'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
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

async function startServer(t) {
  const port = await availablePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vchat-http-test-'));
  const env = {
    ...process.env,
    PORT: String(port),
    VCHAT_DATA_DIR: dataDir,
    NODE_ENV: 'test',
    REEL_MAX_MB: '1',
    REEL_UPLOAD_LIMIT: '50',
  };
  delete env.TWILIO_ACCOUNT_SID;
  delete env.TWILIO_AUTH_TOKEN;
  delete env.TWILIO_FROM;
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

  response = await jsonRequest(`${base}/api/auth/verify`, { phone: request.phone, code: request.devCode });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).needsProfile, true);

  response = await jsonRequest(`${base}/api/auth/register`, {
    phone: request.phone,
    username: 'HTTP Tester',
    avatar: 'T',
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
  response = await fetch(`${base}${photoAccount.photoUrl}`, { headers: { cookie: otherCookie } });
  assert.equal(response.status, 200, 'profile photos default to visible to everyone');

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
