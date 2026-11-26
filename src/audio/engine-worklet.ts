// Engine voice, audio thread side. Three ways of making the noise, picked per engine.
//
// 'grain' (piston engines with a recording): real engine recordings cut into short grains,
// each tagged with the rpm and throttle it was recorded at (see public/audio/banks). Every
// grain picks the closest match to where the sim is and gets resampled to the exact rpm,
// overlap added back to back. Exhaust events from the sim still shape the level, so a
// misfire or a lumpy cam shows up on top of the recording.
//
// 'ptr' (piston engines): a pulse train lined up with the firing order, one pulse per
// exhaust opening, sized by what the sim says that cylinder blew down. Each pulse is an
// exponentially decaying harmonic series under an attack/decay envelope, bent down in
// pitch as it goes, roughened with turbulence noise, then run through Karplus-Strong
// resonators: one per bank for the headers and one shared for the tailpipe. After
// Doerfler and Wyse, "Physics-Informed Neural Engine Sound Modeling with Differentiable
// Pulse-Train Synthesis" (EUSIPCO 2026).
//
// 'flow' (rotaries): the sim's header pressure itself, turned into flow noise the way
// engine-sim does (ange-yaghi/engine-sim, MIT) and convolved with a recorded exhaust
// after this node.
//
// Both read the same stream from the sim, resampled from its uneven steps to the audio
// clock, so a misfire or a backfire lands on the exact cycle it happened in the sim.

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

const CH = 3; // left header, right header, intake
const TWO_PI = Math.PI * 2;

class Fifo {
  buf: Float32Array[];
  tc: Int16Array; // trigger cylinder per audio sample, -1 none
  ta: Float32Array;
  r = 0;
  w = 0;
  n = 0;
  constructor(size: number) {
    this.buf = Array.from({ length: CH }, () => new Float32Array(size));
    this.tc = new Int16Array(size).fill(-1);
    this.ta = new Float32Array(size);
  }
  get size() {
    return this.tc.length;
  }
  push(v: number[], tc: number, ta: number) {
    if (this.n >= this.size) this.drop(1);
    for (let c = 0; c < CH; c++) this.buf[c][this.w] = v[c];
    this.tc[this.w] = tc;
    this.ta[this.w] = ta;
    this.w = (this.w + 1) % this.size;
    this.n++;
  }
  drop(k: number) {
    k = Math.min(k, this.n);
    this.r = (this.r + k) % this.size;
    this.n -= k;
  }
}

class LP {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
  x1 = 0;
  x2 = 0;
  y1 = 0;
  y2 = 0;
  constructor(f: number, hp = false) {
    const w = (TWO_PI * Math.min(f, sampleRate * 0.45)) / sampleRate;
    const al = Math.sin(w) / Math.SQRT2;
    const c = Math.cos(w);
    const a0 = 1 + al;
    if (hp) {
      this.b0 = (1 + c) / 2 / a0;
      this.b1 = -(1 + c) / a0;
    } else {
      this.b0 = (1 - c) / 2 / a0;
      this.b1 = (1 - c) / a0;
    }
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

// y[n] = x[n] + g (a y[n-L] + b y[n-L-1]). a pipe that rings at sampleRate / L
class KS {
  buf: Float32Array;
  i = 0;
  constructor(
    public L: number,
    public g: number,
    public a = 0.5,
    public b = 0.5,
  ) {
    this.buf = new Float32Array(Math.max(4, Math.round(L)) + 2);
  }
  run(x: number) {
    const n = this.buf.length;
    const L = n - 2;
    const d0 = this.buf[(this.i - L + n * 4) % n];
    const d1 = this.buf[(this.i - L - 1 + n * 4) % n];
    const y = x + this.g * (this.a * d0 + this.b * d1);
    this.buf[this.i] = y;
    this.i = (this.i + 1) % n;
    return y;
  }
}

interface Bank {
  buf: Float32Array;
  sr: number;
  n: number; // cylinders on the engine it was recorded from
  t: Float32Array;
  P: Float32Array;
  rpm: Float32Array;
  ld: Float32Array;
  g: Float32Array;
  byRpm: Int32Array; // mark indices sorted by rpm
}

interface Grain {
  pos: number; // source sample
  inc: number;
  i: number;
  len: number;
  amp: number;
}

interface Pulse {
  phi: number; // radians since the exhaust opened, of a full cycle
  amp: number;
  bank: number;
  pop: boolean;
}

interface FlowChan {
  dc: number;
  prev: number;
  noise: LP;
  aa: LP;
}

class EngineVoice extends AudioWorkletProcessor {
  fifo = new Fifo(Math.ceil(sampleRate * 0.5));
  acc = 0;
  last = [0, 0, 0];
  pendT = -1;
  pendA = 0;
  mode: 'ptr' | 'flow' | 'grain' = 'ptr';
  bank: Bank | null = null;
  grains: Grain[] = [];
  nextGrain = 0;
  cur = -1;
  nCyl = 8;
  taAvg = 0.3;
  fireEnv = 1;
  fireEnvT = 1;
  banks: number[] = [];
  pulses: Pulse[] = [];
  cps = 0;
  cpsT = 0;
  gThr = 0.1;
  gThrT = 0.1;
  gDfco = 0;
  gDfcoT = 0;
  on = 0;
  onT = 0;
  // ptr parameters
  attack = 30;
  decay = 2.6;
  lambda = 0.12;
  bend = 0.86;
  turb = 0.5;
  bankKS: KS[] = [new KS(160, 0.55), new KS(171, 0.55)];
  tailKS = new KS(520, 0.45);
  noiseB1 = new LP(900);
  noiseB2 = new LP(3500);
  hpL = new LP(28, true);
  hpR = new LP(28, true);
  // flow parameters
  flow: FlowChan[] = [];
  noiseAmt = 0.6;
  dfMix = 0.012;
  peak = [0.05, 0.05];
  gain = [1, 1];
  seed = 987654;

  constructor() {
    super();
    for (let c = 0; c < CH; c++) this.flow.push({ dc: 0, prev: 0, noise: new LP(2000), aa: new LP(1900) });
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === 'flow') this.take(m);
      else if (m.type === 'state') {
        this.cpsT = m.cps;
        this.gThrT = m.gThr;
        this.gDfcoT = m.gDfco;
        this.onT = m.on ? 1 : 0;
      } else if (m.type === 'bank') {
        this.bank = m.bank;
        this.grains = [];
        this.cur = -1;
      } else if (m.type === 'config') {
        this.mode = m.mode;
        this.nCyl = m.nCyl ?? this.nCyl;
        this.banks = m.banks;
        this.attack = m.attack;
        this.decay = m.decay;
        this.lambda = m.lambda;
        this.bend = m.bend;
        this.turb = m.turb;
        this.noiseAmt = m.noise;
        this.dfMix = m.df;
        const sr = sampleRate;
        this.bankKS = [new KS(sr / m.headerHz, m.headerFb, 0.55, 0.45), new KS(sr / (m.headerHz * 0.94), m.headerFb, 0.55, 0.45)];
        this.tailKS = new KS(sr / m.tailHz, m.tailFb, 0.6, 0.4);
        this.pulses = [];
      }
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

  take(m: { dt: Float32Array; a: Float32Array; b: Float32Array; c: Float32Array; tc: Float32Array; ta: Float32Array; scale: number }) {
    const k = sampleRate / Math.max(1e-4, m.scale);
    const ch = [m.a, m.b, m.c];
    const v = [0, 0, 0];
    for (let i = 0; i < m.dt.length; i++) {
      if (m.tc[i] >= 0) {
        this.pendT = m.tc[i];
        this.pendA = m.ta[i];
      }
      const span = m.dt[i] * k;
      this.acc += span;
      while (this.acc >= 1) {
        const f = span > 0 ? Math.min(1, (span - (this.acc - 1)) / span) : 1;
        for (let c = 0; c < CH; c++) v[c] = this.last[c] + (ch[c][i] - this.last[c]) * f;
        this.fifo.push(v, this.pendT, this.pendA);
        this.pendT = -1;
        this.acc -= 1;
      }
      for (let c = 0; c < CH; c++) this.last[c] = ch[c][i];
    }
    if (this.fifo.n > Math.ceil(sampleRate * 0.12)) this.fifo.drop(this.fifo.n - Math.ceil(sampleRate * 0.06));
  }

  // one sample of all live pulses for one bank
  ptrSample(): [number, number] {
    const out: [number, number] = [0, 0];
    const r = Math.exp(-0.5 * this.lambda);
    const dphi = (TWO_PI * this.cps) / sampleRate;
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const p = this.pulses[i];
      const phi = p.phi;
      const att = p.pop ? this.attack * 3 : this.attack;
      const dec = p.pop ? this.decay * 0.45 : this.decay;
      const env = (1 - Math.exp(-att * phi)) * Math.exp(-dec * phi);
      // pitch bends down through the pulse as the gas cools
      const x = TWO_PI * Math.pow(phi / TWO_PI, p.pop ? 0.7 : this.bend);
      const cx = Math.cos(x);
      // closed form of sum over k of r^k sin(k x)
      const series = (r * Math.sin(x)) / (1 - 2 * r * cx + r * r);
      let s = env * p.amp * series * (1 - r) * (1 - r) * 4;
      const eta = this.rand() * 2 - 1;
      s *= 1 + this.turb * this.gThr * eta * (p.pop ? 2 : 1);
      out[p.bank] += s;
      p.phi += p.pop ? Math.max(dphi, TWO_PI * 6 / sampleRate) : dphi;
      if (p.phi > Math.min(TWO_PI * 0.9, 7 / dec)) this.pulses.splice(i, 1);
    }
    return out;
  }

  // the mark closest to the rpm and throttle we want, with a little randomness so a steady
  // rpm doesn't loop the same few grains
  pickGrain(b: Bank, rpmEq: number, load: number) {
    const M = b.byRpm.length;
    let lo = 0;
    let hi = M - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (b.rpm[b.byRpm[mid]] < rpmEq) lo = mid + 1;
      else hi = mid;
    }
    let best = b.byRpm[Math.min(lo, M - 1)];
    let bc = 1e9;
    const a = Math.max(0, lo - 80);
    const z = Math.min(M, lo + 80);
    for (let k = a; k < z; k++) {
      const j = b.byRpm[k];
      const c = Math.abs(Math.log(b.rpm[j] / rpmEq)) + 0.3 * Math.abs(b.ld[j] - load) + this.rand() * 0.06;
      if (c < bc) {
        bc = c;
        best = j;
      }
    }
    return best;
  }

  grainSample(): number {
    const b = this.bank!;
    const rpm = this.cps * 120;
    if (this.on > 0.01 && rpm > 30) {
      this.nextGrain--;
      if (this.nextGrain <= 0) {
        const rpmEq = (rpm * this.nCyl) / b.n;
        const load = this.gDfco > 0.05 ? 0 : Math.min(1, this.gThr * 1.1);
        let j = this.cur + 1;
        // keep reading the recording forward while it still fits, jump when it doesn't
        if (
          this.cur < 0 ||
          j >= b.t.length ||
          b.t[j] - b.t[this.cur] > b.P[this.cur] * 2 ||
          Math.abs(Math.log(b.rpm[j] / rpmEq)) > 0.09 ||
          Math.abs(b.ld[j] - load) > 0.45 ||
          this.rand() < 0.015
        )
          j = this.pickGrain(b, rpmEq, load);
        this.cur = j;
        const r = Math.min(5, Math.max(0.4, rpmEq / b.rpm[j]));
        const inc = (r * b.sr) / sampleRate;
        const half = b.P[j] * b.sr;
        const len = Math.max(8, Math.round((2 * half) / inc));
        this.grains.push({ pos: b.t[j] * b.sr - half, inc, i: 0, len, amp: Math.pow(b.g[j], 0.7) });
        this.nextGrain = len / 2;
      }
    }
    let y = 0;
    const buf = b.buf;
    for (let k = this.grains.length - 1; k >= 0; k--) {
      const gr = this.grains[k];
      const p = gr.pos;
      const i0 = Math.floor(p);
      if (i0 >= 0 && i0 + 1 < buf.length) {
        const fr = p - i0;
        const w = 0.5 - 0.5 * Math.cos((TWO_PI * gr.i) / gr.len);
        y += (buf[i0] + (buf[i0 + 1] - buf[i0]) * fr) * w * gr.amp;
      }
      gr.pos += gr.inc;
      gr.i++;
      if (gr.i >= gr.len) this.grains.splice(k, 1);
    }
    return y;
  }

  process(_in: Float32Array[][], outputs: Float32Array[][]) {
    const ex = outputs[0];
    const inn = outputs[1];
    const n = ex[0].length;
    const f = this.fifo;
    const dtA = 1 / sampleRate;
    const raw = [0, 0, 0];
    const fo = [0, 0, 0];
    for (let s = 0; s < n; s++) {
      this.on += (this.onT - this.on) * 0.0005;
      this.cps += (this.cpsT - this.cps) * 0.002;
      this.gThr += (this.gThrT - this.gThr) * 0.0008;
      this.gDfco += (this.gDfcoT - this.gDfco) * 0.0008;
      let tc = -1;
      let ta = 0;
      if (f.n > 0) {
        raw[0] = f.buf[0][f.r];
        raw[1] = f.buf[1][f.r];
        raw[2] = f.buf[2][f.r];
        tc = f.tc[f.r];
        ta = f.ta[f.r];
        f.drop(1);
      } else raw[0] = raw[1] = raw[2] = 0;

      // flow noise for the intake always, and the exhaust too in flow mode
      for (let c = 0; c < CH; c++) {
        const ch = this.flow[c];
        const x = ch.aa.run(raw[c]) / 1e5;
        ch.dc += (x - ch.dc) * (TWO_PI * 10 * dtA);
        const fl = x - ch.dc;
        const fp = (x - ch.prev) / dtA;
        ch.prev = x;
        const rr = ch.noise.run(this.rand() * 2 - 1) * 2.2;
        const rm = this.noiseAmt * rr + (1 - this.noiseAmt);
        fo[c] = fp * this.dfMix + fl * rm * (1 - this.dfMix);
      }

      let l = 0;
      let r = 0;
      if (this.mode === 'grain' && this.bank) {
        // each exhaust event nudges the level by how hard that cylinder actually blew down
        if (tc >= 0 && tc < 100) {
          this.taAvg += (ta - this.taAvg) * 0.04;
          this.fireEnvT = Math.min(1.25, Math.max(0.12, ta / Math.max(1e-3, this.taAvg)));
        }
        this.fireEnv += (Math.sqrt(this.fireEnvT) - this.fireEnv) * 0.01;
        const rpm = this.cps * 120;
        const lvl = (0.3 + 0.7 * Math.min(1, this.gThr)) * (0.65 + 0.35 * Math.min(1, rpm / 5000)) * (1 - 0.35 * this.gDfco);
        const y = this.grainSample() * lvl * this.fireEnv * 0.55;
        l = y;
        r = y;
        ex[0][s] = l * this.on;
        ex[1][s] = r * this.on;
        if (inn) inn[0][s] = 0;
        continue;
      }
      if (this.mode === 'ptr') {
        if (tc >= 0) {
          const pop = tc >= 100;
          const cyl = pop ? tc - 100 : tc;
          this.pulses.push({ phi: 0, amp: pop ? 1.5 + ta * 2 : 0.12 + ta, bank: this.banks[cyl] ?? 0, pop });
        }
        const [b0, b1] = this.ptrSample();
        // air rushing through on overrun with the fuel cut
        const eta = this.noiseB1.run(this.rand() * 2 - 1) * 0.6 + this.noiseB2.run(this.rand() * 2 - 1) * 0.3;
        const air = eta * this.gDfco * 0.05;
        const h0 = this.bankKS[0].run(b0 + air);
        const h1 = this.bankKS[1].run(b1 + air);
        const t = this.tailKS.run((h0 + h1) * 0.5);
        l = this.hpL.run(h0 * 0.6 + t * 0.7);
        r = this.hpR.run(h1 * 0.6 + t * 0.7);
      } else {
        if (tc >= 100) {
          // a backfire in a rotary: kick the flow signal hard for a moment
          fo[0] += ta * 4;
          fo[1] += ta * 4;
        }
        l = fo[0];
        r = fo[1];
      }
      // leveling, partial so idle still sits under full throttle
      for (let k = 0; k < 2; k++) {
        const src = k === 0 ? Math.abs(l) + Math.abs(r) : Math.abs(fo[2]);
        this.peak[k] = Math.max(src, this.peak[k] * 0.99985);
        const g = Math.min(200, 0.3 * Math.pow(Math.max(1e-4, this.peak[k]), -0.62));
        this.gain[k] += (g - this.gain[k]) * 0.0004;
      }
      ex[0][s] = l * this.gain[0] * this.on;
      ex[1][s] = r * this.gain[0] * this.on;
      if (inn) inn[0][s] = fo[2] * this.gain[1] * this.on;
    }
    return true;
  }
}

registerProcessor('engine-voice', EngineVoice);
