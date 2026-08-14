'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { assertRuntimeConfig, productionConfigReport } = require('../lib/runtime-config');

function safeProductionEnv(overrides = {}) {
  return {
    NODE_ENV: 'production',
    PUBLIC_APP_URL: 'https://chat.example.com',
    TRUST_PROXY: 'loopback, linklocal, uniquelocal',
    PASSKEY_ORIGIN: 'https://chat.example.com',
    PASSKEY_RP_ID: 'example.com',
    TWILIO_ACCOUNT_SID: `AC${'0123456789abcdef'.repeat(2)}`,
    TWILIO_AUTH_TOKEN: '0123456789abcdef0123456789abcdef',
    TWILIO_FROM: '+15550000000',
    TURN_URLS: 'turns:turn.example.com:5349',
    TURN_SECRET: '0123456789abcdef0123456789abcdef',
    ALLOW_TRANSITIONAL_LOCAL_STORAGE: 'true',
    WEB_CONCURRENCY: '1',
    VCHAT_DATA_DIR: '/var/lib/vchat',
    ...overrides,
  };
}

test('production fails closed unless all critical security/provider configuration is explicit', () => {
  assert.throws(() => assertRuntimeConfig({ NODE_ENV: 'prod' }), /must be exactly development/);
  const report = productionConfigReport({ NODE_ENV: 'production' });
  assert.ok(report.errors.some(message => message.includes('JSON/local-media')));
  assert.ok(report.errors.some(message => message.includes('TWILIO_AUTH_TOKEN')));
  assert.ok(report.errors.some(message => message.includes('TURN_URLS')));
  assert.throws(
    () => assertRuntimeConfig({ NODE_ENV: 'production' }),
    error => error.code === 'ERR_UNSAFE_RUNTIME_CONFIG' && !error.message.includes('secret'),
  );
});

test('transitional production override is explicit, single-node, and provider complete', () => {
  const report = assertRuntimeConfig(safeProductionEnv());
  assert.equal(report.errors.length, 0);
  assert.equal(report.localOverride, true);
  assert.ok(report.warnings.some(message => message.includes('TRANSITIONAL OVERRIDE ACTIVE')));

  const scaled = productionConfigReport(safeProductionEnv({ WEB_CONCURRENCY: '2' }));
  assert.ok(scaled.errors.some(message => message.includes('exactly one')));
});

test('paid workloads require ValmontPay and an explicit administrator allowlist', () => {
  const report = productionConfigReport(safeProductionEnv({
    ENABLE_PAID_STORY_BOOSTS: 'true',
    VALMONTPAY_SECRET_KEY: '',
    VALMONTPAY_API_URL: 'http://payments.example.com',
    STORY_AD_ADMIN_PHONES: '',
  }));
  assert.ok(report.errors.some(message => message.includes('VALMONTPAY_SECRET_KEY')));
  assert.ok(report.errors.some(message => message.includes('VALMONTPAY_API_URL')));
  assert.ok(report.errors.some(message => message.includes('STORY_AD_ADMIN_PHONES')));
});

test('passkey identity must align with the canonical public origin', () => {
  const report = productionConfigReport(safeProductionEnv({
    PASSKEY_ORIGIN: 'https://evil.example.net',
  }));
  assert.ok(report.errors.some(message => message.includes('PASSKEY_RP_ID')));
  assert.ok(report.errors.some(message => message.includes('PUBLIC_APP_URL')));
});

test('production accepts bounded proxy hops and explicit IP/CIDR proxy allowlists', () => {
  for (const trustProxy of [
    '1', '32', '192.0.2.10', '10.0.0.0/8', '192.0.2.0/24',
    '2001:db8::1', '2001:db8::/48', 'loopback, 10.20.0.0/16',
  ]) {
    assert.doesNotThrow(() => assertRuntimeConfig(safeProductionEnv({ TRUST_PROXY: trustProxy })), trustProxy);
  }
});

test('production rejects broad or malformed proxy and TURN configuration', () => {
  for (const trustProxy of [
    'true', 'false', '0', '33', 'all', '0.0.0.0', '::', '0.0.0.0/0', '10.0.0.0/7',
    '2001:db8::/16', '10.0.0.0/33', 'loopback,', 'proxy.example.com',
  ]) {
    const report = productionConfigReport(safeProductionEnv({ TRUST_PROXY: trustProxy }));
    assert.ok(report.errors.some(message => message.includes('broad or unknown values')), trustProxy);
  }

  for (const turnUrls of [
    '', 'https://turn.example.com', 'turn:', 'turn:turn.example.com:0',
    'turn:turn.example.com:65536', 'turn:user@turn.example.com',
    'turn:turn..example.com', 'turn:[not-ipv6]:3478',
    'turn:turn.example.com?transport=sctp', 'turn:turn.example.com,',
  ]) {
    const report = productionConfigReport(safeProductionEnv({ TURN_URLS: turnUrls }));
    assert.ok(report.errors.some(message => message.includes('TURN_URLS')), turnUrls);
  }
  for (const turnUrls of [
    'turn:turn.example.com:3478?transport=udp',
    'turns:turn.example.com:5349?transport=tcp',
    'turn:[2001:db8::1]:3478,turn:192.0.2.1:3478',
  ]) {
    assert.doesNotThrow(() => assertRuntimeConfig(safeProductionEnv({ TURN_URLS: turnUrls })), turnUrls);
  }
});

test('production rejects malformed and placeholder provider credentials', () => {
  const report = productionConfigReport(safeProductionEnv({
    TWILIO_ACCOUNT_SID: 'ACnot-a-real-sid',
    TWILIO_AUTH_TOKEN: 'change-me-change-me-change-me-123',
    TWILIO_FROM: '0555000000',
    TURN_SECRET: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    ENABLE_PAID_STORY_BOOSTS: 'true',
    VALMONTPAY_SECRET_KEY: 'replace-me-with-your-secret-key-now',
    VALMONTPAY_API_URL: 'http://payments.example.com',
    STORY_AD_ADMIN_PHONES: 'not-a-phone',
  }));
  for (const setting of [
    'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM', 'TURN_SECRET',
    'VALMONTPAY_SECRET_KEY', 'VALMONTPAY_API_URL', 'STORY_AD_ADMIN_PHONES',
  ]) {
    assert.ok(report.errors.some(message => message.includes(setting)), setting);
  }
});

test('production rejects malformed origins, thresholds, persistence paths, and metrics credentials', () => {
  const report = productionConfigReport(safeProductionEnv({
    ALLOWED_ORIGINS: 'http://insecure.example.com,https://chat.example.com/path',
    COOKIE_SECURE: 'false',
    SESSION_COOKIE_NAME: 'vchat_session',
    API_RATE_MAX: 'not-a-number',
    READINESS_MIN_FREE_MB: '0',
    VCHAT_MEDIA_DIR: '/tmp/outside-vchat',
    METRICS_TOKEN: 'short',
  }));
  assert.ok(report.errors.some(message => message.includes('ALLOWED_ORIGINS')));
  assert.ok(report.errors.some(message => message.includes('COOKIE_SECURE')));
  assert.ok(report.errors.some(message => message.includes('__Host-')));
  assert.ok(report.errors.some(message => message.includes('API_RATE_MAX')));
  assert.ok(report.errors.some(message => message.includes('READINESS_MIN_FREE_MB')));
  assert.ok(report.errors.some(message => message.includes('inside VCHAT_DATA_DIR')));
  assert.ok(report.errors.some(message => message.includes('at least 32 bytes')));
});
