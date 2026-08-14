'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FORMAT = 'vchat-transitional-local-backup-v1';
const MANIFEST = 'manifest.json';

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function inside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function listFiles(root, relative = '') {
  const directory = path.join(root, relative);
  const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  const files = [];
  for (const entry of entries) {
    const itemRelative = path.join(relative, entry.name);
    if (itemRelative === MANIFEST) continue;
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in backups: ${itemRelative}`);
    if (entry.isDirectory()) files.push(...listFiles(root, itemRelative));
    else if (entry.isFile()) files.push(itemRelative.split(path.sep).join('/'));
    else throw new Error(`Unsupported filesystem item: ${itemRelative}`);
  }
  return files;
}

function assertSnapshot(snapshotPath) {
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  if (snapshot.schemaVersion !== 2) throw new Error('Only schema-v2 transitional snapshots can be backed up or restored');
  return snapshot;
}

function copyRegularFile(source, destination) {
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing to copy non-regular file: ${source}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, 0o600);
}

function createLocalBackup(sourceDirectory, destinationDirectory) {
  const source = path.resolve(sourceDirectory);
  const destination = path.resolve(destinationDirectory);
  if (!fs.statSync(source).isDirectory()) throw new Error('Backup source must be a directory');
  if (inside(source, destination)) throw new Error('Backup destination must be outside the live data directory');
  if (fs.existsSync(destination)) throw new Error('Backup destination already exists');
  assertSnapshot(path.join(source, 'db.v2.json'));

  const stage = `${destination}.partial-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.mkdirSync(stage, { recursive: false, mode: 0o700 });
    const selected = ['db.v2.json'];
    const mediaDirectory = path.join(source, 'media');
    if (fs.existsSync(mediaDirectory)) {
      for (const relative of listFiles(mediaDirectory)) selected.push(`media/${relative}`);
    }
    selected.sort();
    const files = [];
    for (const relative of selected) {
      const sourceFile = path.join(source, ...relative.split('/'));
      const destinationFile = path.join(stage, ...relative.split('/'));
      copyRegularFile(sourceFile, destinationFile);
      files.push({ path: relative, bytes: fs.statSync(destinationFile).size, sha256: sha256(destinationFile) });
    }
    const manifest = { format: FORMAT, schemaVersion: 2, files };
    fs.writeFileSync(path.join(stage, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(stage, destination);
    return manifest;
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

function readAndVerifyLocalBackup(backupDirectory) {
  const backup = path.resolve(backupDirectory);
  const manifest = JSON.parse(fs.readFileSync(path.join(backup, MANIFEST), 'utf8'));
  if (manifest.format !== FORMAT || manifest.schemaVersion !== 2 || !Array.isArray(manifest.files)) {
    throw new Error('Unsupported or malformed backup manifest');
  }
  const actual = listFiles(backup);
  const declared = manifest.files.map(item => item?.path).sort();
  if (new Set(declared).size !== declared.length || JSON.stringify(actual) !== JSON.stringify(declared)) {
    throw new Error('Backup contents do not match its manifest');
  }
  for (const item of manifest.files) {
    if (!/^(?:db\.v2\.json|media\/[A-Za-z0-9._/-]+)$/.test(item.path)
        || item.path.includes('..') || path.isAbsolute(item.path)) {
      throw new Error('Backup manifest contains an unsafe path');
    }
    const filePath = path.join(backup, ...item.path.split('/'));
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.size !== item.bytes || sha256(filePath) !== item.sha256) {
      throw new Error(`Backup integrity check failed for ${item.path}`);
    }
  }
  assertSnapshot(path.join(backup, 'db.v2.json'));
  return manifest;
}

function restoreLocalBackup(backupDirectory, destinationDirectory) {
  const backup = path.resolve(backupDirectory);
  const destination = path.resolve(destinationDirectory);
  if (inside(backup, destination)) throw new Error('Restore destination must be outside the backup directory');
  if (fs.existsSync(destination)) throw new Error('Restore destination already exists');
  const manifest = readAndVerifyLocalBackup(backup);
  const stage = `${destination}.partial-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.mkdirSync(stage, { recursive: false, mode: 0o700 });
    for (const item of manifest.files) {
      copyRegularFile(
        path.join(backup, ...item.path.split('/')),
        path.join(stage, ...item.path.split('/')),
      );
    }
    fs.renameSync(stage, destination);
    return manifest;
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { FORMAT, MANIFEST, createLocalBackup, readAndVerifyLocalBackup, restoreLocalBackup };
