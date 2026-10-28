'use strict';

// Real Electron + SQLite integration, fed exclusively by synthetic JSONL.
// The separate harness rejects any attempt to spawn a real capture helper.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const project = path.resolve(__dirname,'..');
const workspace = path.resolve(project,'..','..','..');
const electron = path.join(project,'node_modules','electron','dist','electron.exe');
const harness = path.join(__dirname,'synthetic-capture-harness.cjs');
const fakeHelper = path.join(__dirname,'synthetic-helper.cjs');
const fakePaths = ['C:\\QA\\alpha\\editor.exe','C:\\QA\\beta\\editor.exe'];
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));

async function timeout(promise,ms){let timer;try{return await Promise.race([promise,new Promise(r=>{timer=setTimeout(()=>r(null),ms)})])}finally{clearTimeout(timer)}}
async function until(fn,ms,label){const deadline=Date.now()+ms;let last;while(Date.now()<deadline){try{const value=await fn();if(value)return value}catch(error){last=error}await delay(75)}throw new Error(`${label} timed out${last?`: ${last.message}`:''}`)}
class CDP {
  constructor(ws){this.ws=ws;this.next=0;this.pending=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data),p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);if(m.error)p.reject(new Error(m.error.message));else p.resolve(m.result)});ws.addEventListener('close',()=>{for(const p of this.pending.values())p.reject(new Error('CDP closed'));this.pending.clear()})}
  static async connect(url){const ws=new WebSocket(url),ok=await timeout(new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',()=>reject(new Error('CDP connection failed')),{once:true})}),5000);if(!ok)throw new Error('CDP timeout');return new CDP(ws)}
  async eval(expression){const id=++this.next,r=await new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}))});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value}
  close(){this.ws.close()}
}

async function launch(dataDir, capture) {
  const temp = path.join(dataDir,'temp');fs.mkdirSync(temp,{recursive:true});
  const env={...process.env,TOCCATA_DATA_DIR:dataDir,TEMP:temp,TMP:temp,
    TOCCATA_QA_HELPER_EXE:process.execPath,TOCCATA_QA_HELPER_SCRIPT:fakeHelper};
  delete env.ELECTRON_RUN_AS_NODE;delete env.TOCCATA_QA_MEMORY;delete env.TOCCATA_QA_SCREENSHOT;
  if(capture)delete env.TOCCATA_DISABLE_CAPTURE;else env.TOCCATA_DISABLE_CAPTURE='1';
  const proc=spawn(electron,['--remote-debugging-port=0','--remote-allow-origins=*','--disable-gpu',harness],
    {cwd:project,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
  let output='',exited=false,spawnError;
  proc.stdout.on('data',x=>{output+=x});proc.stderr.on('data',x=>{output+=x});proc.on('error',e=>{spawnError=e});
  const done=new Promise(resolve=>proc.once('close',(code,signal)=>{exited=true;resolve({code,signal})}));
  try{
    const port=await until(()=>{if(spawnError)throw spawnError;const match=output.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);if(match)return Number(match[1]);if(exited)throw new Error('Electron exited')},20000,'startup');
    const target=await until(async()=>{const pages=await(await fetch(`http://127.0.0.1:${port}/json`)).json();return pages.find(p=>p.type==='page'&&p.url.includes('/renderer/index.html')&&!p.url.includes('?')&&p.webSocketDebuggerUrl)},10000,'main renderer');
    const cdp=await CDP.connect(target.webSocketDebuggerUrl);
    await until(()=>cdp.eval('Boolean(window.toccata?.invoke && document.querySelector("#main h1"))'),10000,'preload');
    return {proc,done,cdp,getOutput:()=>output};
  }catch(error){if(!exited)proc.kill();await timeout(done,3000);throw error}
}
async function invoke(cdp,name,payload={}){return cdp.eval(`window.toccata.invoke(${JSON.stringify(name)},${JSON.stringify(payload)})`)}
async function closeApp(instance){try{await instance.cdp.eval("(()=>{window.toccata.invoke('app:quit').catch(()=>{});return true})()")}catch(_){}const result=await timeout(instance.done,10000);assert.ok(result,'Electron failed to exit');assert.equal(result.code,0,instance.getOutput().slice(-2000));instance.cdp.close()}

function assertNoPaths(value) {
  const walk = x => {
    if(typeof x==='string')for(const p of fakePaths)assert.equal(x.toLowerCase().includes(p.toLowerCase()),false,'absolute path leaked');
    else if(Array.isArray(x))x.forEach(walk);
    else if(x && typeof x==='object')Object.values(x).forEach(walk);
  };
  walk(value);
}
function assertDbNoPaths(file) {
  // SQLite may store strings in either UTF-8 or UTF-16. These are fixed,
  // synthetic path values; file contents are never printed.
  for(const suffix of ['','-wal']){
    if(!fs.existsSync(file+suffix))continue;
    const bytes=fs.readFileSync(file+suffix);
    for(const p of fakePaths)for(const encoding of ['utf8','utf16le'])
      assert.equal(bytes.includes(Buffer.from(p,encoding)),false,'absolute path persisted in SQLite');
  }
}

test('synthetic scan events survive real Electron, SQLite, UI rendering and restart', {timeout:50000}, async t=>{
  assert.ok(fs.existsSync(electron));
  const dataDir=fs.mkdtempSync(path.join(workspace,'Toccata-synthetic-qa-data-'));
  assert.equal(path.dirname(path.resolve(dataDir)),path.resolve(workspace));
  assert.ok(path.basename(dataDir).startsWith('Toccata-synthetic-qa-data-'));
  let instance;
  t.after(async()=>{if(instance&&instance.proc.exitCode===null){instance.proc.kill();await timeout(instance.done,3000)}if(instance)try{instance.cdp.close()}catch(_){}fs.rmSync(dataDir,{recursive:true,force:true})});

  instance=await launch(dataDir,true);
  await instance.cdp.eval("(()=>{window.__qaEvents=[];window.toccata.on('key',x=>window.__qaEvents.push(x));return true})()");
  const state=await until(async()=>{const x=await invoke(instance.cdp,'capture:status');return x.state==='active'&&x},10000,'synthetic helper ready');
  assert.equal(state.state,'active');
  const bounds={start_ms:Date.now()-3600000,end_ms:Date.now()+3600000};
  const stats=await until(async()=>{const x=await invoke(instance.cdp,'stats:query',bounds);return x.key_count===2&&x.apps.length===2&&x},10000,'synthetic stats');
  assert.equal(stats.key_count,2);assert.equal(stats.keys['0'],1);assert.equal(stats.keys['8'],1);
  assert.equal(stats.apps.length,2);assert.equal(new Set(stats.apps.map(x=>x.id)).size,2);
  assert.deepEqual(stats.apps.map(x=>x.name),['editor.exe','editor.exe']);
  assert.ok(stats.apps.every(x=>x.id.startsWith('win-exe:v1:')&&x.key_count===1));
  assertNoPaths(stats);
  const observed=await until(()=>instance.cdp.eval('window.__qaEvents.length===4 && window.__qaEvents'),5000,'renderer events');
  assert.equal(observed.length,4);assertNoPaths(observed);
  assert.ok(observed.every(e=>!Object.hasOwn(e,'exe_path')));
  await instance.cdp.eval("document.querySelector('[data-page=activity]').click();true");
  await until(()=>instance.cdp.eval("document.querySelector('[data-key=\"0\"]')?.classList.contains('hot') && document.querySelector('[data-key=\"8\"]')?.classList.contains('hot')"),10000,'heatmap');
  assertNoPaths(await instance.cdp.eval('document.body.innerText'));
  const ids=stats.apps.map(x=>x.id).sort();
  await closeApp(instance);instance=null;

  const keyDb=path.join(dataDir,'toccata-windows.sqlite'), identityDb=path.join(dataDir,'app-identities.sqlite');
  const keys=new DatabaseSync(keyDb,{readOnly:true}), identities=new DatabaseSync(identityDb,{readOnly:true});
  try{
    const rows=keys.prepare('SELECT * FROM key_events ORDER BY ts_ms').all();
    const apps=identities.prepare('SELECT id,name FROM app_identities').all();
    assert.equal(rows.length,4);assert.equal(new Set(rows.map(x=>x.app)).size,2);
    assert.deepEqual(apps.map(x=>x.id).sort(),ids);
    assertNoPaths(rows);assertNoPaths(apps);
  }finally{keys.close();identities.close()}
  assertDbNoPaths(keyDb);assertDbNoPaths(identityDb);

  // Reopen with capture disabled, so the fixture cannot insert a second set.
  instance=await launch(dataDir,false);
  assert.equal((await invoke(instance.cdp,'capture:status')).state,'disabled');
  const persisted=await invoke(instance.cdp,'stats:query',bounds);
  assert.equal(persisted.key_count,2);assert.equal(persisted.keys['0'],1);assert.equal(persisted.keys['8'],1);
  assert.deepEqual(persisted.apps.map(x=>x.id).sort(),ids);
  assert.deepEqual(persisted.apps.map(x=>x.name),['editor.exe','editor.exe']);
  assertNoPaths(persisted);
  await closeApp(instance);instance=null;
});
