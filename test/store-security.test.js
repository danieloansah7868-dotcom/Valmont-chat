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
    }));
  `], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, VCHAT_DATA_DIR: dataDir, BOB_ID: bob.id, ALICE_ID: alice.id,
      STORY_ID: story.id, CAMPAIGN_ID: campaign.id,
    },
    encoding: 'utf8',
  });
  assert.equal(restoredChild.status, 0, restoredChild.stderr);
  const restored = JSON.parse(restoredChild.stdout);
  assert.equal(restored.story.myReaction, '🔥');
  assert.equal(restored.campaign.status, 'stopped');
  assert.equal(restored.campaign.reviewer.id, alice.id);

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

test('unique @handles are required for discovery and cannot collide', () => {
  const alice = store.findUserByPhone('+233240000001');
  const bob = store.findUserByPhone('+233240000002');
  assert.ok(alice.handle);
  assert.match(alice.handle, store.HANDLE_RE);
  assert.equal(store.normalizeHandle('Admin'), null, 'reserved handles are rejected');
  assert.equal(store.normalizeHandle('ab'), null);
  assert.equal(store.normalizeHandle('daniel_ok'), 'daniel_ok');

  const taken = store.updateProfile(bob.id, { handle: alice.handle });
  assert.match(taken.error, /already taken/i);

  const ok = store.updateProfile(bob.id, { handle: 'bob_finder' });
  assert.equal(ok.user.handle, 'bob_finder');
  assert.equal(store.findUserByHandle('@Bob_Finder').id, bob.id);

  const hits = store.searchUsers('bob_f', alice.id);
  assert.equal(hits.some(user => user.id === bob.id && user.handle === 'bob_finder'), true);
  assert.equal(hits.every(user => user.phone === undefined), true, 'search never leaks phone numbers');
  assert.equal(store.searchUsers('x', alice.id).length, 0);

  const clash = store.upsertUserByPhone('+233240000088', {
    username: 'Copycat', handle: 'bob_finder',
  });
  assert.match(clash.error, /already taken/i);
  assert.equal(store.findUserByPhone('+233240000088'), null);
});
