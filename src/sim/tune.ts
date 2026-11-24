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

// stock rods get roughly 18% over the factory limiter before they let go
for (const p of PRESETS) {
  const r = p.stroke / 2000;
  const l = p.rod / 1000;
  const w = ((p.revLimit * 1.18) * 2 * Math.PI) / 60;
  p.rodStrength = Math.round(((p.recipMass / 1000) * r * w * w * (1 + r / l)) / 100) / 10;
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
