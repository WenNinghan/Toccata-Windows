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



async function click(c, selector){await c.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});e.click();return true})()`)}
async function change(c,selector,value){await c.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)}
async function send(c,method,params){const id=++c.next;return new Promise((resolve,reject)=>{c.pending.set(id,{resolve,reject});c.ws.send(JSON.stringify({id,method,params}))})}
async function screenshot(c,file){const result=await send(c,'Page.captureScreenshot',{format:'png'});fs.writeFileSync(file,Buffer.from(result.data,'base64'))}
test('real Electron keyboard preset and custom editing, failure and restart', {timeout:60000}, async t=>{
 const fix=fixture(t);fix.current=await launch(fix.dataDir);let c=fix.current.main;
 await click(c,'[data-page="activity"]');
 await until(()=>c.evaluate(`Boolean(document.querySelector('#keyboard-layout'))`),10000,'layout selection');
 assert.equal(await c.evaluate(`document.querySelectorAll('.keyboard [data-key]').length`),104);
 await send(c,'Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 assert.equal(await c.evaluate(`getComputedStyle(document.querySelector('.keyboard .key')).transitionDuration`),'0s');
 await send(c,'Emulation.setEmulatedMedia',{features:[]});
 const originalWidth=await c.evaluate(`document.querySelector('.keyboard [data-key="0"]').getBoundingClientRect().width`);
 for(const [id,count] of [['windows-80-87',87],['windows-75-percent',84],['windows-65-68',68]]){
   await change(c,'#keyboard-layout',id);
   await until(()=>c.evaluate(`document.querySelectorAll('.keyboard [data-key]').length===${count}`),10000,`${count}-key preset`);
   const box=await c.evaluate(`({width:document.querySelector('.keyboard [data-key="0"]').getBoundingClientRect().width,ratio:getComputedStyle(document.querySelector('.keyboard')).aspectRatio,keys:window.ToccataShareCard.keyboardGeometry(window.TOCCATA_LAYOUT).keys.length})`);
   assert.ok(box.width>=originalWidth,`compact key should not shrink: ${box.width} < ${originalWidth}`);assert.equal(box.keys,count);
 }
 assert.equal((await invoke(c,'layout:get')).layout.id,'windows-65-68');
 await screenshot(c,'G:/DevTools/temp/toccata-layout-68.png');
 await click(c,'[data-action="share"]');
 await until(()=>c.evaluate(`Boolean(document.querySelector('#share-preview img'))`),10000,'compact share');
 await screenshot(c,'G:/DevTools/temp/toccata-layout-68-share.png');
 await click(c,'[data-action="close-dialog"]');
 await click(c,'[data-action="edit-layout"]');
 await until(()=>c.evaluate(`Boolean(document.querySelector('.layout-dialog'))`),10000,'layout editor');
 await screenshot(c,'G:/DevTools/temp/toccata-layout-editor.png');
 const original=await invoke(c,'layout:get');
 await change(c,'#layout-preset','windows-80-87');
 await until(()=>c.evaluate(`document.querySelectorAll('[data-layout-key]').length===87`),10000,'preview 87 keys');
 assert.equal((await invoke(c,'layout:get')).layout.id,original.layout.id,'preview must not write');
 await click(c,'[data-layout-action="reset"]');
 assert.equal(await c.evaluate(`document.querySelectorAll('[data-layout-key]').length`),68);
 const drag=await c.evaluate(`(()=>{const key=document.querySelector('[data-layout-key="53"]').getBoundingClientRect(),canvas=document.querySelector('.layout-canvas').getBoundingClientRect();return {fromX:key.x+key.width/2,fromY:key.y+key.height/2,toX:canvas.x+20.5/32*canvas.width,toY:canvas.y+6.5/10*canvas.height}})()`);
 await send(c,'Input.dispatchMouseEvent',{type:'mouseMoved',x:drag.fromX,y:drag.fromY});
 await send(c,'Input.dispatchMouseEvent',{type:'mousePressed',x:drag.fromX,y:drag.fromY,button:'left',buttons:1,clickCount:1});
 await send(c,'Input.dispatchMouseEvent',{type:'mouseMoved',x:drag.toX,y:drag.toY,button:'left',buttons:1});
 await send(c,'Input.dispatchMouseEvent',{type:'mouseReleased',x:drag.toX,y:drag.toY,button:'left',buttons:0,clickCount:1});
 await until(()=>c.evaluate(`document.querySelector('#layout-x')?.value==='20' && document.querySelector('#layout-y')?.value==='6'`),10000,'drag key');
 await change(c,'#layout-x','1');await change(c,'#layout-y','0');
 assert.match(await c.evaluate(`document.querySelector('.layout-error').textContent`),/重叠/);
 assert.equal(await c.evaluate(`document.querySelector('[data-layout-action="apply"]').disabled`),true);
 await click(c,'[data-layout-action="reset"]');
 await change(c,'#layout-add-key','63');await click(c,'[data-layout-action="add"]');
 assert.equal(await c.evaluate(`document.querySelector('.layout-key.selected').dataset.layoutKey`),'63');
 assert.match(await c.evaluate(`document.querySelector('.layout-note').textContent`),/不可检测/);
 await click(c,'[data-layout-action="remove"]');
 assert.equal(await c.evaluate(`document.querySelectorAll('[data-layout-key]').length`),68);
 await click(c,'[data-layout-action="add"]');
 assert.equal(await c.evaluate(`document.querySelectorAll('[data-layout-key]').length`),69);
 await change(c,'#layout-label','新增键');
 assert.equal(await c.evaluate(`document.querySelector('.layout-key.selected')?.textContent`),'新增键');
 await change(c,'#layout-x','24');await change(c,'#layout-y','6');await change(c,'#layout-w','1.25');
 const tempfile=path.join(fix.dataDir,'keyboard-layout.json.tmp');fs.mkdirSync(tempfile);
 try {
   await click(c,'[data-layout-action="apply"]');
   await until(()=>c.evaluate(`Boolean(document.querySelector('.layout-error')?.textContent)`),10000,'failed save');
   assert.equal(await c.evaluate(`document.querySelector('.layout-key.selected')?.textContent`),'新增键');
   assert.equal((await invoke(c,'layout:get')).layout.id,'windows-65-68');
 } finally {fs.rmdirSync(tempfile)}
 await c.evaluate(`(()=>{const e=document.querySelector('#layout-label');e.focus();e.select();return true})()`);
 await send(c,'Input.insertText',{text:'最终键'});
 const apply=await c.evaluate(`(()=>{const r=document.querySelector('[data-layout-action="apply"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
 await send(c,'Input.dispatchMouseEvent',{type:'mouseMoved',x:apply.x,y:apply.y});
 await send(c,'Input.dispatchMouseEvent',{type:'mousePressed',x:apply.x,y:apply.y,button:'left',buttons:1,clickCount:1});
 await send(c,'Input.dispatchMouseEvent',{type:'mouseReleased',x:apply.x,y:apply.y,button:'left',buttons:0,clickCount:1});
 await until(()=>c.evaluate(`!document.querySelector('.layout-dialog')`),10000,'apply after editing without extra click');
 const saved=(await invoke(c,'layout:get')).layout;
 assert.equal(saved.id,'custom');assert.equal(saved.keys.length,69);assert.ok(saved.keys.some(k=>k.label==='最终键'&&k.x===24&&k.y===6&&k.w===1.25));
 await until(()=>c.evaluate(`document.querySelectorAll('.keyboard [data-key]').length===69`),10000,'custom rendered');
 await click(c,'[data-action="edit-layout"]');await click(c,'[data-layout-action="remove"]');await click(c,'[data-layout-action="cancel"]');
 assert.equal((await invoke(c,'layout:get')).layout.keys.length,69,'cancel must not write');
 await exit(fix.current);fix.current=null;
 fix.current=await launch(fix.dataDir);c=fix.current.main;
 assert.equal((await invoke(c,'layout:get')).layout.keys.length,69);
 await click(c,'[data-page="activity"]');await until(()=>c.evaluate(`document.querySelectorAll('.keyboard [data-key]').length===69`),10000,'custom after restart');
 await exit(fix.current);fix.current=null;
});
