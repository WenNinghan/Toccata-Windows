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
const workspace = path.resolve(project, '..', '..', '..');
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
    fs.rmSync(dataDir, { recursive:true, force:true });
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

test('no selected tasks exits and pending title + markdown survive immediate exit and restart', { timeout:50000 }, async t => {
  assert.ok(fs.existsSync(executable));
  const fix = fixture(t);
  fix.current = await launch(fix.dataDir);
  assert.deepEqual((await invoke(fix.current.main,'tasks:list')).tasks, []);
  await exit(fix.current); fix.current = null;

  fix.current = await launch(fix.dataDir);
  const task = await invoke(fix.current.main,'tasks:create',{title:'原始标题',details:'原始内容'});
  const selector = `[data-action="select"][data-id="${task.id}"]`;
  await until(() => fix.current.main.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), 10000, 'task row');
  await fix.current.main.evaluate(`document.querySelector(${JSON.stringify(selector)}).click();true`);
  await editorReady(fix.current.main);
  // Put the IPC request in the same JS turn: do not wait for 240/400 ms timers.
  try { await fix.current.main.evaluate(`${quickEdits('快速标题','快速 Markdown')} && (window.toccata.invoke('app:quit').catch(()=>{}),true)`); } catch (_) {}
  const result = await timeout(fix.current.done, 10000);
  assert.ok(result, 'rapid edit exit did not finish');
  assert.equal(result.code, 0, fix.current.getOutput().slice(-2000));
  fix.current.main.close(); fix.current = null;

  fix.current = await launch(fix.dataDir);
  const restored = (await invoke(fix.current.main,'tasks:list')).tasks.find(x => x.id === task.id);
  assert.ok(restored);
  assert.equal(restored.title, '快速标题');
  assert.equal(restored.details, '快速 Markdown');
  await exit(fix.current); fix.current = null;
});

test('floating editor flushes before switch; invalid title and DB failure prevent switching', { timeout:50000 }, async t => {
  const fix = fixture(t);
  fix.current = await launch(fix.dataDir);
  const first = await invoke(fix.current.main,'tasks:create',{title:'浮窗 A',details:'原内容'});
  const second = await invoke(fix.current.main,'tasks:create',{title:'浮窗 B'});
  await invoke(fix.current.main,'app:open-editor',{id:first.id});
  const page = await fix.current.target(url => url.includes('view=editor') && url.includes(first.id));
  const editor = await CDP.connect(page.webSocketDebuggerUrl);
  t.after(() => { try { editor.close(); } catch (_) {} });
  await until(() => editor.evaluate('Boolean(window.toccata?.invoke && document.querySelector("#detail-title"))'), 10000, 'floating editor');
  await editorReady(editor);

  await editor.evaluate(quickEdits('浮窗 A 修改','待保存详情'));
  // Invalid title must reject a switch and retain the same editor.
  await editor.evaluate("(()=>{const e=document.querySelector('#detail-title');e.value=' ';e.dispatchEvent(new Event('input',{bubbles:true}));return true})()");
  await assert.rejects(() => invoke(fix.current.main,'app:open-editor',{id:second.id}), /尚未保存/);
  assert.ok((await editor.evaluate('location.search')).includes(first.id));

  // Trigger a real SQLite update failure against the synthetic temporary DB.
  await editor.evaluate("(()=>{const e=document.querySelector('#detail-title');e.value='浮窗 A 修改';e.dispatchEvent(new Event('input',{bubbles:true}));return true})()");
  const database = new DatabaseSync(path.join(fix.dataDir,'tasks.sqlite'));
  try {
    database.exec("CREATE TRIGGER reject_update BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT,'test write failure'); END");
    await assert.rejects(() => invoke(fix.current.main,'app:open-editor',{id:second.id}), /尚未保存/);
    assert.ok((await editor.evaluate('location.search')).includes(first.id));
    database.exec('DROP TRIGGER reject_update');
  } finally { database.close(); }

  await invoke(fix.current.main,'app:open-editor',{id:second.id});
  await until(() => editor.evaluate(`location.search.includes(${JSON.stringify(second.id)})`), 10000, 'switch to second editor');
  if (process.env.TOCCATA_TEST_WAIT_EDITOR_READY === '1') await editorReady(editor);
  const restored = (await invoke(fix.current.main,'tasks:list')).tasks.find(x => x.id === first.id);
  assert.equal(restored.title, '浮窗 A 修改');
  assert.equal(restored.details, '待保存详情');
  editor.close();
  await exit(fix.current); fix.current = null;
});
