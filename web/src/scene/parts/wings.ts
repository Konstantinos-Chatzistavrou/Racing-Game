// 30 rear-wing designs, generated from the car's own proportions: ten families, three variants each.
// Original geometry (no real-world kit is copied), deterministic, no assets and no materials of its own - every mesh
// uses ctx.mat. Each wing is a small THREE.Group in model space (x left-right, y up, z front-back), <= 8 meshes.
import * as THREE from 'three/webgpu';

export interface WingCtx {
  /** the car's bounding box in model space */
  readonly box: THREE.Box3;
  /** the stock wing's bounding box in model space (mount height / z come from here) */
  readonly wb: THREE.Box3;
  /** the one material every mesh may use */
  readonly mat: THREE.Material;
}

export interface WingSpec {
  id: string;
  name: string;
  build(ctx: WingCtx): THREE.Object3D;
}

/** Cambered airfoil section extruded along the span, centred on x with the chord along z. */
function airfoil(chord: number, span: number, camber = 1): THREE.ExtrudeGeometry {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.bezierCurveTo(0.06 * camber, 0.05, 0.2 * camber, 0.05, chord, 0.012);
  s.lineTo(chord, -0.004);
  s.bezierCurveTo(0.2 * camber, 0.012, 0.06 * camber, 0.004, 0, 0);
  const g = new THREE.ExtrudeGeometry(s, { depth: span, bevelEnabled: false, curveSegments: 6 });
  g.translate(-chord / 2, 0, -span / 2);
  g.rotateY(Math.PI / 2);
  return g;
}

const cx = (c: WingCtx) => (c.wb.max.x + c.wb.min.x) / 2;
const zc = (c: WingCtx) => (c.wb.max.z + c.wb.min.z) / 2;
const spanOf = (c: WingCtx, frac: number, cap = 1.95) => Math.min(cap, (c.box.max.x - c.box.min.x) * frac);

function part(geo: THREE.BufferGeometry, c: WingCtx, x: number, y: number, z: number, rx = 0): THREE.Mesh {
  const m = new THREE.Mesh(geo, c.mat);
  m.position.set(x, y, z);
  m.rotation.x = rx;
  return m;
}
function plate(c: WingCtx, h: number, chord: number, x: number, y: number, z: number): THREE.Mesh {
  return part(new THREE.BoxGeometry(0.012, h, chord), c, x, y, z);
}
function strut(c: WingCtx, h: number, x: number, y: number, z: number, tilt = 0): THREE.Mesh {
  return part(new THREE.BoxGeometry(0.02, h, 0.06), c, x, y, z, tilt);
}

// ---- families ---------------------------------------------------------------------------------------------

/** Ducktail: one angled blade sitting on the boot lid. */
function ducktail(c: WingCtx, chord: number, tilt: number, spanFrac: number) {
  const g = new THREE.Group();
  g.add(part(airfoil(chord, spanOf(c, spanFrac)), c, cx(c), c.wb.min.y + 0.015, zc(c) + 0.04, tilt));
  return g;
}

/** Lip: the subtle end of the range - a short blade lifted just off the lid. */
function lip(c: WingCtx, chord: number, lift: number, spanFrac: number) {
  const g = new THREE.Group();
  g.add(part(airfoil(chord, spanOf(c, spanFrac)), c, cx(c), c.wb.min.y + lift, zc(c) + 0.06, -0.04));
  return g;
}

/** GT single element: blade on two struts, optional endplates. */
function gtSingle(c: WingCtx, spanFrac: number, chord: number, height: number, plateH: number) {
  const g = new THREE.Group();
  const w = spanOf(c, spanFrac), x = cx(c), z = zc(c) - 0.06;
  const y = c.wb.max.y + height;
  g.add(part(airfoil(chord, w), c, x, y, z, -0.14));
  for (const s of [-1, 1]) {
    g.add(strut(c, y - c.wb.min.y, x + s * w * 0.3, (y + c.wb.min.y) / 2, z + 0.02, 0.08));
    if (plateH > 0) g.add(plate(c, plateH, chord + 0.08, x + (s * w) / 2, y, z));
  }
  return g;
}

/** GT two element: a main plane with a separate flap behind it, deep endplates and struts. */
function gtTwo(c: WingCtx, spanFrac: number, chord: number, height: number) {
  const g = new THREE.Group();
  const w = spanOf(c, spanFrac), x = cx(c), z = zc(c) - 0.05;
  const y = c.wb.max.y + height;
  g.add(part(airfoil(chord, w), c, x, y, z, -0.16));
  g.add(part(airfoil(chord * 0.4, w * 0.98), c, x, y + 0.09, z + 0.19, -0.24));
  for (const s of [-1, 1]) {
    g.add(plate(c, 0.24, chord + 0.36, x + (s * w) / 2, y + 0.03, z + 0.09));
    g.add(strut(c, y - c.wb.min.y + 0.04, x + s * w * 0.28, (y + c.wb.min.y) / 2, z + 0.02, 0.08));
  }
  return g;
}

/** Swan neck: a high blade carried on two forward-leaning posts. */
function swan(c: WingCtx, spanFrac: number, chord: number, height: number, lean: number) {
  const g = new THREE.Group();
  const w = spanOf(c, spanFrac), x = cx(c), z = zc(c);
  const y = c.wb.max.y + height;
  g.add(part(airfoil(chord, w), c, x, y, z, -0.12));
  for (const s of [-1, 1]) g.add(strut(c, height + 0.1, x + s * w * 0.3, (c.wb.max.y + y) / 2, z + 0.05, lean));
  return g;
}

/** Chassis mount: a low blade bolted between two vertical plates. */
function chassis(c: WingCtx, spanFrac: number, chord: number, lift: number, plateH: number) {
  const g = new THREE.Group();
  const w = spanOf(c, spanFrac), x = cx(c), z = zc(c) + 0.03;
  const y = c.wb.min.y + lift;
  g.add(part(airfoil(chord, w), c, x, y, z, -0.08));
  for (const s of [-1, 1]) g.add(plate(c, plateH, chord + 0.06, x + (s * w) / 2, y, z));
  return g;
}

/** Dual element: two stacked blades tied together by endplates. */
function dual(c: WingCtx, spanFrac: number, chord: number, gap: number) {
  const g = new THREE.Group();
  const w = spanOf(c, spanFrac), x = cx(c), z = zc(c);
  g.add(part(airfoil(chord, w), c, x, c.wb.max.y + 0.14, z, -0.1));
  g.add(part(airfoil(chord * 1.2, w), c, x, c.wb.max.y + 0.14 + gap, z, -0.18));
  for (const s of [-1, 1]) g.add(plate(c, gap + 0.2, chord + 0.2, x + (s * w) / 2, c.wb.max.y + 0.16 + gap / 2, z));
  return g;
}

/** Wide blade: maximum span and endplate area, short chord. */
function wide(c: WingCtx, spanFrac: number, chord: number, height: number) {
  const g = new THREE.Group();
  const w = spanOf(c, spanFrac, 2.05), x = cx(c), z = zc(c) - 0.05;
  const y = c.wb.max.y + height;
  g.add(part(airfoil(chord, w), c, x, y, z, -0.12));
  for (const s of [-1, 1]) {
    g.add(plate(c, 0.2, chord + 0.12, x + (s * w) / 2, y, z));
    g.add(strut(c, height + 0.08, x + s * w * 0.32, (c.wb.max.y + y) / 2, z + 0.03, 0.06));
  }
  return g;
}

/** Pillar mount: the blade sits on two chunky uprights instead of thin struts. */
function pillar(c: WingCtx, spanFrac: number, chord: number, height: number) {
  const g = new THREE.Group();
  const w = spanOf(c, spanFrac), x = cx(c), z = zc(c) - 0.02;
  const y = c.wb.max.y + height;
  g.add(part(airfoil(chord, w), c, x, y, z, -0.1));
  for (const s of [-1, 1]) g.add(part(new THREE.BoxGeometry(0.05, height + 0.1, 0.12), c, x + s * w * 0.34, (c.wb.max.y + y) / 2, z + 0.02));
  return g;
}

/** Basket handle: a hoop - the blade carried on two tall side posts, closed by a top brace. */
function basket(c: WingCtx, spanFrac: number, chord: number, height: number) {
  const g = new THREE.Group();
  const w = spanOf(c, spanFrac, 1.9), x = cx(c), z = zc(c);
  const y = c.wb.max.y + height;
  g.add(part(airfoil(chord, w), c, x, y, z, -0.05));
  for (const s of [-1, 1]) g.add(part(new THREE.BoxGeometry(0.03, height + 0.06, 0.05), c, x + (s * w * 0.96) / 2, (c.wb.max.y + y) / 2, z + 0.02));
  g.add(part(new THREE.BoxGeometry(w, 0.025, 0.03), c, x, y + 0.02, z + 0.02));
  return g;
}

// ---- the catalogue: 10 families x 3 variants ----------------------------------------------------------------

type Params = [number, number, number];
type Build = (c: WingCtx, p: Params) => THREE.Object3D;
interface Def { id: string; name: string; p: Params; b: Build }

const DEFS: Def[] = [
  { id: 'duck-01', name: 'Duck 01', p: [0.20, -0.05, 0.9], b: (c, [a, t, s]) => ducktail(c, a, t, s) },
  { id: 'duck-02', name: 'Duck 02', p: [0.26, -0.10, 0.96], b: (c, [a, t, s]) => ducktail(c, a, t, s) },
  { id: 'duck-03', name: 'Duck 03', p: [0.32, -0.15, 1.0], b: (c, [a, t, s]) => ducktail(c, a, t, s) },

  { id: 'lip-01', name: 'Lip 01', p: [0.14, 0.01, 0.88], b: (c, [a, l, s]) => lip(c, a, l, s) },
  { id: 'lip-02', name: 'Lip 02', p: [0.18, 0.04, 0.94], b: (c, [a, l, s]) => lip(c, a, l, s) },
  { id: 'lip-03', name: 'Lip 03', p: [0.22, 0.07, 1.0], b: (c, [a, l, s]) => lip(c, a, l, s) },

  { id: 'gt-01', name: 'GT 01', p: [0.9, 0.28, 0.24], b: (c, [w, ch, h]) => gtSingle(c, w, ch, h, 0) },
  { id: 'gt-02', name: 'GT 02', p: [0.96, 0.32, 0.30], b: (c, [w, ch, h]) => gtSingle(c, w, ch, h, 0.14) },
  { id: 'gt-03', name: 'GT 03', p: [1.0, 0.38, 0.36], b: (c, [w, ch, h]) => gtSingle(c, w, ch, h, 0.18) },

  { id: 'gt2-01', name: 'GT2 01', p: [0.9, 0.30, 0.26], b: (c, [w, ch, h]) => gtTwo(c, w, ch, h) },
  { id: 'gt2-02', name: 'GT2 02', p: [0.96, 0.34, 0.32], b: (c, [w, ch, h]) => gtTwo(c, w, ch, h) },
  { id: 'gt2-03', name: 'GT2 03', p: [1.0, 0.40, 0.38], b: (c, [w, ch, h]) => gtTwo(c, w, ch, h) },

  { id: 'swan-01', name: 'Swan 01', p: [0.9, 0.28, 0.22], b: (c, [w, ch, h]) => swan(c, w, ch, h, -0.4) },
  { id: 'swan-02', name: 'Swan 02', p: [0.96, 0.30, 0.30], b: (c, [w, ch, h]) => swan(c, w, ch, h, -0.55) },
  { id: 'swan-03', name: 'Swan 03', p: [1.0, 0.34, 0.38], b: (c, [w, ch, h]) => swan(c, w, ch, h, -0.7) },

  { id: 'chassis-01', name: 'Chassis 01', p: [0.92, 0.26, 0.08], b: (c, [w, ch, h]) => chassis(c, w, ch, h, 0.16) },
  { id: 'chassis-02', name: 'Chassis 02', p: [0.96, 0.30, 0.12], b: (c, [w, ch, h]) => chassis(c, w, ch, h, 0.2) },
  { id: 'chassis-03', name: 'Chassis 03', p: [1.0, 0.34, 0.16], b: (c, [w, ch, h]) => chassis(c, w, ch, h, 0.24) },

  { id: 'dual-01', name: 'Dual 01', p: [0.9, 0.22, 0.10], b: (c, [w, ch, g]) => dual(c, w, ch, g) },
  { id: 'dual-02', name: 'Dual 02', p: [0.96, 0.24, 0.14], b: (c, [w, ch, g]) => dual(c, w, ch, g) },
  { id: 'dual-03', name: 'Dual 03', p: [1.0, 0.28, 0.18], b: (c, [w, ch, g]) => dual(c, w, ch, g) },

  { id: 'wide-01', name: 'Wide 01', p: [0.96, 0.22, 0.22], b: (c, [w, ch, h]) => wide(c, w, ch, h) },
  { id: 'wide-02', name: 'Wide 02', p: [1.0, 0.24, 0.28], b: (c, [w, ch, h]) => wide(c, w, ch, h) },
  { id: 'wide-03', name: 'Wide 03', p: [1.0, 0.26, 0.34], b: (c, [w, ch, h]) => wide(c, w, ch, h) },

  { id: 'pillar-01', name: 'Pillar 01', p: [0.9, 0.26, 0.20], b: (c, [w, ch, h]) => pillar(c, w, ch, h) },
  { id: 'pillar-02', name: 'Pillar 02', p: [0.96, 0.30, 0.28], b: (c, [w, ch, h]) => pillar(c, w, ch, h) },
  { id: 'pillar-03', name: 'Pillar 03', p: [1.0, 0.34, 0.36], b: (c, [w, ch, h]) => pillar(c, w, ch, h) },

  { id: 'basket-01', name: 'Basket 01', p: [0.88, 0.24, 0.24], b: (c, [w, ch, h]) => basket(c, w, ch, h) },
  { id: 'basket-02', name: 'Basket 02', p: [0.94, 0.26, 0.32], b: (c, [w, ch, h]) => basket(c, w, ch, h) },
  { id: 'basket-03', name: 'Basket 03', p: [1.0, 0.30, 0.40], b: (c, [w, ch, h]) => basket(c, w, ch, h) },
];

/** Exactly 30 wings: Duck, Lip, GT, GT2, Swan, Chassis, Dual, Wide, Pillar, Basket - three variants each. */
export const WING_SPECS: WingSpec[] = DEFS.map((d) => ({ id: d.id, name: d.name, build: (ctx: WingCtx) => d.b(ctx, d.p) }));
