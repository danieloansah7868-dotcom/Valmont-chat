'use strict';

const path = require('node:path');
const net = require('node:net');

function validHttpsUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    const exactOrigin = parsed.pathname === '/' && !parsed.search && !parsed.hash;
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && exactOrigin ? parsed : null;
  } catch {
    return null;
  }
}

function validTrustProxy(value) {
  const configured = String(value || '').trim();
  if (/^[1-9]\d*$/.test(configured)) return Number(configured) <= 32;
  const aliases = new Set(['loopback', 'linklocal', 'uniquelocal']);
  const tokens = configured.split(',').map(item => item.trim());
  if (!tokens.length || tokens.some(token => !token)) return false;
  return tokens.every(token => {
    if (aliases.has(token)) return true;
    const slash = token.lastIndexOf('/');
    const address = slash < 0 ? token : token.slice(0, slash);
    const family = net.isIP(address);
    if (!family || address === '0.0.0.0' || address === '::') return false;
    if (slash < 0) return true;
    const prefix = token.slice(slash + 1);
    if (!/^\d+$/.test(prefix)) return false;
    const bits = Number(prefix);
    // A proxy allowlist must name a bounded network, never the whole Internet.
    return family === 4 ? bits >= 8 && bits <= 32 : bits >= 32 && bits <= 128;
  });
}

function configuredSecret(value, minimumBytes, { exactPattern = null } = {}) {
  const secret = String(value || '').trim();
  if (Buffer.byteLength(secret) < minimumBytes || (exactPattern && !exactPattern.test(secret))) return false;
  if (new Set(secret).size < 8) return false;
  return !/(?:change[\s_-]*me|replace[\s_-]*me|placeholder|example[\s_-]*secret|your[\s_-]*(?:secret|token|key)|dummy[\s_-]*(?:secret|token|key))/i.test(secret);
}

function validTurnUrl(value) {
  const match = String(value || '').match(
    /^turns?:([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(?::([1-9]\d{0,4}))?(?:\?transport=(udp|tcp))?$/i,
  );
  if (!match || (match[2] && Number(match[2]) > 65_535)) return false;
  const host = match[1];
  if (host.startsWith('[')) return net.isIP(host.slice(1, -1)) === 6;
  if (net.isIP(host)) return true;
  return host.length <= 253 && !host.includes('..')
    && host.split('.').every(label => /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/.test(label));
}

function productionConfigReport(env = process.env) {
  const errors = [];
  const warnings = [];
  const environment = String(env.NODE_ENV || 'development');
  const production = environment === 'production';
  const localOverride = env.ALLOW_TRANSITIONAL_LOCAL_STORAGE === 'true';
  if (!['development', 'test', 'production'].includes(environment)) {
    errors.push('NODE_ENV must be exactly development, test, or production; aliases such as prod are rejected.');
    return { production, localOverride, errors, warnings };
  }
  if (!production) {
    warnings.push('Development/test mode may use local OTP delivery and transitional local persistence.');
    return { production, localOverride, errors, warnings };
  }

  if (env.COOKIE_SECURE === 'false') errors.push('COOKIE_SECURE=false is forbidden in production.');
  const sessionCookieName = String(env.SESSION_COOKIE_NAME || '__Host-vchat_session');
  if (!/^__Host-[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(sessionCookieName)) {
    errors.push('SESSION_COOKIE_NAME must use a valid __Host- prefixed cookie name in production.');
  }

  const publicUrl = validHttpsUrl(env.PUBLIC_APP_URL);
  if (!publicUrl) errors.push('PUBLIC_APP_URL must be the canonical HTTPS application origin.');
  const configuredOrigins = String(env.ALLOWED_ORIGINS || '').split(',').map(item => item.trim()).filter(Boolean);
  if (configuredOrigins.some(origin => !validHttpsUrl(origin))) {
    errors.push('ALLOWED_ORIGINS entries must be exact HTTPS origins.');
  }
  const trustProxy = String(env.TRUST_PROXY || '').trim();
  if (!trustProxy) errors.push('TRUST_PROXY must explicitly describe the trusted reverse proxy.');
  else if (!validTrustProxy(trustProxy)) {
    errors.push('TRUST_PROXY must be a bounded hop count or comma-separated trusted IP/CIDR/loopback ranges; broad or unknown values are forbidden.');
  }

  const passkeyOrigin = validHttpsUrl(env.PASSKEY_ORIGIN);
  const passkeyRpId = String(env.PASSKEY_RP_ID || '').trim().toLowerCase();
  if (!passkeyOrigin) errors.push('PASSKEY_ORIGIN must be an explicit HTTPS origin.');
  if (!passkeyRpId) errors.push('PASSKEY_RP_ID is required in production.');
  if (passkeyOrigin && passkeyRpId
      && passkeyOrigin.hostname !== passkeyRpId
      && !passkeyOrigin.hostname.endsWith(`.${passkeyRpId}`)) {
    errors.push('PASSKEY_RP_ID must equal or be a registrable parent of PASSKEY_ORIGIN.');
  }
  if (publicUrl && passkeyOrigin && publicUrl.origin !== passkeyOrigin.origin) {
    errors.push('PASSKEY_ORIGIN must match PUBLIC_APP_URL origin.');
  }

  if (!/^AC[a-fA-F0-9]{32}$/.test(String(env.TWILIO_ACCOUNT_SID || '').trim())) {
    errors.push('TWILIO_ACCOUNT_SID must be a valid Twilio Account SID for production phone verification.');
  }
  if (!configuredSecret(env.TWILIO_AUTH_TOKEN, 32, { exactPattern: /^[A-Za-z0-9]{32}$/ })) {
    errors.push('TWILIO_AUTH_TOKEN must be a non-placeholder 32-character provider token for production phone verification.');
  }
  if (!/^\+[1-9]\d{7,14}$/.test(String(env.TWILIO_FROM || '').trim())) {
    errors.push('TWILIO_FROM must be a valid E.164 sender for production phone verification.');
  }
  const turnUrls = String(env.TURN_URLS || '').split(',').map(item => item.trim());
  if (turnUrls.some(url => !url || !validTurnUrl(url))) {
    errors.push('TURN_URLS must contain only valid comma-separated TURN or TURNS endpoints.');
  }
  if (!configuredSecret(env.TURN_SECRET, 32)) {
    errors.push('TURN_SECRET must be a non-placeholder value containing at least 32 bytes for temporary TURN credentials.');
  }

  const numericSettings = [
    ['PORT', 1, 65_535],
    ['SESSION_TTL_DAYS', 1, 365],
    ['API_RATE_WINDOW_MS', 1_000, 3_600_000],
    ['API_RATE_MAX', 10, 100_000],
    ['AUTH_RATE_LIMIT', 1, 10_000],
    ['CHAT_LOCK_RATE_LIMIT', 1, 10_000],
    ['SOCKET_EVENT_RATE_LIMIT', 1, 100_000],
    ['SOCKET_MESSAGE_RATE_LIMIT', 1, 100_000],
    ['MAX_UPLOAD_MB', 1, 1_024],
    ['MAX_ACCOUNT_STORAGE_MB', 10, 1_000_000],
    ['MAX_PENDING_UPLOADS', 1, 10_000],
    ['READINESS_MIN_FREE_MB', 1, 1_000_000],
    ['SHUTDOWN_TIMEOUT_MS', 1_000, 120_000],
  ];
  for (const [name, minimum, maximum] of numericSettings) {
    if (env[name] === undefined || env[name] === '') continue;
    const value = Number(env[name]);
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      errors.push(`${name} must be an integer from ${minimum} through ${maximum}.`);
    }
  }

  if (env.ENABLE_PAID_STORY_BOOSTS === 'true') {
    if (!configuredSecret(env.VALMONTPAY_SECRET_KEY, 32)) {
      errors.push('VALMONTPAY_SECRET_KEY must be a non-placeholder value containing at least 32 bytes when paid Story boosts are enabled.');
    }
    try {
      const paymentUrl = new URL(String(env.VALMONTPAY_API_URL || 'https://valmontpay.app'));
      if (paymentUrl.protocol !== 'https:' || paymentUrl.username || paymentUrl.password) throw new Error('unsafe URL');
    } catch {
      errors.push('VALMONTPAY_API_URL must be a credential-free HTTPS endpoint when paid Story boosts are enabled.');
    }
    const admins = String(env.STORY_AD_ADMIN_PHONES || '').split(',').map(item => item.trim()).filter(Boolean);
    if (!admins.length || admins.some(phone => !/^\+[1-9]\d{7,14}$/.test(phone))) {
      errors.push('STORY_AD_ADMIN_PHONES must contain valid comma-separated E.164 numbers when paid Story boosts are enabled.');
    }
  }

  if (!localOverride) {
    errors.push(
      'The bundled JSON/local-media adapter is not approved for production. '
      + 'Keep production blocked until a transactional database and durable object-store adapter are installed.',
    );
  } else {
    const replicaSettings = [env.WEB_CONCURRENCY ?? '1', env.INSTANCE_COUNT ?? '1'];
    if (replicaSettings.some(value => String(value) !== '1')) {
      errors.push('Transitional local persistence can run with exactly one application instance.');
    }
    const configuredDataDir = String(env.VCHAT_DATA_DIR || '');
    if (!path.isAbsolute(configuredDataDir)) {
      errors.push('VCHAT_DATA_DIR must be an explicit absolute path for the transitional production override.');
    }
    const dataDir = path.resolve(configuredDataDir || path.join(process.cwd(), 'data'));
    const mediaDir = path.resolve(env.VCHAT_MEDIA_DIR || path.join(dataDir, 'media'));
    const mediaRelative = path.relative(dataDir, mediaDir);
    if (mediaRelative.startsWith('..') || path.isAbsolute(mediaRelative)) {
      errors.push('VCHAT_MEDIA_DIR must remain inside VCHAT_DATA_DIR so offline recovery is complete.');
    }
    warnings.push(`TRANSITIONAL OVERRIDE ACTIVE: single-node state and media are stored under ${dataDir}.`);
    warnings.push('This override is for a controlled pilot only; it is not horizontally scalable production persistence.');
  }

  const metricsToken = String(env.METRICS_TOKEN || '');
  if (!metricsToken) {
    warnings.push('METRICS_TOKEN is unset; the operational metrics endpoint will remain disabled.');
  } else if (Buffer.byteLength(metricsToken) < 32) {
    errors.push('METRICS_TOKEN must contain at least 32 bytes when configured.');
  }
  return { production, localOverride, errors, warnings };
}

function assertRuntimeConfig(env = process.env) {
  const report = productionConfigReport(env);
  if (report.errors.length) {
    const error = new Error(`Unsafe runtime configuration:\n- ${report.errors.join('\n- ')}`);
    error.code = 'ERR_UNSAFE_RUNTIME_CONFIG';
    error.report = report;
    throw error;
  }
  return report;
}

module.exports = { validHttpsUrl, productionConfigReport, assertRuntimeConfig };
