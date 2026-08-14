#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
const confirm = args.includes('--confirm-offline');
const positional = args.filter(arg => arg !== '--confirm-offline');
if (!confirm) fail('Refusing to overwrite a live volume. Stop the process and pass --confirm-offline.');
const [backup, destination] = positional;
if (!backup || !destination) fail('Usage: restore-local.js --confirm-offline <backup-dir> <data-dir>');

const resolvedBackup = path.resolve(backup);
const resolvedDestination = path.resolve(destination);
if (fs.existsSync(resolvedDestination)) fail('Destination already exists');
const manifestPath = path.join(resolvedBackup, 'manifest.json');
if (!fs.existsSync(manifestPath)) fail('Backup manifest.json is missing');

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch {
  fail('Backup manifest is not valid JSON');
}
if (!Array.isArray(manifest.files) || !manifest.files.length) fail('Backup manifest lists no files');

const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'vchat-restore-'));
try {
  for (const entry of manifest.files) {
    const relative = String(entry.path || '');
    if (!relative || relative.includes('..') || path.isAbsolute(relative)) {
      fail('Backup manifest contains an unsafe path');
    }
    const sourceFile = path.join(resolvedBackup, ...relative.split('/'));
    if (!fs.existsSync(sourceFile)) fail(`Missing backup file ${relative}`);
    const bytes = fs.readFileSync(sourceFile);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (digest !== entry.sha256) fail(`integrity check failed for ${relative}`);
    const target = path.join(staging, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, bytes, { mode: 0o600 });
  }

  const snapshotPath = path.join(staging, 'db.v2.json');
  if (!fs.existsSync(snapshotPath)) fail('Restored snapshot is missing db.v2.json');
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  if (snapshot.schemaVersion !== 2) fail(`Unsupported schema ${snapshot.schemaVersion}`);

  fs.mkdirSync(path.dirname(resolvedDestination), { recursive: true, mode: 0o700 });
  fs.renameSync(staging, resolvedDestination);
} catch (error) {
  try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* staging may already be moved */ }
  if (error.message && /integrity check failed|already exists|Unsupported|Missing|unsafe|not valid|missing/.test(error.message)) {
    fail(error.message);
  }
  throw error;
}

process.stdout.write(`${JSON.stringify({ ok: true, destination: resolvedDestination })}\n`);
