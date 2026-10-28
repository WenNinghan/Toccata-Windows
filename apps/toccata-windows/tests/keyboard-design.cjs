'use strict';

// Real Electron visual/interaction QA. All statistics are synthetic and every
// profile is retained on G:. The harness refuses to launch the native listener.
// Run explicitly: node --test tests/keyboard-design.cjs
const fs = require('node:fs');
const path = require('node:path');
const role = process.env.TOCCATA_DESIGN_QA_ROLE;

if (role === 'helper') {
  const readline = require('node:readline');
  const control = process.env.TOCCATA_DESIGN_QA_CONTROL;
  if (!control) throw new Error('Synthetic helper requires its own control file');
  let offset = 0, eventId = 0;
  process.stdout.write(JSON.stringify({ type:'ready', protocol:1 })+'\n');
  const timer = setInterval(() => {
    const commands = fs.readFileSync(control, 'utf8').split('\n').filter(Boolean);
    while (offset < commands.length) {
      const command = JSON.parse(commands[offset++]);
      if (command.type === 'reset') {
        process.stdout.write(JSON.stringify({ type:'reset', device:command.device, reason:'synthetic-design-qa' })+'\n');
      } else {
        if (!['down','up'].includes(command.kind)) throw new Error('Invalid synthetic command');
        process.stdout.write(JSON.stringify({ type:'key', event_id:++eventId, scan:30, ext:0, vkey:65,
          device:command.device || 'design-qa-a', kind:command.kind, ts_ms:Date.now(),
          hold_ms:command.kind === 'up' ? 160 : null, app:'design-qa.exe' })+'\n');
      }
    }
  }, 15);
  const input = readline.createInterface({input:process.stdin});
  const quit = () => { clearInterval(timer); process.exit(0); };
  input.on('line', line => { if (line.trim() === 'quit') quit(); });
  input.on('close', quit);
} else if (role === 'harness') {
  const child = require('node:child_process'), originalSpawn = child.spawn;
  const expectedExe = process.env.TOCCATA_QA_HELPER_EXE;
  const normalize = value => path.resolve(value).toLowerCase();
  child.spawn = function(command, args, options) {
    if (!expectedExe || typeof command !== 'string' || normalize(command) !== normalize(expectedExe) ||
        !Array.isArray(args) || args.length !== 1 || normalize(args[0]) !== normalize(__filename)) {
      throw new Error('Design QA refuses to start a real capture helper');
    }
    return originalSpawn.call(this, command, args, { ...options,
      env:{ ...process.env, TOCCATA_DESIGN_QA_ROLE:'helper' } });
  };
  const { app } = require('electron');
  app.on('browser-window-created', (_event, window) => {
    // Show only this isolated QA app without taking keyboard focus. Chromium
    // does not reliably resolve captureScreenshot for a never-shown surface.
    const showInactive=window.showInactive.bind(window);
    window.show = showInactive;
    window.webContents.setBackgroundThrottling(false);
    window.once('ready-to-show', () => {
      if (!window.isDestroyed() && window.webContents.getURL().includes('/renderer/index.html') &&
          !window.webContents.getURL().includes('?')) window.setContentSize(1200, 900);
    });
  });
  require('../main.js');
} else {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  const { spawn } = require('node:child_process');
  const { KeyStore } = require('../data/keyboard');
  const project = path.resolve(__dirname, '..');
  const executable = path.join(project, 'node_modules', 'electron', 'dist', 'electron.exe');
  const output = 'G:\\DevTools\\temp\\toccata-redesign-20261028';
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function timeout(promise, ms) {
    let timer;
    try { return await Promise.race([promise, new Promise(resolve => { timer=setTimeout(() => resolve(null), ms); })]); }
    finally { clearTimeout(timer); }
  }
  async function until(fn, ms, label) {
    const end=Date.now()+ms; let last;
    while(Date.now()<end) {
      try { const result=await fn(); if(result) return result; } catch(error) { last=error; }
      await delay(35);
    }
    throw new Error(`${label} timed out${last?`: ${last.message}`:''}`);
  }
  class CDP {
    constructor(ws) {
      this.ws=ws;this.next=0;this.pending=new Map();this.exceptions=[];
      ws.addEventListener('message', event => {
        const value=JSON.parse(event.data);
        if(value.method==='Runtime.exceptionThrown') this.exceptions.push(value.params.exceptionDetails.exception?.description || value.params.exceptionDetails.text);
        const request=this.pending.get(value.id);if(!request)return;
        this.pending.delete(value.id);value.error?request.reject(new Error(value.error.message)):request.resolve(value.result);
      });
      ws.addEventListener('close', () => { for(const p of this.pending.values())p.reject(new Error('CDP closed'));this.pending.clear(); });
    }
    static async connect(url) {
      const ws=new WebSocket(url);
      assert.ok(await timeout(new Promise((resolve,reject) => {
        ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',()=>reject(new Error('CDP connect failed')),{once:true});
      }),5000),'CDP open timeout');
      return new CDP(ws);
    }
    send(method,params={}) {
      const id=++this.next;
      return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}));});
    }
    async eval(expression) {
      const result=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
      if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
      return result.result.value;
    }
    close(){this.ws.close();}
  }
  function seed(dir) {
    const now=Date.now()-1000, today=new Date();today.setHours(0,0,0,0);
    const start=Math.max(today.getTime()+1000,now-90*60000);
    const cases=[[30,65,282],[31,83,124],[32,68,155],[33,70,89],[18,69,211],[17,87,97],
      [57,32,405],[28,13,148],[14,8,126],[15,9,81],[29,17,60],[46,67,41]];
    const total=cases.reduce((sum,item)=>sum+item[2],0), step=(now-start)/(total+1);
    const store=new KeyStore(path.join(dir,'toccata-windows.sqlite'));
    let id=0;
    try {
      // Interleave the fixture so its timeline has continuous synthetic activity.
      for(let index=0;index<405;index++)for(const [scan,vkey,count] of cases)if(index<count) {
        const ts=Math.floor(start+(++id)*step),hold=Math.min(120,Math.max(1,Math.floor(step*.6)));
        store.add({type:'key',event_id:`design-${id}-down`,scan,ext:0,vkey,kind:'down',ts_ms:ts,app:'design-qa.exe'});
        store.add({type:'key',event_id:`design-${id}-up`,scan,ext:0,vkey,kind:'up',ts_ms:ts+hold,hold_ms:hold,app:'design-qa.exe'});
      }
      store.flush();
    } finally { store.close(); }
    return {total,bounds:{start_ms:today.getTime(),end_ms:Date.now()+1000}};
  }
  async function launch(dir,capture=false) {
    const temp=path.join(dir,'temp');fs.mkdirSync(temp,{recursive:true});
    const control=path.join(dir,'synthetic-commands.jsonl');fs.writeFileSync(control,'');
    const env={...process.env,TEMP:temp,TMP:temp,TOCCATA_DATA_DIR:dir,TOCCATA_DESIGN_QA_ROLE:'harness',
      TOCCATA_QA_HELPER_EXE:process.execPath,TOCCATA_QA_HELPER_SCRIPT:__filename,TOCCATA_DESIGN_QA_CONTROL:control};
    for(const key of ['ELECTRON_RUN_AS_NODE','TOCCATA_QA_SCREENSHOT','TOCCATA_QA_MEMORY'])delete env[key];
    if(capture)delete env.TOCCATA_DISABLE_CAPTURE;else env.TOCCATA_DISABLE_CAPTURE='1';
    const proc=spawn(executable,['--remote-debugging-port=0','--remote-allow-origins=*','--disable-gpu',__filename],
      {cwd:project,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let log='',exited=false;proc.stdout.on('data',b=>{log+=b});proc.stderr.on('data',b=>{log+=b});
    const done=new Promise(resolve=>proc.once('close',(code,signal)=>{exited=true;resolve({code,signal})}));
    try {
      const port=await until(()=>{const m=log.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);if(m)return +m[1];if(exited)throw new Error(log.slice(-2000));},20000,'Electron startup');
      const target=await until(async()=>{const pages=await(await fetch(`http://127.0.0.1:${port}/json`)).json();return pages.find(p=>p.type==='page'&&p.url.includes('/renderer/index.html')&&!p.url.includes('?')&&p.webSocketDebuggerUrl)},10000,'main renderer');
      const cdp=await CDP.connect(target.webSocketDebuggerUrl);await cdp.send('Runtime.enable');await cdp.send('Page.enable');
      await until(()=>cdp.eval('Boolean(window.toccata?.invoke && document.querySelector("#main h1"))'),10000,'app ready');
      return {proc,done,cdp,control,log:()=>log};
    } catch(error) {if(!exited)proc.kill();await timeout(done,3000);throw error;}
  }
  const invoke=(cdp,channel,payload={})=>cdp.eval(`window.toccata.invoke(${JSON.stringify(channel)},${JSON.stringify(payload)})`);
  async function quit(app) {
    try {await app.cdp.eval("(()=>{window.toccata.invoke('app:quit').catch(()=>{});return true})()");}catch(_){}
    const result=await timeout(app.done,10000);assert.ok(result,'QA app exit timed out');assert.equal(result.code,0,app.log().slice(-2000));app.cdp.close();
  }
  async function click(cdp,selector) {
    await cdp.eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw new Error('Missing selector');el.click();return true})()`);
  }
  async function photo(cdp,name) {
    const shot=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,fromSurface:true});
    const bytes=Buffer.from(shot.data,'base64');assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.ok(bytes.length>6000);
    fs.writeFileSync(path.join(output,name),bytes);
    console.log(`Saved ${path.join(output,name)}`);
  }
  async function metrics(cdp) {
    return cdp.eval(`(()=>{
      const board=document.querySelector('.keyboard'), scroller=document.querySelector('.keyboard-scroll'), content=document.querySelector('#main .content');
      const rect=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};
      const controls=[...document.querySelectorAll('#main button,#main select,#main h1,#main h2')].filter(el=>!el.closest('.keyboard-scroll'));
      const clipped=controls.filter(el=>{const r=el.getBoundingClientRect();return r.width&&r.height&&(r.left<-.5||r.right>innerWidth+.5)}).map(el=>({text:el.textContent,rect:rect(el)}));
      const typography=[...board.querySelectorAll('.key-label')].map(el=>{const range=document.createRange();range.selectNodeContents(el);return {label:el.closest('[data-key]').dataset.label,fontSize:getComputedStyle(el).fontSize,required:range.getBoundingClientRect().width,available:el.getBoundingClientRect().width}});
      const truncatedLabels=typography.filter(label=>label.required>label.available+.1);
      const fontSamples=typography.filter(label=>['Home','F1','Num','Backspace'].includes(label.label));
      return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,documentWidth:document.documentElement.scrollWidth,truncatedLabels,fontSamples,
        contentWidth:content.clientWidth,contentScrollWidth:content.scrollWidth,keys:board.querySelectorAll('[data-key]').length,
        board:rect(board),scroller:rect(scroller),scrollerWidth:scroller.clientWidth,scrollerScrollWidth:scroller.scrollWidth,clipped,
        error:document.querySelector('.error-banner')?.textContent||null};
    })()`);
  }

  test('redesigned keyboard: real layouts, themes, responsive view, export and synthetic key feedback', {timeout:120000}, async t=>{
    fs.mkdirSync(output,{recursive:true});
    const dir=fs.mkdtempSync(path.join(output,'profile-')), seeded=seed(dir), report={profile:dir,synthetic:true,layouts:[],events:[]};
    let app;
    t.after(async()=>{
      if(app?.proc.exitCode===null){app.proc.kill();await timeout(app.done,3000);}if(app)try{app.cdp.close()}catch(_){}
      fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
    });
    app=await launch(dir);let cdp=app.cdp;console.log('Isolated Electron renderer ready');
    assert.equal((await invoke(cdp,'capture:status')).state,'disabled');
    assert.equal((await invoke(cdp,'stats:query',seeded.bounds)).key_count,seeded.total);
    await click(cdp,'[data-page="activity"]');
    await until(()=>cdp.eval('Boolean(document.querySelector(".keyboard [data-key]"))'),10000,'keyboard');
    const info=await invoke(cdp,'layout:get');assert.deepEqual(info.presets.map(p=>p.key_count),[68,84,87,104]);
    for(const theme of ['light','dark']) {
      await invoke(cdp,'settings:set',{key:'theme',value:theme});
      await until(()=>cdp.eval(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`),5000,'theme');
      for(const preset of [...info.presets].reverse()) {
        const layout=await invoke(cdp,'layout:preset',{id:preset.id});await invoke(cdp,'layout:set',{layout});
        await until(()=>cdp.eval(`document.querySelectorAll('.keyboard [data-key]').length===${preset.key_count} && document.querySelector('#keyboard-layout')?.value===${JSON.stringify(preset.id)}`),5000,'preset renderer');
        await delay(450);const measure=await metrics(cdp);
        assert.equal(measure.error,null);assert.deepEqual(measure.clipped,[]);assert.ok(measure.contentScrollWidth<=measure.contentWidth+1);
        assert.equal((await invoke(cdp,'layout:get')).layout.id,preset.id);
        report.layouts.push({theme,preset:preset.id,...measure});
        await photo(cdp,`${theme}-${preset.key_count}.png`);
        assert.deepEqual(measure.truncatedLabels,[],`${theme} ${preset.key_count}: standard key legends must be readable`);
      }
    }
    // Save a real user-edited layout, including its custom label, through UI IPC.
    await invoke(cdp,'settings:set',{key:'theme',value:'light'});
    const original=await invoke(cdp,'layout:preset',{id:info.presets.find(p=>p.key_count===84).id});
    await invoke(cdp,'layout:set',{layout:original});await delay(350);
    await click(cdp,'[data-action="edit-layout"]');
    await until(()=>cdp.eval('Boolean(document.querySelector(".layout-dialog"))'),5000,'layout editor');
    await click(cdp,'[data-layout-key="53"]');
    await cdp.eval("(()=>{const input=document.querySelector('#layout-label');input.value='EXIT';input.dispatchEvent(new Event('change',{bubbles:true}));return true})()");
    await photo(cdp,'custom-editor.png');await click(cdp,'[data-layout-action="apply"]');
    await until(()=>cdp.eval('!document.querySelector(".layout-dialog") && document.querySelector(".keyboard [data-key=\\"53\\"]")?.textContent.includes("EXIT")'),5000,'custom layout applied');
    const customLayout=(await invoke(cdp,'layout:get')).layout;
    assert.equal(customLayout.keys.find(k=>k.code===53).label,'EXIT');
    await photo(cdp,'custom-layout.png');
    const key=await cdp.eval("(()=>{const r=document.querySelector('.keyboard [data-key=\"0\"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',...key});await delay(350);
    report.hover=await cdp.eval("document.querySelector('.keyboard-inspector')?.textContent || ''");
    assert.match(report.hover,/A/);assert.match(report.hover,/282/);await photo(cdp,'custom-hover.png');
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:5,y:5});
    await click(cdp,'[data-action="share"]');
    const share=await until(()=>cdp.eval("(()=>{const img=document.querySelector('#share-preview img');return img?.complete&&img.naturalWidth>0?{src:img.src,width:img.naturalWidth,height:img.naturalHeight}:null})()"),10000,'share image');
    assert.match(share.src,/^data:image\/png;base64,/);assert.equal(share.width,1440);assert.ok(share.height>1000);
    const exportBytes=Buffer.from(share.src.split(',')[1],'base64');assert.ok(exportBytes.length>15000);fs.writeFileSync(path.join(output,'share.png'),exportBytes);
    report.share={width:share.width,height:share.height,bytes:exportBytes.length};await photo(cdp,'share-dialog.png');
    await cdp.eval("document.querySelector('#dialog-root').replaceChildren();true");
    // Device metrics are isolated to this renderer, not the Windows display.
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:900,height:600,deviceScaleFactor:1.5,mobile:false});
    await invoke(cdp,'settings:set',{key:'theme',value:'dark'});await delay(400);
    report.narrow=[];
    for(const preset of [...info.presets].reverse()) {
      const layout=await invoke(cdp,'layout:preset',{id:preset.id});await invoke(cdp,'layout:set',{layout});await delay(350);
      const narrow=await metrics(cdp);assert.equal(narrow.dpr,1.5);assert.deepEqual(narrow.clipped,[]);
      assert.equal(narrow.keys,preset.key_count);assert.ok(narrow.documentWidth<=900);assert.ok(narrow.contentScrollWidth<=narrow.contentWidth+1);
      report.narrow.push({preset:preset.id,...narrow});await photo(cdp,`narrow-150-dark-${preset.key_count}.png`);
      assert.deepEqual(narrow.truncatedLabels,[],`${preset.key_count}: narrow-view standard key legends must be readable`);
      await cdp.eval("document.querySelector('.keyboard-stage').scrollIntoView({block:'center'});true");await delay(120);
      await photo(cdp,`narrow-150-dark-${preset.key_count}-board.png`);
      if(preset.key_count===104) {
        await cdp.eval("(()=>{const scroll=document.querySelector('.keyboard-scroll');scroll.scrollLeft=scroll.scrollWidth;return true})()");
        await photo(cdp,'narrow-150-dark-104-right.png');
        await cdp.eval("document.querySelector('.keyboard-scroll').scrollLeft=0;true");
      }
      await cdp.eval("document.querySelector('#main .content').scrollTop=0;true");
    }
    await invoke(cdp,'layout:set',{layout:customLayout});
    assert.deepEqual(cdp.exceptions,[]);await quit(app);app=null;

    // Restart retains the custom layout. Events below traverse the existing
    // helper/main/preload path; they are not physical hardware acceptance tests.
    app=await launch(dir,true);cdp=app.cdp;
    await until(async()=>((await invoke(cdp,'capture:status')).state==='active'),5000,'synthetic helper');
    assert.equal((await invoke(cdp,'layout:get')).layout.keys.find(k=>k.code===53).label,'EXIT');
    await click(cdp,'[data-page="activity"]');
    await until(()=>cdp.eval('Boolean(document.querySelector(".keyboard [data-key]"))'),5000,'event view');
    await cdp.eval("window.__designEvents=[];window.toccata.on('key',e=>window.__designEvents.push({kind:e.kind,pressedCodes:e.pressedCodes}));true");
    const send=command=>fs.appendFileSync(app.control,JSON.stringify(command)+'\n');
    const pressed=()=>cdp.eval("document.querySelector('.keyboard [data-key=\"0\"]')?.classList.contains('pressed')");
    send({kind:'down',device:'design-qa-a'});await until(pressed,3000,'key down feedback');await delay(100);await photo(cdp,'synthetic-pressed.png');
    send({kind:'down',device:'design-qa-b'});await until(()=>cdp.eval('window.__designEvents.length===2'),3000,'second device');
    send({kind:'up',device:'design-qa-a'});await until(()=>cdp.eval('window.__designEvents.length===3'),3000,'first release');assert.equal(await pressed(),true);
    send({type:'reset',device:'design-qa-a'});await delay(80);assert.equal(await pressed(),true);
    send({kind:'up',device:'design-qa-b'});await until(async()=>!(await pressed()),3000,'final release feedback');
    report.release=await cdp.eval("(()=>{const key=document.querySelector('.keyboard [data-key=\"0\"]'),s=getComputedStyle(key);return {className:key.className,transform:s.transform,animation:s.animationName,transition:s.transitionDuration,animations:key.getAnimations({subtree:true}).map(a=>({state:a.playState,duration:a.effect.getTiming().duration}))}})()");
    assert.match(report.release.className,/released/);
    await photo(cdp,'synthetic-released.png');await delay(1000);assert.equal(await pressed(),false);
    assert.equal(await cdp.eval("document.querySelector('.keyboard [data-key=\"0\"]')?.classList.contains('released')"),false);
    await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    assert.equal(await cdp.eval("matchMedia('(prefers-reduced-motion: reduce)').matches"),true);
    send({kind:'down',device:'design-qa-a'});await until(pressed,3000,'reduced motion key down');
    send({kind:'up',device:'design-qa-a'});await until(async()=>!(await pressed()),3000,'reduced motion key up');await delay(30);
    report.reducedMotion=await cdp.eval("(()=>{const key=document.querySelector('.keyboard [data-key=\"0\"]');return {transform:getComputedStyle(key).transform,animations:key.getAnimations({subtree:true}).filter(a=>a.playState==='running').map(a=>({duration:a.effect.getTiming().duration}))}})()");
    assert.ok(report.reducedMotion.animations.every(a=>Number(a.duration)<=1),'reduced motion must not run visible key animations');
    report.events=await cdp.eval('window.__designEvents');assert.equal(report.events.length,6);assert.deepEqual(report.events.at(-1).pressedCodes,[]);
    assert.equal((await invoke(cdp,'stats:query',{...seeded.bounds,end_ms:Date.now()+1000})).key_count,seeded.total+3);
    assert.deepEqual(cdp.exceptions,[]);await quit(app);app=null;
    t.diagnostic(`Synthetic visual evidence: ${output}; retained profile ${dir}`);
  });
}
