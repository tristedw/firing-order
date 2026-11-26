// Engine sound, all of it driven by the sim. The audio thread (engine-worklet.ts) takes
// the exhaust and intake waves the valves (or rotary ports) make every sim step and runs
// them through headers, pipe, muffler and tailpipe. This side sizes those pipes for the
// engine on the stand and adds the bits that aren't exhaust: starter, turbo whine and
// air, BOV, compressor surge, knock ping and a small room. Everything is kept below the
// engine and shaped with soft edges, nothing here should ever be sharper than the car.

import type { Engine, Readings } from '../sim/engine';
import type { VoiceCfg } from './engine-worklet';
import workletUrl from './engine-worklet.ts?worker&url';

function noiseBuffer(ctx: BaseAudioContext, seconds: number) {
  const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

const C_HOT = 520; // m/s, speed of sound in header gas
const C_PIPE = 450; // cooler by the time it gets down the pipe

export class EngineSound {
  ctx: BaseAudioContext | null = null;
  ready: Promise<void> | null = null;
  private voice: AudioWorkletNode | null = null;
  private voiceKey = '';
  private inGain!: GainNode;
  private master!: GainNode;
  private space!: GainNode;
  private starterGain!: GainNode;
  private starterOsc!: OscillatorNode;
  private whistle!: OscillatorNode;
  private whistleGain!: GainNode;
  private whoosh!: BiquadFilterNode;
  private whooshGain!: GainNode;
  private noise!: AudioBuffer;
  private crash!: AudioBuffer;
  private bore = 0.1;
  enabled = true;
  volume = 0.7;

  init(ctx?: BaseAudioContext) {
    if (this.ctx) return this.ready;
    const c = ctx ?? new AudioContext();
    this.ctx = c;
    // glue, not a squash: slow attack so it never chews the low end
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 18;
    comp.ratio.value = 3;
    comp.attack.value = 0.012;
    comp.release.value = 0.25;
    this.master = c.createGain();
    this.master.gain.value = this.enabled ? this.volume : 0;
    this.master.connect(comp).connect(c.destination);

    // a small shop with soft walls so it isn't in a vacuum
    const conv = c.createConvolver();
    const irLen = Math.floor(c.sampleRate * 0.5);
    const ir = c.createBuffer(2, irLen, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < irLen; i++) {
        const t = i / c.sampleRate;
        lp += (Math.random() * 2 - 1 - lp) * (0.25 - 0.2 * Math.min(1, t / 0.3));
        d[i] = lp * Math.exp(-t / 0.11) * (t < 0.008 ? 0 : 1);
      }
    }
    conv.buffer = ir;
    this.space = c.createGain();
    this.space.gain.value = 0.1;
    this.space.connect(conv).connect(this.master);

    this.noise = noiseBuffer(c, 2);
    const ns = c.createBufferSource();
    ns.buffer = this.noise;
    ns.loop = true;

    // turbo: blade pass whine and air through the compressor, both well under the engine
    this.whistle = c.createOscillator();
    this.whistle.type = 'sine';
    this.whistleGain = c.createGain();
    this.whistleGain.gain.value = 0;
    this.whistle.connect(this.whistleGain).connect(this.master);
    this.whoosh = c.createBiquadFilter();
    this.whoosh.type = 'bandpass';
    this.whoosh.Q.value = 1.2;
    const whooshLp = c.createBiquadFilter();
    whooshLp.type = 'lowpass';
    whooshLp.frequency.value = 3500;
    this.whooshGain = c.createGain();
    this.whooshGain.gain.value = 0;
    ns.connect(this.whoosh).connect(whooshLp).connect(this.whooshGain).connect(this.master);
    this.whistle.start();
    ns.start();

    // starter: a small motor through a gear, rounded off
    this.starterOsc = c.createOscillator();
    this.starterOsc.type = 'triangle';
    this.starterOsc.frequency.value = 160;
    const sf = c.createBiquadFilter();
    sf.type = 'lowpass';
    sf.frequency.value = 700;
    this.starterGain = c.createGain();
    this.starterGain.gain.value = 0;
    this.starterOsc.connect(sf).connect(this.starterGain).connect(this.master);
    this.starterOsc.start();

    // something letting go: a dull bang and rattle, lowpassed so it's a thud, not a shriek
    {
      const len = Math.floor(c.sampleRate * 1.0);
      this.crash = c.createBuffer(1, len, c.sampleRate);
      const d = this.crash.getChannelData(0);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / c.sampleRate;
        lp += (Math.random() * 2 - 1 - lp) * 0.12;
        d[i] = (lp * 2.5 * Math.exp(-t * 5) + Math.sin(2 * Math.PI * 55 * t) * Math.exp(-t * 9)) * (1 - Math.exp(-t * 800));
      }
    }

    this.inGain = c.createGain();
    this.inGain.gain.value = 0.05;
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 25;
    hp.connect(this.master);
    hp.connect(this.space);
    this.ready = c.audioWorklet.addModule(workletUrl).then(() => {
      this.voice = new AudioWorkletNode(c, 'engine-voice', { numberOfInputs: 0, numberOfOutputs: 2, outputChannelCount: [2, 1] });
      this.voice.connect(hp, 0);
      this.voice.connect(this.inGain, 1).connect(hp);
    });
    return this.ready;
  }

  // size the pipes for whatever is on the stand
  private configure(e: Engine) {
    const v = this.voice;
    if (!v) return;
    const t = e.tune;
    const n = e.layout.cyls.length;
    const rot = e.kind === 'rotary';
    const w = e.win;
    const key = `${t.layout}|${t.turbo}|${t.runner}|${t.bore}|${t.stroke}|${w.inC}|${w.inD}|${w.exC}|${w.exD}`;
    if (key === this.voiceKey) return;
    this.voiceKey = key;
    this.bore = e.B;
    const vCyl = e.Vd * 1000;
    const overlap = Math.max(0, w.exC + w.exD / 2 - 720 - (w.inC - w.inD / 2));
    const small = n <= 2;
    // primaries scale with the cylinder they serve, plus a collector
    const primary = rot ? 0.45 : Math.min(0.95, Math.max(0.3, 0.75 * Math.sqrt(vCyl / 0.65)));
    const pipe = t.layout === 'single' ? 0.35 : small ? 1.1 : 2.6;
    const tail = t.layout === 'single' ? 0.12 : 0.45;
    // a hot cam and a bridgeport go with a freer exhaust, a turbine eats a lot of the bark
    const free = Math.min(1, overlap / 70);
    let muffler = 1700 + free * 1500;
    if (t.turbo) muffler *= 0.75;
    if (t.layout === 'single') muffler = 2600;
    if (t.layout === 'vtwin') muffler = 2200;
    const cfg: VoiceCfg = {
      nCyl: n,
      header: (primary + 0.3) / C_HOT,
      pipe: pipe / C_PIPE,
      tail: tail / C_PIPE,
      runner: Math.max(0.05, t.runner / 1000) / 343,
      muffler,
      chamber: 0.6 - free * 0.35,
      turb: (rot ? 0.28 : 0.14) * (t.turbo ? 0.6 : 1),
      radiate: 0.7,
      level: Math.min(2, Math.max(0.6, Math.pow((e.VdTotal * 1000) / 2, 0.6))),
      jet: (rot ? 0.5 : 0.3) * (t.turbo ? 0.7 : 1),
      // overlap pushes exhaust back up the intake, that honk is half of a bridgeport
      intake: rot ? 0.25 + free * 0.9 : 0.06 + free * 0.12,
    };
    v.port.postMessage({ type: 'config', cfg });
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (this.ctx) this.master.gain.setTargetAtTime(on ? this.volume : 0, this.ctx.currentTime, 0.05);
  }

  resume() {
    const c = this.ctx as AudioContext | null;
    if (c && 'resume' in c) c.resume();
  }

  // filtered noise with a soft attack and an exponential tail
  private burst(at: number, dur: number, type: BiquadFilterType, freq: number, q: number, gain: number, sweepTo?: number, attack = 0.012) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, at);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, at + dur);
    f.Q.value = q;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 5000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(gain, at + Math.min(attack, dur * 0.3));
    g.gain.setTargetAtTime(0, at + Math.min(attack, dur * 0.3), dur / 4);
    src.connect(f).connect(lp).connect(g).connect(this.master);
    g.connect(this.space);
    src.start(at, Math.random() * 1.5, dur + 0.1);
  }

  // knock: the end gas going off rings the chamber at its first circumferential modes,
  // f = j'mn * c / (pi * bore) with c around 950 m/s in burnt gas. 5 to 7 kHz for a car
  private ping(at: number, amp: number) {
    const ctx = this.ctx!;
    const f1 = (1.841 * 950) / (Math.PI * this.bore);
    for (const [f, k] of [
      [f1, 1],
      [f1 * 1.66, 0.4],
    ]) {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime((0.02 + amp * 0.05) * k, at + 0.0008);
      g.gain.setTargetAtTime(0, at + 0.0008, 0.0025);
      o.connect(g).connect(this.master);
      o.start(at);
      o.stop(at + 0.03);
    }
  }

  // events are stamped in sim seconds from the start of this frame's update
  frame(e: Engine, r: Readings, timeScale: number) {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    this.configure(e);
    const now = ctx.currentTime;
    const base = now + 0.07;
    const slow = Math.max(timeScale, 0.001);
    const rpm = Math.max(0, r.rpm);
    const live = timeScale > 0.5;

    if (this.voice) {
      const tqRef = Math.max(1, e.VdTotal * 1000 * 120);
      const gThr = Math.pow(Math.max(Math.min(1.5, r.torque / tqRef), 0.02), 0.7);
      const gDfco = r.fuelCut || (r.throttle < 0.04 && rpm > 1800) ? Math.min(1, rpm / 5000) : 0;
      this.voice.port.postMessage({ type: 'state', on: rpm > 20 || r.cranking, gThr, gDfco });
      const au = e.audio;
      if (au.dt.length) {
        const dt = Float32Array.from(au.dt);
        const a = Float32Array.from(au.a);
        const b = Float32Array.from(au.b);
        const cc = Float32Array.from(au.c);
        const tc = Float32Array.from(au.tc);
        const ta = Float32Array.from(au.ta);
        this.voice.port.postMessage({ type: 'flow', dt, a, b, c: cc, tc, ta, scale: slow }, [dt.buffer, a.buffer, b.buffer, cc.buffer, tc.buffer, ta.buffer]);
      }
    }

    this.starterGain.gain.setTargetAtTime(r.cranking ? 0.03 : 0, now, 0.04);
    this.starterOsc.frequency.setTargetAtTime(110 + rpm * 0.45, now, 0.05);

    const tb = r.turbo;
    if (tb && !tb.dead && live) {
      const s = Math.min(1.3, e.spool);
      const f = 1400 + s * s * 3200;
      this.whistle.frequency.setTargetAtTime(f, now, 0.08);
      const drive = Math.max(0.15, Math.min(1, tb.flowFrac * 1.6));
      this.whistleGain.gain.setTargetAtTime(s * s * 0.005 * drive, now, 0.08);
      this.whoosh.frequency.setTargetAtTime(700 + s * 1800, now, 0.1);
      this.whooshGain.gain.setTargetAtTime(Math.min(1, tb.flowFrac) * s * 0.035, now, 0.1);
    } else {
      this.whistleGain.gain.setTargetAtTime(0, now, 0.15);
      this.whooshGain.gain.setTargetAtTime(0, now, 0.12);
    }

    for (const ev of e.events) {
      const at = base + ev.t / slow;
      if (at > now + 1.5) continue;
      if (ev.type === 'knock') {
        this.ping(at, ev.amp);
      } else if (ev.type === 'bov') {
        // the charge dumping out of the valve: a hiss falling as the pressure goes
        this.burst(at, 0.5 + ev.amp * 0.3, 'bandpass', 2600, 0.8, 0.07 * ev.amp, 1100, 0.02);
        this.burst(at, 0.2, 'bandpass', 320, 0.9, 0.05 * ev.amp, 200, 0.01);
      } else if (ev.type === 'surge') {
        // compressor surge: air stalls and slams back out through the wheel, a flutter
        // per stall with the whine dipping each time
        this.burst(at, 0.08, 'bandpass', 420 + Math.random() * 120, 1.2, 0.12 * ev.amp, 240, 0.006);
        this.burst(at, 0.05, 'bandpass', 1300 + Math.random() * 300, 1, 0.035 * ev.amp, 800, 0.006);
        const wg = this.whistleGain.gain;
        wg.cancelScheduledValues(at);
        wg.setValueAtTime(wg.value * 0.4, at);
        wg.linearRampToValueAtTime(wg.value, at + 0.06);
      } else if (ev.type === 'failure') {
        const src = ctx.createBufferSource();
        src.buffer = this.crash;
        const g = ctx.createGain();
        g.gain.value = 0.35 * ev.amp;
        src.connect(g).connect(this.master);
        g.connect(this.space);
        src.start(now + 0.02);
      }
    }
  }
}
