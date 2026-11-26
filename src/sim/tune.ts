import type { LayoutId } from './layouts';

export const SPARK_RPM = [500, 1000, 1500, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000];
export const SPARK_MAP = [20, 40, 60, 80, 100, 140, 180, 220]; // kPa

export interface Tune {
  name: string;
  layout: LayoutId;
  bore: number; // mm
  stroke: number; // mm
  rod: number; // mm, center to center
  compression: number; // :1
  inDuration: number; // crank deg, advertised
  exDuration: number;
  inCenterline: number; // deg ATDC
  exCenterline: number; // deg BTDC
  inLift: number; // mm at the valve
  exLift: number;
  springRate: number; // 0.5..2, scales valve float rpm
  runner: number; // intake runner length mm
  spark: number[][]; // [map][rpm] deg BTDC
  afrCruise: number;
  afrWot: number;
  octane: number;
  revLimit: number;
  idleRpm: number;
  boost: number; // psi, 0 = naturally aspirated
  flywheel: number; // inertia multiplier
  recipMass: number; // grams, piston + pin + rings + small end
  rodStrength: number; // kN of inertial tension the rods survive
  tbMm: number; // throttle body bore, 0 = size it from displacement
  knockSensors: boolean;
  // rotary only, mm and e-shaft deg
  rotorR: number; // generating radius
  rotorE: number; // eccentricity
  rotorB: number; // rotor width
  portIO: number; // intake opens ATDC
  portIC: number; // intake closes ABDC
  portEO: number; // exhaust opens BBDC
  portEC: number; // exhaust closes ATDC (negative = BTDC)
  notes?: string;
}

export function makeSpark(peak: number, lowRpmBase: number, loadPull: number, knee = 3500): number[][] {
  return SPARK_MAP.map((map) =>
    SPARK_RPM.map((rpm) => {
      const rpmPart = lowRpmBase + (peak - lowRpmBase) * Math.min(1, Math.max(0, (rpm - 500) / (knee - 500)));
      const loadPart = Math.min(1, Math.max(0, (map - 30) / 70)) * loadPull;
      const boostPart = Math.max(0, (map - 100) / 40) * 2.5;
      return Math.round((rpmPart - loadPart - boostPart) * 2) / 2;
    }),
  );
}

const base: Omit<Tune, 'name' | 'layout' | 'bore' | 'stroke' | 'rod'> = {
  compression: 10,
  inDuration: 250,
  exDuration: 254,
  inCenterline: 108,
  exCenterline: 114,
  inLift: 10,
  exLift: 9.6,
  springRate: 1,
  runner: 300,
  spark: makeSpark(34, 14, 10),
  afrCruise: 14.7,
  afrWot: 12.8,
  octane: 91,
  revLimit: 6800,
  idleRpm: 750,
  boost: 0,
  flywheel: 1,
  recipMass: 520,
  rodStrength: 20,
  tbMm: 0,
  knockSensors: true,
  rotorR: 105,
  rotorE: 15,
  rotorB: 80,
  portIO: 3,
  portIC: 65,
  portEO: 50,
  portEC: -3,
};

export const PRESETS: Tune[] = [
  {
    ...base,
    name: 'Small block 350',
    layout: 'v8-cross',
    bore: 101.6,
    stroke: 88.4,
    rod: 145,
    compression: 9.5,
    inDuration: 262,
    exDuration: 270,
    inCenterline: 110,
    exCenterline: 114,
    inLift: 11.3,
    exLift: 11.5,
    runner: 380,
    revLimit: 6000,
    idleRpm: 700,
    spark: makeSpark(36, 14, 12),
    recipMass: 640,
  },
  {
    ...base,
    name: 'Tahoe LM7 (MTC8)',
    layout: 'v8-ls',
    bore: 96.0,
    stroke: 92.0,
    rod: 154.9,
    compression: 9.5,
    // Melling MTC-8: 274/280 adv, 212/218 @ .050, .522/.529, 114 LSA, in 4 deg advanced
    inDuration: 274,
    exDuration: 280,
    inCenterline: 110,
    exCenterline: 118,
    inLift: 13.26,
    exLift: 13.44,
    springRate: 1.15,
    runner: 470,
    tbMm: 78,
    afrCruise: 14.7,
    afrWot: 12.6,
    octane: 87,
    knockSensors: false,
    revLimit: 6000,
    idleRpm: 700,
    spark: makeSpark(36, 16, 13, 4000),
    flywheel: 1.25,
    recipMass: 700,
    notes: '2004 Tahoe 5.3 LM7. Melling MTC-8 cam, cold air intake, headers, 78 mm drive by wire throttle body. 87 octane, no knock sensors so knock control is off and the spark table is all you get. SM465 manual, so a heavier flywheel.',
  },
  {
    ...base,
    name: 'LM7 stock cam',
    layout: 'v8-ls',
    bore: 96.0,
    stroke: 92.0,
    rod: 154.9,
    compression: 9.5,
    // 2000 to 2007 LM7: 190/191 @ .050, .457/.466, 114 LSA, 112/116
    inDuration: 252,
    exDuration: 254,
    inCenterline: 112,
    exCenterline: 116,
    inLift: 11.6,
    exLift: 11.84,
    runner: 470,
    tbMm: 78,
    afrWot: 12.6,
    octane: 87,
    revLimit: 6000,
    idleRpm: 600,
    spark: makeSpark(38, 16, 13, 4000),
    flywheel: 1.25,
    recipMass: 700,
    notes: 'Factory 2004 LM7 for comparison. Run a pull here, then switch to the MTC8 tune and pull again to see the cam swap on the dyno.',
  },
  {
    ...base,
    name: 'Flat-plane 5.2',
    layout: 'v8-flat',
    bore: 94,
    stroke: 93,
    rod: 150,
    compression: 12,
    inDuration: 276,
    exDuration: 280,
    inCenterline: 104,
    exCenterline: 108,
    inLift: 13.5,
    exLift: 12.5,
    runner: 230,
    octane: 94,
    springRate: 1.5,
    revLimit: 8250,
    idleRpm: 900,
    spark: makeSpark(34, 16, 10, 4500),
    recipMass: 440,
  },
  {
    ...base,
    name: 'Econo four',
    layout: 'i4',
    bore: 86,
    stroke: 86,
    rod: 143,
    compression: 10.5,
    inDuration: 240,
    exDuration: 244,
    inCenterline: 110,
    exCenterline: 112,
    inLift: 9.2,
    exLift: 8.8,
    octane: 87,
    revLimit: 6800,
    spark: makeSpark(32, 12, 10),
    recipMass: 420,
  },
  {
    ...base,
    name: 'Boosted four',
    layout: 'i4',
    bore: 86,
    stroke: 86,
    rod: 143,
    compression: 8.8,
    inDuration: 248,
    exDuration: 252,
    inCenterline: 110,
    exCenterline: 114,
    inLift: 10,
    exLift: 9.6,
    boost: 14,
    afrWot: 11.8,
    springRate: 1.15,
    octane: 94,
    revLimit: 7000,
    spark: makeSpark(30, 12, 9),
    recipMass: 470,
  },
  {
    ...base,
    name: 'Straight six',
    layout: 'i6',
    bore: 84,
    stroke: 89.6,
    rod: 135,
    compression: 10.2,
    inDuration: 248,
    exDuration: 252,
    inCenterline: 108,
    exCenterline: 112,
    revLimit: 6500,
    runner: 420,
    spark: makeSpark(34, 14, 11),
    recipMass: 450,
  },
  {
    ...base,
    name: 'Triple',
    layout: 'i3',
    bore: 78,
    stroke: 78.4,
    rod: 125,
    compression: 11,
    revLimit: 9000,
    springRate: 1.4,
    inDuration: 262,
    exDuration: 258,
    inCenterline: 106,
    exCenterline: 108,
    inLift: 9,
    exLift: 8.5,
    runner: 220,
    octane: 91,
    idleRpm: 1100,
    flywheel: 0.6,
    spark: makeSpark(36, 14, 10, 5000),
    recipMass: 300,
  },
  {
    ...base,
    name: 'Big twin',
    layout: 'vtwin',
    bore: 100,
    stroke: 111,
    rod: 160,
    compression: 9.7,
    inDuration: 236,
    exDuration: 244,
    inCenterline: 108,
    exCenterline: 112,
    inLift: 11,
    exLift: 10.5,
    revLimit: 5500,
    idleRpm: 900,
    runner: 260,
    spark: makeSpark(32, 12, 10, 3000),
    flywheel: 1.4,
    recipMass: 700,
  },
  {
    ...base,
    name: '13B Renesis',
    bore: 86,
    stroke: 86,
    rod: 143,
    layout: 'rotary-2',
    compression: 10,
    rotorR: 105,
    rotorE: 15,
    rotorB: 80,
    portIO: 3,
    portIC: 65,
    portEO: 50,
    portEC: -3,
    octane: 91,
    revLimit: 9000,
    idleRpm: 900,
    runner: 220,
    flywheel: 1.1,
    spark: makeSpark(30, 10, 8, 5000),
    afrWot: 12.2,
    recipMass: 4600,
    notes: 'RX-8 high power 13B-MSP. Side intake and side exhaust ports, so almost no overlap. Spark and port timing are in e-shaft degrees.',
  },
  {
    ...base,
    name: '13B-REW twin turbo',
    bore: 86,
    stroke: 86,
    rod: 143,
    layout: 'rotary-2',
    compression: 9.0,
    portIO: 32,
    portIC: 50,
    portEO: 75,
    portEC: 48,
    boost: 10,
    afrWot: 11.3,
    octane: 94,
    revLimit: 8000,
    idleRpm: 800,
    runner: 260,
    flywheel: 1.1,
    spark: makeSpark(26, 8, 6, 4500),
    recipMass: 4600,
    notes: 'FD RX-7. Peripheral exhaust port gives the long overlap and the lumpy idle. Spark and port timing are in e-shaft degrees.',
  },
  {
    ...base,
    name: '20B three rotor',
    bore: 86,
    stroke: 86,
    rod: 143,
    layout: 'rotary-3',
    compression: 9.0,
    portIO: 32,
    portIC: 50,
    portEO: 75,
    portEC: 48,
    boost: 4,
    afrWot: 11.4,
    octane: 94,
    revLimit: 7500,
    idleRpm: 850,
    runner: 260,
    flywheel: 1.1,
    spark: makeSpark(26, 8, 6, 4500),
    recipMass: 4600,
    notes: 'Cosmo 20B. Three rotors 120 deg apart on the e-shaft, so it fires every 120 deg like a V12.',
  },
  {
    ...base,
    name: 'Mower single',
    layout: 'single',
    bore: 68,
    stroke: 55,
    rod: 90,
    compression: 8.5,
    inDuration: 230,
    exDuration: 230,
    inCenterline: 112,
    exCenterline: 112,
    inLift: 6,
    exLift: 6,
    revLimit: 3800,
    idleRpm: 1600,
    runner: 120,
    octane: 87,
    spark: makeSpark(24, 18, 4, 2000),
    flywheel: 2.2,
    recipMass: 160,
  },
];

// stock rods (or rotor bearings) get roughly 18% over the factory limiter
for (const p of PRESETS) {
  const w = ((p.revLimit * 1.18) * 2 * Math.PI) / 60;
  const m = p.recipMass / 1000;
  if (p.layout.startsWith('rotary')) {
    p.rodStrength = Math.round((m * (p.rotorE / 1000) * w * w) / 100) / 10;
  } else {
    const r = p.stroke / 2000;
    const l = p.rod / 1000;
    p.rodStrength = Math.round((m * r * w * w * (1 + r / l)) / 100) / 10;
  }
}

export function cloneTune(t: Tune): Tune {
  return { ...t, spark: t.spark.map((r) => [...r]) };
}

// Share links: compact json in the hash
export function encodeTune(t: Tune): string {
  const json = JSON.stringify(t);
  return btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeTune(s: string): Tune | null {
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(escape(atob(b64)));
    const t = JSON.parse(json) as Tune;
    if (!t || typeof t.bore !== 'number' || !Array.isArray(t.spark)) return null;
    if (t.spark.length !== SPARK_MAP.length || t.spark[0].length !== SPARK_RPM.length) return null;
    return { ...PRESETS[0], ...t };
  } catch {
    return null;
  }
}

export function lookupSpark(t: Tune, rpm: number, mapKpa: number): number {
  const fi = (axis: number[], v: number) => {
    if (v <= axis[0]) return [0, 0, 0] as const;
    for (let i = 0; i < axis.length - 1; i++) {
      if (v <= axis[i + 1]) return [i, i + 1, (v - axis[i]) / (axis[i + 1] - axis[i])] as const;
    }
    const l = axis.length - 1;
    return [l, l, 0] as const;
  };
  const [r0, r1, rf] = fi(SPARK_RPM, rpm);
  const [m0, m1, mf] = fi(SPARK_MAP, mapKpa);
  const a = t.spark[m0][r0] * (1 - rf) + t.spark[m0][r1] * rf;
  const b = t.spark[m1][r0] * (1 - rf) + t.spark[m1][r1] * rf;
  return a * (1 - mf) + b * mf;
}
