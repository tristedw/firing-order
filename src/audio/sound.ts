// Procedural engine sound. Every exhaust valve opening in the sim schedules one
// pulse, scaled by cylinder pressure at blowdown, so the firing order, uneven
// V-twin rhythm, misfires and the limiter all come out of the sim for free.

import type { EngineEvent, Readings } from '../sim/engine';

export class EngineSound {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private exBus!: GainNode;
  private exFilter!: BiquadFilterNode;
  private body!: BiquadFilterNode;
  private intakeGain!: GainNode;
  private intakeFilter!: BiquadFilterNode;
  private starterGain!: GainNode;
  private starterOsc!: OscillatorNode;
  private mechGain!: GainNode;
  private pulses: AudioBuffer[] = [];
  private ping!: AudioBuffer;
  private crash!: AudioBuffer;
  enabled = true;
  volume = 0.7;

  init() {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? this.volume : 0;
    this.master.connect(comp).connect(ctx.destination);

    // exhaust chain
    this.exBus = ctx.createGain();
    this.exFilter = ctx.createBiquadFilter();
    this.exFilter.type = 'lowpass';
    this.exFilter.Q.value = 0.9;
    this.body = ctx.createBiquadFilter();
    this.body.type = 'peaking';
    this.body.frequency.value = 110;
    this.body.gain.value = 7;
    this.body.Q.value = 1.1;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * 2.2) / Math.tanh(2.2);
    }
    shaper.curve = curve;
    this.exBus.connect(this.exFilter).connect(this.body).connect(shaper).connect(this.master);

    // intake hiss
    const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const nd = noise.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    const ns = ctx.createBufferSource();
    ns.buffer = noise;
    ns.loop = true;
    this.intakeFilter = ctx.createBiquadFilter();
    this.intakeFilter.type = 'bandpass';
    this.intakeFilter.Q.value = 0.8;
    this.intakeGain = ctx.createGain();
    this.intakeGain.gain.value = 0;
    ns.connect(this.intakeFilter).connect(this.intakeGain).connect(this.master);

    // valvetrain clatter
    const mf = ctx.createBiquadFilter();
    mf.type = 'highpass';
    mf.frequency.value = 3500;
    this.mechGain = ctx.createGain();
    this.mechGain.gain.value = 0;
    ns.connect(mf).connect(this.mechGain).connect(this.master);
    ns.start();

    // starter motor
    this.starterOsc = ctx.createOscillator();
    this.starterOsc.type = 'sawtooth';
    this.starterOsc.frequency.value = 160;
    const sf = ctx.createBiquadFilter();
    sf.type = 'lowpass';
    sf.frequency.value = 900;
    this.starterGain = ctx.createGain();
    this.starterGain.gain.value = 0;
    this.starterOsc.connect(sf).connect(this.starterGain).connect(this.master);
    this.starterOsc.start();

    // pulse variants
    for (let v = 0; v < 4; v++) {
      const len = Math.floor(ctx.sampleRate * 0.07);
      const b = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = b.getChannelData(0);
      let lp = 0;
      const f0 = 70 + v * 9;
      for (let i = 0; i < len; i++) {
        const t = i / ctx.sampleRate;
        lp += (Math.random() * 2 - 1 - lp) * 0.25;
        const env = Math.exp(-t * 70);
        const thump = Math.sin(2 * Math.PI * f0 * t) * Math.exp(-t * 45);
        d[i] = (lp * 0.9 + thump * 1.1) * env * (i < 40 ? i / 40 : 1);
      }
      this.pulses.push(b);
    }
    {
      const len = Math.floor(ctx.sampleRate * 0.04);
      this.ping = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this.ping.getChannelData(0);
      for (let i = 0; i < len; i++) {
        const t = i / ctx.sampleRate;
        d[i] = (Math.sin(2 * Math.PI * 6400 * t) + 0.6 * Math.sin(2 * Math.PI * 9100 * t)) * Math.exp(-t * 120) * 0.5;
      }
    }
    {
      const len = Math.floor(ctx.sampleRate * 1.2);
      this.crash = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this.crash.getChannelData(0);
      for (let i = 0; i < len; i++) {
        const t = i / ctx.sampleRate;
        d[i] = (Math.random() * 2 - 1) * Math.exp(-t * 4) * (1 + Math.sin(2 * Math.PI * 47 * t));
      }
    }
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (this.ctx) this.master.gain.setTargetAtTime(on ? this.volume : 0, this.ctx.currentTime, 0.05);
  }

  resume() {
    this.ctx?.resume();
  }

  // events are stamped in sim seconds from the start of this frame's update
  frame(events: EngineEvent[], r: Readings, timeScale: number) {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    const now = ctx.currentTime;
    const base = now + 0.06;
    const slow = Math.max(timeScale, 0.001);
    const rpm = Math.max(0, r.rpm);
    const pitch = timeScale < 0.99 ? Math.max(0.35, Math.sqrt(timeScale)) : 1;

    this.exFilter.frequency.setTargetAtTime((380 + rpm * 0.32 + r.throttle * 1400) * pitch, now, 0.03);
    this.intakeFilter.frequency.setTargetAtTime(500 + rpm * 0.25, now, 0.05);
    this.intakeGain.gain.setTargetAtTime(timeScale > 0.5 ? r.throttle * Math.min(1, rpm / 6000) * 0.05 : 0, now, 0.05);
    this.mechGain.gain.setTargetAtTime(timeScale > 0.5 ? Math.min(1, rpm / 8000) * 0.012 : 0, now, 0.08);
    this.starterGain.gain.setTargetAtTime(r.cranking ? 0.05 : 0, now, 0.03);
    this.starterOsc.frequency.setTargetAtTime(120 + Math.max(0, rpm) * 0.4, now, 0.05);

    for (const ev of events) {
      const at = base + ev.t / slow;
      if (at > now + 1.5) continue;
      if (ev.type === 'exhaust') {
        const src = ctx.createBufferSource();
        src.buffer = this.pulses[(Math.random() * 4) | 0];
        src.playbackRate.value = (0.85 + Math.min(1, rpm / 9000) * 0.6) * pitch;
        const g = ctx.createGain();
        const load = 0.12 + ev.amp * 0.75;
        g.gain.value = load * (r.fuelCut ? 0.35 : 1);
        src.connect(g).connect(this.exBus);
        src.start(at);
      } else if (ev.type === 'knock') {
        const src = ctx.createBufferSource();
        src.buffer = this.ping;
        src.playbackRate.value = pitch;
        const g = ctx.createGain();
        g.gain.value = 0.15 + ev.amp * 0.5;
        src.connect(g).connect(this.master);
        src.start(at);
      } else if (ev.type === 'failure') {
        const src = ctx.createBufferSource();
        src.buffer = this.crash;
        const g = ctx.createGain();
        g.gain.value = 0.8;
        src.connect(g).connect(this.master);
        src.start(now + 0.02);
      }
    }
  }
}
