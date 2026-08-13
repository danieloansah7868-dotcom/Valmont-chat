'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vchat-cloud-'));
process.env.VCHAT_DATA_DIR = dataDir;
const store = require('../lib/messenger-store');

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('cloud backup stores theme, wallpaper, and notification settings on the account', () => {
  const alice = store.upsertUserByPhone('+233501770001', { username: 'Cloud Alice' });
  const saved = store.updateDeviceSettings(alice.id, {
    theme: 'dark',
    lite: true,
    wallpaper: { id: 'ocean', dim: 32 },
    notifications: { messageTone: 'soft', mediaVisibility: 'tap' },
  });
  assert.equal(saved.theme, 'dark');
  assert.equal(saved.lite, true);
  assert.equal(saved.wallpaper.id, 'ocean');
  assert.equal(saved.wallpaper.dim, 32);
  assert.equal(saved.notifications.messageTone, 'soft');
  const exported = store.exportAccountData(alice.id);
  assert.equal(exported.settings.theme, 'dark');
  assert.equal(exported.settings.wallpaper.id, 'ocean');
  assert.equal(store.accountView(alice).settings.theme, 'dark');
});

test('SMS transport is limited to one-to-one chats and tagged on the message', () => {
  const alice = store.findUserByPhone('+233501770001');
  const bob = store.upsertUserByPhone('+233501770002', { username: 'Cloud Bob' });
  const dm = store.findOrCreateDM(alice.id, bob.id);
  assert.equal(store.setChatTransport(alice.id, dm.id, 'sms'), 'sms');
  assert.equal(store.chatView(dm, alice.id).transport, 'sms');
  assert.equal(store.setChatTransport(alice.id, 'general', 'sms'), null);
  const message = store.addMessage({
    chatId: dm.id, senderId: alice.id, text: 'sent as SMS', type: 'text', transport: 'sms',
  });
  assert.equal(store.outMessage(message, bob.id).transport, 'sms');
  const inbound = store.routeInboundSms(bob.phone, 'reply over SMS');
  assert.equal(inbound.chatId, dm.id);
  assert.equal(inbound.transport, 'sms');
  assert.equal(inbound.text, 'reply over SMS');
});

test('client has Cloud/SMS switch and a full settings backup surface', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(html, /id="transport-switch"/);
  assert.match(html, /data-transport="sms"/);
  assert.match(html, /id="modal-backup"/);
  assert.match(html, /id="modal-get-app"/);
  assert.match(source, /function collectDeviceSettings/);
  assert.match(source, /function applyDeviceSettings/);
  assert.match(source, /function isNativeApp/);
  assert.match(source, /function openGetApp/);
  assert.match(source, /chat:setTransport/);
  assert.match(source, /\/api\/account\/settings/);
  assert.match(css, /button\.on\[data-transport="cloud"\][^}]+var\(--brand-navy\)/);
  assert.match(css, /button\.on\[data-transport="sms"\][^}]+var\(--brand-gold\)/);
  assert.doesNotMatch(css, /#0a84ff/);
  assert.doesNotMatch(css, /#34c759/);
});
