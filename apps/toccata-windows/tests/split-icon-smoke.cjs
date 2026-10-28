'use strict';

// Real Electron UI, synthetic app identity and synthetic events only. Input
// capture is disabled; the divider is moved with CDP synthetic mouse events.
const { test }=require('node:test');
const assert=require('node:assert/strict');
const { spawn }=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const { AppIdentities }=require('../data/app-identities');
const { KeyStore }=require('../data/keyboard');

const project=path.resolve(__dirname,'..'),workspace=path.resolve(project,'..','..','..');
const executable=path.join(project,'node_modules','electron','dist','electron.exe');
const outputDir=path.join(workspace,'Toccata-windows-qa-visual');
// Distinctive 32px synthetic icon so the resulting visual proof is inspectable.
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAVElEQVR4nGMUS3n5n2EAAdNAWj7qgNEQGBQhwIJP8mWxPVUsEe89OHhDgGnUAQyjDhhgwDTqAIZRBwwwYBp1AMOoA0a6AxhHOyYMow4YYMA04h0AAAAxCAUkH5ziAAAAAElFTkSuQmCC','base64');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function timeout(promise,ms){let timer;try{return await Promise.race([promise,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),ms)})])}finally{clearTimeout(timer)}}
async function until(fn,ms,label){const end=Date.now()+ms;let last;while(Date.now()<end){try{const value=await fn();if(value)return value}catch(e){last=e}await delay(75)}throw new Error(`${label} timed out${last?`: ${last.message}`:''}`)}
class CDP{
 constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data),p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);if(m.error)p.reject(new Error(m.error.message));else p.resolve(m.result)});ws.addEventListener('close',()=>{for(const p of this.pending.values())p.reject(new Error('CDP closed'));this.pending.clear()})}
 static async connect(url){const ws=new WebSocket(url),ok=await timeout(new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',()=>reject(new Error('CDP connection failed')),{once:true})}),5000);if(!ok)throw new Error('CDP timeout');return new CDP(ws)}
 send(method,params={}){const id=++this.id;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}))})}
 async eval(expression){const r=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value}
 close(){this.ws.close()}
}
async function launch(dataDir){
 const tmp=path.join(dataDir,'temp');fs.mkdirSync(tmp,{recursive:true});const env={...process.env,TOCCATA_DATA_DIR:dataDir,TOCCATA_DISABLE_CAPTURE:'1',TEMP:tmp,TMP:tmp};
 delete env.ELECTRON_RUN_AS_NODE;delete env.TOCCATA_QA_SCREENSHOT;delete env.TOCCATA_QA_MEMORY;delete env.TOCCATA_QA_HELPER_EXE;delete env.TOCCATA_QA_HELPER_SCRIPT;
 const proc=spawn(executable,['--remote-debugging-port=0','--remote-allow-origins=*','--disable-gpu',project],{cwd:project,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
 let output='',exited=false,spawnError;proc.stdout.on('data',x=>{output+=x});proc.stderr.on('data',x=>{output+=x});proc.on('error',e=>{spawnError=e});
 const done=new Promise(resolve=>proc.once('close',(code,signal)=>{exited=true;resolve({code,signal})}));
 try{const port=await until(()=>{if(spawnError)throw spawnError;const m=output.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);if(m)return Number(m[1]);if(exited)throw new Error('Electron exited')},20000,'startup');
 const target=await until(async()=>{const pages=await(await fetch(`http://127.0.0.1:${port}/json`)).json();return pages.find(p=>p.type==='page'&&p.url.includes('/renderer/index.html')&&!p.url.includes('?')&&p.webSocketDebuggerUrl)},10000,'main page');
 const cdp=await CDP.connect(target.webSocketDebuggerUrl);await until(()=>cdp.eval('Boolean(window.toccata?.invoke && document.querySelector("#workspace-divider"))'),10000,'workspace');
 return{proc,done,cdp,getOutput:()=>output}}catch(error){if(!exited)proc.kill();await timeout(done,3000);throw error}
}
async function invoke(cdp,name,payload={}){return cdp.eval(`window.toccata.invoke(${JSON.stringify(name)},${JSON.stringify(payload)})`)}
async function closeApp(instance){try{await instance.cdp.eval("(()=>{window.toccata.invoke('app:quit').catch(()=>{});return true})()")}catch(_){}const result=await timeout(instance.done,10000);assert.ok(result,'Electron failed to quit');assert.equal(result.code,0,instance.getOutput().slice(-2000));instance.cdp.close()}

test('divider drag persists across restart and synthetic app icon renders', {timeout:40000},async t=>{
 assert.ok(fs.existsSync(executable));const dir=fs.mkdtempSync(path.join(workspace,'Toccata-split-icon-qa-data-'));
 assert.equal(path.dirname(path.resolve(dir)),path.resolve(workspace));assert.ok(path.basename(dir).startsWith('Toccata-split-icon-qa-data-'));
 let instance;t.after(async()=>{if(instance&&instance.proc.exitCode===null){instance.proc.kill();await timeout(instance.done,3000)}if(instance)try{instance.cdp.close()}catch(_){}fs.rmSync(dir,{recursive:true,force:true})});
 // Seed only invented application identity, icon, and two key events.
 const identities=new AppIdentities(dir), app=identities.identify('G:\\SyntheticQA\\demo.exe','demo.exe');
 identities.setIcon(app.id,PNG);identities.close();
 const keys=new KeyStore(path.join(dir,'toccata-windows.sqlite'));
 const ts=Date.now()-10000;
 for(const [event_id,kind,time,hold_ms] of [['qa:1','down',ts,null],['qa:2','up',ts+100,100]])
   keys.add({type:'key',event_id,ts_ms:time,kind,hold_ms,app:app.id,scan:30,ext:0,vkey:65});
 keys.close();

 instance=await launch(dir);assert.equal((await invoke(instance.cdp,'capture:status')).state,'disabled');
 const start=await instance.cdp.eval(`(()=>{const d=document.querySelector('#workspace-divider').getBoundingClientRect(),l=document.querySelector('#left').getBoundingClientRect();return {x:d.x+d.width/2,y:d.y+d.height/2,width:l.width}})()`);
 assert.ok(start.width>0);
 await instance.cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:start.x,y:start.y});
 await instance.cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:start.x,y:start.y,button:'left',buttons:1,clickCount:1});
 await instance.cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:start.x+100,y:start.y,button:'left',buttons:1});
 await instance.cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:start.x+100,y:start.y,button:'left',buttons:0,clickCount:1});
 const moved=await until(async()=>{const width=await instance.cdp.eval('document.querySelector("#left").getBoundingClientRect().width');return width>start.width+70&&width},5000,'divider move');
 const ratio=await until(async()=>{const s=await invoke(instance.cdp,'settings:get');return s.splitRatio>0.5&&s.splitRatio},5000,'split settings persistence');
 await closeApp(instance);instance=null;

 instance=await launch(dir);const saved=await invoke(instance.cdp,'settings:get');assert.ok(Math.abs(saved.splitRatio-ratio)<0.0001);
 const reopened=await until(async()=>{const width=await instance.cdp.eval('document.querySelector("#left").getBoundingClientRect().width');return width>start.width+70&&width},5000,'restored divider');
 assert.ok(Math.abs(reopened-moved)<2,`restored width ${reopened} differs from ${moved}`);
 t.diagnostic(`Synthetic drag: ${start.width.toFixed(1)}px to ${moved.toFixed(1)}px; after restart ${reopened.toFixed(1)}px; saved ratio ${ratio.toFixed(4)}`);
 await instance.cdp.eval("document.querySelector('[data-page=ranking]').click();true");
 const icon=await until(()=>instance.cdp.eval(`(()=>{const img=document.querySelector('.app-row .app-image'),row=document.querySelector('.app-row');if(!img||!img.complete||!img.naturalWidth)return null;const r=img.getBoundingClientRect(),s=getComputedStyle(img);return {name:row.innerText,src:img.getAttribute('src'),width:r.width,height:r.height,display:s.display}})()`),10000,'decoded app icon');
 assert.ok(icon.name.includes('demo.exe'));assert.ok(icon.src.startsWith('data:image/png;base64,'));assert.ok(icon.width>0&&icon.height>0&&icon.display!=='none');
 await instance.cdp.send('Page.enable');const png=await instance.cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,fromSurface:true});
 const bytes=Buffer.from(png.data,'base64');assert.ok(bytes.length>5000);fs.mkdirSync(outputDir,{recursive:true});fs.writeFileSync(path.join(outputDir,'07-应用图标.png'),bytes);
 await closeApp(instance);instance=null;
});
