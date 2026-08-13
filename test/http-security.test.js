'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { io: socketClient } = require('socket.io-client');

const root = path.join(__dirname, '..');

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function startServer(t, extraEnv = {}, seed = null) {
  const port = await availablePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vchat-http-test-'));
  const env = {
    ...process.env,
    PORT: String(port),
    VCHAT_DATA_DIR: dataDir,
    NODE_ENV: 'test',
    REEL_MAX_MB: '1',
    REEL_UPLOAD_LIMIT: '50',
    STORY_MAX_MB: '1',
    STORY_UPLOAD_LIMIT: '50',
    STORY_AD_ADMIN_PHONES: '+233241234567',
    ...extraEnv,
  };
  delete env.TWILIO_ACCOUNT_SID;
  delete env.TWILIO_AUTH_TOKEN;
  delete env.TWILIO_FROM;
  if (!Object.hasOwn(extraEnv, 'VALMONTPAY_SECRET_KEY')) delete env.VALMONTPAY_SECRET_KEY;
  if (!Object.hasOwn(extraEnv, 'VALMONTPAY_API_URL')) delete env.VALMONTPAY_API_URL;
  if (seed) await seed({ dataDir, env });
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start: ${output}`)), 5000);
    const onData = chunk => {
      output += chunk;
      if (output.includes('VChat is live')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`server exited with ${code}: ${output}`));
    });
  });
  await ready;
  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${port}`, dataDir };
}

function jsonRequest(url, body, headers = {}, method = 'POST') {
  return fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function startValmontPayStub(t, secret) {
  const port = await availablePort();
  const requests = [];
  const initialized = new Map();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString();
      const body = rawBody ? JSON.parse(rawBody) : null;
      requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
      res.setHeader('Content-Type', 'application/json');
      if (req.headers.authorization !== `Bearer ${secret}`) {
        res.statusCode = 401;
        return res.end(JSON.stringify({ status: false, message: 'Unauthorized' }));
      }
      if (req.method === 'POST' && req.url === '/api/transaction/initialize') {
        initialized.set(body.reference, body);
        return res.end(JSON.stringify({
          status: true,
          data: {
            access_code: 'ac_contract_test',
            reference: body.reference,
            amount: body.amount,
            currency: body.currency,
            pay_url: `https://valmontpay.app/pay.html?access_code=ac_contract_test`,
          },
        }));
      }
      const verifyMatch = req.method === 'GET' && req.url.match(/^\/api\/transaction\/verify\/(.+)$/);
      if (verifyMatch && initialized.has(decodeURIComponent(verifyMatch[1]))) {
        const payment = initialized.get(decodeURIComponent(verifyMatch[1]));
        return res.end(JSON.stringify({
          status: true,
          data: {
            reference: payment.reference,
            status: 'success',
            amount: payment.amount,
            currency: payment.currency,
            channel: 'mobile_money',
            paid_at: '2025-06-15T12:00:00Z',
            merchant: 'vchat',
            gateway_reference: payment.reference,
          },
        }));
      }
      res.statusCode = 404;
      return res.end(JSON.stringify({ status: false, message: 'Not found' }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { base: `http://127.0.0.1:${port}`, requests };
}

function socketAck(socket, event, payload, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for socket acknowledgement: ${event}`)), timeoutMs);
    socket.emit(event, payload, result => {
      clearTimeout(timer);
      if (result?.error) reject(new Error(result.error));
      else resolve(result);
    });
  });
}

function socketEvent(socket, event, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`timed out waiting for socket event: ${event}`));
    }, timeoutMs);
    const onEvent = (...args) => {
      clearTimeout(timer);
      resolve(args);
    };
    socket.once(event, onEvent);
  });
}

test('HTTP security boundary protects sessions, mutations, media, and legacy uploads', async t => {
  const { base, dataDir } = await startServer(t);

  let response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('cache-control'), 'no-cache');

  response = await fetch(`${base}/manifest.webmanifest`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/manifest\+json/);
  response = await fetch(`${base}/uploads/.gitkeep`);
  assert.equal(response.status, 404);
  response = await fetch(`${base}/api/messenger/media/not-real`);
  assert.equal(response.status, 401);

  response = await jsonRequest(`${base}/api/auth/request-code`, { dialCode: '233', number: '241234567' });
  assert.equal(response.status, 200);
  const request = await response.json();
  assert.match(request.devCode, /^\d{6}$/);
  assert.equal(request.registered, undefined, 'code requests must not disclose whether an account exists');
  assert.equal(request.username, undefined, 'code requests must not disclose account profile data');

  response = await jsonRequest(`${base}/api/auth/verify`, { phone: request.phone, code: request.devCode });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).needsProfile, true);

  response = await jsonRequest(`${base}/api/auth/register`, {
    phone: request.phone,
    username: 'HTTP Tester',
    avatar: 'T',
    accountType: 'business',
    businessProfile: {
      name: 'HTTP Test Studio', category: 'technology', description: 'Public test purpose',
      website: 'https://studio.example', email: 'hello@studio.example', address: 'Accra',
    },
  });
  assert.equal(response.status, 200);
  const setCookie = response.headers.get('set-cookie');
  assert.match(setCookie, /^vchat_session=[^;]+/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Priority=High/);
  const cookie = setCookie.match(/^([^;]+)/)[1];
  const account = (await response.json()).user;
  assert.equal(account.phone, request.phone);
  assert.equal(account.accountType, 'business');
  assert.equal(account.business.name, 'HTTP Test Studio');

  response = await fetch(`${base}/api/auth/session`, { headers: { cookie } });
  assert.equal(response.status, 200);
  response = await fetch(`${base}/api/messenger/chats`, { headers: { cookie } });
  assert.equal(response.status, 200);
  assert.ok((await response.json()).some(chat => chat.id === 'general'));

  response = await jsonRequest(
    `${base}/api/account/privacy`,
    { readReceipts: false },
    { cookie, origin: 'https://evil.example' },
    'PATCH',
  );
  assert.equal(response.status, 403);

  response = await jsonRequest(
    `${base}/api/account/privacy`,
    { readReceipts: false },
    { cookie, origin: base },
    'PATCH',
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).privacy.readReceipts, false);

  const invalidPhotoForm = new FormData();
  invalidPhotoForm.append('photo', new Blob(['not an image'], { type: 'image/png' }), 'fake.png');
  response = await fetch(`${base}/api/account/profile-photo`, {
    method: 'PUT', headers: { cookie, origin: base }, body: invalidPhotoForm,
  });
  assert.equal(response.status, 415, 'an image MIME label must not bypass content validation');

  const oversizedPhotoForm = new FormData();
  oversizedPhotoForm.append('photo', new Blob([Buffer.alloc((5 * 1024 * 1024) + 1)], { type: 'image/png' }), 'large.png');
  response = await fetch(`${base}/api/account/profile-photo`, {
    method: 'PUT', headers: { cookie, origin: base }, body: oversizedPhotoForm,
  });
  assert.equal(response.status, 413);

  const firstPhoto = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  const photoForm = new FormData();
  photoForm.append('photo', new Blob([firstPhoto], { type: 'image/png' }), 'avatar.png');
  response = await fetch(`${base}/api/account/profile-photo`, {
    method: 'PUT', headers: { cookie, origin: base }, body: photoForm,
  });
  assert.equal(response.status, 200);
  const photoAccount = (await response.json()).user;
  assert.match(photoAccount.photoUrl, new RegExp(`/api/messenger/profile-photo/${account.id}`));
  response = await fetch(`${base}${photoAccount.photoUrl}`);
  assert.equal(response.status, 401, 'profile photos require an authenticated viewer');
  response = await fetch(`${base}${photoAccount.photoUrl}`, { headers: { cookie } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), firstPhoto);

  response = await jsonRequest(`${base}/api/auth/request-code`, { dialCode: '233', number: '241234568' });
  const otherRequest = await response.json();
  response = await jsonRequest(`${base}/api/auth/verify`, { phone: otherRequest.phone, code: otherRequest.devCode });
  assert.equal(response.status, 200);
  response = await jsonRequest(`${base}/api/auth/register`, {
    phone: otherRequest.phone, username: 'Photo Viewer', avatar: 'V',
  });
  assert.equal(response.status, 200);
  const otherCookie = response.headers.get('set-cookie').match(/^([^;]+)/)[1];
  const otherAccount = (await response.json()).user;
  assert.equal(otherAccount.accountType, 'personal');
  response = await fetch(`${base}/api/business/${account.id}`, { headers: { cookie: otherCookie } });
  assert.equal(response.status, 200);
  const publicBusiness = (await response.json()).business;
  assert.equal(publicBusiness.profile.name, 'HTTP Test Studio');
  assert.equal(publicBusiness.profile.description, 'Public test purpose');
  assert.equal(publicBusiness.canEdit, false);
  response = await jsonRequest(
    `${base}/api/account/business-profile`, { description: 'No conversion' },
    { cookie: otherCookie, origin: base }, 'PUT',
  );
  assert.equal(response.status, 403, 'personal accounts cannot be converted through business profile updates');
  response = await fetch(`${base}${photoAccount.photoUrl}`, { headers: { cookie: otherCookie } });
  assert.equal(response.status, 200, 'profile photos default to visible to everyone');

  // Status posts are visible only to mutual contacts, media stays protected,
  // realtime notices are identifier-free, and boosts cannot deliver until an
  // authorized review plus verified payment or an explicit admin waiver.
  response = await fetch(`${base}/api/stories`);
  assert.equal(response.status, 401);

  const storyOwnerSocket = socketClient(base, {
    transports: ['websocket'], extraHeaders: { Cookie: cookie, Origin: base }, reconnection: false,
  });
  const storyViewerSocket = socketClient(base, {
    transports: ['websocket'], extraHeaders: { Cookie: otherCookie, Origin: base }, reconnection: false,
  });
  t.after(() => { storyOwnerSocket.close(); storyViewerSocket.close(); });
  await Promise.all([socketEvent(storyOwnerSocket, 'connect'), socketEvent(storyViewerSocket, 'connect')]);
  const dm = (await socketAck(storyOwnerSocket, 'chat:startDM', { targetUserId: otherAccount.id })).chat;
  await socketAck(storyViewerSocket, 'message:send', {
    chatId: dm.id, text: 'Mutual contact confirmation', type: 'text', clientId: 'story-contact-1',
  });

  const hostileStoryForm = new FormData();
  hostileStoryForm.append('type', 'text');
  hostileStoryForm.append('text', 'Cross origin');
  response = await fetch(`${base}/api/stories`, {
    method: 'POST', headers: { cookie, origin: 'https://evil.example' }, body: hostileStoryForm,
  });
  assert.equal(response.status, 403);

  const invalidStoryForm = new FormData();
  invalidStoryForm.append('media', new Blob(['not a picture'], { type: 'image/png' }), 'fake.png');
  response = await fetch(`${base}/api/stories`, {
    method: 'POST', headers: { cookie, origin: base }, body: invalidStoryForm,
  });
  assert.equal(response.status, 415);

  const storyCreatedNotice = socketEvent(storyViewerSocket, 'stories:changed');
  const textStoryForm = new FormData();
  textStoryForm.append('type', 'text');
  textStoryForm.append('text', 'Friends-only HTTP status');
  textStoryForm.append('background', 'ocean');
  response = await fetch(`${base}/api/stories`, {
    method: 'POST', headers: { cookie, origin: base }, body: textStoryForm,
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const textStory = (await response.json()).story;
  assert.deepEqual((await storyCreatedNotice)[0], { type: 'created' });

  response = await fetch(`${base}/api/stories`, { headers: { cookie: otherCookie } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  let storyFeed = await response.json();
  assert.ok(storyFeed.groups.flatMap(group => group.items).some(item => item.id === textStory.id));
  assert.ok(storyFeed.ads.some(ad => ad.id === 'house-vchat' && ad.durationSeconds === 30 && ad.sponsored));
  assert.equal(storyFeed.adAdmin, false);

  response = await jsonRequest(
    `${base}/api/stories/${textStory.id}/view`, {}, { cookie: otherCookie, origin: base }, 'POST',
  );
  assert.equal(response.status, 200);
  const reactionNotice = socketEvent(storyOwnerSocket, 'stories:changed');
  response = await jsonRequest(
    `${base}/api/stories/${textStory.id}/reaction`, { reaction: '🔥' },
    { cookie: otherCookie, origin: base }, 'PUT',
  );
  assert.equal(response.status, 200);
  assert.deepEqual((await reactionNotice)[0], { type: 'reaction' }, 'realtime notices must not leak story owner IDs');
  response = await jsonRequest(
    `${base}/api/stories/${textStory.id}/reaction`, { reaction: '🔥' },
    { cookie: otherCookie, origin: 'https://evil.example' }, 'PUT',
  );
  assert.equal(response.status, 403);

  const imageStoryForm = new FormData();
  imageStoryForm.append('media', new Blob([firstPhoto], { type: 'image/png' }), 'status.png');
  imageStoryForm.append('text', 'Protected status image');
  response = await fetch(`${base}/api/stories`, {
    method: 'POST', headers: { cookie, origin: base }, body: imageStoryForm,
  });
  assert.equal(response.status, 201);
  const imageStory = (await response.json()).story;
  assert.match(imageStory.mediaUrl, new RegExp(`/api/stories/${imageStory.id}/media`));
  response = await fetch(`${base}${imageStory.mediaUrl}`);
  assert.equal(response.status, 401);
  response = await fetch(`${base}${imageStory.mediaUrl}`, { headers: { cookie: otherCookie } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), firstPhoto);
  response = await jsonRequest(
    `${base}/api/stories/${imageStory.id}`, {}, { cookie: otherCookie, origin: base }, 'DELETE',
  );
  assert.equal(response.status, 404);
  response = await jsonRequest(
    `${base}/api/stories/${imageStory.id}`, {}, { cookie, origin: base }, 'DELETE',
  );
  assert.equal(response.status, 200);
  response = await fetch(`${base}${imageStory.mediaUrl}`, { headers: { cookie } });
  assert.equal(response.status, 404, 'deleting a story removes its protected media');

  const boostForm = new FormData();
  for (const [key, value] of Object.entries({
    type: 'text', text: 'Promote this status', background: 'jade', boost: 'true',
    objective: 'profile_visits', cta: 'Visit profile', adAudience: 'broad',
    budgetGhs: '25', durationDays: '3', billingEmail: 'tester@example.com',
  })) boostForm.append(key, value);
  response = await fetch(`${base}/api/stories`, {
    method: 'POST', headers: { cookie, origin: base }, body: boostForm,
  });
  assert.equal(response.status, 201);
  const boosted = await response.json();
  assert.ok(boosted.campaign?.id);
  assert.equal(boosted.campaign.paymentStatus, 'configuration_required');
  assert.equal(boosted.campaign.checkoutUrl, null);
  assert.match(boosted.boostError, /billing is not configured/i);

  response = await fetch(`${base}/api/story-ads/campaigns`, { headers: { cookie: otherCookie } });
  assert.deepEqual((await response.json()).campaigns, [], 'campaign billing data is private to its owner');
  response = await fetch(`${base}/api/story-ads/review`, { headers: { cookie: otherCookie } });
  assert.equal(response.status, 403);
  response = await fetch(`${base}/api/story-ads/review`, { headers: { cookie } });
  assert.equal(response.status, 200);
  assert.ok((await response.json()).campaigns.some(campaign => campaign.id === boosted.campaign.id));

  response = await jsonRequest(
    `${base}/api/story-ads/${boosted.campaign.id}/review`,
    { decision: 'approve', waivePayment: true },
    { cookie, origin: base }, 'PUT',
  );
  assert.equal(response.status, 400, 'complimentary account credit requires a documented authorization reason');
  response = await jsonRequest(
    `${base}/api/story-ads/${boosted.campaign.id}/review`,
    { decision: 'approve', note: 'Test-only authorized credit', waivePayment: true },
    { cookie, origin: base }, 'PUT',
  );
  assert.equal(response.status, 200);
  const approvedCampaign = (await response.json()).campaign;
  assert.equal(approvedCampaign.status, 'active');
  assert.equal(approvedCampaign.paymentStatus, 'waived');
  assert.equal(approvedCampaign.reviewer.id, account.id);
  assert.ok(approvedCampaign.reviewedAt);

  response = await fetch(`${base}/api/stories`, { headers: { cookie: otherCookie } });
  storyFeed = await response.json();
  assert.ok(storyFeed.ads.some(ad => ad.id === boosted.campaign.id && ad.sponsored
    && ad.durationSeconds === 30 && ad.objective === 'profile_visits'));
  for (let index = 0; index < 2; index += 1) {
    response = await jsonRequest(
      `${base}/api/story-ads/${boosted.campaign.id}/impression`, {},
      { cookie: otherCookie, origin: base }, 'POST',
    );
    assert.equal(response.status, 200);
  }
  response = await jsonRequest(
    `${base}/api/story-ads/${boosted.campaign.id}/click`, {},
    { cookie: otherCookie, origin: base }, 'POST',
  );
  assert.equal(response.status, 200);
  response = await fetch(`${base}/api/story-ads/campaigns`, { headers: { cookie } });
  const campaignReport = (await response.json()).campaigns.find(item => item.id === boosted.campaign.id);
  assert.equal(campaignReport.impressionCount, 1);
  assert.equal(campaignReport.reachCount, 1);
  assert.equal(campaignReport.clickCount, 1);

  response = await jsonRequest(
    `${base}/api/story-ads/${boosted.campaign.id}/control`, { action: 'pause' },
    { cookie: otherCookie, origin: base }, 'PUT',
  );
  assert.equal(response.status, 409, 'only a campaign owner may control delivery');
  response = await jsonRequest(
    `${base}/api/story-ads/${boosted.campaign.id}/control`, { action: 'pause' },
    { cookie, origin: base }, 'PUT',
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).campaign.status, 'paused');
  response = await fetch(`${base}/api/stories`, { headers: { cookie: otherCookie } });
  assert.equal((await response.json()).ads.some(ad => ad.id === boosted.campaign.id), false);
  response = await jsonRequest(
    `${base}/api/story-ads/${boosted.campaign.id}/control`, { action: 'resume' },
    { cookie, origin: base }, 'PUT',
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).campaign.status, 'active');

  const otherAdvertiserBoost = new FormData();
  for (const [key, value] of Object.entries({
    type: 'text', text: 'Another advertiser campaign', background: 'violet', boost: 'true',
    objective: 'messages', cta: 'Send message', adAudience: 'broad',
    budgetGhs: '20', durationDays: '2', billingEmail: 'viewer@example.com',
  })) otherAdvertiserBoost.append(key, value);
  response = await fetch(`${base}/api/stories`, {
    method: 'POST', headers: { cookie: otherCookie, origin: base }, body: otherAdvertiserBoost,
  });
  assert.equal(response.status, 201);
  const otherCampaign = (await response.json()).campaign;
  response = await jsonRequest(
    `${base}/api/story-ads/${otherCampaign.id}/review`,
    { decision: 'approve', note: 'Authorized test credit', waivePayment: true },
    { cookie, origin: base }, 'PUT',
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).campaign.status, 'active');
  response = await jsonRequest(
    `${base}/api/story-ads/${otherCampaign.id}/control`, { action: 'stop' },
    { cookie, origin: base }, 'PUT',
  );
  assert.equal(response.status, 400, 'an administrator must supply an audit reason when stopping another advertiser');
  const safetyReason = 'Safety policy test stop';
  response = await jsonRequest(
    `${base}/api/story-ads/${otherCampaign.id}/control`, { action: 'stop', note: safetyReason },
    { cookie, origin: base }, 'PUT',
  );
  assert.equal(response.status, 200);
  const safetyStopped = (await response.json()).campaign;
  assert.equal(safetyStopped.status, 'stopped');
  assert.equal(safetyStopped.stopNote, safetyReason);
  assert.equal(safetyStopped.stopActor.id, account.id);
  assert.ok(safetyStopped.stoppedAt);
  response = await fetch(`${base}/api/story-ads/campaigns`, { headers: { cookie: otherCookie } });
  const ownerStoppedView = (await response.json()).campaigns.find(item => item.id === otherCampaign.id);
  assert.equal(ownerStoppedView.stopNote, safetyReason);
  assert.equal(ownerStoppedView.stopActor.id, account.id);

  response = await fetch(`${base}/api/story-ads/payment/verify?reference=unknown`, { headers: { cookie } });
  assert.equal(response.status, 404);
  response = await jsonRequest(`${base}/api/story-ads/valmontpay/webhook`, { event: 'charge.success', data: {} });
  assert.equal(response.status, 401, 'unsigned payment webhooks are rejected');

  // Reels use their own authenticated, block-aware media boundary and remove
  // rejected/deleted files from protected storage.
  response = await fetch(`${base}/api/reels`);
  assert.equal(response.status, 401);
  response = await fetch(`${base}/api/reels?cursor=not-valid`, { headers: { cookie } });
  assert.equal(response.status, 400);

  const mediaDir = path.join(dataDir, 'media');
  const mediaCount = () => fs.readdirSync(mediaDir).length;
  const beforeRejectedReel = mediaCount();
  const invalidReelForm = new FormData();
  invalidReelForm.append('video', new Blob(['not a movie'], { type: 'video/mp4' }), 'fake.mp4');
  invalidReelForm.append('caption', 'Invalid');
  response = await fetch(`${base}/api/reels`, {
    method: 'POST', headers: { cookie, origin: base }, body: invalidReelForm,
  });
  assert.equal(response.status, 415, 'a video MIME label must not bypass content validation');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(mediaCount(), beforeRejectedReel, 'invalid reel bytes must be removed');

  const oversizedReelForm = new FormData();
  oversizedReelForm.append('video', new Blob([Buffer.alloc((1024 * 1024) + 1)], { type: 'video/mp4' }), 'large.mp4');
  oversizedReelForm.append('caption', 'Too large');
  response = await fetch(`${base}/api/reels`, {
    method: 'POST', headers: { cookie, origin: base }, body: oversizedReelForm,
  });
  assert.equal(response.status, 413);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(mediaCount(), beforeRejectedReel, 'oversized partial uploads must be removed');

  const validMp4 = Buffer.concat([
    Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(4), Buffer.from('isommp42'),
    Buffer.from([0, 0, 0, 8]), Buffer.from('mdat'),
  ]);
  const mismatchedReelForm = new FormData();
  mismatchedReelForm.append('video', new Blob([validMp4], { type: 'video/quicktime' }), 'not-a-mov.mov');
  response = await fetch(`${base}/api/reels`, {
    method: 'POST', headers: { cookie, origin: base }, body: mismatchedReelForm,
  });
  assert.equal(response.status, 415, 'the declared video type must match its container signature');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(mediaCount(), beforeRejectedReel, 'MIME-mismatched reels must be removed');

  const crossOriginForm = new FormData();
  crossOriginForm.append('video', new Blob([validMp4], { type: 'video/mp4' }), 'cross-origin.mp4');
  response = await fetch(`${base}/api/reels`, {
    method: 'POST', headers: { cookie, origin: 'https://evil.example' }, body: crossOriginForm,
  });
  assert.equal(response.status, 403);

  const reelSocket = socketClient(base, {
    transports: ['websocket'],
    extraHeaders: { Cookie: otherCookie, Origin: base },
    reconnection: false,
  });
  t.after(() => reelSocket.close());
  await socketEvent(reelSocket, 'connect');

  async function postReel(caption, waitForEvent = false) {
    const changed = waitForEvent ? socketEvent(reelSocket, 'reels:changed') : null;
    const form = new FormData();
    form.append('video', new Blob([validMp4], { type: 'video/mp4' }), `${caption}.mp4`);
    form.append('caption', caption);
    const result = await fetch(`${base}/api/reels`, {
      method: 'POST', headers: { cookie, origin: base }, body: form,
    });
    assert.equal(result.status, 201);
    assert.equal(result.headers.get('cache-control'), 'private, no-store');
    const posted = (await result.json()).reel;
    if (changed) {
      const [notice] = await changed;
      assert.deepEqual(notice, { type: 'created' }, 'realtime notices must not leak blocked reel IDs');
    }
    return posted;
  }

  const firstReel = await postReel('First reel 🎬', true);
  const secondReel = await postReel('Second reel');
  assert.equal(mediaCount(), beforeRejectedReel + 2);
  assert.equal(firstReel.owner.id, account.id);
  assert.equal(firstReel.caption, 'First reel 🎬');

  response = await fetch(`${base}/api/reels?limit=1`, { headers: { cookie: otherCookie } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const firstPage = await response.json();
  assert.equal(firstPage.items.length, 1);
  assert.equal(firstPage.maxUploadBytes, 1024 * 1024, 'clients receive the configured Reel upload maximum');
  assert.ok(firstPage.nextCursor);
  response = await fetch(`${base}/api/reels?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`, { headers: { cookie: otherCookie } });
  const secondPage = await response.json();
  assert.equal(secondPage.items.length, 1);
  assert.notEqual(secondPage.items[0].id, firstPage.items[0].id);

  response = await fetch(`${base}${firstReel.videoUrl}`);
  assert.equal(response.status, 401);
  response = await fetch(`${base}${firstReel.videoUrl}`, { headers: { cookie: otherCookie } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), validMp4);
  response = await fetch(`${base}${firstReel.videoUrl}`, {
    headers: { cookie: otherCookie, range: 'bytes=0-7' },
  });
  assert.equal(response.status, 206, 'protected Reel media supports seeking with byte ranges');
  assert.equal(response.headers.get('content-range'), `bytes 0-7/${validMp4.length}`);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), validMp4.subarray(0, 8));

  response = await jsonRequest(
    `${base}/api/reels/${firstReel.id}/like`, { liked: true }, { cookie: otherCookie, origin: base }, 'PUT',
  );
  assert.equal(response.status, 200);
  const likedReel = (await response.json()).reel;
  assert.equal(likedReel.liked, true);
  assert.equal(likedReel.likeCount, 1);

  response = await jsonRequest(
    `${base}/api/account/block/${account.id}`, { blocked: true }, { cookie: otherCookie, origin: base }, 'POST',
  );
  assert.equal(response.status, 200);
  response = await fetch(`${base}/api/reels`, { headers: { cookie: otherCookie } });
  assert.equal((await response.json()).items.some(reel => reel.owner.id === account.id), false);
  response = await fetch(`${base}${firstReel.videoUrl}`, { headers: { cookie: otherCookie } });
  assert.equal(response.status, 404);
  response = await jsonRequest(
    `${base}/api/account/block/${account.id}`, { blocked: false }, { cookie: otherCookie, origin: base }, 'POST',
  );
  assert.equal(response.status, 200);

  response = await jsonRequest(
    `${base}/api/reels/${firstReel.id}`, {}, { cookie: otherCookie, origin: base }, 'DELETE',
  );
  assert.equal(response.status, 404, 'a non-owner may not delete a reel');
  response = await jsonRequest(
    `${base}/api/reels/${firstReel.id}`, {}, { cookie, origin: base }, 'DELETE',
  );
  assert.equal(response.status, 200);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(mediaCount(), beforeRejectedReel + 1, 'deleting a reel removes its protected video');
  response = await fetch(`${base}${firstReel.videoUrl}`, { headers: { cookie } });
  assert.equal(response.status, 404);

  // Keep the second fixture reachable through the rest of the security test.
  response = await fetch(`${base}${secondReel.videoUrl}`, { headers: { cookie } });
  assert.equal(response.status, 200);

  response = await jsonRequest(
    `${base}/api/account/privacy`, { profilePhoto: 'nobody' }, { cookie }, 'PATCH',
  );
  assert.equal(response.status, 200);
  response = await fetch(`${base}${photoAccount.photoUrl}`, { headers: { cookie: otherCookie } });
  assert.equal(response.status, 404, 'privacy changes apply to profile-photo retrieval');
  response = await fetch(`${base}${photoAccount.photoUrl}`, { headers: { cookie } });
  assert.equal(response.status, 200, 'owners can always retrieve their own profile photo');

  const replacementPhoto = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4XcAAAAASUVORK5CYII=',
    'base64',
  );
  const replacementForm = new FormData();
  replacementForm.append('photo', new Blob([replacementPhoto], { type: 'image/png' }), 'replacement.png');
  response = await fetch(`${base}/api/account/profile-photo`, {
    method: 'PUT', headers: { cookie, origin: base }, body: replacementForm,
  });
  assert.equal(response.status, 200);
  response = await fetch(`${base}${photoAccount.photoUrl}`, { headers: { cookie } });
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), replacementPhoto, 'replacement content is served immediately');

  response = await jsonRequest(`${base}/api/account/profile-photo`, {}, { cookie }, 'DELETE');
  assert.equal(response.status, 200);
  response = await fetch(`${base}${photoAccount.photoUrl}`, { headers: { cookie } });
  assert.equal(response.status, 404);

  response = await jsonRequest(`${base}/api/account/two-step`, { pin: '123456' }, { cookie }, 'PUT');
  assert.equal(response.status, 200);
  response = await jsonRequest(`${base}/api/account/two-step`, { pin: '654321' }, { cookie }, 'PUT');
  assert.equal(response.status, 401, 'changing a PIN requires the current PIN');
  response = await jsonRequest(`${base}/api/account/two-step`, { pin: '000000' }, { cookie }, 'DELETE');
  assert.equal(response.status, 401);
  response = await jsonRequest(`${base}/api/account/two-step`, { pin: '123456' }, { cookie }, 'DELETE');
  assert.equal(response.status, 200);

  // A revoked device must lose its already-connected realtime channel and must
  // not be able to reconnect using the old cookie.
  response = await jsonRequest(`${base}/api/auth/request-code`, { dialCode: '233', number: '241234567' });
  const secondLoginRequest = await response.json();
  response = await jsonRequest(`${base}/api/auth/verify`, {
    phone: secondLoginRequest.phone, code: secondLoginRequest.devCode,
  });
  assert.equal(response.status, 200);
  const secondCookie = response.headers.get('set-cookie').match(/^([^;]+)/)[1];
  const liveSocket = socketClient(base, {
    transports: ['websocket'],
    extraHeaders: { Cookie: secondCookie, Origin: base },
    reconnection: false,
  });
  t.after(() => liveSocket.close());
  await socketEvent(liveSocket, 'connect');
  const revokedEvent = socketEvent(liveSocket, 'session:revoked');
  const disconnectedEvent = socketEvent(liveSocket, 'disconnect');

  response = await fetch(`${base}/api/account/devices`, { headers: { cookie } });
  assert.equal(response.status, 200);
  const revokedDevice = (await response.json()).find(device => !device.current);
  assert.ok(revokedDevice);
  response = await jsonRequest(
    `${base}/api/account/devices/${revokedDevice.id}`, {}, { cookie, origin: base }, 'DELETE',
  );
  assert.equal(response.status, 200);
  await Promise.all([revokedEvent, disconnectedEvent]);
  assert.equal(liveSocket.connected, false);
  response = await fetch(`${base}/api/auth/session`, { headers: { cookie: secondCookie } });
  assert.equal(response.status, 401);

  const rejectedSocket = socketClient(base, {
    transports: ['websocket'],
    extraHeaders: { Cookie: secondCookie, Origin: base },
    reconnection: false,
  });
  t.after(() => rejectedSocket.close());
  const [connectionError] = await socketEvent(rejectedSocket, 'connect_error');
  assert.match(connectionError.message, /Authentication required/);

  response = await jsonRequest(`${base}/api/auth/logout`, {}, { cookie });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  response = await fetch(`${base}/api/auth/session`, { headers: { cookie } });
  assert.equal(response.status, 401);
});


test('chat-lock PIN sessions and View Once media are enforced across HTTP and realtime boundaries', async t => {
  const { base } = await startServer(t);

  async function register(number, username) {
    let response = await jsonRequest(`${base}/api/auth/request-code`, { dialCode: '233', number });
    const request = await response.json();
    response = await jsonRequest(`${base}/api/auth/verify`, { phone: request.phone, code: request.devCode });
    assert.equal(response.status, 200);
    response = await jsonRequest(`${base}/api/auth/register`, {
      phone: request.phone, username, avatar: username[0], accountType: 'personal',
    });
    assert.equal(response.status, 200);
    return {
      phone: request.phone,
      cookie: response.headers.get('set-cookie').match(/^([^;]+)/)[1],
      user: (await response.json()).user,
    };
  }

  async function signInAgain(account) {
    let response = await jsonRequest(`${base}/api/auth/request-code`, {
      dialCode: '233', number: account.phone.replace(/^\+233/, ''),
    });
    const request = await response.json();
    response = await jsonRequest(`${base}/api/auth/verify`, { phone: request.phone, code: request.devCode });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').match(/^([^;]+)/)[1];
  }

  const alice = await register('501110001', 'Lock Alice');
  const bob = await register('501110002', 'Once Bob');
  const aliceSocket = socketClient(base, {
    transports: ['websocket'], extraHeaders: { Cookie: alice.cookie, Origin: base }, reconnection: false,
  });
  const bobSocket = socketClient(base, {
    transports: ['websocket'], extraHeaders: { Cookie: bob.cookie, Origin: base }, reconnection: false,
  });
  t.after(() => { aliceSocket.close(); bobSocket.close(); });
  await Promise.all([socketEvent(aliceSocket, 'connect'), socketEvent(bobSocket, 'connect')]);
  const chat = (await socketAck(aliceSocket, 'chat:startDM', { targetUserId: bob.user.id })).chat;
  await socketAck(bobSocket, 'message:send', {
    chatId: chat.id, text: 'Accept contact', type: 'text', clientId: 'contact-accept-1',
  });

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  const uploadForm = new FormData();
  uploadForm.append('chatId', chat.id);
  uploadForm.append('file', new Blob([png], { type: 'image/png' }), 'one-time.png');
  let response = await fetch(`${base}/api/messenger/upload`, {
    method: 'POST', headers: { cookie: alice.cookie, origin: base }, body: uploadForm,
  });
  assert.equal(response.status, 201);
  const attachment = await response.json();
  const sent = (await socketAck(aliceSocket, 'message:send', {
    chatId: chat.id, text: '', file: attachment, type: 'image',
    clientId: 'view-once-http-1', viewOnce: true,
  })).message;
  assert.equal(sent.viewOnce, true);

  response = await fetch(`${base}/api/messenger/messages/${chat.id}`, { headers: { cookie: bob.cookie } });
  assert.equal(response.status, 200);
  let bobMessage = (await response.json()).find(message => message.id === sent.id);
  assert.equal(bobMessage.file.url, null, 'the ordinary media URL is never projected to the recipient');
  response = await fetch(`${base}/api/messenger/media/${attachment.id}`, { headers: { cookie: bob.cookie } });
  assert.equal(response.status, 404, 'ordinary attachment retrieval cannot bypass View Once consumption');
  const forwarded = await socketAck(bobSocket, 'message:forward', {
    chatId: chat.id, messageId: sent.id, targetChatIds: ['general'],
  });
  assert.equal(forwarded.count, 0, 'View Once media cannot be forwarded through the server');

  response = await jsonRequest(
    `${base}/api/messenger/messages/${chat.id}/${sent.id}/view-once`, {},
    { cookie: bob.cookie, origin: base }, 'POST',
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const grant = await response.json();
  assert.match(grant.mediaUrl, /^\/api\/messenger\/view-once-media\//);
  response = await fetch(`${base}${grant.mediaUrl}`, { headers: { cookie: bob.cookie } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-view-once'), 'true');
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  response = await fetch(`${base}${grant.mediaUrl}`, { headers: { cookie: bob.cookie } });
  assert.equal(response.status, 404, 'the media capability itself is consumed by its first GET');
  response = await jsonRequest(
    `${base}/api/messenger/messages/${chat.id}/${sent.id}/view-once`, {},
    { cookie: bob.cookie, origin: base }, 'POST',
  );
  assert.equal(response.status, 410, 'the same recipient cannot obtain a second opening grant');
  response = await fetch(`${base}/api/messenger/messages/${chat.id}`, { headers: { cookie: bob.cookie } });
  bobMessage = (await response.json()).find(message => message.id === sent.id);
  assert.equal(bobMessage.viewOnceOpened, true);
  assert.equal(bobMessage.file, null);

  const privateStatusForm = new FormData();
  privateStatusForm.append('type', 'text');
  privateStatusForm.append('text', 'Saving disabled');
  response = await fetch(`${base}/api/stories`, {
    method: 'POST', headers: { cookie: alice.cookie, origin: base }, body: privateStatusForm,
  });
  assert.equal(response.status, 201);
  const privateStatus = (await response.json()).story;
  response = await fetch(`${base}/api/stories/${privateStatus.id}/save`, { headers: { cookie: bob.cookie } });
  assert.equal(response.status, 404, 'the Save action is denied unless the owner enables it per post');

  const savableStatusForm = new FormData();
  savableStatusForm.append('type', 'text');
  savableStatusForm.append('text', 'Owner-approved Status copy');
  savableStatusForm.append('allowSave', 'true');
  response = await fetch(`${base}/api/stories`, {
    method: 'POST', headers: { cookie: alice.cookie, origin: base }, body: savableStatusForm,
  });
  assert.equal(response.status, 201);
  const savableStatus = (await response.json()).story;
  response = await fetch(`${base}/api/stories`, { headers: { cookie: bob.cookie } });
  const savableProjection = (await response.json()).groups
    .flatMap(group => group.items).find(item => item.id === savableStatus.id);
  assert.equal(savableProjection.canSave, true);
  assert.match(savableProjection.saveUrl, /\/save$/);
  response = await fetch(`${base}/api/stories/${savableStatus.id}/save`);
  assert.equal(response.status, 401, 'Status saving always requires an authenticated session');
  response = await fetch(`${base}/api/stories/${savableStatus.id}/save`, { headers: { cookie: bob.cookie } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /vchat-status-.+\.txt/);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal(await response.text(), 'Owner-approved Status copy');

  response = await jsonRequest(
    `${base}/api/account/chat-lock/pin`, { pin: '12' }, { cookie: alice.cookie, origin: base }, 'PUT',
  );
  assert.equal(response.status, 400);
  response = await jsonRequest(
    `${base}/api/account/chat-lock/pin`, { pin: '246810' }, { cookie: alice.cookie, origin: base }, 'PUT',
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).user.chatLockEnabled, true);
  response = await jsonRequest(
    `${base}/api/account/chat-lock/passkey/register/options`, {}, { cookie: alice.cookie, origin: base }, 'POST',
  );
  assert.equal(response.status, 200, 'an unlocked session can start verified device-passkey registration');
  const passkeyOptions = await response.json();
  assert.ok(passkeyOptions.challenge);
  assert.equal(passkeyOptions.rp.id, '127.0.0.1');

  response = await jsonRequest(
    `${base}/api/messenger/chats/${chat.id}/lock`, { locked: true },
    { cookie: alice.cookie, origin: base }, 'PUT',
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).locked, true);
  const secondAliceCookie = await signInAgain(alice);
  response = await fetch(`${base}/api/messenger/chats`, { headers: { cookie: secondAliceCookie } });
  assert.equal((await response.json()).some(item => item.id === chat.id), false,
    'unlocking one device session never reveals locked chats in another session');

  const lockedAliceSocket = socketClient(base, {
    transports: ['websocket'], extraHeaders: { Cookie: secondAliceCookie, Origin: base }, reconnection: false,
  });
  t.after(() => lockedAliceSocket.close());
  await socketEvent(lockedAliceSocket, 'connect');
  const lockedSessionEvents = {
    chatNew: [], accepted: [], signal: [], ended: [],
  };
  const lockedListeners = {
    chatNew: payload => lockedSessionEvents.chatNew.push(payload),
    accepted: payload => lockedSessionEvents.accepted.push(payload),
    signal: payload => lockedSessionEvents.signal.push(payload),
    ended: payload => lockedSessionEvents.ended.push(payload),
  };
  lockedAliceSocket.on('chat:new', lockedListeners.chatNew);
  lockedAliceSocket.on('call:accepted', lockedListeners.accepted);
  lockedAliceSocket.on('call:signal', lockedListeners.signal);
  lockedAliceSocket.on('call:ended', lockedListeners.ended);

  const visibleChatNew = socketEvent(aliceSocket, 'chat:new');
  const existingChat = (await socketAck(bobSocket, 'chat:startDM', { targetUserId: alice.user.id })).chat;
  assert.equal(existingChat.id, chat.id);
  assert.equal((await visibleChatNew)[0].id, chat.id,
    'the unlocked session still receives its chat projection');

  const startedCall = await socketAck(aliceSocket, 'call:start', { chatId: chat.id, media: 'audio' });
  const acceptedEvent = socketEvent(aliceSocket, 'call:accepted');
  bobSocket.emit('call:accept', { callId: startedCall.callId });
  const accepted = (await acceptedEvent)[0];
  assert.equal(accepted.chatId, chat.id);

  const signalEvent = socketEvent(aliceSocket, 'call:signal');
  bobSocket.emit('call:signal', {
    callId: startedCall.callId, data: { candidate: 'private-webrtc-candidate' },
  });
  const signal = (await signalEvent)[0];
  assert.equal(signal.chatId, chat.id);
  assert.equal(signal.data.candidate, 'private-webrtc-candidate');

  const blockedCallEvents = { signal: [], ended: [] };
  const blockedCallListeners = {
    signal: payload => blockedCallEvents.signal.push(payload),
    ended: payload => blockedCallEvents.ended.push(payload),
  };
  bobSocket.on('call:signal', blockedCallListeners.signal);
  bobSocket.on('call:ended', blockedCallListeners.ended);
  response = await jsonRequest(
    `${base}/api/account/chat-lock/lock`, {}, { cookie: alice.cookie, origin: base }, 'POST',
  );
  assert.equal(response.status, 200, 'the caller session can relock while its call is active');
  aliceSocket.emit('call:signal', {
    callId: startedCall.callId, data: { candidate: 'must-not-cross-relocked-chat' },
  });
  aliceSocket.emit('call:end', { callId: startedCall.callId });
  aliceSocket.emit('call:cancel', { callId: startedCall.callId });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(blockedCallEvents, { signal: [], ended: [] },
    'a relocked socket cannot signal or mutate a call whose chat it can no longer access');
  bobSocket.off('call:signal', blockedCallListeners.signal);
  bobSocket.off('call:ended', blockedCallListeners.ended);

  response = await jsonRequest(
    `${base}/api/account/chat-lock/unlock`, { pin: '246810' }, { cookie: alice.cookie, origin: base }, 'POST',
  );
  assert.equal(response.status, 200);
  const endedEvent = socketEvent(aliceSocket, 'call:ended');
  bobSocket.emit('call:end', { callId: startedCall.callId });
  const ended = (await endedEvent)[0];
  assert.equal(ended.chatId, chat.id);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(lockedSessionEvents, { chatNew: [], accepted: [], signal: [], ended: [] },
    'chat projections and WebRTC data never reach another locked session');
  lockedAliceSocket.off('chat:new', lockedListeners.chatNew);
  lockedAliceSocket.off('call:accepted', lockedListeners.accepted);
  lockedAliceSocket.off('call:signal', lockedListeners.signal);
  lockedAliceSocket.off('call:ended', lockedListeners.ended);

  response = await jsonRequest(
    `${base}/api/account/chat-lock/lock`, {}, { cookie: alice.cookie, origin: base }, 'POST',
  );
  assert.equal(response.status, 200);
  response = await fetch(`${base}/api/messenger/chats`, { headers: { cookie: alice.cookie } });
  assert.equal((await response.json()).some(item => item.id === chat.id), false);
  response = await fetch(`${base}/api/messenger/messages/${chat.id}`, { headers: { cookie: alice.cookie } });
  assert.equal(response.status, 404, 'locked message history uses not-found behavior while hidden');
  response = await jsonRequest(
    `${base}/api/account/chat-lock/unlock`, { pin: '000000' }, { cookie: alice.cookie, origin: base }, 'POST',
  );
  assert.equal(response.status, 401);
  response = await jsonRequest(
    `${base}/api/account/chat-lock/unlock`, { pin: '246810' }, { cookie: alice.cookie, origin: base }, 'POST',
  );
  assert.equal(response.status, 200);
  assert.ok((await response.json()).user.chatLockUnlockedUntil > Date.now());
  response = await fetch(`${base}/api/messenger/chats`, { headers: { cookie: alice.cookie } });
  assert.equal((await response.json()).some(item => item.id === chat.id && item.locked), true);
  response = await fetch(`${base}/api/messenger/messages/${chat.id}`, { headers: { cookie: alice.cookie } });
  assert.equal(response.status, 200);

  const removedFromVisibleSession = socketEvent(aliceSocket, 'chat:removed');
  const removedFromLockedSession = socketEvent(lockedAliceSocket, 'chat:removed');
  aliceSocket.emit('chat:leave', { chatId: chat.id });
  const [[visibleRemoval], [lockedRemoval]] = await Promise.all([
    removedFromVisibleSession, removedFromLockedSession,
  ]);
  assert.deepEqual(visibleRemoval, { chatId: chat.id });
  assert.deepEqual(lockedRemoval, { chatId: chat.id },
    'content-free removal notices remain deliverable after membership has ended');
});

test('passkey registration refuses an eleventh credential before WebAuthn setup begins', async t => {
  const phone = '+233501119999';
  const { base } = await startServer(t, {}, ({ env }) => {
    const source = `
      const store = require('./lib/messenger-store');
      const user = store.upsertUserByPhone(${JSON.stringify(phone)}, { username: 'Passkey Cap' });
      store.setChatLockPin(user.id, '246810');
      for (let index = 0; index < store.MAX_CHAT_LOCK_CREDENTIALS; index += 1) {
        const result = store.addChatLockCredential(user.id, {
          id: 'seed-credential-' + index,
          publicKey: 'seed-public-key-' + index,
          name: 'Seed passkey ' + index,
        });
        if (!result || result.error) throw new Error('could not seed passkey cap');
      }
      setTimeout(() => {}, 400);
    `;
    const seeded = spawnSync(process.execPath, ['-e', source], {
      cwd: root, env, encoding: 'utf8', timeout: 3000,
    });
    assert.equal(seeded.status, 0, seeded.stderr || seeded.stdout || 'passkey fixture seeding failed');
  });

  let response = await jsonRequest(`${base}/api/auth/request-code`, { dialCode: '233', number: '501119999' });
  const requested = await response.json();
  response = await jsonRequest(`${base}/api/auth/verify`, { phone: requested.phone, code: requested.devCode });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').match(/^([^;]+)/)[1];

  response = await jsonRequest(
    `${base}/api/account/chat-lock/unlock`, { pin: '246810' }, { cookie, origin: base }, 'POST',
  );
  assert.equal(response.status, 200);
  response = await jsonRequest(
    `${base}/api/account/chat-lock/passkey/register/options`, {}, { cookie, origin: base }, 'POST',
  );
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /up to 10 chat-lock passkeys/i);
});

test('production authentication fails closed when real SMS delivery is not configured', async t => {
  const { base } = await startServer(t, { NODE_ENV: 'production' });
  const response = await jsonRequest(
    `${base}/api/auth/request-code`,
    { dialCode: '233', number: '501234567' },
  );
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.match(body.error, /temporarily unavailable/i);
  assert.equal(body.devCode, undefined);
});

test('ValmontPay checkout uses the tenant contract and verifies major-unit GHS payments', async t => {
  const secret = 'test-valmontpay-secret';
  const provider = await startValmontPayStub(t, secret);
  const { base } = await startServer(t, {
    VALMONTPAY_SECRET_KEY: secret,
    VALMONTPAY_API_URL: provider.base,
    PUBLIC_APP_URL: 'https://chat.example.com',
  });

  let response = await jsonRequest(`${base}/api/auth/request-code`, { dialCode: '233', number: '501234567' });
  const request = await response.json();
  response = await jsonRequest(`${base}/api/auth/verify`, { phone: request.phone, code: request.devCode });
  assert.equal(response.status, 200);
  response = await jsonRequest(`${base}/api/auth/register`, {
    phone: request.phone,
    username: 'ValmontPay Tester',
    avatar: 'V',
  });
  const cookie = response.headers.get('set-cookie').match(/^([^;]+)/)[1];

  const boost = new FormData();
  for (const [key, value] of Object.entries({
    type: 'text', text: 'Pay for this promoted status', background: 'jade', boost: 'true',
    objective: 'profile_visits', cta: 'Visit profile', adAudience: 'broad',
    budgetGhs: '25', durationDays: '3', billingEmail: 'payer@example.com',
  })) boost.append(key, value);
  response = await fetch(`${base}/api/stories`, {
    method: 'POST', headers: { cookie, origin: base }, body: boost,
  });
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.campaign.paymentProvider, 'valmontpay');
  assert.equal(created.campaign.paymentStatus, 'pending');
  assert.equal(created.payment.authorizationUrl, 'https://valmontpay.app/pay.html?access_code=ac_contract_test');

  const initialization = provider.requests.find(entry => entry.url === '/api/transaction/initialize');
  assert.equal(initialization.authorization, `Bearer ${secret}`);
  assert.deepEqual(initialization.body, {
    amount: 25,
    reference: created.payment.reference,
    currency: 'GHS',
    email: 'payer@example.com',
    phone: '+233501234567',
    callback_url: 'https://chat.example.com/api/story-ads/valmontpay/return',
  });

  response = await jsonRequest(
    `${base}/api/story-ads/${created.campaign.id}/payment/initialize`,
    {}, { cookie, origin: base },
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).payment.authorizationUrl, created.payment.authorizationUrl);
  assert.equal(provider.requests.filter(entry => entry.url === '/api/transaction/initialize').length, 1,
    'an existing pending checkout is reused instead of creating another transaction');

  const webhookBody = Buffer.from(JSON.stringify({
    event: 'charge.success',
    data: {
      reference: created.payment.reference,
      status: 'success',
      amount: 25,
      currency: 'GHS',
      gateway_reference: created.payment.reference,
    },
  }));
  response = await fetch(`${base}/api/story-ads/valmontpay/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-valmontpay-signature': crypto.createHmac('sha256', secret).update(webhookBody).digest('hex'),
    },
    body: webhookBody,
  });
  assert.equal(response.status, 200);
  response = await fetch(`${base}/api/story-ads/campaigns`, { headers: { cookie } });
  assert.equal((await response.json()).campaigns[0].paymentStatus, 'paid');

  response = await fetch(
    `${base}/api/story-ads/valmontpay/return?ref=${encodeURIComponent(created.payment.reference)}&status=success&merchant=vchat`,
    { redirect: 'manual' },
  );
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), `/?boost_return=1&reference=${encodeURIComponent(created.payment.reference)}`);

  response = await fetch(
    `${base}/api/story-ads/payment/verify?reference=${encodeURIComponent(created.payment.reference)}`,
    { headers: { cookie } },
  );
  assert.equal(response.status, 200);
  const verified = await response.json();
  assert.equal(verified.campaign.paymentStatus, 'paid');
  assert.equal(verified.campaign.status, 'pending_review');
  const verification = provider.requests.find(entry => entry.url.startsWith('/api/transaction/verify/'));
  assert.equal(verification.authorization, `Bearer ${secret}`);
});

test('friends are found by unique @username rather than phone number', async t => {
  const { base } = await startServer(t);

  async function register(number, username, handle) {
    let response = await jsonRequest(`${base}/api/auth/request-code`, { dialCode: '233', number });
    const request = await response.json();
    response = await jsonRequest(`${base}/api/auth/verify`, { phone: request.phone, code: request.devCode });
    assert.equal(response.status, 200);
    response = await jsonRequest(`${base}/api/auth/register`, {
      phone: request.phone, username, handle, avatar: username[0],
    });
    assert.equal(response.status, 200);
    return {
      cookie: response.headers.get('set-cookie').match(/^([^;]+)/)[1],
      user: (await response.json()).user,
    };
  }

  const alice = await register('501220001', 'Alice Finder', 'alice_finder');
  const bob = await register('501220002', 'Bob Finder', 'bob_finder');
  assert.equal(alice.user.handle, 'alice_finder');
  assert.equal(alice.user.phone, '+233501220001');
  assert.equal(bob.user.phone, '+233501220002');

  let response = await jsonRequest(`${base}/api/auth/request-code`, { dialCode: '233', number: '501220003' });
  const third = await response.json();
  response = await jsonRequest(`${base}/api/auth/verify`, { phone: third.phone, code: third.devCode });
  assert.equal(response.status, 200);
  response = await jsonRequest(`${base}/api/auth/register`, {
    phone: third.phone, username: 'Copy', handle: 'alice_finder', avatar: 'C',
  });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /already taken/i);

  response = await jsonRequest(`${base}/api/auth/register`, {
    phone: third.phone, username: 'Bad Handle', handle: 'ab', avatar: 'B',
  });
  assert.equal(response.status, 400);

  response = await fetch(`${base}/api/messenger/users/search?q=bob_f`, { headers: { cookie: alice.cookie } });
  assert.equal(response.status, 200);
  const hits = await response.json();
  assert.equal(hits.some(user => user.handle === 'bob_finder' && user.id === bob.user.id), true);
  assert.equal(hits.every(user => user.phone === undefined), true);

  const aliceSocket = socketClient(base, {
    transports: ['websocket'], extraHeaders: { Cookie: alice.cookie, Origin: base }, reconnection: false,
  });
  t.after(() => aliceSocket.close());
  await socketEvent(aliceSocket, 'connect');
  const lookedUp = await socketAck(aliceSocket, 'users:lookup', { query: '@bob_finder' });
  assert.equal(lookedUp.some(user => user.id === bob.user.id && user.handle === 'bob_finder'), true);
});

test('ValmontPay webhooks require an HMAC-SHA256 over the exact raw request bytes', async t => {
  const secret = 'test-valmontpay-secret';
  const { base } = await startServer(t, { VALMONTPAY_SECRET_KEY: secret });
  const payload = Buffer.from(JSON.stringify({
    event: 'unhandled.test',
    data: { amount: 25, currency: 'GHS' },
  }));
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  let response = await fetch(`${base}/api/story-ads/valmontpay/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-valmontpay-signature': signature },
    body: payload,
  });
  assert.equal(response.status, 200);

  const altered = Buffer.from(`${payload.toString()} `);
  response = await fetch(`${base}/api/story-ads/valmontpay/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-valmontpay-signature': signature },
    body: altered,
  });
  assert.equal(response.status, 401, 'a signature for different raw bytes must be rejected');
});
