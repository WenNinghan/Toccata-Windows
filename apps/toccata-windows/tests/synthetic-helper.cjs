'use strict';

// Fixture only. Emits predetermined test messages; never calls an input API.
const readline = require('node:readline');
process.stdout.write(JSON.stringify({type:'ready',protocol:1})+'\n');
setTimeout(() => {
  const start = Date.now() - 10000;
  const cases = [
    {scan:30,vkey:65,path:'C:\\QA\\alpha\\editor.exe',offset:0,held:200},
    {scan:46,vkey:67,path:'C:\\QA\\beta\\editor.exe',offset:6000,held:300},
  ];
  let id = 0;
  for (const item of cases) {
    for (const kind of ['down','up']) {
      const up = kind === 'up';
      process.stdout.write(JSON.stringify({type:'key',event_id:++id,scan:item.scan,ext:0,vkey:item.vkey,
        device:'synthetic-device',kind,ts_ms:start+item.offset+(up?item.held:0),
        hold_ms:up?item.held:null,app:'editor.exe',exe_path:item.path})+'\n');
    }
  }
}, 1800);
const lines = readline.createInterface({input:process.stdin});
lines.on('line', line => { if (line.trim() === 'quit') process.exit(0); });
lines.on('close', () => process.exit(0));
