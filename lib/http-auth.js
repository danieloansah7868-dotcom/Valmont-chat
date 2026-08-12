'use strict';

const store = require('./messenger-store');

const FALLBACK_COOKIE_NAME = 'vchat_session';
const COOKIE_SECURE = process.env.COOKIE_SECURE
  ? process.env.COOKIE_SECURE === 'true'
  : process.env.NODE_ENV === 'production';
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME
  || (COOKIE_SECURE ? '__Host-vchat_session' : FALLBACK_COOKIE_NAME);

function parseCookies(header = '') {
  const out = {};
  for (const pair of String(header).split(';')) {
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    try {
      out[decodeURIComponent(pair.slice(0, at).trim())] = decodeURIComponent(pair.slice(at + 1).trim());
    } catch { /* malformed cookies are ignored */ }
  }
  return out;
}

function tokenFromRequest(req) {
  const cookies = parseCookies(req.headers?.cookie);
  return cookies[COOKIE_NAME] || cookies[FALLBACK_COOKIE_NAME] || '';
}

function authFromRequest(req) {
  const token = tokenFromRequest(req);
  const user = store.userForSession(token);
  return user ? { token, user } : null;
}

function authRequired(req, res, next) {
  const auth = authFromRequest(req);
  if (!auth) return res.status(401).json({ error: 'Authentication required' });
  req.auth = auth;
  return next();
}

function cookieAttributes(maxAgeSeconds) {
  const attrs = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    'Priority=High',
  ];
  if (COOKIE_SECURE || COOKIE_NAME.startsWith('__Host-')) attrs.push('Secure');
  return attrs;
}

function setSessionCookie(res, token) {
  const attrs = cookieAttributes(Number(process.env.SESSION_TTL_DAYS || 30) * 24 * 60 * 60);
  attrs[0] += encodeURIComponent(token);
  res.append('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(res) {
  const attrs = cookieAttributes(0);
  attrs[0] = `${COOKIE_NAME}=`;
  res.append('Set-Cookie', attrs.join('; '));
  if (COOKIE_NAME !== FALLBACK_COOKIE_NAME) {
    const fallback = [...attrs];
    fallback[0] = `${FALLBACK_COOKIE_NAME}=`;
    res.append('Set-Cookie', fallback.join('; '));
  }
}

function requestMetadata(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return {
    label: 'Web browser',
    userAgent: req.headers['user-agent'] || '',
    ipHint: forwarded || req.ip || req.socket?.remoteAddress || '',
  };
}

module.exports = {
  COOKIE_NAME,
  COOKIE_SECURE,
  parseCookies,
  tokenFromRequest,
  authFromRequest,
  authRequired,
  setSessionCookie,
  clearSessionCookie,
  requestMetadata,
};
