'use strict';
// Synthetic events only: this fixture never installs a keyboard hook.
const readline=require('node:readline');
process.stdout.write(JSON.stringify({type:'ready',protocol:1})+'\n');
let id=0;
function key(device,kind){process.stdout.write(JSON.stringify({type:'key',event_id:++id,scan:30,ext:0,vkey:65,device,kind,ts_ms:Date.now(),hold_ms:kind==='up'?500:null,app:'test.exe'})+'\n')}
setTimeout(()=>key('device-a','down'),1600);
setTimeout(()=>key('device-b','down'),2000);
setTimeout(()=>key('device-a','up'),2500);
setTimeout(()=>process.stdout.write(JSON.stringify({type:'reset',device:'device-a',reason:'synthetic'})+'\n'),2900);
setTimeout(()=>key('device-b','up'),3500);
const lines=readline.createInterface({input:process.stdin});
lines.on('line',line=>{if(line.trim()==='quit')process.exit(0)});lines.on('close',()=>process.exit(0));
