'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { computeStats } = require('../data/stats');

const dayStart = new Date(2026, 9, 19).getTime();
const nextDay = new Date(2026, 9, 20).getTime();
const e = (offset, keycode = 1, kind = 0, hold_ms = null, app = null, event_id) =>
  ({ ts_ms: dayStart + offset, keycode, kind, hold_ms, app, event_id });
const calc = (events, options = {}) => computeStats(events, {
  start_ms: dayStart, end_ms: nextDay, now_ms: dayStart + 180_000, ...options,
});

test('short windows, overlap and gaps follow upstream 5-second rule', () => {
  let result = calc([e(0), e(100, 1, 1, 100), e(3000), e(3100, 1, 1, 100)]);
  assert.equal(result.active_ms, 8000);
  assert.equal(result.key_count, 2);
  assert.equal(result.keys[1], 2);
  result = calc([e(0), e(100, 1, 1, 100), e(40_000), e(40_100, 1, 1, 100)]);
  assert.equal(result.active_ms, 10_000);
  assert.equal(result.days[0].active_ms, 10_000);
  assert.equal(result.days[0].buckets.reduce((a, b) => a + b, 0), 10_000);
});

test('configured window merges overlaps consistently for global and app time', () => {
  const result = calc([e(0, 1, 0, null, 'editor'), e(3000, 2, 0, null, 'editor')],
    { activity_window_ms: 10_000 });
  assert.equal(result.active_ms, 13_000);
  assert.equal(result.key_count, 2);
  assert.equal(result.apps[0].active_ms, 13_000);
  assert.equal(result.days[0].buckets[0], 13_000);
});

test('zero window still counts down and actual held intervals', () => {
  const short = calc([e(0)], { activity_window_ms: 0 });
  assert.equal(short.key_count, 1);
  assert.equal(short.active_ms, 0);
  const held = calc([e(0), e(2000, 1, 1, 2000)], { activity_window_ms: 0 });
  assert.equal(held.key_count, 1);
  assert.equal(held.active_ms, 2000);
});

test('configured window includes a preceding press crossing the range boundary', () => {
  const result = calc([e(-7000, 1, 0, null, 'editor')],
    { activity_window_ms: 10_000, end_ms: dayStart + 60_000 });
  assert.equal(result.key_count, 0);
  assert.equal(result.active_ms, 3000);
  assert.equal(result.apps[0].active_ms, 3000);
});

test('invalid activity windows are rejected, rather than silently changing metrics', () => {
  for (const value of [-1, 1.5, NaN, Infinity, '5000', null, true, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => calc([], { activity_window_ms: value }), RangeError);
  }
});

test('long and concurrent holds count union once; orphan up contributes nothing', () => {
  let result = calc([e(0, 1), e(0, 2), e(12_000, 1, 1, 12_000), e(12_000, 2, 1, 12_000)]);
  assert.equal(result.active_ms, 12_000);
  assert.equal(result.key_count, 2);
  assert.equal(result.fn_ms, null);
  assert.equal(result.days[0].fn_ms, null);
  result = calc([e(10_000, 1, 1)]);
  assert.equal(result.active_ms, 0);
});

test('cross-boundary releases and preceding down windows are clipped, not discarded', () => {
  const result = calc([
    e(-3000, 1),
    e(120_000, 2, 1, 180_000),
  ], { end_ms: dayStart + 60_000 });
  assert.equal(result.active_ms, 60_000);
  assert.equal(result.key_count, 0);
  const isolated = calc([e(-3000)], { end_ms: dayStart + 60_000 });
  assert.equal(isolated.active_ms, 2000);
  assert.equal(isolated.key_count, 0);
});

test('cross-midnight and quarter-hour boundaries split by real time', () => {
  const midnight = new Date(2026, 9, 20).getTime();
  const end = new Date(2026, 9, 21).getTime();
  const result = computeStats([
    { ts_ms: midnight - 2000, keycode: 1, kind: 0 },
    { ts_ms: midnight + 899_000, keycode: 2, kind: 0 },
  ], { start_ms: dayStart, end_ms: end, now_ms: midnight + 1_000_000 });
  assert.equal(result.active_ms, 10_000);
  assert.deepEqual(result.days.map(d => d.active_ms), [2000, 8000]);
  assert.deepEqual(result.days.map(d => d.key_count), [1, 1]);
  assert.deepEqual(result.days[1].buckets.slice(0, 2), [4000, 4000]);
});

test('deduplicates only shared event_id and retains enriched release duration', () => {
  const result = calc([
    e(0, 1, 0, null, 'editor', 'down-1'),
    e(0, 1, 0, null, 'editor', 'down-1'),
    e(0, 1, 0, null, 'editor', 'down-2'),
    e(10_000, 1, 1, 10_000, 'editor', 'up-1'),
    e(10_000, 1, 1, null, 'editor', 'up-1'),
  ]);
  assert.equal(result.key_count, 2);
  assert.equal(result.keys[1], 2);
  assert.equal(result.active_ms, 10_000);
  assert.equal(result.apps[0].key_count, 2);
});

test('live held events grow only when supplied; shared saved ID counts once', () => {
  const saved = e(1000, 1, 0, null, 'editor', 'down');
  let result = calc([saved], { now_ms: dayStart + 12_000, live: [saved] });
  assert.equal(result.key_count, 1);
  assert.equal(result.active_ms, 11_000);
  assert.equal(result.apps[0].active_ms, 11_000);
  result = calc([saved], { now_ms: dayStart + 12_000 });
  assert.equal(result.active_ms, 5000);
  result = calc([], { now_ms: dayStart + 12_000, live: [saved] });
  assert.equal(result.key_count, 1);
  assert.equal(result.active_ms, 11_000);
});

test('app time is grouped independently and can exceed global union', () => {
  const result = calc([e(0, 1, 0, null, 'app-a'), e(2000, 2, 0, null, 'app-b')]);
  assert.equal(result.active_ms, 7000);
  assert.equal(result.apps.length, 2);
  assert.equal(result.apps.reduce((sum, app) => sum + app.active_ms, 0), 10_000);
});

test('unmapped keys count globally, in days and apps without creating a heatmap key', () => {
  const result = calc([
    e(0, null, 0, null, 'editor', 'unknown-down'),
    e(12_000, null, 1, 12_000, 'editor', 'unknown-up'),
  ]);
  assert.equal(result.key_count, 1);
  assert.equal(result.active_ms, 12_000);
  assert.equal(result.days[0].key_count, 1);
  assert.equal(result.days[0].active_ms, 12_000);
  assert.deepEqual({ ...result.keys }, {});
  assert.equal(result.apps[0].key_count, 1);
  assert.equal(result.apps[0].active_ms, 12_000);
  const live = calc([], { now_ms: dayStart + 10_000,
    live: [e(0, null, 0, null, 'editor', 'live-unknown')] });
  assert.equal(live.key_count, 1);
  assert.equal(live.active_ms, 10_000);
  assert.deepEqual({ ...live.keys }, {});
});

test('clips at now and excludes future events and range end', () => {
  const result = calc([e(10_000), e(11_000), e(12_000, 2)], { now_ms: dayStart + 11_000 });
  assert.equal(result.active_ms, 1000);
  assert.equal(result.key_count, 1);
  assert.equal(result.days[0].active_ms, 1000);
});

test('DST days contain 92 or 100 quarter-hour buckets', () => {
  const modulePath = path.resolve(__dirname, '../data/stats.js');
  const code = `const {computeStats}=require(${JSON.stringify(modulePath)});
    for (const [m,d] of [[2,8],[10,1]]) {
      const start=new Date(2026,m,d).getTime(),end=new Date(2026,m,d+1).getTime();
      const x=computeStats([],{start_ms:start,end_ms:end,now_ms:end});
      console.log(JSON.stringify([end-start,x.days[0].buckets.length]));
    }`;
  const child = spawnSync(process.execPath, ['-e', code], {
    env: { ...process.env, TZ: 'America/Los_Angeles' }, encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(child.stdout.trim().split(/\r?\n/).map(JSON.parse),
    [[23 * 3600 * 1000, 92], [25 * 3600 * 1000, 100]]);
});

test('rejects invalid range instead of returning misleading data', () => {
  assert.throws(() => calc([], { start_ms: 3, end_ms: 3 }), RangeError);
  assert.throws(() => computeStats([], { start_ms: 1, end_ms: 2 }), RangeError);
});
