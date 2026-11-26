import type { Engine, Trace } from '../sim/engine';

export function css(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// canvas sized to its css box at device pixel ratio
export function fit(c: HTMLCanvasElement) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = c.clientWidth;
  const h = c.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const g = c.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w, h };
}

const FONT = '"Poppins", system-ui, sans-serif';

interface Palette {
  ink: string;
  ink2: string;
  line: string;
  charge: string;
  exhaust: string;
  spark: string;
  heat: string;
  panel: string;
}

function pal(): Palette {
  return {
    ink: css('--ink'),
    ink2: css('--ink-2'),
    line: css('--line'),
    charge: css('--charge'),
    exhaust: css('--exhaust'),
    spark: css('--spark'),
    heat: css('--heat'),
    panel: css('--panel'),
  };
}

// ---------------------------------------------------------------- tach

export function drawTach(c: HTMLCanvasElement, rpm: number, limit: number, floatRpm: number, cut: boolean) {
  const { g, w, h } = fit(c);
  const p = pal();
  g.clearRect(0, 0, w, h);
  const max = Math.ceil((limit + 1200) / 1000) * 1000;
  const cx = w / 2;
  const cy = h * 0.58;
  const R = Math.min(w * 0.46, h * 0.56);
  const a0 = Math.PI * 0.8;
  const a1 = Math.PI * 2.2;
  const ang = (v: number) => a0 + (a1 - a0) * Math.min(1, Math.max(0, v / max));

  g.lineCap = 'butt';
  g.lineWidth = 10;
  g.strokeStyle = p.line;
  g.beginPath();
  g.arc(cx, cy, R, a0, a1);
  g.stroke();

  // live sweep
  g.strokeStyle = p.ink;
  g.beginPath();
  g.arc(cx, cy, R, a0, ang(rpm));
  g.stroke();

  // redline
  g.strokeStyle = p.heat;
  g.beginPath();
  g.arc(cx, cy, R, ang(limit), a1);
  g.stroke();

  // float point
  if (floatRpm < max) {
    const fa = ang(floatRpm);
    g.strokeStyle = p.spark;
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(cx + Math.cos(fa) * (R - 12), cy + Math.sin(fa) * (R - 12));
    g.lineTo(cx + Math.cos(fa) * (R + 9), cy + Math.sin(fa) * (R + 9));
    g.stroke();
  }

  g.fillStyle = p.ink2;
  g.font = `500 10px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (let v = 0; v <= max; v += 1000) {
    const a = ang(v);
    g.strokeStyle = p.ink2;
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * (R - 18), cy + Math.sin(a) * (R - 18));
    g.lineTo(cx + Math.cos(a) * (R - 10), cy + Math.sin(a) * (R - 10));
    g.stroke();
    g.fillText(String(v / 1000), cx + Math.cos(a) * (R - 28), cy + Math.sin(a) * (R - 28));
  }

  g.fillStyle = cut ? p.heat : p.ink;
  g.font = `600 ${Math.round(R * 0.36)}px ${FONT}`;
  g.fillText(Math.max(0, Math.round(rpm)).toLocaleString(), cx, cy + R * 0.02);
  g.fillStyle = p.ink2;
  g.font = `400 11px ${FONT}`;
  g.fillText(cut ? 'Fuel cut' : 'rpm', cx, cy + R * 0.3);
}

// ---------------------------------------------------------------- timing ring

const STROKES = ['Intake', 'Compression', 'Power', 'Exhaust'];

export function strokeName(cycle: number) {
  return STROKES[Math.floor((((cycle % 720) + 720) % 720) / 180)];
}

export function drawTimingRing(c: HTMLCanvasElement, e: Engine) {
  const { g, w, h } = fit(c);
  const p = pal();
  g.clearRect(0, 0, w, h);
  const cyl = e.cyls[e.watch];
  if (!cyl) return;
  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) / 2 - 14;
  // cycle 0 at the top, clockwise, 720 crank deg per lap
  const A = (cycle: number) => -Math.PI / 2 + (cycle / 720) * Math.PI * 2;
  const arc = (r: number, from: number, to: number, color: string, width: number) => {
    let a = from;
    let b = to;
    if (b < a) b += 720;
    g.strokeStyle = color;
    g.lineWidth = width;
    g.beginPath();
    g.arc(cx, cy, r, A(a), A(b));
    g.stroke();
  };

  // stroke quadrants
  g.lineWidth = 1;
  for (let k = 0; k < 4; k++) {
    arc(R, k * 180 + 1.5, (k + 1) * 180 - 1.5, p.line, 16);
  }
  const ev = e.valveEvents();
  const rIn = R - 22;
  const rEx = R - 34;
  arc(rIn, ev.intake.open, ev.intake.close, p.charge, 8);
  arc(rEx, ev.exhaust.open, ev.exhaust.close, p.exhaust, 8);

  // burn
  if (e.ignition) {
    const rb = R - 46;
    const start = cyl.burnStart || cyl.sparkAt + 10;
    const dur = cyl.burnDur || 50;
    arc(rb, start, start + dur, p.heat, 6);
    // spark tick
    const sa = A(cyl.sparkAt);
    g.strokeStyle = p.spark;
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(cx + Math.cos(sa) * (rb - 8), cy + Math.sin(sa) * (rb - 8));
    g.lineTo(cx + Math.cos(sa) * (R + 8), cy + Math.sin(sa) * (R + 8));
    g.stroke();
  }

  // stroke labels on the outer band
  g.font = `500 10px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const cur = Math.floor(cyl.cycle / 180);
  STROKES.forEach((name, k) => {
    const mid = A(k * 180 + 90);
    g.save();
    g.translate(cx + Math.cos(mid) * R, cy + Math.sin(mid) * R);
    let rot = mid + Math.PI / 2;
    if (k === 1 || k === 2) rot += Math.PI;
    g.rotate(rot);
    g.fillStyle = k === cur ? p.ink : p.ink2;
    g.fillText(name, 0, 1);
    g.restore();
  });

  // pointer
  const pa = A(cyl.cycle);
  g.strokeStyle = p.ink;
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(cx + Math.cos(pa) * (R * 0.3), cy + Math.sin(pa) * (R * 0.3));
  g.lineTo(cx + Math.cos(pa) * (R + 10), cy + Math.sin(pa) * (R + 10));
  g.stroke();
  g.fillStyle = p.ink;
  g.beginPath();
  g.arc(cx + Math.cos(pa) * (R + 10), cy + Math.sin(pa) * (R + 10), 3.5, 0, Math.PI * 2);
  g.fill();

  g.fillStyle = p.ink;
  g.font = `600 ${Math.round(R * 0.3)}px ${FONT}`;
  g.fillText(e.layout.labels[e.watch] ?? String(e.watch + 1), cx, cy - R * 0.08);
  g.fillStyle = p.ink2;
  g.font = `400 11px ${FONT}`;
  // rotary shows real e-shaft degrees, the ring itself stays one lap per cycle
  g.fillText(`${Math.round(cyl.cycle / e.kN)}°`, cx, cy + R * 0.18);
}

// ---------------------------------------------------------------- P-V and P-theta

function phaseColor(p: Palette, deg: number) {
  if (deg < 180) return p.charge;
  if (deg < 360) return p.ink2;
  if (deg < 540) return p.heat;
  return p.exhaust;
}

export function drawPV(c: HTMLCanvasElement, tr: Trace, e: Engine, logScale: boolean, imperial = false) {
  const { g, w, h } = fit(c);
  const p = pal();
  g.clearRect(0, 0, w, h);
  const padL = 38;
  const padB = 22;
  const padT = 10;
  const padR = 10;
  const vMin = e.Vc;
  const vMax = e.Vc + e.Vd;
  let pMax = 2e5;
  if (tr.valid) for (let i = 0; i < 720; i++) pMax = Math.max(pMax, tr.p[i]);
  pMax *= 1.08;
  const pMin = logScale ? 0.2e5 : 0;
  const X = (v: number) => padL + ((v - vMin) / (vMax - vMin)) * (w - padL - padR);
  const Y = (pr: number) => {
    if (logScale) {
      const a = Math.log(Math.max(pr, pMin));
      return h - padB - ((a - Math.log(pMin)) / (Math.log(pMax) - Math.log(pMin))) * (h - padB - padT);
    }
    return h - padB - ((pr - pMin) / (pMax - pMin)) * (h - padB - padT);
  };

  axes(g, p, w, h, padL, padB, padT, padR);
  g.fillStyle = p.ink2;
  g.font = `400 10px ${FONT}`;
  g.textAlign = 'right';
  g.textBaseline = 'middle';
  const sc = imperial ? 6894.76 : 1e5;
  const ticks = logScale ? (imperial ? [10, 20, 50, 100, 200, 500, 1000, 1500] : [0.5, 1, 2, 5, 10, 20, 50, 100]).map((b) => b * sc).filter((t) => t >= pMin && t <= pMax) : niceTicks(0, pMax / sc, 4).map((t) => t * sc);
  for (const t of ticks) {
    if (t > pMax || t < pMin) continue;
    const y = Y(t);
    g.strokeStyle = p.line;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(padL, y);
    g.lineTo(w - padR, y);
    g.stroke();
    g.fillText(`${+(t / sc).toFixed(imperial ? 0 : 1)}`, padL - 6, y);
  }
  g.textAlign = 'center';
  g.textBaseline = 'top';
  const cc = [vMin, (vMin + vMax) / 2, vMax];
  for (const v of cc) g.fillText(`${Math.round(v * 1e6)} cc`, X(v), h - padB + 6);

  if (!tr.valid) return emptyNote(g, p, w, h, 'Start the engine or turn it by hand');
  g.lineWidth = 1.8;
  for (let i = 0; i < 720; i++) {
    const j = (i + 1) % 720;
    g.strokeStyle = phaseColor(p, i);
    g.beginPath();
    g.moveTo(X(tr.V[i]), Y(tr.p[i]));
    g.lineTo(X(tr.V[j]), Y(tr.p[j]));
    g.stroke();
  }
}

export function drawPTheta(c: HTMLCanvasElement, tr: Trace, e: Engine, imperial = false) {
  const { g, w, h } = fit(c);
  const p = pal();
  g.clearRect(0, 0, w, h);
  const padL = 38;
  const padB = 22;
  const padT = 10;
  const padR = 10;
  let pMax = 2e5;
  if (tr.valid) for (let i = 0; i < 720; i++) pMax = Math.max(pMax, tr.p[i]);
  pMax *= 1.08;
  const X = (deg: number) => padL + (deg / 720) * (w - padL - padR);
  const Y = (pr: number) => h - padB - (pr / pMax) * (h - padB - padT);
  axes(g, p, w, h, padL, padB, padT, padR);

  g.font = `400 10px ${FONT}`;
  g.fillStyle = p.ink2;
  g.textAlign = 'right';
  g.textBaseline = 'middle';
  const sc = imperial ? 6894.76 : 1e5;
  for (const t of niceTicks(0, pMax / sc, 4).map((v) => v * sc)) {
    const y = Y(t);
    g.strokeStyle = p.line;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(padL, y);
    g.lineTo(w - padR, y);
    g.stroke();
    g.fillText(`${+(t / sc).toFixed(0)}`, padL - 6, y);
  }
  g.textAlign = 'center';
  g.textBaseline = 'top';
  [0, 180, 360, 540, 720].forEach((d) => g.fillText(d === 360 ? 'TDC' : `${d - 360}`, X(d), h - padB + 6));

  // firing TDC line
  g.strokeStyle = p.ink2;
  g.setLineDash([3, 3]);
  g.beginPath();
  g.moveTo(X(360), padT);
  g.lineTo(X(360), h - padB);
  g.stroke();
  g.setLineDash([]);

  const cyl = e.cyls[e.watch];
  if (cyl && e.ignition) {
    g.strokeStyle = p.spark;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(X(cyl.sparkAt), padT);
    g.lineTo(X(cyl.sparkAt), h - padB);
    g.stroke();
  }

  if (!tr.valid) return emptyNote(g, p, w, h, 'No cycle recorded yet');
  g.lineWidth = 1.8;
  for (let i = 0; i < 719; i++) {
    g.strokeStyle = phaseColor(p, i);
    g.beginPath();
    g.moveTo(X(i), Y(tr.p[i]));
    g.lineTo(X(i + 1), Y(tr.p[i + 1]));
    g.stroke();
  }
}

// ---------------------------------------------------------------- dyno

export interface DynoRun {
  label: string;
  bins: [number, number][]; // rpm, Nm
}

export function drawDyno(c: HTMLCanvasElement, runs: DynoRun[], imperial: boolean, live: { rpm: number; tq: number } | null) {
  const { g, w, h } = fit(c);
  const p = pal();
  g.clearRect(0, 0, w, h);
  const padL = 40;
  const padR = 40;
  const padB = 22;
  const padT = 12;
  const tqU = (nm: number) => (imperial ? nm * 0.7376 : nm);
  const pwU = (nm: number, rpm: number) => {
    const wts = (nm * rpm * 2 * Math.PI) / 60;
    return imperial ? wts / 745.7 : wts / 1000;
  };
  let rMax = 4000;
  let tMax = 50;
  let pMax = 50;
  for (const run of runs)
    for (const [r, t] of run.bins) {
      rMax = Math.max(rMax, r);
      tMax = Math.max(tMax, tqU(t));
      pMax = Math.max(pMax, pwU(t, r));
    }
  if (live) {
    rMax = Math.max(rMax, live.rpm);
    tMax = Math.max(tMax, tqU(live.tq));
  }
  const both = Math.max(tMax, pMax) * 1.12;
  tMax = both;
  pMax = both;
  rMax = Math.ceil((rMax + 200) / 1000) * 1000;
  const X = (r: number) => padL + (r / rMax) * (w - padL - padR);
  const Yt = (v: number) => h - padB - (v / tMax) * (h - padB - padT);
  const Yp = (v: number) => h - padB - (v / pMax) * (h - padB - padT);
  axes(g, p, w, h, padL, padB, padT, padR);

  g.font = `400 10px ${FONT}`;
  g.fillStyle = p.ink2;
  g.textBaseline = 'middle';
  for (const t of niceTicks(0, tMax, 4)) {
    const y = Yt(t);
    g.strokeStyle = p.line;
    g.beginPath();
    g.moveTo(padL, y);
    g.lineTo(w - padR, y);
    g.stroke();
    g.textAlign = 'right';
    g.fillText(String(Math.round(t)), padL - 6, y);
    g.textAlign = 'left';
    g.fillText(String(Math.round(t)), w - padR + 6, y);
  }
  g.textAlign = 'center';
  g.textBaseline = 'top';
  for (let r = 0; r <= rMax; r += rMax > 8000 ? 2000 : 1000) g.fillText(String(r), X(r), h - padB + 6);

  if (!runs.length && !live) return emptyNote(g, p, w, h, 'Run a pull to draw the curve');

  runs.forEach((run, k) => {
    const latest = k === runs.length - 1;
    g.setLineDash(latest ? [] : [5, 4]);
    g.globalAlpha = latest ? 1 : 0.55;
    g.lineWidth = latest ? 2.2 : 1.6;
    g.strokeStyle = p.ink;
    g.beginPath();
    run.bins.forEach(([r, t], i) => (i ? g.lineTo(X(r), Yt(tqU(t))) : g.moveTo(X(r), Yt(tqU(t)))));
    g.stroke();
    g.strokeStyle = p.heat;
    g.beginPath();
    run.bins.forEach(([r, t], i) => (i ? g.lineTo(X(r), Yp(pwU(t, r))) : g.moveTo(X(r), Yp(pwU(t, r)))));
    g.stroke();
  });
  g.setLineDash([]);
  g.globalAlpha = 1;

  if (live) {
    g.fillStyle = p.ink;
    g.beginPath();
    g.arc(X(live.rpm), Yt(tqU(live.tq)), 3.5, 0, Math.PI * 2);
    g.fill();
  }
}

function axes(g: CanvasRenderingContext2D, p: Palette, w: number, h: number, l: number, b: number, t: number, r: number) {
  g.strokeStyle = p.ink2;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(l, t);
  g.lineTo(l, h - b);
  g.lineTo(w - r, h - b);
  g.stroke();
}

function emptyNote(g: CanvasRenderingContext2D, p: Palette, w: number, h: number, text: string) {
  g.fillStyle = p.ink2;
  g.font = `400 12px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, w / 2 + 14, h / 2 - 6);
}

function niceTicks(a: number, b: number, n: number) {
  const span = b - a;
  const step0 = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? step0;
  const out: number[] = [];
  for (let v = Math.ceil(a / step) * step; v <= b; v += step) out.push(v);
  return out;
}
