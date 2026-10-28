'use strict';

// Test-only entrypoint: resize only the isolated Electron instance's main
// window. No system display settings or other processes are changed.
const {app}=require('electron');
app.on('browser-window-created',(_event,window)=>{
 window.once('ready-to-show',()=>setImmediate(()=>{
  const url=window.webContents.getURL();
  if(!window.isDestroyed()&&url.includes('/renderer/index.html')&&!url.includes('?')) window.setSize(900,600);
 }));
});
require('../main.js');
