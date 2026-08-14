#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { createLocalBackup } = require('../lib/local-backup');

function fail(message) {
  process.stderr.write(`Backup failed: ${message}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args[0] !== '--confirm-offline' || args.length !== 3) {
  fail('usage: node scripts/backup-local.js --confirm-offline <data-directory> <new-backup-directory>');
}

try {
  const manifest = createLocalBackup(path.resolve(args[1]), path.resolve(args[2]));
  process.stdout.write(`${JSON.stringify({ ok: true, format: manifest.format, files: manifest.files.length })}\n`);
} catch (error) {
  fail(error.message);
}
