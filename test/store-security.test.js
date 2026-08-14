'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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

test('persistence failures remain tracked and a later flush recovers pending state', () => {
  store.flush();
  const originalRename = fs.renameSync;
  fs.renameSync = () => {
    const error = new Error('simulated atomic rename failure');
    error.code = 'EIO';
    throw error;
  };
  try {
    store.save();
    assert.throws(() => store.flush(), /simulated atomic rename failure/);
    const failed = store.persistenceStatus();
    assert.equal(failed.ok, false);
    assert.equal(failed.pending, true, 'failed bytes remain dirty for retry');
    assert.equal(typeof failed.errorAt, 'number');
    assert.throws(() => store.flush(), /simulated atomic rename failure/,
      'a failed final flush cannot be reported as successful');
  } finally {
    fs.renameSync = originalRename;
  }

  assert.equal(store.flush(), true, 'restored storage commits the still-pending snapshot');
  assert.deepEqual(store.persistenceStatus(), { ok: true, pending: false });
});

test('phone verification continuations are phone-bound, single-use, and invalidate older browser flows', () => {
  const first = store.issueCode('+233240000090');
  const firstVerified = store.verifyCode('+233240000090', first.code);
  assert.equal(firstVerified.ok, true);
  assert.equal(store.hasPhoneVerification('+233240000090', firstVerified.continuation), true);
  assert.equal(store.hasPhoneVerification('+233240000091', firstVerified.continuation), false,
    'a continuation cannot authorize a different submitted phone number');

  const replacement = store.issueCode('+233240000090');
  const replacementVerified = store.verifyCode('+233240000090', replacement.code);
  assert.equal(replacementVerified.ok, true);
  assert.equal(store.hasPhoneVerification('+233240000090', firstVerified.continuation), false,
    'a newer successful browser flow invalidates the older continuation for that phone');
  assert.equal(store.consumePhoneVerification('+233240000090', replacementVerified.continuation), true);
  assert.equal(store.consumePhoneVerification('+233240000090', replacementVerified.continuation), false,
    'registration continuation replay is rejected');
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

test('reply snapshots and reactions are canonical, visible, and allowlisted', () => {
  const alice = store.findUserByPhone('+233240000001');
  const bob = store.findUserByPhone('+233240000002');
  const eve = store.findUserByPhone('+233240000003');
  const chat = store.createChat({
    name: 'Canonical messages', type: 'group', members: [alice.id, bob.id], createdBy: alice.id,
  });
  const original = store.addMessage({ chatId: chat.id, senderId: alice.id, text: 'Stored truth', type: 'text' });
  const snapshot = store.replySnapshot(chat.id, original.id, bob.id);
  assert.deepEqual(snapshot, {
    id: original.id, senderId: alice.id, senderName: 'Alice', text: 'Stored truth', preview: 'Stored truth',
  });
  assert.equal(store.replySnapshot(chat.id, original.id, eve.id), null,
    'a non-member cannot obtain reply presentation metadata');

  original.reactions = {
    '👍': [bob.id, bob.id, 'missing-user'],
    '<img src=x onerror=alert(1)>': [bob.id],
  };
  assert.deepEqual(store.outMessage(original, alice.id).reactions, { '👍': [bob.id] },
    'stored legacy or hostile reaction keys are removed from projections');
  assert.equal(store.toggleReaction(chat.id, original.id, bob.id, '<script>'), null);
  assert.equal(store.toggleReaction(chat.id, original.id, eve.id, '❤️'), null);
  assert.deepEqual(store.outMessage(store.toggleReaction(chat.id, original.id, bob.id, '❤️'), alice.id).reactions, {
    '❤️': [bob.id],
  });
  assert.deepEqual(store.deleteMessage(chat.id, original.id, bob.id, false).storageNames, []);
  assert.equal(store.replySnapshot(chat.id, original.id, bob.id), null,
    'a participant cannot reply to a message hidden from their own history');
  assert.equal(store.toggleReaction(chat.id, original.id, bob.id, '👍'), null,
    'retaining a message ID cannot mutate reactions after local deletion');
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
  assert.deepEqual(store.attachmentUsage(alice.id), { bytes: 1234, count: 2, pending: 0 },
    'forwarding shares protected bytes while tracking both authorization records');

  const sourceDeletion = store.deleteMessage(source.id, message.id, alice.id, true);
  assert.deepEqual(sourceDeletion.storageNames, [],
    'deleting a source message preserves bytes still referenced by a forwarded copy');
  assert.equal(store.getAttachment(upload.id, bob.id), null);
  assert.equal(store.getAttachment(forwarded[0].file.id, eve.id)?.id, forwarded[0].file.id);
  const finalDeletion = store.deleteMessage(target.id, forwarded[0].id, alice.id, true);
  assert.deepEqual(finalDeletion.storageNames, ['opaque-storage-name.png'],
    'the final authorization record returns the shared object for physical deletion');
  assert.deepEqual(store.attachmentUsage(alice.id), { bytes: 0, count: 0, pending: 0 });

  assert.equal(store.setAdvancedPrivacy(source.id, alice.id, true)?.advancedPrivacy, true);
  assert.deepEqual(store.forwardMessage(source.id, message.id, alice.id, [target.id]), []);
});

test('attachment visibility and cleanup follow per-user clear, expiry, and abandoned-upload state', () => {
  const alice = store.findUserByPhone('+233240000001');
  const bob = store.findUserByPhone('+233240000002');
  const chat = store.createChat({
    name: 'Attachment lifecycle', type: 'group', members: [alice.id, bob.id], createdBy: alice.id,
  });

  const clearUpload = store.registerAttachment({
    ownerId: alice.id, chatId: chat.id, storageName: 'clear-lifecycle.pdf',
    name: 'clear.pdf', mime: 'application/pdf', size: 500,
  });
  const clearMessage = store.addMessage({
    chatId: chat.id, senderId: alice.id,
    file: store.validateAttachment(clearUpload.id, alice.id, chat.id), type: 'file',
  });
  assert.equal(store.getAttachment(clearUpload.id, bob.id)?.id, clearUpload.id);
  assert.deepEqual(store.clearChat(alice.id, chat.id).storageNames, [],
    'one participant clearing locally cannot delete bytes still visible to another participant');
  assert.equal(store.getAttachment(clearUpload.id, alice.id), null,
    'a cleared participant cannot retrieve old bytes by retaining an attachment ID');
  assert.equal(store.getAttachment(clearUpload.id, bob.id)?.id, clearUpload.id);
  assert.deepEqual(store.clearChat(bob.id, chat.id).storageNames, ['clear-lifecycle.pdf']);
  assert.equal(store.getAttachment(clearUpload.id, bob.id), null);
  assert.equal(clearMessage.file, null, 'the last clear detaches stale message authorization metadata');

  const expiryUpload = store.registerAttachment({
    ownerId: alice.id, chatId: chat.id, storageName: 'expired-lifecycle.png',
    name: 'expired.png', mime: 'image/png', size: 750,
  });
  const expiring = store.addMessage({
    chatId: chat.id, senderId: alice.id,
    file: store.validateAttachment(expiryUpload.id, alice.id, chat.id), type: 'image',
  });
  expiring.expiresAt = Date.now() - 1;
  const expired = store.pruneExpiredMessages().find(item => item.messageId === expiring.id);
  assert.deepEqual(expired.storageNames, ['expired-lifecycle.png']);
  assert.equal(store.getAttachment(expiryUpload.id, alice.id), null);

  const abandoned = store.registerAttachment({
    ownerId: alice.id, chatId: chat.id, storageName: 'abandoned-lifecycle.txt',
    name: 'draft.txt', mime: 'text/plain', size: 250,
  });
  assert.equal(store.attachmentUsage(alice.id).pending, 1);
  assert.deepEqual(
    store.pruneAbandonedAttachments(Date.now() + (60 * 60 * 1000) + 1),
    ['abandoned-lifecycle.txt'],
  );
  assert.equal(store.getAttachment(abandoned.id, alice.id), null);
  assert.equal(store.attachmentUsage(alice.id).pending, 0);
});

test('business identity, chat locks, View Once, and Status saving enforce their privacy boundaries', () => {
  const alice = store.findUserByPhone('+233240000001');
  const bob = store.findUserByPhone('+233240000002');
  const eve = store.findUserByPhone('+233240000003');
  const business = store.upsertUserByPhone('+233240000004', {
    username: 'Accra Studio',
    accountType: 'business',
    businessProfile: {
      name: 'Accra Studio', category: 'professional_services',
      description: 'Photography and design', website: 'https://studio.example',
      email: 'HELLO@STUDIO.EXAMPLE',
    },
  });
  assert.equal(store.accountView(business).accountType, 'business');
  assert.equal(store.businessProfileView(business.id, alice.id).profile.email, 'hello@studio.example');
  assert.equal(store.businessProfileView(business.id, alice.id).canEdit, false);
  store.upsertUserByPhone('+233240000004', { username: 'Accra Studio 2', accountType: 'personal' });
  assert.equal(store.accountView(business).accountType, 'business', 'account type is immutable after registration');
  store.blockUser(alice.id, business.id, true);
  assert.equal(store.businessProfileView(business.id, alice.id), null, 'blocks hide public business pages');
  store.blockUser(alice.id, business.id, false);

  const lockedChat = store.findOrCreateDM(alice.id, eve.id);
  store.addMessage({ chatId: lockedChat.id, senderId: eve.id, text: 'Hidden preview', type: 'text' });
  assert.equal(store.setChatLocked(alice.id, lockedChat.id, true), null, 'a separate lock PIN is required first');
  assert.deepEqual(store.setChatLockPin(alice.id, '246810'), { ok: true });
  assert.equal(store.verifyChatLockPin(alice, '246810'), true);
  assert.equal(store.setTwoStepPin(alice.id, '135790'), true);
  assert.equal(store.verifyTwoStepPin(alice, '246810'), false, 'the chat-lock PIN cannot satisfy two-step verification');
  assert.equal(store.verifyChatLockPin(alice, '135790'), false, 'the two-step PIN cannot unlock hidden chats');

  for (let index = 0; index < store.MAX_CHAT_LOCK_CREDENTIALS; index += 1) {
    const saved = store.addChatLockCredential(alice.id, {
      id: `credential-${index}`, publicKey: `public-key-${index}`, name: `Passkey ${index}`,
    });
    assert.equal(saved.id, `credential-${index}`);
  }
  const overflow = store.addChatLockCredential(alice.id, {
    id: 'credential-overflow', publicKey: 'overflow-public-key', name: 'Passkey overflow',
  });
  assert.match(overflow.error, /up to 10 chat-lock passkeys/i);
  assert.equal(store.listChatLockCredentials(alice.id).length, store.MAX_CHAT_LOCK_CREDENTIALS);
  assert.equal(store.getChatLockCredential(alice.id, 'credential-overflow'), null,
    'a rejected passkey is never persisted or reported as registered');
  const replacement = store.addChatLockCredential(alice.id, {
    id: 'credential-9', publicKey: 'replacement-public-key', name: 'Replacement passkey',
  });
  assert.equal(replacement.id, 'credential-9', 'same-ID credential replacement remains possible at the cap');
  assert.equal(store.getChatLockCredential(alice.id, 'credential-9').publicKey, 'replacement-public-key');
  assert.equal(store.listChatLockCredentials(alice.id).length, store.MAX_CHAT_LOCK_CREDENTIALS);

  assert.ok(store.setChatLocked(alice.id, lockedChat.id, true));
  assert.equal(store.getUserChats(alice.id).some(chat => chat.id === lockedChat.id), false,
    'locked rows and their previews are absent from the normal projection');
  assert.equal(store.getUserChats(alice.id, true).find(chat => chat.id === lockedChat.id).lastMessage.text, 'Hidden preview');

  const firstSession = store.createSession(alice.id, { label: 'Unlocked lock test' });
  const secondSession = store.createSession(alice.id, { label: 'Still locked test' });
  store.unlockChatLockSession(firstSession);
  assert.equal(store.accountView(alice, firstSession).chatLockUnlockedUntil > Date.now(), true);
  assert.equal(store.accountView(alice, secondSession).chatLockUnlockedUntil, null,
    'unlock grants are bounded to one authenticated device session');
  store.lockChatLockSession(firstSession);
  assert.equal(store.isChatLockSessionUnlocked(firstSession), false);

  const group = store.createChat({
    name: 'View Once recipients', type: 'group', members: [alice.id, bob.id, eve.id], createdBy: alice.id,
  });
  const upload = store.registerAttachment({
    ownerId: alice.id, chatId: group.id, storageName: 'view-once.png',
    name: 'private.png', mime: 'image/png', size: 99,
  });
  const file = store.validateAttachment(upload.id, alice.id, group.id);
  const once = store.addMessage({
    chatId: group.id, senderId: alice.id, file, type: 'image', viewOnce: true,
  });
  const beforeOpen = store.outMessage(once, bob.id);
  assert.equal(beforeOpen.viewOnce, true);
  assert.equal(beforeOpen.file.url, null, 'normal media URLs are not exposed to a View Once recipient');
  assert.equal(store.getAttachment(upload.id, bob.id), null, 'normal attachment retrieval is disabled');
  assert.deepEqual(store.forwardMessage(group.id, once.id, bob.id, [lockedChat.id]), [],
    'View Once media cannot be forwarded');
  assert.equal(store.openViewOnceMessage(group.id, once.id, bob.id).attachment.id, upload.id);
  assert.equal(store.openViewOnceMessage(group.id, once.id, bob.id), null, 'each recipient can consume only once');
  assert.equal(store.outMessage(once, bob.id).file, null, 'consumed media disappears from message projections');
  assert.equal(store.openViewOnceMessage(group.id, once.id, eve.id).attachment.id, upload.id,
    'another recipient retains an independent one-time opening');
  assert.equal(store.outMessage(once, alice.id).viewOnceOpenedCount, 2);
  assert.deepEqual(store.finalizeViewOnceAttachment(group.id, once.id), ['view-once.png']);
  assert.equal(once.file, null);
  assert.equal(store.getAttachment(upload.id, eve.id, { allowViewOnce: true }), null,
    'the final recipient consumption revokes metadata for the shared bytes');

  const noSave = store.createStory(alice.id, { type: 'text', text: 'Do not save', background: 'jade' });
  const savable = store.createStory(alice.id, {
    type: 'text', text: 'Owner-approved save', background: 'ocean', allowSave: true,
  });
  const bobStories = store.listStories(bob.id).flatMap(item => item.items);
  assert.equal(bobStories.find(item => item.id === noSave.id).canSave, false);
  assert.equal(bobStories.find(item => item.id === noSave.id).saveUrl, null);
  assert.equal(bobStories.find(item => item.id === savable.id).canSave, true);
  assert.match(bobStories.find(item => item.id === savable.id).saveUrl, /\/save$/);
});

test('reels persist likes and enforce stable pagination, blocks, and ownership', async () => {
  const alice = store.findUserByPhone('+233240000001');
  const bob = store.findUserByPhone('+233240000002');
  const eve = store.findUserByPhone('+233240000003');
  const created = [0, 1, 2].map(index => store.createReel(alice.id, {
    storageName: `opaque-reel-${index}.mp4`,
    mime: 'video/mp4',
    size: 128 + index,
    caption: `Reel ${index} 🎬`,
  }));
  assert.ok(created.every(Boolean));
  assert.equal(store.listReels(bob.id, { cursor: 'not-a-cursor' }), null);

  const seen = [];
  let cursor = null;
  do {
    const page = store.listReels(bob.id, { cursor, limit: 1 });
    assert.equal(page.items.length, 1);
    seen.push(page.items[0].id);
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(new Set(seen).size, created.length, 'cursor pages must not duplicate tied timestamps');
  assert.deepEqual(new Set(seen), new Set(created.map(reel => reel.id)));

  const liked = store.setReelLike(created[0].id, bob.id, true);
  assert.equal(liked.liked, true);
  assert.equal(liked.likeCount, 1);
  assert.equal(store.reelView(store.getReel(created[0].id, alice.id), alice.id).liked, false);
  assert.equal(store.deleteReel(created[0].id, eve.id), null, 'only the owner may delete a reel');

  assert.equal(store.blockUser(bob.id, alice.id, true), true);
  assert.equal(store.getReel(created[0].id, bob.id), null);
  assert.equal(store.setReelLike(created[0].id, bob.id, false), null);
  assert.equal(store.listReels(bob.id, { limit: 30 }).items.some(reel => seen.includes(reel.id)), false);
  assert.equal(store.blockUser(bob.id, alice.id, false), true);

  await new Promise(resolve => setTimeout(resolve, 350));
  const snapshot = JSON.parse(fs.readFileSync(store.DB_FILE, 'utf8'));
  const persisted = snapshot.reels.find(reel => reel.id === created[0].id);
  assert.deepEqual(persisted.likedBy, [bob.id], 'likes serialize as arrays rather than leaking Set internals');

  const child = spawnSync(process.execPath, ['-e', `
    const store = require('./lib/messenger-store');
    const item = store.listReels(process.env.VIEWER_ID, { limit: 30 }).items.find(r => r.id === process.env.REEL_ID);
    process.stdout.write(JSON.stringify(item));
  `], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, VCHAT_DATA_DIR: dataDir, VIEWER_ID: bob.id, REEL_ID: created[0].id },
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  const restored = JSON.parse(child.stdout);
  assert.equal(restored.caption, 'Reel 0 🎬');
  assert.equal(restored.liked, true);
  assert.equal(restored.likeCount, 1);

  const removed = store.deleteReel(created[0].id, alice.id);
  assert.equal(removed.ownerId, alice.id);
  assert.equal(store.getReel(created[0].id, alice.id), null);
});

test('stories enforce mutual-contact privacy and campaigns require review plus exact payment', async () => {
  const alice = store.findUserByPhone('+233240000001');
  const bob = store.findUserByPhone('+233240000002');
  const outsider = store.upsertUserByPhone('+233240000099', { username: 'Outsider' });

  const story = store.createStory(alice.id, {
    type: 'text', text: 'Friends only status', background: 'ocean',
  });
  assert.ok(story?.id);
  assert.equal(store.listStories(bob.id).flatMap(group => group.items).some(item => item.id === story.id), true);
  assert.equal(store.listStories(outsider.id).flatMap(group => group.items).some(item => item.id === story.id), false);
  assert.equal(store.getStory(story.id, outsider.id), null);

  const viewed = store.recordStoryView(story.id, bob.id);
  assert.equal(viewed.seen, true);
  assert.equal(store.setStoryReaction(story.id, bob.id, '🔥').myReaction, '🔥');
  assert.equal(store.setStoryReaction(story.id, bob.id, 'not-allowed'), null);
  assert.equal(store.recordStoryView(story.id, outsider.id), null);
  const ownerFeedStory = store.listStories(alice.id).flatMap(group => group.items).find(item => item.id === story.id);
  assert.equal(ownerFeedStory.viewCount, 1);
  assert.equal(ownerFeedStory.reactionCount, 1);

  store.blockUser(bob.id, alice.id, true);
  assert.equal(store.getStory(story.id, bob.id), null);
  store.blockUser(bob.id, alice.id, false);

  const campaign = store.createStoryCampaign(alice.id, story.id, {
    type: 'text', text: 'Promoted update', background: 'jade', objective: 'profile_visits',
    cta: 'Visit profile', audience: 'broad', budgetGhs: 25, durationDays: 3,
    billingEmail: 'alice@example.com', paymentProvider: 'valmontpay',
  });
  assert.ok(campaign?.id);
  assert.equal(campaign.status, 'pending_review');
  assert.equal(store.setCampaignPaymentInitialization(campaign.id, outsider.id, { initialized: true }), null);
  const initialized = store.setCampaignPaymentInitialization(campaign.id, alice.id, {
    provider: 'valmontpay', reference: 'story-test-reference',
    authorizationUrl: 'https://valmontpay.app/pay.html?access_code=ac_test', initialized: true,
  });
  assert.equal(initialized.paymentStatus, 'pending');
  assert.equal(initialized.checkoutUrl, 'https://valmontpay.app/pay.html?access_code=ac_test');

  store.reviewStoryCampaign(campaign.id, { approved: true, note: 'Creative approved', reviewerId: alice.id });
  assert.equal(store.listEligibleStoryAds(bob.id).some(item => item.id === campaign.id), false,
    'approval without verified payment cannot activate delivery');
  assert.equal(store.confirmCampaignPayment('story-test-reference', { amount: 2499, currency: 'GHS' }), null);
  assert.equal(store.confirmCampaignPayment('story-test-reference', { amount: 2500, currency: 'USD' }), null);
  assert.ok(store.confirmCampaignPayment('story-test-reference', { amount: 2500, currency: 'GHS', providerId: 'pay-1' }));
  assert.ok(store.confirmCampaignPayment('story-test-reference', { amount: 2500, currency: 'GHS', providerId: 'pay-1' }),
    'provider verification retries are idempotent');
  assert.equal(store.confirmCampaignPayment('story-test-reference', { amount: 2500, currency: 'GHS', providerId: 'different-charge' }), null,
    'a second provider charge cannot overwrite a captured payment');
  assert.equal(store.listPaymentLedger(campaign.id, outsider.id).length, 0, 'financial records are owner-private');
  assert.equal(store.listPaymentLedger(campaign.id, alice.id).length, 1);
  assert.equal(store.listPaymentLedger(campaign.id, alice.id)[0].kind, 'payment_captured');
  const webhookDigest = 'a'.repeat(64);
  const webhook = store.processValmontPayWebhook({
    digest: webhookDigest, event: 'charge.success', status: 'success', reference: 'story-test-reference',
    amount: 2500, currency: 'GHS', providerId: 'pay-1',
  });
  assert.equal(webhook.outcome, 'confirmed');
  assert.equal(store.processValmontPayWebhook({ digest: webhookDigest }).duplicate, true,
    'signed webhook delivery retries use the durable inbox digest');
  assert.equal(store.getPaymentWebhookInbox().filter(entry => entry.digest === webhookDigest).length, 1);
  assert.equal(store.listPaymentLedger(campaign.id, alice.id).length, 1,
    'webhook and verification paths share one capture ledger entry');

  const eligible = store.listEligibleStoryAds(bob.id).find(item => item.id === campaign.id);
  assert.ok(eligible);
  assert.equal(eligible.checkoutUrl, undefined, 'billing checkout is visible only to the advertiser/admin');
  assert.equal(store.listEligibleStoryAds(alice.id).some(item => item.id === campaign.id), false,
    'advertisers do not receive their own campaign');
  assert.equal(store.listStories(outsider.id).flatMap(group => group.items).some(item => item.id === story.id), false);
  assert.equal(store.listEligibleStoryAds(outsider.id).some(item => item.id === campaign.id), true,
    'broad campaigns remain discoverable to an eligible user with no friend Status');
  assert.equal(store.recordCampaignEvent(campaign.id, outsider.id, 'impression')?.id, campaign.id);
  assert.equal(store.recordCampaignEvent(campaign.id, outsider.id, 'impression')?.id, campaign.id);
  assert.equal(store.recordCampaignEvent(campaign.id, outsider.id, 'click')?.id, campaign.id);
  assert.equal(store.recordCampaignEvent(campaign.id, outsider.id, 'click')?.id, campaign.id);
  const report = store.listStoryCampaigns(alice.id).find(item => item.id === campaign.id);
  assert.equal(report.impressionCount, 1, 'duplicate measurement calls are idempotent per viewer');
  assert.equal(report.reachCount, 1);
  assert.equal(report.clickCount, 1);
  assert.equal(report.reviewer.id, alice.id);
  assert.ok(report.reviewedAt);

  assert.equal(store.controlStoryCampaign(campaign.id, outsider.id, 'pause'), null);
  assert.equal(store.controlStoryCampaign(campaign.id, alice.id, 'pause').status, 'paused');
  assert.equal(store.listEligibleStoryAds(bob.id).some(item => item.id === campaign.id), false);
  assert.equal(store.controlStoryCampaign(campaign.id, alice.id, 'resume').status, 'active');
  assert.equal(store.listEligibleStoryAds(bob.id).some(item => item.id === campaign.id), true);
  assert.equal(store.controlStoryCampaign(campaign.id, alice.id, 'stop').status, 'stopped');
  assert.equal(store.controlStoryCampaign(campaign.id, alice.id, 'resume'), null);
  assert.equal(store.reviewStoryCampaign(campaign.id, { approved: true, reviewerId: alice.id }), null, 'review decisions are final');

  assert.ok(store.recordCampaignRefund(campaign.id, {
    actorId: alice.id, amountMinor: 500, providerRefundId: 'refund-1', reason: 'Partial service credit',
  }));
  assert.ok(store.recordCampaignRefund(campaign.id, {
    actorId: alice.id, amountMinor: 500, providerRefundId: 'refund-1', reason: 'Idempotent retry',
  }), 'the provider refund identifier makes retries idempotent');
  assert.equal(store.recordCampaignRefund(campaign.id, {
    actorId: alice.id, amountMinor: 600, providerRefundId: 'refund-1', reason: 'Conflicting retry',
  }), null);
  assert.equal(store.recordCampaignRefund(campaign.id, {
    actorId: alice.id, amountMinor: 2001, providerRefundId: 'refund-too-large', reason: 'Over-refund',
  }), null, 'refund totals cannot exceed captured funds');
  assert.equal(store.listStoryCampaigns(alice.id).find(item => item.id === campaign.id).paymentStatus,
    'partially_refunded');
  assert.equal(store.listPaymentLedger(campaign.id, alice.id).length, 2);
  assert.deepEqual(store.listPaymentReconciliation().filter(issue => issue.campaignId === campaign.id), []);

  const latePayment = store.createStoryCampaign(alice.id, story.id, {
    type: 'text', text: 'Stopped before payment', objective: 'messages', cta: 'Send message',
    audience: 'broad', budgetGhs: 10, durationDays: 1, billingEmail: 'alice@example.com',
    paymentProvider: 'valmontpay',
  });
  store.setCampaignPaymentInitialization(latePayment.id, alice.id, {
    provider: 'valmontpay', reference: 'late-payment-reference', initialized: true,
  });
  store.reviewStoryCampaign(latePayment.id, { approved: true, reviewerId: alice.id });
  assert.equal(store.controlStoryCampaign(latePayment.id, alice.id, 'stop').status, 'stopped');
  store.confirmCampaignPayment('late-payment-reference', { amount: 1000, currency: 'GHS' });
  assert.equal(store.listStoryCampaigns(alice.id).find(item => item.id === latePayment.id).status, 'stopped',
    'a late provider webhook cannot restart a stopped campaign');

  const pausedExpiry = store.createStoryCampaign(alice.id, story.id, {
    storageName: 'paused-campaign.png', type: 'image', mime: 'image/png', size: 10,
    text: 'Paused until reservation end', objective: 'profile_visits', cta: 'Visit profile',
    audience: 'broad', budgetGhs: 10, durationDays: 1, billingEmail: 'alice@example.com',
  });
  assert.equal(store.reviewStoryCampaign(pausedExpiry.id, {
    approved: true, waivePayment: true, reviewerId: alice.id,
  }), null, 'complimentary account credit requires a documented reason');
  store.reviewStoryCampaign(pausedExpiry.id, {
    approved: true, waivePayment: true, reviewerId: alice.id, note: 'Test account credit',
  });
  const creditEntries = store.listPaymentLedger(pausedExpiry.id, alice.id);
  assert.equal(creditEntries.length, 1);
  assert.equal(creditEntries[0].kind, 'account_credit_waiver');
  assert.equal(creditEntries[0].reason, 'Test account credit');
  assert.equal(store.controlStoryCampaign(pausedExpiry.id, alice.id, 'pause').status, 'paused');
  const pausedEndAt = store.listStoryCampaigns(alice.id).find(item => item.id === pausedExpiry.id).endAt;
  assert.deepEqual(store.pruneExpiredStoryCampaigns(pausedEndAt + 1), ['paused-campaign.png']);
  assert.equal(store.listStoryCampaigns(alice.id).find(item => item.id === pausedExpiry.id).status, 'completed',
    'pausing delivery does not extend the fixed reservation window');
  assert.equal(store.controlStoryCampaign(pausedExpiry.id, alice.id, 'resume', { now: pausedEndAt + 1 }), null,
    'an ended paused campaign cannot resume');

  await new Promise(resolve => setTimeout(resolve, 350));
  const restoredChild = spawnSync(process.execPath, ['-e', `
    const store = require('./lib/messenger-store');
    process.stdout.write(JSON.stringify({
      story: store.listStories(process.env.BOB_ID).flatMap(group => group.items).find(item => item.id === process.env.STORY_ID),
      campaign: store.listStoryCampaigns(process.env.ALICE_ID).find(item => item.id === process.env.CAMPAIGN_ID),
      ledger: store.listPaymentLedger(process.env.CAMPAIGN_ID, process.env.ALICE_ID),
      webhook: store.getPaymentWebhookInbox().find(entry => entry.digest === process.env.WEBHOOK_DIGEST),
    }));
  `], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, VCHAT_DATA_DIR: dataDir, BOB_ID: bob.id, ALICE_ID: alice.id,
      STORY_ID: story.id, CAMPAIGN_ID: campaign.id, WEBHOOK_DIGEST: webhookDigest,
    },
    encoding: 'utf8',
  });
  assert.equal(restoredChild.status, 0, restoredChild.stderr);
  const restored = JSON.parse(restoredChild.stdout);
  assert.equal(restored.story.myReaction, '🔥');
  assert.equal(restored.campaign.status, 'stopped');
  assert.equal(restored.campaign.reviewer.id, alice.id);
  assert.equal(restored.ledger.length, 2);
  assert.equal(restored.ledger[0].providerId, 'pay-1');
  assert.equal(restored.ledger[1].providerId, 'refund-1');
  assert.equal(restored.webhook.event, 'charge.success');

  const restartMediaName = 'restart-expired-story.png';
  const restartMediaDir = path.join(dataDir, 'media');
  fs.mkdirSync(restartMediaDir, { recursive: true });
  fs.writeFileSync(path.join(restartMediaDir, restartMediaName), 'expired protected bytes');
  const restartExpired = store.createStory(alice.id, {
    type: 'image', text: 'Expires across restart', storageName: restartMediaName,
    mime: 'image/png', size: 23,
  });
  const rawRestartExpired = store.getStory(restartExpired.id, alice.id);
  rawRestartExpired.expiresAt = Date.now() - 1;
  store.createStory(alice.id, { type: 'text', text: 'Persistence flush', background: 'jade' });
  await new Promise(resolve => setTimeout(resolve, 350));

  const cleanupChild = spawnSync(process.execPath, ['-e', `
    const fs = require('node:fs');
    const path = require('node:path');
    const http = require('node:http');
    const express = require('express');
    const app = express();
    app.locals.isOriginAllowed = () => true;
    require('./lib/messenger').attach(http.createServer(app), app);
    setTimeout(() => {
      const snapshot = JSON.parse(fs.readFileSync(process.env.DB_FILE, 'utf8'));
      process.stdout.write(JSON.stringify({
        mediaExists: fs.existsSync(path.join(process.env.MEDIA_DIR, process.env.MEDIA_NAME)),
        metadataExists: snapshot.stories.some(item => item.id === process.env.STORY_ID),
      }));
    }, 450);
  `], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, VCHAT_DATA_DIR: dataDir, DB_FILE: store.DB_FILE, MEDIA_DIR: restartMediaDir,
      MEDIA_NAME: restartMediaName, STORY_ID: restartExpired.id,
    },
    encoding: 'utf8',
  });
  assert.equal(cleanupChild.status, 0, cleanupChild.stderr);
  assert.deepEqual(JSON.parse(cleanupChild.stdout), { mediaExists: false, metadataExists: false },
    'service startup removes both expired Story metadata and protected bytes');

  const rawStory = store.getStory(story.id, alice.id);
  rawStory.expiresAt = Date.now() - 1;
  assert.equal(store.pruneExpiredStories().some(item => item.id === story.id), true);
  assert.equal(store.getStory(story.id, alice.id), null);
});

test('protected media usage deduplicates bytes across every account-owned media class', () => {
  const owner = store.upsertUserByPhone('+233240000098', { username: 'Quota Owner' });
  const bob = store.findUserByPhone('+233240000002');
  const chat = store.findOrCreateDM(owner.id, bob.id);

  store.setProfilePhoto(owner.id, { storageName: 'quota-profile.png', mime: 'image/png', size: 11 });
  const upload = store.registerAttachment({
    ownerId: owner.id,
    chatId: chat.id,
    storageName: 'quota-attachment.png',
    name: 'quota.png',
    mime: 'image/png',
    size: 13,
  });
  const file = store.validateAttachment(upload.id, owner.id, chat.id);
  const message = store.addMessage({ chatId: chat.id, senderId: owner.id, type: 'image', file });
  assert.ok(message?.id);
  assert.equal(store.forwardMessage(chat.id, message.id, owner.id, [chat.id]).length, 1,
    'forwarding creates another authorization record for the same protected object');

  assert.ok(store.createReel(owner.id, {
    storageName: 'quota-reel.mp4', mime: 'video/mp4', size: 17, caption: 'Quota',
  }));
  const story = store.createStory(owner.id, {
    type: 'image', storageName: 'quota-story.png', mime: 'image/png', size: 19,
  });
  assert.ok(story?.id);
  assert.ok(store.createStoryCampaign(owner.id, story.id, {
    storageName: 'quota-campaign.png', type: 'image', mime: 'image/png', size: 19,
    objective: 'profile_visits', cta: 'Visit profile', audience: 'broad',
    budgetGhs: 25, durationDays: 3, billingEmail: 'quota@example.com', paymentProvider: 'valmontpay',
  })?.id);

  assert.deepEqual(store.protectedMediaUsage(owner.id), { bytes: 79, objects: 5 });
  assert.deepEqual(store.protectedMediaUsage(owner.id, 'quota-profile.png'), { bytes: 68, objects: 4 },
    'profile-photo replacement can exclude bytes that will be removed atomically');
});

test('service restart prunes fully opened View Once metadata and protected bytes', async () => {
  const owner = store.upsertUserByPhone('+233240000096', { username: 'Restart Sender' });
  const recipient = store.upsertUserByPhone('+233240000097', { username: 'Restart Recipient' });
  const chat = store.findOrCreateDM(owner.id, recipient.id);
  const mediaDir = path.join(dataDir, 'media');
  const storageName = 'restart-consumed-view-once.png';
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(path.join(mediaDir, storageName), 'consumed protected bytes');
  const upload = store.registerAttachment({
    ownerId: owner.id, chatId: chat.id, storageName, name: 'once.png', mime: 'image/png', size: 24,
  });
  const file = store.validateAttachment(upload.id, owner.id, chat.id);
  const message = store.addMessage({
    chatId: chat.id, senderId: owner.id, type: 'image', file, viewOnce: true,
  });
  assert.ok(store.openViewOnceMessage(chat.id, message.id, recipient.id));
  assert.equal(fs.existsSync(path.join(mediaDir, storageName)), true,
    'issuing an in-memory transfer grant leaves the bytes available until transfer termination');
  await new Promise(resolve => setTimeout(resolve, 350));

  const child = spawnSync(process.execPath, ['-e', `
    const fs = require('node:fs');
    const path = require('node:path');
    const http = require('node:http');
    const express = require('express');
    const app = express();
    app.locals.isOriginAllowed = () => true;
    require('./lib/messenger').attach(http.createServer(app), app);
    setTimeout(() => {
      const snapshot = JSON.parse(fs.readFileSync(process.env.DB_FILE, 'utf8'));
      const message = snapshot.messages.flatMap(([, items]) => items)
        .find(item => item.id === process.env.MESSAGE_ID);
      process.stdout.write(JSON.stringify({
        mediaExists: fs.existsSync(path.join(process.env.MEDIA_DIR, process.env.MEDIA_NAME)),
        attachmentExists: snapshot.attachments.some(([id]) => id === process.env.ATTACHMENT_ID),
        messageHasFile: Boolean(message?.file),
      }));
    }, 450);
  `], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, VCHAT_DATA_DIR: dataDir, DB_FILE: store.DB_FILE, MEDIA_DIR: mediaDir,
      MEDIA_NAME: storageName, MESSAGE_ID: message.id, ATTACHMENT_ID: upload.id,
    },
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    mediaExists: false, attachmentExists: false, messageHasFile: false,
  });
});

test('account deletion durably tombstones identity, revokes access, redacts content, and protects shared media', () => {
  const owner = store.upsertUserByPhone('+233240000095', { username: 'Delete Me', about: 'private deletion note' });
  const peer = store.findUserByPhone('+233240000002');
  const chat = store.findOrCreateDM(owner.id, peer.id);
  const session = store.createSession(owner.id, { label: 'Deletion device' });
  store.setTwoStepPin(owner.id, '953159');
  store.setProfilePhoto(owner.id, { storageName: 'delete-profile.png', mime: 'image/png', size: 10 });

  const shared = store.registerAttachment({
    ownerId: owner.id, chatId: chat.id, storageName: 'delete-shared.png',
    name: 'private.png', mime: 'image/png', size: 12,
  });
  store.registerAttachment({
    ownerId: peer.id, chatId: chat.id, storageName: 'delete-shared.png',
    name: 'peer-copy.png', mime: 'image/png', size: 12,
  });
  const sent = store.addMessage({
    chatId: chat.id,
    senderId: owner.id,
    text: 'account deletion secret body',
    type: 'image',
    file: store.validateAttachment(shared.id, owner.id, chat.id),
  });
  const incoming = store.addMessage({ chatId: chat.id, senderId: peer.id, text: 'reply target', type: 'text' });
  assert.ok(store.toggleReaction(chat.id, incoming.id, owner.id, '❤️'));
  const reply = store.addMessage({
    chatId: chat.id, senderId: peer.id, text: 'recipient reply', type: 'text',
    replyTo: store.replySnapshot(chat.id, sent.id, peer.id),
  });

  const story = store.createStory(owner.id, {
    type: 'image', storageName: 'delete-story.png', mime: 'image/png', size: 14, text: 'private Status',
  });
  const reel = store.createReel(owner.id, {
    storageName: 'delete-reel.mp4', mime: 'video/mp4', size: 16, caption: 'private reel caption',
  });
  const campaign = store.createStoryCampaign(owner.id, story.id, {
    storageName: 'delete-campaign.png', type: 'image', mime: 'image/png', size: 18,
    text: 'private campaign creative', objective: 'profile_visits', cta: 'Visit profile',
    audience: 'broad', budgetGhs: 25, durationDays: 3,
    billingEmail: 'delete-me@example.com', paymentProvider: 'valmontpay',
  });
  assert.ok(reel?.id && campaign?.id);
  const group = store.createChat({
    name: 'Deletion admin handoff', type: 'group', members: [owner.id, peer.id], createdBy: owner.id,
  });
  store.reportUser(owner.id, peer.id, 'submitted abuse report', chat.id);
  store.rateCall({
    callId: 'delete-call', userId: owner.id, chatId: chat.id, media: 'audio', stars: 2,
    tags: ['audio'], note: 'private rating note', duration: 30,
  });

  const result = store.deleteAccount(owner.id, { requestedAt: 1_800_000_000_000 });
  assert.equal(result.deletedAt, 1_800_000_000_000);
  assert.equal(result.storageNames.includes('delete-shared.png'), false,
    'bytes still referenced by another attachment must not be physically removed');
  for (const name of ['delete-profile.png', 'delete-story.png', 'delete-reel.mp4', 'delete-campaign.png']) {
    assert.equal(result.storageNames.includes(name), true, `${name} should be eligible for physical cleanup`);
  }
  assert.equal(store.userForSession(session), null);
  assert.equal(store.findUserByPhone('+233240000095'), null);
  assert.equal(store.getAllUsers(peer.id).some(user => user.id === owner.id), false);
  assert.equal(store.exportAccountData(owner.id), null);
  assert.equal(store.getChat(group.id).admins.has(peer.id), true, 'a surviving group member becomes admin');
  assert.equal(store.getStory(story.id, peer.id), null);
  assert.equal(store.getCallRatings({ userId: owner.id }).length, 0);

  const redacted = store.getRawMessage(chat.id, sent.id);
  assert.equal(redacted.deleted, true);
  assert.equal(redacted.text, '');
  assert.equal(redacted.file, null);
  assert.equal(store.getRawMessage(chat.id, incoming.id).reactions['❤️'], undefined);
  assert.deepEqual(store.getRawMessage(chat.id, reply.id).replyTo, {
    ...store.getRawMessage(chat.id, reply.id).replyTo,
    senderName: 'Deleted account', text: '', preview: 'Deleted message',
  });
  const retainedCampaign = store.listStoryCampaigns(owner.id).find(item => item.id === campaign.id);
  assert.equal(retainedCampaign.billingEmail, '');
  assert.equal(retainedCampaign.text, '');
  assert.equal(retainedCampaign.mediaUrl, null);
  assert.equal(retainedCampaign.status, 'stopped');

  const tombstone = store.getUser(owner.id);
  assert.equal(tombstone.username, 'Deleted account');
  assert.equal(tombstone.phone, null);
  assert.equal(tombstone.pinHash, null);
  assert.equal(tombstone.chatLock.credentials.length, 0);
  assert.equal(store.deleteAccount(owner.id), null, 'deletion is not applied twice');

  store.flush();
  const snapshot = fs.readFileSync(store.DB_FILE, 'utf8');
  for (const secret of [
    '+233240000095', 'account deletion secret body', 'private deletion note',
    'private Status', 'private reel caption', 'private campaign creative', 'delete-me@example.com',
  ]) assert.equal(snapshot.includes(secret), false, `${secret} must not survive in the durable snapshot`);
});
