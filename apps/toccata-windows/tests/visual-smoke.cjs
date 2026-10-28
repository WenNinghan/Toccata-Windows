'use strict';

// A real Electron visual smoke run. All tasks are synthetic, recording is
// disabled, and the temporary profile is created on G: in the project parent.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const project = path.resolve(__dirname, '..');
const workspace = path.resolve(project, '..', '..', '..');
const outputDir = path.join(workspace, 'Toccata-windows-qa-visual');
const electron = path.join(project, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(fn, ms, label) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await delay(100);
  }
  throw new Error(`${label} timed out${last ? `: ${last.message}` : ''}`);
}
async function timeout(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); })]); }
  finally { clearTimeout(timer); }
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.exceptions = [];
    ws.addEventListener('message', event => {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
      }
      if (!msg.id || !this.pending.has(msg.id)) return;
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    });
    ws.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('CDP closed'));
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
  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise:true, returnByValue:true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  close() { this.ws.close(); }
}

async function launch(dataDir) {
  const env = { ...process.env, TOCCATA_DATA_DIR:dataDir, TOCCATA_DISABLE_CAPTURE:'1' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.TOCCATA_QA_SCREENSHOT;
  const proc = spawn(electron, ['--remote-debugging-port=0', '--remote-allow-origins=*', '--disable-gpu', project], {
    cwd:project, env, stdio:['ignore','pipe','pipe'], windowsHide:true,
  });
  let output = '', exited = false, spawnError;
  proc.stdout.on('data', chunk => { output += chunk; });
  proc.stderr.on('data', chunk => { output += chunk; });
  proc.on('error', error => { spawnError = error; });
  const done = new Promise(resolve => proc.once('close', (code, signal) => { exited = true; resolve({code,signal}); }));
  try {
    const port = await until(() => {
      if (spawnError) throw spawnError;
      const match = output.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) return Number(match[1]);
      if (exited) throw new Error(`Electron exited early: ${output.slice(-2000)}`);
    }, 20000, 'DevTools startup');
    const target = await until(async () => {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      return targets.find(t => t.type === 'page' && t.url.startsWith('file:') &&
        t.url.includes('/renderer/index.html') && !t.url.includes('?view=tray') && t.webSocketDebuggerUrl);
    }, 15000, 'main renderer');
    const cdp = await CDP.connect(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await until(() => cdp.evaluate('Boolean(window.toccata && window.toccata.invoke && document.querySelector("#main"))'), 10000, 'preload bridge');
    return { proc, cdp, done, getOutput:() => output };
  } catch (error) {
    if (!exited) proc.kill();
    await timeout(done, 3000);
    throw error;
  }
}

async function invoke(cdp, channel, payload = {}) {
  return cdp.evaluate(`window.toccata.invoke(${JSON.stringify(channel)},${JSON.stringify(payload)})`);
}

test('six real Electron pages render and export screenshots with capture disabled', { timeout:60000 }, async t => {
  assert.ok(fs.existsSync(electron), 'Electron dependency missing');
  fs.mkdirSync(outputDir, { recursive:true });
  const dataDir = fs.mkdtempSync(path.join(workspace, 'Toccata-visual-qa-data-'));
  assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(workspace));
  assert.ok(path.basename(dataDir).startsWith('Toccata-visual-qa-data-'));
  let instance;
  t.after(async () => {
    if (instance) {
      try { instance.cdp.close(); } catch (_) {}
      instance.proc.kill();
      await timeout(instance.done, 3000);
    }
    // Only remove the freshly created test profile, never the shared workspace.
    fs.rmSync(dataDir, { recursive:true, force:true });
  });
  instance = await launch(dataDir);
  const { cdp } = instance;
  assert.equal((await invoke(cdp, 'capture:status')).state, 'disabled');
  assert.deepEqual((await invoke(cdp, 'tasks:list')).tasks, []);
  const parent = await invoke(cdp, 'tasks:create', {
    title:'整理研究资料', details:'## 研究计划\n\n- 阅读论文\n- 整理思路', planned_at:Date.now()/1000,
  });
  await invoke(cdp, 'tasks:create', { title:'标记关键文献', parent_id:parent.id });
  const complete = await invoke(cdp, 'tasks:create', { title:'完成阅读笔记' });
  await invoke(cdp, 'tasks:toggle', { id:complete.id });
  await until(() => cdp.evaluate('document.querySelector("#main")?.innerText.includes("整理研究资料")'), 10000, 'synthetic tasks');

  const pages = [
    { id:'tasks', name:'01-任务.png', expected:'任务' },
    { id:'inbox', name:'02-收集箱.png', expected:'收集箱' },
    { id:'calendar', name:'03-任务日历.png', expected:'任务日历' },
    { id:'review', name:'04-任务回顾.png', expected:'任务回顾' },
    { id:'activity', name:'05-键盘活跃.png', expected:'键盘活跃' },
    { id:'ranking', name:'06-应用与趋势.png', expected:'应用活跃度' },
  ];
  for (const page of pages) {
    await cdp.evaluate(`document.querySelector(${JSON.stringify(`[data-page="${page.id}"]`)}).click()`);
    await until(() => cdp.evaluate(`document.querySelector('#main')?.innerText.includes(${JSON.stringify(page.expected)})`), 10000, `${page.id} rendered`);
    if (page.id === 'tasks') {
      await until(() => cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify(`[data-action="select"][data-id="${parent.id}"]`)}))`), 5000, 'synthetic task row');
      await cdp.evaluate(`document.querySelector(${JSON.stringify(`[data-action="select"][data-id="${parent.id}"]`)}).click()`);
      await until(() => cdp.evaluate('Boolean(document.querySelector("#detail-title"))'), 5000, 'task detail');
    }
    await delay(500);
    const state = await cdp.evaluate('({text:document.querySelector("#main")?.innerText, error:document.querySelector(".error-banner")?.innerText || null, selected:document.querySelector("[data-page].selected")?.dataset.page})');
    assert.equal(state.selected, page.id);
    assert.equal(state.error, null, `${page.id}: ${state.error}`);
    assert.ok(state.text.includes(page.expected));
    const screenshot = await cdp.send('Page.captureScreenshot', { format:'png', captureBeyondViewport:false, fromSurface:true });
    const bytes = Buffer.from(screenshot.data, 'base64');
    assert.ok(bytes.length > 5000, `${page.id}: screenshot unexpectedly small`);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    fs.writeFileSync(path.join(outputDir, page.name), bytes);
  }
  assert.deepEqual(cdp.exceptions, []);
  try { await cdp.evaluate("(()=>{window.toccata.invoke('app:quit').catch(()=>{});return true})()"); } catch (_) {}
  const exit = await timeout(instance.done, 8000);
  assert.ok(exit, 'Electron did not exit after quit');
  assert.equal(exit.code, 0, instance.getOutput().slice(-2000));
  cdp.close();
  instance = null;
});
