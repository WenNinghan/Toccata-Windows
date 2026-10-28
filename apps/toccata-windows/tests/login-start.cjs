'use strict';

// Simulate the --login command-line path only. Never change the system login
// setting, never enable capture, and isolate all temporary state on G:.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const project = path.resolve(__dirname, '..');
const workspace = path.resolve(project, '..', '..', '..');
const executable = path.join(project, 'node_modules', 'electron', 'dist', 'electron.exe');
const harness = path.join(__dirname, 'login-harness.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function timeout(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); })]); }
  finally { clearTimeout(timer); }
}
async function until(fn, ms, label) {
  const deadline = Date.now() + ms; let last;
  while (Date.now() < deadline) {
    try { const result = await fn(); if (result) return result; } catch (error) { last = error; }
    await delay(75);
  }
  throw new Error(`${label} timed out${last ? `: ${last.message}` : ''}`);
}
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data), pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
    });
    ws.addEventListener('close', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('CDP closed'));
      this.pending.clear();
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    const opened = await timeout(new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once:true });
      ws.addEventListener('error', () => reject(new Error('CDP connection failed')), { once:true });
    }), 5000);
    if (!opened) throw new Error('CDP connection timed out');
    return new CDP(ws);
  }
  async evaluate(expression) {
    const id = ++this.id;
    const result = await new Promise((resolve, reject) => {
      this.pending.set(id, {resolve,reject});
      this.ws.send(JSON.stringify({ id, method:'Runtime.evaluate', params:{expression,awaitPromise:true,returnByValue:true} }));
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  close() { this.ws.close(); }
}

async function launch(dir, login) {
  const tempDir = path.join(dir, 'temp'); fs.mkdirSync(tempDir, {recursive:true});
  const env = { ...process.env, TOCCATA_DATA_DIR:dir, TOCCATA_DISABLE_CAPTURE:'1', TEMP:tempDir, TMP:tempDir };
  delete env.ELECTRON_RUN_AS_NODE; delete env.TOCCATA_QA_SCREENSHOT; delete env.TOCCATA_QA_MEMORY;
  const args = ['--remote-debugging-port=0','--remote-allow-origins=*','--disable-gpu',harness];
  if (login) args.push('--login');
  const proc = spawn(executable,args,{cwd:project,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
  let output = '', exited = false, error;
  proc.stdout.on('data', b => { output += b; }); proc.stderr.on('data', b => { output += b; });
  proc.on('error', e => { error = e; });
  const done = new Promise(resolve => proc.once('close',(code,signal)=>{exited=true;resolve({code,signal})}));
  try {
    const port = await until(() => {
      if(error) throw error;
      const found = output.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if(found) return Number(found[1]);
      if(exited) throw new Error('Electron exited');
    }, 20000, 'Electron startup');
    const target = await until(async () => {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      return pages.find(p => p.type==='page' && p.url.includes('/renderer/index.html') && !p.url.includes('?') && p.webSocketDebuggerUrl);
    }, 10000, 'main page');
    const cdp = await CDP.connect(target.webSocketDebuggerUrl);
    await until(() => cdp.evaluate('Boolean(window.toccata?.invoke && document.querySelector("#main h1"))'), 10000, 'page ready');
    return {proc,done,cdp,getOutput:()=>output};
  } catch (e) { if(!exited) proc.kill(); await timeout(done,3000); throw e; }
}

test('login command stays hidden, manual open shows it, and no login setting is written', {timeout:40000}, async t => {
  assert.ok(fs.existsSync(executable), 'Electron dependency missing');
  const dir = fs.mkdtempSync(path.join(workspace,'Toccata-login-qa-data-'));
  assert.equal(path.dirname(path.resolve(dir)),path.resolve(workspace));
  assert.ok(path.basename(dir).startsWith('Toccata-login-qa-data-'));
  let instance;
  t.after(async()=>{
    if(instance && instance.proc.exitCode===null){instance.proc.kill();await timeout(instance.done,3000);}
    if(instance)try{instance.cdp.close()}catch(_){}
    fs.rmSync(dir,{recursive:true,force:true});
  });
  instance = await launch(dir,true);
  assert.equal((await instance.cdp.evaluate('window.toccata.invoke("capture:status")')).state,'disabled');
  // Electron documents that document.visibilityState may incorrectly report
  // visible on initial load. The test launcher reads BrowserWindow.isVisible().
  const initial = await until(() => instance.getOutput().match(/QA_INITIAL_VISIBLE=(true|false)/), 5000, 'initial visibility');
  assert.equal(initial[1],'false','login launch unexpectedly showed main window');
  await instance.cdp.evaluate('window.toccata.invoke("app:open-main")');
  await until(()=>instance.getOutput().includes('QA_MAIN_SHOW'),5000,'manual open');
  // The unpackaged dev build rejects this IPC before touching the OS setting.
  await assert.rejects(()=>instance.cdp.evaluate('window.toccata.invoke("app:toggle-login",{enabled:true})'),/打包版/);
  try{await instance.cdp.evaluate("(()=>{window.toccata.invoke('app:quit').catch(()=>{});return true})()")}catch(_){}
  const exit = await timeout(instance.done,10000);
  assert.ok(exit,'Electron did not quit'); assert.equal(exit.code,0,instance.getOutput().slice(-2000));
  instance.cdp.close(); instance=null;
});
