// Crank-angle resolved engine model.
// Each cylinder is a single zone of gas: mass, temperature, fresh air fraction.
// Valves are compressible orifices, combustion is a Wiebe burn, heat loss is
// Woschni, knock is a Livengood-Wu integral on the end gas. Torque falls out of
// p * dV/dtheta so pumping losses, cam timing and spark all show up naturally.

import { LAYOUTS, cycleLength, firingAngles, type EngineKind, type LayoutDef } from './layouts';
import { lookupSpark, type Tune } from './tune';

export const PATM = 101325;
const GAMMA = 1.31;
const R = 287;
const CV = R / (GAMMA - 1);
const CP = GAMMA * CV;
const LHV = 44e6;
const STOICH = 14.7;
const T_AMB = 298;
const DEG = Math.PI / 180;

export type FailureKind = 'rod' | 'piston' | 'valve' | 'gasket' | 'turbo';

export interface Failure {
  kind: FailureKind;
  cyl: number; // 0-based
  rpm: number;
}

export interface EngineEvent {
  type: 'exhaust' | 'knock' | 'spark' | 'failure' | 'pop' | 'bov' | 'surge';
  cyl: number;
  t: number; // seconds of sim time since the start of this update() call
  amp: number;
}

export interface CylState {
  idx: number;
  tdc: number; // crank angle of compression TDC
  cycle: number; // 0..720 normalised, 0 = overlap TDC, 360 = firing TDC (rotary: e-shaft deg x 2/3)
  psi: number; // crank angle relative to this cylinder axis, deg
  x: number; // piston distance down from TDC, m
  vel: number; // m/s
  acc: number; // m/s^2
  rodAngle: number; // rad
  V: number;
  dVdth: number; // m^3/rad
  m: number;
  mAir: number;
  T: number;
  p: number;
  inLift: number; // mm
  exLift: number;
  // combustion
  sparkAt: number; // cycle deg
  burning: boolean;
  burnStart: number;
  burnDur: number;
  xb: number;
  Qtot: number;
  pSpark: number;
  TSpark: number;
  knockInt: number;
  knocked: boolean;
  knockFlash: number; // seconds left to show
  sparkFlash: number;
  knockRetard: number;
  damage: number;
  dead: boolean;
  trappedAir: number; // kg at IVC last cycle
  peakP: number;
  peakPLast: number;
  ca50: number;
  ca50Last: number;
  ve: number;
  egt: number;
  lambda: number;
  workAcc: number; // J this cycle
  imep: number; // Pa
  gasket: number; // 0..1, cumulative over pressure
  misfires: number; // cycles that should have lit and didn't
  knocks: number;
  residual: number; // burnt gas fraction left in the charge at spark
  revert: number; // kg of exhaust pushed back up the intake during overlap, comes back first
  unburnt: boolean; // last charge went out the exhaust without lighting
}

export interface Readings {
  rpm: number;
  torque: number; // Nm, net brake, cycle averaged
  power: number; // W
  map: number; // Pa
  boost: number; // Pa gauge
  afr: number;
  lambda: number;
  egt: number; // K
  ve: number;
  spark: number; // deg BTDC commanded
  knockRetard: number;
  throttle: number;
  fuelCut: boolean;
  floatRpm: number;
  rodLoad: number; // N, peak inertial tension on the rods
  rodRating: number;
  running: boolean;
  cranking: boolean;
  idleValve: number;
  spool: number;
  turbo: TurboReadings | null;
  peakBar: number; // highest cylinder pressure last cycle
  pressureLimit: number; // bar
}

export interface TurboReadings {
  shaftRpm: number;
  boost: number; // Pa gauge in the charge pipe, before the throttle
  pr: number; // pressure ratio across the compressor
  flow: number; // kg/s through the compressor
  flowFrac: number; // of the choke flow
  eff: number; // compressor efficiency
  chargeT: number; // K after the intercooler
  compOutT: number; // K straight off the compressor
  emap: number; // Pa exhaust manifold
  surging: boolean;
  dead: boolean;
}

export interface Trace {
  p: Float32Array; // 720 samples, Pa
  V: Float32Array; // m^3
  valid: boolean;
}

// share of the exhaust pushed into the runner that comes back to the same cylinder,
// the rest mixes out into the plenum
const REVERT_KEEP = 0.45;

function clamp(v: number, a: number, b: number) {
  return v < a ? a : v > b ? b : v;
}
function wrap720(a: number) {
  return ((a % 720) + 720) % 720;
}
function angDist720(a: number, b: number) {
  const d = Math.abs(wrap720(a) - wrap720(b));
  return Math.min(d, 720 - d);
}

// Mass flow through an orifice, positive when gas goes from 1 to 2
function orifice(cdA: number, p1: number, T1: number, p2: number, T2: number): number {
  if (cdA <= 0) return 0;
  let sign = 1;
  let pu = p1;
  let Tu = T1;
  let pd = p2;
  if (p2 > p1) {
    sign = -1;
    pu = p2;
    Tu = T2;
    pd = p1;
  }
  const crit = Math.pow(2 / (GAMMA + 1), GAMMA / (GAMMA - 1));
  let pr = pd / pu;
  if (pr < crit) pr = crit;
  const psi = Math.sqrt(((2 * GAMMA) / (GAMMA - 1)) * (Math.pow(pr, 2 / GAMMA) - Math.pow(pr, (GAMMA + 1) / GAMMA)));
  return (sign * cdA * pu * psi) / Math.sqrt(R * Tu);
}

// valve or port windows in normalised cycle degrees
interface Windows {
  inC: number;
  inD: number;
  exC: number;
  exD: number;
}

export class Engine {
  tune!: Tune;
  layout!: LayoutDef;
  kind: EngineKind = 'piston';
  cycleLen = 720; // shaft degrees per full cycle
  kN = 1; // shaft deg to normalised cycle deg
  win: Windows = { inC: 108, inD: 250, exC: 606, exD: 254 };
  cyls: CylState[] = [];

  // geometry, SI
  rotR = 0.105;
  rotE = 0.015;
  rotB = 0.08;
  portInMax = 0;
  portExMax = 0;
  B = 0.1;
  r = 0.044;
  l = 0.145;
  A = 0;
  Vd = 0; // per cylinder
  Vc = 0;
  VdTotal = 0;
  dIn = 0;
  dEx = 0;
  J = 0.2;
  tbArea = 0;
  Vman = 0;
  floatRpm = 7000;
  rodRating = 24000;

  // state
  theta = 0; // crank or e-shaft deg, 0..cycleLen
  omega = 0; // rad/s
  pMan = PATM;
  spool = 0; // turbo shaft speed, 0..1 of its rated max
  turboDead = false;
  turboOver = 0; // seconds spent past the compressor map
  boostUp = 0; // Pa gauge before the throttle
  compEff = 0.72;
  compOutT = T_AMB;
  chargeT = T_AMB;
  emap = PATM;
  bovOpen = false;
  missLog: number[] = []; // sim times, for a per minute rate
  knockLog: number[] = [];
  bovFired = false;
  surging = false;
  surgeClock = 0;
  idleValve = 0.2;
  idleInt = 0;
  idleSpark = 0;
  lastRpm = 0;
  throttle = 0;
  throttleCmd = 0;
  load = 0; // 0..1 absorber
  ignition = false;
  starter = false;
  fuelCut = false;
  knockControl = true;
  killed = new Set<number>();
  failure: Failure | null = null;
  floatTimer = 0;
  rodTimer = 0;
  simTime = 0;

  // dyno
  dynoActive = false;
  dynoTarget = 0;
  dynoRate = 450; // rpm/s
  dynoInt = 0;
  dynoBrake = 0;
  dynoTime = 0;
  dynoStall = 0;
  dynoBest = 0;
  dynoBins = new Map<number, { sum: number; n: number }>();
  onDynoDone: ((bins: Map<number, number>) => void) | null = null;

  // hand turning
  handOmega: number | null = null;
  stepScale = 1;

  // filtered
  torqueF = 0;
  torqueCycle = 0;
  cycAcc = 0;
  cycDeg = 0;
  torqueInst = 0;
  exhFlowF = 0;
  airFlowF = 0;
  egtF = 600;
  sparkCmd = 0;

  // traces of the watched cylinder
  watch = 0;
  traceA: Trace = { p: new Float32Array(720), V: new Float32Array(720), valid: false };
  traceB: Trace = { p: new Float32Array(720), V: new Float32Array(720), valid: false };
  traceLive = this.traceA;
  traceDone = this.traceB;

  events: EngineEvent[] = [];

  constructor(t: Tune) {
    this.setTune(t, true);
  }

  setTune(t: Tune, reset = false) {
    const layoutChanged = !this.tune || this.tune.layout !== t.layout;
    this.tune = t;
    this.layout = LAYOUTS[t.layout];
    this.kind = this.layout.kind;
    this.cycleLen = cycleLength(this.layout);
    this.kN = 720 / this.cycleLen;
    const n = this.layout.cyls.length;
    if (this.kind === 'rotary') {
      this.rotR = t.rotorR / 1000;
      this.rotE = Math.min(t.rotorE, t.rotorR / 5) / 1000;
      this.rotB = t.rotorB / 1000;
      // chamber displacement of one flank: 3 sqrt3 e R b
      this.Vd = 3 * Math.sqrt(3) * this.rotE * this.rotR * this.rotB;
      this.Vc = this.Vd / (t.compression - 1);
      // stand-ins so the shared heat loss and flow sizing have something to chew on
      this.B = Math.cbrt((4 * this.Vd) / Math.PI);
      this.A = (Math.PI * this.B * this.B) / 4;
      this.r = this.rotE;
      this.l = 1;
      this.portInMax = 0.24 * this.rotB * this.rotR;
      this.portExMax = 0.18 * this.rotB * this.rotR;
      this.floatRpm = Infinity;
      // port timing in e-shaft deg -> normalised windows
      const io = t.portIO;
      const ic = 270 + t.portIC;
      const eo = 810 - t.portEO;
      const ec = 1080 + t.portEC;
      this.win = {
        inC: ((io + ic) / 2) * this.kN,
        inD: Math.max(20, ic - io) * this.kN,
        exC: ((eo + ec) / 2) * this.kN,
        exD: Math.max(20, ec - eo) * this.kN,
      };
    } else {
      this.B = t.bore / 1000;
      this.r = t.stroke / 2000;
      this.l = Math.max(t.rod / 1000, this.r * 2.2);
      this.A = (Math.PI * this.B * this.B) / 4;
      this.Vd = this.A * 2 * this.r;
      this.Vc = this.Vd / (t.compression - 1);
      const maxLift = Math.max(t.inLift, t.exLift);
      this.floatRpm = 6800 * t.springRate * Math.sqrt(10 / maxLift) * Math.sqrt(0.088 / (2 * this.r));
      // lifter, pushrod and rocker all have to follow the lobe too
      if (t.valvetrain === 'pushrod') this.floatRpm *= 0.93;
      this.win = { inC: t.inCenterline, inD: t.inDuration, exC: 720 - t.exCenterline, exD: t.exDuration };
    }
    // displacement per 720 of shaft, so a rotary sizes like the piston engine it breathes like
    this.VdTotal = this.Vd * n * this.kN;
    // four valve heads, lumped into one equivalent valve each side
    this.dIn = 0.5 * this.B;
    this.dEx = 0.41 * this.B;
    const L = this.VdTotal * 1000;
    const tbD = (t.tbMm > 0 ? t.tbMm : 40 * Math.pow(L, 0.45)) / 1000;
    this.tbArea = (Math.PI * tbD * tbD) / 4;
    this.Vman = Math.max(0.0012, 1.6 * this.VdTotal);
    this.J = (0.04 + 0.05 * L) * t.flywheel;
    this.rodRating = t.rodStrength * 1000;
    if (this.theta >= this.cycleLen) this.theta %= this.cycleLen;

    const tdcs = firingAngles(this.layout);
    if (reset || layoutChanged || this.cyls.length !== n) {
      this.cyls = this.layout.cyls.map((_, i) => this.freshCyl(i, tdcs[i]));
      this.failure = null;
      this.killed.clear();
      this.watch = Math.min(this.watch, n - 1);
      this.traceA.valid = false;
      this.traceB.valid = false;
    } else {
      this.cyls.forEach((c, i) => (c.tdc = tdcs[i]));
    }
    this.kinematics();
  }

  private freshCyl(i: number, tdc: number): CylState {
    const c: CylState = {
      idx: i,
      tdc,
      cycle: 0,
      psi: 0,
      x: 0,
      vel: 0,
      acc: 0,
      rodAngle: 0,
      V: this.Vc,
      dVdth: 0,
      m: 0,
      mAir: 0,
      T: T_AMB,
      p: PATM,
      inLift: 0,
      exLift: 0,
      sparkAt: 340,
      burning: false,
      burnStart: 0,
      burnDur: 50,
      xb: 0,
      Qtot: 0,
      pSpark: PATM,
      TSpark: 600,
      knockInt: 0,
      knocked: false,
      knockFlash: 0,
      sparkFlash: 0,
      knockRetard: 0,
      damage: 0,
      dead: false,
      trappedAir: 0,
      peakP: 0,
      peakPLast: 0,
      ca50: 0,
      ca50Last: 0,
      ve: 0,
      egt: 600,
      lambda: 1,
      workAcc: 0,
      imep: 0,
      gasket: 0,
      misfires: 0,
      knocks: 0,
      residual: 0,
      revert: 0,
      unburnt: false,
    };
    this.geom(c);
    c.m = (PATM * c.V) / (R * T_AMB);
    c.mAir = c.m;
    return c;
  }

  rebuild() {
    this.failure = null;
    this.cyls.forEach((c) => {
      c.damage = 0;
      c.dead = false;
      c.knockRetard = 0;
      c.gasket = 0;
    });
    this.turboDead = false;
    this.turboOver = 0;
    this.floatTimer = 0;
    this.rodTimer = 0;
  }

  get rpm() {
    return (this.omega * 60) / (2 * Math.PI);
  }

  // Valve lift in mm for a cylinder at a given cycle angle
  valveLift(cycle: number, intake: boolean): number {
    const t = this.tune;
    const w = this.win;
    const center = intake ? w.inC : w.exC;
    const dur = intake ? w.inD : w.exD;
    const d = angDist720(cycle, center);
    if (d >= dur / 2) return 0;
    const u = d / (dur / 2);
    const s = 0.5 * (1 + Math.cos(Math.PI * u));
    if (this.kind === 'rotary') {
      // a port uncovers fast as the apex seal sweeps past, then sits wide open.
      // reported as 0..10 so the ui has something lift shaped to show
      return 10 * Math.min(1, s * 2.2);
    }
    const L = intake ? t.inLift : t.exLift;
    // fast-ish ramps, flat top: raised cosine squashed a bit
    return L * s * (1.25 - 0.25 * s);
  }

  // valve events at a nominal 1 mm of lift, for the timing ring
  valveEvents() {
    const t = this.tune;
    const w = this.win;
    const find = (intake: boolean) => {
      const center = intake ? w.inC : w.exC;
      const dur = intake ? w.inD : w.exD;
      const L = this.kind === 'rotary' ? 1e6 : intake ? t.inLift : t.exLift;
      // solve L * s(1.25 - 0.25s) = 1mm
      const k = Math.min(1, 1 / L);
      const s = (1.25 - Math.sqrt(1.5625 - k)) / 0.5;
      const u = Math.acos(2 * s - 1) / Math.PI;
      const half = u * (dur / 2);
      return { open: wrap720(center - half), close: wrap720(center + half), center: wrap720(center) };
    };
    return { intake: find(true), exhaust: find(false) };
  }

  private geom(c: CylState) {
    if (this.kind === 'rotary') {
      c.cycle = wrap720((this.theta - c.tdc) * this.kN + 360);
      const a = c.cycle * DEG;
      // chamber volume is a pure sinusoid in rotor angle, two humps per 720 normalised
      c.V = this.Vc + (this.Vd / 2) * (1 - Math.cos(a));
      c.dVdth = (this.Vd / 2) * Math.sin(a) * this.kN;
      c.x = (c.V - this.Vc) / this.A;
      c.psi = c.cycle / this.kN;
      c.rodAngle = 0;
      c.vel = this.rotE * this.omega;
      c.acc = this.rotE * this.omega * this.omega;
      return;
    }
    const bank = this.layout.cyls[c.idx].bank;
    const pin = this.layout.cyls[c.idx].pin;
    const psiDeg = this.theta + pin - bank;
    const psi = psiDeg * DEG;
    const r = this.r;
    const l = this.l;
    const s = Math.sin(psi);
    const co = Math.cos(psi);
    const root = Math.sqrt(l * l - r * r * s * s);
    c.psi = ((psiDeg % 360) + 360) % 360;
    c.x = r + l - (r * co + root);
    c.V = this.Vc + this.A * c.x;
    const dxdth = r * s * (1 + (r * co) / root);
    c.dVdth = this.A * dxdth;
    c.rodAngle = Math.asin((r * s) / l);
    c.vel = dxdth * this.omega;
    c.acc = r * this.omega * this.omega * (co + (r * (co * co - s * s)) / l);
    c.cycle = wrap720(this.theta - c.tdc + 360);
  }

  private kinematics() {
    for (const c of this.cyls) {
      this.geom(c);
      c.inLift = this.valveLift(c.cycle, true);
      c.exLift = this.valveLift(c.cycle, false);
    }
  }

  startDyno(fromRpm: number) {
    this.dynoActive = true;
    this.dynoTarget = Math.max(fromRpm, this.rpm);
    this.dynoInt = 0;
    this.dynoTime = 0;
    this.dynoStall = 0;
    this.dynoBest = 0;
    this.dynoBins.clear();
  }

  stopDyno() {
    this.dynoActive = false;
    this.dynoBrake = 0;
  }

  // Advance the sim by dt seconds of engine time
  update(dt: number) {
    this.events.length = 0;
    const t = this.tune;
    let left = dt;
    let elapsed = 0;
    // throttle body motion is quick but not instant
    const thrTarget = this.dynoActive ? 1 : this.throttleCmd;
    this.throttle += (thrTarget - this.throttle) * Math.min(1, dt * 18);

    let guard = 0;
    while (left > 1e-9 && guard++ < 20000) {
      const om = Math.max(Math.abs(this.omega), 20);
      // finer steps at low rpm where the gas has time to do things
      const stepDeg = clamp(0.35 + (om / 1000) * 0.9, 0.35, 0.9) * this.stepScale;
      const dtDeg = (stepDeg * DEG) / om;
      const h = Math.min(left, dtDeg, 4e-5);
      this.step(h, elapsed);
      left -= h;
      elapsed += h;
    }

    // slower control loops, once per frame is plenty
    const rpm = this.rpm;
    const idling = this.ignition && this.throttle < 0.04 && rpm > 300 && !this.dynoActive;
    const rpmRate = dt > 0 ? (rpm - this.lastRpm) / dt : 0;
    this.lastRpm = rpm;
    if (idling) {
      const err = (t.idleRpm - rpm) / 1000;
      if (Math.abs(err) < 0.3) this.idleInt = clamp(this.idleInt + err * dt * 0.25, -0.16, 0.6);
      // air does the slow work, spark does the fast work, like a real idle controller
      this.idleValve = clamp(0.16 + err * 0.35 - rpmRate * 0.00006 + this.idleInt, 0, 1);
      this.idleSpark = clamp(err * 25 - rpmRate * 0.004, -12, 10);
    } else {
      this.idleSpark *= 0.9;
      if (!this.ignition) {
        this.idleValve = 0.16;
        this.idleInt = 0;
      }
    }
    if (rpm > t.revLimit) this.fuelCut = true;
    else if (rpm < t.revLimit - 120) this.fuelCut = false;

    // failure watchdogs
    if (!this.failure && rpm > 300) {
      if (rpm > this.floatRpm * 1.14) this.floatTimer += dt;
      else this.floatTimer = Math.max(0, this.floatTimer - dt);
      const load = this.rodLoad();
      if (load > this.rodRating) this.rodTimer += dt;
      else this.rodTimer = Math.max(0, this.rodTimer - dt);
      if (this.rodTimer > 0.25) this.fail('rod', Math.floor(Math.random() * this.cyls.length));
      else if (this.floatTimer > 0.6) this.fail('valve', Math.floor(Math.random() * this.cyls.length));
      for (const c of this.cyls) if (c.damage >= 1 && !c.dead) this.fail('piston', c.idx);
    }

    for (const c of this.cyls) {
      c.knockFlash = Math.max(0, c.knockFlash - dt);
      c.sparkFlash = Math.max(0, c.sparkFlash - dt);
      if (this.knockControl) c.knockRetard = Math.max(0, c.knockRetard - dt * 1.2);
      else c.knockRetard = 0;
    }
  }

  private fail(kind: FailureKind, cyl: number) {
    this.failure = { kind, cyl, rpm: this.rpm };
    this.cyls[cyl].dead = true;
    this.events.push({ type: 'failure', cyl, t: 0, amp: 1 });
    if (kind === 'rod') {
      // the block lets go, nothing turns after this
      this.ignition = false;
      this.stopDyno();
    }
  }

  private failTurbo() {
    // the compressor wheel lets go. engine lives, boost doesn't
    this.turboDead = true;
    this.failure = { kind: 'turbo', cyl: 0, rpm: this.rpm };
    this.events.push({ type: 'failure', cyl: 0, t: 0, amp: 0.6 });
  }

  // events per minute over the last few seconds of sim time
  rate(log: number[], window = 6) {
    const from = this.simTime - window;
    while (log.length && log[0] < from) log.shift();
    return (log.length / Math.min(window, Math.max(0.5, this.simTime))) * 60;
  }

  resetCounts() {
    for (const c of this.cyls) {
      c.misfires = 0;
      c.knocks = 0;
    }
    this.missLog.length = 0;
    this.knockLog.length = 0;
  }

  rodLoad() {
    const m = this.tune.recipMass / 1000;
    if (this.kind === 'rotary') return m * this.rotE * this.omega * this.omega;
    return m * this.r * this.omega * this.omega * (1 + this.r / this.l);
  }

  private step(h: number, tAt: number) {
    const t = this.tune;
    const rpm = this.rpm;
    const omega = this.omega;
    this.simTime += h;

    // upstream of the throttle: turbo compressor if fitted
    let pUp = PATM;
    let Tup = T_AMB;
    const turbo = t.turbo && !this.turboDead;
    if (turbo) {
      const size = t.turboSize / 56;
      // a 56 mm inducer chokes somewhere near 0.42 kg/s, flow goes with wheel area
      const choke = 0.42 * size * size;
      // the turbine gets more out of hotter gas. a bigger wheel needs more of it to spin up
      const egtAvg = this.cyls.reduce((a, c) => a + c.egt, 0) / this.cyls.length;
      const drive = this.exhFlowF * clamp(egtAvg / 950, 0.4, 1.4);
      const need = 0.16 * Math.pow(size, 2.3);
      // pressure ratio climbs with the square of shaft speed, 3.6 at full speed
      const prMax = 2.6;
      const gatePa = Math.max(0, t.boost) * 6894.76;
      const gateShaft = Math.sqrt(gatePa / (prMax * PATM));
      let target = drive / need;
      // wastegate bleeds the turbine once it makes the set boost
      if (this.boostUp > gatePa * 0.92) target = Math.min(target, gateShaft * 1.02);
      const flowFrac = this.airFlowF / choke;
      // surge: lots of pressure, nowhere for the air to go. the wheel stalls and the air bangs back
      const pr0 = 1 + prMax * this.spool * this.spool;
      const surgeLine = 0.06 + 0.22 * (pr0 - 1);
      this.bovOpen = t.bov && this.throttle < 0.12 && this.boostUp > 3000;
      const wasSurging = this.surging;
      this.surging = !t.bov && pr0 > 1.25 && flowFrac < surgeLine && this.throttle < 0.25;
      // inertia of the wheel, a big turbo takes a while to wake up
      const tau = 0.45 * Math.pow(size, 2.4) / clamp(drive / need, 0.35, 2);
      const fall = this.surging ? 3 : this.bovOpen ? 1.6 : 1;
      this.spool += (target - this.spool) * Math.min(1, (h * (target < this.spool ? fall : 1)) / tau);
      this.spool = clamp(this.spool, 0, 1.3);
      let boostPa = PATM * prMax * this.spool * this.spool;
      // past choke the wheel just spins faster for no more air, pressure sags
      const chokeLoss = clamp((flowFrac - 0.92) / 0.35, 0, 0.75);
      boostPa = Math.min(boostPa, gatePa + 6000) * (1 - chokeLoss);
      if (this.bovOpen) boostPa *= 0.15;
      if (this.surging) {
        // flutter: pressure in the charge pipe pulses as the wheel stalls and recovers
        this.surgeClock += h * (9 + 10 * this.spool);
        if (this.surgeClock >= 1) {
          this.surgeClock -= 1;
          this.events.push({ type: 'surge', cyl: 0, t: tAt, amp: clamp((pr0 - 1) / 1.2, 0.2, 1) });
        }
        boostPa *= 0.75 + 0.25 * Math.sin(this.surgeClock * Math.PI * 2);
      } else this.surgeClock = 0;
      if (!wasSurging && this.bovOpen && this.boostUp > 12000 && !this.bovFired) {
        this.bovFired = true;
        this.events.push({ type: 'bov', cyl: 0, t: tAt, amp: clamp(this.boostUp / 1.2e5, 0.2, 1.2) });
      }
      if (!this.bovOpen) this.bovFired = false;
      this.boostUp += (boostPa - this.boostUp) * Math.min(1, h / 0.05);
      pUp = PATM + this.boostUp;
      // efficiency island sits around 60% of choke flow, falls off toward surge and choke
      this.compEff = clamp(0.76 - 0.55 * (flowFrac - 0.6) ** 2 - 0.3 * chokeLoss, 0.45, 0.77);
      this.compOutT = T_AMB * (1 + (Math.pow(pUp / PATM, 0.286) - 1) / this.compEff);
      Tup = t.intercooler ? T_AMB + (this.compOutT - T_AMB) * 0.28 : this.compOutT;
      // running way off the map overspeeds the wheel
      const over = Math.max(0, flowFrac - 0.98) * 9 + Math.max(0, this.spool - 1.08) * 8;
      if (over > 0 && this.spool > 0.7) this.turboOver += h * over;
      else this.turboOver = Math.max(0, this.turboOver - h * 0.3);
      if (this.turboOver > 1 && !this.failure) this.failTurbo();
    } else {
      this.spool = Math.max(0, this.spool - h * 2);
      this.boostUp = 0;
      this.surging = false;
      this.compOutT = T_AMB;
    }
    this.chargeT = Tup;

    // throttle plate and idle bypass
    const plate = 1 - Math.cos((this.throttle * Math.PI) / 2);
    const area = this.tbArea * (plate + 0.03 * this.idleValve + 0.0008);
    const mdotThr = orifice(0.82 * area, pUp, Tup, this.pMan, Tup);

    // intake runner ram effect, peaks around the tuned rpm
    const tunedRpm = 1.9e6 / Math.max(80, t.runner);
    const ram = 1 + 0.07 * Math.exp(-(((rpm - tunedRpm) / (0.38 * tunedRpm)) ** 2));

    let pExh = PATM * (1.02 + 0.15 * (this.exhFlowF / Math.max(1e-4, (1.18 * this.VdTotal * 6000) / 120)) ** 2);
    if (t.turbo) {
      // the turbine is a restriction. a small housing makes boost early and chokes the engine up top
      const size = t.turboSize / 56;
      const ratio = clamp(1.35 / Math.pow(size, 0.9) - 0.3, 0.55, 1.6);
      pExh += this.boostUp * ratio + PATM * 0.04 * (this.exhFlowF / (0.16 * size * size)) ** 2;
    }
    this.emap = pExh;
    const Texh = 700;

    // valve float: past the float point the valves stop seating properly
    const floatSev = clamp((rpm - this.floatRpm) / (this.floatRpm * 0.12), 0, 1);

    // where are we on the spark map
    const mapKpa = this.pMan / 1000;
    const adv = lookupSpark(t, rpm, mapKpa) + this.idleSpark;
    this.sparkCmd = adv;

    const wot = clamp((mapKpa - 72) / 25, 0, 1);
    const afrCmd = t.afrCruise + (t.afrWot - t.afrCruise) * wot;

    // mean piston speed, or rotor flank speed for a rotary
    const sp = this.kind === 'rotary' ? this.rotR * Math.abs(omega) * 0.4 : (4 * this.r * Math.abs(omega)) / Math.PI;
    const wMot8 = Math.pow(Math.max(2.28 * sp, 0.5), 0.8);
    const wBurn8 = Math.pow(Math.max(2.28 * sp + 3, 0.5), 0.8);
    const bTerm = 3.26 * Math.pow(this.B, -0.2);

    let mdotIntakeSum = 0;
    let mdotExhSum = 0;
    let torque = 0;
    const thetaPrev = this.theta;
    const dTheta = (omega * h) / DEG; // shaft deg
    const dThetaN = dTheta * this.kN; // normalised cycle deg
    const L = this.cycleLen;
    this.theta = (((this.theta + dTheta) % L) + L) % L;

    for (const c of this.cyls) {
      const prevCycle = c.cycle;
      this.geom(c);
      const cyc = c.cycle;
      const crossed = (mark: number) => {
        if (dThetaN <= 0) return false;
        const a = wrap720(mark - prevCycle);
        return a > 0 && a <= dThetaN + 1e-9;
      };

      // new cycle starts at overlap TDC
      if (crossed(0)) {
        // head gasket (or rotary seals): every cycle over the limit eats a bit of it
        const over = c.peakP / (t.pressureLimit * 1e5) - 1;
        if (over > 0 && !c.dead) {
          c.gasket += over * 0.04 + 0.004;
          if (c.gasket >= 1 && !this.failure) this.fail('gasket', c.idx);
        }
        c.peakPLast = c.peakP;
        c.peakP = 0;
        c.ca50Last = c.ca50;
        c.imep = c.workAcc / this.Vd;
        c.workAcc = 0;
        if (c.idx === this.watch) {
          const tmp = this.traceDone;
          this.traceDone = this.traceLive;
          this.traceDone.valid = true;
          this.traceLive = tmp;
        }
      }

      // lift with float bounce
      let li = this.valveLift(cyc, true);
      let le = this.valveLift(cyc, false);
      if (floatSev > 0) {
        li = Math.max(li, t.inLift * 0.12 * floatSev);
        le = Math.max(le, t.exLift * 0.12 * floatSev);
      }
      if (c.dead && this.failure?.kind !== 'piston') {
        // bent valves never close
        if (this.failure?.cyl === c.idx) {
          li = Math.max(li, 1.5);
          le = Math.max(le, 1.5);
        }
      }
      c.inLift = li;
      c.exLift = le;

      // curtain area until the port itself becomes the restriction, around d/4 of lift
      const curtain = (d: number, lift: number) => Math.min(Math.PI * d * (lift / 1000), (Math.PI * d * d) / 4);
      const rot = this.kind === 'rotary';
      const aIn = rot ? (this.portInMax * li) / 10 : curtain(this.dIn, li);
      const aEx = rot ? (this.portExMax * le) / 10 : curtain(this.dEx, le);

      // a holed piston just blows everything into the crankcase
      const leak = c.dead && this.failure?.cyl === c.idx ? (this.failure.kind === 'piston' ? this.A * 0.05 : this.failure.kind === 'gasket' ? this.A * 0.012 : 0) : 0;

      const p = c.p;
      const T = c.T;
      // the intake charge has momentum: after BDC it keeps stuffing the cylinder
      // for a while, more so the faster it is moving. this is what a late
      // closing intake valve cashes in on at high rpm
      const inertia = cyc > 180 && cyc < 320 ? 1 + Math.min(0.25, 0.0045 * (rpm / 1000) ** 2) * Math.sin(((cyc - 180) / 140) * Math.PI) : 1;
      const pIn = this.pMan * ram * inertia;
      let mi = orifice(0.62 * aIn, pIn, Tup, p, T);
      let me = orifice(0.66 * aEx, p, T, pExh, Texh);
      let ml = leak > 0 ? orifice(0.6 * leak, p, T, PATM, T_AMB) : 0;

      // don't let one step overshoot pressure equilibrium
      const lim = (md: number, pa: number) => {
        const cap = (Math.abs(pa - p) * c.V) / (R * T) / h * 0.45;
        return clamp(md, -cap, cap);
      };
      mi = lim(mi, pIn);
      me = lim(me, pExh);
      ml = lim(ml, PATM);

      const dmIn = mi * h;
      const dmEx = me * h;
      const dmLk = ml * h;
      const airFrac = c.m > 0 ? c.mAir / c.m : 0;

      let dE = 0;
      dE += dmIn > 0 ? CP * Tup * dmIn : CP * T * dmIn;
      dE -= dmEx > 0 ? CP * T * dmEx : CP * Texh * dmEx;
      dE -= dmLk > 0 ? CP * T * dmLk : CP * T_AMB * dmLk;

      let mAir = c.mAir;
      if (dmIn > 0) {
        // whatever got shoved up the runner during overlap is first back in
        const back = Math.min(dmIn, c.revert);
        c.revert -= back;
        mAir += dmIn - back;
      } else {
        c.revert = Math.min(c.revert - dmIn * (1 - airFrac) * REVERT_KEEP, c.V * 2);
        mAir += dmIn * airFrac;
      }
      mAir -= dmEx > 0 ? dmEx * airFrac : 0;
      mAir -= dmLk > 0 ? dmLk * airFrac : -dmLk;

      // intake valve closing: this is what the cylinder gets to burn
      if (crossed(wrap720(this.win.inC + this.win.inD / 2))) {
        c.trappedAir = c.mAir;
        const rhoRef = PATM / (R * T_AMB);
        c.ve = c.mAir / (rhoRef * this.Vd);
      }

      // exhaust valve opening: blowdown pulse, the thing you hear
      if (crossed(wrap720(this.win.exC - this.win.exD / 2))) {
        c.egt = T * 0.62;
        this.events.push({ type: 'exhaust', cyl: c.idx, t: tAt, amp: clamp((p - PATM) / 6e5, 0, 1.6) });
        // raw mixture hits a header still hot from the other cylinders and goes off in the pipe
        if (c.unburnt) {
          c.unburnt = false;
          if (Math.max(...this.cyls.map((k) => k.egt)) > 650 && Math.random() < 0.3) this.events.push({ type: 'pop', cyl: c.idx, t: tAt + 0.002, amp: 0.4 + Math.random() * 0.6 });
        }
      }

      // spark
      const totalAdv = (adv - c.knockRetard) * this.kN;
      c.sparkAt = 360 - totalAdv;
      if (crossed(wrap720(c.sparkAt)) && this.ignition) {
        c.sparkFlash = 0.035;
        const air = c.mAir;
        const lambda = afrCmd / STOICH;
        c.lambda = lambda;
        // exhaust left behind (overlap, low manifold pressure) dilutes the charge.
        // past a point the flame gets slow and sloppy and some cycles never light.
        // this is the lope of a big cam and most of a bridgeport's brap
        const xr = c.m > 0 ? clamp(1 - air / c.m, 0, 1) : 0;
        c.residual = xr;
        const dil = Math.max(0, xr - (this.kind === 'rotary' ? 0.2 : 0.14));
        const pMiss = this.kind === 'rotary' ? clamp((dil - 0.1) * 2.6, 0, 0.6) : clamp((dil - 0.12) * 1.6, 0, 0.5);
        const fuelOn = !this.fuelCut && !this.killed.has(c.idx) && !c.dead && lambda <= 1.6 && air >= 1e-7;
        const dilMiss = fuelOn && Math.random() < pMiss;
        const misfire = !fuelOn || dilMiss;
        if (dilMiss) c.unburnt = true;
        // count the ones nobody asked for: not the limiter, not a cut button
        if (!this.starter && rpm > 400 && (dilMiss || (!this.fuelCut && !this.killed.has(c.idx) && !c.dead && lambda > 1.6))) {
          c.misfires++;
          this.missLog.push(this.simTime);
        }
        if (!misfire) {
          let eff: number;
          if (lambda <= 1) eff = 1 - 2.2 * (lambda - 0.87) ** 2;
          else eff = (1 - 2.2 * (1 - 0.87) ** 2) / lambda;
          c.Qtot = (air / STOICH) * LHV * 0.88 * Math.max(0.2, eff);
          // cycle to cycle spread, tiny on a healthy charge, big on a diluted one
          const cov = 0.025 + dil * 1.4;
          c.Qtot *= clamp(1 - Math.random() * Math.random() * cov * 2.2 + (Math.random() - 0.5) * cov * 0.4, 0.1, 1.08);
          // rotary chambers are long and thin, the flame takes longer to cross
          const slow = this.kind === 'rotary' ? this.kN * 1.15 : 1;
          const delay = (8 + (rpm / 1000) * 1.5) * slow;
          const lean = lambda > 1 ? (lambda - 1) * 70 : 0;
          const rich = lambda < 0.8 ? (0.8 - lambda) * 40 : 0;
          const lowLoad = 0.5 * Math.max(0, 0.6 - this.pMan / PATM);
          c.burnStart = c.sparkAt + delay;
          c.burnDur = (50 + (rpm / 1000) * 1.5 + lean + rich) * (1 + lowLoad) * (1 + dil * 2.5) * slow;
          c.burning = true;
          c.xb = 0;
          c.knockInt = 0;
          c.knocked = false;
          c.pSpark = p;
          c.TSpark = T;
          c.ca50 = c.burnStart + 0.517 * c.burnDur - 360;
        }
        this.events.push({ type: 'spark', cyl: c.idx, t: tAt, amp: misfire ? 0 : 1 });
      }

      let dQ = 0;
      if (c.burning) {
        const u = (cyc - c.burnStart) / c.burnDur;
        if (cyc > 560 || cyc < 200) {
          c.burning = false;
        } else if (u > 0) {
          const xbNew = u >= 1.6 ? 1 : 1 - Math.exp(-5 * Math.pow(u, 3));
          const dx = Math.max(0, xbNew - c.xb);
          dQ = c.Qtot * dx;
          mAir -= Math.min(mAir, dx * c.Qtot / (LHV * 0.88) * STOICH);
          c.xb = xbNew;

          // end gas autoignition integral
          if (!c.knocked && c.xb < 0.92) {
            const Tu = c.TSpark * Math.pow(p / c.pSpark, (GAMMA - 1) / GAMMA);
            const tauMs = 17.68 * Math.pow(t.octane / 100, 3.402) * Math.pow(p / PATM, -1.7) * Math.exp(3800 / Tu);
            c.knockInt += (h * 1000) / tauMs;
            if (c.knockInt >= 1) {
              c.knocked = true;
              const intensity = 1 - c.xb;
              c.knockFlash = 0.12;
              c.damage += intensity * 0.012 * Math.max(0.3, p / 6e6);
              if (this.knockControl) c.knockRetard = Math.min(10, c.knockRetard + 2 * intensity + 0.5);
              dQ *= 1.2; // pressure spike
              this.events.push({ type: 'knock', cyl: c.idx, t: tAt, amp: intensity });
              if (!this.starter && rpm > 400) {
                c.knocks++;
                this.knockLog.push(this.simTime);
              }
            }
          }
          if (c.xb >= 0.999) c.burning = false;
        }
      }

      // Woschni-ish wall heat loss
      const w8 = c.burning ? wBurn8 : wMot8;
      const hc = bTerm * Math.exp(0.8 * Math.log(Math.max(p, 1) / 1000) - 0.55 * Math.log(T)) * w8;
      // rotary: flank + housing strip + two side plates, a lot of wall for the volume
      const area = this.kind === 'rotary' ? 1.5 * this.rotR * this.rotB + (2 * c.V) / this.rotB : 2 * this.A + Math.PI * this.B * c.x;
      const qLoss = 1.7 * hc * area * (T - 450) * h;

      const dV = c.dVdth * dTheta * DEG;
      const mNew = Math.max(1e-8, c.m + dmIn - dmEx - dmLk);
      const U = c.m * CV * T + dE + dQ - qLoss - p * dV;
      c.T = clamp(U / (mNew * CV), 220, 3200);
      c.m = mNew;
      c.mAir = clamp(mAir, 0, mNew);
      c.p = (c.m * R * c.T) / c.V;
      if (c.p > c.peakP) c.peakP = c.p;
      c.workAcc += (p - PATM) * dV;

      torque += (c.p - PATM) * c.dVdth;
      mdotIntakeSum += mi;
      mdotExhSum += me;

      if (c.idx === this.watch) {
        const k = Math.floor(cyc) % 720;
        this.traceLive.p[k] = c.p;
        this.traceLive.V[k] = c.V;
      }
    }

    // manifold filling and emptying
    this.pMan += ((R * Tup) / this.Vman) * (mdotThr - mdotIntakeSum) * h;
    this.pMan = clamp(this.pMan, 8000, pUp + 30000);

    const k = Math.min(1, h * 6);
    this.exhFlowF += (Math.max(0, mdotExhSum) - this.exhFlowF) * k;
    this.airFlowF += (Math.max(0, mdotThr) - this.airFlowF) * k;

    // friction, starter, absorber
    const N = Math.abs(rpm) / 1000;
    const fmep = (1.1 + 0.08 * N + 0.014 * N * N) * 1e5;
    // no valvetrain on a rotary, so a bit less to drag around
    let tFric = ((this.kind === 'rotary' ? 0.8 : 1) * fmep * this.VdTotal) / (4 * Math.PI);
    tFric *= Math.tanh(omega / 3);
    if (this.failure?.kind === 'rod') tFric += 400 * Math.tanh(omega / 2);

    let tStarter = 0;
    if (this.starter && !this.failure) {
      const Ls = this.VdTotal * 1000;
      tStarter = (110 + 90 * Ls) * Math.max(0, 1 - rpm / 420);
    }

    let tLoad = 0;
    if (this.dynoActive) {
      // hold the ramp until the engine catches up to it
      if (rpm > this.dynoTarget - 150) this.dynoTarget += this.dynoRate * h;
      const err = (rpm - this.dynoTarget) / 100;
      this.dynoInt = clamp(this.dynoInt + err * h * 40, 0, 4000);
      this.dynoBrake = clamp(err * 60 + this.dynoInt, 0, 4000);
      tLoad = this.dynoBrake * Math.tanh(omega / 5);
    } else {
      const tRef = this.VdTotal * 1000 * 130 * (1 + (t.turbo ? t.boost : 0) / 14.7);
      tLoad = this.load * tRef * clamp(rpm / 1500, 0, 1);
    }

    const tNet = torque - tFric;
    this.torqueInst = tNet;
    // exact average over one full 720, then a light filter for the gauges
    this.cycAcc += tNet * dTheta;
    this.cycDeg += dTheta;
    if (this.cycDeg >= 720) {
      this.torqueCycle = this.cycAcc / this.cycDeg;
      this.cycAcc = 0;
      this.cycDeg = 0;
    } else if (Math.abs(omega) < 15) {
      this.torqueCycle += (tNet - this.torqueCycle) * Math.min(1, h * 4);
    }
    this.torqueF += (this.torqueCycle - this.torqueF) * Math.min(1, h * 12);

    if (this.handOmega !== null) {
      this.omega = this.handOmega;
    } else {
      this.omega += ((tNet + tStarter - tLoad) / this.J) * h;
      if (this.omega < 0 && !this.starter) this.omega *= 0.5;
      if (this.omega < -5) this.omega = -5;
    }

    if (this.dynoActive) {
      this.dynoTime += h;
      if (rpm > this.dynoBest + 20) {
        this.dynoBest = rpm;
        this.dynoStall = 0;
      } else this.dynoStall += h;
    }
    const engineGaveUp = this.dynoActive && this.dynoStall > 1.5;
    if (this.dynoActive && ((this.dynoTime > 0.6 && Math.abs(rpm - this.dynoTarget) < 150) || engineGaveUp)) {
      const bin = Math.round(rpm / 100) * 100;
      const b = this.dynoBins.get(bin) ?? { sum: 0, n: 0 };
      if (!engineGaveUp) {
        b.sum += this.torqueCycle;
        b.n++;
        this.dynoBins.set(bin, b);
      }
      if (this.dynoTarget >= t.revLimit - 80 || this.failure || engineGaveUp) {
        const out = new Map<number, number>();
        [...this.dynoBins.entries()].sort((x, y) => x[0] - y[0]).forEach(([r, v]) => v.n > 0 && out.set(r, v.sum / v.n));
        this.stopDyno();
        this.onDynoDone?.(out);
      }
    }
    void thetaPrev;
  }

  readings(): Readings {
    const rpm = this.rpm;
    const running = this.ignition && rpm > 250;
    const ves = this.cyls.map((c) => c.ve);
    const egts = this.cyls.map((c) => c.egt);
    this.egtF += (egts.reduce((a, b) => a + b, 0) / egts.length - this.egtF) * 0.05;
    const kr = this.cyls.reduce((a, c) => Math.max(a, c.knockRetard), 0);
    const wot = clamp((this.pMan / 1000 - 72) / 25, 0, 1);
    const afr = this.tune.afrCruise + (this.tune.afrWot - this.tune.afrCruise) * wot;
    return {
      rpm,
      torque: this.torqueF,
      power: this.torqueF * this.omega,
      map: this.pMan,
      boost: this.pMan - PATM,
      afr: this.fuelCut || !this.ignition ? 0 : afr,
      lambda: afr / STOICH,
      egt: this.egtF,
      ve: ves.reduce((a, b) => a + b, 0) / ves.length,
      spark: this.sparkCmd - kr,
      knockRetard: kr,
      throttle: this.throttle,
      fuelCut: this.fuelCut,
      floatRpm: this.floatRpm,
      rodLoad: this.rodLoad(),
      rodRating: this.rodRating,
      running,
      cranking: this.starter,
      idleValve: this.idleValve,
      spool: this.spool,
      turbo: this.tune.turbo
        ? {
            shaftRpm: this.turboDead ? 0 : (this.spool * 165000) / (this.tune.turboSize / 56),
            boost: this.boostUp,
            pr: (PATM + this.boostUp) / PATM,
            flow: this.airFlowF,
            flowFrac: this.airFlowF / (0.42 * (this.tune.turboSize / 56) ** 2),
            eff: this.compEff,
            chargeT: this.chargeT,
            compOutT: this.compOutT,
            emap: this.emap,
            surging: this.surging,
            dead: this.turboDead,
          }
        : null,
      peakBar: this.cyls.reduce((a, c) => Math.max(a, c.peakPLast), 0) / 1e5,
      pressureLimit: this.tune.pressureLimit,
    };
  }
}
