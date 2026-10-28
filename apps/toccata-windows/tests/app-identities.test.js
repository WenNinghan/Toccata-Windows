'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { AppIdentities, MAX_ICON_BYTES, MAX_ICON_DIMENSION } = require('../data/app-identities');
const TEMP_ROOT = 'G:\\DevTools\\temp';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aU4AAAAASUVORK5CYII=', 'base64');

function temporary(t) {
  fs.mkdirSync(TEMP_ROOT, { recursive:true });
  const dir = fs.mkdtempSync(path.join(TEMP_ROOT,'toccata-app-identities-'));
  assert.ok(path.resolve(dir).startsWith(path.resolve(TEMP_ROOT) + path.sep));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  return dir;
}

test('same basename in different directories yields distinct IDs; normalized variants match', t => {
  const dir = temporary(t); const db = new AppIdentities(dir);
  const a = db.identify('C:\\Users\\Example\\One\\tool.exe','tool.exe');
  const b = db.identify('C:\\Users\\Example\\Two\\tool.exe','tool.exe');
  const a2 = db.identify('c:/users/EXAMPLE/one/./TOOL.exe','tool.exe');
  const a3 = db.identify('\\\\?\\C:\\Users\\Example\\One\\tool.exe','tool.exe');
  assert.notEqual(a.id,b.id); assert.equal(a.id,a2.id); assert.equal(a.id,a3.id);
  assert.match(a.id,/^win-exe:v1:[a-f0-9]{64}$/); assert.equal(a.legacy,false); db.close();
});

test('identity and icon survive restart, and absolute path is never persisted', t => {
  const dir = temporary(t), exe='G:\\private-person-987\\hidden-app-path\\research.exe';
  let db = new AppIdentities(dir); const item = db.identify(exe,'research.exe');
  db.setIcon(item.id,PNG); assert.deepEqual(db.get(item.id).icon_png,PNG); db.close();
  const persisted = fs.readdirSync(dir).filter(x=>x.endsWith('.sqlite')||x.endsWith('.sqlite-wal'));
  assert.ok(persisted.length>0);
  for (const file of persisted) {
    const bytes=fs.readFileSync(path.join(dir,file));
    for(const raw of [exe,exe.toLowerCase(),'private-person-987','hidden-app-path']) {
      assert.equal(bytes.includes(Buffer.from(raw,'utf8')),false);
      assert.equal(bytes.includes(Buffer.from(raw,'utf16le')),false);
    }
  }
  db = new AppIdentities(dir);
  assert.equal(db.identify('g:/PRIVATE-PERSON-987/hidden-app-path/RESEARCH.EXE','research.exe').id,item.id);
  assert.deepEqual(db.get(item.id).icon_png,PNG); db.close();
});

test('rejects relative, drive-relative, device, malformed and non-exe paths without echoing them', t => {
  const db=new AppIdentities(temporary(t));
  for(const bad of ['tool.exe','C:foo\\tool.exe','\\folder\\tool.exe','\\\\.\\PIPE\\name.exe',
    'C:\\private\\secret.txt','C:\\private\\bad\0.exe','']) {
    assert.throws(()=>db.identify(bad,'x.exe'),error => error instanceof TypeError && !error.message.includes('private'));
  }
  assert.throws(()=>db.identify('C:\\safe\\tool.exe','C:\\private\\name.exe'),TypeError); db.close();
});

test('UNC and extended UNC equivalents normalize to the same keyed identity', t => {
  const db=new AppIdentities(temporary(t));
  const a=db.identify('\\\\SERVER\\Share\\Folder\\tool.exe','tool.exe');
  const b=db.identify('\\\\?\\UNC\\server\\share\\folder\\TOOL.exe','tool.exe');
  assert.equal(a.id,b.id); db.close();
});

test('legacy basename is distinguishable, while unknown and malformed ID remain unknown', t => {
  const db=new AppIdentities(temporary(t));
  assert.deepEqual(db.get('chrome.exe'),{id:'chrome.exe',name:'chrome.exe',icon_png:null,legacy:true});
  assert.equal(db.get(null),null); assert.equal(db.get('win-exe:v2:opaque'),null);
  assert.equal(db.get('C:\\Users\\name\\secret.exe'),null);
  assert.equal(db.get('win-exe:v1:'+'a'.repeat(64)),null); db.close();
});

test('icons enforce PNG type, byte size, dimensions, and identity existence', t => {
  const db=new AppIdentities(temporary(t)), a=db.identify('C:\\tools\\a.exe','a.exe');
  assert.throws(()=>db.setIcon(a.id,'not a buffer'),TypeError);
  assert.throws(()=>db.setIcon(a.id,Buffer.alloc(MAX_ICON_BYTES+1)),TypeError);
  assert.throws(()=>db.setIcon(a.id,Buffer.from('not-png')),TypeError);
  const big=Buffer.from(PNG); big.writeUInt32BE(MAX_ICON_DIMENSION+1,16);
  assert.throws(()=>db.setIcon(a.id,big),TypeError);
  assert.throws(()=>db.setIcon('win-exe:v1:'+'a'.repeat(64),PNG),/Unknown application identity/);
  db.setIcon(a.id,PNG); db.setIcon(a.id,null); assert.equal(db.get(a.id).icon_png,null); db.close();
});

test('missing or corrupt key never silently generates new IDs for existing data', t => {
  const dir=temporary(t); let db=new AppIdentities(dir); db.identify('C:\\tools\\a.exe','a.exe'); db.close();
  const keyFile=path.join(dir,'app-identity.key'); fs.unlinkSync(keyFile);
  assert.throws(()=>new AppIdentities(dir),/key is missing/);
  fs.writeFileSync(keyFile,Buffer.from('corrupt'));
  assert.throws(()=>new AppIdentities(dir),/Invalid application identity key/);
});
