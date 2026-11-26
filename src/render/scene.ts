import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Engine, CylState } from '../sim/engine';

// 1 scene unit = 10 cm
const S = 10;
const DEG = Math.PI / 180;

export type PartKind = 'piston' | 'rod' | 'crank' | 'intake-valve' | 'exhaust-valve' | 'cam' | 'flywheel' | 'plug' | 'cylinder' | 'rotor';

export interface PartHit {
  kind: PartKind;
  cyl: number; // -1 for shared parts
}

interface CylMeshes {
  group: THREE.Group;
  piston: THREE.Group;
  rod: THREE.Group;
  gas: THREE.Mesh;
  gasMat: THREE.MeshBasicMaterial;
  inValve: THREE.Group;
  exValve: THREE.Group;
  inSpring: THREE.Mesh;
  exSpring: THREE.Mesh;
  inLobe: THREE.Mesh;
  exLobe: THREE.Mesh;
  light: THREE.PointLight;
  plugTip: THREE.Mesh;
  plugMat: THREE.MeshBasicMaterial;
  header: THREE.Mesh;
  headerMat: THREE.MeshStandardMaterial;
  liner: THREE.Mesh;
  deckY: number;
  pinToTop: number;
}

const COL = {
  steel: 0x8e979f,
  forged: 0x6f7880,
  alu: 0xc3c8cc,
  valve: 0xb4aca2,
  spring: 0x2f5d8c,
  cam: 0x868c92,
  block: 0x9aa7b1,
  fresh: new THREE.Color(0x3d7bea),
  smoke: new THREE.Color(0x7b736c),
  flame: new THREE.Color(0xffb22e),
  flameHot: new THREE.Color(0xff5a1f),
  knock: new THREE.Color(0xfff3e0),
};

function mat(color: number, metal = 1, rough = 0.38) {
  return new THREE.MeshStandardMaterial({ color, metalness: metal, roughness: rough });
}

// fresh charge blue, burnt gas grey, flame on top. shared by piston and rotary
function gasLook(c: CylState, out: THREE.MeshBasicMaterial) {
  const fresh = c.m > 0 ? c.mAir / c.m : 0;
  const col = COL.smoke.clone().lerp(COL.fresh, Math.min(1, fresh * 1.05));
  const hot = Math.min(1, Math.max(0, (c.T - 700) / 1700));
  if (hot > 0) col.lerp(COL.flame.clone().lerp(COL.flameHot, hot), Math.min(1, hot * 1.4));
  if (c.knockFlash > 0) col.lerp(COL.knock, Math.min(1, c.knockFlash * 8));
  out.color.copy(col);
  out.opacity = 0.28 + hot * 0.5 + (c.knockFlash > 0 ? 0.2 : 0);
  return hot;
}

interface RotorMeshes {
  group: THREE.Group;
  rotor: THREE.Group;
  lobe: THREE.Mesh;
  chambers: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; pos: THREE.BufferAttribute }[];
  plugs: THREE.Group;
  plugMats: THREE.MeshBasicMaterial[];
  intake: THREE.Group;
  exhaust: THREE.Mesh;
  exhaustMat: THREE.MeshStandardMaterial;
  light: THREE.PointLight;
  faces: number[]; // sim cylinder index for flank 0, 1, 2
  phase: number;
}

const FLANK_N = 20;

export class EngineView {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  root = new THREE.Group();
  crank = new THREE.Group();
  flywheel = new THREE.Group();
  cyls: CylMeshes[] = [];
  rotors: RotorMeshes[] = [];
  shaft = new THREE.Group();
  private R = 1;
  private ecc = 0.15;
  blockMats: THREE.Material[] = [];
  pickables: THREE.Object3D[] = [];
  selected: PartHit | null = null;
  hovered: PartHit | null = null;
  private highlightSaved = new Map<THREE.MeshStandardMaterial, number>();
  private raycaster = new THREE.Raycaster();
  private floor: THREE.Mesh;
  blockMode: 'ghost' | 'hidden' | 'solid' = 'ghost';
  radius = 6;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 400);
    this.camera.position.set(9, 6, 14);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 2;
    this.controls.maxDistance = 60;
    this.controls.maxPolarAngle = Math.PI * 0.92;

    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(6, 14, 8);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -12;
    key.shadow.camera.right = 12;
    key.shadow.camera.top = 12;
    key.shadow.camera.bottom = -12;
    key.shadow.bias = -0.0004;
    key.shadow.radius = 6;
    this.scene.add(key);
    this.scene.add(new THREE.HemisphereLight(0xe8eef2, 0x8a9096, 0.55));

    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.ShadowMaterial({ opacity: 0.16 }));
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);

    this.scene.add(this.root);
  }

  resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private tag(o: THREE.Object3D, hit: PartHit) {
    o.traverse((c) => {
      c.userData.hit = hit;
      if ((c as THREE.Mesh).isMesh) {
        c.castShadow = true;
        c.receiveShadow = true;
      }
    });
    this.pickables.push(o);
  }

  build(e: Engine) {
    // tear down
    this.root.clear();
    this.root.position.set(0, 0, 0);
    this.crank = new THREE.Group();
    this.flywheel = new THREE.Group();
    this.shaft = new THREE.Group();
    this.cyls = [];
    this.rotors = [];
    this.pickables = [];
    this.blockMats = [];
    this.selected = null;
    this.highlightSaved.clear();
    if (e.kind === 'rotary') this.buildRotary(e);
    else this.buildPiston(e);
    this.finish();
  }

  private makeFlywheel(fwR: number, B: number, x: number) {
    const fw = new THREE.Mesh(new THREE.CylinderGeometry(fwR, fwR, 0.22 * B, 64).rotateZ(Math.PI / 2), mat(0x50575d, 1, 0.42));
    this.flywheel.add(fw);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(fwR, 0.05 * B, 8, 96).rotateY(Math.PI / 2), mat(0x3c4247, 1, 0.5));
    this.flywheel.add(ring);
    const mark = new THREE.Mesh(new THREE.BoxGeometry(0.24 * B, 0.08 * B, 0.3 * B), new THREE.MeshBasicMaterial({ color: 0xd62828 }));
    mark.position.set(0.01, fwR * 0.86, 0);
    this.flywheel.add(mark);
    for (let k = 1; k < 8; k++) {
      const tick = new THREE.Mesh(new THREE.BoxGeometry(0.235 * B, 0.025 * B, 0.12 * B), new THREE.MeshBasicMaterial({ color: 0xe9ecee }));
      const a = (k / 8) * Math.PI * 2;
      tick.position.set(0.01, Math.cos(a) * fwR * 0.88, Math.sin(a) * fwR * 0.88);
      tick.rotation.x = a;
      this.flywheel.add(tick);
    }
    this.flywheel.position.x = x;
    this.root.add(this.flywheel);
    this.tag(this.flywheel, { kind: 'flywheel', cyl: -1 });
  }

  // housing bore: x = e cos 3t + R cos t, y = e sin 3t + R sin t
  private housing(t: number, grow = 0) {
    const R = this.R + grow;
    return new THREE.Vector2(this.ecc * Math.cos(3 * t) + R * Math.cos(t), this.ecc * Math.sin(3 * t) + R * Math.sin(t));
  }

  // rotor flank i in the rotor's own frame, s from apex i to apex i+1
  private flank(i: number, s: number) {
    const R = this.R;
    const a0 = (i * 2 * Math.PI) / 3;
    const a1 = a0 + (2 * Math.PI) / 3;
    const am = a0 + Math.PI / 3;
    const x = R * (Math.cos(a0) * (1 - s) + Math.cos(a1) * s) + Math.cos(am) * 0.16 * R * Math.sin(Math.PI * s);
    const y = R * (Math.sin(a0) * (1 - s) + Math.sin(a1) * s) + Math.sin(am) * 0.16 * R * Math.sin(Math.PI * s);
    return new THREE.Vector2(x, y);
  }

  private buildRotary(e: Engine) {
    const R = e.rotR * S;
    const ec = e.rotE * S;
    const b = e.rotB * S;
    this.R = R;
    this.ecc = ec;
    const lay = e.layout;
    const pitch = b * 1.55;
    const xs = lay.rotors!.map((r) => (r.x / 1.1) * pitch);

    // e-shaft runs through everything
    this.root.add(this.shaft);
    const xMin = Math.min(...xs) - pitch * 0.9;
    const xMax = Math.max(...xs) + pitch * 0.6;
    const main = new THREE.Mesh(new THREE.CylinderGeometry(ec * 1.25, ec * 1.25, xMax - xMin, 24).rotateZ(Math.PI / 2), mat(COL.steel, 1, 0.22));
    main.position.x = (xMin + xMax) / 2;
    this.shaft.add(main);
    const pulley = new THREE.Mesh(new THREE.CylinderGeometry(ec * 3, ec * 3, b * 0.25, 32).rotateZ(Math.PI / 2), mat(0x5d6368, 1, 0.45));
    pulley.position.x = xMax - b * 0.15;
    this.shaft.add(pulley);
    this.tag(this.shaft, { kind: 'crank', cyl: -1 });

    const housingPts: THREE.Vector2[] = [];
    for (let k = 0; k < 120; k++) housingPts.push(this.housing((k / 120) * Math.PI * 2, 0.06));

    lay.rotors!.forEach((rot, ri) => {
      const g = new THREE.Group();
      g.position.x = xs[ri];
      g.rotation.y = Math.PI / 2; // local xy is the rotor plane, local z runs along the shaft
      this.root.add(g);

      // housing, see-through
      const outer = new THREE.Shape();
      for (let k = 0; k <= 120; k++) {
        const t = (k / 120) * Math.PI * 2;
        const p = this.housing(t, R * 0.32);
        if (k === 0) outer.moveTo(p.x * 1.02, p.y);
        else outer.lineTo(p.x * 1.02, p.y);
      }
      outer.holes.push(new THREE.Path(housingPts));
      const hg = new THREE.ExtrudeGeometry(outer, { depth: b, bevelEnabled: false, curveSegments: 4 });
      hg.translate(0, 0, -b / 2);
      const hMat = new THREE.MeshStandardMaterial({ color: COL.block, metalness: 0.4, roughness: 0.5, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide });
      const housingMesh = new THREE.Mesh(hg, hMat);
      housingMesh.renderOrder = 3;
      g.add(housingMesh);
      this.blockMats.push(hMat);

      // side plate behind it, so the chambers read against something
      const plateMat = new THREE.MeshStandardMaterial({ color: 0xb9c3cb, metalness: 0.3, roughness: 0.6, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide });
      const plate = new THREE.Mesh(new THREE.ShapeGeometry(outer), plateMat);
      plate.position.z = -b / 2 - 0.01;
      g.add(plate);
      this.blockMats.push(plateMat);

      // stationary gear on the side housing
      const sg = new THREE.Mesh(new THREE.CylinderGeometry(2 * ec, 2 * ec, b * 0.14, 36).rotateX(Math.PI / 2), mat(0x7b828a, 1, 0.35));
      sg.position.z = b * 0.43;
      g.add(sg);

      // rotor: three flanks, internal ring gear, bearing bore
      const rotorG = new THREE.Group();
      const shape = new THREE.Shape();
      for (let i = 0; i < 3; i++)
        for (let k = 0; k < FLANK_N; k++) {
          const p = this.flank(i, k / FLANK_N);
          if (i === 0 && k === 0) shape.moveTo(p.x, p.y);
          else shape.lineTo(p.x, p.y);
        }
      const bore = new THREE.Path();
      bore.absarc(0, 0, 3 * ec * 1.06, 0, Math.PI * 2, true);
      shape.holes.push(bore);
      const rg = new THREE.ExtrudeGeometry(shape, { depth: b * 0.94, bevelEnabled: false, curveSegments: 24 });
      rg.translate(0, 0, -b * 0.47);
      rotorG.add(new THREE.Mesh(rg, mat(0x9aa1a8, 0.9, 0.34)));
      const ringGear = new THREE.Mesh(new THREE.TorusGeometry(3 * ec, ec * 0.18, 8, 64), mat(0x5b6168, 1, 0.4));
      ringGear.position.z = b * 0.43;
      rotorG.add(ringGear);
      // apex seals
      for (let i = 0; i < 3; i++) {
        const a = (i * 2 * Math.PI) / 3;
        const seal = new THREE.Mesh(new THREE.BoxGeometry(R * 0.05, R * 0.05, b * 0.96), new THREE.MeshStandardMaterial({ color: 0x2b3036, metalness: 0.8, roughness: 0.3 }));
        seal.position.set(Math.cos(a) * R * 0.985, Math.sin(a) * R * 0.985, 0);
        seal.rotation.z = a;
        rotorG.add(seal);
      }
      g.add(rotorG);
      this.tag(rotorG, { kind: 'rotor', cyl: ri * 3 });

      // e-shaft lobe the rotor rides on
      const lobe = new THREE.Mesh(new THREE.CylinderGeometry(2.6 * ec, 2.6 * ec, b * 0.9, 36).rotateX(Math.PI / 2), mat(COL.steel, 1, 0.25));
      g.add(lobe);
      lobe.userData.hit = { kind: 'crank', cyl: -1 };
      lobe.castShadow = true;
      this.pickables.push(lobe);

      // the three working chambers between flanks and housing
      const chambers: RotorMeshes['chambers'] = [];
      for (let i = 0; i < 3; i++) {
        const geo = new THREE.BufferGeometry();
        const pos = new THREE.BufferAttribute(new Float32Array((FLANK_N + 1) * 4 * 3), 3);
        geo.setAttribute('position', pos);
        const idx: number[] = [];
        const row = FLANK_N + 1;
        for (const side of [0, 2]) {
          for (let k = 0; k < FLANK_N; k++) {
            const h0 = side * row + k;
            const f0 = (side + 1) * row + k;
            idx.push(h0, f0, h0 + 1, h0 + 1, f0, f0 + 1);
          }
        }
        geo.setIndex(idx);
        const cm = new THREE.MeshBasicMaterial({ color: COL.fresh, transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide });
        const mesh = new THREE.Mesh(geo, cm);
        mesh.frustumCulled = false;
        mesh.renderOrder = 1;
        g.add(mesh);
        chambers.push({ mesh, mat: cm, pos });
      }

      // twin plugs on the bottom minor axis, leading and trailing
      const plugs = new THREE.Group();
      const plugMats: THREE.MeshBasicMaterial[] = [];
      for (const off of [-0.2, 0.2]) {
        const t = (3 * Math.PI) / 2 + off;
        const p = this.housing(t, R * 0.05);
        const plug = new THREE.Group();
        const ins = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.035, R * 0.035, R * 0.45, 12), new THREE.MeshStandardMaterial({ color: 0xf2f0ea, roughness: 0.25, metalness: 0 }));
        ins.position.y = -R * 0.3;
        plug.add(ins);
        const pm = new THREE.MeshBasicMaterial({ color: 0x5a6064 });
        const tip = new THREE.Mesh(new THREE.SphereGeometry(R * 0.035, 10, 8), pm);
        plug.add(tip);
        plug.position.set(p.x, p.y, 0);
        plug.rotation.z = t + Math.PI / 2;
        plugs.add(plug);
        plugMats.push(pm);
      }
      g.add(plugs);
      this.tag(plugs, { kind: 'plug', cyl: ri * 3 });

      const light = new THREE.PointLight(0xffa040, 0, 3 * R, 1.6);
      light.position.set(0, -R * 0.75, 0);
      g.add(light);

      // side intake port and runner, up and to the left of top dead centre
      const intake = new THREE.Group();
      const ip = this.housing(Math.PI * 0.72, -R * 0.28);
      const runnerPts = [new THREE.Vector3(ip.x, ip.y, b * 0.5), new THREE.Vector3(ip.x, ip.y, b * 0.9), new THREE.Vector3(ip.x * 1.4, ip.y + R * 0.6, b * 1.1), new THREE.Vector3(ip.x * 1.5, ip.y + R * 1.3, b * 1.1)];
      const runner = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(runnerPts), 24, R * 0.13, 12, false), new THREE.MeshStandardMaterial({ color: 0x8d969d, metalness: 0.6, roughness: 0.5, transparent: true, opacity: 0.6 }));
      intake.add(runner);
      const portFace = new THREE.Mesh(new THREE.CircleGeometry(R * 0.14, 24), new THREE.MeshBasicMaterial({ color: 0x3d7bea, transparent: true, opacity: 0.5, side: THREE.DoubleSide }));
      portFace.position.set(ip.x, ip.y, b * 0.505);
      intake.add(portFace);
      g.add(intake);
      this.tag(intake, { kind: 'intake-valve', cyl: ri * 3 });

      // exhaust port, right of top, glows with EGT
      const t0 = Math.PI * 0.22;
      const p0 = this.housing(t0, 0.02);
      const dir = new THREE.Vector2(Math.cos(t0), Math.sin(t0));
      const exPts = [
        new THREE.Vector3(p0.x, p0.y, 0),
        new THREE.Vector3(p0.x + dir.x * R * 0.6, p0.y + dir.y * R * 0.6, 0),
        new THREE.Vector3(p0.x + dir.x * R * 1.1, p0.y + dir.y * R * 0.3, 0),
        new THREE.Vector3(p0.x + dir.x * R * 1.2, p0.y - R * 0.8, 0),
      ];
      const exMat = new THREE.MeshStandardMaterial({ color: 0x4f4a45, metalness: 0.8, roughness: 0.5, emissive: 0x000000 });
      const exhaust = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(exPts), 32, R * 0.14, 14, false), exMat);
      g.add(exhaust);
      this.tag(exhaust, { kind: 'exhaust-valve', cyl: ri * 3 });

      const faces = [0, 1, 2].map((f) => lay.cyls.findIndex((c) => c.rotor === ri && c.face === f));
      this.rotors.push({ group: g, rotor: rotorG, lobe, chambers, plugs, plugMats, intake, exhaust, exhaustMat: exMat, light, faces, phase: rot.phase });
    });

    // flywheel on the far end so the 3/4 view looks into the rotors
    this.makeFlywheel(R * 1.2, b, xMin - b * 0.1);
  }

  private updateRotary(e: Engine) {
    const th = e.theta * DEG;
    this.shaft.rotation.x = th;
    this.flywheel.rotation.x = th;
    const ec = this.ecc;
    const b = e.rotB * S;
    for (const rm of this.rotors) {
      const tr = th + rm.phase * DEG;
      const rho = tr / 3;
      const cx = ec * Math.cos(tr);
      const cy = ec * Math.sin(tr);
      rm.rotor.position.set(cx, cy, 0);
      rm.rotor.rotation.z = rho;
      rm.lobe.position.set(cx, cy, 0);
      const cr = Math.cos(rho);
      const sr = Math.sin(rho);
      let spark = false;
      let hotMax = 0;
      let egt = 0;
      for (let i = 0; i < 3; i++) {
        const ch = rm.chambers[i];
        const arr = ch.pos.array as Float32Array;
        const row = FLANK_N + 1;
        for (let k = 0; k <= FLANK_N; k++) {
          const s = k / FLANK_N;
          const h = this.housing(rho + ((i + s) * 2 * Math.PI) / 3);
          const f = this.flank(i, s);
          const fx = cx + f.x * cr - f.y * sr;
          const fy = cy + f.x * sr + f.y * cr;
          for (const [side, z] of [[0, b * 0.46], [2, -b * 0.46]] as const) {
            let o = (side * row + k) * 3;
            arr[o] = h.x;
            arr[o + 1] = h.y;
            arr[o + 2] = z;
            o = ((side + 1) * row + k) * 3;
            arr[o] = fx;
            arr[o + 1] = fy;
            arr[o + 2] = z;
          }
        }
        ch.pos.needsUpdate = true;
        const c = e.cyls[rm.faces[i]];
        if (!c) continue;
        hotMax = Math.max(hotMax, gasLook(c, ch.mat));
        if (c.sparkFlash > 0) spark = true;
        egt = Math.max(egt, c.egt);
        ch.mesh.visible = !(c.dead && e.failure?.kind === 'piston');
      }
      rm.plugMats.forEach((m) => m.color.setHex(spark ? 0xbfe3ff : 0x5a6064));
      rm.light.intensity = hotMax * 5;
      const glow = Math.min(1, Math.max(0, (egt - 273 - 520) / 380)) * (e.rpm > 200 ? 1 : 0);
      rm.exhaustMat.emissive.setRGB(glow * 0.75, glow * 0.12, glow * 0.02);
    }
  }

  private buildPiston(e: Engine) {
    const B = e.B * S;
    const r = e.r * S;
    const l = e.l * S;
    const lay = e.layout;
    const span = B; // spacing unit for x positions

    // crank
    this.root.add(this.crank);
    const mainR = Math.max(0.27 * B, r * 0.55);
    const pinR = Math.max(0.22 * B, r * 0.45);
    for (let i = 0; i < lay.mains.length; i++) {
      const x = lay.mains[i] * span;
      const g = new THREE.CylinderGeometry(mainR, mainR, 0.3 * B, 28);
      g.rotateZ(Math.PI / 2);
      const m = new THREE.Mesh(g, mat(COL.steel, 1, 0.22));
      m.position.x = x;
      this.crank.add(m);
    }
    lay.pins.forEach((pin) => {
      const throwG = new THREE.Group();
      throwG.rotation.x = pin.angle * DEG;
      const w = pin.width * 0.5 * B;
      const pg = new THREE.CylinderGeometry(pinR, pinR, w + 0.02, 24);
      pg.rotateZ(Math.PI / 2);
      const pm = new THREE.Mesh(pg, mat(COL.steel, 1, 0.22));
      pm.position.set(pin.x * span, r, 0);
      throwG.add(pm);
      for (const side of [-1, 1]) {
        const webT = 0.13 * B;
        const wx = pin.x * span + side * (w / 2 + webT / 2);
        // web from main to pin
        const web = new THREE.Mesh(new THREE.BoxGeometry(webT, r + pinR * 1.6, pinR * 2.3), mat(COL.forged, 1, 0.5));
        web.position.set(wx, r / 2, 0);
        throwG.add(web);
        // counterweight, opposite the pin
        const cwR = r * 1.25 + mainR;
        const cg = new THREE.CylinderGeometry(cwR, cwR, webT, 32, 1, false, Math.PI * 0.2, Math.PI * 0.6);
        cg.rotateZ(Math.PI / 2);
        cg.rotateX(Math.PI);
        const cw = new THREE.Mesh(cg, mat(COL.forged, 1, 0.5));
        cw.position.set(wx, 0, 0);
        throwG.add(cw);
      }
      this.crank.add(throwG);
    });
    const xFront = lay.mains[0] * span;
    const xRear = lay.mains[lay.mains.length - 1] * span;
    // snout and timing gear
    const snout = new THREE.Mesh(new THREE.CylinderGeometry(mainR * 0.7, mainR * 0.7, 0.7 * B, 20).rotateZ(Math.PI / 2), mat(COL.steel, 1, 0.3));
    snout.position.x = xFront - 0.45 * B;
    this.crank.add(snout);
    const gear = new THREE.Mesh(new THREE.CylinderGeometry(mainR * 1.3, mainR * 1.3, 0.18 * B, 28).rotateZ(Math.PI / 2), mat(0x5d6368, 1, 0.45));
    gear.position.x = xFront - 0.5 * B;
    this.crank.add(gear);
    this.tag(this.crank, { kind: 'crank', cyl: -1 });

    // flywheel with a timing mark, spins with the crank
    this.makeFlywheel(r * 2.6 + B * 0.5, B, xRear + 0.35 * B);

    // cylinders
    const ch = 0.42 * B; // wrist pin to crown
    const clearance = (e.Vc / e.A) * S;
    let maxTop = 0;
    lay.cyls.forEach((cd, i) => {
      const group = new THREE.Group();
      group.position.x = cd.x * span;
      group.rotation.x = cd.bank * DEG;
      this.root.add(group);

      const deckY = r + l + ch + clearance;
      maxTop = Math.max(maxTop, deckY + 2 * B);

      // liner
      const linerLen = deckY - (l - r) + 0.1 * B;
      const linerMat = new THREE.MeshStandardMaterial({ color: 0xdfe6ea, metalness: 0.1, roughness: 0.15, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false });
      const liner = new THREE.Mesh(new THREE.CylinderGeometry(B / 2 + 0.03, B / 2 + 0.03, linerLen, 40, 1, true), linerMat);
      liner.position.y = deckY - linerLen / 2;
      liner.renderOrder = 2;
      group.add(liner);
      this.blockMats.push(linerMat);

      // piston
      const piston = new THREE.Group();
      const crownH = 0.18 * B;
      const skirt = new THREE.Mesh(new THREE.CylinderGeometry(B / 2 - 0.01, B / 2 - 0.02, ch + 0.25 * B, 40), mat(COL.alu, 0.9, 0.32));
      skirt.position.y = (ch + 0.25 * B) / 2 - 0.25 * B;
      piston.add(skirt);
      for (let k = 0; k < 3; k++) {
        const ringM = new THREE.Mesh(new THREE.TorusGeometry(B / 2 - 0.012, 0.012, 6, 48).rotateX(Math.PI / 2), mat(0x3a3f44, 1, 0.5));
        ringM.position.y = ch - crownH * 0.45 - k * 0.07 * B;
        piston.add(ringM);
      }
      const wrist = new THREE.Mesh(new THREE.CylinderGeometry(0.11 * B, 0.11 * B, B * 0.96, 16).rotateZ(Math.PI / 2), mat(COL.steel, 1, 0.2));
      piston.add(wrist);
      group.add(piston);
      this.tag(piston, { kind: 'piston', cyl: i });

      // rod: built along +y, big end at the origin
      const rod = new THREE.Group();
      const beam = new THREE.Mesh(new THREE.BoxGeometry(0.12 * B, l, 0.22 * B), mat(COL.forged, 1, 0.42));
      beam.position.y = l / 2;
      rod.add(beam);
      const big = new THREE.Mesh(new THREE.CylinderGeometry(pinR * 1.45, pinR * 1.45, 0.2 * B, 24).rotateZ(Math.PI / 2), mat(COL.forged, 1, 0.42));
      rod.add(big);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(0.2 * B, 0.12 * B, pinR * 3.6), mat(COL.forged, 1, 0.42));
      cap.position.y = -pinR * 1.2;
      rod.add(cap);
      const small = new THREE.Mesh(new THREE.CylinderGeometry(0.16 * B, 0.16 * B, 0.2 * B, 20).rotateZ(Math.PI / 2), mat(COL.forged, 1, 0.42));
      small.position.y = l;
      rod.add(small);
      group.add(rod);
      this.tag(rod, { kind: 'rod', cyl: i });

      // gas column between crown and deck
      const gasMat = new THREE.MeshBasicMaterial({ color: COL.fresh, transparent: true, opacity: 0.4, depthWrite: false });
      const gas = new THREE.Mesh(new THREE.CylinderGeometry(B / 2 - 0.02, B / 2 - 0.02, 1, 36), gasMat);
      gas.renderOrder = 1;
      group.add(gas);

      // head: valves, springs, cams
      const valveSide = cd.bank > 0 ? -1 : cd.bank < 0 ? 1 : -1; // intake toward the valley
      const vz = 0.24 * B;
      const mkValve = (d: number) => {
        const v = new THREE.Group();
        const headM = new THREE.Mesh(new THREE.CylinderGeometry(d / 2, d / 2 * 0.55, 0.06 * B, 28), mat(COL.valve, 0.9, 0.35));
        headM.position.y = 0.03 * B;
        v.add(headM);
        const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.035 * B, 0.035 * B, 1.05 * B, 10), mat(COL.valve, 0.9, 0.35));
        stem.position.y = 0.55 * B;
        v.add(stem);
        const ret = new THREE.Mesh(new THREE.CylinderGeometry(0.11 * B, 0.08 * B, 0.05 * B, 16), mat(COL.steel, 1, 0.3));
        ret.position.y = 1.0 * B;
        v.add(ret);
        return v;
      };
      const inValve = mkValve(e.dIn * S * 0.7);
      inValve.position.set(0, deckY, valveSide * vz);
      group.add(inValve);
      this.tag(inValve, { kind: 'intake-valve', cyl: i });
      const exValve = mkValve(e.dEx * S * 0.7);
      exValve.position.set(0, deckY, -valveSide * vz);
      group.add(exValve);
      this.tag(exValve, { kind: 'exhaust-valve', cyl: i });

      const mkSpring = () => {
        const pts: THREE.Vector3[] = [];
        const turns = 6;
        const rad = 0.095 * B;
        for (let k = 0; k <= turns * 24; k++) {
          const a = (k / 24) * Math.PI * 2;
          pts.push(new THREE.Vector3(Math.cos(a) * rad, k / (turns * 24), Math.sin(a) * rad));
        }
        const curve = new THREE.CatmullRomCurve3(pts);
        const m = new THREE.Mesh(new THREE.TubeGeometry(curve, turns * 24, 0.016 * B, 6, false), mat(COL.spring, 0.6, 0.45));
        return m;
      };
      const springBase = deckY + 0.42 * B;
      const inSpring = mkSpring();
      inSpring.position.set(0, springBase, valveSide * vz);
      group.add(inSpring);
      const exSpring = mkSpring();
      exSpring.position.set(0, springBase, -valveSide * vz);
      group.add(exSpring);

      // cam lobes ride the valve tips
      const camY = deckY + 1.0 * B + 0.05 * B;
      const mkLobe = (dur: number, liftMm: number) => {
        const rb = 0.17 * B;
        const lift = (liftMm / 1000) * S;
        const shape = new THREE.Shape();
        const half = (dur / 4) * DEG; // cam degrees
        for (let k = 0; k <= 96; k++) {
          const a = (k / 96) * Math.PI * 2;
          const d = Math.abs(((a + Math.PI) % (Math.PI * 2)) - Math.PI);
          const bump = d < half ? 0.5 * (1 + Math.cos((Math.PI * d) / half)) : 0;
          const rr = rb + lift * bump;
          const px = Math.sin(a) * rr;
          const py = Math.cos(a) * rr;
          if (k === 0) shape.moveTo(px, py);
          else shape.lineTo(px, py);
        }
        const g = new THREE.ExtrudeGeometry(shape, { depth: 0.16 * B, bevelEnabled: false, curveSegments: 4 });
        g.translate(0, 0, -0.08 * B);
        g.rotateY(Math.PI / 2);
        return new THREE.Mesh(g, mat(COL.cam, 1, 0.3));
      };
      const inLobe = mkLobe(e.tune.inDuration, e.tune.inLift);
      inLobe.position.set(0, camY + 0.17 * B, valveSide * vz);
      group.add(inLobe);
      this.tag(inLobe, { kind: 'cam', cyl: i });
      const exLobe = mkLobe(e.tune.exDuration, e.tune.exLift);
      exLobe.position.set(0, camY + 0.17 * B, -valveSide * vz);
      group.add(exLobe);
      this.tag(exLobe, { kind: 'cam', cyl: i });

      // spark plug
      const plug = new THREE.Group();
      const ins = new THREE.Mesh(new THREE.CylinderGeometry(0.05 * B, 0.05 * B, 0.7 * B, 12), new THREE.MeshStandardMaterial({ color: 0xf2f0ea, roughness: 0.25, metalness: 0 }));
      ins.position.y = 0.4 * B;
      plug.add(ins);
      const hex = new THREE.Mesh(new THREE.CylinderGeometry(0.085 * B, 0.085 * B, 0.12 * B, 6), mat(0xa9adb0, 1, 0.3));
      hex.position.y = 0.1 * B;
      plug.add(hex);
      const plugMat = new THREE.MeshBasicMaterial({ color: 0x5a6064 });
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.045 * B, 12, 8), plugMat);
      tip.position.y = -0.03 * B;
      plug.add(tip);
      plug.position.set(0, deckY, 0);
      group.add(plug);
      this.tag(plug, { kind: 'plug', cyl: i });

      const light = new THREE.PointLight(0xffa040, 0, 4 * B, 1.6);
      light.position.set(0, deckY - 0.2 * B, 0);
      group.add(light);

      // head casting, see-through
      const headMat = new THREE.MeshStandardMaterial({ color: COL.block, metalness: 0.4, roughness: 0.5, transparent: true, opacity: 0.14, depthWrite: false });
      const head = new THREE.Mesh(new THREE.BoxGeometry(cd.bank === 0 ? 1.25 * B : 1.15 * B, 0.42 * B, 1.1 * B), headMat);
      head.position.y = deckY + 0.21 * B;
      head.renderOrder = 3;
      group.add(head);
      this.blockMats.push(headMat);

      // exhaust header, glows with EGT
      const exSide = -valveSide;
      const p0 = new THREE.Vector3(0, deckY + 0.2 * B, exSide * 0.55 * B);
      const p1 = new THREE.Vector3(0, deckY + 0.1 * B, exSide * 1.0 * B);
      const p2 = new THREE.Vector3(0, deckY - 0.6 * B, exSide * 1.25 * B);
      const p3 = new THREE.Vector3(0, deckY - 1.6 * B, exSide * 1.3 * B);
      const headerMat = new THREE.MeshStandardMaterial({ color: 0x4f4a45, metalness: 0.8, roughness: 0.5, emissive: 0x000000 });
      const header = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([p0, p1, p2, p3]), 32, 0.16 * B, 14, false), headerMat);
      header.castShadow = true;
      group.add(header);

      // intake runner
      const q0 = new THREE.Vector3(0, deckY + 0.2 * B, valveSide * 0.55 * B);
      const q1 = new THREE.Vector3(0, deckY + 0.5 * B, valveSide * 1.0 * B);
      const q2 = new THREE.Vector3(0, deckY + 1.3 * B, valveSide * 1.05 * B);
      const runner = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([q0, q1, q2]), 24, 0.15 * B, 12, false), new THREE.MeshStandardMaterial({ color: 0x8d969d, metalness: 0.6, roughness: 0.5, transparent: true, opacity: 0.55 }));
      group.add(runner);

      this.cyls.push({ group, piston, rod, gas, gasMat, inValve, exValve, inSpring, exSpring, inLobe, exLobe, light, plugTip: tip, plugMat, header, headerMat, liner, deckY, pinToTop: ch });
    });

    // crankcase, translucent
    const ccMat = new THREE.MeshStandardMaterial({ color: COL.block, metalness: 0.35, roughness: 0.55, transparent: true, opacity: 0.1, depthWrite: false });
    const ccLen = xRear - xFront + 0.3 * B;
    const ccH = r * 2.4 + mainR * 2;
    const cc = new THREE.Mesh(new THREE.BoxGeometry(ccLen, ccH, r * 3.4 + B), ccMat);
    cc.position.set((xFront + xRear) / 2, -ccH * 0.12, 0);
    cc.renderOrder = 3;
    this.root.add(cc);
    this.blockMats.push(ccMat);
    void maxTop;
  }

  private finish() {
    // set it on the floor and frame it
    const box = new THREE.Box3().setFromObject(this.root);
    const lowest = box.min.y;
    this.root.position.y = -lowest + 0.05;
    this.floor.position.y = 0;
    const size = box.getSize(new THREE.Vector3());
    this.radius = Math.max(size.x, size.y, size.z);
    this.controls.target.set(0, size.y * 0.44, 0);
    this.setBlockMode(this.blockMode);
  }

  frame(view: 'iso' | 'front' | 'side' | 'top' = 'iso') {
    // pull back on tall narrow screens so the whole engine fits
    const d = this.radius * 1.95 * Math.max(1, 1.3 / Math.max(this.camera.aspect, 0.3));
    const t = this.controls.target;
    const pos = {
      iso: new THREE.Vector3(d * 0.55, d * 0.42, d * 0.78),
      front: new THREE.Vector3(-d, d * 0.1, 0.0001),
      side: new THREE.Vector3(0.0001, d * 0.12, d),
      top: new THREE.Vector3(0.0001, d * 1.05, 0.01),
    }[view];
    this.camera.position.copy(t).add(pos);
    this.controls.update();
  }

  setBlockMode(m: 'ghost' | 'hidden' | 'solid') {
    this.blockMode = m;
    for (const bm of this.blockMats) {
      const s = bm as THREE.MeshStandardMaterial;
      if (s.userData.base === undefined) s.userData.base = s.opacity;
      s.visible = m !== 'hidden';
      s.opacity = m === 'solid' ? Math.min(0.75, s.userData.base * 4) : s.userData.base;
    }
  }

  pick(clientX: number, clientY: number): PartHit | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.pickables, true);
    for (const h of hits) {
      const hit = h.object.userData.hit as PartHit | undefined;
      if (hit) return hit;
    }
    return null;
  }

  private objectsFor(hit: PartHit): THREE.Object3D[] {
    if (this.rotors.length) {
      const rm = this.rotors[Math.max(0, Math.floor(hit.cyl / 3))];
      if (hit.kind === 'crank') return [this.shaft, ...this.rotors.map((r) => r.lobe)];
      if (hit.kind === 'flywheel') return [this.flywheel];
      if (!rm) return [];
      if (hit.kind === 'rotor') return [rm.rotor];
      if (hit.kind === 'plug') return [rm.plugs];
      if (hit.kind === 'intake-valve') return [rm.intake];
      if (hit.kind === 'exhaust-valve') return [rm.exhaust];
      return [];
    }
    if (hit.kind === 'crank') return [this.crank];
    if (hit.kind === 'flywheel') return [this.flywheel];
    const c = this.cyls[hit.cyl];
    if (!c) return [];
    switch (hit.kind) {
      case 'piston':
        return [c.piston];
      case 'rod':
        return [c.rod];
      case 'intake-valve':
        return [c.inValve, c.inSpring];
      case 'exhaust-valve':
        return [c.exValve, c.exSpring];
      case 'cam':
        return [c.inLobe, c.exLobe];
      case 'plug':
        return [c.plugTip.parent!];
      default:
        return [];
    }
  }

  setHighlight(hit: PartHit | null) {
    for (const [m, hex] of this.highlightSaved) m.emissive.setHex(hex);
    this.highlightSaved.clear();
    this.selected = hit;
    if (!hit) return;
    for (const o of this.objectsFor(hit)) {
      o.traverse((c) => {
        const m = (c as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (m && (m as THREE.MeshStandardMaterial).isMeshStandardMaterial && !this.highlightSaved.has(m)) {
          this.highlightSaved.set(m, m.emissive.getHex());
          m.emissive.setHex(0x2a5fae);
        }
      });
    }
  }

  update(e: Engine) {
    if (this.rotors.length) return this.updateRotary(e);
    const r = e.r * S;
    const l = e.l * S;
    const th = e.theta * DEG;
    this.crank.rotation.x = th;
    this.flywheel.rotation.x = th;
    const fl = e.failure;

    e.cyls.forEach((c: CylState, i) => {
      const m = this.cyls[i];
      if (!m) return;
      const psi = c.psi * DEG;
      const sp = Math.sin(psi);
      const cp = Math.cos(psi);
      const s = r * cp + Math.sqrt(l * l - r * r * sp * sp);
      const brokenRod = fl?.kind === 'rod' && fl.cyl === i;
      if (brokenRod) {
        m.piston.position.y = r + l - 0.2;
        m.rod.position.set(0, r * cp - 0.4, r * sp + 0.3);
        m.rod.rotation.x = 0.9;
      } else {
        m.piston.position.y = s;
        m.rod.position.set(0, r * cp, r * sp);
        m.rod.rotation.x = Math.atan2(-r * sp, s - r * cp);
      }

      const crown = m.piston.position.y + m.pinToTop;
      const gasH = Math.max(0.01, m.deckY - crown);
      m.gas.scale.y = gasH;
      m.gas.position.y = crown + gasH / 2;

      const hot = gasLook(c, m.gasMat);

      m.light.intensity = c.burning ? 6 * hot + 2 : c.knockFlash > 0 ? 8 : hot * 3;
      m.light.color.copy(c.knockFlash > 0 ? COL.knock : COL.flame);
      m.plugMat.color.setHex(c.sparkFlash > 0 ? 0xbfe3ff : 0x5a6064);
      m.plugTip.scale.setScalar(c.sparkFlash > 0 ? 2.2 : 1);

      const li = (c.inLift / 1000) * S;
      const le = (c.exLift / 1000) * S;
      m.inValve.position.y = m.deckY - li;
      m.exValve.position.y = m.deckY - le;
      // spring sits on the head, retainer comes down with the valve
      const springLen = 0.58 * e.B * S;
      m.inSpring.scale.y = springLen - li;
      m.exSpring.scale.y = springLen - le;

      // cam lobe: nose straight down at peak lift
      const inC = e.tune.inCenterline;
      const exC = 720 - e.tune.exCenterline;
      m.inLobe.rotation.x = Math.PI + ((c.cycle - inC) / 2) * DEG;
      m.exLobe.rotation.x = Math.PI + ((c.cycle - exC) / 2) * DEG;

      // header glow from EGT
      const egtC = c.egt - 273;
      const glow = Math.min(1, Math.max(0, (egtC - 520) / 380)) * (e.rpm > 200 ? 1 : 0);
      m.headerMat.emissive.setRGB(glow * 0.75, glow * 0.12, glow * 0.02);

      const dead = c.dead;
      m.gas.visible = !(dead && fl?.kind === 'piston');
      m.piston.children[0] && ((m.piston.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial).color.setHex(dead && fl?.kind === 'piston' ? 0x4a3f38 : COL.alu);
    });
  }

  render() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
