import { LAYOUTS, type LayoutId } from '../sim/layouts';
import { SPARK_MAP, SPARK_RPM, makeSpark, type Tune } from '../sim/tune';

type NumKey = Exclude<{ [K in keyof Tune]-?: Tune[K] extends number ? K : never }[keyof Tune], undefined>;

interface Field {
  key: NumKey;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  hint?: string;
  only?: 'piston' | 'rotary' | 'pushrod' | 'turbo';
  conv?: Conv;
}

// stored value is always metric (boost in psi, like the gauge). conv says how to show it the other way
type Conv = 'len' | 'boost' | 'press' | 'force';
const CONV: Record<Conv, { imp: [number, string, number]; met: [number, string, number] }> = {
  len: { met: [1, 'mm', 2], imp: [1 / 25.4, 'in', 3] },
  boost: { met: [6.89476, 'kPa', 0], imp: [1, 'psi', 1] },
  press: { met: [1, 'bar', 0], imp: [14.5038, 'psi', 0] },
  force: { met: [1, 'kN', 1], imp: [224.809, 'lbf', 0] },
};

export const GEOMETRY_KEYS = new Set<keyof Tune>(['turbo', 'turboSize', 'intercooler', 'bov', 'valvetrain', 'rockerRatio', 'layout', 'bore', 'stroke', 'rod', 'compression', 'inDuration', 'exDuration', 'inLift', 'exLift', 'rotorR', 'rotorE', 'rotorB']);

const GROUPS: { id: string; name: string; fields: Field[] }[] = [
  {
    id: 'engine',
    name: 'Bottom end',
    fields: [
      { key: 'bore', label: 'Bore', unit: 'mm', min: 50, max: 115, step: 0.1, only: 'piston' , conv: 'len' },
      { key: 'stroke', label: 'Stroke', unit: 'mm', min: 40, max: 120, step: 0.1, only: 'piston' , conv: 'len' },
      { key: 'rod', label: 'Rod length', unit: 'mm', min: 80, max: 200, step: 0.5, only: 'piston', hint: 'Center to center. Longer rods mean less side load and a gentler piston dwell at TDC.' , conv: 'len' },
      { key: 'rotorR', label: 'Generating radius', unit: 'mm', min: 70, max: 130, step: 0.5, only: 'rotary', hint: 'Rotor center to apex. Sets the size of the housing.' , conv: 'len' },
      { key: 'rotorE', label: 'Eccentricity', unit: 'mm', min: 10, max: 22, step: 0.1, only: 'rotary', hint: 'Offset of the e-shaft lobe. Chamber volume scales with it directly.' , conv: 'len' },
      { key: 'rotorB', label: 'Rotor width', unit: 'mm', min: 50, max: 110, step: 0.5, only: 'rotary' , conv: 'len' },
      { key: 'compression', label: 'Compression', unit: ':1', min: 6, max: 15, step: 0.1 },
      { key: 'recipMass', label: 'Piston and pin mass', unit: 'g', min: 120, max: 1000, step: 5, only: 'piston', hint: 'Sets rod load. Heavy parts break rods at lower rpm.' },
      { key: 'recipMass', label: 'Rotor mass', unit: 'g', min: 2000, max: 8000, step: 50, only: 'rotary', hint: 'The rotor orbits on the e-shaft lobe, so its weight loads the bearing every revolution.' },
      { key: 'flywheel', label: 'Flywheel', unit: '×', min: 0.3, max: 3, step: 0.05, hint: 'Rotating inertia. Light revs fast, heavy idles smooth.' },
    ],
  },
  {
    id: 'cam',
    name: 'Camshaft',
    fields: [
      { key: 'inDuration', label: 'Intake duration', unit: '°', min: 180, max: 320, step: 1, only: 'piston' },
      { key: 'exDuration', label: 'Exhaust duration', unit: '°', min: 180, max: 320, step: 1, only: 'piston' },
      { key: 'inCenterline', label: 'Intake centerline', unit: '° ATDC', min: 90, max: 130, step: 0.5, only: 'piston', hint: 'Lower numbers advance the cam: torque moves down the rev range.' },
      { key: 'exCenterline', label: 'Exhaust centerline', unit: '° BTDC', min: 90, max: 130, step: 0.5, only: 'piston' },
      { key: 'inLift', label: 'Intake lift', unit: 'mm', min: 4, max: 17, step: 0.1, only: 'piston' , conv: 'len' },
      { key: 'exLift', label: 'Exhaust lift', unit: 'mm', min: 4, max: 17, step: 0.1, only: 'piston' , conv: 'len' },
      { key: 'rockerRatio', label: 'Rocker ratio', unit: ':1', min: 1.3, max: 2, step: 0.05, only: 'pushrod', hint: 'Valve lift is lobe lift times this. LS heads run 1.7, a small block Chevy 1.5.' },
      { key: 'springRate', label: 'Valve springs', unit: '×', min: 0.6, max: 2, step: 0.05, only: 'piston', hint: 'Stiffer springs push valve float higher. Pushrod valvetrains carry more weight and float a bit sooner.' },
      { key: 'portIO', label: 'Intake opens', unit: '° ATDC', min: -80, max: 60, step: 1, only: 'rotary', hint: 'E-shaft degrees. Porting a rotary is the same game as picking a cam: open earlier and close later for top end.' },
      { key: 'portIC', label: 'Intake closes', unit: '° ABDC', min: 20, max: 100, step: 1, only: 'rotary' },
      { key: 'portEO', label: 'Exhaust opens', unit: '° BBDC', min: 30, max: 100, step: 1, only: 'rotary' },
      { key: 'portEC', label: 'Exhaust closes', unit: '° ATDC', min: -10, max: 70, step: 1, only: 'rotary', hint: 'Negative means before TDC. Peripheral exhaust ports close late and overlap with the intake.' },
    ],
  },
  {
    id: 'fuel',
    name: 'Fuel and air',
    fields: [
      { key: 'afrCruise', label: 'AFR at part throttle', unit: ':1', min: 10, max: 18, step: 0.1 },
      { key: 'afrWot', label: 'AFR at full throttle', unit: ':1', min: 10, max: 18, step: 0.1, hint: 'Best power is a bit rich, around 12.5 to 13.' },
      { key: 'octane', label: 'Fuel octane', unit: 'AKI', min: 80, max: 110, step: 1 },
      { key: 'runner', label: 'Intake runner', unit: 'mm', min: 100, max: 600, step: 5 , conv: 'len' },
      { key: 'tbMm', label: 'Throttle body', unit: 'mm', min: 0, max: 120, step: 1, hint: '0 sizes it from displacement.' },
      { key: 'boost', label: 'Wastegate', unit: 'psi', min: 2, max: 35, step: 0.5, only: 'turbo', hint: 'Boost the gate holds once the turbo is lit. More boost means more heat in the charge and more pressure in the cylinder.' , conv: 'boost' },
      { key: 'turboSize', label: 'Compressor inducer', unit: 'mm', min: 38, max: 90, step: 1, only: 'turbo', hint: 'Bigger flows more air up top but needs more exhaust to wake up. Too small and it chokes and oversped.' },
    ],
  },
  {
    id: 'limits',
    name: 'Limits',
    fields: [
      { key: 'revLimit', label: 'Rev limiter', unit: 'rpm', min: 2000, max: 12000, step: 50 },
      { key: 'idleRpm', label: 'Idle target', unit: 'rpm', min: 500, max: 2000, step: 10 },
      { key: 'rodStrength', label: 'Rod strength', unit: 'kN', min: 4, max: 60, step: 0.5, only: 'piston', hint: 'How much inertial pull the rods take before one snaps. Forged rods buy you rpm.' , conv: 'force' },
      { key: 'pressureLimit', label: 'Head gasket holds', unit: 'bar', min: 50, max: 160, step: 1, only: 'piston', hint: 'Peak cylinder pressure before the gasket starts to give. MLS gaskets and head studs move this up.' , conv: 'press' },
      { key: 'pressureLimit', label: 'Seals hold', unit: 'bar', min: 50, max: 140, step: 1, only: 'rotary', hint: 'Peak chamber pressure the side and corner seals take before they start blowing by.' , conv: 'press' },
      { key: 'rodStrength', label: 'Rotor bearing rating', unit: 'kN', min: 20, max: 160, step: 1, only: 'rotary', hint: 'Load the rotor bearing takes from the rotor orbiting the e-shaft.' , conv: 'force' },
    ],
  },
];

export interface PanelHooks {
  onChange(key: keyof Tune): void;
  getLive(): { rpm: number; map: number };
  imperial(): boolean;
}

export class TunePanel {
  private inputs: { f: Field; num: HTMLInputElement; range: HTMLInputElement; row: HTMLElement; unit: HTMLElement }[] = [];
  private notesEl!: HTMLElement;
  private sparkNote!: HTMLElement;
  private layoutSel!: HTMLSelectElement;
  private vtSel!: HTMLSelectElement;
  private vtRow!: HTMLElement;
  private toggles: { key: 'turbo' | 'intercooler' | 'bov'; box: HTMLInputElement; row: HTMLElement; turboOnly: boolean }[] = [];
  private derived = new Map<string, HTMLElement>();
  private cells: HTMLElement[][] = [];
  private sel = { r0: 0, c0: 0, r1: 0, c1: 0, active: false };
  private lastCursor: HTMLElement | null = null;
  activeTab = 'engine';

  constructor(
    private host: HTMLElement,
    private tune: () => Tune,
    private hooks: PanelHooks,
  ) {
    this.render();
  }

  private render() {
    const tabs = [
      ...GROUPS.slice(0, 2).map((g) => ({ id: g.id, name: g.name })),
      { id: 'spark', name: 'Spark' },
      ...GROUPS.slice(2).map((g) => ({ id: g.id, name: g.name })),
    ];
    this.host.innerHTML = '';
    const nav = el('div', 'tabs');
    nav.setAttribute('role', 'tablist');
    tabs.forEach((t) => {
      const b = el('button', 'tab') as HTMLButtonElement;
      b.textContent = t.name;
      b.setAttribute('role', 'tab');
      b.dataset.tab = t.id;
      b.onclick = () => this.show(t.id);
      nav.append(b);
    });
    this.host.append(nav);

    const body = el('div', 'tab-body');
    this.host.append(body);
    this.notesEl = el('p', 'tune-notes');
    body.append(this.notesEl);

    for (const g of GROUPS) {
      const sec = el('section', 'pane');
      sec.dataset.pane = g.id;
      if (g.id === 'engine') sec.append(this.layoutRow());
      if (g.id === 'cam') sec.append(this.valvetrainRow());
      for (const f of g.fields) {
        if (f.key === 'boost') sec.append(this.toggleRow('turbo', 'Turbo', 'Exhaust drives a turbine, the turbine spins a compressor, the compressor packs the intake.', false));
        sec.append(this.fieldRow(f));
      }
      if (g.id === 'fuel') {
        sec.append(this.toggleRow('intercooler', 'Intercooler', 'Pulls most of the compressor heat back out before it reaches the engine. Hot charge is less dense and knocks sooner.', true));
        sec.append(this.toggleRow('bov', 'Blow off valve', 'Vents boost when you lift. Without it the air bangs back through the compressor and it surges.', true));
      }
      sec.append(this.derivedBlock(g.id));
      body.append(sec);
    }
    body.append(this.sparkPane());
    this.show(this.activeTab);
    this.sync();
  }

  show(id: string) {
    this.activeTab = id;
    this.host.querySelectorAll<HTMLElement>('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === id)));
    this.host.querySelectorAll<HTMLElement>('.pane').forEach((p) => (p.hidden = p.dataset.pane !== id));
  }

  private layoutRow() {
    const row = el('label', 'field');
    const top = el('span', 'field-top');
    top.append(text('span', 'field-label', 'Layout'));
    row.append(top);
    const s = document.createElement('select');
    s.className = 'select';
    for (const l of Object.values(LAYOUTS)) {
      const o = document.createElement('option');
      o.value = l.id;
      o.textContent = l.name;
      s.append(o);
    }
    s.onchange = () => {
      this.tune().layout = s.value as LayoutId;
      this.hooks.onChange('layout');
      this.sync();
    };
    this.layoutSel = s;
    row.append(s);
    return row;
  }

  private valvetrainRow() {
    const row = el('label', 'field');
    const top = el('span', 'field-top');
    top.append(text('span', 'field-label', 'Valvetrain'));
    row.append(top);
    const s = document.createElement('select');
    s.className = 'select';
    for (const [v, n] of [['ohc', 'Overhead cam'], ['pushrod', 'Pushrod, cam in block']]) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = n;
      s.append(o);
    }
    s.onchange = () => {
      this.tune().valvetrain = s.value as Tune['valvetrain'];
      this.hooks.onChange('valvetrain');
      this.sync();
    };
    this.vtSel = s;
    this.vtRow = row;
    row.append(s);
    return row;
  }

  private toggleRow(key: 'turbo' | 'intercooler' | 'bov', label: string, hint: string, turboOnly: boolean) {
    const row = el('div', 'field field-toggle');
    const lab = el('label', 'check');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.onchange = () => {
      this.tune()[key] = box.checked;
      this.hooks.onChange(key);
      this.sync();
    };
    lab.append(box, document.createTextNode(label));
    row.append(lab, text('p', 'hint', hint));
    this.toggles.push({ key, box, row, turboOnly });
    return row;
  }

  // factor, unit and decimals to show this field in right now
  private scale(f: Field): [number, string, number] {
    if (!f.conv) return [1, f.unit, 2];
    const c = CONV[f.conv];
    return this.hooks.imperial() ? c.imp : c.met;
  }

  private fieldRow(f: Field) {
    const row = el('div', 'field');
    const top = el('div', 'field-top');
    const id = `f-${f.key}${f.only ? `-${f.only}` : ''}`;
    const lab = text('label', 'field-label', f.label) as HTMLLabelElement;
    lab.htmlFor = id;
    const numWrap = el('span', 'num');
    const num = document.createElement('input');
    num.type = 'number';
    num.id = id;
    num.min = String(f.min);
    num.max = String(f.max);
    num.step = String(f.step);
    const unitEl = text('span', 'unit', f.unit);
    numWrap.append(num, unitEl);
    top.append(lab, numWrap);
    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(f.min);
    range.max = String(f.max);
    range.step = String(f.step);
    range.setAttribute('aria-label', f.label);
    const apply = (v: number) => {
      if (!Number.isFinite(v)) return;
      v = Math.min(f.max, Math.max(f.min, v));
      (this.tune() as unknown as Record<string, number>)[f.key] = v;
      this.hooks.onChange(f.key);
      this.sync();
    };
    range.oninput = () => apply(+range.value);
    num.onchange = () => apply(+num.value / this.scale(f)[0]);
    row.append(top, range);
    if (f.hint) row.append(text('p', 'hint', f.hint));
    this.inputs.push({ f, num, range, row, unit: unitEl });
    return row;
  }

  private derivedBlock(group: string) {
    const d = el('dl', 'derived');
    const add = (k: string, label: string) => {
      const dt = text('dt', '', label);
      const dd = el('dd', '');
      d.append(dt, dd);
      this.derived.set(k, dd);
    };
    if (group === 'engine') {
      add('disp', 'Displacement');
      add('rs', 'Rod to stroke');
      add('ps', 'Piston speed at limiter');
    } else if (group === 'cam') {
      add('lsa', 'Lobe separation');
      add('overlap', 'Overlap');
      add('ivc', 'Intake closes');
      add('float', 'Valve float');
    } else if (group === 'fuel') {
      add('lambda', 'Lambda at full throttle');
      add('tuned', 'Runner tuned for');
    } else if (group === 'limits') {
      add('rodlim', 'Rods let go near');
      add('float2', 'Valve float');
    }
    return d;
  }

  private sparkPane() {
    const sec = el('section', 'pane');
    sec.dataset.pane = 'spark';
    this.sparkNote = text('p', 'hint', '');
    sec.append(this.sparkNote);
    const wrap = el('div', 'spark-wrap');
    const table = el('div', 'spark-table');
    table.style.gridTemplateColumns = `auto repeat(${SPARK_RPM.length}, 1fr)`;
    table.tabIndex = 0;
    table.setAttribute('aria-label', 'Spark advance table');
    table.append(text('span', 'corner', 'kPa'));
    SPARK_RPM.forEach((r) => table.append(text('span', 'axis', r >= 1000 ? `${r / 1000}k` : String(r))));
    this.cells = [];
    for (let mi = SPARK_MAP.length - 1; mi >= 0; mi--) {
      table.append(text('span', 'axis axis-row', String(SPARK_MAP[mi])));
      const row: HTMLElement[] = [];
      SPARK_RPM.forEach((_, ri) => {
        const c = el('span', 'cell');
        c.dataset.m = String(mi);
        c.dataset.r = String(ri);
        c.onpointerdown = (ev) => {
          ev.preventDefault();
          table.focus();
          if (ev.shiftKey && this.sel.active) {
            this.sel.r1 = mi;
            this.sel.c1 = ri;
          } else {
            this.sel = { r0: mi, c0: ri, r1: mi, c1: ri, active: true };
          }
          this.paintSel();
          const move = (e2: PointerEvent) => {
            const t = document.elementFromPoint(e2.clientX, e2.clientY) as HTMLElement | null;
            if (t?.classList.contains('cell')) {
              this.sel.r1 = +t.dataset.m!;
              this.sel.c1 = +t.dataset.r!;
              this.paintSel();
            }
          };
          const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        };
        row.push(c);
        table.append(c);
      });
      this.cells[mi] = row;
    }
    table.onkeydown = (ev) => {
      if (ev.key === '+' || ev.key === '=' || ev.key === 'PageUp') this.bump(ev.shiftKey ? 0.5 : 1);
      else if (ev.key === '-' || ev.key === '_' || ev.key === 'PageDown') this.bump(ev.shiftKey ? -0.5 : -1);
      else if (ev.key.startsWith('Arrow')) {
        const dm = ev.key === 'ArrowUp' ? 1 : ev.key === 'ArrowDown' ? -1 : 0;
        const dr = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
        const m = clampI(this.sel.r1 + dm, 0, SPARK_MAP.length - 1);
        const r = clampI(this.sel.c1 + dr, 0, SPARK_RPM.length - 1);
        if (ev.shiftKey) {
          this.sel.r1 = m;
          this.sel.c1 = r;
        } else this.sel = { r0: m, c0: r, r1: m, c1: r, active: true };
        this.paintSel();
      } else return;
      ev.preventDefault();
      ev.stopPropagation();
    };
    wrap.append(table);
    sec.append(wrap);

    const tools = el('div', 'spark-tools');
    const btn = (label: string, fn: () => void, title?: string) => {
      const b = text('button', 'btn btn-quiet', label) as HTMLButtonElement;
      if (title) b.title = title;
      b.onclick = fn;
      tools.append(b);
    };
    btn('Advance 1°', () => this.bump(1), 'Plus key');
    btn('Retard 1°', () => this.bump(-1), 'Minus key');
    btn('Smooth', () => this.smooth());
    btn('Select all', () => {
      this.sel = { r0: 0, c0: 0, r1: SPARK_MAP.length - 1, c1: SPARK_RPM.length - 1, active: true };
      this.paintSel();
    });
    btn('Flatten to 20°', () => {
      this.tune().spark = makeSpark(20, 20, 0);
      this.hooks.onChange('spark');
      this.sync();
    }, 'Good starting point for finding MBT by hand');
    sec.append(tools);
    sec.append(text('p', 'hint', 'Click or drag to select cells, shift click to extend, then use plus and minus. Too much advance on low octane will knock.'));
    return sec;
  }

  private range() {
    const s = this.sel;
    return {
      m0: Math.min(s.r0, s.r1),
      m1: Math.max(s.r0, s.r1),
      c0: Math.min(s.c0, s.c1),
      c1: Math.max(s.c0, s.c1),
    };
  }

  private bump(d: number) {
    if (!this.sel.active) return;
    const { m0, m1, c0, c1 } = this.range();
    const sp = this.tune().spark;
    for (let m = m0; m <= m1; m++) for (let c = c0; c <= c1; c++) sp[m][c] = Math.max(-10, Math.min(60, Math.round((sp[m][c] + d) * 2) / 2));
    this.hooks.onChange('spark');
    this.paintCells();
  }

  private smooth() {
    const sp = this.tune().spark;
    const src = sp.map((r) => [...r]);
    const { m0, m1, c0, c1 } = this.sel.active ? this.range() : { m0: 0, m1: SPARK_MAP.length - 1, c0: 0, c1: SPARK_RPM.length - 1 };
    for (let m = m0; m <= m1; m++)
      for (let c = c0; c <= c1; c++) {
        let sum = 0;
        let n = 0;
        for (let dm = -1; dm <= 1; dm++)
          for (let dc = -1; dc <= 1; dc++) {
            const v = src[m + dm]?.[c + dc];
            if (v !== undefined) {
              sum += v;
              n++;
            }
          }
        sp[m][c] = Math.round((sum / n) * 2) / 2;
      }
    this.hooks.onChange('spark');
    this.paintCells();
  }

  private paintSel() {
    const { m0, m1, c0, c1 } = this.range();
    this.cells.forEach((row, m) => row.forEach((c, r) => c.classList.toggle('sel', this.sel.active && m >= m0 && m <= m1 && r >= c0 && r <= c1)));
  }

  private paintCells() {
    const sp = this.tune().spark;
    this.cells.forEach((row, m) =>
      row.forEach((c, r) => {
        const v = sp[m][r];
        c.textContent = Number.isInteger(v) ? String(v) : v.toFixed(1);
        // cool steel for little advance, ignition amber for a lot
        const t = Math.max(0, Math.min(1, (v - 5) / 40));
        c.style.setProperty('--t', t.toFixed(3));
      }),
    );
  }

  // live cursor on the spark table
  tick() {
    if (this.activeTab !== 'spark') return;
    const { rpm, map } = this.hooks.getLive();
    let ri = 0;
    let best = Infinity;
    SPARK_RPM.forEach((r, i) => {
      if (Math.abs(r - rpm) < best) {
        best = Math.abs(r - rpm);
        ri = i;
      }
    });
    let mi = 0;
    best = Infinity;
    SPARK_MAP.forEach((m, i) => {
      if (Math.abs(m - map) < best) {
        best = Math.abs(m - map);
        mi = i;
      }
    });
    const c = this.cells[mi]?.[ri] ?? null;
    if (c !== this.lastCursor) {
      this.lastCursor?.classList.remove('live');
      c?.classList.add('live');
      this.lastCursor = c;
    }
  }

  sync() {
    const t = this.tune();
    const kind = LAYOUTS[t.layout].kind;
    this.layoutSel.value = t.layout;
    this.vtSel.value = t.valvetrain ?? 'ohc';
    this.vtRow.hidden = kind === 'rotary';
    const pushrod = kind === 'piston' && t.valvetrain === 'pushrod';
    for (const g of this.toggles) {
      g.box.checked = !!t[g.key];
      g.row.hidden = g.turboOnly && !t.turbo;
    }
    this.notesEl.textContent = t.notes ?? '';
    this.notesEl.hidden = !t.notes;
    const camTab = this.host.querySelector<HTMLElement>('.tab[data-tab="cam"]');
    if (camTab) camTab.textContent = kind === 'rotary' ? 'Ports' : 'Camshaft';
    this.sparkNote.textContent =
      kind === 'rotary'
        ? 'Ignition advance in e-shaft degrees before TDC. Rows are manifold pressure, columns are rpm. The outlined cell is where the engine is running right now.'
        : 'Ignition advance in degrees before TDC. Rows are manifold pressure, columns are rpm. The outlined cell is where the engine is running right now.';
    for (const { f, num, range, row, unit } of this.inputs) {
      row.hidden = f.only === 'pushrod' ? !pushrod : f.only === 'turbo' ? !t.turbo : !!f.only && f.only !== kind;
      const k = f.key;
      const v = t[k] as number;
      const [k2, u, d] = this.scale(f);
      unit.textContent = u;
      num.step = f.conv ? 'any' : String(f.step);
      if (document.activeElement !== num) num.value = String(+(v * k2).toFixed(d));
      range.value = String(v);
      range.style.setProperty('--fill', `${((v - +range.min) / (+range.max - +range.min)) * 100}%`);
    }
    this.paintCells();
    this.paintSel();
    this.updateDerived();
  }

  private speed(ms: number) {
    return this.hooks.imperial() ? `${Math.round(ms * 196.85).toLocaleString()} ft/min` : `${ms.toFixed(1)} m/s`;
  }

  updateDerived(extra?: { floatRpm: number; rodRpm: number }) {
    const t = this.tune();
    const lay = LAYOUTS[t.layout];
    const n = lay.cyls.length;
    const set = (k: string, v: string) => {
      const e = this.derived.get(k);
      if (e) e.textContent = v;
    };
    const show = (k: string, on: boolean) => {
      const e = this.derived.get(k);
      if (e) {
        e.hidden = !on;
        (e.previousElementSibling as HTMLElement).hidden = !on;
      }
    };
    if (lay.kind === 'rotary') {
      const face = 3 * Math.sqrt(3) * t.rotorE * t.rotorR * t.rotorB / 1000; // cc
      const rotors = lay.rotors!.length;
      set('disp', `${rotors} x ${Math.round(face)} cc`);
      set('rs', '');
      set('ps', this.speed(((t.rotorR + t.rotorE) / 1000) * (t.revLimit / 3) * (Math.PI / 30)));
      set('lsa', '');
      set('overlap', `${Math.max(0, t.portEC - t.portIO)}°`);
      set('ivc', `${t.portIC}° ABDC`);
      for (const k of ['rs', 'lsa', 'float', 'float2']) show(k, false);
      (this.derived.get('ps')?.previousElementSibling as HTMLElement).textContent = 'Apex speed at limiter';
      (this.derived.get('rodlim')?.previousElementSibling as HTMLElement).textContent = 'Rotor bearing lets go near';
      set('lambda', (t.afrWot / 14.7).toFixed(2));
      set('tuned', `${Math.round(1.9e6 / t.runner / 50) * 50} rpm`);
      if (extra) set('rodlim', `${Math.round(extra.rodRpm / 10) * 10} rpm`);
      return;
    }
    for (const k of ['rs', 'lsa', 'float', 'float2']) show(k, true);
    (this.derived.get('ps')?.previousElementSibling as HTMLElement).textContent = 'Piston speed at limiter';
    (this.derived.get('rodlim')?.previousElementSibling as HTMLElement).textContent = 'Rods let go near';
    const disp = (Math.PI / 4) * (t.bore / 10) ** 2 * (t.stroke / 10) * n;
    set('disp', `${(disp / 1000).toFixed(2)} L, ${Math.round(disp / 16.387)} ci`);
    set('rs', (t.rod / t.stroke).toFixed(2));
    set('ps', this.speed((2 * t.stroke * t.revLimit) / 60000));
    const lsa = (t.inCenterline + t.exCenterline) / 2;
    set('lsa', `${lsa.toFixed(1)}°`);
    const ivo = t.inCenterline - t.inDuration / 2; // ATDC, negative means BTDC
    const evc = 720 - t.exCenterline + t.exDuration / 2 - 720;
    const overlap = Math.max(0, evc - ivo);
    set('overlap', `${overlap.toFixed(0)}°`);
    const ivc = t.inCenterline + t.inDuration / 2 - 180;
    set('ivc', `${ivc.toFixed(0)}° ABDC`);
    set('lambda', (t.afrWot / 14.7).toFixed(2));
    set('tuned', `${Math.round(1.9e6 / t.runner / 50) * 50} rpm`);
    if (extra) {
      set('float', `${Math.round(extra.floatRpm / 10) * 10} rpm`);
      set('float2', `${Math.round(extra.floatRpm / 10) * 10} rpm`);
      set('rodlim', `${Math.round(extra.rodRpm / 10) * 10} rpm`);
    }
  }
}

function el(tag: string, cls: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
function text(tag: string, cls: string, t: string) {
  const e = el(tag, cls);
  e.textContent = t;
  return e;
}
function clampI(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}
