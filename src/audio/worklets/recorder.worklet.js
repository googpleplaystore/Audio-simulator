// AudioWorklet that captures stereo PCM and ships it to the main thread in
// ~0.1 s batches (fewer, larger messages keep the audio thread light).
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.active = false;
    this.batch = 4096;
    this.l = new Float32Array(this.batch);
    this.r = new Float32Array(this.batch);
    this.n = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'start') this.active = true;
      else if (e.data === 'stop') {
        this.flush();
        this.active = false;
        this.done = true; // let the processor be collected
      }
    };
  }

  flush() {
    if (!this.n) return;
    const l = this.l.slice(0, this.n);
    const r = this.r.slice(0, this.n);
    this.port.postMessage([l, r], [l.buffer, r.buffer]);
    this.n = 0;
  }

  process(inputs) {
    if (this.done) return false;
    if (!this.active) return true;
    const input = inputs[0];
    if (!input || !input.length) return true;
    const L = input[0];
    const R = input[1] || input[0];
    for (let i = 0; i < L.length; i++) {
      this.l[this.n] = L[i];
      this.r[this.n] = R[i];
      this.n++;
      if (this.n === this.batch) this.flush();
    }
    return true;
  }
}

registerProcessor('audiospace-recorder', RecorderProcessor);
