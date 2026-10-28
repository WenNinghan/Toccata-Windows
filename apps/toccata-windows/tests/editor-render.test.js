'use strict';

// End-to-end pending-edit tests with synthetic data. Every Electron profile and
// temporary directory is created on G:, and keyboard capture is disabled.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const project = path.resolve(__dirname, '..');
const workspace = 'G:\\DevTools\\temp';
const executable = path.join(project, 'node_modules', 'electron', 'dist', 'electron.exe');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function timeout(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); })]); }
  finally { clearTimeout(timer); }
}
async function until(fn, ms, label) {
  const end = Date.now() + ms;
  let lastError;
  while (Date.now() < end) {
    try { const result = await fn(); if (result) return result; } catch (error) { lastError = error; }
    await delay(75);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}
class CDP {
  constructor(ws) {
    this.ws = ws; this.next = 0; this.pending = new Map();
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data), request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
    });
    ws.addEventListener('close', () => {
      for (const request of this.pending.values()) request.reject(new Error('CDP connection closed'));
      this.pending.clear();
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    const opened = await timeout(new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once:true });
      ws.addEventListener('error', () => reject(new Error('CDP connection failed')), { once:true });
    }), 5000);
    if (!opened) throw new Error('CDP connection timeout');
    return new CDP(ws);
  }
  async evaluate(expression) {
    const id = ++this.next;
    const value = await new Promise((resolve, reject) => {
      this.pending.set(id, {resolve,reject});
      this.ws.send(JSON.stringify({ id, method:'Runtime.evaluate', params:{ expression, awaitPromise:true, returnByValue:true } }));
    });
    if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
    return value.result.value;
  }
  close() { this.ws.close(); }
}
async function launch(dataDir) {
  const tempDir = path.join(dataDir, 'temp');
  fs.mkdirSync(tempDir, { recursive:true });
  const env = { ...process.env, TOCCATA_DATA_DIR:dataDir, TOCCATA_DISABLE_CAPTURE:'1', TEMP:tempDir, TMP:tempDir };
  delete env.ELECTRON_RUN_AS_NODE; delete env.TOCCATA_QA_SCREENSHOT; delete env.TOCCATA_QA_MEMORY;
  const proc = spawn(executable, ['--remote-debugging-port=0','--remote-allow-origins=*','--disable-gpu',project], {
    cwd:project, env, stdio:['ignore','pipe','pipe'], windowsHide:true,
  });
  let output = '', exited = false, spawnError;
  proc.stdout.on('data', bytes => { output += bytes; });
  proc.stderr.on('data', bytes => { output += bytes; });
  proc.on('error', error => { spawnError = error; });
  const done = new Promise(resolve => proc.once('close', (code, signal) => { exited = true; resolve({code,signal}); }));
  try {
    const port = await until(() => {
      if (spawnError) throw spawnError;
      const match = output.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) return Number(match[1]);
      if (exited) throw new Error('Electron exited during startup');
    }, 20000, 'Electron startup');
    async function target(predicate) {
      return until(async () => {
        const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
        return pages.find(page => page.type === 'page' && page.webSocketDebuggerUrl && predicate(page.url));
      }, 10000, 'renderer target');
    }
    const main = await CDP.connect((await target(url => url.includes('/renderer/index.html') && !url.includes('?'))).webSocketDebuggerUrl);
    await until(() => main.evaluate('Boolean(window.toccata?.invoke && document.querySelector("#main h1"))'), 10000, 'main ready');
    assert.equal((await main.evaluate('window.toccata.invoke("capture:status")')).state, 'disabled');
    return { proc, done, port, main, target, getOutput:() => output };
  } catch (error) {
    if (!exited) proc.kill();
    await timeout(done, 3000);
    throw error;
  }
}
async function invoke(cdp, channel, payload = {}) {
  return cdp.evaluate(`window.toccata.invoke(${JSON.stringify(channel)}, ${JSON.stringify(payload)})`);
}
async function exit(instance) {
  let quitRequest;
  try { quitRequest = await timeout(instance.main.evaluate("(()=>{window.__quitState='pending';window.__quitFlush=0;window.toccata.on('flush-edits',()=>{window.__quitFlush++});window.toccata.invoke('app:quit').then(()=>{window.__quitState='ok'}).catch(e=>{window.__quitState='error:'+e.message});return true})()"), 1500); }
  catch (error) { quitRequest = error.message; }
  const result = await timeout(instance.done, 10000);
  if (!result) {
    const pages = await timeout(fetch(`http://127.0.0.1:${instance.port}/json`).then(x => x.json()), 1500) || [];
    const diagnostics = [];
    for (const page of pages.filter(x => x.url.includes('/renderer/index.html') && x.webSocketDebuggerUrl)) {
      try {
        const client = await CDP.connect(page.webSocketDebuggerUrl);
        diagnostics.push(await timeout(client.evaluate('({url:location.href,error:document.querySelector(".error-banner")?.innerText||null,title:document.querySelector("#detail-title")?.value||null,frame:document.querySelector("#details-frame")?.contentDocument?.readyState||null,quit:window.__quitState||null,flush:window.__quitFlush??null})'), 1500));
        client.close();
      } catch (error) { diagnostics.push(error.message); }
    }
    throw new Error(`Electron did not exit after flushing pending changes: ${JSON.stringify({quitRequest,exitCode:instance.proc.exitCode,signalCode:instance.proc.signalCode,diagnostics,output:instance.getOutput().slice(-3000)})}`);
  }
  assert.equal(result.code, 0, instance.getOutput().slice(-2000));
  instance.main.close();
}
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(workspace, 'Toccata-exit-qa-data-'));
  assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(workspace));
  assert.ok(path.basename(dataDir).startsWith('Toccata-exit-qa-data-'));
  let instance;
  t.after(async () => {
    if (instance && instance.proc.exitCode === null) {
      instance.proc.kill();
      await timeout(instance.done, 3000);
    }
    if (instance) try { instance.main.close(); } catch (_) {}
    // Retain synthetic isolated profile for inspection.
  });
  return { dataDir, set current(value) { instance = value; }, get current() { return instance; } };
}
async function editorReady(cdp) {
  await until(() => cdp.evaluate('Boolean(document.querySelector("#details-frame")?.contentDocument?.querySelector("#editor"))'), 10000, 'markdown editor');
  // setMarkdown() is called when the iframe load event arrives.
  await delay(150);
}
function quickEdits(title, body) {
  return `(()=>{const t=document.querySelector('#detail-title');t.value=${JSON.stringify(title)};t.dispatchEvent(new Event('input',{bubbles:true}));const f=document.querySelector('#details-frame'),e=f.contentDocument.querySelector('#editor');e.innerText=${JSON.stringify(body)};e.dispatchEvent(new f.contentWindow.Event('input',{bubbles:true}));return true})()`;
}


function editMarkdownAnd(action, value) {
 return `(()=>{const f=document.querySelector('#details-frame'),e=f.contentDocument.querySelector('#editor');window.__oldFrame=f;e.innerText=${JSON.stringify(value)};e.dispatchEvent(new f.contentWindow.Event('input',{bubbles:true}));${action};return true})()`;
}
async function waitDetails(cdp,id,text) {
 return until(async()=> (await invoke(cdp,'tasks:list')).tasks.find(x=>x.id===id)?.details===text, 10000, 'markdown persisted');
}

test('Markdown survives immediate list controls and failed saves retain editor', {timeout:60000}, async t=>{
 const fix=fixture(t); fix.current=await launch(fix.dataDir);const c=fix.current.main;
 const item=await invoke(c,'tasks:create',{title:'编辑测试任务',details:'旧内容'});
 const done=await invoke(c,'tasks:create',{title:'已完成任务'});
 await invoke(c,'tasks:toggle',{id:done.id});
 await until(()=>c.evaluate(`Boolean(document.querySelector(${JSON.stringify(`[data-action="select"][data-id="${item.id}"]`)}))`),10000,'task available');
 await c.evaluate(`document.querySelector(${JSON.stringify(`[data-action="select"][data-id="${item.id}"]`)}).click();true`);
 await editorReady(c);
 await c.evaluate(editMarkdownAnd("const x=document.querySelector('#display-mode');x.value='details';x.dispatchEvent(new Event('change',{bubbles:true}))",'模式切换未丢失'));
 await waitDetails(c,item.id,'模式切换未丢失');
 await until(()=>c.evaluate(`document.querySelector('#display-mode')?.value==='details'`),10000,'display mode');
 assert.equal(await c.evaluate(`document.querySelector('#details-frame')===window.__oldFrame`),true);

 await c.evaluate(editMarkdownAnd("const x=document.querySelector('#search');x.focus();x.value='编辑测试';x.setSelectionRange(1,3);x.dispatchEvent(new Event('input',{bubbles:true}));x.value='编辑测试任务';x.setSelectionRange(2,4);x.dispatchEvent(new Event('input',{bubbles:true}))",'搜索切换未丢失'));
 await waitDetails(c,item.id,'搜索切换未丢失');
 await until(()=>c.evaluate(`document.querySelector('#search')?.value==='编辑测试任务' && document.activeElement===document.querySelector('#search') && document.querySelector('#search').selectionStart===2 && document.querySelector('#search').selectionEnd===4`),10000,'search and selection');
 assert.equal(await c.evaluate(`document.querySelector('#details-frame')===window.__oldFrame`),true);

 const database=new DatabaseSync(path.join(fix.dataDir,'tasks.sqlite'));
 try {
  database.exec("CREATE TRIGGER reject_update BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT,'test write failure'); END");
  await c.evaluate(editMarkdownAnd("const x=document.querySelector('#display-mode');x.value='titles';x.dispatchEvent(new Event('change',{bubbles:true}))",'失败时保留的草稿'));
  await until(()=>c.evaluate(`document.querySelector('#save-status')?.textContent.includes('失败')`),10000,'failed save');
  assert.equal(await c.evaluate(`document.querySelector('#display-mode')?.value`),'details');
  assert.equal(await c.evaluate(`document.querySelector('#details-frame')===window.__oldFrame`),true);
  assert.equal(await c.evaluate(`document.querySelector('#details-frame').contentDocument.querySelector('#editor').innerText`),'失败时保留的草稿');
  await c.evaluate(`(()=>{const x=document.querySelector('#search');x.value='错误筛选';x.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  await until(()=>c.evaluate(`document.querySelector('#search')?.value==='编辑测试任务'`),10000,'search failure restores old filter');
  assert.equal(await c.evaluate(`document.querySelector('#details-frame')===window.__oldFrame`),true);
  database.exec('DROP TRIGGER reject_update');
 } finally { database.close(); }
 await c.evaluate(`(()=>{const x=document.querySelector('#display-mode');x.value='titles';x.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
 await waitDetails(c,item.id,'失败时保留的草稿');
 await until(()=>c.evaluate(`document.querySelector('#display-mode')?.value==='titles'`),10000,'display mode recovery');

 // Priority mutation performs another IPC before rendering; the current iframe must still be saved.
 await c.evaluate(editMarkdownAnd("const x=document.querySelector('#priority');x.value='2';x.dispatchEvent(new Event('change',{bubbles:true}))",'优先级切换未丢失'));
 await waitDetails(c,item.id,'优先级切换未丢失');
 await until(async()=>(await invoke(c,'tasks:list')).tasks.find(x=>x.id===item.id)?.priority===2,10000,'priority changed');
 await editorReady(c);
 await c.evaluate(editMarkdownAnd("const x=document.querySelector('#plan-date');x.value='2030-04-12';x.dispatchEvent(new Event('change',{bubbles:true}))",'日期切换未丢失'));
 await waitDetails(c,item.id,'日期切换未丢失');
 await until(async()=>(await invoke(c,'tasks:list')).tasks.find(x=>x.id===item.id)?.planned_at!=null,10000,'plan changed');
 await editorReady(c);
 await c.evaluate(`(()=>{const x=document.querySelector('#search');x.value='';x.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
 await until(()=>c.evaluate(`Boolean(document.querySelector('[data-action="show-completed"]'))`),10000,'completed group');
 await c.evaluate(editMarkdownAnd("document.querySelector('[data-action=show-completed]').click()",'折叠切换未丢失'));
 await waitDetails(c,item.id,'折叠切换未丢失');
 await editorReady(c);

 // A changed event from another window must flush the iframe before a refresh.
 await c.evaluate(editMarkdownAnd("window.toccata.invoke('tasks:create',{title:'外部更新'}).catch(()=>{})",'外部刷新未丢失'));
 await waitDetails(c,item.id,'外部刷新未丢失');
 await exit(fix.current);fix.current=null;
});
