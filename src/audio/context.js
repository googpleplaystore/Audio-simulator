// AudioContext lifecycle: creation, autoplay-policy unlocking on the first
// user gesture, recovery from OS interruptions (iOS "interrupted" state,
// Bluetooth route changes) and state reporting for the UI.

import { Emitter } from '../util/emitter.js';

export class AudioSystem extends Emitter {
  constructor() {
    super();
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) throw new Error('Web Audio API is not supported in this browser.');
    this.ctx = new Ctor({ latencyHint: 'playback' });
    this.wantRunning = false;
    this.ctx.addEventListener('statechange', () => this.emit('state', this.ctx.state));
    this._installUnlock();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.wantRunning && this.ctx.state !== 'running') {
        this.ctx.resume().catch(() => {});
      }
    });
  }

  get state() {
    return this.ctx.state;
  }

  get running() {
    return this.ctx.state === 'running';
  }

  /** Resume the context — call from within a user gesture handler. */
  async unlock() {
    this.wantRunning = true;
    if (this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
      } catch (err) {
        console.warn('[audio] resume failed', err);
      }
    }
    return this.ctx.state === 'running';
  }

  _installUnlock() {
    const handler = () => {
      this.unlock().then((ok) => {
        if (ok) {
          for (const t of ['pointerdown', 'keydown', 'touchend']) window.removeEventListener(t, handler, true);
        }
      });
    };
    for (const t of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(t, handler, true);
  }
}
