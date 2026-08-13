'use strict';

const { randomUUID, timingSafeEqual } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { assertRuntimeConfig } = require('./lib/runtime-config');

let runtimeConfig;
try {
  runtimeConfig = assertRuntimeConfig(process.env);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    time: new Date().toISOString(),
    level: 'fatal',
    event: 'runtime_configuration_rejected',
    code: error.code || 'ERR_CONFIG',
    errors: error.report?.errors || [error.message || 'Runtime configuration is invalid'],
  })}\n`);
  process.exitCode = 1;
  throw error;
}

const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const store = require('./lib/messenger-store');
const messenger = require('./lib/messenger');

function sendJsonError(res, status, message) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json({ error: message });
}

function log(level, event, fields = {}) {
  const record = { time: new Date().toISOString(), level, event, ...fields };
  const line = `${JSON.stringify(record)}\n`;
  (level === 'error' || level === 'fatal' ? process.stderr : process.stdout).write(line);
}

const app = express();
const server = http.createServer(app);
const startedAt = Date.now();
const isProduction = process.env.NODE_ENV === 'production';
let draining = false;
let ready = false;
let shutdownStarted = false;

const metrics = {
  requests: 0,
  responses: new Map(),
  errors: 0,
  rateLimited: 0,
};

for (const warning of runtimeConfig.warnings) {
  log('warn', 'runtime_configuration_warning', { warning });
  process.stderr.write(`${warning}\n`);
}

const rawTrustProxy = process.env.TRUST_PROXY || (isProduction ? '' : 'loopback');
const trustProxy = /^\d+$/.test(rawTrustProxy) ? Number(rawTrustProxy) : rawTrustProxy;
if (trustProxy) app.set('trust proxy', trustProxy);
app.disable('x-powered-by');

app.use(helmet({
  strictTransportSecurity: isProduction ? { maxAge: 31536000, includeSubDomains: true } : false,
  crossOriginResourcePolicy: { policy: 'same-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      mediaSrc: ["'self'", 'blob:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: isProduction ? [] : null,
    },
  },
}));

app.use((req, res, next) => {
  const suppliedId = String(req.get('x-request-id') || '');
  const requestId = /^[A-Za-z0-9._:-]{8,128}$/.test(suppliedId) ? suppliedId : randomUUID();
  const requestStarted = process.hrtime.bigint();
  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);
  metrics.requests += 1;
  res.once('finish', () => {
    const statusClass = `${Math.floor(res.statusCode / 100)}xx`;
    metrics.responses.set(statusClass, (metrics.responses.get(statusClass) || 0) + 1);
    if (res.statusCode >= 500) metrics.errors += 1;
    if (process.env.LOG_REQUESTS === 'true' || isProduction) {
      log(res.statusCode >= 500 ? 'error' : 'info', 'http_request', {
        requestId,
        method: req.method,
        route: req.route?.path || (req.path.startsWith('/api') ? '/api/<unmatched>' : '/<static-or-unmatched>'),
        status: res.statusCode,
        durationMs: Number(process.hrtime.bigint() - requestStarted) / 1e6,
      });
    }
  });
  next();
});

const allowedOrigins = new Set(
  String(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(value => {
      try { return new URL(value.trim()).origin; } catch { return ''; }
    })
    .filter(Boolean),
);
if (runtimeConfig.production) {
  try { allowedOrigins.add(new URL(process.env.PUBLIC_APP_URL).origin); } catch { /* validated earlier */ }
}
function originAllowed(origin, host) {
  if (!origin) return true;
  if (allowedOrigins.has(origin)) return true;
  if (runtimeConfig.production) return false;
  try {
    const parsed = new URL(origin);
    return parsed.host === host && ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}
app.locals.isOriginAllowed = originAllowed;
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.path === '/api/story-ads/valmontpay/webhook') return next();
  if (req.path === '/api/sms/twilio/inbound') return next();
  if (!originAllowed(req.get('origin'), req.get('host'))) {
    return sendJsonError(res, 403, 'Origin not allowed');
  }
  return next();
});

const apiLimiter = rateLimit({
  windowMs: Math.max(1000, Number(process.env.API_RATE_WINDOW_MS || 60_000)),
  limit: Math.max(10, Number(process.env.API_RATE_MAX || process.env.API_RATE_LIMIT || 600)),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: req => req.path === '/story-ads/valmontpay/webhook',
  handler(_req, res) {
    metrics.rateLimited += 1;
    return sendJsonError(res, 429, 'Too many requests');
  },
});
app.use('/api', apiLimiter);

app.use('/api/story-ads/valmontpay/webhook', express.json({
  limit: '256kb',
  verify(req, _res, body) { req.rawBody = Buffer.from(body); },
}));
app.use(express.json({
  limit: '2mb',
  strict: true,
  verify(req, _res, buffer) {
    if (req.originalUrl?.split('?')[0] === '/api/story-ads/valmontpay/webhook') {
      req.rawBody = Buffer.from(buffer);
    }
  },
}));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));

function persistenceReady() {
  try {
    if (!store.persistenceStatus().ok) return { ok: false, reason: 'persistence_write_failed' };
    fs.accessSync(store.DATA_DIR, fs.constants.R_OK | fs.constants.W_OK);
    const mediaDir = process.env.VCHAT_MEDIA_DIR || path.join(store.DATA_DIR, 'media');
    fs.accessSync(mediaDir, fs.constants.R_OK | fs.constants.W_OK);
    const minimumFreeBytes = Math.max(1, Number(process.env.READINESS_MIN_FREE_MB || 16)) * 1024 * 1024;
    for (const directory of new Set([store.DATA_DIR, mediaDir])) {
      const stats = fs.statfsSync(directory);
      if (Number(stats.bavail) * Number(stats.bsize) < minimumFreeBytes) {
        return { ok: false, reason: 'persistence_space_low' };
      }
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'persistence_unavailable' };
  }
}

app.get('/livez', (_req, res) => res.json({ ok: true }));
app.get('/readyz', (_req, res) => {
  const persistence = persistenceReady();
  const ok = ready && !draining && persistence.ok;
  res.status(ok ? 200 : 503).json({ ok, checks: { application: ready && !draining, persistence: persistence.ok } });
});
app.get('/healthz', (_req, res) => {
  const persistence = persistenceReady();
  const ok = ready && !draining && persistence.ok;
  res.status(ok ? 200 : 503).json({ ok });
});

function authorizedMetricsRequest(req) {
  const expected = String(process.env.METRICS_TOKEN || '');
  const supplied = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!expected || !supplied) return false;
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}
let io = null;
app.get('/metrics', (req, res) => {
  if (!process.env.METRICS_TOKEN) return res.status(404).end();
  if (!authorizedMetricsRequest(req)) return res.status(401).set('WWW-Authenticate', 'Bearer').end();
  const lines = [
    '# HELP vchat_uptime_seconds Process uptime in seconds.',
    '# TYPE vchat_uptime_seconds gauge',
    `vchat_uptime_seconds ${Math.floor((Date.now() - startedAt) / 1000)}`,
    '# HELP vchat_http_requests_total HTTP requests received.',
    '# TYPE vchat_http_requests_total counter',
    `vchat_http_requests_total ${metrics.requests}`,
    '# HELP vchat_http_responses_total HTTP responses by status class.',
    '# TYPE vchat_http_responses_total counter',
    ...[...metrics.responses].map(([statusClass, count]) => `vchat_http_responses_total{status_class="${statusClass}"} ${count}`),
    '# HELP vchat_http_errors_total Responses with 5xx status.',
    '# TYPE vchat_http_errors_total counter',
    `vchat_http_errors_total ${metrics.errors}`,
    '# HELP vchat_rate_limited_total API requests rejected by the HTTP rate limit.',
    '# TYPE vchat_rate_limited_total counter',
    `vchat_rate_limited_total ${metrics.rateLimited}`,
    '# HELP vchat_socket_connections Current authenticated and unauthenticated Socket.IO transports.',
    '# TYPE vchat_socket_connections gauge',
    `vchat_socket_connections ${io?.engine?.clientsCount || 0}`,
    '# HELP vchat_process_resident_memory_bytes Resident process memory in bytes.',
    '# TYPE vchat_process_resident_memory_bytes gauge',
    `vchat_process_resident_memory_bytes ${process.memoryUsage().rss}`,
  ];
  res.type('text/plain; version=0.0.4').send(`${lines.join('\n')}\n`);
});

io = messenger.attach(server, app);

app.use('/uploads', (_req, res) => sendJsonError(res, 404, 'Not found'));
app.use('/api', (_req, res) => sendJsonError(res, 404, 'API route not found'));
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: 0,
  setHeaders(res, filePath) {
    res.setHeader('Cache-Control', 'no-cache');
    if (filePath.endsWith('manifest.webmanifest')) {
      res.setHeader('Content-Type', 'application/manifest+json');
    }
  },
}));
app.get('*', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  return res.sendFile(path.join(__dirname, 'index.html'));
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const tooLarge = error?.code === 'LIMIT_FILE_SIZE' || error?.type === 'entity.too.large';
  const suppliedStatus = Number(error?.status);
  const status = tooLarge ? 413 : (suppliedStatus >= 400 && suppliedStatus < 600 ? suppliedStatus : 500);
  log(status >= 500 ? 'error' : 'warn', 'request_error', {
    requestId: req.requestId,
    method: req.method,
    route: req.route?.path || (req.path.startsWith('/api') ? '/api/<unmatched>' : '/<unmatched>'),
    status,
    error: error?.name || 'Error',
  });
  return sendJsonError(res, status, tooLarge ? 'Request is too large' : 'Request could not be processed');
});

const port = Number(process.env.PORT || 3000);
server.once('error', error => {
  ready = false;
  log('fatal', 'http_server_error', { code: error?.code || 'ERR_HTTP_SERVER' });
  if (!shutdownStarted) process.exit(1);
});
server.listen(port, '0.0.0.0', () => {
  ready = true;
  log('info', 'server_started', {
    port,
    environment: process.env.NODE_ENV || 'development',
    persistence: runtimeConfig.localOverride ? 'transitional-local-override' : 'transitional-local-development',
  });
});

function shutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  draining = true;
  ready = false;
  log('info', 'graceful_shutdown_started', { signal });

  const deadline = setTimeout(() => {
    log('fatal', 'graceful_shutdown_timeout', { signal });
    process.exit(1);
  }, Math.max(1000, Number(process.env.SHUTDOWN_TIMEOUT_MS || 10_000)));
  deadline.unref?.();

  const finish = () => {
    server.close(() => {
      clearTimeout(deadline);
      try {
        store.flush();
        log('info', 'graceful_shutdown_complete', { signal });
        process.exit(0);
      } catch (error) {
        log('fatal', 'graceful_shutdown_persistence_failed', {
          signal,
          code: error?.code || 'ERR_STORE_PERSISTENCE',
        });
        process.exit(1);
      }
    });
    server.closeIdleConnections?.();
  };

  if (io) io.close(finish);
  else finish();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

module.exports = { app, server, shutdown };
