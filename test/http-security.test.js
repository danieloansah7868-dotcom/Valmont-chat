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
  const env = { ...process.env, PORT: String(port), VCHAT_DATA_DIR: dataDir, NODE_ENV: 'test' };
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
  return `http://127.0.0.1:${port}`;
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
  const base = await startServer(t);

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
  response = await fetch(`${base}${photoAccount.photoUrl}`, { headers: { cookie: otherCookie } });
  assert.equal(response.status, 200, 'profile photos default to visible to everyone');

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
