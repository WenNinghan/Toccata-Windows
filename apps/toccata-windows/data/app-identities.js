'use strict';

// Application identity is local to one installation. A keyed digest separates
// equal executable basenames without persisting the executable's absolute path.
// Keep the key together with the database when backing up or moving the data.
const { DatabaseSync } = require('node:sqlite');
const { createHmac, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ID_PREFIX = 'win-exe:v1:';
const ID_PATTERN = /^win-exe:v1:[0-9a-f]{64}$/;
const MAX_ICON_BYTES = 256 * 1024;
const MAX_ICON_DIMENSION = 512;
const PNG_SIGNATURE = Buffer.from([137,80,78,71,13,10,26,10]);

function normalizeExecutablePath(value) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f]/.test(value)) throw new TypeError('Invalid executable path');
  let source = value.replace(/\//g, '\\');
  // Normalize long-path prefixes to the equivalent standard drive/UNC path.
  if (/^\\\\\?\\UNC\\/i.test(source)) source = '\\\\' + source.slice(8);
  else if (/^\\\\\?\\/.test(source)) source = source.slice(4);
  if (/^\\\\[.?]\\/.test(source)) throw new TypeError('Invalid executable path');
  const drive = /^[A-Za-z]:\\/.test(source);
  const unc = /^\\\\[^\\]+\\[^\\]+\\/.test(source);
  if (!drive && !unc) throw new TypeError('Executable path must be absolute');
  const normalized = path.win32.normalize(source);
  if (!/\.exe$/i.test(path.win32.basename(normalized))) throw new TypeError('Invalid executable path');
  return normalized.toLowerCase();
}

function displayName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\\/\x00-\x1f]/.test(value))
    throw new TypeError('Invalid application name');
  return value.trim();
}
function legacyName(value) {
  return typeof value === 'string' && value.length <= 512 && value.trim() === value && value.length > 0 &&
    !/[\\/\x00-\x1f]/.test(value) && !/^win-exe:/i.test(value) ? value : null;
}
function assertIcon(icon) {
  if (!Buffer.isBuffer(icon)) throw new TypeError('Icon must be a PNG Buffer');
  if (icon.length > MAX_ICON_BYTES || icon.length < 33 || !icon.subarray(0,8).equals(PNG_SIGNATURE) ||
      icon.readUInt32BE(8) !== 13 || icon.toString('ascii',12,16) !== 'IHDR') {
    throw new TypeError('Invalid or oversized PNG icon');
  }
  const width = icon.readUInt32BE(16), height = icon.readUInt32BE(20);
  if (!width || !height || width > MAX_ICON_DIMENSION || height > MAX_ICON_DIMENSION) {
    throw new TypeError('Invalid or oversized PNG icon');
  }
}
function readOrCreateKey(keyPath, dbPath) {
  let created = false, fd;
  try {
    try {
      const existing = fs.readFileSync(keyPath);
      if (existing.length !== 32) throw new Error('Invalid application identity key');
      return existing;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    // Creating a replacement key would silently split every existing identity.
    if (fs.existsSync(dbPath)) throw new Error('Application identity key is missing');
    try {
      fd = fs.openSync(keyPath, 'wx', 0o600); created = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = fs.readFileSync(keyPath);
      if (existing.length !== 32) throw new Error('Invalid application identity key');
      return existing;
    }
    const key = randomBytes(32);
    fs.writeFileSync(fd, key);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    return key;
  } catch (error) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    if (created) { try { fs.unlinkSync(keyPath); } catch {} }
    if (error.message === 'Application identity key is missing' || error.message === 'Invalid application identity key') throw error;
    throw new Error('Unable to initialize application identity key');
  }
}

class AppIdentities {
  #key;
  constructor(dataDir) {
    if (typeof dataDir !== 'string' || !dataDir || !path.isAbsolute(dataDir)) throw new TypeError('Application identity directory must be absolute');
    const dbPath = path.join(dataDir, 'app-identities.sqlite');
    const keyPath = path.join(dataDir, 'app-identity.key');
    try { fs.mkdirSync(dataDir, { recursive:true }); } catch { throw new Error('Unable to initialize application identity directory'); }
    this.#key = readOrCreateKey(keyPath, dbPath);
    this.closed = false;
    try {
      this.db = new DatabaseSync(dbPath);
      this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
        CREATE TABLE IF NOT EXISTS app_identities (
          id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, icon_png BLOB
        );`);
      this.upsert = this.db.prepare(`INSERT INTO app_identities(id,name) VALUES (?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name WHERE app_identities.name<>excluded.name`);
      this.byId = this.db.prepare('SELECT id,name,icon_png FROM app_identities WHERE id=?');
      this.updateIcon = this.db.prepare('UPDATE app_identities SET icon_png=? WHERE id=?');
    } catch {
      if (this.db) { try { this.db.close(); } catch {} }
      this.closed = true; this.#key.fill(0);
      throw new Error('Unable to initialize application identity database');
    }
  }
  identify(exePath, name) {
    if (this.closed) throw new Error('Application identity store closed');
    const normalized = normalizeExecutablePath(exePath);
    const label = displayName(name == null ? path.win32.basename(normalized) : name);
    const id = ID_PREFIX + createHmac('sha256', this.#key).update(normalized, 'utf8').digest('hex');
    try { this.upsert.run(id, label); } catch { throw new Error('Unable to save application identity'); }
    return this.get(id);
  }
  setIcon(id, icon) {
    if (this.closed) throw new Error('Application identity store closed');
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new TypeError('Invalid application identity');
    if (icon !== null) assertIcon(icon);
    try {
      const result = this.updateIcon.run(icon, id);
      if (result.changes !== 1) throw new Error('Unknown application identity');
    } catch (error) {
      if (error.message === 'Unknown application identity') throw error;
      throw new Error('Unable to save application icon');
    }
    return this.get(id);
  }
  get(id) {
    if (this.closed) throw new Error('Application identity store closed');
    if (typeof id !== 'string' || !id) return null;
    if (!ID_PATTERN.test(id)) {
      const legacy = legacyName(id);
      return legacy ? { id:legacy, name:legacy, icon_png:null, legacy:true } : null;
    }
    let found;
    try { found = this.byId.get(id); } catch { throw new Error('Unable to read application identity'); }
    if (!found) return null;
    return { id:found.id, name:found.name, icon_png:found.icon_png === null ? null : Buffer.from(found.icon_png), legacy:false };
  }
  close() {
    if (this.closed) return;
    this.db.close(); this.#key.fill(0); this.closed = true;
  }
}

module.exports = { AppIdentities, MAX_ICON_BYTES, MAX_ICON_DIMENSION };
