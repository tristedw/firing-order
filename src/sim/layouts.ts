// Engine layouts. Each cylinder has a bank angle (cylinder axis, measured from
// vertical around the crank axis), a crankpin angle, and an x position along
// the crank. TDC angles get worked out from the geometry + firing order so the
// cylinders always agree with the metal.

export type LayoutId = 'single' | 'vtwin' | 'i3' | 'i4' | 'i6' | 'v8-cross' | 'v8-flat';

export interface CylDef {
  bank: number; // deg
  pin: number; // deg
  x: number; // position along crank, in bore spacings
  pinIndex: number;
}

export interface LayoutDef {
  id: LayoutId;
  name: string;
  short: string;
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
  return { id, name, short, firingOrder: order, cyls, pins: pinsOut, mains };
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
  return { id, name, short, firingOrder: order, cyls, pins: pinsOut, mains };
}

export const LAYOUTS: Record<LayoutId, LayoutDef> = {
  single: inline(1, [0], [1], 'single', 'Single', '1 cyl'),
  vtwin: {
    id: 'vtwin',
    name: '45° V-twin',
    short: 'V2',
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
  'v8-cross': v8([0, 90, 270, 180], [1, 8, 4, 3, 6, 5, 7, 2], 'v8-cross', 'Cross-plane V8', 'V8'),
  'v8-flat': v8([0, 180, 180, 0], [1, 4, 3, 8, 7, 6, 5, 2], 'v8-flat', 'Flat-plane V8', 'V8 flat'),
};

// For each cylinder, the crank angle (0..720) where it hits compression TDC.
// Geometry only gives TDC mod 360. Try every combo of +0/+360 and keep the one
// that walks the firing order once around the 720 with the most even gaps.
export function firingAngles(layout: LayoutDef): number[] {
  const n = layout.cyls.length;
  const mod = (a: number, m: number) => ((a % m) + m) % m;
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
