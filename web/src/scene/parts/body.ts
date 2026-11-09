// 24 body-panel designs generated from the car's own proportions: 6 front bumpers, 6 rear bumpers, 6 hoods and
// 6 fender-flare sets. Original shapes only (no real-world kit is copied), deterministic, no textures, and every mesh
// uses the single material the caller passes - so a panel can be swapped in with no new draw state.
//
// Model space: +x LEFT, +y UP, +z FRONT (the headlights sit at z ~ +2.0). The car is ~4.4 m long and ~1.9 m wide.
// Panels arrive as the stock part's bounding box (bumper_front / bumper_rear / hood); fenders have no panel box, so
// they are placed from the car box and the known axle positions.
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

// ---- bumpers ------------------------------------------------------------------------------------------------

interface Shell { g: THREE.Group; x: number; y: number; z: number; w: number; h: number; d: number; dir: 1 | -1 }

/**
 * The base bumper shell: a slab that sits over the stock panel, pushed out along z so it reads as a replacement.
 * opts.h / opts.depth scale the height and how far it protrudes.
 */
function shell(c: BodyCtx, kind: 'front' | 'rear', opts: { h?: number; depth?: number } = {}): Shell {
  const dir: 1 | -1 = kind === 'front' ? 1 : -1;
  const p = panelOf(c, kind, dir);
  const ctr = center(p), s = size(p);
  const w = Math.max(1.2, (s.x || 1.8) * 0.99);
  const h = Math.max(0.18, (s.y || 0.5) * (opts.h ?? 0.92));
  const base = Math.max(0.08, s.z || 0.25);
  const d = Math.max(0.1, base * (opts.depth ?? 1.15));
  const z = ctr.z + dir * (d - base) * 0.45;
  const g = new THREE.Group();
  g.add(mesh(new THREE.BoxGeometry(w, h, d), c).translateX(ctr.x).translateY(ctr.y).translateZ(z));
  return { g, x: ctr.x, y: ctr.y, z, w, h, d, dir };
}

/** A thin feature block (canard, fin, lip, strake) hanging off a shell. */
function fin(c: BodyCtx, w: number, h: number, d: number, x: number, y: number, z: number, rz = 0) {
  const m = mesh(new THREE.BoxGeometry(w, h, d), c);
  m.position.set(x, y, z);
  m.rotation.z = rz;
  return m;
}

function lip(c: BodyCtx, s: Shell, depth: number, yOff: number) {
  const m = mesh(new THREE.BoxGeometry(s.w * 0.98, 0.05, depth), c);
  m.position.set(s.x, s.y - s.h / 2 + yOff, s.z + s.dir * (s.d / 2 + depth / 2 - 0.02));
  return m;
}

function frontIntake(c: BodyCtx, s: Shell) {
  const g = new THREE.Group();
  const bw = s.w * 0.98, bh = s.h * 0.92;
  const top = mesh(new THREE.BoxGeometry(bw, bh * 0.28, s.d), c);
  top.position.set(s.x, s.y + bh * 0.36, s.z);
  const bot = mesh(new THREE.BoxGeometry(bw, bh * 0.22, s.d), c);
  bot.position.set(s.x, s.y - bh * 0.39, s.z);
  const sideW = bw * 0.18;
  for (const sx of [-1, 1]) {
    const side = mesh(new THREE.BoxGeometry(sideW, bh * 0.5, s.d), c);
    side.position.set(s.x + (sx * (bw - sideW)) / 2, s.y, s.z);
    g.add(side);
  }
  const back = mesh(new THREE.BoxGeometry(bw * 0.6, bh * 0.46, 0.04), c);
  back.position.set(s.x, s.y, s.z - s.dir * s.d * 0.5);
  g.add(top, bot, back);
  return g;
}

// ---- hood ---------------------------------------------------------------------------------------------------

interface Hood { g: THREE.Group; x: number; y: number; z: number; w: number; d: number }

function hoodBase(c: BodyCtx, opts: { thickness?: number } = {}): Hood {
  const p = panelOf(c, 'hood', 1);
  const ctr = center(p), s = size(p);
  const w = Math.max(0.9, (s.x || 1.5) * 0.92);
  const d = Math.max(0.6, (s.z || 1.0) * 0.92);
  const y = p.max.y + 0.01;
  const g = new THREE.Group();
  g.add(mesh(new THREE.BoxGeometry(w, opts.thickness ?? 0.04, d), c).translateX(ctr.x).translateY(y).translateZ(ctr.z));
  return { g, x: ctr.x, y, z: ctr.z, w, d };
}

function slats(c: BodyCtx, h: Hood, count: number, wFrac: number, depth: number) {
  const g = new THREE.Group();
  const w = h.w * wFrac, d = h.d * depth;
  for (let i = 0; i < count; i++) {
    const s = mesh(new THREE.BoxGeometry(w, 0.03, d / count - 0.02), c);
    s.position.set(h.x, h.y + 0.03, h.z + h.d * 0.1 - (d / 2) + (i + 0.5) * (d / count));
    g.add(s);
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
  geo.rotateY(Math.PI / 2);                    // shape x -> -z, shape y stays y, extrusion along x
  geo.translate(0, 0, 0);
  const m = mesh(geo, c);
  m.position.set(x + side * 0.02, y, z);
  if (side < 0) m.scale.x = 1;                 // both sides use the same extrusion; position mirrors it
  return m;
}

/** Four flares placed from the car box and the known axle positions (front 1.18, rear -1.47 in model space). */
function flares(c: BodyCtx, R: number, t: number, spread: number) {
  const g = new THREE.Group();
  const halfW = Math.max(0.75, (c.box.max.x - c.box.min.x) / 2 - 0.08);
  const y = Math.max(0.28, c.box.min.y + R * 0.92);
  const axles: [number, number][] = [[1.18, 1], [1.18, -1], [-1.47, 1], [-1.47, -1]];
  for (const [z, side] of axles) {
    const m = arch(c, side * (halfW + spread), y, z, R, t, side as 1 | -1);
    g.add(m);
  }
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
    const s = shell(c, 'front', { h: 0.9 });
    s.g.add(lip(c, s, 0.14, 0.03));
    return s.g;
  }),
  front('front-gt', 'Front GT', (c) => {
    const s = shell(c, 'front', { h: 0.95, depth: 1.2 });
    s.g.add(lip(c, s, 0.2, 0.03));
    for (const sx of [-1, 1]) s.g.add(fin(c, 0.05, 0.22, 0.26, s.x + sx * s.w * 0.46, s.y - s.h * 0.18, s.z + s.d * 0.42, sx * 0.2));
    return s.g;
  }),
  front('front-intake', 'Front Intake', (c) => {
    const s = shell(c, 'front', { h: 1, depth: 1.1 });
    s.g.add(frontIntake(c, s));
    return s.g;
  }),
  front('front-split', 'Front Split Lip', (c) => {
    const s = shell(c, 'front', { h: 0.85, depth: 1.25 });
    s.g.add(lip(c, s, 0.3, 0.02));
    for (const sx of [-1, 1]) s.g.add(fin(c, 0.06, 0.1, 0.22, s.x + sx * s.w * 0.47, s.y - s.h * 0.42, s.z + s.d * 0.55));
    return s.g;
  }),
  front('front-canard', 'Front Canards', (c) => {
    const s = shell(c, 'front', { h: 0.92 });
    for (const sx of [-1, 1]) for (let i = 0; i < 2; i++) {
      s.g.add(fin(c, 0.28, 0.03, 0.2, s.x + sx * s.w * 0.42, s.y + s.h * (0.05 + i * 0.28), s.z + s.d * 0.5, sx * (0.16 + i * 0.1)));
    }
    return s.g;
  }),
  front('front-track', 'Front Track', (c) => {
    const s = shell(c, 'front', { h: 0.98, depth: 1.18 });
    s.g.add(lip(c, s, 0.16, 0.02));
    for (const sx of [-1, 1]) s.g.add(fin(c, 0.04, 0.18, 0.3, s.x + sx * s.w * 0.48, s.y + s.h * 0.12, s.z + s.d * 0.35));
    const hook = mesh(new THREE.BoxGeometry(0.09, 0.09, 0.12), c);
    hook.position.set(s.x - s.w * 0.3, s.y - s.h * 0.3, s.z + s.d * 0.6);
    s.g.add(hook);
    return s.g;
  }),

  // ---- rear bumpers ----
  rear('rear-smooth', 'Rear Smooth', (c) => {
    const s = shell(c, 'rear', { h: 0.9 });
    s.g.add(lip(c, s, 0.12, 0.03));
    return s.g;
  }),
  rear('rear-diffuser', 'Rear Diffuser Cut', (c) => {
    const s = shell(c, 'rear', { h: 1, depth: 1.2 });
    s.g.add(lip(c, s, 0.26, 0.02));
    for (let i = 0; i < 4; i++) {
      const f = fin(c, 0.04, s.h * 0.5, 0.24, s.x - s.w * 0.33 + i * (s.w * 0.22), s.y - s.h * 0.22, s.z - s.d * 0.55, 0);
      s.g.add(f);
    }
    return s.g;
  }),
  rear('rear-twin', 'Rear Twin Exit', (c) => {
    const s = shell(c, 'rear', { h: 0.95 });
    for (const sx of [-1, 1]) {
      const ring = mesh(new THREE.BoxGeometry(0.26, 0.2, 0.06), c);
      ring.position.set(s.x + sx * s.w * 0.28, s.y - s.h * 0.25, s.z - s.d * 0.55);
      s.g.add(ring);
    }
    return s.g;
  }),
  rear('rear-aggressive', 'Rear Aggressive', (c) => {
    const s = shell(c, 'rear', { h: 1, depth: 1.15 });
    s.g.add(lip(c, s, 0.2, 0.02));
    for (let i = 0; i < 3; i++) s.g.add(fin(c, 0.05, 0.3, 0.18, s.x - s.w * 0.3 + i * s.w * 0.3, s.y + s.h * 0.05, s.z - s.d * 0.5));
    return s.g;
  }),
  rear('rear-gt', 'Rear GT', (c) => {
    const s = shell(c, 'rear', { h: 0.92, depth: 1.22 });
    s.g.add(lip(c, s, 0.24, 0.03));
    for (const sx of [-1, 1]) s.g.add(fin(c, 0.05, 0.2, 0.3, s.x + sx * s.w * 0.46, s.y - s.h * 0.1, s.z - s.d * 0.45, sx * 0.18));
    return s.g;
  }),
  rear('rear-track', 'Rear Track', (c) => {
    const s = shell(c, 'rear', { h: 0.96 });
    const plate = mesh(new THREE.BoxGeometry(s.w * 0.28, 0.16, 0.04), c);
    plate.position.set(s.x, s.y - s.h * 0.05, s.z - s.d * 0.55);
    s.g.add(plate);
    for (let i = 0; i < 2; i++) s.g.add(fin(c, 0.05, 0.24, 0.16, s.x - s.w * 0.2 + i * s.w * 0.4, s.y - s.h * 0.28, s.z - s.d * 0.45));
    return s.g;
  }),

  // ---- hoods ----
  hood('hood-smooth', 'Hood Smooth', (c) => hoodBase(c).g),
  hood('hood-vented', 'Hood Vented', (c) => {
    const h = hoodBase(c);
    h.g.add(slats(c, h, 4, 0.62, 0.5));
    return h.g;
  }),
  hood('hood-bulge', 'Hood Bulge', (c) => {
    const h = hoodBase(c);
    const bulge = mesh(new THREE.BoxGeometry(h.w * 0.42, 0.06, h.d * 0.7), c);
    bulge.position.set(h.x, h.y + 0.04, h.z);
    h.g.add(bulge);
    return h.g;
  }),
  hood('hood-power', 'Hood Power Dome', (c) => {
    const h = hoodBase(c);
    const dome = mesh(new THREE.BoxGeometry(h.w * 0.5, 0.08, h.d * 0.5), c);
    dome.position.set(h.x, h.y + 0.05, h.z + h.d * 0.06);
    h.g.add(dome);
    for (const sx of [-1, 1]) {
      const vent = mesh(new THREE.BoxGeometry(h.w * 0.16, 0.03, h.d * 0.3), c);
      vent.position.set(h.x + sx * h.w * 0.27, h.y + 0.03, h.z - h.d * 0.18);
      h.g.add(vent);
    }
    return h.g;
  }),
  hood('hood-carbon', 'Hood Carbon Inlay', (c) => {
    const h = hoodBase(c);
    const inlay = mesh(new THREE.BoxGeometry(h.w * 0.9, 0.02, h.d * 0.92), c);
    inlay.position.set(h.x, h.y + 0.02, h.z);
    const stripe = mesh(new THREE.BoxGeometry(h.w * 0.12, 0.025, h.d * 0.95), c);
    stripe.position.set(h.x, h.y + 0.035, h.z);
    h.g.add(inlay, stripe);
    return h.g;
  }),
  hood('hood-track', 'Hood Track Louvres', (c) => {
    const h = hoodBase(c);
    for (const sx of [-1, 1]) h.g.add(slats(c, { ...h, x: h.x + sx * h.w * 0.28 }, 3, 0.3, 0.45));
    return h.g;
  }),

  // ---- fender flares ----
  fender('fender-smooth', 'Fender Smooth', (c) => flares(c, 0.42, 0.05, 0)),
  fender('fender-plus', 'Fender Plus', (c) => flares(c, 0.44, 0.07, 0.02)),
  fender('fender-wide', 'Fender Wide', (c) => flares(c, 0.46, 0.09, 0.04)),
  fender('fender-bolt', 'Fender Bolt-on', (c) => flares(c, 0.48, 0.1, 0.06)),
  fender('fender-race', 'Fender Race', (c) => flares(c, 0.5, 0.12, 0.08)),
  fender('fender-extreme', 'Fender Extreme', (c) => flares(c, 0.54, 0.15, 0.1)),
];
