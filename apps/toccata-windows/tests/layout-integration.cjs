'use strict';
// Synthetic local database and real Electron IPC; physical capture is disabled.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const {KeyStore,mapWindowsKey}=require('../data/keyboard');
const project=path.resolve(__dirname,'..'), workspace=path.resolve(project,'..','..','..');
const exe=path.join(project,'node_modules','electron','dist','electron.exe');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function timeout(p,ms){let t;try{return await Promise.race([p,new Promise(r=>{t=setTimeout(()=>r(null),ms)})])}finally{clearTimeout(t)}}
async function until(fn,ms,label){const end=Date.now()+ms;let last;while(Date.now()<end){try{const x=await fn();if(x)return x}catch(e){last=e}await sleep(75)}throw new Error(`${label} timed out${last?`: ${last.message}`:''}`)}
class CDP{
 constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data),p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result)});ws.addEventListener('close',()=>{for(const p of this.pending.values())p.reject(new Error('CDP closed'));this.pending.clear()})}
 static async connect(url){const ws=new WebSocket(url),opened=await timeout(new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',()=>reject(new Error('CDP connection failed')),{once:true})}),5000);if(!opened)throw new Error('CDP timeout');return new CDP(ws)}
 async eval(expression){const id=++this.id,result=await new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}))});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value}
 close(){this.ws.close()}
}
async function launch(dir){
 const temp=path.join(dir,'temp');fs.mkdirSync(temp,{recursive:true});const env={...process.env,TOCCATA_DATA_DIR:dir,TOCCATA_DISABLE_CAPTURE:'1',TEMP:temp,TMP:temp};
 for(const k of ['ELECTRON_RUN_AS_NODE','TOCCATA_QA_SCREENSHOT','TOCCATA_QA_MEMORY','TOCCATA_QA_HELPER_EXE','TOCCATA_QA_HELPER_SCRIPT'])delete env[k];
 const proc=spawn(exe,['--remote-debugging-port=0','--remote-allow-origins=*','--disable-gpu',project],{cwd:project,env,stdio:['ignore','pipe','pipe'],windowsHide:true});let output='',exited=false;
 proc.stdout.on('data',b=>{output+=b});proc.stderr.on('data',b=>{output+=b});const done=new Promise(r=>proc.once('close',(code,signal)=>{exited=true;r({code,signal})}));
 try{const port=await until(()=>{const m=output.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/);if(m)return +m[1];if(exited)throw new Error('Electron exited')},20000,'startup');
 const page=await until(async()=>{const pages=await(await fetch(`http://127.0.0.1:${port}/json`)).json();return pages.find(p=>p.type==='page'&&p.url.includes('/renderer/index.html')&&!p.url.includes('?')&&p.webSocketDebuggerUrl)},10000,'main renderer');
 const cdp=await CDP.connect(page.webSocketDebuggerUrl);await until(()=>cdp.eval('Boolean(window.toccata?.invoke)'),10000,'preload bridge');return {proc,done,cdp,output:()=>output};
 }catch(e){if(!exited)proc.kill();await timeout(done,3000);throw e}
}
const invoke=(cdp,name,payload={})=>cdp.eval(`window.toccata.invoke(${JSON.stringify(name)},${JSON.stringify(payload)})`);
async function quit(x){try{await x.cdp.eval("(()=>{window.toccata.invoke('app:quit').catch(()=>{});return true})()") }catch(_){}const result=await timeout(x.done,10000);assert.ok(result,'graceful exit timed out');assert.equal(result.code,0,x.output().slice(-2000));x.cdp.close()}
function rows(file){const db=new DatabaseSync(file,{readOnly:true});try{return db.prepare('SELECT * FROM key_events ORDER BY event_id').all().map(x=>({...x}))}finally{db.close()}}

test('layout IPC validates, persists, and does not alter keyboard events',{timeout:60000},async t=>{
 assert.ok(fs.existsSync(exe));const dir=fs.mkdtempSync(path.join(workspace,'Toccata-layout-qa-'));const dbFile=path.join(dir,'toccata-windows.sqlite');
 const start=Date.now()-60000,store=new KeyStore(dbFile);
 try{for(const [id,scan,vkey,ts] of [['a',30,65,start],['s',31,83,start+1000]]){
  store.add({type:'key',event_id:`synthetic-${id}-down`,scan,ext:0,vkey,kind:'down',ts_ms:ts,app:null});
  store.add({type:'key',event_id:`synthetic-${id}-up`,scan,ext:0,vkey,kind:'up',ts_ms:ts+100,hold_ms:100,app:null});
 }store.flush()}finally{store.close()}
 const before=rows(dbFile),bounds={start_ms:start-1000,end_ms:start+30000};let x;
 t.after(async()=>{if(x&&x.proc.exitCode===null){x.proc.kill();await timeout(x.done,3000)}if(x)try{x.cdp.close()}catch(_){}});
 x=await launch(dir);assert.equal((await invoke(x.cdp,'capture:status')).state,'disabled');
 const initial=await invoke(x.cdp,'layout:get');assert.equal(initial.layout.id,'windows-100-104');assert.deepEqual(initial.presets.map(x=>x.key_count),[68,84,87,104]);
 const statsBefore=await invoke(x.cdp,'stats:query',bounds);assert.equal(statsBefore.key_count,2);assert.equal(statsBefore.keys['0'],1);assert.equal(statsBefore.keys['1'],1);
 let chosen;
 for(const preset of initial.presets){const candidate=await invoke(x.cdp,'layout:preset',{id:preset.id});const saved=await invoke(x.cdp,'layout:set',{layout:candidate});assert.equal(saved.layout.id,preset.id);assert.equal((await invoke(x.cdp,'layout:get')).layout.id,preset.id);chosen=saved.layout}
 const compact=await invoke(x.cdp,'layout:preset',{id:'windows-65-68'});chosen=(await invoke(x.cdp,'layout:set',{layout:compact})).layout;
 const duplicate=structuredClone(chosen);duplicate.keys[1].code=duplicate.keys[0].code;
 await assert.rejects(()=>invoke(x.cdp,'layout:set',{layout:duplicate}),/Duplicate/);assert.deepEqual((await invoke(x.cdp,'layout:get')).layout,chosen);
 const overlap=structuredClone(chosen);overlap.keys[1].x=overlap.keys[0].x;overlap.keys[1].y=overlap.keys[0].y;
 await assert.rejects(()=>invoke(x.cdp,'layout:set',{layout:overlap}),/Overlapping/);assert.deepEqual((await invoke(x.cdp,'layout:get')).layout,chosen);
 const withReserved=structuredClone(chosen);withReserved.id='synthetic-reserved';withReserved.keys.push({code:63,label:'Fn',x:25,y:0,w:1,h:1,unavailable:false},{code:1581,label:'Pause',x:26,y:0,w:1,h:1,unavailable:false});
 chosen=(await invoke(x.cdp,'layout:set',{layout:withReserved})).layout;
 assert.equal(chosen.keys.find(k=>k.code===63).unavailable,true);assert.equal(chosen.keys.find(k=>k.code===1581).unavailable,true);
 for(let scan=0;scan<256;scan++)for(const ext of [0,2,4]){assert.notEqual(mapWindowsKey(scan,ext),63);assert.notEqual(mapWindowsKey(scan,ext),1581)}
 const statsAfter=await invoke(x.cdp,'stats:query',bounds);assert.deepEqual(statsAfter,statsBefore);assert.deepEqual(rows(dbFile),before);
 await quit(x);x=null;x=await launch(dir);assert.equal((await invoke(x.cdp,'capture:status')).state,'disabled');
 assert.deepEqual((await invoke(x.cdp,'layout:get')).layout,chosen);assert.deepEqual(await invoke(x.cdp,'stats:query',bounds),statsBefore);assert.deepEqual(rows(dbFile),before);
 await quit(x);x=null;t.diagnostic(`Synthetic profile retained: ${dir}`);
});
