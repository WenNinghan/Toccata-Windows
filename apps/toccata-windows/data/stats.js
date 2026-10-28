'use strict';

// All event and range values are Unix epoch milliseconds. Spans are half-open.
const WINDOW_MS = 5000;
const BUCKET_MS = 15 * 60 * 1000;

function merge(spans) {
  const sorted = spans.filter(s => s[1] > s[0]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const result = [];
  for (const [start, end] of sorted) {
    const last = result[result.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else result.push([start, end]);
  }
  return result;
}

function clippedSpans(spans, start, end) {
  if (end <= start) return [];
  return merge(spans.map(([left, right]) => [Math.max(start, left), Math.min(end, right)]));
}

function spanDuration(spans, start, end) {
  if (end <= start) return 0;
  // Spans are merged and ordered; seek to the first one that can overlap.
  let low = 0, high = spans.length;
  while (low < high) { const mid = (low + high) >>> 1; if (spans[mid][1] <= start) low = mid + 1; else high = mid; }
  let total = 0;
  for (let i = low; i < spans.length && spans[i][0] < end; i++) {
    total += Math.max(0, Math.min(end, spans[i][1]) - Math.max(start, spans[i][0]));
  }
  return total;
}
function lowerBound(values, target) {
  let low=0, high=values.length;
  while (low<high) { const mid=(low+high)>>>1; if(values[mid]<target)low=mid+1;else high=mid; }
  return low;
}

function localMidnight(ms) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date;
}

function dateKey(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function validEvent(event) {
  return event && Number.isFinite(event.ts_ms) && (event.kind === 0 || event.kind === 1) &&
    (event.keycode === null || typeof event.keycode === 'string' || Number.isFinite(event.keycode));
}

// Identity belongs to the actual event, not merely (timestamp, key, kind): two
// independent devices may emit identical-looking events in the same millisecond.
function deduplicate(events) {
  const unique = [];
  const byId = new Map();
  for (const event of events) {
    if (!validEvent(event)) continue;
    if (event.event_id === undefined || event.event_id === null) {
      unique.push(event);
      continue;
    }
    const index = byId.get(event.event_id);
    if (index === undefined) {
      byId.set(event.event_id, unique.length);
      unique.push(event);
    } else {
      const existing = unique[index];
      // A persisted release can enrich an earlier live release with hold_ms.
      if (existing.hold_ms == null || event.hold_ms != null) unique[index] = event;
    }
  }
  return unique;
}

/**
 * `live` is an array of currently held down events from the current connection.
 * Pass it only while connected. Live events with the same event_id as a saved
 * down are counted once; orphan saved downs never grow indefinitely.
 * The caller supplies events outside the selected range: preceding downs whose
 * windows overlap it, and releases through now whose holds overlap it.
 */
function computeStats(events, { start_ms, end_ms, now_ms, live = [], activity_window_ms = WINDOW_MS } = {}) {
  if (!Array.isArray(events) || !Array.isArray(live)) throw new TypeError('events and live must be arrays');
  if (![start_ms, end_ms, now_ms].every(Number.isFinite) || end_ms <= start_ms) {
    throw new RangeError('start_ms and end_ms must be a nonempty interval; now_ms must be finite');
  }
  if (!Number.isSafeInteger(activity_window_ms) || activity_window_ms < 0) {
    throw new RangeError('activity_window_ms must be a nonnegative safe integer');
  }
  const limit = Math.min(end_ms, now_ms);
  const held = live.filter(item => item && Number.isFinite(item.ts_ms) && item.ts_ms <= now_ms &&
    (item.keycode === null || typeof item.keycode === 'string' || Number.isFinite(item.keycode)));
  const all = deduplicate([...events, ...held.map(item => ({ ...item, kind: 0 }))])
    .filter(event => event.ts_ms <= now_ms);
  const rawSpans = [];
  const appGroups = new Map();
  const groupFor = app => {
    if (typeof app !== 'string' || !app) return null;
    if (!appGroups.has(app)) appGroups.set(app, { spans: [], key_count: 0 });
    return appGroups.get(app);
  };
  const keys = Object.create(null);
  let keyCount = 0;
  const downs = [];
  for (const event of all) {
    const inRange = event.ts_ms >= start_ms && event.ts_ms < limit;
    let span = null;
    if (event.kind === 0) {
      // Saturate the end rather than silently overflowing the integer range.
      span = [event.ts_ms, Math.min(Number.MAX_SAFE_INTEGER, event.ts_ms + activity_window_ms)];
      if (inRange) {
        keyCount++;
        // Unmapped physical keys still contribute to activity, but must not
        // appear as a guessed keyboard key (or an artificial "null" key).
        if (event.keycode !== null) keys[event.keycode] = (keys[event.keycode] || 0) + 1;
        downs.push(event.ts_ms);
      }
    } else if (Number.isFinite(event.hold_ms) && event.hold_ms > 0) {
      span = [event.ts_ms - event.hold_ms, event.ts_ms];
    }
    if (span) rawSpans.push(span);
    const app = groupFor(event.app);
    if (app) {
      if (span) app.spans.push(span);
      if (event.kind === 0 && inRange) app.key_count++;
    }
  }
  for (const item of held) {
    // Include actual time held only while the live connection is valid.
    rawSpans.push([item.ts_ms, now_ms]);
    const app = groupFor(item.app);
    if (app) app.spans.push([item.ts_ms, now_ms]);
  }
  const active = clippedSpans(rawSpans, start_ms, limit);
  const activeMs = spanDuration(active, start_ms, limit);
  const apps = [];
  for (const [id, data] of appGroups) {
    const spans = clippedSpans(data.spans, start_ms, limit);
    const active_ms = spanDuration(spans, start_ms, limit);
    if (data.key_count || active_ms) apps.push({ id, name: id, key_count: data.key_count, active_ms });
  }
  apps.sort((a, b) => b.active_ms - a.active_ms || b.key_count - a.key_count || a.id.localeCompare(b.id));

  downs.sort((a,b)=>a-b);
  const days = [];
  for (let day = localMidnight(start_ms); day.getTime() < end_ms;) {
    const dayStart = day.getTime();
    const next = new Date(dayStart);
    next.setDate(next.getDate() + 1);
    const dayEnd = next.getTime();
    if (!(dayEnd > dayStart)) throw new RangeError('invalid local day');
    const buckets = [];
    for (let bucketStart = dayStart; bucketStart < dayEnd; bucketStart += BUCKET_MS) {
      buckets.push(spanDuration(active, bucketStart, Math.min(bucketStart + BUCKET_MS, dayEnd)));
    }
    days.push({
      date: dateKey(day),
      key_count: lowerBound(downs,dayEnd)-lowerBound(downs,dayStart),
      active_ms: spanDuration(active, dayStart, dayEnd),
      fn_ms: null,
      buckets,
    });
    day = next;
  }
  return { key_count: keyCount, active_ms: activeMs, fn_ms: null, keys, days, apps };
}

module.exports = { computeStats };
