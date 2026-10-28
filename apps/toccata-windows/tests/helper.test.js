'use strict';
// These tests never start the helper in capture mode. In particular, they do
// not collect, read, print, or save key-event output from a running listener.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const executable = path.join(__dirname, '..', 'native', 'raw_input_helper.exe');
const onWindows = process.platform === 'win32';

test('native helper self-test checks key state without starting capture', { skip: !onWindows }, () => {
  assert.ok(fs.existsSync(executable), 'build helper first with npm run build:native');
  const result = spawnSync(executable, ['--self-test'], {
    windowsHide: true, encoding: 'utf8', timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^PASS: repeat, hold, chord, device, removal, extended and zero-scan handling\r?\n$/);
  assert.equal(result.stderr, '');
});

// Regular helper startup subscribes to system-wide Raw Input immediately. We
// cannot guarantee that a user is not typing, even during a short test. The
// live readiness/quit/EOF handshake is therefore intentionally not automated.
test.skip('live helper ready and quit/EOF handshake requires a non-capturing test mode', () => {});

test('unknown arguments are rejected without starting capture', { skip: !onWindows }, () => {
  for (const args of [['--unknown'], ['--self-test', 'unexpected']]) {
    const result = spawnSync(executable, args, {
      windowsHide: true, encoding: 'utf8', timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 64);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^Usage:/);
  }
});
