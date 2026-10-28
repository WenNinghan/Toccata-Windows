'use strict';
// Actual BrowserWindow close and state regression, all data is synthetic and
// capture is disabled. TEMP/TMP and Electron userData live in the G: fixture.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const project=path.resolve(__dirname,'..'), workspace=path.resolve(project,'..','..','..');
const exe=path.join(project,'node_modules','electron','dist','electron.exe');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function timeout(p,ms){let timer;try{return await Promise.race([p,new Promise(r=>{timer=setTimeout(()=>r(null),ms)})])}finally{clearTimeout(timer)}}
async function until(fn,ms,label){const end=Date.now()+ms;let last;while(Date.now()<end){try{const x=await fn();if(x)return x}catch(e){last=e}await sleep(50)}throw new Error(`${label} timed out${last?`: ${last.message}`:''}`)}
class CDP {
 constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();ws.addEventListener('message',e=>{const x=JSON.parse(e.data),p=this.pending.get(x.id);if(!p)return;this.pending.delete(x.id);x.error?p.reject(new Error(x.error.message)):p.resolve(x.result)});ws.addEventListener('close',()=>{for(const p of this.pending.values())p.reject(new Error('CDP closed'));this.pending.clear()})}
 static async connect(url){const ws=new WebSocket(url);const opened=await timeout(new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',()=>reject(new Error('CDP error')),{once:true})}),5000);if(!opened)throw new Error('CDP timeout');return new CDP(ws)}
 async eval(expression){const id=++this.id,x=await new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}))});if(x.exceptionDetails)throw new Error(x.exceptionDetails.exception?.description||x.exceptionDetails.text);return x.result.value}
 close(){this.ws.close()}
}
async function launch(dir){
 const temp=path.join(dir,'temp');fs.mkdirSync(temp,{recursive:true});
 const env={...process.env,TOCCATA_DATA_DIR:dir,TOCCATA_DISABLE_CAPTURE:'1',TEMP:temp,TMP:temp};
 for(const key of ['ELECTRON_RUN_AS_NODE','TOCCATA_QA_SCREENSHOT','TOCCATA_QA_MEMORY','TOCCATA_QA_HELPER_EXE','TOCCATA_QA_HELPER_SCRIPT'])delete env[key];
 const proc=spawn(exe,['--remote-debugging-port=0','--remote-allow-origins=*','--disable-gpu',path.join(__dirname,'native-window-harness.cjs')],{cwd:project,env,stdio:['pipe','pipe','pipe'],windowsHide:true});
 let output='',exited=false,seq=0;
 proc.stdout.on('data',bytes=>{output+=bytes});
 proc.stderr.on('data',x=>{output+=x});const done=new Promise(r=>proc.once('close',(code,signal)=>{exited=true;r({code,signal})}));
 try{const port=await until(()=>{const m=output.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);if(m)return +m[1];if(exited)throw new Error('Electron exited');},20000,'startup');
 const page=await until(async()=>{const a=await(await fetch(`http://127.0.0.1:${port}/json`)).json();return a.find(x=>x.type==='page'&&x.url.includes('/renderer/index.html')&&!x.url.includes('?')&&x.webSocketDebuggerUrl)},10000,'main target');
 const cdp=await CDP.connect(page.webSocketDebuggerUrl);await until(()=>cdp.eval('Boolean(window.toccata?.invoke && document.querySelector("#main h1"))'),10000,'renderer ready');
 const control=async(op,fields={})=>{const id=++seq;await cdp.eval(`console.log(${JSON.stringify('QA_NATIVE_COMMAND ')}+${JSON.stringify(JSON.stringify({id,op,...fields}))});true`);const reply=await until(()=>cdp.eval(`window.__nativeReply?.id===${id}?window.__nativeReply:null`),5000,'native control '+op);if(reply.error)throw new Error(reply.error);return reply.result};
 return {proc,done,cdp,control,output:()=>output};
 }catch(e){if(!exited)proc.kill();await timeout(done,3000);throw e}
}
const invoke=(c,name,p={})=>c.eval(`window.toccata.invoke(${JSON.stringify(name)},${JSON.stringify(p)})`);
async function quit(x){try{await x.cdp.eval("(()=>{window.toccata.invoke('app:quit').catch(()=>{});return true})()") }catch(_){}const r=await timeout(x.done,10000);assert.ok(r,'quit timed out');assert.equal(r.code,0,x.output().slice(-1500));x.cdp.close()}

test('native window state and close flush pending edits to tray, survives restart',{timeout:60000},async t=>{
 assert.ok(fs.existsSync(exe));const dir=fs.mkdtempSync(path.join(workspace,'Toccata-native-window-qa-'));assert.equal(path.dirname(dir),workspace);
 let x;t.after(async()=>{if(x&&x.proc.exitCode===null){x.proc.kill();await timeout(x.done,3000)}if(x)try{x.cdp.close()}catch(_){}});
 x=await launch(dir);assert.equal((await invoke(x.cdp,'capture:status')).state,'disabled');
 const initial=await x.control('state');assert.equal(initial.frame,true,'main BrowserWindow must have its system frame enabled');
 await x.control('maximize');await until(async()=> (await x.control('state')).maximized,3000,'maximize');
 await x.control('unmaximize');await until(async()=> !(await x.control('state')).maximized,3000,'unmaximize');
 await x.control('minimize');await until(async()=> (await x.control('state')).minimized,3000,'minimize');
 await x.control('restore');await until(async()=> !(await x.control('state')).minimized,3000,'restore');
 const task=await invoke(x.cdp,'tasks:create',{title:'原始标题',details:'原始内容'}),sel=`[data-action="select"][data-id="${task.id}"]`;
 await until(()=>x.cdp.eval(`Boolean(document.querySelector(${JSON.stringify(sel)}))`),10000,'task row');await x.cdp.eval(`document.querySelector(${JSON.stringify(sel)}).click();true`);
 await until(()=>x.cdp.eval('Boolean(document.querySelector("#details-frame")?.contentDocument?.querySelector("#editor")?.textContent.includes("原始内容"))'),10000,'editor ready');
 const expression=`(()=>{const t=document.querySelector('#detail-title');t.value='关闭前标题';t.dispatchEvent(new Event('input',{bubbles:true}));const f=document.querySelector('#details-frame'),e=f.contentDocument.querySelector('#editor');e.innerText='关闭前 Markdown';e.dispatchEvent(new f.contentWindow.Event('input',{bubbles:true}));return true})()`;
 await x.control('edit-close',{expression});await until(async()=>!(await x.control('state')).visible,10000,'native close hides main');
 assert.equal(x.proc.exitCode,null,'process must remain alive in tray');
 let saved=(await invoke(x.cdp,'tasks:list')).tasks.find(t=>t.id===task.id);assert.equal(saved.title,'关闭前标题');assert.equal(saved.details,'关闭前 Markdown');
 await x.control('show');await until(async()=> (await x.control('state')).visible,3000,'show after hiding');
 await quit(x);x=null;
 x=await launch(dir);saved=(await invoke(x.cdp,'tasks:list')).tasks.find(t=>t.id===task.id);assert.ok(saved);assert.equal(saved.title,'关闭前标题');assert.equal(saved.details,'关闭前 Markdown');await quit(x);x=null;
 t.diagnostic(`Synthetic fixture retained at ${dir}`);
});

