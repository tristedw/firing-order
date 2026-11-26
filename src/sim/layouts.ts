// Engine layouts. Each cylinder has a bank angle (cylinder axis, measured from
// vertical around the crank axis), a crankpin angle, and an x position along
// the crank. TDC angles get worked out from the geometry + firing order so the
// cylinders always agree with the metal.

export type LayoutId = 'single' | 'vtwin' | 'i3' | 'i4' | 'i6' | 'v8-cross' | 'v8-ls' | 'v8-flat' | 'rotary-1' | 'rotary-2' | 'rotary-3';
export type EngineKind = 'piston' | 'rotary';

export interface CylDef {
  bank: number; // deg
  pin: number; // deg
  x: number; // position along crank, in bore spacings
  pinIndex: number;
  rotor?: number; // rotary only
  face?: number; // rotary only, 0..2
}

export interface LayoutDef {
  id: LayoutId;
  kind: EngineKind;
  name: string;
  short: string;
  labels: string[]; // what each cylinder or rotor face is called in the ui
  rotors?: { phase: number; x: number }[]; // rotary only, e-shaft phase in deg
  firingOrder: number[]; // 1-based cylinder numbers
  cyls: CylDef[]; // index 0 = cylinder 1
  pins: { angle: number; x: number; width: number }[];
  mains: number[]; // x positions of main journals
}

function inline(n: number, pins: number[], order: number[], id: LayoutId, name: string, short: string): LayoutDef {
  const cyls: CylDef[] = [];
  const pinsOut: LayoutDef['pins'] = [];
  const mains: number[] = [];
  const off = (n - 1) / 2;
  for (let i = 0; i < n; i++) {
    const x = (i - off) * 1.25;
    cyls.push({ bank: 0, pin: pins[i], x, pinIndex: i });
    pinsOut.push({ angle: pins[i], x, width: 1 });
    mains.push(x - 0.625);
  }
  mains.push((n - 1 - off) * 1.25 + 0.625);
  return { id, kind: 'piston', name, short, labels: cyls.map((_, i) => String(i + 1)), firingOrder: order, cyls, pins: pinsOut, mains };
}

function v8(pins: number[], order: number[], id: LayoutId, name: string, short: string): LayoutDef {
  // GM style numbering: odd cylinders on one bank, even on the other.
  // Odd bank sits a little forward since each pair of rods shares a pin.
  const cyls: CylDef[] = [];
  const pinsOut: LayoutDef['pins'] = [];
  const mains: number[] = [];
  for (let p = 0; p < 4; p++) {
    const px = (p - 1.5) * 1.35;
    pinsOut.push({ angle: pins[p], x: px, width: 1.1 });
    mains.push(px - 0.675);
    cyls.push({ bank: 45, pin: pins[p], x: px - 0.27, pinIndex: p }); // odd bank
    cyls.push({ bank: -45, pin: pins[p], x: px + 0.27, pinIndex: p }); // even bank
  }
  mains.push(1.5 * 1.35 + 0.675);
  return { id, kind: 'piston', name, short, labels: cyls.map((_, i) => String(i + 1)), firingOrder: order, cyls, pins: pinsOut, mains };
}

// Wankel. Each rotor has three faces and each face runs its own four stroke
// cycle over 1080 deg of e-shaft. Face i of a rotor fires when the middle of its
// flank passes the plug side of the housing (see firingAngles).
function rotary(n: number, phases: number[], id: LayoutId, name: string, short: string): LayoutDef {
  const cyls: CylDef[] = [];
  const rotors: { phase: number; x: number }[] = [];
  const labels: string[] = [];
  const off = (n - 1) / 2;
  for (let r = 0; r < n; r++) {
    const x = (r - off) * 1.1;
    rotors.push({ phase: phases[r], x });
    for (let f = 0; f < 3; f++) {
      cyls.push({ bank: 0, pin: 0, x, pinIndex: r, rotor: r, face: f });
      labels.push(`${r + 1}${'ABC'[f]}`);
    }
  }
  const def: LayoutDef = { id, kind: 'rotary', name, short, labels, rotors, firingOrder: [], cyls, pins: [], mains: [-off * 1.1 - 0.7, off * 1.1 + 0.7] };
  const fa = firingAngles(def);
  const order = fa.map((a, i) => [a, i + 1]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
  const k = order.indexOf(1);
  def.firingOrder = [...order.slice(k), ...order.slice(0, k)];
  return def;
}

export const LAYOUTS: Record<LayoutId, LayoutDef> = {
  single: inline(1, [0], [1], 'single', 'Single', '1 cyl'),
  vtwin: {
    id: 'vtwin',
    kind: 'piston',
    name: '45° V-twin',
    short: 'V2',
    labels: ['1', '2'],
    firingOrder: [1, 2],
    cyls: [
      { bank: -22.5, pin: 0, x: -0.2, pinIndex: 0 },
      { bank: 22.5, pin: 0, x: 0.2, pinIndex: 0 },
    ],
    pins: [{ angle: 0, x: 0, width: 0.9 }],
    mains: [-0.6, 0.6],
  },
  i3: inline(3, [0, 120, 240], [1, 2, 3], 'i3', 'Inline 3', 'I3'),
  i4: inline(4, [0, 180, 180, 0], [1, 3, 4, 2], 'i4', 'Inline 4', 'I4'),
  i6: inline(6, [0, 240, 120, 120, 240, 0], [1, 5, 3, 6, 2, 4], 'i6', 'Inline 6', 'I6'),
  'v8-cross': v8([0, 90, 270, 180], [1, 8, 4, 3, 6, 5, 7, 2], 'v8-cross', 'Cross-plane V8 (SBC order)', 'V8'),
  // same crank as the small block, the LS cam swaps the 4 and 7 events
  'v8-ls': v8([0, 90, 270, 180], [1, 8, 7, 2, 6, 5, 4, 3], 'v8-ls', 'Cross-plane V8 (LS order)', 'LS'),
  'v8-flat': v8([0, 180, 180, 0], [1, 4, 3, 8, 7, 6, 5, 2], 'v8-flat', 'Flat-plane V8', 'V8 flat'),
  'rotary-1': rotary(1, [0], 'rotary-1', 'Single rotor', '1 rotor'),
  'rotary-2': rotary(2, [0, 180], 'rotary-2', 'Two rotor', '2 rotor'),
  'rotary-3': rotary(3, [0, 240, 120], 'rotary-3', 'Three rotor', '3 rotor'),
};

export function cycleLength(l: LayoutDef) {
  return l.kind === 'rotary' ? 1080 : 720;
}

// For each cylinder, the crank angle (0..720) where it hits compression TDC.
// Geometry only gives TDC mod 360. Try every combo of +0/+360 and keep the one
// that walks the firing order once around the 720 with the most even gaps.
export function firingAngles(layout: LayoutDef): number[] {
  const n = layout.cyls.length;
  const mod = (a: number, m: number) => ((a % m) + m) % m;
  if (layout.kind === 'rotary') {
    // flank i of a rotor at phase p is centred on the plug side (bottom minor
    // axis) when theta + p = 630 - 360 i, mod 1080 e-shaft deg
    return layout.cyls.map((c) => mod(630 - 360 * (c.face ?? 0) - layout.rotors![c.rotor ?? 0].phase, 1080));
  }
  const order = layout.firingOrder.map((c) => c - 1);
  const base = order.map((i) => mod(layout.cyls[i].bank - layout.cyls[i].pin, 360));
  let best: number[] | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 1 << (n - 1); mask++) {
    const seq = base.map((t, k) => (k === 0 ? t : t + ((mask >> (k - 1)) & 1) * 360));
    let sum = 0;
    let score = 0;
    const even = 720 / n;
    for (let k = 0; k < n; k++) {
      let g = mod(seq[(k + 1) % n] - seq[k], 720);
      if (g === 0) g = 720;
      sum += g;
      score += (g - even) ** 2;
    }
    if (n > 1 && Math.abs(sum - 720) > 1e-6) continue;
    if (score < bestScore) {
      bestScore = score;
      best = seq;
    }
  }
  const out = new Array<number>(n).fill(0);
  (best ?? base).forEach((a, k) => (out[order[k]] = mod(a, 720)));
  return out;
}
