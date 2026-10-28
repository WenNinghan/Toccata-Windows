'use strict';
// Isolated test-only main-process control. Never reads input from the keyboard.
const Module = require('node:module');
const electron = require('electron');
const originalLoad = Module._load;
const options = new WeakMap();
const Window = new Proxy(electron.BrowserWindow, {
  construct(target, args) { const window = Reflect.construct(target, args); options.set(window, args[0]); return window; },
});
Module._load = function(request, parent, isMain) {
  const loaded = originalLoad.apply(this, arguments);
  if (request === 'electron') return new Proxy(loaded, { get(target, prop) { return prop === 'BrowserWindow' ? Window : target[prop]; } });
  return loaded;
};
function mainWindow() {
  return electron.BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/renderer/index.html') && !w.webContents.getURL().includes('?'));
}
electron.app.on('browser-window-created', (_event, created) => created.webContents.on('console-message', async (event, level, message) => {
  const line = typeof message === 'string' ? message : event.message;
  if (typeof line !== 'string' || !line.startsWith('QA_NATIVE_COMMAND ')) return;
  let request;
  try {
    request = JSON.parse(line.slice('QA_NATIVE_COMMAND '.length));
    const w = mainWindow();
    if (!w || created !== w) throw new Error('main window missing');
    let result;
    switch(request.op) {
      case 'state': result = {frame:options.get(w)?.frame, visible:w.isVisible(), minimized:w.isMinimized(), maximized:w.isMaximized(), destroyed:w.isDestroyed()}; break;
      case 'maximize': w.maximize(); result = true; break;
      case 'unmaximize': w.unmaximize(); result = true; break;
      case 'minimize': w.minimize(); result = true; break;
      case 'restore': w.restore(); result = true; break;
      case 'show': w.show(); result = true; break;
      case 'edit-close': await w.webContents.executeJavaScript(request.expression); w.close(); result = true; break;
      default: throw new Error('unknown operation');
    }
    await created.webContents.executeJavaScript(`window.__nativeReply=${JSON.stringify({id:request.id,result})}`);
  } catch (error) { if (request) await created.webContents.executeJavaScript(`window.__nativeReply=${JSON.stringify({id:request.id,error:error.message})}`); }
}));
require('../main.js');
