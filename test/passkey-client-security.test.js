'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { passkeyRequestContext } = require('../lib/messenger');

function requestFor(origin, host = 'attacker.example') {
  return {
    protocol: 'https',
    get(name) {
      if (name === 'origin') return origin;
      if (name === 'host') return host;
      return undefined;
    },
  };
}

test('production passkeys fail closed without canonical origin and RP-ID configuration', () => {
  const saved = {
    nodeEnv: process.env.NODE_ENV,
    origin: process.env.PASSKEY_ORIGIN,
    rpID: process.env.PASSKEY_RP_ID,
  };
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.PASSKEY_ORIGIN;
    delete process.env.PASSKEY_RP_ID;
    assert.equal(passkeyRequestContext(requestFor('https://attacker.example')), null,
      'request Origin and Host headers cannot become production WebAuthn trust anchors');

    process.env.PASSKEY_ORIGIN = 'https://chat.vchat.example';
    assert.equal(passkeyRequestContext(requestFor('https://chat.vchat.example')), null,
      'both canonical settings are mandatory');

    process.env.PASSKEY_RP_ID = 'vchat.example';
    assert.deepEqual(
      passkeyRequestContext(requestFor('https://chat.vchat.example')),
      { origin: 'https://chat.vchat.example', rpID: 'vchat.example' },
    );
    assert.equal(passkeyRequestContext(requestFor('https://attacker.example')), null,
      'a configured deployment still rejects a mismatched request origin');
    assert.equal(passkeyRequestContext(requestFor('')), null,
      'production passkey requests must carry an explicit approved Origin');

    process.env.PASSKEY_ORIGIN = 'data:text/plain,vchat';
    process.env.PASSKEY_RP_ID = 'vchat.example';
    assert.equal(passkeyRequestContext(requestFor('data:text/plain,vchat')), null,
      'opaque configured origins fail closed without throwing a server error');
  } finally {
    if (saved.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved.nodeEnv;
    if (saved.origin === undefined) delete process.env.PASSKEY_ORIGIN;
    else process.env.PASSKEY_ORIGIN = saved.origin;
    if (saved.rpID === undefined) delete process.env.PASSKEY_RP_ID;
    else process.env.PASSKEY_RP_ID = saved.rpID;
  }
});

test('client privacy state resets, merges session fields, and closes View Once media on relock', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(source, /\$\('story-allow-save'\)\.checked = false;/,
    'opening the composer must not retain the previous Status privacy choice');
  assert.match(source, /form\.append\('allowSave', String\(\$\('story-allow-save'\)\.checked\)\);/,
    'the selected privacy choice must be included in the multipart publish request');
  assert.match(source, /const applyLocalProfile = user => \{[\s\S]{0,400}?me = \{ \.\.\.me, \.\.\.\(user \|\| \{\}\) \};/,
    'profile mutations preserve unrelated session-scoped account state');
  assert.match(source, /function closeChat\(\) \{[\s\S]{0,400}?closeViewOnce\(\);/,
    'automatic relocking destroys any fetched View Once object URL through closeChat');
  assert.match(source, /socket\.emit\('users:lookup'/,
    'new chats look people up by unique @username');
  assert.match(source, /const WP_KEY = 'vchat\.wallpaper'/,
    'wallpaper choice is remembered on the device');
});
