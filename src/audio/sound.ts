// Engine sound. The sim streams header and intake runner pressure plus every exhaust
// opening and backfire, at its own step rate. The audio thread (engine-worklet.ts) turns
// that into a firing pulse train through pipe resonators for piston engines, or into
// flow noise through a recorded exhaust from engine-sim (MIT, see public/audio) for
// rotaries. This side adds turbo whine, BOV, surge, knock ping, the starter and a room.

import type { Engine, Readings } from '../sim/engine';
import workletUrl from './engine-worklet.ts?worker&url';

function noiseBuffer(ctx: BaseAudioContext, seconds: number) {
  const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

export class EngineSound {
  ctx: BaseAudioContext | null = null;
  ready: Promise<void> | null = null;
  private voice: AudioWorkletNode | null = null;
  private voiceKey = '';
  private exConv!: ConvolverNode;
  private inConv!: ConvolverNode;
  private exGain!: GainNode;
  private dryGain!: GainNode;
  private inGain!: GainNode;
  private irs = new Map<string, AudioBuffer>();
  private master!: GainNode;
  private space!: GainNode;
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
  private ping!: AudioBuffer;
  private crash!: AudioBuffer;
  enabled = true;
  volume = 0.7;

  init(ctx?: BaseAudioContext) {
    if (this.ctx) return this.ready;
    const c = ctx ?? new AudioContext();
    this.ctx = c;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 10;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.15;
    this.master = c.createGain();
    this.master.gain.value = this.enabled ? this.volume : 0;
    this.master.connect(comp).connect(c.destination);

    // a small concrete room, so it sounds like it is in a shop and not a vacuum
    const conv = c.createConvolver();
    const irLen = Math.floor(c.sampleRate * 0.6);
    const ir = c.createBuffer(2, irLen, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < irLen; i++) {
        const t = i / c.sampleRate;
        lp += (Math.random() * 2 - 1 - lp) * 0.3;
        d[i] = lp * Math.exp(-t / 0.13) * (t < 0.01 ? 0 : 1);
      }
    }
    conv.buffer = ir;
    this.space = c.createGain();
    this.space.gain.value = 0.12;
    this.space.connect(conv).connect(this.master);

    this.noise = noiseBuffer(c, 2);
    const ns = c.createBufferSource();
    ns.buffer = this.noise;
    ns.loop = true;

    // valvetrain and general mechanical chatter, kept well under the engine
    this.mechFilter = c.createBiquadFilter();
    this.mechFilter.type = 'bandpass';
    this.mechFilter.frequency.value = 3200;
    this.mechFilter.Q.value = 0.7;
    this.mechGain = c.createGain();
    this.mechGain.gain.value = 0;
    ns.connect(this.mechFilter).connect(this.mechGain).connect(this.master);

    // turbo: blade pass whine and air rushing through the compressor
    this.whistle = c.createOscillator();
    this.whistle.type = 'sine';
    this.whistle2 = c.createOscillator();
    this.whistle2.type = 'triangle';
    this.whistleGain = c.createGain();
    this.whistleGain.gain.value = 0;
    this.whistle.connect(this.whistleGain);
    const w2g = c.createGain();
    w2g.gain.value = 0.3;
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

    // starter motor whine
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

    // the engine voice: flow noise from the worklet through a recorded exhaust response
    this.exConv = c.createConvolver();
    this.inConv = c.createConvolver();
    this.exGain = c.createGain();
    this.exGain.gain.value = 3;
    this.inGain = c.createGain();
    this.inGain.gain.value = 0.35;
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 25;
    const inLp = c.createBiquadFilter();
    inLp.type = 'lowpass';
    inLp.frequency.value = 2400;
    this.dryGain = c.createGain();
    this.dryGain.gain.value = 0;
    this.exConv.connect(this.exGain).connect(hp);
    this.dryGain.connect(hp);
    this.inConv.connect(inLp).connect(this.inGain).connect(hp);
    hp.connect(this.master);
    hp.connect(this.space);
    const base = import.meta.env.BASE_URL;
    const load = (name: string) =>
      fetch(`${base}audio/${name}.wav`)
        .then((r) => r.arrayBuffer())
        .then((b) => c.decodeAudioData(b))
        .then((buf) => {
          this.irs.set(name, buf);
        });
    this.ready = Promise.all([
      c.audioWorklet.addModule(workletUrl),
      ...['smooth_39', 'mild_exhaust', 'mild_exhaust_reverb', 'minimal_muffling_01', 'minimal_muffling_02', 'sharp_01'].map(load),
    ]).then(() => {
      this.voice = new AudioWorkletNode(c, 'engine-voice', { numberOfInputs: 0, numberOfOutputs: 2, outputChannelCount: [2, 1] });
      this.voice.connect(this.exConv, 0);
      this.voice.connect(this.dryGain, 0);
      this.voice.connect(this.inConv, 1);
      this.inConv.buffer = this.irs.get('sharp_01') ?? null;
    });
    return this.ready;
  }

  // rotaries use the sim's own header flow through a recorded exhaust, everything else
  // the pulse train and resonators. tune the resonators to the pipes this engine has
  private configure(e: Engine) {
    const v = this.voice;
    if (!v) return;
    const t = e.tune;
    const n = e.layout.cyls.length;
    const rot = e.kind === 'rotary';
    const w = e.win;
    const key = `${t.layout}|${t.turbo}|${t.valvetrain}|${w.inC}|${w.inD}|${w.exC}|${w.exD}`;
    if (key === this.voiceKey) return;
    this.voiceKey = key;
    const banks = e.layout.cyls.map((c) => (c.bank > 0 ? 1 : 0));
    const vCyl = e.Vd * 1000;
    let ir = 'mild_exhaust';
    if (rot) ir = t.turbo ? 'smooth_39' : 'minimal_muffling_01';
    else if (t.turbo) ir = 'smooth_39';
    else if (n === 8) ir = 'mild_exhaust_reverb';
    this.exConv.buffer = this.irs.get(ir) ?? null;
    const now = this.ctx!.currentTime;
    this.exGain.gain.setTargetAtTime(rot ? 1.2 : 0.45, now, 0.05);
    this.dryGain.gain.setTargetAtTime(rot ? 0 : 0.8, now, 0.05);
    // big overlap pushes exhaust back up the intake, that honk is half of a bridgeport
    const overlap = Math.max(0, w.exC + w.exD / 2 - 720 - (w.inC - w.inD / 2));
    this.inGain.gain.setTargetAtTime((rot ? 0.2 + Math.min(1, overlap / 120) * 0.9 : 0.04 + Math.min(1, overlap / 120) * 0.08) * 0.4, now, 0.05);
    // header primaries ring around a quarter wave of their length, the tailpipe much lower
    const primary = Math.min(1, Math.max(0.35, 0.78 * Math.sqrt(vCyl / 0.65)));
    const hot = 520;
    v.port.postMessage({
      type: 'config',
      mode: rot ? 'flow' : 'ptr',
      banks,
      // bigger cylinders blow down slower, a big cam lets go earlier and harder
      attack: 34 - Math.min(12, vCyl * 8),
      decay: 2.2 + Math.max(0, (0.8 - vCyl) * 2.5),
      lambda: n <= 2 ? 0.09 : n === 8 ? 0.13 : 0.11,
      bend: 0.86,
      turb: t.turbo ? 0.1 : 0.16,
      headerHz: hot / (4 * primary),
      headerFb: t.turbo ? 0.35 : 0.55,
      tailHz: hot / (4 * (n <= 2 ? 1.0 : 2.2)),
      tailFb: t.turbo ? 0.3 : 0.5,
      noise: rot ? 0.55 : 0.8,
      df: rot ? 0.02 : 0.012,
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

  private burst(at: number, dur: number, type: BiquadFilterType, freq: number, q: number, gain: number, sweepTo?: number) {
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
    src.connect(f).connect(g).connect(this.master);
    src.start(at, Math.random() * 1.5, dur + 0.05);
  }

  // events are stamped in sim seconds from the start of this frame's update
  frame(e: Engine, r: Readings, timeScale: number) {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    this.configure(e);
    const now = ctx.currentTime;
    const base = now + 0.06;
    const slow = Math.max(timeScale, 0.001);
    const rpm = Math.max(0, r.rpm);
    const live = timeScale > 0.5;

    if (this.voice) {
      // engine load drives the turbulence noise, overrun with the fuel cut drives the air rush
      const tqRef = Math.max(1, e.VdTotal * 1000 * 120);
      const gThr = Math.pow(Math.max(Math.min(1.5, r.torque / tqRef), 0.02), 0.7);
      const gDfco = r.fuelCut || (r.throttle < 0.04 && rpm > 1800) ? Math.min(1, rpm / 5000) : 0;
      this.voice.port.postMessage({ type: 'state', on: rpm > 20 || r.cranking, cps: (rpm / 60) * (360 / e.cycleLen) * timeScale, gThr, gDfco });
      const au = e.audio;
      if (au.dt.length) {
        const dt = Float32Array.from(au.dt);
        const a = Float32Array.from(au.a);
        const b = Float32Array.from(au.b);
        const cc = Float32Array.from(au.c);
        const tc = Float32Array.from(au.tc);
        const ta = Float32Array.from(au.ta);
        this.voice.port.postMessage({ type: 'flow', dt, a, b, c: cc, tc, ta, scale: Math.max(timeScale, 0.001) }, [dt.buffer, a.buffer, b.buffer, cc.buffer, tc.buffer, ta.buffer]);
      }
    }

    this.mechGain.gain.setTargetAtTime(live ? (0.0006 + Math.min(1, rpm / 7000) * 0.0022) * (e.kind === 'rotary' ? 0.25 : e.tune.valvetrain === 'pushrod' ? 1.3 : 1) : 0, now, 0.08);
    this.mechFilter.frequency.setTargetAtTime(2400 + rpm * 0.25, now, 0.1);
    this.starterGain.gain.setTargetAtTime(r.cranking ? 0.05 : 0, now, 0.03);
    this.starterOsc.frequency.setTargetAtTime(110 + rpm * 0.45, now, 0.05);

    const tb = r.turbo;
    if (tb && !tb.dead && live) {
      const s = Math.min(1.3, e.spool);
      const f = 1400 + s * s * 4200;
      this.whistle.frequency.setTargetAtTime(f, now, 0.06);
      this.whistle2.frequency.setTargetAtTime(f * 0.5, now, 0.06);
      const drive = Math.max(0.15, Math.min(1, tb.flowFrac * 1.6));
      this.whistleGain.gain.setTargetAtTime(s * s * 0.014 * drive, now, 0.06);
      this.whoosh.frequency.setTargetAtTime(900 + s * 2600, now, 0.08);
      this.whooshGain.gain.setTargetAtTime(Math.min(1, tb.flowFrac) * s * 0.045, now, 0.08);
    } else {
      this.whistleGain.gain.setTargetAtTime(0, now, 0.15);
      this.whooshGain.gain.setTargetAtTime(0, now, 0.1);
    }

    for (const ev of e.events) {
      const at = base + ev.t / slow;
      if (at > now + 1.5) continue;
      if (ev.type === 'knock') {
        const src = ctx.createBufferSource();
        src.buffer = this.ping;
        const g = ctx.createGain();
        g.gain.value = 0.12 + ev.amp * 0.4;
        src.connect(g).connect(this.master);
        src.start(at);
      } else if (ev.type === 'bov') {
        this.burst(at, 0.55 + ev.amp * 0.3, 'bandpass', 3400, 0.9, 0.14 * ev.amp, 1400);
        this.burst(at, 0.25, 'highpass', 5000, 0.6, 0.05 * ev.amp);
      } else if (ev.type === 'surge') {
        // compressor surge: the air stalls and slams back out through the wheel,
        // a chuff per cycle with the turbo whine dipping each time
        this.burst(at, 0.075, 'bandpass', 380 + Math.random() * 120, 1.4, 0.3 * ev.amp, 220);
        this.burst(at, 0.05, 'bandpass', 1500 + Math.random() * 400, 1.1, 0.14 * ev.amp, 700);
        this.burst(at + 0.004, 0.02, 'highpass', 3500, 0.7, 0.05 * ev.amp);
        const wg = this.whistleGain.gain;
        wg.cancelScheduledValues(at);
        wg.setValueAtTime(wg.value * 0.3, at);
        wg.linearRampToValueAtTime(wg.value, at + 0.05);
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
