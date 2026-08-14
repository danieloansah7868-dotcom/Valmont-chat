#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
const confirm = args.includes('--confirm-offline');
const positional = args.filter(arg => arg !== '--confirm-offline');
if (!confirm) fail('Refusing to copy a live volume. Stop the process and pass --confirm-offline.');
const [source, destination] = positional;
if (!source || !destination) fail('Usage: backup-local.js --confirm-offline <data-dir> <backup-dir>');

const resolvedSource = path.resolve(source);
const resolvedDestination = path.resolve(destination);
if (!fs.existsSync(resolvedSource) || !fs.statSync(resolvedSource).isDirectory()) {
  fail('Source data directory does not exist');
}
if (fs.existsSync(resolvedDestination)) fail('Backup directory already exists');

const snapshotPath = path.join(resolvedSource, 'db.v2.json');
if (!fs.existsSync(snapshotPath)) fail('db.v2.json is missing from the source directory');
let snapshot;
try {
  snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
} catch {
  fail('Source snapshot is not valid JSON');
}
if (snapshot.schemaVersion !== 2) fail(`Unsupported schema ${snapshot.schemaVersion}`);

function walk(directory, prefix = '') {
  const entries = [];
  for (const name of fs.readdirSync(directory).sort()) {
    const full = path.join(directory, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    const stat = fs.statSync(full);
    if (stat.isDirectory()) entries.push(...walk(full, relative));
    else if (stat.isFile()) entries.push({ full, relative, size: stat.size });
  }
  return entries;
}

const files = walk(resolvedSource);
fs.mkdirSync(resolvedDestination, { recursive: true, mode: 0o700 });
const manifestFiles = [];
for (const file of files) {
  const target = path.join(resolvedDestination, file.relative);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.copyFileSync(file.full, target);
  fs.chmodSync(target, 0o600);
  manifestFiles.push({
    path: file.relative.split(path.sep).join('/'),
    size: file.size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file.full)).digest('hex'),
  });
}

const manifest = {
  createdAt: new Date().toISOString(),
  schemaVersion: 2,
  files: manifestFiles,
};
fs.writeFileSync(path.join(resolvedDestination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ ok: true, files: files.length, destination: resolvedDestination })}\n`);
