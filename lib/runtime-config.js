'use strict';

const path = require('node:path');
const net = require('node:net');

const PLACEHOLDER = /change-me|replace-me|your-secret|xxxxxxxx|not-a-real|example-secret|todo|placeholder/i;

function envString(env, key) {
  return env[key] == null ? '' : String(env[key]).trim();
}

function isProduction(env) {
  return env.NODE_ENV === 'production';
}

function parseHops(value) {
  if (!/^\d+$/.test(value)) return null;
  const hops = Number(value);
  return hops >= 1 && hops <= 32 ? hops : null;
}

function validIpv4(value) {
  if (!net.isIPv4(value)) return false;
  return value !== '0.0.0.0';
}

function validIpv6(value) {
  if (!net.isIPv6(value)) return false;
  const compact = value.toLowerCase();
  return compact !== '::' && compact !== '0:0:0:0:0:0:0:0';
}

function validCidr(value) {
  const slash = value.lastIndexOf('/');
  if (slash < 0) return false;
  const address = value.slice(0, slash);
  const prefix = Number(value.slice(slash + 1));
  if (!Number.isInteger(prefix)) return false;
  if (net.isIPv4(address)) {
    if (address === '0.0.0.0') return false;
    return prefix >= 8 && prefix <= 32;
  }
  if (net.isIPv6(address)) {
    const compact = address.toLowerCase();
    if (compact === '::' || compact === '0:0:0:0:0:0:0:0') return false;
    return prefix >= 32 && prefix <= 128;
  }
  return false;
}

const NAMED_PROXIES = new Set(['loopback', 'linklocal', 'uniquelocal']);

function validTrustProxyToken(token) {
  if (!token) return false;
  if (NAMED_PROXIES.has(token)) return true;
  if (parseHops(token) != null) return true;
  if (validIpv4(token) || validIpv6(token) || validCidr(token)) return true;
  return false;
}

function validTrustProxy(value) {
  if (!value) return false;
  if (parseHops(value) != null) return true;
  const tokens = value.split(',').map(item => item.trim());
  if (tokens.some(token => token === '')) return false;
  return tokens.every(validTrustProxyToken);
}

function validHostname(host) {
  if (!host || host.length > 253) return false;
  if (host.includes('..')) return false;
  if (net.isIPv4(host) || net.isIPv6(host)) return true;
  return /^(?=.{1,253}$)(?!-)[a-z0-9-]+(?:\.[a-z0-9-]+)*\.?$/i.test(host);
}

function parseTurnUrl(raw) {
  const value = String(raw || '').trim();
  const match = value.match(/^(turns?):(?:\[([^\]]+)\]|([^/:?]+))(?::(\d+))?(?:\?(.*))?$/i);
  if (!match) return null;
  const host = match[2] || match[3];
  const port = match[4] == null ? null : Number(match[4]);
  if (port == null || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (match[2]) {
    if (!validIpv6(match[2])) return null;
  } else if (!validHostname(host) && !validIpv4(host)) {
    return null;
  }
  if (match[5]) {
    const params = new URLSearchParams(match[5]);
    const transport = params.get('transport');
    if (transport && !['udp', 'tcp'].includes(transport.toLowerCase())) return null;
    for (const key of params.keys()) {
      if (key !== 'transport') return null;
    }
  }
  return { host, port };
}

function validTurnUrls(value) {
  if (!value) return false;
  const parts = value.split(',').map(item => item.trim());
  if (parts.some(part => part === '')) return false;
  return parts.every(part => parseTurnUrl(part));
}

function httpsOrigin(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    if (parsed.pathname && parsed.pathname !== '/') return null;
    if (parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function validE164List(value) {
  const phones = String(value || '').split(',').map(item => item.trim()).filter(Boolean);
  return phones.length > 0 && phones.every(phone => /^\+\d{7,15}$/.test(phone));
}

function looksLikeSecretPlaceholder(value) {
  if (!value) return true;
  if (PLACEHOLDER.test(value)) return true;
  if (/^x+$/i.test(value)) return true;
  return false;
}

function productionConfigReport(env = process.env) {
  const errors = [];
  const warnings = [];
  const production = isProduction(env);
  const report = {
    production,
    localOverride: false,
    errors,
    warnings,
  };

  if (!production) return report;

  const publicAppUrl = httpsOrigin(envString(env, 'PUBLIC_APP_URL'));
  if (!publicAppUrl) {
    errors.push('PUBLIC_APP_URL must be the canonical https origin of this deployment');
  }

  const trustProxy = envString(env, 'TRUST_PROXY');
  if (!validTrustProxy(trustProxy)) {
    errors.push('TRUST_PROXY must be an explicit hop count (1-32), named zone, or IP/CIDR list; broad or unknown values are rejected');
  }

  const passkeyOrigin = httpsOrigin(envString(env, 'PASSKEY_ORIGIN'));
  const passkeyRpId = envString(env, 'PASSKEY_RP_ID').toLowerCase();
  if (!passkeyOrigin) {
    errors.push('PASSKEY_ORIGIN must be the canonical https WebAuthn origin');
  } else if (publicAppUrl && passkeyOrigin !== publicAppUrl) {
    errors.push('PASSKEY_ORIGIN must match PUBLIC_APP_URL');
  }
  if (!passkeyRpId || !/^[a-z0-9.-]+$/.test(passkeyRpId)) {
    errors.push('PASSKEY_RP_ID must be the registrable domain used for WebAuthn');
  } else if (passkeyOrigin) {
    let host;
    try { host = new URL(passkeyOrigin).hostname.toLowerCase(); } catch { host = ''; }
    const rpMatches = host === passkeyRpId || host.endsWith(`.${passkeyRpId}`);
    if (!rpMatches) errors.push('PASSKEY_RP_ID must be a suffix of the PASSKEY_ORIGIN host');
  }

  const twilioSid = envString(env, 'TWILIO_ACCOUNT_SID');
  const twilioToken = envString(env, 'TWILIO_AUTH_TOKEN');
  const twilioFrom = envString(env, 'TWILIO_FROM');
  if (!/^AC[0-9a-f]{32}$/i.test(twilioSid) || looksLikeSecretPlaceholder(twilioSid)) {
    errors.push('TWILIO_ACCOUNT_SID must be a real Twilio account SID');
  }
  if (!/^[0-9a-f]{32,}$/i.test(twilioToken) || looksLikeSecretPlaceholder(twilioToken)) {
    errors.push('TWILIO_AUTH_TOKEN must be the live Twilio auth token');
  }
  if (!/^\+\d{7,15}$/.test(twilioFrom)) {
    errors.push('TWILIO_FROM must be an E.164 sender number');
  }

  const turnUrls = envString(env, 'TURN_URLS');
  if (!validTurnUrls(turnUrls)) {
    errors.push('TURN_URLS must be a comma-separated turn: or turns: list with explicit ports');
  }
  const turnSecret = envString(env, 'TURN_SECRET');
  if (turnSecret.length < 16 || looksLikeSecretPlaceholder(turnSecret)) {
    errors.push('TURN_SECRET must be a non-placeholder shared secret');
  }

  const localOverride = envString(env, 'ALLOW_TRANSITIONAL_LOCAL_STORAGE') === 'true';
  report.localOverride = localOverride;
  if (!localOverride) {
    errors.push('Production refuses the bundled JSON/local-media adapter unless ALLOW_TRANSITIONAL_LOCAL_STORAGE=true');
  } else {
    warnings.push('TRANSITIONAL OVERRIDE ACTIVE: JSON files and local media are not a multi-replica store');
    const concurrency = envString(env, 'WEB_CONCURRENCY') || '1';
    if (concurrency !== '1') {
      errors.push('WEB_CONCURRENCY must be exactly one when the transitional local adapter is enabled');
    }
  }

  const paid = envString(env, 'ENABLE_PAID_STORY_BOOSTS') === 'true';
  if (paid) {
    const paySecret = envString(env, 'VALMONTPAY_SECRET_KEY');
    const payUrl = envString(env, 'VALMONTPAY_API_URL');
    if (!paySecret || looksLikeSecretPlaceholder(paySecret)) {
      errors.push('VALMONTPAY_SECRET_KEY is required when paid story boosts are enabled');
    }
    try {
      const parsed = new URL(payUrl);
      if (parsed.protocol !== 'https:') throw new Error('https');
    } catch {
      errors.push('VALMONTPAY_API_URL must be an https ValmontPay endpoint');
    }
    if (!validE164List(envString(env, 'STORY_AD_ADMIN_PHONES'))) {
      errors.push('STORY_AD_ADMIN_PHONES must be an explicit E.164 administrator allowlist');
    }
  }

  const allowedOrigins = envString(env, 'ALLOWED_ORIGINS');
  if (allowedOrigins) {
    for (const item of allowedOrigins.split(',').map(value => value.trim()).filter(Boolean)) {
      if (!httpsOrigin(item)) {
        errors.push('ALLOWED_ORIGINS must be a comma-separated list of https origins');
        break;
      }
    }
  }

  if (envString(env, 'COOKIE_SECURE') === 'false') {
    errors.push('COOKIE_SECURE cannot be disabled in production');
  }
  const cookieName = envString(env, 'SESSION_COOKIE_NAME');
  if (cookieName && !cookieName.startsWith('__Host-')) {
    errors.push('SESSION_COOKIE_NAME must use the __Host- prefix in production');
  }

  if (Object.hasOwn(env, 'API_RATE_MAX') && !/^\d+$/.test(envString(env, 'API_RATE_MAX'))) {
    errors.push('API_RATE_MAX must be a positive integer');
  }
  if (Object.hasOwn(env, 'READINESS_MIN_FREE_MB')) {
    const free = Number(envString(env, 'READINESS_MIN_FREE_MB'));
    if (!Number.isFinite(free) || free < 1) {
      errors.push('READINESS_MIN_FREE_MB must be at least 1');
    }
  }

  const dataDir = envString(env, 'VCHAT_DATA_DIR') || '/var/lib/vchat';
  const mediaDir = envString(env, 'VCHAT_MEDIA_DIR');
  if (mediaDir) {
    const resolvedData = path.resolve(dataDir);
    const resolvedMedia = path.resolve(mediaDir);
    const inside = resolvedMedia === resolvedData
      || resolvedMedia.startsWith(`${resolvedData}${path.sep}`);
    if (!inside) errors.push('VCHAT_MEDIA_DIR must resolve inside VCHAT_DATA_DIR');
  }

  const metricsToken = envString(env, 'METRICS_TOKEN');
  if (metricsToken && Buffer.byteLength(metricsToken, 'utf8') < 32) {
    errors.push('METRICS_TOKEN must be at least 32 bytes');
  }

  return report;
}

function assertRuntimeConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV;
  if (nodeEnv && !['development', 'production', 'test'].includes(nodeEnv)) {
    const error = new Error('NODE_ENV must be exactly development, production, or test');
    error.code = 'ERR_UNSAFE_RUNTIME_CONFIG';
    throw error;
  }
  const report = productionConfigReport(env);
  if (report.errors.length) {
    const error = new Error('Runtime configuration is unsafe for this environment');
    error.code = 'ERR_UNSAFE_RUNTIME_CONFIG';
    error.report = report;
    throw error;
  }
  return report;
}

module.exports = { productionConfigReport, assertRuntimeConfig };
