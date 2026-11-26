// Engine voice, audio thread side.
//
// The sim streams, per step, the acoustic wave each bank's exhaust valves push into the
// headers (c times mass flow over port area), the same for the intake runners, and every
// exhaust opening and backfire. This turns that into what you'd hear standing behind the
// car, the same way for every engine, piston or rotary:
//
//   valves -> headers (one waveguide per bank) -> collector -> pipe -> muffler -> tailpipe
//   -> radiation off the tip, with a little gas turbulence riding on the flow
//
// The waveguides are pairs of delay lines with lossy, lowpassed reflections at the ends,
// after Baldan et al., "Physically informed car engine sound synthesis for virtual and
// augmented environments" (2015). The input conditioning (antialias around 2 kHz, DC
// removal, flow noise riding on the signal) follows engine-sim (ange-yaghi/engine-sim).
// Sound off an open pipe end goes with the rate of change of flow, so a share of the
// derivative gets mixed in at the tip.
//
// Ears first: nothing here can step or click. The sim stream is read with a slightly
// stretchy read head instead of dropping samples, levels move slowly, and the end of the
// chain is a soft saturator, so a backfire can be loud without ever being a hard edge.

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

const CH = 3; // left bank, right bank, intake
const TWO_PI = Math.PI * 2;

// ring of audio rate samples from the sim, read back at a slightly variable rate so the
// fill level drifts back to target without skipping
class Fifo {
  buf: Float32Array[];
  tc: Int16Array;
  ta: Float32Array;
  w = 0;
  r = 0; // fractional read position
  constructor(public size: number) {
    this.buf = Array.from({ length: CH }, () => new Float32Array(size));
    this.tc = new Int16Array(size).fill(-1);
    this.ta = new Float32Array(size);
  }
  get fill() {
    let d = this.w - this.r;
    if (d < 0) d += this.size;
    return d;
  }
  push(v: number[], tc: number, ta: number) {
    const i = this.w;
    for (let c = 0; c < CH; c++) this.buf[c][i] = v[c];
    this.tc[i] = tc;
    this.ta[i] = ta;
    this.w = (i + 1) % this.size;
    if (this.fill > this.size - 4) this.r = (this.r + 1) % this.size;
  }
}

class Biquad {
  b0 = 1;
  b1 = 0;
  b2 = 0;
  a1 = 0;
  a2 = 0;
  x1 = 0;
  x2 = 0;
  y1 = 0;
  y2 = 0;
  static lp(f: number, q = Math.SQRT1_2) {
    return new Biquad().set('lp', f, q);
  }
  static hp(f: number, q = Math.SQRT1_2) {
    return new Biquad().set('hp', f, q);
  }
  static bp(f: number, q: number) {
    return new Biquad().set('bp', f, q);
  }
  set(type: 'lp' | 'hp' | 'bp', f: number, q: number) {
    const w = (TWO_PI * Math.min(f, sampleRate * 0.45)) / sampleRate;
    const al = Math.sin(w) / (2 * q);
    const c = Math.cos(w);
    const a0 = 1 + al;
    if (type === 'lp') {
      this.b0 = (1 - c) / 2 / a0;
      this.b1 = (1 - c) / a0;
      this.b2 = this.b0;
    } else if (type === 'hp') {
      this.b0 = (1 + c) / 2 / a0;
      this.b1 = -(1 + c) / a0;
      this.b2 = this.b0;
    } else {
      this.b0 = al / a0;
      this.b1 = 0;
      this.b2 = -al / a0;
    }
    this.a1 = (-2 * c) / a0;
    this.a2 = (1 - al) / a0;
    return this;
  }
  run(x: number) {
    let y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    if (y < 1e-20 && y > -1e-20) y = 0;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

// one pole lowpass, used inside reflections so the highs leave the pipe instead of ringing
class OnePole {
  a: number;
  y = 0;
  constructor(f: number) {
    this.a = 1 - Math.exp((-TWO_PI * f) / sampleRate);
  }
  run(x: number) {
    this.y += (x - this.y) * this.a;
    if (this.y < 1e-20 && this.y > -1e-20) this.y = 0;
    return this.y;
  }
}

class Delay {
  buf: Float32Array;
  i = 0;
  constructor(public d: number) {
    this.buf = new Float32Array(Math.ceil(d) + 4);
  }
  write(x: number) {
    this.buf[this.i] = x;
    this.i = (this.i + 1) % this.buf.length;
  }
  // value written d samples ago, linear between samples
  read() {
    const n = this.buf.length;
    const p = this.i - 1 - this.d;
    const i0 = Math.floor(p);
    const f = p - i0;
    const a = this.buf[((i0 % n) + n) % n];
    const b = this.buf[(((i0 + 1) % n) + n) % n];
    return a + (b - a) * f;
  }
}

// a length of pipe: right going and left going waves, reflections at both ends.
// rIn reflects back at the input end (a mostly shut valve, a junction), rOut at the far
// end (negative for an open end or a big volume) through a lowpass, since the highs
// mostly get out. returns what is transmitted out of the far end
class Pipe {
  fwd: Delay;
  bwd: Delay;
  lpOut: OnePole;
  lpIn: OnePole;
  constructor(
    seconds: number,
    public rIn: number,
    public rOut: number,
    fOut: number,
    public loss = 0.985,
  ) {
    const d = Math.max(2, seconds * sampleRate);
    this.fwd = new Delay(d);
    this.bwd = new Delay(d);
    this.lpOut = new OnePole(fOut);
    this.lpIn = new OnePole(fOut * 1.5);
  }
  run(x: number) {
    const atEnd = this.fwd.read() * this.loss;
    const atStart = this.bwd.read() * this.loss;
    const refl = this.lpOut.run(atEnd) * this.rOut;
    this.bwd.write(refl);
    this.fwd.write(x + this.lpIn.run(atStart) * this.rIn);
    return atEnd - refl;
  }
}

// linear for normal levels, rounds off smoothly above that and never passes 1
function soft(x: number) {
  const a = Math.abs(x);
  if (a < 0.6) return x;
  const s = x < 0 ? -1 : 1;
  return s * (0.6 + 0.4 * Math.tanh((a - 0.6) / 0.4));
}

interface Pop {
  t: number; // samples since it went off
  amp: number;
  tau: number; // decay, samples
  next: number; // when the next, smaller crackle goes
  left: number;
}

export interface VoiceCfg {
  nCyl: number;
  header: number; // seconds one way, primaries plus collector
  pipe: number;
  tail: number;
  runner: number;
  muffler: number; // Hz, lowpass inside the muffler. open pipes high, a quiet car low
  chamber: number; // expansion chamber cancellation 0..1
  turb: number;
  radiate: number; // share of derivative at the tip
  jet: number; // hiss off the tip
  level: number;
  intake: number;
}

class EngineVoice extends AudioWorkletProcessor {
  fifo = new Fifo(Math.ceil(sampleRate * 1.0));
  acc = 0;
  last = [0, 0, 0];
  pendT = -1;
  pendA = 0;
  target = Math.round(sampleRate * 0.07);
  started = false;
  jump = false;
  seed = 987654;

  gThr = 0.1;
  gThrT = 0.1;
  gDfco = 0;
  gDfcoT = 0;
  on = 0;
  onT = 0;
  fade = 0;
  fadeT = 1;

  cfg: VoiceCfg = {
    nCyl: 4,
    header: 0.0018,
    pipe: 0.005,
    tail: 0.0012,
    runner: 0.0006,
    muffler: 1400,
    chamber: 0.5,
    turb: 0.15,
    radiate: 0.35,
    jet: 0.3,
    level: 1,
    intake: 0.1,
  };

  aa: Biquad[] = [];
  dc: Biquad[] = [];
  heads: Pipe[] = [];
  main!: Pipe;
  tailP!: Pipe;
  muf1!: Biquad;
  chamberD!: Delay;
  intakeP!: Pipe;
  inLp!: Biquad;
  inHp!: Biquad;
  turbBp!: Biquad;
  turbLp!: Biquad;
  jetHp!: Biquad;
  jetLp!: Biquad;
  jetEnv = 0;
  outHp: Biquad[] = [];
  outLp: Biquad[] = [];
  prevTip = 0;
  pops: Pop[] = [];
  popLp!: Biquad;

  // slow level follower and the gain it drives
  env = 1e-3;
  gain = 1;

  constructor() {
    super();
    this.build();
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === 'flow') this.take(m);
      else if (m.type === 'state') {
        this.gThrT = m.gThr;
        this.gDfcoT = m.gDfco;
        this.onT = m.on ? 1 : 0;
      } else if (m.type === 'config') {
        this.cfg = { ...this.cfg, ...m.cfg };
        this.build();
        this.fade = 0;
      }
    };
  }

  build() {
    const c = this.cfg;
    this.aa = [Biquad.lp(3800), Biquad.lp(3800), Biquad.lp(1600)];
    this.dc = [Biquad.hp(20), Biquad.hp(20), Biquad.hp(25)];
    // primaries: the valve end mostly reflects, the collector is a big step in area
    this.heads = [new Pipe(c.header, 0.45, -0.55, 2500), new Pipe(c.header * 1.04, 0.45, -0.55, 2500)];
    this.main = new Pipe(c.pipe, 0.25, -0.35, 1500, 0.99);
    this.muf1 = Biquad.lp(c.muffler, 0.6);
    this.chamberD = new Delay(Math.max(4, sampleRate * 0.0011));
    this.tailP = new Pipe(c.tail, 0.3, -0.6, 1800);
    this.intakeP = new Pipe(c.runner, 0.5, -0.6, 1600);
    this.inLp = Biquad.lp(1400, 0.6);
    this.inHp = Biquad.hp(60);
    this.turbBp = Biquad.bp(1300, 0.7);
    this.turbLp = Biquad.lp(3500);
    this.jetHp = Biquad.hp(500, 0.6);
    this.jetLp = Biquad.lp(5000, 0.6);
    this.outHp = [Biquad.hp(32), Biquad.hp(32)];
    this.outLp = [Biquad.lp(9000, 0.6), Biquad.lp(9000, 0.6)];
    this.popLp = Biquad.lp(1800, 0.6);
    this.pops = [];
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
  }

  // one sample of the sim stream. the read rate leans up to 2% to hold latency near
  // target. way behind (the tab was hidden) it fades out, jumps, fades back in
  readIn(raw: number[]): [number, number] {
    const f = this.fifo;
    const fill = f.fill;
    if (!this.started) {
      if (fill < this.target) return [-1, 0];
      this.started = true;
    }
    if (fill > sampleRate * 0.4 && !this.jump) {
      this.jump = true;
      this.fadeT = 0;
    }
    if (this.jump && this.fade <= 0) {
      f.r = (f.w - this.target + f.size) % f.size;
      for (let j = 0; j < f.size; j++) f.tc[j] = -1;
      this.jump = false;
      this.fadeT = 1;
    }
    // starved: hold the last value, the DC blockers settle it quietly
    if (fill < 2) return [-1, 0];
    const rate = Math.min(1.02, Math.max(0.98, 1 + ((fill - this.target) / this.target) * 0.02));
    const i0 = Math.floor(f.r);
    const fr = f.r - i0;
    const i1 = (i0 + 1) % f.size;
    for (let c = 0; c < CH; c++) raw[c] = f.buf[c][i0] + (f.buf[c][i1] - f.buf[c][i0]) * fr;
    let tc = -1;
    let ta = 0;
    const end = f.r + rate;
    for (let p = Math.ceil(f.r); p < end; p++) {
      const j = p % f.size;
      if (f.tc[j] >= 0) {
        tc = f.tc[j];
        ta = f.ta[j];
        f.tc[j] = -1;
      }
    }
    f.r = end % f.size;
    return [tc, ta];
  }

  process(_in: Float32Array[][], outputs: Float32Array[][]) {
    const ex = outputs[0];
    const inn = outputs[1];
    const n = ex[0].length;
    const c = this.cfg;
    const raw = this.last.slice();
    const dtA = 1 / sampleRate;
    const envA = 1 - Math.exp(-dtA / 0.25);
    const envR = 1 - Math.exp(-dtA / 1.5);
    const fadeStep = dtA / 0.03;
    for (let s = 0; s < n; s++) {
      this.on += (this.onT - this.on) * 0.0005;
      this.gThr += (this.gThrT - this.gThr) * 0.0008;
      this.gDfco += (this.gDfcoT - this.gDfco) * 0.0008;
      this.fade += Math.max(-fadeStep, Math.min(fadeStep, this.fadeT - this.fade));

      const [tc, ta] = this.readIn(raw);

      // condition the valve signals: scale, antialias, drop DC
      const x0 = this.dc[0].run(this.aa[0].run(raw[0] / 1e5));
      const x1 = this.dc[1].run(this.aa[1].run(raw[1] / 1e5));
      const xi = this.dc[2].run(this.aa[2].run(raw[2] / 1e5));

      // gas tearing through the valves: noise riding on the flow, more of it with load,
      // and a breath of it on overrun with the fuel cut
      const flowMag = Math.abs(x0) + Math.abs(x1);
      const nz = this.turbLp.run(this.turbBp.run(this.rand() * 2 - 1));
      const turb = nz * (flowMag * c.turb * (0.35 + 0.65 * Math.min(1, this.gThr)) + this.gDfco * this.env * 0.15);

      const h0 = this.heads[0].run(x0 + turb * 0.5);
      const h1 = this.heads[1].run(x1 + turb * 0.5);

      // backfire: unburnt charge lighting off in the pipe past the collector. a fast rise,
      // a short decay and a couple of smaller crackles after, all through the muffler
      if (tc >= 100) {
        const amp = Math.min(1.5, 0.4 + ta);
        this.pops.push({ t: 0, amp, tau: sampleRate * (0.004 + this.rand() * 0.004), next: sampleRate * (0.006 + this.rand() * 0.01), left: 1 + Math.floor(this.rand() * 3) });
      }
      let popSig = 0;
      for (let k = this.pops.length - 1; k >= 0; k--) {
        const p = this.pops[k];
        const t = p.t;
        const shape = (1 - Math.exp(-t / (sampleRate * 0.0006))) * Math.exp(-t / p.tau);
        popSig += p.amp * shape * (0.8 + 0.4 * (this.rand() - 0.5));
        p.t++;
        if (p.left > 0 && t >= p.next) {
          this.pops.push({ t: 0, amp: p.amp * (0.35 + this.rand() * 0.3), tau: p.tau * 0.7, next: sampleRate * (0.004 + this.rand() * 0.012), left: p.left - 1 });
          p.left = 0;
        }
        if (t > p.tau * 8) this.pops.splice(k, 1);
      }
      // sized off how loud the engine is running so they punch without stabbing
      popSig = this.popLp.run(popSig) * Math.max(0.01, this.env) * 5;

      const p1 = this.main.run(h0 + h1 + popSig);
      // muffler: lowpass plus an expansion chamber that cancels a band where its length fits
      const m0 = this.muf1.run(p1);
      const chOut = m0 - c.chamber * 0.5 * this.chamberD.read();
      this.chamberD.write(m0);
      const tip = this.tailP.run(chOut);
      // far field off an open end goes with d(flow)/dt
      const dTip = (tip - this.prevTip) * sampleRate * 2.5e-4;
      this.prevTip = tip;
      let rad = tip * (1 - c.radiate) + dTip * c.radiate;
      // gas leaving the tip as a jet: broadband hiss that follows each pulse and grows fast
      // with flow speed. smooth envelope so it breathes with the engine instead of crackling
      const v = Math.abs(chOut);
      this.jetEnv += (v - this.jetEnv) * (v > this.jetEnv ? 0.02 : 0.004);
      rad += this.jetLp.run(this.jetHp.run(this.rand() * 2 - 1)) * this.jetEnv * c.jet * (0.2 + 0.8 * Math.min(1, this.gThr));

      // intake runner resonance, mostly low
      const inS = this.inHp.run(this.inLp.run(this.intakeP.run(xi)));

      // partial normalisation: gain drops as level rises, but not all the way, so a pull
      // is still louder than idle. it moves over seconds, never per pulse
      const mag = Math.abs(rad);
      this.env += (mag - this.env) * (mag > this.env ? envA : envR);
      const g = Math.min(60, 0.25 * Math.pow(Math.max(5e-4, this.env), -0.4));
      this.gain += (g - this.gain) * 0.00005;

      // bigger engines are louder, and a closed throttle is quieter than a pull
      const G = this.gain * this.on * this.fade * c.level * (0.7 + 0.3 * Math.min(1, this.gThr));
      // a little of each bank's own header on its side
      const l = soft(this.outLp[0].run(this.outHp[0].run((rad + h0 * 0.12) * G)));
      const r = soft(this.outLp[1].run(this.outHp[1].run((rad + h1 * 0.12) * G)));
      ex[0][s] = l;
      ex[1][s] = r;
      if (inn) inn[0][s] = soft(inS * G * c.intake);
    }
    return true;
  }
}

registerProcessor('engine-voice', EngineVoice);
