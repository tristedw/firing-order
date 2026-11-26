import './style.css';
import { Engine, PATM } from './sim/engine';
import { PRESETS, cloneTune, decodeTune, encodeTune, type Tune } from './sim/tune';
import { EngineView, type PartHit } from './render/scene';
import { EngineSound } from './audio/sound';
import { TunePanel, GEOMETRY_KEYS } from './ui/panel';
import { drawDyno, drawPTheta, drawPV, drawTach, drawTimingRing, strokeName, type DynoRun } from './ui/charts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const DEG = Math.PI / 180;
const STORE = 'firing-order:tune';

// ---------------------------------------------------------------- state

function initialTune(): Tune {
  const m = location.hash.match(/t=([^&]+)/);
  if (m) {
    const t = decodeTune(m[1]);
    if (t) return t;
  }
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) {
      const t = decodeTune(raw);
      if (t) return t;
    }
  } catch {
    /* private mode */
  }
  return cloneTune(PRESETS[0]);
}

let tune = initialTune();
const engine = new Engine(tune);
const view = new EngineView($<HTMLCanvasElement>('gl'));
const sound = new EngineSound();
let imperial = true;
let timeScale = 1;
let wHeld = false;
let throttleSlider = 0;
let starting = false;
let startTimer = 0;
let pvLog = true;
let runs: DynoRun[] = [];
let inspected: PartHit | null = null;

view.build(engine);
view.resize();
view.frame('iso');

// ---------------------------------------------------------------- units

const U = {
  tq: (nm: number) => (imperial ? [nm * 0.7376, 'lb-ft'] : [nm, 'Nm']) as [number, string],
  pw: (w: number) => (imperial ? [w / 745.7, 'hp'] : [w / 1000, 'kW']) as [number, string],
  temp: (k: number) => (imperial ? [((k - 273.15) * 9) / 5 + 32, '°F'] : [k - 273.15, '°C']) as [number, string],
  boost: (pa: number) => (imperial ? [pa / 6894.76, 'psi'] : [pa / 1000, 'kPa']) as [number, string],
  speed: (ms: number) => (imperial ? [ms * 196.85, 'ft/min'] : [ms, 'm/s']) as [number, string],
  press: (pa: number) => (imperial ? [pa / 6894.76, 'psi'] : [pa / 1e5, 'bar']) as [number, string],
  len: (mm: number) => (imperial ? [mm / 25.4, 'in'] : [mm, 'mm']) as [number, string],
  force: (n: number) => (imperial ? [n * 0.224809, 'lbf'] : [n / 1000, 'kN']) as [number, string],
  flow: (kgs: number) => (imperial ? [kgs * 132.28, 'lb/min'] : [kgs * 60, 'kg/min']) as [number, string],
};
// formatted with the right precision for each unit
const P = (pa: number) => {
  const [v, u] = U.press(pa);
  return `${fmt(v, imperial ? 0 : 1)} ${u}`;
};
const Lm = (mm: number) => {
  const [v, u] = U.len(mm);
  return imperial ? `${fmt(v, 3)} ${u}` : `${fmt(v, 2)} ${u}`;
};
const F = (n: number) => {
  const [v, u] = U.force(n);
  return imperial ? `${fmt(v)} ${u}` : `${fmt(v, 1)} ${u}`;
};
const fmt = (v: number, d = 0) => v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

// ---------------------------------------------------------------- presets

const presetSel = $<HTMLSelectElement>('preset');
PRESETS.forEach((p, i) => {
  const o = document.createElement('option');
  o.value = String(i);
  o.textContent = p.name;
  presetSel.append(o);
});
const custom = document.createElement('option');
custom.value = 'custom';
custom.textContent = 'Custom tune';
presetSel.append(custom);
const presetIndex = PRESETS.findIndex((p) => p.name === tune.name);
presetSel.value = presetIndex >= 0 ? String(presetIndex) : 'custom';

presetSel.onchange = () => {
  if (presetSel.value === 'custom') return;
  loadTune(cloneTune(PRESETS[+presetSel.value]));
};

function applyKnockSensors() {
  engine.knockControl = tune.knockSensors !== false;
  $<HTMLInputElement>('knockctl').checked = engine.knockControl;
}

function loadTune(t: Tune) {
  tune = t;
  applyKnockSensors();
  engine.ignition = false;
  engine.starter = false;
  engine.stopDyno();
  engine.omega = 0;
  engine.setTune(tune, true);
  runs = [];
  rebuildView();
  view.frame('iso');
  panel.sync();
  buildCylinders();
  save();
}

// ---------------------------------------------------------------- tune panel

let rebuildTimer = 0;
function rebuildView() {
  const hit = inspected;
  view.build(engine);
  view.resize();
  if (hit && (hit.cyl < engine.cyls.length)) {
    view.setHighlight(hit);
  } else closeInspector();
}

const panel = new TunePanel($('tune'), () => tune, {
  imperial: () => imperial,
  onChange(key) {
    if (presetSel.value !== 'custom') {
      presetSel.value = 'custom';
      tune.name = 'Custom tune';
    }
    const layoutChange = key === 'layout';
    engine.setTune(tune, layoutChange);
    if (layoutChange) {
      buildCylinders();
      runs = [];
    }
    if (GEOMETRY_KEYS.has(key)) {
      clearTimeout(rebuildTimer);
      rebuildTimer = window.setTimeout(() => {
        rebuildView();
        if (layoutChange) view.frame('iso');
      }, layoutChange ? 0 : 120);
    }
    save();
  },
  getLive() {
    return { rpm: engine.rpm, map: engine.pMan / 1000 };
  },
});

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(STORE, encodeTune(tune));
    } catch {
      /* ignore */
    }
  }, 300);
}

// rpm where the rods hit their rating: m r w^2 (1 + r/l) = rating
function rodLimitRpm() {
  const m = tune.recipMass / 1000;
  const w = Math.sqrt(engine.rodRating / (m * engine.r * (1 + engine.r / engine.l)));
  return (w * 60) / (2 * Math.PI);
}

// ---------------------------------------------------------------- start / stop

const startBtn = $<HTMLButtonElement>('start');
const statusEl = $('status');

function start() {
  sound.init();
  sound.resume();
  if (engine.failure) return toast('Rebuild the engine first.');
  engine.ignition = true;
  engine.resetCounts();
  starting = true;
  startTimer = 0;
}
function stop() {
  engine.ignition = false;
  engine.starter = false;
  starting = false;
  engine.stopDyno();
}
startBtn.onclick = () => (engine.ignition ? stop() : start());

$('rebuild').onclick = () => {
  engine.rebuild();
  engine.omega = 0;
  rebuildView();
  $('failure').hidden = true;
};

// ---------------------------------------------------------------- pedals

const thr = $<HTMLInputElement>('throttle');
const load = $<HTMLInputElement>('load');
const setFill = (r: HTMLInputElement) => r.style.setProperty('--fill', `${((+r.value - +r.min) / (+r.max - +r.min)) * 100}%`);
thr.oninput = () => {
  throttleSlider = +thr.value / 100;
  setFill(thr);
};
load.oninput = () => {
  engine.load = +load.value / 100;
  $('load-out').textContent = `${load.value}%`;
  setFill(load);
};
setFill(thr);
setFill(load);

// ---------------------------------------------------------------- segmented controls

function segGroup(attr: string, onPick: (v: string) => void) {
  const btns = document.querySelectorAll<HTMLButtonElement>(`[data-${attr}]`);
  btns.forEach((b) =>
    b.addEventListener('click', () => {
      btns.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      onPick(b.dataset[attr]!);
    }),
  );
  return (v: string) => btns.forEach((x) => x.setAttribute('aria-pressed', String(x.dataset[attr] === v)));
}

const setSpeed = segGroup('speed', (v) => (timeScale = +v));
const setBlock = segGroup('block', (v) => view.setBlockMode(v as 'ghost' | 'solid' | 'hidden'));
segGroup('view', (v) => view.frame(v as 'iso'));
const setUnits = segGroup('units', (v) => {
  imperial = v === 'imperial';
  try {
    localStorage.setItem('firing-order:units', v);
  } catch {}
  panel.sync();
  drawDynoNow();
  updateReadouts();
  if (inspected) fillInspector();
  drawCharts();
});
{
  let u = 'imperial';
  try {
    u = localStorage.getItem('firing-order:units') ?? 'imperial';
  } catch {}
  imperial = u === 'imperial';
  setUnits(u);
}
document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => b.setAttribute('aria-pressed', 'false'));

const soundBtn = $<HTMLButtonElement>('sound');
soundBtn.onclick = () => {
  sound.init();
  const on = !sound.enabled;
  sound.setEnabled(on);
  soundBtn.setAttribute('aria-pressed', String(on));
  soundBtn.textContent = on ? 'Sound on' : 'Sound off';
};

$('share').onclick = async () => {
  const url = `${location.origin}${location.pathname}#t=${encodeTune(tune)}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Tune link copied.');
  } catch {
    history.replaceState(null, '', url);
    toast('Link is in the address bar.');
  }
};

const helpBtn = $<HTMLButtonElement>('help');
helpBtn.onclick = () => {
  const box = $('helpbox');
  box.hidden = !box.hidden;
  helpBtn.setAttribute('aria-expanded', String(!box.hidden));
};

$<HTMLInputElement>('knockctl').onchange = (e) => {
  engine.knockControl = (e.target as HTMLInputElement).checked;
  tune.knockSensors = engine.knockControl;
  save();
};

const pvBtn = $<HTMLButtonElement>('pvlog');
pvBtn.onclick = () => {
  pvLog = !pvLog;
  pvBtn.setAttribute('aria-pressed', String(pvLog));
};

let toastTimer = 0;
function toast(msg: string) {
  const t = $('toast');
  t.textContent = msg;
  t.dataset.show = 'true';
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.dataset.show = 'false'), 2200);
}

// ---------------------------------------------------------------- dyno

function drawDynoNow() {
  let shown = runs;
  if (engine.dynoActive && engine.dynoBins.size > 1) {
    const partial: [number, number][] = [...engine.dynoBins.entries()].sort((a, b) => a[0] - b[0]).map(([r, v]) => [r, v.sum / v.n]);
    shown = [...runs.slice(-1), { label: 'live', bins: partial }];
  }
  drawDyno($<HTMLCanvasElement>('dynoc'), shown, imperial, engine.dynoActive ? { rpm: engine.rpm, tq: engine.torqueCycle } : null);
  const last = runs[runs.length - 1];
  const peak = $('dyno-peak');
  if (!last || !last.bins.length) {
    peak.textContent = '';
    return;
  }
  let bt = last.bins[0];
  let bp = last.bins[0];
  for (const b of last.bins) {
    if (b[1] > bt[1]) bt = b;
    if (b[1] * b[0] > bp[1] * bp[0]) bp = b;
  }
  const [tq, tu] = U.tq(bt[1]);
  const [pw, pu] = U.pw((bp[1] * bp[0] * 2 * Math.PI) / 60);
  peak.textContent = `Peak ${fmt(tq)} ${tu} at ${fmt(bt[0])} rpm, ${fmt(pw)} ${pu} at ${fmt(bp[0])} rpm`;
}

function runDyno() {
  if (!engine.ignition || engine.rpm < 300) return toast('Start the engine first.');
  if (engine.dynoActive) {
    engine.stopDyno();
    $('dyno').textContent = 'Run a pull';
    return;
  }
  wHeld = false;
  engine.startDyno(Math.max(1500, tune.idleRpm + 600));
  engine.dynoTarget = Math.max(1500, tune.idleRpm + 600);
  $('dyno').textContent = 'Stop pull';
}
$('dyno').onclick = runDyno;
$('dyno-clear').onclick = () => {
  runs = [];
  drawDynoNow();
};
engine.onDynoDone = (bins) => {
  const arr = [...bins.entries()].filter(([, t]) => Number.isFinite(t));
  if (arr.length > 3) {
    runs.push({ label: tune.name, bins: arr });
    if (runs.length > 2) runs = runs.slice(-2);
  }
  $('dyno').textContent = 'Run a pull';
  drawDynoNow();
};

// ---------------------------------------------------------------- cylinders

const cylHost = $('cyls');
let cylEls: { root: HTMLElement; lamp: HTMLElement; dmg: HTMLElement; cut: HTMLButtonElement; counts: HTMLElement }[] = [];

function buildCylinders() {
  cylHost.innerHTML = '';
  cylEls = engine.cyls.map((c) => {
    const root = document.createElement('div');
    root.className = 'cyl';
    const pick = document.createElement('button');
    pick.className = 'pick';
    pick.type = 'button';
    const label = engine.layout.labels[c.idx];
    const what = engine.kind === 'rotary' ? 'chamber' : 'cylinder';
    pick.setAttribute('aria-label', `Watch ${what} ${label}`);
    const num = document.createElement('span');
    num.textContent = label;
    const lamp = document.createElement('span');
    lamp.className = 'lamp';
    pick.append(num, lamp);
    pick.onclick = () => watch(c.idx);
    const dmgWrap = document.createElement('div');
    dmgWrap.className = 'dmg';
    dmgWrap.title = 'Knock damage';
    const dmg = document.createElement('i');
    dmgWrap.append(dmg);
    const cut = document.createElement('button');
    cut.className = 'cut';
    cut.type = 'button';
    cut.textContent = 'Cut';
    cut.setAttribute('aria-pressed', 'false');
    cut.setAttribute('aria-label', `Cut spark to ${what} ${label}`);
    cut.onclick = () => {
      if (engine.killed.has(c.idx)) engine.killed.delete(c.idx);
      else engine.killed.add(c.idx);
      cut.setAttribute('aria-pressed', String(engine.killed.has(c.idx)));
    };
    const counts = document.createElement('div');
    counts.className = 'counts';
    root.append(pick, dmgWrap, counts, cut);
    cylHost.append(root);
    return { root, lamp, dmg, cut, counts };
  });
  cylHost.style.gridTemplateColumns = `repeat(${engine.kind === 'rotary' ? 3 : Math.min(4, engine.cyls.length)}, 1fr)`;
  $('cyl-title').textContent = engine.kind === 'rotary' ? 'Chambers' : 'Cylinders';

  const f = $('firing');
  f.innerHTML = '';
  const lbl = document.createElement('span');
  lbl.className = 'lbl';
  lbl.textContent = 'Firing order';
  f.append(lbl);
  for (const n of engine.layout.firingOrder) {
    const b = document.createElement('b');
    b.textContent = engine.layout.labels[n - 1];
    b.dataset.cyl = String(n - 1);
    f.append(b);
  }
  watch(Math.min(engine.watch, engine.cyls.length - 1));
}

function watch(i: number) {
  engine.watch = i;
  engine.traceA.valid = false;
  engine.traceB.valid = false;
  cylEls.forEach((c, k) => c.root.setAttribute('data-watch', String(k === i)));
}

// ---------------------------------------------------------------- inspector

const insp = $('inspector');
function openInspector(hit: PartHit) {
  $('stage-hint').hidden = true;
  inspected = hit;
  view.setHighlight(hit);
  insp.hidden = false;
  if (hit.cyl >= 0) watch(hit.cyl);
  fillInspector();
}
function closeInspector() {
  inspected = null;
  view.setHighlight(null);
  insp.hidden = true;
}
$('insp-close').onclick = closeInspector;

const PART_COPY: Record<PartHit['kind'], [string, string]> = {
  piston: ['Piston', 'Takes the push from burning gas and hands it to the rod. Top speed comes before mid stroke because the rod swings.'],
  rod: ['Connecting rod', 'Links piston to crank. Inertia tries to stretch it at the top of the exhaust stroke, which is why high rpm breaks rods.'],
  crank: ['Crankshaft', 'Turns the up and down push into rotation. With the engine off, drag it to turn everything over by hand.'],
  'intake-valve': ['Intake valve', 'Lets fresh charge in. Closing it late costs low rpm torque but packs more in at high rpm.'],
  'exhaust-valve': ['Exhaust valve', 'Opens before the piston reaches the bottom to dump pressure early. That pulse is most of what you hear.'],
  cam: ['Camshaft lobes', 'Spin at half crank speed. Lobe shape sets duration and lift, the phase sets the centerlines.'],
  flywheel: ['Flywheel', 'Stores energy between power strokes so the engine keeps turning. The red mark lines up with crankpin 1.'],
  plug: ['Spark plug', 'Fires at the angle from the spark table. Too early and the unburnt gas lights off on its own. That is knock.'],
  cylinder: ['Cylinder', ''],
  turbo: ['Turbo', 'Exhaust spins the turbine, the shaft spins the compressor, and the compressor packs air into the intake. Lag is the wheel getting up to speed. Run it past its map and the air gets hot, the turbine chokes the exhaust, and the wheel can overspeed.'],
  pushrod: ['Lifter, pushrod and rocker', 'One cam down in the block works every valve. The lifter rides the lobe, the pushrod carries the motion up to the rocker, and the rocker multiplies it by its ratio on the way to the valve.'],
  rotor: ['Rotor', 'Three flanks make three chambers. It turns once for every three turns of the e-shaft, kept in step by its ring gear walking round the fixed gear.'],
};

const ROTARY_COPY: Partial<Record<PartHit['kind'], [string, string]>> = {
  crank: ['Eccentric shaft', 'The rotor rides the offset lobe and pushes on it like a crankpin. Every rotor fires once per turn of the e-shaft. With the engine off, drag it to turn it by hand.'],
  'intake-valve': ['Intake port', 'No valves. The rotor uncovers the port as it sweeps past, so the shape of the port is the cam.'],
  'exhaust-valve': ['Exhaust port', 'Opens as the apex seal passes it on the way to TDC. A peripheral port like this one opens early and gives the lumpy idle.'],
  plug: ['Spark plugs', 'Leading and trailing plugs fire as a flank passes the narrow waist of the housing.'],
};

function fillRotary(hit: PartHit) {
  const rotorIdx = hit.cyl >= 0 ? Math.floor(hit.cyl / 3) : -1;
  const lay = engine.layout;
  const faces = rotorIdx >= 0 ? lay.cyls.map((c, i) => ({ c, i })).filter((x) => x.c.rotor === rotorIdx).map((x) => engine.cyls[x.i]) : [];
  const [title, desc] = ROTARY_COPY[hit.kind] ?? PART_COPY[hit.kind];
  const named = hit.kind === 'rotor' ? `Rotor ${rotorIdx + 1}` : `${title}, rotor ${rotorIdx + 1}`;
  $('insp-title').textContent = rotorIdx >= 0 && hit.kind !== 'crank' && hit.kind !== 'flywheel' ? named : title;
  $('insp-desc').textContent = desc;
  const rows: [string, string][] = [];
  const t = tune;
  const k = engine.kN;
  const faceRows = () => faces.forEach((c) => rows.push([`Chamber ${lay.labels[c.idx]}`, `${strokeName(c.cycle)}, ${P(c.p)}`]));
  switch (hit.kind) {
    case 'rotor': {
      rows.push(['Rotor angle', `${fmt(((engine.theta + lay.rotors![rotorIdx].phase) / 3) % 360)}°`]);
      faceRows();
      rows.push(['Bearing load', F(engine.rodLoad())]);
      rows.push(['Rated to', F(engine.rodRating)]);
      rows.push(['Apex speed', `${fmt(U.speed((engine.rotR + engine.rotE) * (Math.abs(engine.omega) / 3))[0], imperial ? 0 : 1)} ${U.speed(0)[1]}`]);
      break;
    }
    case 'crank': {
      const [tq, tu] = U.tq(engine.torqueInst);
      rows.push(['Angle', `${fmt(engine.theta % 360)}°`]);
      rows.push(['Torque right now', `${fmt(tq)} ${tu}`]);
      rows.push(['Speed', `${fmt(engine.rpm)} rpm`]);
      rows.push(['Rotor phasing', lay.rotors!.map((r) => `${r.phase}°`).join(', ')]);
      break;
    }
    case 'intake-valve':
      rows.push(['Opens', `${t.portIO}° ATDC`]);
      rows.push(['Closes', `${t.portIC}° ABDC`]);
      rows.push(['Open to', faces.filter((c) => c.inLift > 0).map((c) => lay.labels[c.idx]).join(', ') || 'nothing']);
      break;
    case 'exhaust-valve':
      rows.push(['Opens', `${t.portEO}° BBDC`]);
      rows.push(['Closes', t.portEC < 0 ? `${-t.portEC}° BTDC` : `${t.portEC}° ATDC`]);
      rows.push(['Open to', faces.filter((c) => c.exLift > 0).map((c) => lay.labels[c.idx]).join(', ') || 'nothing']);
      if (faces[0]) rows.push(['EGT at opening', `${fmt(U.temp(Math.max(...faces.map((c) => c.egt)))[0])} ${U.temp(0)[1]}`]);
      break;
    case 'plug': {
      // whichever flank is coming up to fire next
      const next = faces.reduce((a, c) => ((((c.sparkAt - c.cycle) % 720) + 720) % 720 < (((a.sparkAt - a.cycle) % 720) + 720) % 720 ? c : a), faces[0]);
      if (!next) break;
      rows.push(['Next to fire', lay.labels[next.idx]]);
      rows.push(['Advance', `${fmt((360 - next.sparkAt) / k, 1)}° BTDC`]);
      rows.push(['Knock retard', `${fmt(next.knockRetard, 1)}°`]);
      rows.push(['50% burned at', `${fmt(next.ca50Last / k, 1)}° ATDC`]);
      rows.push(['Peak pressure', P(next.peakPLast)]);
      rows.push(['IMEP', P(next.imep)]);
      break;
    }
    case 'flywheel':
      rows.push(['Inertia', `${fmt(engine.J, 3)} kg m²`]);
      rows.push(['Speed', `${fmt(engine.rpm)} rpm`]);
      rows.push(['Stored energy', `${fmt((0.5 * engine.J * engine.omega * engine.omega) / 1000, 1)} kJ`]);
      break;
  }
  $('insp-data').innerHTML = rows.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('');
}

function fillInspector() {
  if (!inspected) return;
  const hit = inspected;
  if (engine.kind === 'rotary' && hit.kind !== 'turbo') return fillRotary(hit);
  const c = hit.cyl >= 0 ? engine.cyls[hit.cyl] : null;
  const pushrodHead = tune.valvetrain === 'pushrod';
  const [title, desc] =
    hit.kind === 'cam' && pushrodHead
      ? (['Camshaft', 'One cam in the block, between the banks on a V. It turns at half crank speed and every valve on the engine gets its timing from one of its lobes.'] as [string, string])
      : PART_COPY[hit.kind];
  $('insp-title').textContent = c ? `${title}, cylinder ${engine.layout.labels[c.idx]}` : title;
  $('insp-desc').textContent = desc;
  const rows: [string, string][] = [];
  const ev = engine.valveEvents();
  const t = tune;
  if (c) rows.push(['Stroke', `${strokeName(c.cycle)}, ${Math.round(c.cycle)}°`]);
  switch (hit.kind) {
    case 'piston': {
      const [sv, su] = U.speed(Math.abs(c!.vel));
      rows.push(['Down from TDC', Lm(c!.x * 1000)]);
      rows.push(['Speed', `${fmt(sv, imperial ? 0 : 1)} ${su}`]);
      rows.push(['Acceleration', `${fmt(c!.acc / 9.81)} g`]);
      rows.push(['Gas force', F((c!.p - PATM) * engine.A)]);
      rows.push(['Pressure', P(c!.p)]);
      break;
    }
    case 'rod': {
      const ld = engine.rodLoad();
      rows.push(['Angle', `${fmt(c!.rodAngle / DEG, 1)}°`]);
      rows.push(['Inertia load', F(ld)]);
      rows.push(['Rated to', F(engine.rodRating)]);
      rows.push(['Lets go near', `${fmt(Math.round(rodLimitRpm() / 10) * 10)} rpm`]);
      rows.push(['Rod to stroke', fmt(t.rod / t.stroke, 2)]);
      break;
    }
    case 'crank': {
      const [tq, tu] = U.tq(engine.torqueInst);
      rows.push(['Angle', `${fmt(engine.theta % 360)}°`]);
      rows.push(['Torque right now', `${fmt(tq)} ${tu}`]);
      rows.push(['Speed', `${fmt(engine.rpm)} rpm`]);
      rows.push(['Pin angles', engine.layout.pins.map((p) => `${p.angle}°`).join(', ')]);
      break;
    }
    case 'turbo': {
      const r = engine.readings();
      const tr = r.turbo;
      if (!tr) break;
      const [bp, bu] = U.boost(tr.boost);
      const [ep, eu] = U.boost(tr.emap - 101325);
      rows.push(['Shaft speed', tr.dead ? 'Wheel is gone' : `${fmt(Math.round(tr.shaftRpm / 1000))}k rpm`]);
      rows.push(['Boost before throttle', `${fmt(bp, 1)} ${bu}`]);
      rows.push(['Pressure ratio', `${fmt(tr.pr, 2)}`]);
      rows.push(['Flow', `${fmt(U.flow(tr.flow)[0], 1)} ${U.flow(0)[1]}, ${fmt(tr.flowFrac * 100)}% of choke`]);
      rows.push(['Compressor efficiency', `${fmt(tr.eff * 100)}%`]);
      rows.push(['Off the compressor', `${fmt(U.temp(tr.compOutT)[0])} ${U.temp(tr.compOutT)[1]}`]);
      rows.push(['Into the engine', `${fmt(U.temp(tr.chargeT)[0])} ${U.temp(tr.chargeT)[1]}`]);
      rows.push(['Exhaust back pressure', `${fmt(ep, 1)} ${eu}`]);
      rows.push(['Peak cylinder pressure', `${P(r.peakBar * 1e5)} of ${P(r.pressureLimit * 1e5)}`]);
      if (tr.surging) rows.push(['Compressor', 'Surging']);
      break;
    }
    case 'pushrod': {
      const rr = Math.max(1, t.rockerRatio);
      rows.push(['Intake lifter', Lm(c!.inLift / rr)]);
      rows.push(['Exhaust lifter', Lm(c!.exLift / rr)]);
      rows.push(['Rocker ratio', `${fmt(rr, 2)}:1`]);
      rows.push(['Intake valve', Lm(c!.inLift)]);
      rows.push(['Exhaust valve', Lm(c!.exLift)]);
      rows.push(['Floats above', `${fmt(Math.round(engine.floatRpm / 10) * 10)} rpm`]);
      break;
    }
    case 'intake-valve':
      rows.push(['Lift', Lm(c!.inLift)]);
      if (pushrodHead) rows.push(['Lobe lift', `${Lm(t.inLift / Math.max(1, t.rockerRatio))} at ${fmt(t.rockerRatio, 2)}:1`]);
      rows.push(['Opens', `${fmt(720 - ev.intake.open)}° BTDC`]);
      rows.push(['Closes', `${fmt(ev.intake.close - 180)}° ABDC`]);
      rows.push(['Floats above', `${fmt(Math.round(engine.floatRpm / 10) * 10)} rpm`]);
      break;
    case 'exhaust-valve':
      rows.push(['Lift', Lm(c!.exLift)]);
      if (pushrodHead) rows.push(['Lobe lift', `${Lm(t.exLift / Math.max(1, t.rockerRatio))} at ${fmt(t.rockerRatio, 2)}:1`]);
      rows.push(['Opens', `${fmt(540 - ev.exhaust.open)}° BBDC`]);
      rows.push(['Closes', `${fmt(ev.exhaust.close)}° ATDC`]);
      rows.push(['EGT at opening', `${fmt(U.temp(c!.egt)[0])} ${U.temp(c!.egt)[1]}`]);
      break;
    case 'cam':
      rows.push(['Cam angle', `${fmt((engine.theta / 2) % 360)}°`]);
      rows.push(['Intake centerline', `${t.inCenterline}° ATDC`]);
      rows.push(['Exhaust centerline', `${t.exCenterline}° BTDC`]);
      rows.push(['Lobe separation', `${fmt((t.inCenterline + t.exCenterline) / 2, 1)}°`]);
      rows.push(['Valvetrain', pushrodHead ? `Pushrod, ${fmt(t.rockerRatio, 2)} rockers` : 'Overhead cam']);
      break;
    case 'flywheel':
      rows.push(['Inertia', `${fmt(engine.J, 3)} kg m²`]);
      rows.push(['Speed', `${fmt(engine.rpm)} rpm`]);
      rows.push(['Stored energy', `${fmt((0.5 * engine.J * engine.omega * engine.omega) / 1000, 1)} kJ`]);
      break;
    case 'plug':
      rows.push(['Advance', `${fmt(360 - c!.sparkAt, 1)}° BTDC`]);
      rows.push(['Knock retard', `${fmt(c!.knockRetard, 1)}°`]);
      rows.push(['50% burned at', `${fmt(c!.ca50Last, 1)}° ATDC`]);
      rows.push(['Peak pressure', P(c!.peakPLast)]);
      rows.push(['IMEP', P(c!.imep)]);
      break;
  }
  const dl = $('insp-data');
  dl.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

// ---------------------------------------------------------------- canvas input

const gl = $<HTMLCanvasElement>('gl');
let down: { x: number; y: number; hit: PartHit | null } | null = null;
let dragging = false;
let dragDeg = 0;
let lastHover = 0;

gl.addEventListener('pointerdown', (e) => {
  const hit = view.pick(e.clientX, e.clientY);
  down = { x: e.clientX, y: e.clientY, hit };
  const turnable = hit && (hit.kind === 'crank' || hit.kind === 'flywheel') && Math.abs(engine.rpm) < 80 && !engine.starter;
  if (turnable) {
    dragging = true;
    dragDeg = 0;
    view.controls.enabled = false;
    gl.setPointerCapture(e.pointerId);
    gl.dataset.grabbing = 'true';
    sound.init();
  }
});
gl.addEventListener('pointermove', (e) => {
  if (dragging && down) {
    dragDeg += (e.movementY + e.movementX * 0.4) * 1.1;
    return;
  }
  const now = performance.now();
  if (now - lastHover < 60 || e.buttons) return;
  lastHover = now;
  const hit = view.pick(e.clientX, e.clientY);
  gl.dataset.hover = String(!!hit);
  gl.dataset.grab = String(!!hit && (hit.kind === 'crank' || hit.kind === 'flywheel') && Math.abs(engine.rpm) < 80);
});
const endDrag = (e: PointerEvent) => {
  if (down && !dragging) {
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    if (moved < 5) {
      if (down.hit) openInspector(down.hit);
      else closeInspector();
    }
  } else if (dragging && down) {
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    if (moved < 5 && down.hit) openInspector(down.hit);
  }
  if (dragging) {
    dragging = false;
    engine.handOmega = null;
    view.controls.enabled = true;
    gl.dataset.grabbing = 'false';
  }
  down = null;
};
gl.addEventListener('pointerup', endDrag);
gl.addEventListener('pointercancel', endDrag);

// ---------------------------------------------------------------- keys

const SPEEDS = [1, 0.25, 0.04, 0.005];
const BLOCKS = ['ghost', 'solid', 'hidden'] as const;
window.addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === ' ') {
    e.preventDefault();
    if (engine.ignition) stop();
    else start();
  } else if (k === 'w') {
    if (!wHeld) sound.init();
    wHeld = true;
  } else if (/^[1-8]$/.test(k)) {
    const i = +k - 1;
    if (i < engine.cyls.length) watch(i);
  } else if (k === 'p') {
    timeScale = timeScale === 0 ? 1 : 0;
    setSpeed(String(timeScale));
  } else if (k === 's') {
    const i = SPEEDS.indexOf(timeScale);
    timeScale = SPEEDS[(i + 1) % SPEEDS.length];
    setSpeed(String(timeScale));
  } else if (k === 'b') {
    const i = BLOCKS.indexOf(view.blockMode);
    const m = BLOCKS[(i + 1) % BLOCKS.length];
    view.setBlockMode(m);
    setBlock(m);
  } else if (k === 'd') {
    runDyno();
  } else if (k === 'escape') {
    closeInspector();
    $('helpbox').hidden = true;
  }
});
window.addEventListener('keyup', (e) => {
  if (e.key.toLowerCase() === 'w') wHeld = false;
});
window.addEventListener('blur', () => (wHeld = false));

// ---------------------------------------------------------------- readouts

const readHost = $('readouts');
const READ_KEYS = ['torque', 'power', 'map', 'afr', 'spark', 've', 'egt', 'rod', 'miss', 'knock'] as const;
const readEls: Record<string, HTMLElement> = {};
const READ_LABELS: Record<string, string> = {
  torque: 'Torque',
  power: 'Power',
  map: 'Manifold',
  afr: 'Air fuel',
  spark: 'Spark',
  ve: 'Vol. efficiency',
  egt: 'EGT',
  rod: 'Rod load',
  miss: 'Misfires',
  knock: 'Knock',
};
for (const k of READ_KEYS) {
  const d = document.createElement('div');
  const dt = document.createElement('dt');
  dt.textContent = READ_LABELS[k];
  const dd = document.createElement('dd');
  d.append(dt, dd);
  readHost.append(d);
  readEls[k] = dd;
  if (k === 'miss' || k === 'knock') {
    d.className = 'resettable';
    d.tabIndex = 0;
    d.setAttribute('role', 'button');
    d.title = 'Click to reset the counts';
    const reset = () => {
      engine.resetCounts();
      updateReadouts();
    };
    d.onclick = reset;
    d.onkeydown = (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        reset();
      }
    };
  }
}

function drawCharts() {
  drawPV($<HTMLCanvasElement>('pv'), engine.traceDone, engine, pvLog, imperial);
  drawPTheta($<HTMLCanvasElement>('pt'), engine.traceDone, engine, imperial);
}

function updateReadouts() {
  const r = engine.readings();
  const [tq, tu] = U.tq(r.torque);
  const [pw, pu] = U.pw(Math.max(0, r.power));
  readEls.torque.innerHTML = `${fmt(tq)}<small>${tu}</small>`;
  readEls.power.innerHTML = `${fmt(pw)}<small>${pu}</small>`;
  if (tune.turbo && r.boost > 2000) {
    const [b, bu] = U.boost(r.boost);
    readEls.map.innerHTML = `${fmt(b, 1)}<small>${bu} boost</small>`;
  } else {
    readEls.map.innerHTML = `${fmt(r.map / 1000)}<small>kPa</small>`;
  }
  readEls.afr.innerHTML = r.afr > 0 ? `${fmt(r.afr, 1)}<small>λ ${fmt(r.lambda, 2)}</small>` : `<small>no fuel</small>`;
  readEls.spark.innerHTML = `${fmt(r.spark, 1)}<small>° BTDC${r.knockRetard > 0.2 ? `, −${fmt(r.knockRetard, 1)}` : ''}</small>`;
  readEls.spark.dataset.warn = String(r.knockRetard > 0.2);
  readEls.ve.innerHTML = `${fmt(r.ve * 100)}<small>%</small>`;
  const [eg, egu] = U.temp(r.egt);
  readEls.egt.innerHTML = `${fmt(eg)}<small>${egu}</small>`;
  const rodPct = (r.rodLoad / r.rodRating) * 100;
  readEls.rod.innerHTML = `${fmt(rodPct)}<small>% of rating</small>`;
  (readEls.rod.previousElementSibling as HTMLElement).textContent = engine.kind === 'rotary' ? 'Rotor load' : 'Rod load';
  readEls.rod.dataset.warn = String(rodPct > 85);
  const miss = engine.cyls.reduce((a, c) => a + c.misfires, 0);
  const knocks = engine.cyls.reduce((a, c) => a + c.knocks, 0);
  const missRate = engine.rate(engine.missLog);
  const knockRate = engine.rate(engine.knockLog);
  readEls.miss.innerHTML = `${fmt(miss)}<small>${fmt(missRate)} a min</small>`;
  readEls.miss.dataset.warn = String(missRate > 30);
  readEls.knock.innerHTML = `${fmt(knocks)}<small>${fmt(knockRate)} a min</small>`;
  readEls.knock.dataset.warn = String(knockRate > 0);

  // status
  let st = 'Off';
  let state = 'off';
  if (engine.failure) {
    st = 'Broken';
    state = 'broken';
  } else if (engine.starter) st = 'Cranking';
  else if (engine.dynoActive) {
    st = 'On the dyno';
    state = 'running';
  } else if (engine.ignition && engine.rpm > 250) {
    st = r.fuelCut ? 'Limiter' : 'Running';
    state = 'running';
  } else if (engine.ignition) st = 'Key on';
  statusEl.textContent = st;
  statusEl.dataset.state = state;
  startBtn.textContent = engine.ignition ? 'Stop engine' : 'Start engine';
  startBtn.dataset.running = String(engine.ignition);
  $('throttle-out').textContent = `${Math.round(r.throttle * 100)}%`;

  engine.cyls.forEach((c, i) => {
    const el = cylEls[i];
    if (!el) return;
    el.lamp.dataset.on = c.knockFlash > 0 ? 'knock' : c.sparkFlash > 0 || (c.burning && c.xb < 0.6) ? 'spark' : '';
    el.dmg.style.width = `${Math.min(100, c.damage * 100)}%`;
    el.root.dataset.dead = String(c.dead);
    const txt = `${c.misfires ? `<b class="m" title="Misfires">${c.misfires}</b>` : ''}${c.knocks ? `<b class="k" title="Knock">${c.knocks}</b>` : ''}`;
    if (el.counts.innerHTML !== txt) el.counts.innerHTML = txt;
  });

  const c = engine.cyls[engine.watch];
  if (c) $('pt-note').textContent = `${engine.kind === 'rotary' ? 'Chamber' : 'Cylinder'} ${engine.layout.labels[engine.watch]}, peak ${P(c.peakPLast)}, IMEP ${P(c.imep)}`;

  panel.updateDerived({ floatRpm: engine.floatRpm, rodRpm: rodLimitRpm() });
  panel.tick();
  if (inspected) fillInspector();

  if (engine.failure && $('failure').hidden) {
    const f = engine.failure;
    const lbl = engine.layout.labels[f.cyl];
    const rotor = Math.floor(f.cyl / 3) + 1;
    const what =
      engine.kind === 'rotary'
        ? {
            rod: `Rotor ${rotor} spun its bearing at ${fmt(f.rpm)} rpm. The orbiting rotor pulled harder than the bearing was rated for.`,
            valve: `Something let go at ${fmt(f.rpm)} rpm.`,
            piston: `Detonation cracked an apex seal on chamber ${lbl}. The chamber has no compression now. Pull some timing or run better fuel.`,
            gasket: `Chamber ${lbl} blew past its side seals at ${fmt(f.rpm)} rpm. Too much cylinder pressure for too long. Less boost, less timing, or stronger seals.`,
            turbo: `The turbo oversped at ${fmt(f.rpm)} rpm and the compressor wheel let go. It was flowing way past its map. Engine still runs, just no boost. Go bigger on the turbo.`,
          }[f.kind]
        : {
            rod: `A rod let go in cylinder ${lbl} at ${fmt(f.rpm)} rpm. The inertia load passed what the rod was built for.`,
            valve: `Valve float at ${fmt(f.rpm)} rpm let a valve kiss the piston in cylinder ${lbl}. It is bent and the cylinder is dead.`,
            piston: `Detonation burned a hole through the piston in cylinder ${lbl}. Pull some timing or run better fuel.`,
            gasket: `Blew the head gasket on cylinder ${lbl} at ${fmt(f.rpm)} rpm. Peak pressure sat over what it holds. Less boost, less timing, or head studs and a better gasket.`,
            turbo: `The turbo oversped at ${fmt(f.rpm)} rpm and the compressor wheel let go. It was flowing way past its map. Engine still runs, just no boost. Go bigger on the turbo.`,
          }[f.kind];
    $('failure-text').textContent = what;
    $('failure').hidden = false;
  }
}

// ---------------------------------------------------------------- loop

let last = performance.now();
let slowTick = 0;
let chartTick = 0;

function frame(now: number) {
  const dtReal = Math.min(0.05, (now - last) / 1000);
  last = now;

  engine.throttleCmd = wHeld ? 1 : throttleSlider;

  if (starting) {
    startTimer += dtReal * Math.max(timeScale, 0.02);
    const fired = engine.rpm > Math.max(450, tune.idleRpm * 0.6);
    engine.starter = !fired && startTimer < 5;
    if (fired || startTimer >= 5) {
      starting = false;
      engine.starter = false;
      if (!fired && engine.rpm < 200) toast('It will not catch. Check the spark table and AFR.');
    }
  }

  let simDt: number;
  if (dragging) {
    engine.handOmega = (dragDeg * DEG) / Math.max(dtReal, 1e-3);
    dragDeg = 0;
    simDt = dtReal;
  } else {
    simDt = dtReal * timeScale;
  }
  if (simDt > 0) engine.update(simDt);
  else engine.events.length = 0;

  const r = engine.readings();
  sound.frame(engine, r, dragging ? 1 : timeScale);

  view.update(engine);
  view.render();
  drawTimingRing($<HTMLCanvasElement>('ring'), engine);
  drawTach($<HTMLCanvasElement>('tach'), r.rpm, tune.revLimit, engine.floatRpm, r.fuelCut);

  const fl = document.querySelectorAll<HTMLElement>('#firing b');
  fl.forEach((b) => {
    const c = engine.cyls[+b.dataset.cyl!];
    const d = c ? (((c.cycle - c.sparkAt) % 720) + 720) % 720 : 999;
    b.classList.toggle('hot', engine.ignition && d < 70 && !c.dead && !engine.killed.has(c.idx));
  });

  slowTick += dtReal;
  if (slowTick > 0.08) {
    slowTick = 0;
    updateReadouts();
  }
  chartTick += dtReal;
  if (chartTick > 0.1) {
    chartTick = 0;
    drawCharts();
    if (engine.dynoActive) drawDynoNow();
  }
  requestAnimationFrame(frame);
}

window.addEventListener('resize', () => {
  view.resize();
  drawDynoNow();
});
new ResizeObserver(() => view.resize()).observe(gl);

buildCylinders();
applyKnockSensors();
updateReadouts();
drawDynoNow();
requestAnimationFrame(frame);

// handy for poking at things from the console while developing
if (import.meta.env.DEV) Object.assign(window, { engine, view });
