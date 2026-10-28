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
const workspace = 'G:\\DevTools\\temp';
const electron = path.join(project,'node_modules','electron','dist','electron.exe');
const harness = path.join(__dirname,'synthetic-capture-harness.cjs');
const fakeHelper = path.join(__dirname,'keyboard-visual-helper.cjs');
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


test('live keyboard retains its DOM and uses aggregated held keys across devices', {timeout:30000}, async t=>{
 const dataDir=fs.mkdtempSync(path.join(workspace,'toccata-keyboard-live-'));let app;
 t.diagnostic(`Synthetic profile retained: ${dataDir}`);
 t.after(async()=>{if(app&&app.proc.exitCode===null){app.proc.kill();await timeout(app.done,3000)}if(app)try{app.cdp.close()}catch(_){}});
 app=await launch(dataDir,true);const c=app.cdp;
 await c.eval("document.querySelector('[data-page=activity]').click();true");
 await until(()=>c.eval(`Boolean(document.querySelector('.keyboard [data-key="0"]'))`),10000,'keyboard');
 await c.eval(`(()=>{window.__liveKey=document.querySelector('.keyboard [data-key="0"]');window.__keyEvents=[];window.__resets=[];window.toccata.on('key',x=>window.__keyEvents.push(x));window.toccata.on('capture-reset',x=>window.__resets.push(x));return true})()`);
 await until(()=>c.eval(`window.__keyEvents.length>=1 && window.__liveKey.classList.contains('pressed')`),10000,'first press');
 await until(()=>c.eval(`window.__keyEvents.length>=3`),10000,'second device remains down');
 assert.equal(await c.eval(`window.__liveKey===document.querySelector('.keyboard [data-key="0"]')`),true,'refresh must not replace key DOM');
 assert.equal(await c.eval(`window.__liveKey.classList.contains('pressed')`),true,'one device remains held');
 await until(()=>c.eval(`window.__resets.length>=1`),10000,'device reset');
 assert.equal(await c.eval(`window.__liveKey.classList.contains('pressed')`),true,'reset of another device preserves held key');
 await until(()=>c.eval(`window.__keyEvents.length>=4`),10000,'release');
 assert.equal(await c.eval(`window.__liveKey.classList.contains('pressed')`),false);
 assert.equal(await c.eval(`window.__liveKey===document.querySelector('.keyboard [data-key="0"]')`),true);
 // Check statistics only after the timed device fixture is finished, so added
 // assertions cannot delay or change the original press/reset/release checks.
 await c.eval(`(()=>{const original=window.ToccataShareCard;window.__rateSamples=[];window.ToccataShareCard=Object.freeze({...original,formatKeystrokeRate(stats,language,compact){const result=original.formatKeystrokeRate(stats,language,compact);window.__rateSamples.push({key_count:stats?.key_count,active_ms:stats?.active_ms,language,compact,result});return result}});return true})()`);
 await until(()=>c.eval(`(()=>{const values=[...document.querySelectorAll('.metrics .metric-value')];return window.__rateSamples.some(s=>s.compact&&s.key_count===2)&&values[1]?.textContent==='2'&&/^[\\d,]+ 次\\/分$/.test(values[2]?.textContent||'')&&/次\\/活跃分钟/.test(document.querySelector('.day-summary')?.textContent||'')})()`),10000,'live keystroke rate');
 const metrics=await c.eval(`(()=>{const cards=[...document.querySelectorAll('.metrics .metric')];return {title:cards[2].querySelector('.metric-title').textContent,value:cards[2].querySelector('.metric-value').textContent,daily:document.querySelector('.day-summary').textContent,sample:window.__rateSamples.filter(s=>s.compact).at(-1)}})()`);
 assert.equal(metrics.title,'平均击键频率');
 assert.ok(Number(metrics.value.replaceAll(',','').split(' ')[0])>0,'synthetic key events must update the rate from an unavailable value');
 assert.equal(metrics.value,`${Math.round(metrics.sample.key_count*60000/metrics.sample.active_ms).toLocaleString('zh-CN')} 次/分`,'live value must be calculated from the actual aggregate, not key count or wall-clock time alone');
 assert.doesNotMatch(metrics.daily,/Fn|不可用/);
 await closeApp(app);app=null;
});

test('empty activity rate renders consistently in Chinese and English without capture', {timeout:30000}, async t=>{
 const dataDir=fs.mkdtempSync(path.join(workspace,'toccata-rate-empty-'));let app;
 t.diagnostic(`Synthetic profile retained: ${dataDir}`);
 t.after(async()=>{if(app&&app.proc.exitCode===null){app.proc.kill();await timeout(app.done,3000)}if(app)try{app.cdp.close()}catch(_){}});
 app=await launch(dataDir,false);const c=app.cdp;
 await c.eval("document.querySelector('[data-page=activity]').click();true");
 await until(()=>c.eval("document.querySelectorAll('.metrics .metric-value').length===3"),10000,'empty activity metrics');
 const snapshot=()=>c.eval(`(()=>{const cards=[...document.querySelectorAll('.metrics .metric')];return {title:cards[2].querySelector('.metric-title').textContent,value:cards[2].querySelector('.metric-value').textContent,daily:document.querySelector('.day-summary')?.textContent||'',hint:document.querySelector('.metrics').textContent}})()`);
 const zh=await snapshot();
 assert.equal(zh.title,'平均击键频率');assert.equal(zh.value,'—');
 assert.match(zh.hint,/活跃分钟/);assert.match(zh.daily,/—/);assert.doesNotMatch(zh.daily,/Fn|不可用/);
 await c.eval("(()=>{const select=document.querySelector('#language');select.value='en';select.dispatchEvent(new Event('change',{bubbles:true}));return true})()");
 await until(async()=>((await snapshot()).title==='Keystroke rate'),10000,'English rate label');
 const en=await snapshot();
 assert.equal(en.value,'—');assert.match(en.hint,/active minute/);assert.match(en.daily,/—/);assert.doesNotMatch(en.daily,/Fn|Unavailable/);
 await closeApp(app);app=null;
});
