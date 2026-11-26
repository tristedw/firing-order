// Procedural engine sound. Every exhaust port opening in the sim schedules one
// pressure pulse, scaled by what was left in the cylinder at blowdown. Pulses go
// down a pipe model per bank (header plus tailpipe resonance, then a muffler), so
// the firing order, a cross-plane burble, a big cam's lope and a bridgeport's
// brap all come out of the sim instead of being faked on top.

import type { Engine, Readings } from '../sim/engine';

const SPEED_OF_GAS = 520; // m/s, hot exhaust

interface Voice {
  key: string;
  rotary: boolean;
  banks: number[]; // bank index per cylinder, 0 = left/center, 1 = right
  split: boolean; // two separate banks worth panning apart
  primary: number; // m, header primary
  tail: number; // m, collector to the tip
  muffler: number; // Hz, base muffler cutoff
  overlap: number; // normalised cycle deg
  intakeLevel: number;
  mechLevel: number;
  turbo: boolean;
}

interface Bank {
  input: GainNode;
  delay1: DelayNode;
  fb1: GainNode;
  lp1: BiquadFilterNode;
  delay2: DelayNode;
  fb2: GainNode;
  lp2: BiquadFilterNode;
  muffler: BiquadFilterNode;
  pan: StereoPannerNode;
}

function noiseBuffer(ctx: BaseAudioContext, seconds: number) {
  const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

// one blowdown: the pressure step when the port cracks open, the turbulent rush
// behind it, and a low thump that is really the block and mounts taking the hit
function pulseBuffer(ctx: BaseAudioContext, kind: 'piston' | 'rotary', seed: number) {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * 0.09);
  const b = ctx.createBuffer(1, len, sr);
  const d = b.getChannelData(0);
  const rot = kind === 'rotary';
  // a poppet valve lifts over a few degrees, a rotary port is uncovered by the apex seal all at once
  const rise = rot ? 0.00008 : 0.0007 + seed * 0.0001;
  const fall = rot ? 0.0026 : 0.0052 + seed * 0.0006;
  const thumpF = (rot ? 95 : 62) + seed * 7;
  const rasp = 1300 + seed * 260;
  let lp = 0;
  let lp2 = 0;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const step = (1 - Math.exp(-t / rise)) * Math.exp(-t / fall);
    lp += (Math.random() * 2 - 1 - lp) * (rot ? 0.55 : 0.3);
    lp2 += (lp - lp2) * 0.5;
    const rush = (rot ? lp : lp2) * Math.exp(-t / (rot ? 0.006 : 0.011)) * Math.min(1, t / 0.0004);
    const thump = Math.sin(2 * Math.PI * thumpF * t) * Math.exp(-t / (rot ? 0.006 : 0.009)) * Math.min(1, t / 0.0015);
    const ring = rot ? Math.sin(2 * Math.PI * rasp * t) * Math.exp(-t / 0.004) * 0.3 : 0;
    d[i] = step * 1.2 + rush * (rot ? 0.8 : 0.6) + thump * (rot ? 0.22 : 0.35) + ring;
  }
  return b;
}

export class EngineSound {
  ctx: BaseAudioContext | null = null;
  private master!: GainNode;
  private exOut!: GainNode;
  private banks: Bank[] = [];
  private space!: GainNode;
  private intakeGain!: GainNode;
  private intakeFilter!: BiquadFilterNode;
  private gulp!: BiquadFilterNode;
  private gulpGain!: GainNode;
  private mechGain!: GainNode;
  private mechFilter!: BiquadFilterNode;
  private starterGain!: GainNode;
  private starterOsc!: OscillatorNode;
  private whistle!: OscillatorNode;
  private whistle2!: OscillatorNode;
  private whistleGain!: GainNode;
  private whoosh!: BiquadFilterNode;
  private whooshGain!: GainNode;
  private noise!: AudioBuffer;
  private pulses: Record<'piston' | 'rotary', AudioBuffer[]> = { piston: [], rotary: [] };
  private ping!: AudioBuffer;
  private crash!: AudioBuffer;
  private voice: Voice | null = null;
  enabled = true;
  volume = 0.7;

  init(ctx?: BaseAudioContext) {
    if (this.ctx) return;
    const c = ctx ?? new AudioContext();
    this.ctx = c;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 8;
    comp.ratio.value = 5;
    comp.attack.value = 0.004;
    comp.release.value = 0.12;
    this.master = c.createGain();
    this.master.gain.value = this.enabled ? this.volume : 0;
    this.master.connect(comp).connect(c.destination);

    // a small concrete room, so it sounds like it is sitting in a shop and not in a vacuum
    const conv = c.createConvolver();
    const irLen = Math.floor(c.sampleRate * 0.55);
    const ir = c.createBuffer(2, irLen, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < irLen; i++) {
        const t = i / c.sampleRate;
        lp += (Math.random() * 2 - 1 - lp) * 0.35;
        d[i] = lp * Math.exp(-t / 0.11) * (t < 0.012 ? 0 : 1);
      }
    }
    conv.buffer = ir;
    this.space = c.createGain();
    this.space.gain.value = 0.16;
    this.space.connect(conv).connect(this.master);

    // exhaust: pipes per bank into a bit of saturation
    this.exOut = c.createGain();
    const shaper = c.createWaveShaper();
    const curve = new Float32Array(2048);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      // asymmetric, pressure pulses push harder than they pull
      curve[i] = x > 0 ? Math.tanh(x * 1.8) / Math.tanh(1.8) : Math.tanh(x * 1.3) / Math.tanh(1.8);
    }
    shaper.curve = curve;
    shaper.oversample = '2x';
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 28;
    this.exOut.connect(shaper).connect(hp);
    hp.connect(this.master);
    hp.connect(this.space);
    for (let b = 0; b < 2; b++) this.banks.push(this.makeBank(c));

    this.noise = noiseBuffer(c, 2);
    const ns = c.createBufferSource();
    ns.buffer = this.noise;
    ns.loop = true;

    // intake roar, centred on the runner, and a gulp per cycle through the same filter
    this.intakeFilter = c.createBiquadFilter();
    this.intakeFilter.type = 'bandpass';
    this.intakeFilter.Q.value = 1.2;
    this.intakeGain = c.createGain();
    this.intakeGain.gain.value = 0;
    ns.connect(this.intakeFilter).connect(this.intakeGain).connect(this.master);
    this.gulp = c.createBiquadFilter();
    this.gulp.type = 'lowpass';
    this.gulp.frequency.value = 500;
    this.gulp.Q.value = 3;
    this.gulpGain = c.createGain();
    this.gulpGain.gain.value = 0.4;
    this.gulp.connect(this.gulpGain).connect(this.master);
    this.gulpGain.connect(this.space);

    // valvetrain and general mechanical chatter
    this.mechFilter = c.createBiquadFilter();
    this.mechFilter.type = 'bandpass';
    this.mechFilter.frequency.value = 3200;
    this.mechFilter.Q.value = 0.7;
    this.mechGain = c.createGain();
    this.mechGain.gain.value = 0;
    ns.connect(this.mechFilter).connect(this.mechGain).connect(this.master);

    // turbo: blade pass whine and the hiss of air through the compressor
    this.whistle = c.createOscillator();
    this.whistle.type = 'sine';
    this.whistle2 = c.createOscillator();
    this.whistle2.type = 'triangle';
    this.whistleGain = c.createGain();
    this.whistleGain.gain.value = 0;
    this.whistle.connect(this.whistleGain);
    const w2g = c.createGain();
    w2g.gain.value = 0.35;
    this.whistle2.connect(w2g).connect(this.whistleGain);
    this.whistleGain.connect(this.master);
    this.whoosh = c.createBiquadFilter();
    this.whoosh.type = 'bandpass';
    this.whoosh.Q.value = 2;
    this.whooshGain = c.createGain();
    this.whooshGain.gain.value = 0;
    ns.connect(this.whoosh).connect(this.whooshGain).connect(this.master);
    this.whistle.start();
    this.whistle2.start();
    ns.start();

    // starter: a brushed motor whine with a bendix rattle on top
    this.starterOsc = c.createOscillator();
    this.starterOsc.type = 'sawtooth';
    this.starterOsc.frequency.value = 160;
    const sf = c.createBiquadFilter();
    sf.type = 'lowpass';
    sf.frequency.value = 1100;
    this.starterGain = c.createGain();
    this.starterGain.gain.value = 0;
    this.starterOsc.connect(sf).connect(this.starterGain).connect(this.master);
    this.starterOsc.start();

    for (let v = 0; v < 6; v++) {
      this.pulses.piston.push(pulseBuffer(c, 'piston', v / 5));
      this.pulses.rotary.push(pulseBuffer(c, 'rotary', v / 5));
    }
    {
      const len = Math.floor(c.sampleRate * 0.04);
      this.ping = c.createBuffer(1, len, c.sampleRate);
      const d = this.ping.getChannelData(0);
      for (let i = 0; i < len; i++) {
        const t = i / c.sampleRate;
        d[i] = (Math.sin(2 * Math.PI * 6400 * t) + 0.6 * Math.sin(2 * Math.PI * 9100 * t)) * Math.exp(-t * 120) * 0.5;
      }
    }
    {
      const len = Math.floor(c.sampleRate * 1.2);
      this.crash = c.createBuffer(1, len, c.sampleRate);
      const d = this.crash.getChannelData(0);
      for (let i = 0; i < len; i++) {
        const t = i / c.sampleRate;
        d[i] = (Math.random() * 2 - 1) * Math.exp(-t * 4) * (1 + Math.sin(2 * Math.PI * 47 * t));
      }
    }
  }

  // header and tailpipe as two feedback combs. an open pipe end reflects with the
  // sign flipped, so the feedback is negative and it rings on odd harmonics
  private makeBank(c: BaseAudioContext): Bank {
    const input = c.createGain();
    const minDelay = 129 / c.sampleRate;
    const delay1 = c.createDelay(0.1);
    delay1.delayTime.value = Math.max(minDelay, 0.004);
    const fb1 = c.createGain();
    fb1.gain.value = -0.5;
    const lp1 = c.createBiquadFilter();
    lp1.type = 'lowpass';
    lp1.frequency.value = 3200;
    const sum1 = c.createGain();
    input.connect(sum1);
    sum1.connect(delay1).connect(lp1).connect(fb1).connect(sum1);
    const delay2 = c.createDelay(0.1);
    delay2.delayTime.value = 0.01;
    const fb2 = c.createGain();
    fb2.gain.value = -0.4;
    const lp2 = c.createBiquadFilter();
    lp2.type = 'lowpass';
    lp2.frequency.value = 1800;
    const sum2 = c.createGain();
    sum1.connect(sum2);
    sum2.connect(delay2).connect(lp2).connect(fb2).connect(sum2);
    const muffler = c.createBiquadFilter();
    muffler.type = 'lowpass';
    muffler.Q.value = 0.8;
    muffler.frequency.value = 1500;
    const pan = c.createStereoPanner();
    sum2.connect(muffler).connect(pan).connect(this.exOut);
    return { input, delay1, fb1, lp1, delay2, fb2, lp2, muffler, pan };
  }

  // work out how this engine should sound. only redone when the build changes
  private configure(e: Engine) {
    const t = e.tune;
    const key = `${t.layout}|${t.turbo}|${t.turboSize}|${e.win.inC}|${e.win.inD}|${e.win.exC}|${e.win.exD}|${e.Vd.toFixed(5)}|${t.valvetrain}`;
    if (this.voice?.key === key) return;
    const rot = e.kind === 'rotary';
    const lay = e.layout;
    const banks = lay.cyls.map((c) => (c.bank > 0 ? 1 : 0));
    const split = banks.some((b) => b === 1) && banks.some((b) => b === 0);
    const vCyl = e.Vd * 1000; // litres per cylinder or chamber
    const w = e.win;
    const overlap = Math.max(0, w.exC + w.exD / 2 - 720 - (w.inC - w.inD / 2));
    const v: Voice = {
      key,
      rotary: rot,
      banks,
      split,
      primary: rot ? 0.45 : Math.min(1.1, Math.max(0.35, 0.8 * Math.sqrt(vCyl / 0.65))),
      tail: rot ? 1.5 : lay.cyls.length <= 2 ? 1.2 : 2.4,
      // rotaries usually run a straight through can, and a turbine soaks up a lot of the bark
      muffler: (rot ? 2600 : lay.cyls.length <= 2 ? 1600 : 1250) * (t.turbo ? 0.62 : 1),
      overlap,
      intakeLevel: (rot ? 1.6 : 1) * (1 + Math.min(3, overlap / 40)),
      mechLevel: rot ? 0.25 : t.valvetrain === 'pushrod' ? 1.3 : 1,
      turbo: t.turbo,
    };
    this.voice = v;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const minDelay = 129 / ctx.sampleRate;
    this.banks.forEach((b, i) => {
      // the two sides of a V run slightly different lengths, like real headers
      const skew = i === 1 ? 1.07 : 1;
      b.delay1.delayTime.setValueAtTime(Math.max(minDelay, ((2 * v.primary) / SPEED_OF_GAS) * skew), now);
      b.delay2.delayTime.setValueAtTime(Math.max(minDelay, ((2 * v.tail) / SPEED_OF_GAS) * skew), now);
      b.fb1.gain.setValueAtTime(rot ? -0.42 : -0.55, now);
      b.fb2.gain.setValueAtTime(t.turbo ? -0.18 : -0.28, now);
      b.lp1.frequency.setValueAtTime(rot ? 4200 : 2600, now);
      b.pan.pan.setValueAtTime(v.split ? (i === 0 ? -0.55 : 0.55) : 0, now);
    });
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (this.ctx) this.master.gain.setTargetAtTime(on ? this.volume : 0, this.ctx.currentTime, 0.05);
  }

  resume() {
    const c = this.ctx as AudioContext | null;
    if (c && 'resume' in c) c.resume();
  }

  private burst(at: number, dur: number, type: BiquadFilterType, freq: number, q: number, gain: number, sweepTo?: number, dest?: AudioNode) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, at);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, at + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(gain, at + Math.min(0.01, dur * 0.1));
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(f).connect(g).connect(dest ?? this.master);
    src.start(at, Math.random() * 1.5, dur + 0.05);
  }

  // events are stamped in sim seconds from the start of this frame's update
  frame(e: Engine, r: Readings, timeScale: number) {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    this.configure(e);
    const v = this.voice!;
    const now = ctx.currentTime;
    const base = now + 0.06;
    const slow = Math.max(timeScale, 0.001);
    const rpm = Math.max(0, r.rpm);
    const live = timeScale > 0.5;
    const pitch = timeScale < 0.99 ? Math.max(0.35, Math.sqrt(timeScale)) : 1;
    const load = Math.min(1.6, r.map / 101325);

    // muffler opens up with flow, so it gets louder and brighter on throttle
    const flow = Math.min(1, rpm / 7000) * Math.min(1.4, load);
    for (const b of this.banks) {
      b.muffler.frequency.setTargetAtTime((v.muffler * (0.95 + 0.9 * flow) + r.throttle * 500) * pitch, now, 0.04);
      b.lp2.frequency.setTargetAtTime((900 + flow * 2200) * pitch, now, 0.05);
    }
    this.exOut.gain.setTargetAtTime(0.7 + 0.5 * flow, now, 0.05);

    const tunedRpm = 1.9e6 / Math.max(80, e.tune.runner);
    this.intakeFilter.frequency.setTargetAtTime((350 + rpm * 0.18 + (tunedRpm / 60) * 2) * pitch, now, 0.05);
    this.intakeGain.gain.setTargetAtTime(live ? (r.throttle * 0.045 + 0.004) * Math.min(1, rpm / 5000 + 0.2) * v.intakeLevel : 0, now, 0.05);
    this.gulp.frequency.setTargetAtTime((260 + rpm * 0.05) * pitch, now, 0.05);
    this.mechGain.gain.setTargetAtTime(live ? (0.004 + Math.min(1, rpm / 7000) * 0.014) * v.mechLevel : 0, now, 0.08);
    this.mechFilter.frequency.setTargetAtTime(2400 + rpm * 0.25, now, 0.1);
    this.starterGain.gain.setTargetAtTime(r.cranking ? 0.06 : 0, now, 0.03);
    this.starterOsc.frequency.setTargetAtTime(110 + rpm * 0.45, now, 0.05);

    const tb = r.turbo;
    if (tb && !tb.dead && live) {
      const s = Math.min(1.3, e.spool);
      const f = 1400 + s * s * 4200;
      this.whistle.frequency.setTargetAtTime(f, now, 0.06);
      this.whistle2.frequency.setTargetAtTime(f * 0.5, now, 0.06);
      const drive = Math.max(0.15, Math.min(1, tb.flowFrac * 1.6));
      this.whistleGain.gain.setTargetAtTime(s * s * 0.016 * drive, now, 0.06);
      this.whoosh.frequency.setTargetAtTime(900 + s * 2600, now, 0.08);
      this.whooshGain.gain.setTargetAtTime(Math.min(1, tb.flowFrac) * s * 0.05, now, 0.08);
    } else {
      this.whistleGain.gain.setTargetAtTime(0, now, 0.15);
      this.whooshGain.gain.setTargetAtTime(0, now, 0.1);
    }

    const set = v.rotary ? this.pulses.rotary : this.pulses.piston;
    const rate = (0.85 + Math.min(1, rpm / 9000) * 0.45) * pitch;
    for (const ev of e.events) {
      const at = base + ev.t / slow;
      if (at > now + 1.5) continue;
      if (ev.type === 'exhaust') {
        const bank = this.banks[v.split ? v.banks[ev.cyl] : 0];
        const src = ctx.createBufferSource();
        src.buffer = set[(Math.random() * set.length) | 0];
        src.playbackRate.value = rate * (0.97 + Math.random() * 0.06);
        const g = ctx.createGain();
        // blowdown pressure is the loudness. a cylinder that barely lit is barely heard
        const amp = Math.pow(Math.max(0, ev.amp), 1.05);
        g.gain.value = (0.06 + amp * 0.8) * (r.fuelCut ? 0.4 : 1) * (0.94 + Math.random() * 0.12);
        src.connect(g).connect(bank.input);
        src.start(at);
        // intake gulp, louder the more the cam or ports overlap
        if (live) {
          const gs = ctx.createBufferSource();
          gs.buffer = set[(Math.random() * set.length) | 0];
          gs.playbackRate.value = rate * 0.6;
          const gg = ctx.createGain();
          gg.gain.value = 0.05 * v.intakeLevel * (0.3 + r.throttle);
          gs.connect(gg).connect(this.gulp);
          gs.start(at + 0.003);
        }
      } else if (ev.type === 'pop') {
        // raw mixture lighting in the header: a hard crack that rings down the pipe
        const bank = this.banks[v.split ? v.banks[ev.cyl] : 0];
        const src = ctx.createBufferSource();
        src.buffer = this.pulses.rotary[(Math.random() * 6) | 0];
        src.playbackRate.value = 0.7 + Math.random() * 0.3;
        const g = ctx.createGain();
        g.gain.value = 0.3 + ev.amp * 0.5;
        src.connect(g).connect(bank.input);
        src.start(at);
        this.burst(at, 0.04, 'highpass', 1800, 0.7, 0.08 * ev.amp);
      } else if (ev.type === 'knock') {
        const src = ctx.createBufferSource();
        src.buffer = this.ping;
        src.playbackRate.value = pitch;
        const g = ctx.createGain();
        g.gain.value = 0.15 + ev.amp * 0.5;
        src.connect(g).connect(this.master);
        src.start(at);
      } else if (ev.type === 'bov') {
        // pssh: boost dumping to atmosphere through a valve
        this.burst(at, 0.55 + ev.amp * 0.3, 'bandpass', 3400, 0.9, 0.14 * ev.amp, 1400);
        this.burst(at, 0.25, 'highpass', 5000, 0.6, 0.05 * ev.amp);
      } else if (ev.type === 'surge') {
        // stu-tu-tu: air slamming back through the compressor wheel
        this.burst(at, 0.045, 'bandpass', 520 + Math.random() * 160, 3, 0.16 * ev.amp);
        this.burst(at, 0.03, 'bandpass', 2600, 2, 0.04 * ev.amp);
      } else if (ev.type === 'failure') {
        const src = ctx.createBufferSource();
        src.buffer = this.crash;
        const g = ctx.createGain();
        g.gain.value = 0.8 * ev.amp;
        src.connect(g).connect(this.master);
        src.start(now + 0.02);
      }
    }
  }
}
