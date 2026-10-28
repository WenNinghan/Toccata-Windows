'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { KeyStore, mapWindowsKey } = require('../data/keyboard');

function event(id, overrides = {}) {
  return { type:'key', event_id:`session-123:${id}`, scan:0x1e, ext:0, vkey:65,
    kind:'down', ts_ms:10000, hold_ms:null, app:'notepad.exe', device:'transient', ...overrides };
}

test('physical mapping matches original ANSI keyboard and keeps unknown keys unknown', () => {
  const base = [[0x01,53],[0x02,18],[0x0b,29],[0x10,12],[0x1e,0],[0x2e,8],
    [0x39,49],[0x1d,59],[0x2a,56],[0x36,60],[0x38,58],[0x0e,51],
    [0x0c,27],[0x0d,24],[0x1a,33],[0x1b,30],[0x27,41],[0x28,39],
    [0x29,50],[0x2b,42],[0x33,43],[0x34,47],[0x35,44]];
  for (const [scan, expected] of base) assert.equal(mapWindowsKey(scan,0), expected);
  const f = [122,120,99,118,96,97,98,100,101,109];
  for (let i=0; i<f.length; i++) assert.equal(mapWindowsKey(0x3b+i,0),f[i]);
  assert.equal(mapWindowsKey(0x57,0),103); assert.equal(mapWindowsKey(0x58,0),111);
  for (const [scan, expected] of [[0x1d,62],[0x38,61],[0x5b,55],[0x5c,54],
    [0x48,126],[0x50,125],[0x4b,123],[0x4d,124]]) assert.equal(mapWindowsKey(scan,2),expected);
  for (const [scan,ext] of [[0,0],[0x70,0],[0x1e,2],[0x1d,4],[0x45,4],[0xffff,0]]) assert.equal(mapWindowsKey(scan,ext),null);
  // None of the defined scan positions may masquerade as the upstream Fn code.
  for (let scan=0; scan<256; scan++) for (const ext of [0,2,4]) assert.notEqual(mapWindowsKey(scan,ext),63);
});

test('full-size Windows keypad, navigation and special keys have separate stable IDs', () => {
  const base = [[0x37,1055],[0x45,1069],[0x46,1070],[0x47,1071],
    [0x48,1072],[0x49,1073],[0x4a,1074],[0x4b,1075],[0x4c,1076],
    [0x4d,1077],[0x4e,1078],[0x4f,1079],[0x50,1080],[0x51,1081],
    [0x52,1082],[0x53,1083],[0x54,1311]];
  const extended = [[0x1c,1284],[0x35,1309],[0x37,1311],
    [0x47,1327],[0x49,1329],[0x4f,1335],[0x51,1337],[0x52,1338],
    [0x53,1339],[0x5d,1349]];
  for (const [scan,id] of base) assert.equal(mapWindowsKey(scan,0),id);
  for (const [scan,id] of extended) assert.equal(mapWindowsKey(scan,2),id);
  assert.notEqual(mapWindowsKey(0x48,0),mapWindowsKey(0x48,2)); // numpad 8 vs arrow up
  assert.notEqual(mapWindowsKey(0x1c,0),mapWindowsKey(0x1c,2)); // Enter vs numpad Enter
  assert.notEqual(mapWindowsKey(0x35,0),mapWindowsKey(0x35,2)); // slash vs numpad divide
  assert.notEqual(mapWindowsKey(0x47,0),mapWindowsKey(0x47,2)); // numpad 7 vs Home
  assert.equal(mapWindowsKey(0x37,2),mapWindowsKey(0x54,0)); // physical PrintScreen/SysRq
  // Pause E1 sequence has multiple bytes: unknown until a real Raw Input trace.
  assert.equal(mapWindowsKey(0x1d,4),null);
  assert.equal(mapWindowsKey(0x45,4),null);
});

test('commits once by event_id, retains physical metadata, drops device and input text', () => {
  const db = new KeyStore(':memory:');
  const a = event(1, { text:'private text', character:'A' });
  const b = event(2, {kind:'up', ts_ms:10100,hold_ms:100});
  db.add(a); db.add(a); db.add(b);
  assert.equal(db.flush(), 2);
  const rows = db.query();
  assert.equal(rows.length,2); assert.equal(rows[0].keycode,0);
  assert.equal(rows[1].hold_ms,100); assert.equal(rows[0].scan,0x1e);
  assert.equal(Object.hasOwn(rows[0],'device'),false); assert.equal(Object.hasOwn(rows[0],'text'),false);
  assert.equal(Object.hasOwn(rows[0],'character'),false);
  db.add(a); assert.equal(db.flush(),0); assert.equal(db.query().length,2);
  db.close();
});

test('unknown positions remain null while event is saved', () => {
  const db = KeyStore.open(':memory:');
  db.add(event(1, {scan:0x70, ext:0})); db.flush();
  assert.equal(db.query()[0].keycode,null); db.close();
});

test('transaction failure retains the whole pending batch and retry commits once', () => {
  const db = new KeyStore(':memory:');
  db.db.exec("CREATE TEMP TRIGGER fail_input BEFORE INSERT ON key_events BEGIN SELECT RAISE(ABORT,'test failure'); END");
  db.add(event(1)); db.add(event(2, {kind:'up',ts_ms:10100,hold_ms:100}));
  assert.throws(() => db.flush(), /test failure/);
  assert.equal(db.pending.length,2); assert.equal(db.query().length,0);
  db.db.exec('DROP TRIGGER fail_input');
  assert.equal(db.flush(),2); assert.equal(db.pending.length,0);
  assert.equal(db.flush(),0); assert.equal(db.query().length,2); db.close();
});

test('event identity collision rejects changes without losing pending data', () => {
  const db = new KeyStore(':memory:');
  db.add(event(1)); db.flush(); db.add(event(1,{scan:0x2e,vkey:67}));
  assert.throws(() => db.flush(),/conflicting keyboard event identity/);
  assert.equal(db.pending.length,1); assert.equal(db.query().length,1);
  db.pending = []; db.close();
});

test('date range includes overlapping earlier windows and later released holds', () => {
  const db = new KeyStore(':memory:');
  db.add(event(1,{ts_ms:6000}));
  db.add(event(2,{ts_ms:12000}));
  db.add(event(3,{ts_ms:18000,kind:'up',hold_ms:12000}));
  db.add(event(4,{ts_ms:20000,kind:'up',hold_ms:1000}));
  db.flush();
  const rows = db.query({start_ms:10000,end_ms:15000,now_ms:21000});
  assert.deepEqual(rows.map(x=>x.event_id),['session-123:1','session-123:2','session-123:3']);
  db.close();
});

test('file database uses WAL and retains committed rows after reopening', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'toccata-key-test-'));
  const file = path.join(dir,'keyboard.sqlite');
  try {
    const db = KeyStore.open(file);
    assert.equal(db.db.prepare('PRAGMA journal_mode').get().journal_mode,'wal');
    db.add(event(1)); db.close();
    const reopened = KeyStore.open(file);
    assert.equal(reopened.query().length,1); reopened.close();
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
