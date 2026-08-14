'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vchat-secret-'));
process.env.VCHAT_DATA_DIR = dataDir;
const store = require('../lib/messenger-store');

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const pub = (label) => `${label}${'A'.repeat(80)}`.slice(0, 88);

test('secret chats stay pending until the invited device accepts', () => {
  const alice = store.upsertUserByPhone('+233501990001', { username: 'Secret Alice' });
  const bob = store.upsertUserByPhone('+233501990002', { username: 'Secret Bob' });
  const created = store.createSecretChat(alice.id, bob.id, pub('alice'));
  assert.equal(created.type, 'secret');
  assert.equal(created.secret.state, 'pending');
  assert.equal(created.advancedPrivacy, true);
  assert.equal(store.createSecretChat(alice.id, bob.id, 'short').error, undefined,
    'a second start returns the existing secret chat rather than minting another');
  const accepted = store.acceptSecretChat(created.id, bob.id, pub('bobkey'));
  assert.equal(accepted.secret.state, 'ready');
  assert.ok(accepted.secret.peerPublicKey);
  const view = store.chatView(accepted, alice.id);
  assert.equal(view.secret.state, 'ready');
  assert.ok(view.secret.remotePublicKey);
});

test('secret messages persist ciphertext only and cannot be forwarded or searched', () => {
  const alice = store.findUserByPhone('+233501990001');
  const bob = store.findUserByPhone('+233501990002');
  let chat = store.findSecretChat(alice.id, bob.id);
  if (chat?.secret?.state !== 'ready') {
    store.acceptSecretChat(chat.id, bob.id, pub('bobkey'));
    chat = store.findSecretChat(alice.id, bob.id);
  }
  assert.equal(store.addMessage({
    chatId: chat.id, senderId: alice.id, text: 'plaintext leak', type: 'text',
  }), null);
  const message = store.addMessage({
    chatId: chat.id,
    senderId: alice.id,
    text: 'plaintext leak',
    type: 'text',
    encryption: { v: 1, alg: 'A256GCM', iv: 'AAAAAAAAAAAAAA=='.replace(/=/g, '').padEnd(16, 'A'), ct: 'B'.repeat(32) },
  });
  assert.ok(message.id);
  assert.equal(message.text, '');
  assert.equal(message.encryption.alg, 'A256GCM');
  assert.doesNotMatch(JSON.stringify(message), /plaintext leak/);
  assert.deepEqual(store.forwardMessage(chat.id, message.id, alice.id, ['general']), []);
  assert.deepEqual(store.searchMessages(alice.id, 'plaintext'), []);
});

test('client secret chats use ECDH and AES-GCM on the device', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(source, /namedCurve: 'P-256'/);
  assert.match(source, /AES-GCM/);
  assert.match(source, /indexedDB\.open\(SECRET_DB_NAME/);
  assert.match(source, /chat:startSecret/);
  assert.match(source, /function encryptSecretMessage/);
  assert.match(html, /id="secret-banner"/);
  assert.match(html, /data-filter="secret"/);
});
