'use strict';

// Short real-helper lifecycle test. It does not send, read, or print key events.
// Keyboard DB is :memory:; every other profile/temp path is an isolated G: folder.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');

const execFileAsync = promisify(execFile);
const project = path.resolve(__dirname, '..');
const workspace = path.resolve(project, '..', '..', '..');
const electron = path.join(project, 'node_modules', 'electron', 'dist', 'electron.exe');
const helperPath = path.join(project, 'native', 'raw_input_helper.exe');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function timeout(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); })]); }
  finally { clearTimeout(timer); }
}
async function until(fn, ms, label) {
  const end = Date.now() + ms;
  let error;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (e) { error = e; }
    await delay(75);
  }
  throw new Error(`${label} timed out${error ? `: ${error.message}` : ''}`);
}

class CDP {
  constructor(socket) {
    this.socket = socket;
    this.id = 0;
    this.pending = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      // Ignore unsolicited events. Only explicit Runtime.evaluate replies are read.
      if (!message.id || !this.pending.has(message.id)) return;
      const item = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) item.reject(new Error(message.error.message));
      else item.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      for (const item of this.pending.values()) item.reject(new Error('CDP connection closed'));
      this.pending.clear();
    });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    const opened = await timeout(new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once:true });
      socket.addEventListener('error', () => reject(new Error('CDP connection error')), { once:true });
    }), 5000);
    if (!opened) throw new Error('CDP connection timeout');
    return new CDP(socket);
  }
  async evaluate(expression) {
    const id = ++this.id;
    const response = await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method:'Runtime.evaluate', params:{ expression, awaitPromise:true, returnByValue:true } }));
    });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  }
  close() { this.socket.close(); }
}

async function helperPid(parentPid) {
  assert.ok(Number.isInteger(parentPid) && parentPid > 0);
  const query = `Get-CimInstance -ClassName Win32_Process -Filter "ParentProcessId = ${parentPid} AND Name = 'raw_input_helper.exe'" | ForEach-Object { $_.ProcessId }`;
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], {
    timeout:5000, windowsHide:true,
  });
  const values = stdout.trim().split(/\s+/).filter(Boolean).map(Number);
  assert.ok(values.every(Number.isInteger), 'unexpected process enumeration result');
  if (values.length > 1) throw new Error('multiple helper children found');
  return values[0] || null;
}
function isRunning(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

test('real helper registers capture and exits without a keyboard database on disk', { timeout:40000 }, async t => {
  assert.equal(process.platform, 'win32', 'this is a Windows-only integration test');
  assert.ok(fs.existsSync(electron), 'Electron dependency missing');
  assert.ok(fs.existsSync(helperPath), 'native helper missing; run npm run build:native');
  const dataDir = fs.mkdtempSync(path.join(workspace, 'Toccata-capture-qa-data-'));
  const tempDir = path.join(dataDir, 'temp');
  fs.mkdirSync(tempDir);
  assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(workspace));
  assert.ok(path.basename(dataDir).startsWith('Toccata-capture-qa-data-'));
  const env = { ...process.env, TOCCATA_DATA_DIR:dataDir, TOCCATA_QA_MEMORY:'1', TEMP:tempDir, TMP:tempDir };
  delete env.TOCCATA_DISABLE_CAPTURE;
  delete env.TOCCATA_QA_SCREENSHOT;
  delete env.ELECTRON_RUN_AS_NODE;
  let cdp, pid;
  const proc = spawn(electron, ['--remote-debugging-port=0', '--remote-allow-origins=*', '--disable-gpu', project], {
    cwd:project, env, stdio:['ignore','pipe','pipe'], windowsHide:true,
  });
  let stderr = '', spawnError, didExit = false;
  // Only DevTools startup line is consumed; key event stdout belongs to the
  // helper's private pipe and is never read by this test.
  proc.stdout.resume();
  proc.stderr.on('data', chunk => { stderr += chunk; });
  proc.on('error', error => { spawnError = error; });
  const done = new Promise(resolve => proc.once('close', (code, signal) => { didExit = true; resolve({code,signal}); }));
  t.after(async () => {
    if (!didExit) {
      if (cdp) try { await timeout(cdp.evaluate("(()=>{window.toccata.invoke('app:quit').catch(()=>{});return true})()"), 1500); } catch (_) {}
      if (!await timeout(done, 4000)) {
        // Target only the Electron process this test spawned and its children.
        await execFileAsync('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide:true, timeout:5000 }).catch(() => {});
        await timeout(done, 3000);
      }
    }
    if (cdp) cdp.close();
    if (pid && isRunning(pid)) throw new Error('test helper still running after cleanup');
    fs.rmSync(dataDir, { recursive:true, force:true });
  });

  const port = await until(() => {
    if (spawnError) throw spawnError;
    const match = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
    if (match) return Number(match[1]);
    if (didExit) throw new Error('Electron exited before DevTools startup');
  }, 15000, 'DevTools startup');
  const target = await until(async () => {
    const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    return pages.find(page => page.type === 'page' && page.url.startsWith('file:') &&
      page.url.includes('/renderer/index.html') && !page.url.includes('?view=tray') && page.webSocketDebuggerUrl);
  }, 10000, 'main renderer');
  cdp = await CDP.connect(target.webSocketDebuggerUrl);
  const statusPromise = until(async () => {
    const state = await cdp.evaluate('window.toccata?.invoke("capture:status").then(x=>x.state)');
    if (state === 'error' || state === 'disabled' || state === 'storage-error') throw new Error(`capture state ${state}`);
    return state === 'active' ? state : null;
  }, 10000, 'active capture');
  const pidPromise = until(() => helperPid(proc.pid), 10000, 'helper process');
  const [state, helper] = await Promise.all([statusPromise, pidPromise]);
  pid = helper;
  assert.equal(state, 'active');
  assert.ok(isRunning(pid));
  assert.equal(fs.readdirSync(dataDir).some(name => /^toccata-windows\.sqlite(?:-|$)/.test(name)), false);

  // Stop immediately after the two lifecycle assertions; no synthetic keys.
  try { await timeout(cdp.evaluate("(()=>{window.toccata.invoke('app:quit').catch(()=>{});return true})()"), 1500); } catch (_) {}
  const exit = await timeout(done, 8000);
  assert.ok(exit, 'Electron did not quit');
  assert.equal(exit.code, 0, 'Electron exit status');
  await until(() => !isRunning(pid), 5000, 'helper exit');
  assert.equal(fs.readdirSync(dataDir).some(name => /^toccata-windows\.sqlite(?:-|$)/.test(name)), false);
  cdp.close(); cdp = null;
});
