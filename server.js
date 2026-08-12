'use strict';

const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const http = require('http');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const isProduction = process.env.NODE_ENV === 'production';

// Do not trust client-supplied forwarding headers unless the deployment has an
// explicitly configured reverse-proxy hop count or proxy subnet.
const trustProxy = String(process.env.TRUST_PROXY || '').trim();
if (trustProxy) app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
app.disable('x-powered-by');
app.use(helmet({
  strictTransportSecurity: isProduction ? undefined : false,
  crossOriginResourcePolicy: { policy: 'same-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      mediaSrc: ["'self'", 'blob:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      workerSrc: ["'self'", 'blob:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: isProduction ? [] : null,
    },
  },
}));
app.use(express.json({
  limit: '256kb',
  strict: true,
  verify(req, _res, buffer) {
    // Paystack webhook signatures cover the exact request bytes. Keep a raw
    // copy only for that endpoint; all other JSON continues through normally.
    if (req.originalUrl?.split('?')[0] === '/api/story-ads/paystack/webhook') {
      req.rawBody = Buffer.from(buffer);
    }
  },
}));

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.API_RATE_LIMIT || 240),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});
app.use('/api', apiLimiter);

// Explicit allow-list for deployments that intentionally use another origin.
const configuredOrigins = new Set(
  String(process.env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean),
);
app.locals.isOriginAllowed = (origin, requestHost = '') => {
  if (!origin) return true; // Native clients and server-to-server requests do not always send Origin.
  if (configuredOrigins.has(origin)) return true;
  try {
    return new URL(origin).host === requestHost;
  } catch {
    return false;
  }
};

// Cookie-authenticated mutation requests must be same-origin. SameSite=Strict is
// the primary CSRF control; this rejects hostile browser origins as defence in depth.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin && !app.locals.isOriginAllowed(origin, req.headers.host)) {
    return res.status(403).json({ error: 'Cross-origin request rejected' });
  }
  return next();
});

const httpServer = http.createServer(app);
const messenger = require('./lib/messenger');
// Register authenticated API routes before static files so a public asset can
// never shadow an account, message, media, or calling endpoint.
messenger.attach(httpServer, app);

// Legacy public uploads are intentionally unreachable. Protected attachments are
// served only by the authenticated, chat-authorized media API.
app.use('/uploads', (_req, res) => res.status(404).json({ error: 'Not found' }));

// Immutable fingerprinted assets can be cached; the HTML and service worker may not.
app.use(express.static(PUBLIC_DIR, {
  maxAge: isProduction ? '1h' : 0,
  setHeaders(res, filePath) {
    if (filePath.endsWith('sw.js') || filePath.endsWith('manifest.webmanifest')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

app.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'vchat' }));
app.use('/api', (_req, res) => res.status(404).json({ error: 'API endpoint not found' }));

// Keep operational details out of HTTP responses while retaining useful logs.
app.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  const tooLarge = error?.code === 'LIMIT_FILE_SIZE' || error?.type === 'entity.too.large';
  const status = tooLarge ? 413 : (Number(error?.status) >= 400 ? Number(error.status) : 500);
  if (status >= 500) console.error('[http]', error?.stack || error);
  return res.status(status).json({ error: tooLarge ? 'Request is too large' : 'Request could not be processed' });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  🟢 VChat is live  →  http://localhost:${PORT}\n`);
});
