'use strict';

// Test-only launcher: observe BrowserWindow.isVisible() in the Electron main
// process. It neither calls setLoginItemSettings nor reads keyboard events.
const { app } = require('electron');
app.on('browser-window-created', (_event, window) => {
  const isMain = () => {
    const url = window.webContents.getURL();
    return url.includes('/renderer/index.html') && !url.includes('?');
  };
  window.on('show', () => { if (isMain()) process.stdout.write('QA_MAIN_SHOW\n'); });
  window.once('ready-to-show', () => setImmediate(() => {
    if (isMain() && !window.isDestroyed()) process.stdout.write(`QA_INITIAL_VISIBLE=${window.isVisible()}\n`);
  }));
});
require('../main.js');
