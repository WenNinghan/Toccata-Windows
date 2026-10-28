'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { MAX_ICON_BYTES, MAX_ICON_DIMENSION } = require('./app-identities');

function validPng(bytes) {
  return Buffer.isBuffer(bytes) && bytes.length >= 33 && bytes.length <= MAX_ICON_BYTES &&
    bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) &&
    bytes.toString('ascii',12,16) === 'IHDR' && bytes.readUInt32BE(16) > 0 &&
    bytes.readUInt32BE(20) > 0 && bytes.readUInt32BE(16) <= MAX_ICON_DIMENSION &&
    bytes.readUInt32BE(20) <= MAX_ICON_DIMENSION;
}

// The executable path is transient input, never a cache key written to disk.
// Read the script through Node so the same code works inside app.asar.
function createIconLoader() {
  const script = fs.readFileSync(path.join(__dirname,'read-app-icon.ps1'),'utf8');
  const encoded = Buffer.from(script,'utf16le').toString('base64');
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const children = new Set(); let closed = false;
  const load = async exePath => {
    if (closed) return null;
    return new Promise(resolve => {
      const child=spawn(executable,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',encoded],{
        windowsHide:true,stdio:['pipe','pipe','pipe'],env:process.env,
      });
      children.add(child);let output='',settled=false;
      const finish=bytes=>{if(settled)return;settled=true;clearTimeout(timer);children.delete(child);resolve(bytes);};
      const timer=setTimeout(()=>{child.kill();finish(null);},12000);
      child.on('error',()=>finish(null));
      child.stdin.on('error',()=>{});
      child.stderr.on('data',()=>{});
      child.stdout.on('data',bytes=>{output+=bytes.toString('utf8');if(output.length>MAX_ICON_BYTES*2){child.kill();finish(null);}});
      child.on('close',code=>{
        if(code!==0||closed){finish(null);return;}
        try {const result=JSON.parse(output.trim()),bytes=Buffer.from(result?.png||'','base64');finish(validPng(bytes)?bytes:null);}catch{finish(null);}
      });
      child.stdin.end(JSON.stringify({exePath}));
    });
  };
  load.close=()=>{closed=true;for(const child of children)child.kill();children.clear();};
  return load;
}

// Refresh an old cached icon once per run, on the next real use of its app.
// Keep the previous icon on failure and cap extraction concurrency off the input path.
class AppIconRefresh {
  constructor({ load, canWrite=()=>true, onSaved=()=>{}, now=Date.now, concurrency=2 }) {
    this.load=load;this.canWrite=canWrite;this.onSaved=onSaved;this.now=now;
    this.concurrency=concurrency;this.states=new Map();this.queue=[];this.active=0;this.closed=false;
  }
  request(record,exePath,store) {
    if(this.closed||!this.canWrite()||store.closed)return;
    const state=this.states.get(record.id)||{done:false,pending:false,failures:0,next:0};
    if(state.done||state.pending||this.now()<state.next)return;
    state.pending=true;this.states.set(record.id,state);this.queue.push({record,exePath,store,state});this.pump();
  }
  pump() {
    while(!this.closed&&this.active<this.concurrency&&this.queue.length){
      const job=this.queue.shift();this.active++;
      this.run(job).finally(()=>{this.active--;this.pump();});
    }
  }
  async run({record,exePath,store,state}) {
    try {
      if(this.closed||store.closed||!this.canWrite())return;
      const bytes=await this.load(exePath);
      if(this.closed||store.closed||!this.canWrite())return;
      if(!validPng(bytes))throw new Error('Icon unavailable');
      // A failed high-resolution read must not downgrade an existing larger icon.
      const old=store.get(record.id)?.icon_png;
      if(!validPng(old)||bytes.readUInt32BE(16)>=old.readUInt32BE(16)) {
        const saved=store.setIcon(record.id,bytes);this.onSaved(saved,exePath);
      }
      state.done=true;
    } catch {
      state.failures++;state.next=this.now()+[60000,300000,900000][Math.min(state.failures-1,2)];
    } finally {state.pending=false;}
  }
  close(){this.closed=true;this.queue.length=0;this.load.close?.();}
}

module.exports={AppIconRefresh,createIconLoader,validPng};
