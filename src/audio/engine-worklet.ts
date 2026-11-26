// Waveguide engine voice, runs on the audio thread.
//
// Every cylinder (or rotor face) gets an intake runner and an exhaust primary,
// each a pair of delay lines carrying pressure waves both ways. Valves are just
// reflection coefficients that swing from "closed wall" to "open" as they lift,
// so the pipes ring at their real lengths and the cam timing shapes the tone.
// Primaries meet in a collector per bank, collectors run to a muffler, the tail
// end of the muffler is what you hear. The sim tells us how hard each cylinder
// blew down and when to expect pops. Approach after Baldan, Lachambre, Delle
// Monache and Boussard, "Physically informed car engine sound synthesis", and
// DasEtwas/enginesound (MIT).

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

interface CylCfg {
  offset: number; // phase of this cylinder relative to the shaft, 0..1 of a cycle
  bank: number; // 0 or 1
}

interface Cfg {
  cyls: CylCfg[];
  inOpen: number; // cycle fraction, 0 = overlap TDC, 0.5 = firing TDC
  inClose: number;
  exOpen: number;
  exClose: number;
  ramp: number; // how quick the valves open, cycle fraction. rotary ports are near instant
  runner: number; // m
  primary: number; // m
  collector: number; // m
  rotary: boolean;
  turbo: boolean;
  split: boolean;
  blowTau: number; // s
  mix?: [number, number, number]; // exhaust, intake, body. for tuning
}

class Line {
  buf: Float32Array;
  pos = 0;
  constructor(n: number) {
    this.buf = new Float32Array(Math.max(2, n | 0));
  }
  out() {
    return this.buf[this.pos];
  }
  write(v: number) {
    this.buf[this.pos] = v;
    this.pos = this.pos + 1 >= this.buf.length ? 0 : this.pos + 1;
  }
}

// a pipe with an end at a (the valve or junction) and an end at b
class Guide {
  ab: Line; // travelling a -> b
  ba: Line;
  ra = 0; // reflection at a
  rb = 0;
  lpA = 0;
  lpB = 0;
  k: number; // wall loss lowpass
  g: number;
  outA = 0; // wave arriving at a
  outB = 0;
  constructor(lenM: number, c: number, loss: number) {
    const n = (lenM / c) * sampleRate;
    this.ab = new Line(n);
    this.ba = new Line(n);
    const wc = (2 * Math.PI * loss) / sampleRate;
    this.k = wc / (wc + 1);
    this.g = 0.992;
  }
  pop() {
    this.lpB += (this.ab.out() - this.lpB) * this.k;
    this.lpA += (this.ba.out() - this.lpA) * this.k;
    this.outB = soft(this.lpB * this.g);
    this.outA = soft(this.lpA * this.g);
  }
  push(inA: number, inB: number) {
    this.ab.write(this.outA * this.ra + inA);
    this.ba.write(this.outB * this.rb + inB);
  }
}

// 2 pole highpass. pressure pulses carry a lot of DC (mean flow) nobody hears
class HighPass {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
  x1 = 0;
  x2 = 0;
  y1 = 0;
  y2 = 0;
  constructor(f: number) {
    const w = (2 * Math.PI * f) / sampleRate;
    const q = Math.SQRT1_2;
    const al = Math.sin(w) / (2 * q);
    const c = Math.cos(w);
    const a0 = 1 + al;
    this.b0 = (1 + c) / 2 / a0;
    this.b1 = -(1 + c) / a0;
    this.b2 = (1 + c) / 2 / a0;
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

function soft(x: number) {
  return x > 4 || x < -4 ? 4 * Math.tanh(x / 4) : x;
}

function wrap(x: number) {
  return x - Math.floor(x);
}

// 0..1 openness inside a window that may wrap past 1
function openness(p: number, a: number, b: number, ramp: number) {
  const len = wrap(b - a);
  const t = wrap(p - a);
  if (t > len) return 0;
  const up = Math.min(1, t / ramp);
  const down = Math.min(1, (len - t) / ramp);
  const x = Math.min(up, down);
  return x * x * (3 - 2 * x);
}

interface Cyl {
  cfg: CylCfg;
  ex: Guide;
  inn: Guide;
  blow: number;
  queue: number[];
  last: number;
  wasOpen: boolean;
  fired: boolean;
  pop: number;
}

class EngineVoice extends AudioWorkletProcessor {
  cfg: Cfg | null = null;
  cyls: Cyl[] = [];
  banks: { col: Guide; muf: Guide; cham: Guide[]; tail: number }[] = [];
  phase = 0;
  cps = 0; // cycles per second, eased
  cpsTarget = 0;
  load = 0.3;
  throttle = 0;
  vib = 0;
  vibLp = 0;
  hpL = new HighPass(24);
  hpR = new HighPass(24);
  noise = 0;
  seed = 22222;
  gain = 0;
  gainTarget = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === 'config') this.configure(m.cfg as Cfg);
      else if (m.type === 'state') {
        this.cpsTarget = m.cps;
        this.load = m.load;
        this.throttle = m.throttle;
        this.gainTarget = m.on ? 1 : 0;
      } else if (m.type === 'blow') {
        const c = this.cyls[m.cyl];
        if (c && c.queue.length < 4) c.queue.push(m.amp);
      } else if (m.type === 'pop') {
        const c = this.cyls[m.cyl];
        if (c) c.pop = m.amp;
      }
    };
  }

  configure(cfg: Cfg) {
    this.cfg = cfg;
    const hot = 520;
    const cold = 345;
    this.cyls = cfg.cyls.map((cc, i) => ({
      cfg: cc,
      // primaries vary a little so a V doesn't sound like one cylinder copied eight times
      ex: new Guide(cfg.primary * (1 + ((i * 37) % 11) / 90), hot, 9000),
      inn: new Guide(cfg.runner, cold, 3800),
      blow: 0,
      queue: [],
      last: 0.4,
      wasOpen: false,
      fired: false,
      pop: 0,
    }));
    for (const c of this.cyls) {
      c.ex.rb = -0.5; // opens out into the collector
      c.inn.rb = -0.55; // opens into the plenum
    }
    const nb = cfg.split ? 2 : 1;
    this.banks = [];
    for (let b = 0; b < nb; b++) {
      const col = new Guide(cfg.collector * (b ? 1.06 : 1), hot, cfg.turbo ? 2200 : 4200);
      col.ra = 0.15;
      col.rb = 0.25;
      const muf = new Guide(0.55, 420, 3000);
      muf.ra = 0.2;
      muf.rb = 0.35;
      // chambers in the can, each rings at its own length
      const cham = [0.21, 0.33, 0.47].map((l) => {
        const g = new Guide(l * (b ? 1.04 : 1), 400, 2600);
        g.ra = 0.5;
        g.rb = 0.75;
        return g;
      });
      this.banks.push({ col, muf, cham, tail: 0 });
    }
  }

  rand() {
    // xorshift, cheap and good enough for hiss
    let x = this.seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.seed = x | 0;
    return ((x >>> 0) / 4294967296) * 2 - 1;
  }

  process(_in: Float32Array[][], outputs: Float32Array[][]) {
    const out = outputs[0];
    const L = out[0];
    const R = out[1] ?? out[0];
    const cfg = this.cfg;
    if (!cfg || !this.cyls.length) {
      L.fill(0);
      if (R !== L) R.fill(0);
      return true;
    }
    const n = L.length;
    const twoPi = Math.PI * 2;
    const tauS = cfg.blowTau * sampleRate;
    const blowDecay = Math.exp(-1 / Math.max(1, tauS));
    const nb = this.banks.length;
    const colIn = new Float64Array(nb);
    const colBack = new Float64Array(nb);
    const perBank = new Float64Array(nb);
    for (const c of this.cyls) perBank[c.cfg.bank % nb]++;

    for (let s = 0; s < n; s++) {
      this.cps += (this.cpsTarget - this.cps) * 0.0008;
      this.gain += (this.gainTarget - this.gain) * 0.0006;
      this.phase = wrap(this.phase + this.cps / sampleRate);
      this.noise += (this.rand() - this.noise) * 0.35;

      // pop everything first so all pushes this sample see last sample's waves
      for (let b = 0; b < nb; b++) {
        const bk = this.banks[b];
        bk.col.pop();
        bk.muf.pop();
        for (const ch of bk.cham) ch.pop();
        colIn[b] = 0;
        colBack[b] = bk.col.outA / Math.max(1, perBank[b]);
      }
      let intake = 0;
      let vib = 0;
      for (const c of this.cyls) {
        c.ex.pop();
        c.inn.pop();
        const p = wrap(this.phase + c.cfg.offset);
        const oE = openness(p, cfg.exOpen, cfg.exClose, cfg.ramp);
        const oI = openness(p, cfg.inOpen, cfg.inClose, cfg.ramp * 1.3);
        // a new blowdown when the exhaust cracks open, sized by what the sim said
        if (oE > 0 && !c.wasOpen) {
          const amp = c.queue.length ? c.queue.shift()! : c.last * 0.97;
          c.last = amp;
          c.blow = 0.15 + amp * 1.6;
        }
        c.wasOpen = oE > 0;
        if (c.pop > 0) {
          c.blow += c.pop * 1.1;
          c.pop = 0;
        }
        // piston speed, positive going down
        const v = Math.sin(twoPi * 2 * p);
        // gas leaves as fast as the opening lets it, and the cylinder empties as it does.
        // that gives the sharp front of the pulse on a quick port and a softer one on a slow valve
        const flow = c.blow * Math.sqrt(oE);
        c.blow *= Math.pow(blowDecay, Math.sqrt(oE));
        const exIn = flow + oE * Math.max(0, -v) * 0.12 * this.load + this.noise * flow * 0.25;
        // suction on the intake stroke, plus exhaust pushing back up the runner during overlap
        const inIn = -oI * Math.max(0, v) * (0.08 + 0.22 * this.load) + oI * oE * c.blow * 0.55 + this.noise * oI * (0.008 + 0.04 * this.throttle);
        // valves: shut is a wall, open lets the wave through into the cylinder
        c.ex.ra = 0.96 - oE * 0.9;
        c.inn.ra = 0.96 - oI * 0.88;
        c.ex.push(exIn, colBack[c.cfg.bank % nb] * 0.8);
        c.inn.push(inIn, 0);
        colIn[c.cfg.bank % nb] += c.ex.outB;
        intake += c.inn.outB;
        // block shake: the firing kick plus the second order of the pistons
        const dz = p - 0.52;
        vib += c.last * Math.exp(-(dz * dz) / 0.0009) * 0.6 + Math.cos(twoPi * 2 * p) * 0.03;
      }
      let l = 0;
      let r = 0;
      for (let b = 0; b < nb; b++) {
        const bk = this.banks[b];
        bk.col.push(colIn[b] * 0.55, bk.muf.outA * 0.6);
        let chamSum = 0;
        for (const ch of bk.cham) chamSum += ch.outA;
        bk.muf.push(bk.col.outB * 0.7, chamSum * 0.25);
        for (const ch of bk.cham) ch.push(bk.muf.outB * 0.35, 0);
        // what leaves the tailpipe: the can's outflow plus a bit straight through
        const tail = bk.muf.outB * 0.65 + chamSum * 0.12;
        bk.tail = tail;
        if (nb === 1) {
          l += tail;
          r += tail;
        } else if (b === 0) {
          l += tail;
          r += tail * 0.35;
        } else {
          r += tail;
          l += tail * 0.35;
        }
      }
      this.vibLp += (vib - this.vibLp) * 0.02;
      const body = this.vibLp * 0.35;
      const inMix = intake * (cfg.rotary ? 1.6 : 0.9);
      const mx = cfg.mix ?? [1, 1, 1];
      const exG = cfg.rotary ? 9 : 6;
      const yl = this.hpL.run((l * exG * mx[0] + inMix * mx[1] + body * mx[2]) * this.gain);
      const yr = this.hpR.run((r * exG * mx[0] + inMix * mx[1] + body * mx[2]) * this.gain);
      L[s] = Math.tanh(yl * 0.8);
      R[s] = Math.tanh(yr * 0.8);
    }
    return true;
  }
}

registerProcessor('engine-voice', EngineVoice);
