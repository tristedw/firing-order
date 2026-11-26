// Engine voice, audio thread side.
//
// The sim hands over the pressure in every header primary and intake runner at its own
// step rate (25 to 60 kHz, uneven). This resamples that to the audio rate and does what
// engine-sim's synthesizer does with it (ange-yaghi/engine-sim, MIT): pull the DC out,
// mix in a little of the derivative for edge, and modulate band limited noise with it
// so the flow sounds like moving air. The exhaust system itself is a convolution with a
// recorded impulse response, done after this node by a ConvolverNode.

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

const CH = 3; // left header, right header, intake

// circular fifo of audio rate samples, one per channel
class Fifo {
  buf: Float32Array[];
  r = 0;
  w = 0;
  n = 0;
  constructor(size: number) {
    this.buf = Array.from({ length: CH }, () => new Float32Array(size));
  }
  get size() {
    return this.buf[0].length;
  }
  push(v: number[]) {
    if (this.n >= this.size) this.drop(1);
    for (let c = 0; c < CH; c++) this.buf[c][this.w] = v[c];
    this.w = (this.w + 1) % this.size;
    this.n++;
  }
  drop(k: number) {
    k = Math.min(k, this.n);
    this.r = (this.r + k) % this.size;
    this.n -= k;
  }
}

// 2 pole butterworth lowpass
class LP {
  b0 = 0;
  b1 = 0;
  b2 = 0;
  a1 = 0;
  a2 = 0;
  x1 = 0;
  x2 = 0;
  y1 = 0;
  y2 = 0;
  constructor(f: number) {
    const w = (2 * Math.PI * Math.min(f, sampleRate * 0.45)) / sampleRate;
    const al = Math.sin(w) / Math.SQRT2;
    const c = Math.cos(w);
    const a0 = 1 + al;
    this.b0 = (1 - c) / 2 / a0;
    this.b1 = (1 - c) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * c) / a0;
    this.a2 = (1 - al) / a0;
  }
  run(x: number) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

interface Chan {
  dc: number;
  prev: number;
  noise: LP;
  jit: Float32Array;
  ji: number;
  jlp: LP;
  aa: LP; // engine-sim runs its input through a 1.9 kHz antialias before anything else
}

class EngineVoice extends AudioWorkletProcessor {
  fifo = new Fifo(Math.ceil(sampleRate * 0.5));
  acc = 0; // fractional audio samples owed
  last = [0, 0, 0];
  chans: Chan[] = [];
  peak = [0.05, 0.05];
  gainSm = [1, 1];
  on = 0;
  onTarget = 0;
  noiseAmt = 0.75; // engine-sim's "air noise"
  dfMix = 0.012; // how much derivative, engine-sim's high frequency gain
  jitter = 0.4;
  maxGain = 60;
  seed = 12345;

  constructor() {
    super();
    for (let c = 0; c < CH; c++) {
      this.chans.push({ dc: 0, prev: 0, noise: new LP(2000), jit: new Float32Array(10), ji: 0, jlp: new LP(10000), aa: new LP(1900) });
    }
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === 'flow') this.take(m.dt, [m.a, m.b, m.c], m.scale);
      else if (m.type === 'params') {
        this.noiseAmt = m.noise;
        this.dfMix = m.df;
        this.jitter = m.jitter;
        this.maxGain = m.maxGain;
      } else if (m.type === 'on') this.onTarget = m.on ? 1 : 0;
    };
  }

  rand() {
    let x = this.seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.seed = x | 0;
    return (x >>> 0) / 4294967296;
  }

  // resample the sim's uneven steps onto the audio clock by linear interpolation
  take(dt: Float32Array, ch: Float32Array[], scale: number) {
    const k = sampleRate / Math.max(1e-4, scale);
    const v = [0, 0, 0];
    for (let i = 0; i < dt.length; i++) {
      const span = dt[i] * k;
      this.acc += span;
      while (this.acc >= 1) {
        const f = span > 0 ? Math.min(1, (span - (this.acc - 1)) / span) : 1;
        for (let c = 0; c < CH; c++) v[c] = this.last[c] + (ch[c][i] - this.last[c]) * f;
        this.fifo.push(v);
        this.acc -= 1;
      }
      for (let c = 0; c < CH; c++) this.last[c] = ch[c][i];
    }
    // keep latency bounded, the sim runs in frame sized lumps
    const maxLag = Math.ceil(sampleRate * 0.12);
    if (this.fifo.n > maxLag) this.fifo.drop(this.fifo.n - Math.ceil(sampleRate * 0.06));
  }

  process(_in: Float32Array[][], outputs: Float32Array[][]) {
    const ex = outputs[0];
    const inn = outputs[1];
    const n = ex[0].length;
    const f = this.fifo;
    const dtA = 1 / sampleRate;
    const raw = [0, 0, 0];
    const out = [0, 0, 0];
    for (let s = 0; s < n; s++) {
      this.on += (this.onTarget - this.on) * 0.0005;
      if (f.n > 0) {
        raw[0] = f.buf[0][f.r];
        raw[1] = f.buf[1][f.r];
        raw[2] = f.buf[2][f.r];
        f.drop(1);
      } else raw[0] = raw[1] = raw[2] = 0;
      for (let c = 0; c < CH; c++) {
        const ch = this.chans[c];
        // a little timing jitter, real combustion never lands on the same spot twice
        ch.jit[ch.ji] = ch.aa.run(raw[c]);
        ch.ji = (ch.ji + 1) % ch.jit.length;
        const js = Math.max(0, Math.min(8.99, ch.jlp.run(this.rand() * 9 * this.jitter)));
        const j0 = Math.floor(js);
        const jf = js - j0;
        const a = ch.jit[(ch.ji + 9 - j0) % 10];
        const b = ch.jit[(ch.ji + 9 - (j0 + 1)) % 10];
        const x = (a * (1 - jf) + b * jf) / 1e5; // Pa to bar
        ch.dc += (x - ch.dc) * (2 * Math.PI * 10 * dtA);
        const fl = x - ch.dc;
        const fp = (x - ch.prev) / dtA;
        ch.prev = x;
        const r = ch.noise.run(this.rand() * 2 - 1) * 2.2;
        const rm = this.noiseAmt * r + (1 - this.noiseAmt);
        out[c] = fp * this.dfMix + fl * rm * (1 - this.dfMix);
      }
      // level it like engine-sim does: chase a target from the running peak, within limits
      for (let k = 0; k < 2; k++) {
        const src = k === 0 ? Math.abs(out[0]) + Math.abs(out[1]) : Math.abs(out[2]);
        this.peak[k] = Math.max(src, this.peak[k] * 0.99985);
        // partial leveling: keeps the jump from idle to full throttle, just not 25 dB of it
        const g = Math.min(this.maxGain, 0.12 * Math.pow(Math.max(1e-4, this.peak[k]), -0.78));
        this.gainSm[k] += (g - this.gainSm[k]) * 0.0004;
      }
      ex[0][s] = out[0] * this.gainSm[0] * this.on;
      ex[1][s] = out[1] * this.gainSm[0] * this.on;
      if (inn) inn[0][s] = out[2] * this.gainSm[1] * this.on;
    }
    return true;
  }
}

registerProcessor('engine-voice', EngineVoice);
