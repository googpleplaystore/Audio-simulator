// Maps low-frequency subwoofer energy to device haptics: navigator.vibrate
// (mobile) and Gamepad dual-rumble actuators (desktop controllers). Emits
// 'pulse' events so the UI can visualise bass transients everywhere else.

import { Emitter } from '../util/emitter.js';

export class Haptics extends Emitter {
  constructor(engine, store) {
    super();
    this.engine = engine;
    this.store = store;
    this.buf = new Float32Array(1024);
    this.env = 0;
    this.avg = 0;
    this.lastPulse = 0;
    this.timer = null;
    this.supported = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
    this.level = 0;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this._tick(), 16);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.supported) navigator.vibrate(0);
  }

  _gamepads() {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return [];
    return [...navigator.getGamepads()].filter((g) => g && g.vibrationActuator);
  }

  _tick() {
    const tap = this.engine.taps && this.engine.taps.lfe;
    if (!tap || this.engine.ctx.state !== 'running') return;
    const cfg = this.store.get('haptics');
    tap.getFloatTimeDomainData(this.buf);
    let sq = 0;
    for (let i = 0; i < this.buf.length; i++) sq += this.buf[i] * this.buf[i];
    const rms = Math.sqrt(sq / this.buf.length);
    // Envelope follower (fast attack, slower release) and adaptive average.
    this.env = rms > this.env ? rms * 0.6 + this.env * 0.4 : this.env * 0.9 + rms * 0.1;
    this.avg = this.avg * 0.985 + rms * 0.015;
    const norm = Math.min(1, this.env * 6 * (cfg.intensity ?? 1));
    this.level = norm;
    const now = performance.now();
    const threshold = 0.02 + (cfg.threshold ?? 0.5) * 0.08;
    const onset = rms > this.avg * 1.5 && rms > threshold;
    if (onset && now - this.lastPulse > 70) {
      this.lastPulse = now;
      const strength = Math.min(1, (rms / Math.max(threshold, 1e-4)) * 0.35 * (cfg.intensity ?? 1));
      const ms = Math.round(18 + strength * 60);
      this.emit('pulse', { strength, ms });
      if (cfg.enabled) {
        if (this.supported) {
          try {
            navigator.vibrate(ms);
          } catch {
            /* requires user activation */
          }
        }
        if (cfg.gamepad) {
          for (const gp of this._gamepads()) {
            gp.vibrationActuator
              .playEffect('dual-rumble', { duration: ms + 20, strongMagnitude: strength, weakMagnitude: strength * 0.4 })
              .catch(() => {});
          }
        }
      }
    }
  }
}
