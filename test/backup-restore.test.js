'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');

function run(script, ...args) {
  return spawnSync(process.execPath, [path.join(root, script), ...args], { encoding: 'utf8' });
}

function digest(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

test('offline backup and restore verify schema, bytes, and digests before atomic recovery', t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'vchat-backup-test-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const source = path.join(workspace, 'live-data');
  const backup = path.join(workspace, 'backup');
  const restored = path.join(workspace, 'restored-data');
  fs.mkdirSync(path.join(source, 'media'), { recursive: true });
  fs.writeFileSync(path.join(source, 'db.v2.json'), JSON.stringify({ schemaVersion: 2, users: [], marker: 'before' }));
  fs.writeFileSync(path.join(source, 'media', 'protected.bin'), Buffer.from([0, 1, 2, 3, 255]));

  let result = run('scripts/backup-local.js', source, backup);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--confirm-offline/);
  assert.equal(fs.existsSync(backup), false);

  result = run('scripts/backup-local.js', '--confirm-offline', source, backup);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.files, 2);
  const manifest = JSON.parse(fs.readFileSync(path.join(backup, 'manifest.json')));
  assert.deepEqual(manifest.files.map(item => item.path), ['db.v2.json', 'media/protected.bin']);
  assert.equal(manifest.files[1].sha256, digest(path.join(source, 'media', 'protected.bin')));

  fs.writeFileSync(path.join(source, 'db.v2.json'), JSON.stringify({ schemaVersion: 2, marker: 'after' }));
  fs.writeFileSync(path.join(source, 'media', 'protected.bin'), 'changed');
  result = run('scripts/restore-local.js', '--confirm-offline', backup, restored);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(restored, 'db.v2.json'))).marker, 'before');
  assert.deepEqual(fs.readFileSync(path.join(restored, 'media', 'protected.bin')), Buffer.from([0, 1, 2, 3, 255]));

  result = run('scripts/restore-local.js', '--confirm-offline', backup, restored);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already exists/);
});

test('restore rejects a tampered backup without leaving a partial data directory', t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'vchat-backup-tamper-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const source = path.join(workspace, 'source');
  const backup = path.join(workspace, 'backup');
  const restored = path.join(workspace, 'restored');
  fs.mkdirSync(path.join(source, 'media'), { recursive: true });
  fs.writeFileSync(path.join(source, 'db.v2.json'), JSON.stringify({ schemaVersion: 2 }));
  fs.writeFileSync(path.join(source, 'media', 'item.bin'), 'original');
  assert.equal(run('scripts/backup-local.js', '--confirm-offline', source, backup).status, 0);

  fs.writeFileSync(path.join(backup, 'media', 'item.bin'), 'tampered');
  const result = run('scripts/restore-local.js', '--confirm-offline', backup, restored);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /integrity check failed/);
  assert.equal(fs.existsSync(restored), false);
});
