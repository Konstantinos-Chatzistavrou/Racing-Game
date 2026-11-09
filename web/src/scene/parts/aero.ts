// 30 original aero add-ons, generated in code (no authored meshes, no textures, no third-party kit shapes).
//
// MODEL SPACE: +x is the car's right, +y up, +z is the FRONT. This is not a guess: the headlight anchors in
// data/cars/*.visual.json sit at z ~= +2.0, and the car is ~4.4 m long, so the front bumper is box.max.z and the
// rear is box.min.z (the opposite of the "-z forward" convention in the brief). Splitters therefore live past
// max.z, diffusers past min.z, and skirts along the middle of z.
//
// Every spec returns an Object3D of at most 8 boxes, all sharing ctx.mat, deterministic (no random), and cheap:
// they are attached once and merged/hidden by the caller. Sizes derive from ctx.box so the same catalog fits any car.
import * as THREE from 'three/webgpu';

export type AeroKind = 'splitter' | 'diffuser' | 'skirt';

export interface AeroCtx {
  readonly box: THREE.Box3;
  readonly mat: THREE.Material;
}

export interface AeroSpec {
  id: string;
  name: string;
  kind: AeroKind;
  build(ctx: AeroCtx): THREE.Object3D;
}

const width = (b: THREE.Box3) => b.max.x - b.min.x;
const length = (b: THREE.Box3) => b.max.z - b.min.z;
const midX = (b: THREE.Box3) => (b.max.x + b.min.x) / 2;
const midZ = (b: THREE.Box3) => (b.max.z + b.min.z) / 2;
const floorY = (b: THREE.Box3) => b.min.y;

/** One box, positioned by its centre. The only primitive the catalog needs. */
function slab(g: THREE.Object3D, mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, rx = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.rotation.x = rx;
  g.add(m);
  return m;
}

function group(name: string) { const g = new THREE.Group(); g.name = name; return g; }

// ---- splitters: blades under the front bumper, at the max z end ------------------------------------------------
/** A splitter base: a wide, thin blade whose back edge tucks under the bumper (max.z - 0.06). */
function splitterBlade(ctx: AeroCtx, depth: number, thickness = 0.03, yOff = 0.03) {
  const b = ctx.box;
  const w = width(b) * 0.9;
  const z = b.max.z + depth / 2 - 0.06;
  return { w, z, y: floorY(b) + yOff, t: thickness };
}

const SPLITTER_SPECS: AeroSpec[] = [
  { id: 'splitter-lip-01', name: 'Street Lip', kind: 'splitter', build: (c) => {
    const g = group('splitter-lip-01'); const s = splitterBlade(c, 0.24);
    slab(g, c.mat, s.w, s.t, 0.24, midX(c.box), s.y + 0.02, s.z); return g; } },
  { id: 'splitter-deep-02', name: 'Deep Splitter', kind: 'splitter', build: (c) => {
    const g = group('splitter-deep-02'); const s = splitterBlade(c, 0.44);
    slab(g, c.mat, s.w, s.t, 0.44, midX(c.box), s.y, s.z);
    slab(g, c.mat, 0.04, 0.14, 0.40, midX(c.box) - s.w / 2 + 0.05, s.y + 0.09, s.z + 0.02);
    slab(g, c.mat, 0.04, 0.14, 0.40, midX(c.box) + s.w / 2 - 0.05, s.y + 0.09, s.z + 0.02);
    return g; } },
  { id: 'splitter-split-03', name: 'Split Blade', kind: 'splitter', build: (c) => {
    const g = group('splitter-split-03'); const s = splitterBlade(c, 0.36);
    const half = s.w * 0.46;
    for (const sx of [-1, 1]) slab(g, c.mat, half, s.t, 0.36, midX(c.box) + sx * (half / 2 + 0.03), s.y, s.z);
    return g; } },
  { id: 'splitter-canard-04', name: 'Canard Wing', kind: 'splitter', build: (c) => {
    const g = group('splitter-canard-04'); const s = splitterBlade(c, 0.30);
    slab(g, c.mat, s.w, s.t, 0.30, midX(c.box), s.y, s.z);
    for (const sx of [-1, 1]) for (let i = 0; i < 2; i++) {
      slab(g, c.mat, 0.16, 0.015, 0.10, midX(c.box) + sx * (s.w / 2 - 0.12), s.y + 0.10 + i * 0.09, s.z - 0.02, -0.35);
    }
    return g; } },
  { id: 'splitter-step-05', name: 'Step Lip', kind: 'splitter', build: (c) => {
    const g = group('splitter-step-05'); const s = splitterBlade(c, 0.34);
    slab(g, c.mat, s.w, s.t, 0.34, midX(c.box), s.y, s.z);
    slab(g, c.mat, s.w * 0.72, s.t * 0.8, 0.18, midX(c.box), s.y - 0.015, s.z + 0.10);
    return g; } },
  { id: 'splitter-curved-06', name: 'Curved Lip', kind: 'splitter', build: (c) => {
    const g = group('splitter-curved-06'); const s = splitterBlade(c, 0.32);
    for (const [dx, rx] of [[-1, 0.22], [0, 0], [1, -0.22]] as [number, number][]) {
      slab(g, c.mat, s.w / 3.2, s.t, 0.30, midX(c.box) + dx * s.w / 3.3, s.y + dx * 0.015, s.z, rx);
    }
    return g; } },
  { id: 'splitter-plate-07', name: 'Endplate Splitter', kind: 'splitter', build: (c) => {
    const g = group('splitter-plate-07'); const s = splitterBlade(c, 0.34);
    slab(g, c.mat, s.w, s.t, 0.34, midX(c.box), s.y, s.z);
    for (const sx of [-1, 1]) slab(g, c.mat, 0.02, 0.12, 0.34, midX(c.box) + sx * (s.w / 2), s.y + 0.06, s.z);
    return g; } },
  { id: 'splitter-twin-08', name: 'Twin Deck', kind: 'splitter', build: (c) => {
    const g = group('splitter-twin-08'); const s = splitterBlade(c, 0.32);
    slab(g, c.mat, s.w, s.t, 0.32, midX(c.box), s.y, s.z);
    slab(g, c.mat, s.w * 0.8, s.t, 0.22, midX(c.box), s.y + 0.16, s.z - 0.04);
    return g; } },
  { id: 'splitter-side-09', name: 'Side Blades', kind: 'splitter', build: (c) => {
    const g = group('splitter-side-09'); const s = splitterBlade(c, 0.28);
    slab(g, c.mat, s.w * 0.5, s.t, 0.40, midX(c.box), s.y, s.z);
    for (const sx of [-1, 1]) slab(g, c.mat, s.w * 0.24, s.t, 0.30, midX(c.box) + sx * (s.w * 0.36), s.y + 0.03, s.z + 0.05);
    return g; } },
  { id: 'splitter-aggr-10', name: 'Time Attack Front', kind: 'splitter', build: (c) => {
    const g = group('splitter-aggr-10'); const s = splitterBlade(c, 0.46);
    slab(g, c.mat, s.w, s.t, 0.46, midX(c.box), s.y, s.z);
    for (const sx of [-1, 1]) {
      slab(g, c.mat, 0.03, 0.18, 0.46, midX(c.box) + sx * (s.w / 2 - 0.015), s.y + 0.09, s.z);
      for (let i = 0; i < 2; i++) slab(g, c.mat, 0.18, 0.015, 0.12, midX(c.box) + sx * (s.w / 2 - 0.14), s.y + 0.14 + i * 0.1, s.z - 0.05, -0.4);
    }
    return g; } },
];

// ---- diffusers: under the rear, at the min z end ---------------------------------------------------------------
/** A diffuser plate angled up towards the rear (negative z), tucked under the bumper. */
function diffuserBase(ctx: AeroCtx, depth: number, yOff = 0.04) {
  const b = ctx.box;
  return { w: width(b) * 0.86, y: floorY(b) + yOff, z: b.min.z - depth / 2 + 0.06, d: depth };
}

function fins(g: THREE.Object3D, ctx: AeroCtx, n: number, w: number, z: number, y: number, d: number, h = 0.12) {
  for (let i = 0; i < n; i++) {
    const x = midX(ctx.box) + ((i / (n - 1)) - 0.5) * w * 0.86;
    slab(g, ctx.mat, 0.02, h, d, x, y - h / 2, z);
  }
}

const DIFFUSER_SPECS: AeroSpec[] = [
  { id: 'diffuser-plate-11', name: 'Flat Diffuser', kind: 'diffuser', build: (c) => {
    const g = group('diffuser-plate-11'); const s = diffuserBase(c, 0.42);
    slab(g, c.mat, s.w, 0.02, s.d, midX(c.box), s.y, s.z, -0.12); return g; } },
  { id: 'diffuser-fins4-12', name: 'Quad Fin', kind: 'diffuser', build: (c) => {
    const g = group('diffuser-fins4-12'); const s = diffuserBase(c, 0.46);
    slab(g, c.mat, s.w, 0.02, s.d, midX(c.box), s.y, s.z, -0.12); fins(g, c, 4, s.w, s.z, s.y, s.d); return g; } },
  { id: 'diffuser-fins6-13', name: 'Six Fin', kind: 'diffuser', build: (c) => {
    const g = group('diffuser-fins6-13'); const s = diffuserBase(c, 0.50);
    slab(g, c.mat, s.w, 0.02, s.d, midX(c.box), s.y, s.z, -0.14); fins(g, c, 6, s.w, s.z, s.y, s.d); return g; } },
  { id: 'diffuser-channel-14', name: 'Channel Rear', kind: 'diffuser', build: (c) => {
    const g = group('diffuser-channel-14'); const s = diffuserBase(c, 0.44);
    slab(g, c.mat, s.w, 0.02, s.d, midX(c.box), s.y, s.z, -0.12);
    for (const sx of [-1, 1]) slab(g, c.mat, 0.22, 0.06, s.d * 0.7, midX(c.box) + sx * s.w * 0.24, s.y + 0.04, s.z);
    fins(g, c, 2, s.w, s.z, s.y, s.d * 0.9);
    return g; } },
  { id: 'diffuser-twin-15', name: 'Twin Deck Rear', kind: 'diffuser', build: (c) => {
    const g = group('diffuser-twin-15'); const s = diffuserBase(c, 0.46);
    slab(g, c.mat, s.w, 0.02, s.d, midX(c.box), s.y, s.z, -0.12);
    slab(g, c.mat, s.w * 0.8, 0.02, s.d * 0.7, midX(c.box), s.y + 0.12, s.z - 0.02, -0.10);
    fins(g, c, 4, s.w * 0.8, s.z, s.y + 0.12, s.d * 0.7, 0.08);
    return g; } },
  { id: 'diffuser-strake-16', name: 'Strakes', kind: 'diffuser', build: (c) => {
    const g = group('diffuser-strake-16'); const s = diffuserBase(c, 0.42);
    slab(g, c.mat, s.w, 0.02, s.d, midX(c.box), s.y, s.z, -0.12);
    for (let i = 0; i < 5; i++) slab(g, c.mat, 0.02, 0.10, s.d * 0.8, midX(c.box) + (i - 2) * s.w * 0.17, s.y - 0.03, s.z - 0.02, -0.35);
    return g; } },
  { id: 'diffuser-max-17', name: 'Max Rear', kind: 'diffuser', build: (c) => {
    const g = group('diffuser-max-17'); const s = diffuserBase(c, 0.52);
    slab(g, c.mat, s.w, 0.02, s.d, midX(c.box), s.y, s.z, -0.14);
    fins(g, c, 7, s.w, s.z, s.y, s.d, 0.13);
    return g; } },
  { id: 'diffuser-vane-18', name: 'Vane Rear', kind: 'diffuser', build: (c) => {
    const g = group('diffuser-vane-18'); const s = diffuserBase(c, 0.44);
    slab(g, c.mat, s.w, 0.02, s.d, midX(c.box), s.y, s.z, -0.12);
    for (const dx of [-1, 0, 1]) slab(g, c.mat, s.w * 0.26, 0.015, s.d * 0.8, midX(c.box) + dx * s.w * 0.3, s.y + 0.06, s.z, -0.5);
    return g; } },
  { id: 'diffuser-step-19', name: 'Stepped Rear', kind: 'diffuser', build: (c) => {
    const g = group('diffuser-step-19'); const s = diffuserBase(c, 0.46);
    slab(g, c.mat, s.w, 0.02, s.d, midX(c.box), s.y, s.z, -0.10);
    slab(g, c.mat, s.w * 0.9, 0.02, s.d * 0.6, midX(c.box), s.y + 0.08, s.z - 0.04, -0.16);
    return g; } },
  { id: 'diffuser-endplate-20', name: 'Endplate Rear', kind: 'diffuser', build: (c) => {
    const g = group('diffuser-endplate-20'); const s = diffuserBase(c, 0.46);
    slab(g, c.mat, s.w, 0.02, s.d, midX(c.box), s.y, s.z, -0.12);
    for (const sx of [-1, 1]) slab(g, c.mat, 0.02, 0.16, s.d, midX(c.box) + sx * s.w / 2, s.y + 0.06, s.z);
    fins(g, c, 3, s.w, s.z, s.y, s.d * 0.8, 0.10);
    return g; } },
];

// ---- side skirts: blades along the sills, both sides ------------------------------------------------------------
function skirt(ctx: AeroCtx, depth: number, height: number, yOff: number, zLen: number, zOff = 0) {
  const b = ctx.box;
  return { x: width(b) / 2 - 0.02, y: floorY(b) + yOff, z: midZ(b) + zOff, d: depth, h: height, l: length(b) * zLen };
}

const SKIRT_SPECS: AeroSpec[] = [
  { id: 'skirt-blade-21', name: 'Blade Skirt', kind: 'skirt', build: (c) => {
    const g = group('skirt-blade-21'); const s = skirt(c, 0.07, 0.10, 0.10, 0.42);
    for (const sx of [-1, 1]) slab(g, c.mat, s.d, s.h, s.l, midX(c.box) + sx * s.x, s.y, s.z);
    return g; } },
  { id: 'skirt-step-22', name: 'Step Skirt', kind: 'skirt', build: (c) => {
    const g = group('skirt-step-22'); const s = skirt(c, 0.08, 0.08, 0.08, 0.40);
    for (const sx of [-1, 1]) {
      slab(g, c.mat, s.d, s.h, s.l, midX(c.box) + sx * s.x, s.y, s.z);
      slab(g, c.mat, s.d * 0.8, s.h, s.l * 0.94, midX(c.box) + sx * (s.x + 0.03), s.y - 0.05, s.z);
    }
    return g; } },
  { id: 'skirt-deep-23', name: 'Deep Skirt', kind: 'skirt', build: (c) => {
    const g = group('skirt-deep-23'); const s = skirt(c, 0.10, 0.18, 0.09, 0.46);
    for (const sx of [-1, 1]) slab(g, c.mat, s.d, s.h, s.l, midX(c.box) + sx * s.x, s.y - 0.02, s.z);
    return g; } },
  { id: 'skirt-split-24', name: 'Split Skirt', kind: 'skirt', build: (c) => {
    const g = group('skirt-split-24'); const s = skirt(c, 0.07, 0.12, 0.10, 0.20);
    for (const sx of [-1, 1]) for (const dz of [-1, 1]) slab(g, c.mat, s.d, s.h, s.l, midX(c.box) + sx * s.x, s.y, s.z + dz * s.l * 0.62);
    return g; } },
  { id: 'skirt-fin-25', name: 'Fin Skirt', kind: 'skirt', build: (c) => {
    const g = group('skirt-fin-25'); const s = skirt(c, 0.08, 0.10, 0.09, 0.42);
    for (const sx of [-1, 1]) {
      slab(g, c.mat, s.d, s.h, s.l, midX(c.box) + sx * s.x, s.y, s.z);
      for (const dz of [-1, 1]) slab(g, c.mat, 0.10, 0.14, 0.03, midX(c.box) + sx * (s.x + 0.02), s.y + 0.02, s.z + dz * s.l * 0.42);
    }
    return g; } },
  { id: 'skirt-winglet-26', name: 'Winglet Skirt', kind: 'skirt', build: (c) => {
    const g = group('skirt-winglet-26'); const s = skirt(c, 0.08, 0.10, 0.10, 0.38);
    for (const sx of [-1, 1]) {
      slab(g, c.mat, s.d, s.h, s.l, midX(c.box) + sx * s.x, s.y, s.z);
      slab(g, c.mat, 0.16, 0.015, 0.14, midX(c.box) + sx * (s.x + 0.10), s.y + 0.04, s.z + s.l * 0.36, -0.2);
    }
    return g; } },
  { id: 'skirt-twin-27', name: 'Twin Rail', kind: 'skirt', build: (c) => {
    const g = group('skirt-twin-27'); const s = skirt(c, 0.07, 0.06, 0.08, 0.44);
    for (const sx of [-1, 1]) for (const dy of [0, 0.12]) slab(g, c.mat, s.d, s.h, s.l, midX(c.box) + sx * s.x, s.y + dy, s.z);
    return g; } },
  { id: 'skirt-angled-28', name: 'Angled Skirt', kind: 'skirt', build: (c) => {
    const g = group('skirt-angled-28'); const s = skirt(c, 0.09, 0.12, 0.09, 0.30);
    for (const sx of [-1, 1]) for (const dz of [-1, 1]) slab(g, c.mat, s.d, s.h, s.l, midX(c.box) + sx * s.x, s.y, s.z + dz * s.l * 0.55, dz * 0.08);
    return g; } },
  { id: 'skirt-lip-29', name: 'Lip Skirt', kind: 'skirt', build: (c) => {
    const g = group('skirt-lip-29'); const s = skirt(c, 0.10, 0.08, 0.08, 0.44);
    for (const sx of [-1, 1]) {
      slab(g, c.mat, s.d, s.h, s.l, midX(c.box) + sx * s.x, s.y, s.z);
      slab(g, c.mat, 0.04, 0.05, s.l * 0.98, midX(c.box) + sx * (s.x - 0.02), s.y + 0.06, s.z);
    }
    return g; } },
  { id: 'skirt-cap-30', name: 'Cap Skirt', kind: 'skirt', build: (c) => {
    const g = group('skirt-cap-30'); const s = skirt(c, 0.08, 0.10, 0.09, 0.40);
    for (const sx of [-1, 1]) {
      slab(g, c.mat, s.d, s.h, s.l, midX(c.box) + sx * s.x, s.y, s.z);
      slab(g, c.mat, s.d * 1.1, 0.16, 0.03, midX(c.box) + sx * s.x, s.y, s.z - s.l / 2);
    }
    return g; } },
];

export const AERO_SPECS: AeroSpec[] = [...SPLITTER_SPECS, ...DIFFUSER_SPECS, ...SKIRT_SPECS];
