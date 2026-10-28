'use strict';

// Real Electron renderer under forced 150% scale, 900x600 DIP, dark theme.
// Only synthetic tasks are used; collection is disabled and all state is on G:.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const project=path.resolve(__dirname,'..'),workspace=path.resolve(project,'..','..','..');
const electron=path.join(project,'node_modules','electron','dist','electron.exe');
const outputDir=path.join(workspace,'Toccata-windows-qa-visual');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function timeout(p,ms){let timer;try{return await Promise.race([p,new Promise(r=>{timer=setTimeout(()=>r(null),ms)})])}finally{clearTimeout(timer)}}
async function until(fn,ms,label){const end=Date.now()+ms;let last;while(Date.now()<end){try{const v=await fn();if(v)return v}catch(e){last=e}await sleep(75)}throw new Error(`${label} timeout${last?`: ${last.message}`:''}`)}
function contrast(foreground,background){const rgb=s=>{const m=/^#([0-9a-f]{6})$/i.exec(s);if(m)return [0,2,4].map(i=>parseInt(m[1].slice(i,i+2),16));const n=/rgba?\(([^)]+)\)/.exec(s);return n?n[1].split(',').slice(0,3).map(Number):null};const luminance=c=>{const a=c.map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return .2126*a[0]+.7152*a[1]+.0722*a[2]};const f=rgb(foreground),b=rgb(background);if(!f||!b)throw new Error('Unexpected editor colors');const x=luminance(f),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)}
class CDP{
 constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();this.exceptions=[];ws.addEventListener('message',e=>{const x=JSON.parse(e.data);if(x.method==='Runtime.exceptionThrown')this.exceptions.push(x.params.exceptionDetails.exception?.description||x.params.exceptionDetails.text);const p=this.pending.get(x.id);if(!p)return;this.pending.delete(x.id);if(x.error)p.reject(new Error(x.error.message));else p.resolve(x.result)});ws.addEventListener('close',()=>{for(const p of this.pending.values())p.reject(new Error('CDP closed'));this.pending.clear()})}
 static async connect(url){const ws=new WebSocket(url),ok=await timeout(new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',()=>reject(new Error('CDP failed')),{once:true})}),5000);if(!ok)throw new Error('CDP timeout');return new CDP(ws)}
 send(method,params={}){const id=++this.id;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}))})}
 async eval(expression){const x=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(x.exceptionDetails)throw new Error(x.exceptionDetails.exception?.description||x.exceptionDetails.text);return x.result.value}
 close(){this.ws.close()}
}
async function launch(dir){const temp=path.join(dir,'temp');fs.mkdirSync(temp,{recursive:true});const env={...process.env,TOCCATA_DATA_DIR:dir,TOCCATA_DISABLE_CAPTURE:'1',TEMP:temp,TMP:temp};
 delete env.ELECTRON_RUN_AS_NODE;delete env.TOCCATA_QA_SCREENSHOT;delete env.TOCCATA_QA_MEMORY;delete env.TOCCATA_QA_HELPER_EXE;delete env.TOCCATA_QA_HELPER_SCRIPT;
 const proc=spawn(electron,['--remote-debugging-port=0','--remote-allow-origins=*','--disable-gpu','--force-device-scale-factor=1.5',path.join(__dirname,'dpi-harness.cjs')],{cwd:project,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
 let output='',exited=false,error;proc.stdout.on('data',b=>{output+=b});proc.stderr.on('data',b=>{output+=b});proc.on('error',e=>{error=e});const done=new Promise(r=>proc.once('close',(code,signal)=>{exited=true;r({code,signal})}));
 try{const port=await until(()=>{if(error)throw error;const m=output.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);if(m)return Number(m[1]);if(exited)throw new Error('Electron exited')},20000,'startup');
 const page=await until(async()=>{const targets=await(await fetch(`http://127.0.0.1:${port}/json`)).json();return targets.find(x=>x.type==='page'&&x.url.includes('/renderer/index.html')&&!x.url.includes('?')&&x.webSocketDebuggerUrl)},10000,'main page');
 const cdp=await CDP.connect(page.webSocketDebuggerUrl);await cdp.send('Runtime.enable');await cdp.send('Page.enable');await until(()=>cdp.eval('Boolean(window.toccata?.invoke && document.querySelector("#main h1"))'),10000,'renderer');return{proc,done,cdp,getOutput:()=>output}}
 catch(e){if(!exited)proc.kill();await timeout(done,3000);throw e}}
async function invoke(cdp,name,payload={}){return cdp.eval(`window.toccata.invoke(${JSON.stringify(name)},${JSON.stringify(payload)})`)}

test('150% DPI narrow dark UI renders six pages and legible markdown', {timeout:60000},async t=>{
 assert.ok(fs.existsSync(electron));const dir=fs.mkdtempSync(path.join(workspace,'Toccata-dpi-qa-data-'));
 assert.equal(path.dirname(path.resolve(dir)),path.resolve(workspace));assert.ok(path.basename(dir).startsWith('Toccata-dpi-qa-data-'));
 let instance;t.after(async()=>{if(instance&&instance.proc.exitCode===null){instance.proc.kill();await timeout(instance.done,3000)}if(instance)try{instance.cdp.close()}catch(_){}fs.rmSync(dir,{recursive:true,force:true})});
 fs.mkdirSync(outputDir,{recursive:true});instance=await launch(dir);const cdp=instance.cdp;
 assert.equal((await invoke(cdp,'capture:status')).state,'disabled');
 await until(()=>cdp.eval('innerWidth<=910 && innerHeight<=610'),5000,'narrow resize');
 const geometry=await cdp.eval('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})');
 assert.ok(geometry.dpr>=1.4,`Expected forced high DPI, got ${geometry.dpr}`);
 t.diagnostic(`Renderer ${geometry.width}x${geometry.height} CSS pixels at DPR ${geometry.dpr}`);
 await invoke(cdp,'settings:set',{key:'theme',value:'dark'});
 await until(()=>cdp.eval("document.documentElement.dataset.theme==='dark'"),5000,'dark theme');
 const task=await invoke(cdp,'tasks:create',{title:'高 DPI 测试任务',details:'## 可读的编辑内容\n\n这是一段中文和 English 用于查看深色模式。'});
 await until(()=>cdp.eval(`Boolean(document.querySelector(${JSON.stringify(`[data-action="select"][data-id="${task.id}"]`)}))`),10000,'task row');
 const pages=[['tasks','任务'],['inbox','收集箱'],['calendar','任务日历'],['review','任务回顾'],['activity','键盘活跃'],['ranking','应用活跃度']];
 const clipped=[], readability=[], contrastChecks=[];
 for(let i=0;i<pages.length;i++){
  const [id,title]=pages[i];await cdp.eval(`document.querySelector(${JSON.stringify(`[data-page="${id}"]`)}).click();true`);
  await until(()=>cdp.eval(`document.querySelector('#main')?.innerText.includes(${JSON.stringify(title)})`),10000,`${id} rendering`);
  if(id==='tasks'){
   const selector=`[data-action="select"][data-id="${task.id}"]`;
   await until(()=>cdp.eval(`Boolean(document.querySelector(${JSON.stringify(selector)}))`),5000,'task row');
   await cdp.eval(`document.querySelector(${JSON.stringify(selector)}).click();true`);
   await until(()=>cdp.eval('Boolean(document.querySelector("#details-frame")?.contentDocument?.querySelector("#editor")?.textContent.includes("可读的编辑内容"))'),10000,'markdown');
  }
  await sleep(350);
  const metrics=await cdp.eval(`(()=>{const main=document.querySelector('#main'),issues=[],contrast=[];
   const rgb=x=>{const m=x.match(/rgba?\\(([^)]+)\\)/);return m?m[1].split(',').slice(0,3).map(Number):null};
   const light=c=>{const x=c.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return .2126*x[0]+.7152*x[1]+.0722*x[2]};
   const check=(label,fg,bg)=>{const f=rgb(fg),b=rgb(bg);if(f&&b){const a=light(f),z=light(b);contrast.push({label,fg,bg,ratio:(Math.max(a,z)+.05)/(Math.min(a,z)+.05)})}};
   for(const value of document.querySelectorAll('.metric-value'))check('metric value',getComputedStyle(value).color,getComputedStyle(value.closest('.metric')).backgroundColor);
   const taskInput=document.querySelector('.add-box input');if(taskInput)check('task input',getComputedStyle(taskInput).color,getComputedStyle(taskInput.closest('.add-box')).backgroundColor);
   for(const el of document.querySelectorAll('#main h1,#main h2,#main button,#main input,#main select,#main iframe,#main .metric-value')){
    if(el.closest('.keyboard-scroll'))continue;const r=el.getBoundingClientRect();if(!r.width||!r.height||r.bottom<0||r.top>innerHeight)continue;
    if(r.left < -1 || r.right > innerWidth+1) issues.push({tag:el.tagName,text:(el.innerText||el.getAttribute('aria-label')||'').slice(0,30),left:r.left,right:r.right});
    let p=el.parentElement;while(p&&p!==document.body){const s=getComputedStyle(p),q=p.getBoundingClientRect();if((s.overflowX==='hidden'||s.overflowX==='clip')&&(r.left<q.left-1||r.right>q.right+1)){issues.push({tag:el.tagName,text:(el.innerText||el.getAttribute('aria-label')||'').slice(0,30),clip:p.className||p.id,left:r.left,right:r.right,limit:q.right});break}p=p.parentElement}
   }
   return {selected:document.querySelector('[data-page].selected')?.dataset.page,error:document.querySelector('.error-banner')?.innerText||null,mainWidth:main.clientWidth,scrollWidth:main.scrollWidth,issues,contrast};})()`);
  assert.equal(metrics.selected,id);assert.equal(metrics.error,null,`${id}: ${metrics.error}`);
  for(const issue of metrics.issues)clipped.push({page:id,...issue});
  for(const item of metrics.contrast){contrastChecks.push({page:id,...item});if(item.ratio<4.5)readability.push({page:id,...item})}
  const shot=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,fromSurface:true});const bytes=Buffer.from(shot.data,'base64');assert.ok(bytes.length>5000);fs.writeFileSync(path.join(outputDir,`dpi150-dark-${String(i+1).padStart(2,'0')}-${id}.png`),bytes);
 }
 // Return to the task detail and assess the actual iframe colors and geometry.
 await cdp.eval("document.querySelector('[data-page=tasks]').click();true");
 const selector=`[data-action="select"][data-id="${task.id}"]`;
 await until(()=>cdp.eval(`Boolean(document.querySelector(${JSON.stringify(selector)}))`),5000,'task row');
 await cdp.eval(`document.querySelector(${JSON.stringify(selector)}).click();true`);
 const editor=await until(()=>cdp.eval(`(()=>{const f=document.querySelector('#details-frame'),e=f?.contentDocument?.querySelector('#editor');if(!e||!e.textContent.includes('可读的编辑内容'))return null;const r=f.getBoundingClientRect(),c=f.contentWindow.getComputedStyle(e);return {width:r.width,height:r.height,foreground:c.color,background:getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),text:e.textContent}})()`),10000,'editor visual');
 assert.ok(editor.width>100 && editor.height>80,JSON.stringify(editor));
 const editorContrast=contrast(editor.foreground,editor.background);
 assert.ok(editorContrast>=4.5,`Editor text contrast ${editorContrast.toFixed(2)}`);
 t.diagnostic(`Editor geometry ${editor.width.toFixed(1)}x${editor.height.toFixed(1)}; text ${editor.foreground}; background ${editor.background}; contrast ${editorContrast.toFixed(2)}`);
 const editorShot=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,fromSurface:true});fs.writeFileSync(path.join(outputDir,'dpi150-dark-editor.png'),Buffer.from(editorShot.data,'base64'));
 t.diagnostic(`Clipping findings: ${JSON.stringify(clipped)}`);
 t.diagnostic(`Contrast findings: ${JSON.stringify(readability)}`);
 t.diagnostic(`Contrast checks: ${JSON.stringify(contrastChecks)}`);
 assert.deepEqual(cdp.exceptions,[],'uncaught renderer exceptions');
 assert.deepEqual(clipped,[],'horizontal clipping of controls');
 assert.ok(contrastChecks.some(x=>x.label==='task input')&&contrastChecks.filter(x=>x.label==='metric value').length>=3,'required color checks did not run');
 assert.deepEqual(readability,[],'task input and metric values need readable contrast');
 try{await cdp.eval("(()=>{window.toccata.invoke('app:quit').catch(()=>{});return true})()")}catch(_){}
 const result=await timeout(instance.done,10000);assert.ok(result,'Electron did not exit');assert.equal(result.code,0,instance.getOutput().slice(-2000));cdp.close();instance=null;
});
