'use strict';

// Defense-in-depth: even if the main app's injection option regresses, fail
// rather than allowing this test to spawn the real keyboard listener.
const path = require('node:path');
const child = require('node:child_process');
const originalSpawn = child.spawn;
const expectedExe = process.env.TOCCATA_QA_HELPER_EXE;
const expectedScript = process.env.TOCCATA_QA_HELPER_SCRIPT;
if (!expectedExe || !expectedScript) throw new Error('Synthetic helper must be configured');
const norm = value => path.resolve(value).toLowerCase();
child.spawn = function(command, args, options) {
  if (typeof command !== 'string' || norm(command) !== norm(expectedExe) || !Array.isArray(args) ||
      args.length !== 1 || typeof args[0] !== 'string' || norm(args[0]) !== norm(expectedScript)) {
    throw new Error('Synthetic test refuses to launch any other helper');
  }
  return originalSpawn.call(this,command,args,options);
};
require('../main.js');
