'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vchat-hybrid-'));
process.env.VCHAT_DATA_DIR = dataDir;
const store = require('../lib/messenger-store');

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('Saved Messages is a private self-chat that sorts first', () => {
  const alice = store.upsertUserByPhone('+233501880001', { username: 'Hybrid Alice' });
  const bob = store.upsertUserByPhone('+233501880002', { username: 'Hybrid Bob' });
  store.findOrCreateDM(alice.id, bob.id);
  const saved = store.findOrCreateSaved(alice.id);
  assert.equal(saved.type, 'saved');
  assert.equal(saved.members.has(alice.id), true);
  assert.equal(saved.members.has(bob.id), false);
  assert.equal(store.findOrCreateSaved(alice.id).id, saved.id);
  const listed = store.getUserChats(alice.id);
  assert.equal(listed[0].id, saved.id);
  assert.equal(listed[0].name, 'Saved Messages');
  assert.equal(listed[0].type, 'saved');
});

test('silent messages and @mentions are stored and projected', () => {
  const alice = store.findUserByPhone('+233501880001');
  const bob = store.findUserByPhone('+233501880002');
  const chat = store.findOrCreateDM(alice.id, bob.id);
  const message = store.addMessage({
    chatId: chat.id,
    senderId: alice.id,
    text: `hello @${bob.handle}`,
    type: 'text',
    silent: true,
    mentions: [bob.id],
  });
  const viewed = store.outMessage(message, bob.id);
  assert.equal(viewed.silent, true);
  assert.deepEqual(viewed.mentions, [bob.id]);
});

test('starred messages and call history stay account-scoped', () => {
  const alice = store.findUserByPhone('+233501880001');
  const bob = store.findUserByPhone('+233501880002');
  const chat = store.findOrCreateDM(alice.id, bob.id);
  const starred = store.addMessage({ chatId: chat.id, senderId: alice.id, text: 'keep this', type: 'text' });
  store.toggleStar(chat.id, starred.id, alice.id);
  store.addMessage({
    chatId: chat.id, senderId: alice.id, text: '', type: 'call',
    call: { media: 'audio', outcome: 'ended', duration: 12, from: alice.id },
  });
  const stars = store.listStarredMessages(alice.id);
  assert.ok(stars.some(item => item.message.id === starred.id));
  assert.equal(store.listStarredMessages(bob.id).some(item => item.message.id === starred.id), false);
  assert.ok(store.listCallHistory(alice.id).some(item => item.message.type === 'call'));
});

test('client hybrid surfaces exist for folders, Saved Messages, search, and mentions', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(html, /data-filter="personal"/);
  assert.match(html, /data-filter="calls"/);
  assert.match(html, /id="inchat-search"/);
  assert.match(html, /id="pin-bar"/);
  assert.match(html, /id="mention-suggest"/);
  assert.match(html, /id="bottom-nav"/);
  assert.match(html, /id="modal-starred"/);
  assert.match(source, /function openSavedMessages/);
  assert.match(source, /function updateMentionSuggest/);
  assert.match(source, /sendMessage\(\{ silent: true \}\)/);
  assert.match(source, /messages:starred/);
  assert.match(source, /calls:history/);
});
