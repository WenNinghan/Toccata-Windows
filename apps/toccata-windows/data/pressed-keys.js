'use strict';

// An in-memory view of currently held physical keys. Device identities never
// leave this object; callers receive only a deduplicated list of mapped codes.
class PressedKeys {
  constructor() {
    this.devices = new Map();
    this.counts = new Map();
  }

  active() {
    return [...this.counts.keys()].sort((a, b) => a - b);
  }

  update(event) {
    if (!event || typeof event.device !== 'string' || !event.device ||
        !Number.isInteger(event.scan) || event.scan < 0 ||
        !Number.isInteger(event.ext) || event.ext < 0 ||
        !Number.isInteger(event.vkey) || event.vkey < 0 ||
        !(event.keycode === null || (Number.isSafeInteger(event.keycode) && event.keycode >= 0)) ||
        !['down', 'up', 0, 1].includes(event.kind)) {
      throw new TypeError('invalid physical key event');
    }
    const down = event.kind === 'down' || event.kind === 0;
    const physical = `${event.scan}:${event.ext}:${event.scan === 0 ? event.vkey : 0}`;
    let keys = this.devices.get(event.device);
    if (down) {
      if (!keys) { keys = new Map(); this.devices.set(event.device, keys); }
      if (!keys.has(physical)) {
        keys.set(physical, event.keycode);
        if (event.keycode !== null) this.counts.set(event.keycode, (this.counts.get(event.keycode) || 0) + 1);
      }
    } else if (keys?.has(physical)) {
      const code = keys.get(physical); // Use the identity saved at key-down.
      keys.delete(physical);
      if (!keys.size) this.devices.delete(event.device);
      this.release(code);
    }
    return this.active();
  }

  release(code) {
    if (code === null) return;
    const count = this.counts.get(code);
    if (count <= 1) this.counts.delete(code);
    else this.counts.set(code, count - 1);
  }

  reset(device = null) {
    if (device === null) {
      this.devices.clear();
      this.counts.clear();
    } else {
      if (typeof device !== 'string' || !device) throw new TypeError('invalid device');
      const keys = this.devices.get(device);
      if (keys) {
        for (const code of keys.values()) this.release(code);
        this.devices.delete(device);
      }
    }
    return this.active();
  }
}
module.exports = { PressedKeys };
