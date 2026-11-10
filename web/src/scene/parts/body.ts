// 24 body-panel designs generated from the car's own proportions: 6 front bumpers, 6 rear bumpers, 6 hoods and
// 6 fender-flare sets. Original shapes only (no real-world kit is copied), deterministic, no textures, and every mesh
// uses the single material the caller passes - so a panel can be swapped in with no new draw state.
//
// Model space: +x LEFT, +y UP, +z FRONT (the headlights sit at z ~ +2.0). The car is ~4.4 m long and ~1.9 m wide.
// Panels arrive as the stock part's bounding box (bumper_front / bumper_rear / hood); fenders have no panel box, so
// they are placed from the car box and the known axle positions.
//
// Shape language: a bumper is not a slab. Its face is a curved cross-section (a displaced segmented box), its lower
// edge is chamfered, openings are real holes in a ring of pieces (with a recessed back wall and angled side walls so
// they read as depth, not paint), and separate parts sit 3 mm off the body as split lines. A hood is a crowned skin
// (a shallow parabola across x, milder along z) with an optional centre bulge or a recessed vent built the same way.
import * as THREE from 'three/webgpu';

export type BodyKind = 'front' | 'rear' | 'hood' | 'fender';

export interface BodyCtx {
  /** the whole car, model space */
  readonly box: THREE.Box3;
  /** the stock panel being replaced (bumper_front / bumper_rear / hood), model space */
  readonly panel: THREE.Box3;
  /** aero material: use only this */
  readonly mat: THREE.Material;
}

export interface BodySpec {
  id: string;
  name: string;
  kind: BodyKind;
  build(ctx: BodyCtx): THREE.Object3D;
}

const CENTER = new THREE.Vector3();
const SIZE = new THREE.Vector3();
/** a split line: separate parts never touch the body */
const GAP = 0.003;
const center = (b: THREE.Box3) => b.getCenter(CENTER.clone());
const size = (b: THREE.Box3) => b.getSize(SIZE.clone());
const mesh = (g: THREE.BufferGeometry, c: BodyCtx) => new THREE.Mesh(g, c.mat);

/** The stock panel, or a sensible stand-in at the front / rear / top of the car when the box is empty. */
function panelOf(c: BodyCtx, kind: BodyKind, dir: 1 | -1): THREE.Box3 {
  if (!c.panel.isEmpty()) return c.panel;
  const b = c.box;
  if (kind === 'hood') {
    return new THREE.Box3(
      new THREE.Vector3(b.min.x + 0.25, b.max.y - 0.35, b.max.z - 1.5),
      new THREE.Vector3(b.max.x - 0.25, b.max.y - 0.1, b.max.z - 0.55),
    );
  }
  const zEnd = dir > 0 ? b.max.z - 0.35 : b.min.z + 0.35;
  return new THREE.Box3(
    new THREE.Vector3(b.min.x + 0.15, b.min.y + 0.15, zEnd - 0.2),
    new THREE.Vector3(b.max.x - 0.15, b.min.y + 0.85, zEnd + 0.2),
  );
}

// ---- shared geometry ----------------------------------------------------------------------------------------

/**
 * A curved panel piece: a box segmented across x whose front face bulges (rounded in plan view) and whose lower
 * edge is pulled back - a chamfered lip, not a cut slab. bulge is in metres; chamfer is a fraction of the depth.
 */
function curvedPiece(c: BodyCtx, w: number, h: number, d: number, bulge: number, chamfer = 0.35): THREE.Mesh {
  const sx = Math.max(2, Math.round(w / 0.18));
  const geo = new THREE.BoxGeometry(w, h, d, sx, 3, 1);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (z <= 0) continue;
    const xn = w > 1e-6 ? (2 * x) / w : 0;
    let nz = z + bulge * (1 - xn * xn);
    if (y < 0 && h > 1e-6) nz -= chamfer * (-y / (h / 2)) * (d * 0.28);
    pos.setZ(i, nz);
  }
  geo.computeVertexNormals();
  return mesh(geo, c);
}

// ---- bumpers ------------------------------------------------------------------------------------------------

interface Shell { g: THREE.Group; x: number; y: number; z: number; w: number; h: number; d: number; dir: 1 | -1 }

function dims(c: BodyCtx, kind: 'front' | 'rear', opts: { h?: number; depth?: number }) {
  const dir: 1 | -1 = kind === 'front' ? 1 : -1;
  const p = panelOf(c, kind, dir);
  const ctr = center(p), s = size(p);
  const w = Math.max(1.2, (s.x || 1.8) * 0.99);
  const h = Math.max(0.18, (s.y || 0.5) * (opts.h ?? 0.92));
  const base = Math.max(0.08, s.z || 0.25);
  const d = Math.max(0.1, base * (opts.depth ?? 1.15));
  const z = ctr.z + dir * (d - base) * 0.45;
  return { dir, ctr, w, h, d, z };
}

/** Base bumper: one curved shell, bulged in plan and chamfered along the bottom. */
function shell(c: BodyCtx, kind: 'front' | 'rear', opts: { h?: number; depth?: number; bulge?: number } = {}): Shell {
  const { dir, ctr, w, h, d, z } = dims(c, kind, opts);
  const m = curvedPiece(c, w, h, d, opts.bulge ?? 0.05, 0.4);
  m.position.set(ctr.x, ctr.y, z);
  const g = new THREE.Group();
  g.add(m);
  return { g, x: ctr.x, y: ctr.y, z, w, h, d, dir };
}

/** Two-piece bumper: upper and lower shells separated by a 3 mm split line. */
function seamShell(c: BodyCtx, kind: 'front' | 'rear', opts: { h?: number; depth?: number; bulge?: number } = {}): Shell {
  const { dir, ctr, w, h, d, z } = dims(c, kind, opts);
  const g = new THREE.Group();
  const hh = h / 2 - GAP;
  for (const sy of [1, -1]) {
    const m = curvedPiece(c, w, hh, d, opts.bulge ?? 0.05, 0.4);
    m.position.set(ctr.x, ctr.y + (sy * (hh + GAP)) / 2, z);
    g.add(m);
  }
  return { g, x: ctr.x, y: ctr.y, z, w, h, d, dir };
}

/** A thin lip under the bumper, offset by GAP so it reads as a separate splitter. */
function lip(c: BodyCtx, s: Shell, depth: number, yOff: number) {
  const m = curvedPiece(c, s.w * 0.98, 0.05, depth, 0.02, 0.2);
  m.position.set(s.x, s.y - s.h / 2 + yOff - GAP, s.z + s.dir * (s.d / 2 + depth / 2 - 0.02));
  return m;
}

/** A thin feature block (canard, fin, plate) hanging off a bumper. */
function fin(c: BodyCtx, w: number, h: number, d: number, x: number, y: number, z: number, rz = 0) {
  const m = mesh(new THREE.BoxGeometry(w, h, d), c);
  m.position.set(x, y, z);
  m.rotation.z = rz;
  return m;
}

/**
 * A real opening in a bumper: the shell is a ring of four curved pieces around a gap, with a recessed back wall
 * (10 cm in, tilted) and two angled side walls - depth and shadow instead of a second material.
 */
function intake(c: BodyCtx, s: Shell, ow: number, oh: number, oy: number, tilt = 0.16) {
  const g = new THREE.Group();
  const w = s.w, h = s.h, d = s.d;
  const topH = h / 2 - (oy + oh / 2) - GAP;
  if (topH > 0.012) {
    const m = curvedPiece(c, w, topH, d, 0.04);
    m.position.set(s.x, oy + oh / 2 + topH / 2 + GAP, s.z);
    g.add(m);
  }
  const botH = oy - oh / 2 + h / 2 - GAP;
  if (botH > 0.012) {
    const m = curvedPiece(c, w, botH, d, 0.04);
    m.position.set(s.x, oy - oh / 2 - botH / 2 - GAP, s.z);
    g.add(m);
  }
  const sideW = (w - ow) / 2 - GAP;
  if (sideW > 0.012) {
    for (const sx of [-1, 1]) {
      const m = curvedPiece(c, sideW, oh, d, 0.03);
      m.position.set(s.x + sx * (ow / 2 + sideW / 2 + GAP), oy, s.z);
      g.add(m);
    }
  }
  const back = mesh(new THREE.BoxGeometry(ow * 0.98, oh * 0.98, 0.04), c);
  back.position.set(s.x, oy, s.z - s.dir * (d / 2 - 0.1));
  back.rotation.x = s.dir * tilt;
  g.add(back);
  for (const sx of [-1, 1]) {
    const wm = mesh(new THREE.BoxGeometry(0.04, oh * 0.95, 0.18), c);
    wm.position.set(s.x + sx * (ow / 2 - 0.02), oy, s.z - s.dir * (d / 2 - 0.06));
    wm.rotation.y = -sx * 0.25 * s.dir;
    g.add(wm);
  }
  return g;
}

// ---- hood ---------------------------------------------------------------------------------------------------

interface Hood { g: THREE.Group; x: number; y: number; z: number; w: number; d: number }

/** A crowned skin piece: y is lifted by a shallow parabola across x (and a gentler one along z). */
function skinPiece(c: BodyCtx, w: number, d: number, t: number, xOff: number, hoodW: number, crown: number, bulge = 0) {
  const sx = Math.max(2, Math.round(w / 0.16)), sz = Math.max(2, Math.round(d / 0.16));
  const geo = new THREE.BoxGeometry(w, t, d, sx, 1, sz);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) <= 0) continue;
    const gx = pos.getX(i) + xOff, gz = pos.getZ(i);
    const xn = hoodW > 1e-6 ? (2 * gx) / hoodW : 0;
    const zn = d > 1e-6 ? (2 * gz) / d : 0;
    let dy = crown * (1 - xn * xn) * (1 - 0.3 * zn * zn);
    dy += bulge * Math.max(0, 1 - Math.abs(xn) / 0.5) * Math.max(0, 1 - Math.abs(zn) / 0.85);
    pos.setY(i, pos.getY(i) + dy);
  }
  geo.computeVertexNormals();
  return mesh(geo, c);
}

function hoodDims(c: BodyCtx) {
  const p = panelOf(c, 'hood', 1);
  const ctr = center(p), s = size(p);
  const w = Math.max(0.9, (s.x || 1.5) * 0.92);
  const d = Math.max(0.6, (s.z || 1.0) * 0.92);
  return { x: ctr.x, y: p.max.y + 0.01, z: ctr.z, w, d };
}

function hoodBase(c: BodyCtx, opts: { crown?: number; bulge?: number; t?: number } = {}): Hood {
  const { x, y, z, w, d } = hoodDims(c);
  const m = skinPiece(c, w, d, opts.t ?? 0.04, 0, w, opts.crown ?? 0.05, opts.bulge ?? 0);
  m.position.set(x, y, z);
  const g = new THREE.Group();
  g.add(m);
  return { g, x, y, z, w, d };
}

/** Front edge lip: a thin strip along the nose edge, 3 mm off the skin. */
function hoodLip(c: BodyCtx, h: Hood) {
  const m = mesh(new THREE.BoxGeometry(h.w * 0.98, 0.03, 0.08), c);
  m.position.set(h.x, h.y + 0.01, h.z + h.d / 2 - 0.02 + GAP);
  return m;
}

/** Recessed vent: the skin becomes a ring of crowned strips around a hole, with a floor and two walls. */
function hoodVent(c: BodyCtx, ow: number, od: number, opts: { crown?: number } = {}) {
  const { x, y, z, w, d } = hoodDims(c);
  const crown = opts.crown ?? 0.05;
  const g = new THREE.Group();
  const strip = (pw: number, pd: number, px: number, pz: number, off: number) => {
    const m = skinPiece(c, pw, pd, 0.04, off, w, crown);
    m.position.set(px, y, pz);
    g.add(m);
  };
  const frontD = d / 2 - od / 2 - GAP;
  if (frontD > 0.01) strip(w, frontD, x, z + od / 2 + frontD / 2 + GAP, 0);
  const rearD = d / 2 - od / 2 - GAP;
  if (rearD > 0.01) strip(w, rearD, x, z - od / 2 - rearD / 2 - GAP, 0);
  const sideW = (w - ow) / 2 - GAP;
  if (sideW > 0.01) for (const sx of [-1, 1]) {
    strip(sideW, od, x + sx * (ow / 2 + sideW / 2 + GAP), z, sx * (ow / 2 + sideW / 2 + GAP));
  }
  const floor = mesh(new THREE.BoxGeometry(ow, 0.02, od), c);
  floor.position.set(x, y - 0.05, z);
  g.add(floor);
  for (const sz of [-1, 1]) {
    const wm = mesh(new THREE.BoxGeometry(ow, 0.05, 0.02), c);
    wm.position.set(x, y - 0.025, z + sz * (od / 2 - 0.01));
    g.add(wm);
  }
  return { g, x, y, z };
}

/** A small recessed pocket: a floor 4 cm down plus two side walls (3 meshes). */
function pocket(c: BodyCtx, ow: number, od: number, x: number, y: number, z: number) {
  const g = new THREE.Group();
  const floor = mesh(new THREE.BoxGeometry(ow, 0.02, od), c);
  floor.position.set(x, y - 0.04, z);
  g.add(floor);
  for (const sx of [-1, 1]) {
    const wm = mesh(new THREE.BoxGeometry(0.02, 0.04, od), c);
    wm.position.set(x + sx * (ow / 2 - 0.01), y - 0.02, z);
    g.add(wm);
  }
  return g;
}

/** A run of louvre slats sitting inside a vent/pocket. */
function slats(c: BodyCtx, x: number, y: number, z: number, w: number, d: number, count: number) {
  const g = new THREE.Group();
  for (let i = 0; i < count; i++) {
    const m = mesh(new THREE.BoxGeometry(w, 0.02, d / count - 0.02), c);
    m.position.set(x, y, z - d / 2 + (i + 0.5) * (d / count));
    g.add(m);
  }
  return g;
}

// ---- fenders ------------------------------------------------------------------------------------------------

/** One arch flare: a half-ring in the y-z plane, extruded along x. */
function arch(c: BodyCtx, x: number, y: number, z: number, R: number, t: number, side: 1 | -1) {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, R, 0.12, Math.PI - 0.12, false);
  const hole = new THREE.Path();
  hole.absarc(0, 0, R - t, 0.12, Math.PI - 0.12, true);
  shape.holes.push(hole);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.11, bevelEnabled: false, curveSegments: 10 });
  geo.rotateY(Math.PI / 2);
  const m = mesh(geo, c);
  m.position.set(x + side * 0.02, y, z);
  return m;
}

/** Four flares placed from the car box and the known axle positions (front 1.18, rear -1.47 in model space). */
function flares(c: BodyCtx, R: number, t: number, spread: number) {
  const g = new THREE.Group();
  const halfW = Math.max(0.75, (c.box.max.x - c.box.min.x) / 2 - 0.08);
  const y = Math.max(0.28, c.box.min.y + R * 0.92);
  const axles: [number, number][] = [[1.18, 1], [1.18, -1], [-1.47, 1], [-1.47, -1]];
  for (const [z, side] of axles) g.add(arch(c, side * (halfW + spread), y, z, R, t, side as 1 | -1));
  return g;
}

// ---- the catalog ---------------------------------------------------------------------------------------------

const front = (id: string, name: string, build: (c: BodyCtx) => THREE.Object3D): BodySpec => ({ id, name, kind: 'front', build });
const rear = (id: string, name: string, build: (c: BodyCtx) => THREE.Object3D): BodySpec => ({ id, name, kind: 'rear', build });
const hood = (id: string, name: string, build: (c: BodyCtx) => THREE.Object3D): BodySpec => ({ id, name, kind: 'hood', build });
const fender = (id: string, name: string, build: (c: BodyCtx) => THREE.Object3D): BodySpec => ({ id, name, kind: 'fender', build });

export const BODY_SPECS: BodySpec[] = [
  // ---- front bumpers ----
  front('front-smooth', 'Front Smooth', (c) => {
    const s = shell(c, 'front', { h: 0.9, bulge: 0.06 });
    s.g.add(lip(c, s, 0.14, 0.03));
    return s.g;
  }),
  front('front-gt', 'Front GT', (c) => {
    const s = seamShell(c, 'front', { h: 0.95, depth: 1.2, bulge: 0.06 });
    s.g.add(lip(c, s, 0.2, 0.03));
    for (const sx of [-1, 1]) s.g.add(fin(c, 0.05, 0.22, 0.26, s.x + sx * s.w * 0.46, s.y - s.h * 0.18, s.z + s.d * 0.42, sx * 0.2));
    return s.g;
  }),
  front('front-intake', 'Front Intake', (c) => {
    const s = shell(c, 'front', { h: 1, depth: 1.1, bulge: 0.05 });
    s.g.add(intake(c, s, s.w * 0.44, s.h * 0.46, -s.h * 0.02));
    s.g.add(lip(c, s, 0.12, 0.02));
    return s.g;
  }),
  front('front-split', 'Front Split Lip', (c) => {
    const s = seamShell(c, 'front', { h: 0.86, depth: 1.28, bulge: 0.05 });
    s.g.add(lip(c, s, 0.3, 0.02));
    for (const sx of [-1, 1]) s.g.add(fin(c, 0.06, 0.1, 0.22, s.x + sx * s.w * 0.47, s.y - s.h * 0.42, s.z + s.d * 0.55));
    return s.g;
  }),
  front('front-canard', 'Front Canards', (c) => {
    const s = shell(c, 'front', { h: 0.92, bulge: 0.06 });
    for (const sx of [-1, 1]) for (let i = 0; i < 2; i++) {
      s.g.add(fin(c, 0.28, 0.03, 0.2, s.x + sx * s.w * 0.42, s.y + s.h * (0.05 + i * 0.28), s.z + s.d * 0.5, sx * (0.16 + i * 0.1)));
    }
    s.g.add(lip(c, s, 0.1, 0.02));
    return s.g;
  }),
  front('front-track', 'Front Track', (c) => {
    const s = shell(c, 'front', { h: 0.98, depth: 1.18, bulge: 0.05 });
    s.g.add(intake(c, s, s.w * 0.56, s.h * 0.34, -s.h * 0.1));
    s.g.add(lip(c, s, 0.16, 0.02));
    for (const sx of [-1, 1]) s.g.add(fin(c, 0.04, 0.18, 0.3, s.x + sx * s.w * 0.48, s.y + s.h * 0.12, s.z + s.d * 0.35));
    const hook = mesh(new THREE.BoxGeometry(0.09, 0.09, 0.12), c);
    hook.position.set(s.x - s.w * 0.3, s.y - s.h * 0.3, s.z + s.d * 0.6);
    s.g.add(hook);
    return s.g;
  }),

  // ---- rear bumpers ----
  rear('rear-smooth', 'Rear Smooth', (c) => {
    const s = shell(c, 'rear', { h: 0.9, bulge: 0.06 });
    s.g.add(lip(c, s, 0.12, 0.03));
    return s.g;
  }),
  rear('rear-diffuser', 'Rear Diffuser Cut', (c) => {
    const s = shell(c, 'rear', { h: 1, depth: 1.2, bulge: 0.05 });
    s.g.add(intake(c, s, s.w * 0.5, s.h * 0.4, -s.h * 0.06));
    for (let i = 0; i < 3; i++) {
      s.g.add(fin(c, 0.04, s.h * 0.34, 0.2, s.x - s.w * 0.2 + i * s.w * 0.2, s.y - s.h * 0.2, s.z - s.d * 0.42));
    }
    s.g.add(lip(c, s, 0.26, 0.02));
    return s.g;
  }),
  rear('rear-twin', 'Rear Twin Exit', (c) => {
    const s = shell(c, 'rear', { h: 0.95, bulge: 0.06 });
    for (const sx of [-1, 1]) {
      const tube = mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.16, 12, 1, true), c);
      tube.rotation.x = Math.PI / 2;
      tube.position.set(s.x + sx * s.w * 0.28, s.y - s.h * 0.22, s.z - s.dir * s.d * 0.32);
      s.g.add(tube);
      const ring = mesh(new THREE.TorusGeometry(0.085, 0.014, 6, 16), c);
      ring.position.set(s.x + sx * s.w * 0.28, s.y - s.h * 0.22, s.z - s.dir * (s.d * 0.5 - GAP));
      s.g.add(ring);
    }
    s.g.add(lip(c, s, 0.1, 0.02));
    return s.g;
  }),
  rear('rear-aggressive', 'Rear Aggressive', (c) => {
    const s = shell(c, 'rear', { h: 1, depth: 1.15, bulge: 0.05 });
    s.g.add(intake(c, s, s.w * 0.6, s.h * 0.34, -s.h * 0.04));
    for (let i = 0; i < 2; i++) s.g.add(fin(c, 0.05, 0.26, 0.18, s.x - s.w * 0.18 + i * s.w * 0.36, s.y + s.h * 0.08, s.z - s.d * 0.5));
    s.g.add(lip(c, s, 0.2, 0.02));
    return s.g;
  }),
  rear('rear-gt', 'Rear GT', (c) => {
    const s = shell(c, 'rear', { h: 0.92, depth: 1.22, bulge: 0.06 });
    s.g.add(lip(c, s, 0.24, 0.03));
    for (const sx of [-1, 1]) s.g.add(fin(c, 0.05, 0.2, 0.3, s.x + sx * s.w * 0.46, s.y - s.h * 0.1, s.z - s.d * 0.45, sx * 0.18));
    return s.g;
  }),
  rear('rear-track', 'Rear Track', (c) => {
    const s = shell(c, 'rear', { h: 0.96, bulge: 0.05 });
    const plate = mesh(new THREE.BoxGeometry(s.w * 0.28, 0.16, 0.04), c);
    plate.position.set(s.x, s.y - s.h * 0.05, s.z - s.d * 0.55);
    s.g.add(plate);
    for (let i = 0; i < 2; i++) s.g.add(fin(c, 0.05, 0.24, 0.16, s.x - s.w * 0.2 + i * s.w * 0.4, s.y - s.h * 0.28, s.z - s.d * 0.45));
    s.g.add(lip(c, s, 0.12, 0.02));
    return s.g;
  }),

  // ---- hoods ----
  hood('hood-smooth', 'Hood Smooth', (c) => {
    const h = hoodBase(c, { crown: 0.05 });
    h.g.add(hoodLip(c, h));
    return h.g;
  }),
  hood('hood-vented', 'Hood Vented', (c) => {
    const h = hoodBase(c, { crown: 0.05 });
    const v = hoodVent(c, h.w * 0.55, h.d * 0.4, { crown: 0.05 });
    h.g.add(v.g);
    h.g.add(slats(c, v.x, v.y - 0.03, v.z, h.w * 0.5, h.d * 0.32, 3));
    h.g.add(hoodLip(c, h));
    return h.g;
  }),
  hood('hood-bulge', 'Hood Bulge', (c) => {
    const h = hoodBase(c, { crown: 0.04, bulge: 0.07 });
    h.g.add(hoodLip(c, h));
    return h.g;
  }),
  hood('hood-power', 'Hood Power Dome', (c) => {
    const h = hoodBase(c, { crown: 0.05 });
    const dome = skinPiece(c, h.w * 0.42, h.d * 0.5, 0.05, 0, h.w, 0.1, 0.06);
    dome.position.set(h.x, h.y + 0.012, h.z + h.d * 0.05);
    h.g.add(dome);
    for (const sx of [-1, 1]) h.g.add(pocket(c, h.w * 0.18, h.d * 0.22, h.x + sx * h.w * 0.28, h.y, h.z - h.d * 0.16));
    h.g.add(hoodLip(c, h));
    return h.g;
  }),
  hood('hood-carbon', 'Hood Carbon Inlay', (c) => {
    const h = hoodBase(c, { crown: 0.05 });
    const inlay = skinPiece(c, h.w * 0.88, h.d * 0.9, 0.02, 0, h.w, 0.05);
    inlay.position.set(h.x, h.y + GAP, h.z);
    const stripe = skinPiece(c, h.w * 0.12, h.d * 0.94, 0.025, 0, h.w, 0.05);
    stripe.position.set(h.x, h.y + GAP * 2, h.z);
    h.g.add(inlay, stripe, hoodLip(c, h));
    return h.g;
  }),
  hood('hood-track', 'Hood Track Louvres', (c) => {
    const h = hoodBase(c, { crown: 0.05 });
    for (const sx of [-1, 1]) {
      const px = h.x + sx * h.w * 0.28, pz = h.z - h.d * 0.1;
      h.g.add(pocket(c, h.w * 0.24, h.d * 0.28, px, h.y, pz));
      h.g.add(slats(c, px, h.y - 0.028, pz, h.w * 0.2, h.d * 0.22, 2));
    }
    h.g.add(hoodLip(c, h));
    return h.g;
  }),

  // ---- fender flares (kept for their ids; the garage now draws arch lips itself) ----
  fender('fender-smooth', 'Fender Smooth', (c) => flares(c, 0.42, 0.05, 0)),
  fender('fender-plus', 'Fender Plus', (c) => flares(c, 0.44, 0.07, 0.02)),
  fender('fender-wide', 'Fender Wide', (c) => flares(c, 0.46, 0.09, 0.04)),
  fender('fender-bolt', 'Fender Bolt-on', (c) => flares(c, 0.48, 0.1, 0.06)),
  fender('fender-race', 'Fender Race', (c) => flares(c, 0.5, 0.12, 0.08)),
  fender('fender-extreme', 'Fender Extreme', (c) => flares(c, 0.54, 0.15, 0.1)),
];
