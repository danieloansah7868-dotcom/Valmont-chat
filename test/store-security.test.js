'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vchat-store-test-'));
process.env.VCHAT_DATA_DIR = dataDir;
const store = require('../lib/messenger-store');

test.after(async () => {
  // Let the debounced persistence adapter finish before removing its test root.
  await new Promise(resolve => setTimeout(resolve, 350));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('sessions are opaque, revocable, and persisted only as digests', async () => {
  const alice = store.upsertUserByPhone('+233240000001', { username: 'Alice' });
  const token = store.createSession(alice.id, { label: 'Test browser', userAgent: 'node:test' });

  assert.equal(store.userForSession(token)?.id, alice.id);
  assert.equal(store.accountView(alice).phone, '+233240000001');
  assert.equal(store.publicUser(alice, 'another-user').phone, undefined);

  await new Promise(resolve => setTimeout(resolve, 350));
  const snapshot = fs.readFileSync(store.DB_FILE, 'utf8');
  assert.equal(snapshot.includes(token), false, 'raw bearer tokens must never be persisted');
  assert.equal(snapshot.includes('+233240000001'), true, 'account snapshots retain the private account number');

  assert.equal(store.destroySession(token), true);
  assert.equal(store.userForSession(token), null);
});

test('privacy, blocking, and group administration enforce authorization', () => {
  const alice = store.findUserByPhone('+233240000001');
  const bob = store.upsertUserByPhone('+233240000002', { username: 'Bob', about: 'Private note' });
  const eve = store.upsertUserByPhone('+233240000003', { username: 'Eve' });

  store.updatePrivacy(bob.id, { about: 'nobody', lastSeen: 'nobody', profilePhoto: 'nobody' });
  store.setProfilePhoto(bob.id, { storageName: 'private-profile.png', mime: 'image/png' });
  const projected = store.publicUser(bob, alice.id);
  assert.equal(projected.about, '');
  assert.equal(projected.lastSeen, null);
  assert.equal(projected.photoUrl, null);
  assert.match(store.accountView(bob).photoUrl, /\/api\/messenger\/profile-photo\//);
  assert.equal(projected.phone, undefined);

  assert.equal(store.blockUser(alice.id, bob.id, true), true);
  assert.equal(store.isBlockedBetween(alice.id, bob.id), true);
  assert.equal(store.blockUser(alice.id, bob.id, false), true);
  assert.equal(store.isBlockedBetween(alice.id, bob.id), false);

  store.updatePrivacy(alice.id, { advancedChatPrivacy: true });
  const unsolicited = store.findOrCreateDM(alice.id, bob.id);
  assert.equal(unsolicited.advancedPrivacy, true, 'new DMs inherit the creator privacy default');
  store.updatePrivacy(alice.id, { advancedChatPrivacy: false });
  store.setAdvancedPrivacy(unsolicited.id, alice.id, false);
  assert.equal(store.isKnownContact(alice.id, bob.id), true, 'starting a chat is an intentional contact');
  assert.equal(store.isKnownContact(bob.id, alice.id), false, 'receiving an unsolicited DM is not');
  store.addMessage({ chatId: unsolicited.id, senderId: bob.id, text: 'Hello', type: 'text' });
  assert.equal(store.isKnownContact(bob.id, alice.id), true, 'replying accepts the contact');

  const group = store.createChat({
    name: 'Authorized group', type: 'group', members: [alice.id, bob.id, eve.id], createdBy: alice.id,
  });
  assert.equal(store.updateGroup(group.id, bob.id, { permissions: { sendMessages: 'admins' } }).permissions.sendMessages, 'members');
  assert.equal(store.updateGroup(group.id, alice.id, { permissions: { sendMessages: 'admins' } }).permissions.sendMessages, 'admins');
  assert.equal(store.canPerform(group, bob.id, 'sendMessages'), false);
  assert.equal(store.setAdvancedPrivacy(group.id, bob.id, true), null);
  assert.equal(store.setAdvancedPrivacy(group.id, alice.id, true)?.advancedPrivacy, true);
  assert.equal(store.setAdmin(group.id, bob.id, eve.id, true), false);
  assert.equal(store.setAdmin(group.id, alice.id, bob.id, true), true);
  assert.equal(store.canPerform(group, bob.id, 'sendMessages'), true);
});

test('attachments are one-use, chat-bound, and safely cloned when forwarded', () => {
  const alice = store.findUserByPhone('+233240000001');
  const bob = store.findUserByPhone('+233240000002');
  const eve = store.findUserByPhone('+233240000003');
  const source = store.findOrCreateDM(alice.id, bob.id);
  const target = store.findOrCreateDM(alice.id, eve.id);

  const upload = store.registerAttachment({
    ownerId: alice.id,
    chatId: source.id,
    storageName: 'opaque-storage-name.png',
    name: 'holiday.png',
    mime: 'image/png',
    size: 1234,
  });
  assert.ok(upload?.id);
  assert.equal(store.getAttachment(upload.id, alice.id)?.id, upload.id);
  assert.equal(store.getAttachment(upload.id, bob.id), null, 'unclaimed uploads are private to the uploader');
  assert.equal(store.getAttachment(upload.id, eve.id), null);

  const file = store.validateAttachment(upload.id, alice.id, source.id);
  assert.equal(file.mimeType, 'image/png');
  const message = store.addMessage({ chatId: source.id, senderId: alice.id, text: '', file, type: 'image' });
  assert.ok(message.id);
  assert.equal(store.validateAttachment(upload.id, alice.id, source.id), null, 'an upload cannot be posted twice');
  assert.equal(store.getAttachment(upload.id, bob.id)?.id, upload.id);
  assert.equal(store.getAttachment(upload.id, eve.id), null);

  const forwarded = store.forwardMessage(source.id, message.id, alice.id, [target.id]);
  assert.equal(forwarded.length, 1);
  assert.notEqual(forwarded[0].file.id, upload.id);
  assert.equal(store.getAttachment(forwarded[0].file.id, eve.id)?.chatId, target.id);
  assert.equal(store.getAttachment(forwarded[0].file.id, bob.id), null);

  assert.equal(store.setAdvancedPrivacy(source.id, alice.id, true)?.advancedPrivacy, true);
  assert.deepEqual(store.forwardMessage(source.id, message.id, alice.id, [target.id]), []);
});
