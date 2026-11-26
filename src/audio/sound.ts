// Engine sound. The engine itself is a waveguide model on the audio thread
// (engine-worklet.ts): real pipe lengths, cam timing as valve reflections, one
// blowdown per cylinder sized by the sim. This side adds what isn't the engine
// breathing: turbo whine, BOV, surge, knock ping, the starter, a bit of room.

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

    // the engine voice. a touch of low shelf for body, then into the room and out
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 22;
    const shelf = c.createBiquadFilter();
    shelf.type = 'lowshelf';
    shelf.frequency.value = 140;
    shelf.gain.value = 4;
    hp.connect(shelf);
    shelf.connect(this.master);
    shelf.connect(this.space);
    this.ready = c.audioWorklet.addModule(workletUrl).then(() => {
      this.voice = new AudioWorkletNode(c, 'engine-voice', { numberOfInputs: 0, outputChannelCount: [2] });
      this.voice.connect(hp);
    });
    return this.ready;
  }

  // tell the audio thread what it is: pipe lengths, valve timing, firing offsets
  private configure(e: Engine) {
    const v = this.voice;
    if (!v) return;
    const t = e.tune;
    const w = e.win;
    const key = `${t.layout}|${t.turbo}|${t.runner}|${w.inC}|${w.inD}|${w.exC}|${w.exD}|${e.cyls.map((c) => c.tdc).join(',')}`;
    if (key === this.voiceKey) return;
    this.voiceKey = key;
    const rot = e.kind === 'rotary';
    const banks = e.layout.cyls.map((c) => (c.bank > 0 ? 1 : 0));
    const split = banks.includes(1) && banks.includes(0);
    const vCyl = e.Vd * 1000;
    const f = (deg: number) => (((deg / 720) % 1) + 1) % 1;
    v.port.postMessage({
      type: 'config',
      cfg: {
        cyls: e.cyls.map((c, i) => ({ offset: f(360 - c.tdc * e.kN), bank: split ? banks[i] : 0 })),
        inOpen: f(w.inC - w.inD / 2),
        inClose: f(w.inC + w.inD / 2),
        exOpen: f(w.exC - w.exD / 2),
        exClose: f(w.exC + w.exD / 2),
        ramp: rot ? 0.008 : 0.05,
        runner: Math.max(0.08, t.runner / 1000),
        primary: rot ? 0.32 : Math.min(1, Math.max(0.35, 0.78 * Math.sqrt(vCyl / 0.65))),
        collector: rot ? 0.9 : e.layout.cyls.length <= 2 ? 0.9 : 1.35,
        rotary: rot,
        turbo: t.turbo,
        split,
        blowTau: rot ? 0.0009 : 0.0019,
      },
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
    const load = Math.min(1.6, r.map / 101325);

    if (this.voice) {
      // cycles per second the audio thread should run, slowed with the sim
      const cps = (rpm / 60) * (360 / e.cycleLen) * timeScale;
      this.voice.port.postMessage({ type: 'state', cps, load, throttle: r.throttle, on: rpm > 20 || r.cranking });
    }

    this.mechGain.gain.setTargetAtTime(live ? (0.002 + Math.min(1, rpm / 7000) * 0.008) * (e.kind === 'rotary' ? 0.25 : e.tune.valvetrain === 'pushrod' ? 1.3 : 1) : 0, now, 0.08);
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
      if (ev.type === 'exhaust') {
        this.voice?.port.postMessage({ type: 'blow', cyl: ev.cyl, amp: Math.max(0, ev.amp) * (r.fuelCut ? 0.5 : 1) });
      } else if (ev.type === 'pop') {
        this.voice?.port.postMessage({ type: 'pop', cyl: ev.cyl, amp: 0.4 + ev.amp * 0.6 });
      } else if (ev.type === 'knock') {
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
