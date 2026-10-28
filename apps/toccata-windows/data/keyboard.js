'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

// Windows scan-set-1 positions map to the ORIGINAL Apple ANSI heatmap's
// CGKeyCode labels, not to typed characters or a Windows virtual key value.
// E0 distinguishes right modifiers, arrows, and Windows keys. Fn is never
// inferred: common PC keyboards handle it entirely in firmware.
const BASE = Object.freeze({
  0x01:53, 0x02:18, 0x03:19, 0x04:20, 0x05:21, 0x06:23, 0x07:22,
  0x08:26, 0x09:28, 0x0a:25, 0x0b:29, 0x0c:27, 0x0d:24, 0x0e:51,
  0x0f:48, 0x10:12, 0x11:13, 0x12:14, 0x13:15, 0x14:17, 0x15:16,
  0x16:32, 0x17:34, 0x18:31, 0x19:35, 0x1a:33, 0x1b:30, 0x1c:36,
  0x1d:59, 0x1e:0, 0x1f:1, 0x20:2, 0x21:3, 0x22:5, 0x23:4, 0x24:38,
  0x25:40, 0x26:37, 0x27:41, 0x28:39, 0x29:50, 0x2a:56, 0x2b:42,
  0x2c:6, 0x2d:7, 0x2e:8, 0x2f:9, 0x30:11, 0x31:45, 0x32:46,
  0x33:43, 0x34:47, 0x35:44, 0x36:60, 0x38:58, 0x39:49, 0x3a:57,
  0x3b:122, 0x3c:120, 0x3d:99, 0x3e:118, 0x3f:96, 0x40:97,
  0x41:98, 0x42:100, 0x43:101, 0x44:109, 0x57:103, 0x58:111,
  // Windows-only physical keys use stable IDs derived from scan-set 1;
  // these IDs are never interpreted as macOS CGKeyCode.
  0x37:1055, 0x45:1069, 0x46:1070,
  0x47:1071, 0x48:1072, 0x49:1073, 0x4a:1074,
  0x4b:1075, 0x4c:1076, 0x4d:1077, 0x4e:1078,
  0x4f:1079, 0x50:1080, 0x51:1081, 0x52:1082, 0x53:1083,
  0x54:1311, // Alt+PrintScreen / SysRq; same physical PrintScreen key.
});
const E0 = Object.freeze({
  0x1d:62, 0x38:61, 0x48:126, 0x50:125, 0x4b:123, 0x4d:124,
  0x5b:55, 0x5c:54,
  0x1c:1284, 0x35:1309, 0x37:1311,
  0x47:1327, 0x49:1329, 0x4f:1335, 0x51:1337,
  0x52:1338, 0x53:1339, 0x5d:1349,
});

function mapWindowsKey(scan, ext = 0) {
  if (!Number.isInteger(scan) || !Number.isInteger(ext)) return null;
  if (ext === 0) return Object.hasOwn(BASE, scan) ? BASE[scan] : null;
  if (ext === 2) return Object.hasOwn(E0, scan) ? E0[scan] : null;
  // Pause uses a multi-byte E1 1D 45 scan sequence. A single Raw Input
  // packet's representation and release behavior have not been verified;
  // keep reserved display ID 1581 unmapped until physical testing.
  return null;
}

function integer(value, name, min, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer in [${min}, ${max}]`);
  }
  return value;
}
function normalize(event) {
  if (!event || typeof event !== 'object' || event.type !== 'key') throw new TypeError('expected a key event');
  if (typeof event.event_id !== 'string' || event.event_id.length === 0 || event.event_id.length > 256)
    throw new TypeError('event_id must contain a session-qualified ID');
  const scan = integer(event.scan, 'scan', 0, 255);
  const ext = integer(event.ext, 'ext', 0, 6);
  if (![0, 2, 4, 6].includes(ext)) throw new TypeError('invalid extended flag');
  const vkey = integer(event.vkey, 'vkey', 0, 255);
  const ts = integer(event.ts_ms, 'ts_ms', 0);
  const kind = event.kind === 'down' || event.kind === 0 ? 0 : event.kind === 'up' || event.kind === 1 ? 1 : null;
  if (kind === null) throw new TypeError('kind must be down/up');
  let hold = null;
  if (event.hold_ms != null) {
    if (kind !== 1) throw new TypeError('hold_ms is valid only on up');
    hold = integer(event.hold_ms, 'hold_ms', 0);
  }
  let app = null;
  if (event.app != null) {
    if (typeof event.app !== 'string' || !event.app || event.app.length > 1024 || /[\\/\x00-\x1f]/.test(event.app))
      throw new TypeError('app must be an executable base name or null');
    app = event.app;
  }
  // Whitelist fields; neither device ID nor typed text are stored.
  return { event_id:event.event_id, ts_ms:ts, keycode:mapWindowsKey(scan, ext), kind, hold_ms:hold, app, scan, ext, vkey };
}

class KeyStore {
  constructor(filename) {
    if (typeof filename !== 'string' || !filename) throw new TypeError('missing keyboard database path');
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.pending = [];
    this.closed = false;
    try {
      this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
        CREATE TABLE IF NOT EXISTS keyboard_meta (
          name TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS key_events (
          event_id TEXT PRIMARY KEY NOT NULL,
          ts_ms INTEGER NOT NULL, keycode INTEGER, kind INTEGER NOT NULL CHECK(kind IN (0,1)),
          hold_ms INTEGER, app TEXT, scan INTEGER NOT NULL, ext INTEGER NOT NULL, vkey INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS key_events_ts ON key_events(ts_ms);
        INSERT OR IGNORE INTO keyboard_meta(name,value) VALUES ('schema_version','1'),
          ('source_keyspace','windows-scan-set-1'),('mapped_keyspace','macos-cgkeycode-ansi');`);
      this.insert = this.db.prepare(`INSERT INTO key_events
        (event_id, ts_ms, keycode, kind, hold_ms, app, scan, ext, vkey)
        VALUES ($event_id, $ts_ms, $keycode, $kind, $hold_ms, $app, $scan, $ext, $vkey)
        ON CONFLICT(event_id) DO NOTHING`);
      this.byId = this.db.prepare('SELECT event_id, ts_ms, keycode, kind, hold_ms, app, scan, ext, vkey FROM key_events WHERE event_id=?');
    } catch (e) { this.db.close(); this.closed = true; throw e; }
  }
  static open(filename) { return new KeyStore(filename); }
  add(event) {
    if (this.closed) throw new Error('keyboard store closed');
    this.pending.push(normalize(event));
    return this.pending.length;
  }
  flush() {
    if (this.closed) throw new Error('keyboard store closed');
    if (!this.pending.length) return 0;
    const batch = this.pending;
    let began = false;
    let written = 0;
    try {
      this.db.exec('BEGIN IMMEDIATE'); began = true;
      for (const event of batch) {
        const existing = this.byId.get(event.event_id);
        if (existing) {
          if (Object.keys(event).some(key => event[key] !== existing[key]))
            throw new Error(`conflicting keyboard event identity: ${event.event_id}`);
          continue;
        }
        this.insert.run(event);
        written++;
      }
      this.db.exec('COMMIT'); began = false;
      this.pending = [];
      return written;
    } catch (error) {
      if (began) { try { this.db.exec('ROLLBACK'); } catch {} }
      throw error;
    }
  }
  /** Read committed rows. Supply range and now to include necessary boundary
      events (preceding short windows and holds ending after the range). */
  query({ start_ms, end_ms, now_ms, activity_window_ms = 5000 } = {}) {
    if (this.closed) throw new Error('keyboard store closed');
    if (start_ms === undefined && end_ms === undefined && now_ms === undefined)
      return this.db.prepare('SELECT event_id, ts_ms, keycode, kind, hold_ms, app, scan, ext, vkey FROM key_events ORDER BY ts_ms, rowid').all();
    integer(start_ms, 'start_ms', 0); integer(end_ms, 'end_ms', 0); integer(now_ms, 'now_ms', 0);
    integer(activity_window_ms, 'activity_window_ms', 0);
    if (end_ms <= start_ms) throw new RangeError('end_ms must be after start_ms');
    return this.db.prepare(`SELECT event_id, ts_ms, keycode, kind, hold_ms, app, scan, ext, vkey FROM key_events
      WHERE ts_ms >= ? AND ts_ms <= ?
      AND (ts_ms < ? OR (kind=1 AND hold_ms>0 AND ts_ms-hold_ms < ?))
      ORDER BY ts_ms, rowid`).all(Math.max(0, start_ms - activity_window_ms), now_ms, end_ms, end_ms);
  }
  close() {
    if (this.closed) return;
    this.flush(); // Failure keeps the connection and buffered data available for retry.
    this.db.close();
    this.closed = true;
  }
}
module.exports = { KeyStore, mapWindowsKey };
