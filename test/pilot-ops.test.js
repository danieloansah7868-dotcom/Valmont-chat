'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('pilot image, compose, and production env template are present', () => {
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /FROM node:20-alpine/);
  assert.match(dockerfile, /USER vchat/);
  assert.match(dockerfile, /HEALTHCHECK/);

  const compose = read('compose.pilot.yml');
  assert.match(compose, /vchat-data:\/var\/lib\/vchat/);
  assert.match(compose, /TRUST_PROXY: "1"/);
  assert.match(compose, /healthz/);

  const env = read('.env.production.example');
  for (const key of [
    'NODE_ENV=production',
    'TRUST_PROXY=',
    'PUBLIC_APP_URL=',
    'TWILIO_ACCOUNT_SID=',
    'TWILIO_AUTH_TOKEN=',
    'TWILIO_FROM=',
    'PASSKEY_ORIGIN=',
    'PASSKEY_RP_ID=',
    'VALMONTPAY_SECRET_KEY=',
  ]) {
    assert.match(env, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.equal(env.includes('ACxxxxxxxx'), false, 'the template must not contain a real-looking Twilio SID');
});

test('operations guide documents fail-closed SMS and single-node limits', () => {
  const docs = read('docs/operations.md');
  assert.match(docs, /TRUST_PROXY/);
  assert.match(docs, /development code is never returned/);
  assert.match(docs, /Do not put this compose file behind a load balancer with more than one app/);
  assert.match(docs, /HMAC-SHA256/);
});
