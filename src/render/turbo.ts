// Turbo kit: a proper snail with its plumbing. Built in its own frame with the shaft
// along x, compressor on -x and turbine on +x, then dropped next to the engine and
// piped up to whatever header tips and intake runners the engine view hands over.

import * as THREE from 'three';

export interface TurboKitIn {
  inducerMm: number;
  S: number; // scene units per metre
  B: number; // bore (or a stand-in) in scene units, for pipe sizes
  exTips: THREE.Vector3[]; // where the headers end, root space
  inTops: THREE.Vector3[]; // where the intake runners end, root space
  box: THREE.Box3; // engine bounds before the kit goes on
  front: 1 | -1; // which end of the crank faces forward
  intercooler: boolean;
  bov: boolean;
}

export interface TurboKit {
  group: THREE.Group; // everything, for picking and highlight
  wheel: THREE.Object3D;
  twheel: THREE.Object3D;
  hot: THREE.MeshStandardMaterial[]; // glow with EGT
  blade: THREE.Object3D; // throttle plate
}

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);

function cast(color: number, rough = 0.62, metal = 0.75) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
}

// a lathe around the x axis. profile points are [radius, x]
function lathe(profile: [number, number][], m: THREE.Material, segs = 48) {
  const g = new THREE.LatheGeometry(
    profile.map(([r, x]) => new THREE.Vector2(r, x)),
    segs,
  );
  g.rotateZ(-Math.PI / 2);
  return new THREE.Mesh(g, m);
}

function cyl(r0: number, r1: number, len: number, m: THREE.Material, segs = 32, open = false) {
  const g = new THREE.CylinderGeometry(r1, r0, len, segs, 1, open);
  return new THREE.Mesh(g, m);
}

// cylinder from a to b
function rod(a: THREE.Vector3, b: THREE.Vector3, r: number, m: THREE.Material, segs = 20) {
  const d = b.clone().sub(a);
  const mesh = cyl(r, r, d.length(), m, segs);
  mesh.position.copy(a).addScaledVector(d, 0.5);
  mesh.quaternion.setFromUnitVectors(Y, d.normalize());
  return mesh;
}

function pipe(pts: THREE.Vector3[], r: number, m: THREE.Material, tension = 0.5) {
  const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', tension);
  const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(24, pts.length * 14), r, 18, false), m);
  mesh.castShadow = true;
  return mesh;
}

// short silicone joiner over a pipe end, pointing along dir
function coupler(at: THREE.Vector3, dir: THREE.Vector3, r: number, m: THREE.Material) {
  const c = cyl(r * 1.12, r * 1.12, r * 1.3, m, 24);
  c.position.copy(at);
  c.quaternion.setFromUnitVectors(Y, dir.clone().normalize());
  const g = new THREE.Group();
  g.add(c);
  for (const s of [-0.42, 0.42]) {
    const clamp = new THREE.Mesh(new THREE.TorusGeometry(r * 1.15, r * 0.06, 8, 28), cast(0xb7bbbf, 0.3, 1));
    clamp.position.copy(at).addScaledVector(dir.clone().normalize(), s * r * 1.3);
    clamp.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().normalize());
    g.add(clamp);
  }
  return g;
}

interface Volute {
  mesh: THREE.Mesh;
  end: THREE.Vector3;
  dir: THREE.Vector3;
  r: number;
}

// the snail: a tube wrapped once round the shaft that grows as it goes, then leaves
// on a tangent. sweep sign sets which way it winds
function volute(xc: number, rBase: number, rs0: number, rs1: number, theta0: number, sweep: number, m: THREE.Material): Volute {
  const segs = 72;
  const rings = 20;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const u = i / segs;
    const th = theta0 + sweep * u;
    const rs = rs0 + (rs1 - rs0) * Math.pow(u, 0.85);
    const cr = rBase + rs;
    const cy = cr * Math.cos(th);
    const cz = cr * Math.sin(th);
    const vy = Math.cos(th);
    const vz = Math.sin(th);
    for (let j = 0; j <= rings; j++) {
      const ph = (j / rings) * Math.PI * 2;
      // slightly flattened on the back face like the casting
      const ax = Math.sin(ph) * rs * (Math.sin(ph) > 0 ? 1 : 0.8);
      pos.push(xc + ax, cy + Math.cos(ph) * rs * vy, cz + Math.cos(ph) * rs * vz);
    }
  }
  for (let i = 0; i < segs; i++) {
    for (let j = 0; j < rings; j++) {
      const a = i * (rings + 1) + j;
      const b = a + rings + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, m);
  mesh.castShadow = true;
  const th = theta0 + sweep;
  const cr = rBase + rs1;
  const end = new THREE.Vector3(xc, cr * Math.cos(th), cr * Math.sin(th));
  const dir = new THREE.Vector3(0, -Math.sin(th), Math.cos(th)).multiplyScalar(Math.sign(sweep));
  return { mesh, end, dir, r: rs1 };
}

// impeller blade as a twisted sheet between hub and shroud
function blades(n: number, x0: number, x1: number, hubR: (s: number) => number, tipR: (s: number) => number, twist: (s: number) => number, startS: number, m: THREE.Material) {
  const out = new THREE.Group();
  const nx = 14;
  const nr = 4;
  for (let k = 0; k < n; k++) {
    const phi = (k / n) * Math.PI * 2;
    const pos: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= nx; i++) {
      const s = startS + (1 - startS) * (i / nx);
      const x = x0 + (x1 - x0) * s;
      const a = phi + twist(s);
      const r0 = hubR(s);
      const r1 = tipR(s);
      for (let j = 0; j <= nr; j++) {
        const r = r0 + (r1 - r0) * (j / nr);
        pos.push(x, Math.cos(a) * r, Math.sin(a) * r);
      }
    }
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nr; j++) {
        const a = i * (nr + 1) + j;
        const b = a + nr + 1;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    out.add(new THREE.Mesh(g, m));
  }
  return out;
}

export function buildTurboKit(o: TurboKitIn): TurboKit {
  const ind = (o.inducerMm / 1000) * o.S;
  const exd = ind * 1.36;
  const B = o.B;
  const hot: THREE.MeshStandardMaterial[] = [];

  const alu = cast(0x878c91, 0.8, 0.55);
  const iron = cast(0x4b4641, 0.78, 0.6);
  iron.emissive = new THREE.Color(0);
  hot.push(iron);
  const steel = cast(0x9da2a6, 0.35, 1);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0xdfe2e4, roughness: 0.22, metalness: 1, side: THREE.DoubleSide });
  const inconel = new THREE.MeshStandardMaterial({ color: 0x77706a, roughness: 0.45, metalness: 1, side: THREE.DoubleSide });
  const black = cast(0x1d1f21, 0.6, 0.3);

  const body = new THREE.Group();
  const xC = -0.78 * ind;
  const xT = 0.78 * ind;

  // ---- compressor
  const cRb = exd * 0.52;
  const comp = volute(xC, cRb, ind * 0.12, ind * 0.42, -Math.PI / 2, Math.PI * 2, alu);
  body.add(comp.mesh);
  const cOutLen = ind * 0.9;
  const cOut = cyl(comp.r, comp.r * 0.92, cOutLen, alu, 28);
  cOut.position.copy(comp.end).addScaledVector(comp.dir, cOutLen / 2);
  cOut.quaternion.setFromUnitVectors(Y, comp.dir);
  body.add(cOut);
  const cOutTip = comp.end.clone().addScaledVector(comp.dir, cOutLen);
  // back plate and cover, the cover is where the inlet bell and shroud live
  const nose = xC - ind * 0.55;
  const mouth = nose - ind * 0.55;
  const tipR = (s: number) => ind * 0.49 + (exd / 2 - ind * 0.49) * Math.pow(s, 3);
  const hubR = (s: number) => ind * 0.13 + (exd * 0.47 - ind * 0.13) * Math.pow(s, 2.4);
  const shroud: [number, number][] = [];
  for (let i = 0; i <= 10; i++) {
    const s = 1 - i / 10;
    shroud.push([tipR(s) + ind * 0.015, nose + (xC - nose) * s]);
  }
  const cover = lathe(
    [
      [cRb + ind * 0.12, xC + ind * 0.05],
      ...shroud,
      [ind * 0.5, mouth + ind * 0.08],
      [ind * 0.6, mouth],
      [ind * 0.66, mouth + ind * 0.06],
      [ind * 0.62, mouth + ind * 0.16],
      [ind * 0.64, xC - ind * 0.3],
      [ind * 0.8, xC - ind * 0.22],
      [cRb, xC - ind * 0.18],
      [cRb + ind * 0.12, xC - ind * 0.05],
    ],
    new THREE.MeshStandardMaterial({ color: 0x878c91, roughness: 0.8, metalness: 0.55, side: THREE.DoubleSide }),
    56,
  );
  body.add(cover);
  const backPlate = cyl(cRb + ind * 0.2, cRb + ind * 0.2, ind * 0.14, alu, 48);
  backPlate.rotation.z = Math.PI / 2;
  backPlate.position.x = xC + ind * 0.2;
  body.add(backPlate);

  // compressor wheel, main blades and splitters
  const wheel = new THREE.Group();
  const hub = lathe(
    Array.from({ length: 12 }, (_, i) => {
      const s = i / 11;
      return [hubR(s), nose + (xC - nose) * s] as [number, number];
    }).concat([[exd * 0.47, xC + ind * 0.03], [ind * 0.08, xC + ind * 0.03]]),
    wheelMat,
    40,
  );
  wheel.add(hub);
  const twist = (s: number) => 1.15 * Math.pow(1 - s, 1.7);
  wheel.add(blades(7, nose, xC, hubR, tipR, twist, 0, wheelMat));
  const split = blades(7, nose, xC, hubR, tipR, twist, 0.42, wheelMat);
  split.rotation.x = Math.PI / 7;
  wheel.add(split);
  const nut = lathe([[0.001, nose - ind * 0.12], [ind * 0.07, nose - ind * 0.06], [ind * 0.08, nose + ind * 0.02], [0.001, nose + ind * 0.02]], cast(0xe6e8ea, 0.25, 1), 6);
  wheel.add(nut);
  body.add(wheel);

  // ---- center section: bearing housing with oil in on top and out the bottom
  const chra = lathe(
    [
      [0.001, xC + ind * 0.27],
      [ind * 0.58, xC + ind * 0.27],
      [ind * 0.58, xC + ind * 0.36],
      [ind * 0.4, xC + ind * 0.42],
      [ind * 0.36, 0],
      [ind * 0.4, xT - ind * 0.42],
      [ind * 0.55, xT - ind * 0.34],
      [ind * 0.55, xT - ind * 0.26],
      [0.001, xT - ind * 0.26],
    ],
    cast(0x7c8186, 0.5, 0.85),
    40,
  );
  body.add(chra);
  const feed = cyl(ind * 0.09, ind * 0.09, ind * 0.25, steel, 16);
  feed.position.set(0, ind * 0.45, 0);
  body.add(feed);
  const banjo = cyl(ind * 0.13, ind * 0.13, ind * 0.12, cast(0xc69a3a, 0.35, 1), 6);
  banjo.position.set(0, ind * 0.6, 0);
  body.add(banjo);
  const drain = new THREE.Mesh(new THREE.BoxGeometry(ind * 0.32, ind * 0.12, ind * 0.32), cast(0x7c8186, 0.5, 0.85));
  drain.position.set(0, -ind * 0.43, 0);
  body.add(drain);
  body.add(rod(new THREE.Vector3(0, -ind * 0.45, 0), new THREE.Vector3(0, -ind * 1.1, ind * 0.1), ind * 0.11, black, 14));

  // ---- turbine: cast iron, inlet flange underneath on the engine side
  const tRb = exd * 0.44;
  const turb = volute(xT, tRb, ind * 0.14, ind * 0.44, Math.PI * 1.5 + Math.PI * 2, -Math.PI * 2, iron);
  body.add(turb.mesh);
  // volute leaves on a tangent, the gas goes in the other way, so the stub points back down that line
  const tInLen = ind * 0.55;
  const tStub = cyl(turb.r * 1.05, turb.r, tInLen, iron, 24);
  tStub.position.copy(turb.end).addScaledVector(turb.dir, tInLen / 2);
  tStub.quaternion.setFromUnitVectors(Y, turb.dir);
  body.add(tStub);
  const flangeAt = turb.end.clone().addScaledVector(turb.dir, tInLen);
  const flange = new THREE.Mesh(new THREE.BoxGeometry(turb.r * 2.9, ind * 0.1, turb.r * 2.9), iron);
  flange.position.copy(flangeAt);
  flange.quaternion.setFromUnitVectors(Y, turb.dir);
  body.add(flange);
  const tCore = cyl(tRb, tRb, ind * 0.3, iron, 40);
  tCore.rotation.z = Math.PI / 2;
  tCore.position.x = xT;
  body.add(tCore);
  // exducer bore and the v-band
  const tOutLen = ind * 0.62;
  const tOut = lathe(
    [
      [ind * 0.42, xT + ind * 0.2],
      [ind * 0.42, xT + tOutLen],
      [ind * 0.58, xT + tOutLen],
      [ind * 0.62, xT + ind * 0.2],
      [tRb, xT + ind * 0.05],
    ],
    new THREE.MeshStandardMaterial({ color: 0x4b4641, roughness: 0.78, metalness: 0.6, side: THREE.DoubleSide }),
    40,
  );
  hot.push(tOut.material as THREE.MeshStandardMaterial);
  body.add(tOut);
  const vband = new THREE.Mesh(new THREE.TorusGeometry(ind * 0.6, ind * 0.05, 8, 40), steel);
  vband.rotation.y = Math.PI / 2;
  vband.position.x = xT + tOutLen + ind * 0.02;
  body.add(vband);
  const twheel = new THREE.Group();
  const tHub = lathe([[ind * 0.08, xT + ind * 0.35], [ind * 0.16, xT + ind * 0.15], [ind * 0.24, xT - ind * 0.05], [0.001, xT - ind * 0.05]], inconel, 24);
  twheel.add(tHub);
  twheel.add(
    blades(
      11,
      xT + ind * 0.35,
      xT - ind * 0.05,
      (s) => ind * (0.08 + 0.16 * s),
      (s) => ind * (0.4 - 0.02 * s),
      (s) => 0.5 * Math.pow(1 - s, 2),
      0,
      inconel,
    ),
  );
  body.add(twheel);

  // ---- wastegate can on a bracket off the compressor, rod back to the flapper arm
  const can = lathe(
    [
      [0.001, -ind * 0.18],
      [ind * 0.3, -ind * 0.16],
      [ind * 0.34, -ind * 0.1],
      [ind * 0.34, ind * 0.1],
      [ind * 0.3, ind * 0.16],
      [0.001, ind * 0.18],
    ],
    cast(0x2a2d30, 0.45, 0.6),
    32,
  );
  const canAt = new THREE.Vector3(xC + ind * 0.15, ind * 0.25, cRb + ind * 0.9);
  can.position.copy(canAt);
  body.add(can);
  body.add(rod(canAt.clone().add(new THREE.Vector3(0, 0, -ind * 0.3)), new THREE.Vector3(xC + ind * 0.2, ind * 0.25, cRb + ind * 0.2), ind * 0.04, steel, 8));
  const armAt = new THREE.Vector3(xT + ind * 0.1, ind * 0.25, tRb + ind * 0.45);
  body.add(rod(canAt.clone().add(new THREE.Vector3(ind * 0.18, 0, 0)), armAt, ind * 0.03, steel, 8));
  const arm = new THREE.Mesh(new THREE.BoxGeometry(ind * 0.06, ind * 0.3, ind * 0.06), steel);
  arm.position.copy(armAt).add(new THREE.Vector3(0, -ind * 0.12, 0));
  body.add(arm);

  body.traverse((c) => {
    if ((c as THREE.Mesh).isMesh) c.castShadow = true;
  });

  // ---- place it: outboard of the header tips on the side the camera sees,
  // or the only side there is
  const box = o.box;
  const tips = o.exTips;
  const zs = tips.map((p) => p.z);
  const sideZ = zs.some((z) => z > 0.01) ? 1 : -1;
  const near = tips.filter((p) => Math.sign(p.z) === sideZ || Math.abs(p.z) < 0.01);
  const far = tips.filter((p) => !near.includes(p));
  const nearX = near.length ? near.reduce((a, p) => a + p.x, 0) / near.length : (box.min.x + box.max.x) / 2;
  const tipY = Math.min(...tips.map((p) => p.y));
  const outerZ = sideZ > 0 ? box.max.z : -box.min.z;
  const reach = Math.max(cRb + ind * 0.36 * 2, tRb + ind * 0.42 * 2);
  const kit = new THREE.Group();
  // compressor toward the engine front, inlet points out the front
  body.rotation.y = o.front > 0 ? Math.PI : 0;
  const bodyAt = new THREE.Vector3(nearX, Math.max(tipY + reach * 1.3, box.min.y + (box.max.y - box.min.y) * 0.42), sideZ * (outerZ + reach * 0.85));
  body.position.copy(bodyAt);
  kit.add(body);
  body.updateMatrix();
  const toKit = (p: THREE.Vector3) => p.clone().applyMatrix4(body.matrix);
  const dirKit = (d: THREE.Vector3) => d.clone().applyQuaternion(body.quaternion).normalize();
  // if the exits ended up facing away from the engine, mirror across the shaft
  const exitZ = toKit(turb.end).z - bodyAt.z;
  if (Math.sign(exitZ) === sideZ) {
    body.rotation.x = Math.PI;
    body.updateMatrix();
  }

  const silicone = new THREE.MeshStandardMaterial({ color: 0x24497d, roughness: 0.75, metalness: 0 });
  const polished = cast(0xd9dcdf, 0.2, 1);
  const stainless = cast(0x8b8681, 0.42, 0.9);
  stainless.emissive = new THREE.Color(0);
  hot.push(stainless);

  // ---- exhaust side: near tips run straight down into a merge under the flange,
  // the far bank joins through a crossover under the pan
  const flangeK = toKit(flangeAt);
  const tDir = dirKit(turb.dir); // out of the volute toward the flange
  const merge = flangeK.clone().addScaledVector(tDir, ind * 0.6);
  const pr = B * 0.15;
  const cr = ind * 0.36;
  for (const p of near) {
    const drop = p.clone().add(new THREE.Vector3(0, -B * 0.25, 0));
    const mid = new THREE.Vector3((p.x + merge.x) / 2, Math.min(p.y, merge.y) - B * 0.35, (p.z + merge.z) / 2);
    kit.add(pipe([p, drop, mid, merge], pr, stainless));
  }
  if (far.length) {
    const sorted = [...far].sort((a, b) => a.x - b.x);
    const logY = Math.min(...far.map((p) => p.y)) - B * 0.35;
    const logZ = far.reduce((a, p) => a + p.z, 0) / far.length;
    const frontX = o.front < 0 ? sorted[0].x : sorted[sorted.length - 1].x;
    for (const p of far) kit.add(pipe([p, p.clone().add(new THREE.Vector3(0, -B * 0.2, 0)), new THREE.Vector3(p.x, logY, logZ)], pr, stainless));
    const logA = new THREE.Vector3(sorted[0].x - B * 0.2, logY, logZ);
    const logB = new THREE.Vector3(sorted[sorted.length - 1].x + B * 0.2, logY, logZ);
    kit.add(pipe([logA, logB], cr * 0.9, stainless));
    const under = box.min.y - B * 0.25;
    const cross = [
      new THREE.Vector3(frontX + o.front * B * 0.2, logY, logZ),
      new THREE.Vector3(frontX + o.front * B * 0.7, under, logZ * 0.6),
      new THREE.Vector3(frontX + o.front * B * 0.7, under, merge.z * 0.6),
      new THREE.Vector3((frontX + merge.x) / 2, merge.y - B * 0.5, merge.z),
      merge,
    ];
    kit.add(pipe(cross, cr * 0.9, stainless, 0.3));
  }
  // collector cone up into the flange
  kit.add(pipe([merge, flangeK.clone().addScaledVector(tDir, ind * 0.05)], cr, stainless));

  // downpipe off the v-band, down and back toward the rear
  const dpStart = toKit(new THREE.Vector3(xT + tOutLen + ind * 0.04, 0, 0));
  const axis = dirKit(X);
  const back = -o.front;
  const dpPts = [
    dpStart,
    dpStart.clone().addScaledVector(axis, ind * 0.5),
    dpStart.clone().addScaledVector(axis, ind * 0.7).add(new THREE.Vector3(0, -ind * 0.8, 0)),
    new THREE.Vector3(dpStart.x + back * B * 0.6, box.min.y - B * 0.1, dpStart.z),
    new THREE.Vector3((back > 0 ? box.max.x : box.min.x) + back * B * 1.2, box.min.y - B * 0.15, dpStart.z),
  ];
  kit.add(pipe(dpPts, ind * 0.42, stainless, 0.4));

  // ---- intake side: plenum over the runners, throttle body on the front end
  const tops = o.inTops;
  const topY = Math.max(...tops.map((p) => p.y));
  const plZ = tops.reduce((a, p) => a + p.z, 0) / tops.length;
  const xs = tops.map((p) => p.x);
  const plR = B * 0.32;
  const plA = Math.min(...xs) - B * 0.45;
  const plB = Math.max(...xs) + B * 0.45;
  const plenum = new THREE.Mesh(new THREE.CapsuleGeometry(plR, plB - plA, 8, 28), cast(0x2f3337, 0.5, 0.6));
  plenum.rotation.z = Math.PI / 2;
  plenum.position.set((plA + plB) / 2, topY + plR * 0.6, plZ);
  kit.add(plenum);
  for (const p of tops) kit.add(rod(p.clone().add(new THREE.Vector3(0, -B * 0.05, 0)), new THREE.Vector3(p.x, topY + plR * 0.4, (p.z + plZ) / 2), B * 0.15, cast(0x2f3337, 0.5, 0.6), 14));
  const tbR = ind * 0.5;
  const plFront = o.front < 0 ? plA - plR : plB + plR;
  const tbIn = new THREE.Vector3(plFront + o.front * B * 0.35, plenum.position.y, plZ);
  const tbOut = new THREE.Vector3(plFront + o.front * B * 0.02, plenum.position.y, plZ);
  const tb = rod(tbOut, tbIn, tbR, cast(0x3a3e42, 0.4, 0.8), 28);
  kit.add(tb);
  const blade = new THREE.Mesh(new THREE.CylinderGeometry(tbR * 0.95, tbR * 0.95, tbR * 0.05, 28), cast(0xb4a27a, 0.3, 1));
  const bladeHolder = new THREE.Group();
  bladeHolder.position.copy(tbIn.clone().add(tbOut).multiplyScalar(0.5));
  bladeHolder.add(blade);
  blade.rotation.z = Math.PI / 2; // plate faces along the bore when closed
  kit.add(bladeHolder);

  // charge pipe: compressor out, through the intercooler if there is one, into the throttle
  const cOutK = toKit(cOutTip);
  const cDir = dirKit(comp.dir);
  const pR = ind * 0.44;
  const frontEdge = o.front < 0 ? box.min.x : box.max.x;
  const tbFace = tbIn.clone().addScaledVector(new THREE.Vector3(o.front, 0, 0), B * 0.25);
  kit.add(coupler(cOutK.clone().addScaledVector(cDir, pR * 0.5), cDir, pR, silicone));
  const up = cOutK.clone().addScaledVector(cDir, pR * 1.6);
  let charge: THREE.Vector3[];
  if (o.intercooler) {
    const zSpan = box.max.z - box.min.z;
    const coreW = Math.max(zSpan * 0.85, B * 3);
    const coreH = Math.max((box.max.y - box.min.y) * 0.42, B * 1.6);
    const coreT = B * 0.4;
    const coreX = frontEdge + o.front * B * 2.2;
    const coreY = box.min.y + coreH * 0.62;
    const core = new THREE.Group();
    const tex = finTexture();
    const face = new THREE.Mesh(new THREE.BoxGeometry(coreT, coreH, coreW), new THREE.MeshStandardMaterial({ color: 0x3b4045, roughness: 0.6, metalness: 0.7, map: tex }));
    core.add(face);
    for (const s of [-1, 1]) {
      const tank = new THREE.Mesh(new THREE.BoxGeometry(coreT * 1.15, coreH * 1.05, B * 0.45), cast(0xbfc3c6, 0.4, 0.9));
      tank.position.z = s * (coreW / 2 + B * 0.22);
      core.add(tank);
    }
    core.position.set(coreX, coreY, 0);
    kit.add(core);
    const sideIn = sideZ * (coreW / 2 + B * 0.22);
    const icIn = new THREE.Vector3(coreX, coreY + coreH * 0.25, sideIn);
    const icOut = new THREE.Vector3(coreX, coreY + coreH * 0.25, -sideIn);
    kit.add(
      pipe(
        [
          up,
          up.clone().add(new THREE.Vector3(o.front * B * 0.6, B * 0.3, 0)),
          new THREE.Vector3(frontEdge + o.front * B * 0.8, up.y, icIn.z),
          new THREE.Vector3(coreX - o.front * B * 0.3, icIn.y, icIn.z),
          icIn.clone().add(new THREE.Vector3(-o.front * coreT * 0.6, 0, 0)),
        ],
        pR,
        polished,
        0.35,
      ),
    );
    charge = [
      icOut.clone().add(new THREE.Vector3(-o.front * coreT * 0.6, 0, 0)),
      new THREE.Vector3(coreX - o.front * B * 0.4, icOut.y, icOut.z),
      new THREE.Vector3(frontEdge + o.front * B * 0.5, tbFace.y, plZ + (icOut.z - plZ) * 0.3),
      tbFace,
    ];
  } else {
    charge = [up, up.clone().add(new THREE.Vector3(o.front * B * 0.3, B * 0.5, 0)), new THREE.Vector3(frontEdge + o.front * B * 0.5, Math.max(up.y, tbFace.y) + B * 0.3, (up.z + plZ) / 2), tbFace];
  }
  kit.add(pipe(charge, pR, polished, 0.35));
  kit.add(coupler(tbFace.clone().addScaledVector(new THREE.Vector3(-o.front, 0, 0), B * 0.12), new THREE.Vector3(o.front, 0, 0), pR, silicone));
  if (o.bov) {
    const at = new THREE.CatmullRomCurve3(charge).getPoint(0.7);
    const bov = lathe([[0.001, 0], [ind * 0.22, 0], [ind * 0.22, ind * 0.18], [ind * 0.3, ind * 0.22], [ind * 0.3, ind * 0.5], [0.001, ind * 0.55]], cast(0x9a2f24, 0.35, 0.8), 24);
    bov.rotation.z = Math.PI / 2;
    bov.position.copy(at).add(new THREE.Vector3(0, pR * 0.8, 0));
    kit.add(bov);
  }
  // air filter cone on the compressor inlet
  const mouthK = toKit(new THREE.Vector3(mouth - ind * 0.05, 0, 0));
  const inAxis = dirKit(new THREE.Vector3(-1, 0, 0));
  const filter = lathe(
    [
      [ind * 0.6, 0],
      [ind * 0.62, ind * 0.12],
      [ind * 0.95, ind * 0.2],
      [ind * 0.78, ind * 1.3],
      [ind * 0.8, ind * 1.36],
      [0.001, ind * 1.4],
    ],
    new THREE.MeshStandardMaterial({ color: 0x3a3a3c, roughness: 0.95, metalness: 0, map: pleatTexture() }),
    40,
  );
  // lathe axis is +x, aim it along the inlet
  filter.quaternion.setFromUnitVectors(X, inAxis);
  filter.position.copy(mouthK);
  kit.add(filter);

  kit.traverse((c) => {
    if ((c as THREE.Mesh).isMesh) c.castShadow = true;
  });
  return { group: kit, wheel, twheel, hot, blade: bladeHolder };
}

let finTex: THREE.Texture | null = null;
function finTexture() {
  if (finTex) return finTex;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#4a5056';
  g.fillRect(0, 0, 64, 256);
  g.fillStyle = '#23272b';
  for (let y = 0; y < 256; y += 6) g.fillRect(0, y, 64, 3);
  finTex = new THREE.CanvasTexture(c);
  finTex.wrapS = finTex.wrapT = THREE.RepeatWrapping;
  finTex.repeat.set(1, 3);
  return finTex;
}

let pleatTex: THREE.Texture | null = null;
function pleatTexture() {
  if (pleatTex) return pleatTex;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 16;
  const g = c.getContext('2d')!;
  for (let x = 0; x < 256; x++) {
    const v = 40 + 30 * (0.5 + 0.5 * Math.sin((x / 256) * Math.PI * 2 * 24));
    g.fillStyle = `rgb(${v},${v},${v + 3})`;
    g.fillRect(x, 0, 1, 16);
  }
  pleatTex = new THREE.CanvasTexture(c);
  pleatTex.wrapS = THREE.RepeatWrapping;
  return pleatTex;
}
