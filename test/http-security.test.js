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
  for (const key of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM']) {
    if (!Object.hasOwn(extraEnv, key)) delete env[key];
  }
  if (!Object.hasOwn(extraEnv, 'VALMONTPAY_SECRET_KEY')) delete env.VALMONTPAY_SECRET_KEY;
  if (!Object.hasOwn(extraEnv, 'VALMONTPAY_API_URL')) delete env.VALMONTPAY_API_URL;
  if (seed) await seed({ dataDir, env });
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start: ${output}`)), 5000);
    const onData = chunk => {
      output += chunk;
      if (output.includes('"event":"server_started"')) {
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
  t.after(async () => {
    const exited = new Promise(resolve => {
      if (child.exitCode != null || child.signalCode != null) return resolve();
      child.once('exit', resolve);
    });
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))]);
    if (child.exitCode == null && child.signalCode == null) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${port}`, dataDir, child, output: () => output };
}

function jsonRequest(url, body, headers = {}, method = 'POST') {
  return fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function responseCookie(response, name) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie') || ''];
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const value of values) {
    const match = value.match(new RegExp(`(?:^|,\\s*)${escaped}=([^;,\\s]*)`));
    if (match) return `${name}=${match[1]}`;
  }
  return null;
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

function socketRawAck(socket, event, payload, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for raw socket acknowledgement: ${event}`)), timeoutMs);
    socket.emit(event, payload, result => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

function socketMissingPayloadAck(socket, event, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for missing-payload acknowledgement: ${event}`)), timeoutMs);
    socket.emit(event, result => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

async function registerAccount(base, number, username) {
  let response = await jsonRequest(`${base}/api/auth/request-code`, { dialCode: '233', number });
  assert.equal(response.status, 200);
  const request = await response.json();
  response = await jsonRequest(`${base}/api/auth/verify`, { phone: request.phone, code: request.devCode });
  assert.equal(response.status, 200);
  const verificationCookie = responseCookie(response, 'vchat_verify');
  response = await jsonRequest(`${base}/api/auth/register`, {
    phone: request.phone, username, accountType: 'personal',
  }, { cookie: verificationCookie });
  assert.equal(response.status, 200);
  return { cookie: responseCookie(response, 'vchat_session'), user: (await response.json()).user };
}

test('HTTP security boundary protects sessions, mutations, media, and legacy uploads', async t => {
  const { base, dataDir } = await startServer(t);

  let response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(response.headers.get('x-request-id'), /^[\w.:-]{8,128}$/);
  assert.equal(response.headers.get('cache-control'), 'no-cache');

  response = await fetch(`${base}/livez`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  response = await fetch(`${base}/readyz`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).checks, { application: true, persistence: true });
  response = await fetch(`${base}/metrics`);
  assert.equal(response.status, 404, 'metrics stay unavailable unless an operator configures a token');

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
  const verificationCookie = responseCookie(response, 'vchat_verify');
  assert.ok(verificationCookie, 'new-account verification must bind profile completion to this browser');

  response = await jsonRequest(`${base}/api/auth/register`, {
    phone: request.phone,
    username: 'HTTP Tester',
    avatar: 'T',
    accountType: 'business',
    businessProfile: {
      name: 'HTTP Test Studio', category: 'technology', description: 'Public test purpose',
      website: 'https://studio.example', email: 'hello@studio.example', address: 'Accra',
    },
  }, { cookie: verificationCookie });
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
  const otherVerificationCookie = responseCookie(response, 'vchat_verify');
  response = await jsonRequest(`${base}/api/auth/register`, {
    phone: otherRequest.phone, username: 'Photo Viewer', avatar: 'V', accountType: 'personal',
  }, { cookie: otherVerificationCookie });
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

  response = await jsonRequest(`${base}/api/auth/request-code`, { dialCode: '233', number: '241234567' });
  const secondLoginRequest = await response.json();
  response = await jsonRequest(`${base}/api/auth/verify`, {
    phone: secondLoginRequest.phone, code: secondLoginRequest.devCode,
  });
  assert.equal(response.status, 200);
  const secondCookie = responseCookie(response, 'vchat_session');
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

test('registration continuations are browser-bound and realtime messages use canonical presentation data', async t => {
  const { base } = await startServer(t);

  let response = await jsonRequest(`${base}/api/auth/request-code`, { dialCode: '233', number: '501120001' });
  const aliceRequest = await response.json();
  response = await jsonRequest(`${base}/api/auth/verify`, {
    phone: aliceRequest.phone, code: aliceRequest.devCode,
  });
  assert.equal(response.status, 200);
  const aliceVerification = responseCookie(response, 'vchat_verify');
  assert.ok(aliceVerification);

  response = await jsonRequest(`${base}/api/auth/register`, {
    phone: aliceRequest.phone, username: 'Canonical Alice', accountType: 'personal',
  });
  assert.equal(response.status, 401, 'an unrelated browser cannot finish a verified registration');
  response = await jsonRequest(`${base}/api/auth/register`, {
    phone: aliceRequest.phone, username: 'Canonical Alice',
  }, { cookie: aliceVerification });
  assert.equal(response.status, 400, 'new registrations require an intentional account-type selection');
  response = await jsonRequest(`${base}/api/auth/register`, {
    phone: aliceRequest.phone, username: 'Canonical Alice', accountType: 'PERSONAL',
  }, { cookie: aliceVerification });
  assert.equal(response.status, 400, 'account-type input is exact rather than silently defaulted');
  response = await jsonRequest(`${base}/api/auth/register`, {
    phone: aliceRequest.phone, username: 'Canonical Alice', avatar: 'A', accountType: 'personal',
  }, { cookie: aliceVerification });
  assert.equal(response.status, 200);
  const aliceCookie = responseCookie(response, 'vchat_session');
  const alice = (await response.json()).user;
  response = await jsonRequest(`${base}/api/auth/register`, {
    phone: aliceRequest.phone, username: 'Replay', accountType: 'business',
    businessProfile: { name: 'Replay Ltd' },
  }, { cookie: aliceVerification });
  assert.equal(response.status, 401, 'a consumed continuation cannot create another account session');

  response = await jsonRequest(`${base}/api/auth/request-code`, { dialCode: '233', number: '501120002' });
  const bobFirstRequest = await response.json();
  response = await jsonRequest(`${base}/api/auth/verify`, {
    phone: bobFirstRequest.phone, code: bobFirstRequest.devCode,
  });
  const staleBobVerification = responseCookie(response, 'vchat_verify');
  response = await jsonRequest(`${base}/api/auth/request-code`, { dialCode: '233', number: '501120002' });
  const bobSecondRequest = await response.json();
  response = await jsonRequest(`${base}/api/auth/verify`, {
    phone: bobSecondRequest.phone, code: bobSecondRequest.devCode,
  });
  const bobVerification = responseCookie(response, 'vchat_verify');
  response = await jsonRequest(`${base}/api/auth/register`, {
    phone: bobSecondRequest.phone, username: 'Stale Bob', accountType: 'personal',
  }, { cookie: staleBobVerification });
  assert.equal(response.status, 401,
    'a later successful verification invalidates an older browser continuation for the same phone');
  response = await jsonRequest(`${base}/api/auth/register`, {
    phone: bobSecondRequest.phone, username: 'Canonical Bob', avatar: 'B', accountType: 'business',
    businessProfile: { name: 'Canonical Bob Studio', description: 'Canonical message testing' },
  }, { cookie: bobVerification });
  assert.equal(response.status, 200);
  const bobCookie = responseCookie(response, 'vchat_session');
  const bob = (await response.json()).user;
  assert.equal(bob.accountType, 'business');

  const aliceSocket = socketClient(base, {
    transports: ['websocket'], extraHeaders: { Cookie: aliceCookie, Origin: base }, reconnection: false,
  });
  const bobSocket = socketClient(base, {
    transports: ['websocket'], extraHeaders: { Cookie: bobCookie, Origin: base }, reconnection: false,
  });
  t.after(() => { aliceSocket.close(); bobSocket.close(); });
  await Promise.all([socketEvent(aliceSocket, 'connect'), socketEvent(bobSocket, 'connect')]);
  const chat = (await socketAck(aliceSocket, 'chat:startDM', { targetUserId: bob.id })).chat;
  const original = (await socketAck(aliceSocket, 'message:send', {
    chatId: chat.id, text: 'Server-owned original', type: 'system',
    call: { outcome: 'forged' }, clientId: 'canonical-original',
  })).message;
  assert.equal(original.type, 'text');
  assert.equal(original.call, null, 'a client cannot forge a call-log payload');

  const reply = (await socketAck(bobSocket, 'message:send', {
    chatId: chat.id,
    text: 'Canonical reply',
    type: 'call',
    call: { outcome: 'answered', duration: 999999 },
    replyTo: {
      id: original.id, senderId: bob.id, senderName: '<script>', text: 'forged quote', preview: 'forged',
    },
    clientId: 'canonical-reply',
  })).message;
  assert.equal(reply.type, 'text');
  assert.equal(reply.call, null);
  assert.deepEqual(reply.replyTo, {
    id: original.id,
    senderId: alice.id,
    senderName: 'Canonical Alice',
    text: 'Server-owned original',
    preview: 'Server-owned original',
  });
  await assert.rejects(
    socketAck(bobSocket, 'message:send', {
      chatId: chat.id, text: 'Reply to an invented message', replyTo: { id: crypto.randomUUID() },
      clientId: 'canonical-invalid-reply',
    }),
    /message being replied to is unavailable/i,
  );

  const hostileUpdates = [];
  const hostileListener = payload => hostileUpdates.push(payload);
  aliceSocket.on('message:updated', hostileListener);
  bobSocket.emit('message:react', { chatId: chat.id, messageId: original.id, emoji: '<img onerror=alert(1)>' });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(hostileUpdates, [], 'non-allowlisted reaction keys are ignored');
  const validUpdate = socketEvent(aliceSocket, 'message:updated');
  bobSocket.emit('message:react', { chatId: chat.id, messageId: original.id, emoji: '❤️' });
  const reacted = (await validUpdate)[0];
  assert.deepEqual(reacted.reactions, { '❤️': [bob.id] });
  aliceSocket.off('message:updated', hostileListener);
});

test('chat-lock PIN sessions and View Once media are enforced across HTTP and realtime boundaries', async t => {
  const { base, dataDir } = await startServer(t);

  async function register(number, username) {
    let response = await jsonRequest(`${base}/api/auth/request-code`, { dialCode: '233', number });
    const request = await response.json();
    response = await jsonRequest(`${base}/api/auth/verify`, { phone: request.phone, code: request.devCode });
    assert.equal(response.status, 200);
    const verificationCookie = responseCookie(response, 'vchat_verify');
    response = await jsonRequest(`${base}/api/auth/register`, {
      phone: request.phone, username, avatar: username[0], accountType: 'personal',
    }, { cookie: verificationCookie });
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
    return responseCookie(response, 'vchat_session');
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
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'media')), [],
    'the final successful View Once transfer removes both metadata and protected bytes');
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
  assert.deepEqual(blockedCallEvents.signal, [],
    'a relocked socket cannot signal a call whose chat it can no longer access');
  assert.equal(blockedCallEvents.ended.length, 1,
    'relocking must actively tear down an established call instead of only blocking future signaling');
  assert.equal(blockedCallEvents.ended[0].callId, startedCall.callId);
  assert.equal(blockedCallEvents.ended[0].reason, 'chat-relocked');
  bobSocket.off('call:signal', blockedCallListeners.signal);
  bobSocket.off('call:ended', blockedCallListeners.ended);

  response = await jsonRequest(
    `${base}/api/account/chat-lock/unlock`, { pin: '246810' }, { cookie: alice.cookie, origin: base }, 'POST',
  );
  assert.equal(response.status, 200);
  const restartedCall = await socketAck(aliceSocket, 'call:start', { chatId: chat.id, media: 'audio' });
  const endedEvent = socketEvent(bobSocket, 'call:ended');
  aliceSocket.emit('call:cancel', { callId: restartedCall.callId });
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

test('group View Once grants remain independent until every delayed transfer terminates', async t => {
  const { base, dataDir } = await startServer(t);

  async function register(number, username) {
    let response = await jsonRequest(`${base}/api/auth/request-code`, { dialCode: '233', number });
    const request = await response.json();
    response = await jsonRequest(`${base}/api/auth/verify`, { phone: request.phone, code: request.devCode });
    const verificationCookie = responseCookie(response, 'vchat_verify');
    response = await jsonRequest(`${base}/api/auth/register`, {
      phone: request.phone, username, accountType: 'personal',
    }, { cookie: verificationCookie });
    assert.equal(response.status, 200);
    return {
      cookie: responseCookie(response, 'vchat_session'),
      user: (await response.json()).user,
    };
  }

  const alice = await register('501112001', 'Grant Alice');
  const bob = await register('501112002', 'Grant Bob');
  const eve = await register('501112003', 'Grant Eve');
  const sockets = [alice, bob, eve].map(account => socketClient(base, {
    transports: ['websocket'], extraHeaders: { Cookie: account.cookie, Origin: base }, reconnection: false,
  }));
  t.after(() => sockets.forEach(socket => socket.close()));
  await Promise.all(sockets.map(socket => socketEvent(socket, 'connect')));
  const [aliceSocket] = sockets;
  const group = (await socketAck(aliceSocket, 'chat:createGroup', {
    name: 'Delayed grants', members: [bob.user.id, eve.user.id],
  })).chat;

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  const uploadForm = new FormData();
  uploadForm.append('chatId', group.id);
  uploadForm.append('file', new Blob([png], { type: 'image/png' }), 'delayed-once.png');
  let response = await fetch(`${base}/api/messenger/upload`, {
    method: 'POST', headers: { cookie: alice.cookie, origin: base }, body: uploadForm,
  });
  assert.equal(response.status, 201);
  const attachment = await response.json();
  const message = (await socketAck(aliceSocket, 'message:send', {
    chatId: group.id, file: attachment, type: 'image', viewOnce: true,
    clientId: 'delayed-view-once-group',
  })).message;

  async function openGrant(account) {
    const opened = await jsonRequest(
      `${base}/api/messenger/messages/${group.id}/${message.id}/view-once`, {},
      { cookie: account.cookie, origin: base }, 'POST',
    );
    assert.equal(opened.status, 200);
    return opened.json();
  }
  const [bobGrant, eveGrant] = await Promise.all([openGrant(bob), openGrant(eve)]);

  response = await jsonRequest(`${base}/api/auth/request-code`, { dialCode: '233', number: '501112002' });
  const secondBobRequest = await response.json();
  response = await jsonRequest(`${base}/api/auth/verify`, {
    phone: secondBobRequest.phone, code: secondBobRequest.devCode,
  });
  const secondBobCookie = responseCookie(response, 'vchat_session');
  response = await fetch(`${base}${bobGrant.mediaUrl}`, { headers: { cookie: secondBobCookie } });
  assert.equal(response.status, 404, 'a grant is bound to Bob’s issuing browser session');
  response = await fetch(`${base}${bobGrant.mediaUrl}`, { headers: { cookie: alice.cookie } });
  assert.equal(response.status, 404, 'another authenticated account cannot consume or cancel Bob’s grant');
  response = await fetch(`${base}${eveGrant.mediaUrl}`, { headers: { cookie: eve.cookie } });
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(fs.readdirSync(path.join(dataDir, 'media')).length, 1,
    'Eve’s completed transfer preserves bytes while Bob still holds a delayed grant');

  response = await fetch(`${base}${bobGrant.mediaUrl}`, { headers: { cookie: bob.cookie } });
  assert.equal(response.status, 200, 'Bob’s delayed grant remains valid after Eve finishes');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'media')), [],
    'the final terminated grant removes the shared metadata and protected bytes');

  const relockUpload = new FormData();
  relockUpload.append('chatId', group.id);
  relockUpload.append('file', new Blob([png], { type: 'image/png' }), 'relocked-once.png');
  response = await fetch(`${base}/api/messenger/upload`, {
    method: 'POST', headers: { cookie: alice.cookie, origin: base }, body: relockUpload,
  });
  assert.equal(response.status, 201);
  const relockAttachment = await response.json();
  const relockMessage = (await socketAck(aliceSocket, 'message:send', {
    chatId: group.id, file: relockAttachment, type: 'image', viewOnce: true,
    clientId: 'relocked-view-once-group',
  })).message;
  response = await jsonRequest(
    `${base}/api/account/chat-lock/pin`, { pin: '246810' }, { cookie: bob.cookie, origin: base }, 'PUT',
  );
  assert.equal(response.status, 200);
  response = await jsonRequest(
    `${base}/api/messenger/chats/${group.id}/lock`, { locked: true },
    { cookie: bob.cookie, origin: base }, 'PUT',
  );
  assert.equal(response.status, 200);
  const openRelockGrant = async account => {
    const opened = await jsonRequest(
      `${base}/api/messenger/messages/${group.id}/${relockMessage.id}/view-once`, {},
      { cookie: account.cookie, origin: base }, 'POST',
    );
    assert.equal(opened.status, 200);
    return opened.json();
  };
  const [bobRelockGrant, eveRelockGrant] = await Promise.all([
    openRelockGrant(bob), openRelockGrant(eve),
  ]);
  response = await jsonRequest(
    `${base}/api/account/chat-lock/lock`, {}, { cookie: bob.cookie, origin: base }, 'POST',
  );
  assert.equal(response.status, 200);
  response = await fetch(`${base}${bobRelockGrant.mediaUrl}`, { headers: { cookie: bob.cookie } });
  assert.equal(response.status, 404, 'relocking the issuing session terminates its outstanding media grant');
  assert.equal(fs.readdirSync(path.join(dataDir, 'media')).length, 1,
    'relocking Bob does not invalidate Eve’s independent transfer');
  response = await fetch(`${base}${eveRelockGrant.mediaUrl}`, { headers: { cookie: eve.cookie } });
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'media')), [],
    'the last active recipient transfer completes relock cleanup');
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
  const cookie = responseCookie(response, 'vchat_session');

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

test('messenger uploads validate signatures and enforce account storage plus pending-upload quotas', async t => {
  const { base, dataDir } = await startServer(t, {
    MAX_ACCOUNT_STORAGE_MB: '10', MAX_PENDING_UPLOADS: '2', MAX_UPLOAD_MB: '20',
    REEL_MAX_MB: '10', STORY_MAX_MB: '10',
  });
  let response = await jsonRequest(`${base}/api/auth/request-code`, { dialCode: '233', number: '501130001' });
  const request = await response.json();
  response = await jsonRequest(`${base}/api/auth/verify`, { phone: request.phone, code: request.devCode });
  const verificationCookie = responseCookie(response, 'vchat_verify');
  response = await jsonRequest(`${base}/api/auth/register`, {
    phone: request.phone, username: 'Quota Tester', accountType: 'personal',
  }, { cookie: verificationCookie });
  assert.equal(response.status, 200);
  const cookie = responseCookie(response, 'vchat_session');

  async function uploadBytes(bytes, type, name) {
    const form = new FormData();
    form.append('chatId', 'general');
    form.append('file', new Blob([bytes], { type }), name);
    return fetch(`${base}/api/messenger/upload`, {
      method: 'POST', headers: { cookie, origin: base }, body: form,
    });
  }

  response = await uploadBytes(Buffer.from('<script>alert(1)</script>'), 'image/png', 'forged.png');
  assert.equal(response.status, 415, 'multipart MIME declarations cannot turn text into an image');
  assert.match((await response.json()).error, /contents do not match/i);

  const largePng = Buffer.alloc(6 * 1024 * 1024);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(largePng);
  response = await uploadBytes(largePng, 'image/png', 'large-one.png');
  assert.equal(response.status, 201);
  response = await uploadBytes(largePng, 'image/png', 'large-two.png');
  assert.equal(response.status, 429);
  assert.match((await response.json()).error, /storage quota/i);

  const quotaPng = Buffer.alloc(Math.floor(4.5 * 1024 * 1024));
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(quotaPng);
  const photoForm = new FormData();
  photoForm.append('photo', new Blob([quotaPng], { type: 'image/png' }), 'quota-profile.png');
  response = await fetch(`${base}/api/account/profile-photo`, {
    method: 'PUT', headers: { cookie, origin: base }, body: photoForm,
  });
  assert.equal(response.status, 429, 'attachment bytes count against profile-photo storage');

  const fiveMbMp4 = Buffer.alloc(5 * 1024 * 1024);
  fiveMbMp4.writeUInt32BE(24, 0);
  fiveMbMp4.write('ftyp', 4, 'ascii');
  fiveMbMp4.write('isom', 8, 'ascii');
  const reelForm = new FormData();
  reelForm.append('video', new Blob([fiveMbMp4], { type: 'video/mp4' }), 'quota-reel.mp4');
  response = await fetch(`${base}/api/reels`, {
    method: 'POST', headers: { cookie, origin: base }, body: reelForm,
  });
  assert.equal(response.status, 429, 'attachment bytes count against reel storage');

  const storyForm = new FormData();
  storyForm.append('type', 'video');
  storyForm.append('media', new Blob([fiveMbMp4], { type: 'video/mp4' }), 'quota-story.mp4');
  response = await fetch(`${base}/api/stories`, {
    method: 'POST', headers: { cookie, origin: base }, body: storyForm,
  });
  assert.equal(response.status, 429, 'attachment bytes count against Story storage');

  const smallPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  response = await uploadBytes(smallPng, 'image/png', 'small.png');
  assert.equal(response.status, 201);
  const smallAttachment = await response.json();
  response = await uploadBytes(smallPng, 'image/png', 'too-many-pending.png');
  assert.equal(response.status, 429);
  assert.match((await response.json()).error, /send or discard existing uploads/i);
  response = await fetch(`${base}/api/messenger/upload/${smallAttachment.id}`, {
    method: 'DELETE', headers: { cookie, origin: base },
  });
  assert.equal(response.status, 200, 'an uploader can discard unclaimed bytes to release pending quota');
  response = await uploadBytes(smallPng, 'image/png', 'after-discard.png');
  assert.equal(response.status, 201);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(fs.readdirSync(path.join(dataDir, 'media')).length, 2,
    'rejected signatures and quota overflows do not leave protected orphan files');
});

test('account exports require two-step reauthentication and exclude credential material', async t => {
  const { base } = await startServer(t);
  const account = await registerAccount(base, '501130020', 'Data Export Tester');
  let response = await jsonRequest(`${base}/api/account/two-step`, { pin: '482951' }, {
    cookie: account.cookie, origin: base,
  }, 'PUT');
  assert.equal(response.status, 200);

  response = await jsonRequest(`${base}/api/account/export`, { currentPin: '000000' }, {
    cookie: account.cookie, origin: base,
  });
  assert.equal(response.status, 401);
  response = await jsonRequest(`${base}/api/account/export`, { currentPin: '482951' }, {
    cookie: account.cookie, origin: base,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.match(response.headers.get('content-disposition'), /^attachment; filename="vchat-account-[\w-]+\.json"$/);
  const raw = await response.text();
  const exported = JSON.parse(raw);
  assert.equal(exported.exportVersion, 1);
  assert.equal(exported.account.id, account.user.id);
  assert.equal(exported.account.phone, '+233501130020');
  assert.ok(exported.chats.some(item => item.chat.id === 'general'));
  assert.ok(exported.sessions.every(session => Object.keys(session).sort().join(',')
    === 'createdAt,expiresAt,id,label,lastUsedAt'));
  assert.doesNotMatch(raw, /pinHash|passkeyChallenge|tokenDigest|storageName/i,
    'credential hashes, challenges, internal media paths, and session digests are excluded');
});

test('every Socket.IO command rejects malformed payloads without terminating the process', async t => {
  const { base, dataDir, child } = await startServer(t);
  const account = await registerAccount(base, '501130009', 'Malformed Event Tester');
  const socket = socketClient(base, {
    transports: ['websocket'], extraHeaders: { Cookie: account.cookie, Origin: base }, reconnection: false,
  });
  t.after(() => socket.close());
  await socketEvent(socket, 'connect');

  const commands = [
    'user:join', 'profile:update',
    'message:send', 'message:edit', 'message:delete', 'message:react', 'message:star',
    'message:pin', 'message:forward', 'messages:read', 'typing:start', 'typing:stop',
    'chat:createGroup', 'chat:startDM', 'chat:open', 'chat:flag', 'chat:clear',
    'chat:setDisappearing', 'chat:setAdvancedPrivacy', 'chat:createInvite',
    'chat:revokeInvites', 'chat:joinInvite', 'group:update', 'group:setAdmin',
    'group:removeMember', 'chat:leave', 'chat:addMembers', 'search:messages',
    'call:start', 'call:accept', 'call:decline', 'call:cancel', 'call:end',
    'call:signal', 'call:rate', 'call:ratings',
  ];
  const malformedPayloads = [undefined, null, [], 'not-an-object', 42];
  for (const command of commands) {
    const missing = await socketMissingPayloadAck(socket, command);
    assert.match(missing?.error || '', /payload/i, `${command} rejects a missing payload`);
    for (const payload of malformedPayloads) {
      const result = await socketRawAck(socket, command, payload);
      assert.match(result?.error || '', /payload/i, `${command} rejects ${JSON.stringify(payload)}`);
      assert.equal(child.exitCode, null, `${command} must not terminate the Node process`);
      assert.equal(socket.connected, true, `${command} must not disconnect the authenticated client`);
    }
  }

  const sent = await socketAck(socket, 'message:send', {
    chatId: 'general', text: 'Still alive and durably stored', clientId: 'after-malformed-events',
  });
  assert.equal(sent.message.text, 'Still alive and durably stored');
  assert.equal((await fetch(`${base}/livez`)).status, 200);

  const snapshot = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.v2.json'), 'utf8'));
  const stored = snapshot.messages.flatMap(([, messages]) => messages)
    .find(message => message.clientId === 'after-malformed-events');
  assert.equal(stored?.text, 'Still alive and durably stored');
});

test('message acknowledgement recovers idempotently after a persistence write failure', async t => {
  const { base, dataDir, child } = await startServer(t);
  const account = await registerAccount(base, '501130011', 'Persistence Recovery Tester');
  const socket = socketClient(base, {
    transports: ['websocket'], extraHeaders: { Cookie: account.cookie, Origin: base }, reconnection: false,
  });
  t.after(() => socket.close());
  await socketEvent(socket, 'connect');

  await new Promise(resolve => setTimeout(resolve, 350));
  fs.chmodSync(dataDir, 0o500);
  t.after(() => {
    try { fs.chmodSync(dataDir, 0o700); } catch { /* test cleanup may already have run */ }
  });

  const announcements = [];
  socket.on('message:new', message => {
    if (message.clientId === 'persistence-retry-id') announcements.push(message);
  });
  const payload = {
    chatId: 'general', text: 'Commit this exactly once', clientId: 'persistence-retry-id', tempId: 'retry-temp',
  };
  const failed = await socketRawAck(socket, 'message:send', payload);
  assert.match(failed?.error || '', /storage.*unavailable/i);
  assert.equal(failed?.retryable, true);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(announcements.length, 0, 'an uncommitted message is not published');
  assert.equal(child.exitCode, null, 'a persistence failure does not crash the service');
  assert.equal((await fetch(`${base}/livez`)).status, 200);
  assert.equal((await fetch(`${base}/readyz`)).status, 503, 'tracked persistence errors fail readiness');

  fs.chmodSync(dataDir, 0o700);
  const recovered = await socketRawAck(socket, 'message:send', payload);
  assert.equal(recovered?.duplicate, true, 'the retry reuses the in-memory idempotency record');
  assert.equal(recovered?.message?.clientId, payload.clientId);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(announcements.length, 1, 'the recovered commit is published exactly once');
  assert.equal((await fetch(`${base}/readyz`)).status, 200, 'a successful retry clears the persistence error');

  const snapshot = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.v2.json'), 'utf8'));
  const copies = snapshot.messages.flatMap(([, messages]) => messages)
    .filter(message => message.clientId === payload.clientId);
  assert.equal(copies.length, 1, 'the durable snapshot contains one idempotent message');
});

test('Socket.IO enforces per-account event budgets before handlers execute', async t => {
  const { base } = await startServer(t, { SOCKET_MESSAGE_RATE_LIMIT: '2' });
  let response = await jsonRequest(`${base}/api/auth/request-code`, { dialCode: '233', number: '501130002' });
  const request = await response.json();
  response = await jsonRequest(`${base}/api/auth/verify`, { phone: request.phone, code: request.devCode });
  const verificationCookie = responseCookie(response, 'vchat_verify');
  response = await jsonRequest(`${base}/api/auth/register`, {
    phone: request.phone, username: 'Realtime Rate Tester', accountType: 'personal',
  }, { cookie: verificationCookie });
  const cookie = responseCookie(response, 'vchat_session');
  const socket = socketClient(base, {
    transports: ['websocket'], extraHeaders: { Cookie: cookie, Origin: base }, reconnection: false,
  });
  t.after(() => socket.close());
  await socketEvent(socket, 'connect');

  await socketAck(socket, 'message:send', { chatId: 'general', text: 'One', clientId: 'rate-one' });
  await socketAck(socket, 'message:send', { chatId: 'general', text: 'Two', clientId: 'rate-two' });
  const limitedEvent = socketEvent(socket, 'rate-limit');
  await assert.rejects(
    socketAck(socket, 'message:send', { chatId: 'general', text: 'Three', clientId: 'rate-three' }),
    /too many realtime actions/i,
  );
  assert.deepEqual((await limitedEvent)[0], { event: 'message:send', retryAfter: 60 });
  response = await fetch(`${base}/api/messenger/messages/general`, { headers: { cookie } });
  const sentTexts = (await response.json()).filter(message => message.sender.username === 'Realtime Rate Tester')
    .map(message => message.text);
  assert.deepEqual(sentTexts, ['One', 'Two'], 'the over-budget event never reaches its message handler');
});

test('operational metrics require a bearer token and expose bounded aggregate counters', async t => {
  const { base } = await startServer(t, { METRICS_TOKEN: 'operator-test-token' });
  let response = await fetch(`${base}/metrics`);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('www-authenticate'), 'Bearer');

  response = await fetch(`${base}/metrics`, {
    headers: { authorization: 'Bearer operator-test-token' },
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /vchat_http_requests_total \d+/);
  assert.match(body, /vchat_http_responses_total\{status_class="4xx"\} 1/);
  assert.match(body, /vchat_socket_connections 0/);
  assert.match(body, /vchat_process_resident_memory_bytes \d+/);
  assert.doesNotMatch(body, /operator-test-token/);
});

test('readiness fails when recoverable persistence falls below its free-space floor', async t => {
  const { base } = await startServer(t, { READINESS_MIN_FREE_MB: '1000000000' });
  const response = await fetch(`${base}/readyz`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    checks: { application: true, persistence: false },
  });
  assert.equal((await fetch(`${base}/livez`)).status, 200, 'liveness remains independent of disk readiness');
});

test('SIGTERM drains Socket.IO and HTTP, flushes pending state, and exits cleanly', async t => {
  const running = await startServer(t, { SHUTDOWN_TIMEOUT_MS: '3000' });
  assert.equal((await fetch(`${running.base}/readyz`)).status, 200);
  const account = await registerAccount(running.base, '501130010', 'Before Shutdown');
  const socket = socketClient(running.base, {
    transports: ['websocket'], extraHeaders: { Cookie: account.cookie, Origin: running.base }, reconnection: false,
  });
  t.after(() => socket.close());
  await socketEvent(socket, 'connect');
  const updated = await socketAck(socket, 'profile:update', {
    username: 'Pending Shutdown Profile', avatar: 'P', about: 'Must survive immediate SIGTERM',
  });
  assert.equal(updated.user.username, 'Pending Shutdown Profile');

  const exited = new Promise(resolve => running.child.once('exit', (code, signal) => resolve({ code, signal })));
  running.child.kill('SIGTERM');
  const outcome = await exited;
  assert.deepEqual(outcome, { code: 0, signal: null });
  assert.match(running.output(), /"event":"graceful_shutdown_started"/);
  assert.match(running.output(), /"event":"graceful_shutdown_complete"/);
  const snapshot = JSON.parse(fs.readFileSync(path.join(running.dataDir, 'db.v2.json'), 'utf8'));
  assert.equal(snapshot.users.find(user => user.id === account.user.id)?.username, 'Pending Shutdown Profile');
});

test('SIGTERM exits nonzero when the final persistence flush fails', async t => {
  const running = await startServer(t, { SHUTDOWN_TIMEOUT_MS: '3000' });
  const account = await registerAccount(running.base, '501130012', 'Final Flush Failure Tester');
  const socket = socketClient(running.base, {
    transports: ['websocket'], extraHeaders: { Cookie: account.cookie, Origin: running.base }, reconnection: false,
  });
  t.after(() => socket.close());
  await socketEvent(socket, 'connect');
  await new Promise(resolve => setTimeout(resolve, 350));

  fs.chmodSync(running.dataDir, 0o500);
  t.after(() => {
    try { fs.chmodSync(running.dataDir, 0o700); } catch { /* test cleanup may already have run */ }
  });
  const updated = await socketAck(socket, 'profile:update', {
    username: 'Cannot Be Flushed', avatar: 'C', about: 'Force the final fsync boundary to fail',
  });
  assert.equal(updated.user.username, 'Cannot Be Flushed');

  const exited = new Promise(resolve => running.child.once('exit', (code, signal) => resolve({ code, signal })));
  running.child.kill('SIGTERM');
  const outcome = await exited;
  fs.chmodSync(running.dataDir, 0o700);
  assert.deepEqual(outcome, { code: 1, signal: null });
  assert.match(running.output(), /"event":"graceful_shutdown_persistence_failed"/);
  assert.doesNotMatch(running.output(), /"event":"graceful_shutdown_complete"/);
});

test('startup fails closed instead of replacing corrupt or unsupported snapshots with an empty store', () => {
  const cases = [
    ['corrupt JSON', '{"schemaVersion":2,"users":'],
    ['unsupported schema', JSON.stringify({ schemaVersion: 999, users: [] })],
  ];
  for (const [label, contents] of cases) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vchat-invalid-store-'));
    const snapshotPath = path.join(dataDir, 'db.v2.json');
    fs.writeFileSync(snapshotPath, contents, { mode: 0o600 });
    const result = spawnSync(process.execPath, ['server.js'], {
      cwd: root,
      env: { ...process.env, NODE_ENV: 'test', PORT: '0', VCHAT_DATA_DIR: dataDir },
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.notEqual(result.status, 0, `${label} must block startup`);
    assert.match(result.stderr, /\[store\] load failed:/);
    assert.equal(fs.readFileSync(snapshotPath, 'utf8'), contents, `${label} must remain untouched for recovery`);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('production startup fails before loading local state when critical services are not configured', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'vchat-unsafe-production-'));
  const dataDir = path.join(parent, 'must-not-be-created');
  const env = { ...process.env, NODE_ENV: 'production', VCHAT_DATA_DIR: dataDir, PORT: '0' };
  for (const key of [
    'PUBLIC_APP_URL', 'TRUST_PROXY', 'PASSKEY_ORIGIN', 'PASSKEY_RP_ID',
    'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM', 'TURN_URLS', 'TURN_SECRET',
    'ALLOW_TRANSITIONAL_LOCAL_STORAGE',
  ]) delete env[key];
  const result = spawnSync(process.execPath, ['server.js'], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /runtime_configuration_rejected/);
  assert.match(result.stderr, /JSON\/local-media/);
  assert.equal(fs.existsSync(dataDir), false, 'configuration rejection must happen before local persistence initializes');
  fs.rmSync(parent, { recursive: true, force: true });
});

test('an explicitly configured single-node production pilot boots with secure headers and readiness', async t => {
  const { base, output } = await startServer(t, {
    NODE_ENV: 'production',
    PUBLIC_APP_URL: 'https://chat.example.com',
    TRUST_PROXY: 'loopback',
    PASSKEY_ORIGIN: 'https://chat.example.com',
    PASSKEY_RP_ID: 'example.com',
    TWILIO_ACCOUNT_SID: `AC${'0123456789abcdef'.repeat(2)}`,
    TWILIO_AUTH_TOKEN: '0123456789abcdef0123456789abcdef',
    TWILIO_FROM: '+15550000000',
    TURN_URLS: 'turns:turn.example.com:5349',
    TURN_SECRET: '0123456789abcdef0123456789abcdef',
    ALLOW_TRANSITIONAL_LOCAL_STORAGE: 'true',
    WEB_CONCURRENCY: '1',
    METRICS_TOKEN: 'test-operator-token-at-least-32-bytes',
  });
  let response = await fetch(`${base}/readyz`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
  response = await fetch(`${base}/metrics`, {
    headers: { authorization: 'Bearer test-operator-token-at-least-32-bytes' },
  });
  assert.equal(response.status, 200);
  response = await jsonRequest(`${base}/api/not-real`, {}, { origin: base });
  assert.equal(response.status, 403, 'production mutations cannot trust a matching attacker-controlled Host header');
  response = await jsonRequest(`${base}/api/not-real`, {}, { origin: 'https://chat.example.com' });
  assert.equal(response.status, 404, 'the configured canonical origin reaches normal routing');
  assert.match(output(), /TRANSITIONAL OVERRIDE ACTIVE/);
  assert.match(output(), /"persistence":"transitional-local-override"/);
});

test('disabled paid boost workloads cannot create, bill, activate, or deliver campaigns', async t => {
  const secret = 'disabled-feature-provider-secret';
  const provider = await startValmontPayStub(t, secret);
  const { base } = await startServer(t, {
    ENABLE_PAID_STORY_BOOSTS: 'false',
    VALMONTPAY_SECRET_KEY: secret,
    VALMONTPAY_API_URL: provider.base,
    PUBLIC_APP_URL: 'https://chat.example.com',
  });

  let response = await jsonRequest(`${base}/api/auth/request-code`, { dialCode: '233', number: '241234567' });
  const request = await response.json();
  response = await jsonRequest(`${base}/api/auth/verify`, { phone: request.phone, code: request.devCode });
  const verificationCookie = responseCookie(response, 'vchat_verify');
  response = await jsonRequest(`${base}/api/auth/register`, {
    phone: request.phone,
    username: 'Disabled Boost Tester',
    avatar: 'D',
    accountType: 'personal',
  }, { cookie: verificationCookie });
  assert.equal(response.status, 200);
  const cookie = responseCookie(response, 'vchat_session');

  response = await fetch(`${base}/api/stories`, { headers: { cookie } });
  assert.equal(response.status, 200);
  let stories = await response.json();
  assert.equal(stories.paymentConfigured, false);
  assert.deepEqual(stories.ads.map(ad => ad.id), ['house-vchat']);

  const boost = new FormData();
  for (const [key, value] of Object.entries({
    type: 'text', text: 'Publish normally, never create this campaign', background: 'jade', boost: 'true',
    objective: 'profile_visits', cta: 'Visit profile', adAudience: 'broad',
    budgetGhs: '25', durationDays: '3', billingEmail: 'disabled@example.com',
  })) boost.append(key, value);
  response = await fetch(`${base}/api/stories`, {
    method: 'POST', headers: { cookie, origin: base }, body: boost,
  });
  assert.equal(response.status, 201, 'the normal Status remains available when paid workloads are off');
  const created = await response.json();
  assert.equal(created.campaign, null);
  assert.equal(created.payment, null);
  assert.match(created.boostError, /paid boosts are not enabled/i);

  response = await fetch(`${base}/api/story-ads/campaigns`, { headers: { cookie } });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).campaigns, []);

  response = await jsonRequest(`${base}/api/story-ads/nonexistent/payment/initialize`, {}, { cookie, origin: base });
  assert.equal(response.status, 503);
  response = await fetch(`${base}/api/story-ads/payment/verify?reference=disabled-ref`, { headers: { cookie } });
  assert.equal(response.status, 503);

  const webhookBody = Buffer.from(JSON.stringify({
    event: 'charge.success', data: { reference: 'disabled-ref', status: 'success', amount: 25, currency: 'GHS' },
  }));
  response = await fetch(`${base}/api/story-ads/valmontpay/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-valmontpay-signature': crypto.createHmac('sha256', secret).update(webhookBody).digest('hex'),
    },
    body: webhookBody,
  });
  assert.equal(response.status, 503);

  for (const event of ['impression', 'click']) {
    response = await jsonRequest(`${base}/api/story-ads/nonexistent/${event}`, {}, { cookie, origin: base });
    assert.equal(response.status, 503);
  }
  response = await jsonRequest(`${base}/api/story-ads/house-vchat/impression`, {}, { cookie, origin: base });
  assert.equal(response.status, 200, 'the non-paid Vchat company placement remains operational');
  response = await jsonRequest(`${base}/api/story-ads/nonexistent/control`, { action: 'resume' }, { cookie, origin: base }, 'PUT');
  assert.equal(response.status, 503);
  response = await jsonRequest(`${base}/api/story-ads/nonexistent/review`, { decision: 'approve' }, { cookie, origin: base }, 'PUT');
  assert.equal(response.status, 503);

  response = await fetch(`${base}/api/stories`, { headers: { cookie } });
  stories = await response.json();
  assert.deepEqual(stories.ads.map(ad => ad.id), ['house-vchat']);
  assert.equal(provider.requests.length, 0, 'the disabled deployment never contacts ValmontPay');
});

test('ValmontPay checkout uses the tenant contract and verifies major-unit GHS payments', async t => {
  const secret = 'test-valmontpay-secret';
  const provider = await startValmontPayStub(t, secret);
  const { base, dataDir } = await startServer(t, {
    VALMONTPAY_SECRET_KEY: secret,
    VALMONTPAY_API_URL: provider.base,
    PUBLIC_APP_URL: 'https://chat.example.com',
  });

  let response = await jsonRequest(`${base}/api/auth/request-code`, { dialCode: '233', number: '501234567' });
  const request = await response.json();
  response = await jsonRequest(`${base}/api/auth/verify`, { phone: request.phone, code: request.devCode });
  assert.equal(response.status, 200);
  const verificationCookie = responseCookie(response, 'vchat_verify');
  response = await jsonRequest(`${base}/api/auth/register`, {
    phone: request.phone,
    username: 'ValmontPay Tester',
    avatar: 'V',
    accountType: 'personal',
  }, { cookie: verificationCookie });
  assert.equal(response.status, 200);
  const cookie = responseCookie(response, 'vchat_session');

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
  const webhookHeaders = {
    'content-type': 'application/json',
    'x-valmontpay-signature': crypto.createHmac('sha256', secret).update(webhookBody).digest('hex'),
  };
  await new Promise(resolve => setTimeout(resolve, 350));
  fs.chmodSync(dataDir, 0o500);
  t.after(() => {
    try { fs.chmodSync(dataDir, 0o700); } catch { /* cleanup may already have run */ }
  });
  response = await fetch(`${base}/api/story-ads/valmontpay/webhook`, {
    method: 'POST', headers: webhookHeaders, body: webhookBody,
  });
  assert.equal(response.status, 503, 'a webhook is never acknowledged before its durable commit');
  assert.equal((await fetch(`${base}/readyz`)).status, 503);
  fs.chmodSync(dataDir, 0o700);
  response = await fetch(`${base}/api/story-ads/valmontpay/webhook`, {
    method: 'POST', headers: webhookHeaders, body: webhookBody,
  });
  assert.equal(response.status, 200, 'the provider retry commits the in-memory idempotency record');
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
  response = await fetch(`${base}/api/story-ads/valmontpay/webhook`, {
    method: 'POST', headers: webhookHeaders, body: webhookBody,
  });
  assert.equal(response.status, 200, 'later provider retries are idempotently acknowledged');
  response = await fetch(`${base}/api/story-ads/campaigns`, { headers: { cookie } });
  assert.equal((await response.json()).campaigns[0].paymentStatus, 'paid');
  response = await fetch(`${base}/api/story-ads/${created.campaign.id}/payment-ledger`, { headers: { cookie } });
  assert.equal(response.status, 200);
  const ledger = (await response.json()).entries;
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].kind, 'payment_captured');
  assert.equal(ledger[0].amountMinor, 2500);
  const outsider = await registerAccount(base, '501234568', 'Payment Ledger Outsider');
  response = await fetch(`${base}/api/story-ads/${created.campaign.id}/payment-ledger`, {
    headers: { cookie: outsider.cookie },
  });
  assert.equal(response.status, 404, 'another account cannot discover a campaign financial ledger');
  const durablePayment = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.v2.json'), 'utf8'));
  assert.equal(durablePayment.paymentWebhookInbox.length, 1, 'the webhook is durable before its 200 response');
  assert.equal(durablePayment.paymentLedger.length, 1, 'provider retries append only one capture');

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

  const admin = await registerAccount(base, '241234567', 'Payments Administrator');
  response = await fetch(`${base}/api/story-ads/reconciliation`, { headers: { cookie: outsider.cookie } });
  assert.equal(response.status, 403);
  response = await fetch(`${base}/api/story-ads/reconciliation`, { headers: { cookie: admin.cookie } });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).issues, []);
  const refund = {
    amountMinor: 500,
    providerRefundId: 'vp-refund-contract-1',
    reason: 'Refund completed by finance in ValmontPay',
  };
  response = await jsonRequest(
    `${base}/api/story-ads/${created.campaign.id}/refunds`, refund,
    { cookie: admin.cookie, origin: base },
  );
  assert.equal(response.status, 200);
  const refundResult = await response.json();
  assert.equal(refundResult.externallyProcessed, true);
  assert.equal(refundResult.campaign.paymentStatus, 'partially_refunded');
  response = await jsonRequest(
    `${base}/api/story-ads/${created.campaign.id}/refunds`, refund,
    { cookie: admin.cookie, origin: base },
  );
  assert.equal(response.status, 200, 'repeating the same completed refund is idempotent');
  response = await jsonRequest(`${base}/api/story-ads/${created.campaign.id}/refunds`, {
    ...refund, amountMinor: 2500,
  }, { cookie: admin.cookie, origin: base });
  assert.equal(response.status, 409, 'a conflicting or excessive refund cannot alter the ledger');
  response = await fetch(`${base}/api/story-ads/${created.campaign.id}/payment-ledger`, {
    headers: { cookie: admin.cookie },
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).entries.map(entry => entry.kind), [
    'payment_captured', 'payment_refunded',
  ]);
  const refundSnapshot = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.v2.json'), 'utf8'));
  assert.equal(refundSnapshot.paymentLedger.length, 2, 'refund acknowledgement is a durable boundary');
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
