#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { restoreLocalBackup } = require('../lib/local-backup');

function fail(message) {
  process.stderr.write(`Restore failed: ${message}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args[0] !== '--confirm-offline' || args.length !== 3) {
  fail('usage: node scripts/restore-local.js --confirm-offline <backup-directory> <new-data-directory>');
}

try {
  const manifest = restoreLocalBackup(path.resolve(args[1]), path.resolve(args[2]));
  process.stdout.write(`${JSON.stringify({ ok: true, format: manifest.format, files: manifest.files.length })}\n`);
} catch (error) {
  fail(error.message);
}
