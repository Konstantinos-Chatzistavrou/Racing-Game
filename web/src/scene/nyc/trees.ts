// Photoreal street trees for the near range (~80 m around the camera; farther trees keep the low-poly crowns in
// props.ts). Per species: a branching skeleton grown from its habit (London planetree, honeylocust, Callery pear, pin
// oak, littleleaf linden) as bark tubes with the scanned bark (colour + normal), and 240-280 leaf-spray cards (the
// species' scanned leaves composed on twigs: assets_source/scripts/make_trees.py) over the crown, alpha-tested,
// lit with normals bent outward from the crown centre (soft, volumetric shading) and darkened towards the inside.
import * as THREE from 'three/webgpu';
import { attribute, hash, instanceIndex, mix, texture, uv, vec3 } from 'three/tsl';
import type { TreeSpecies } from './props';

interface Habit {
  bark: 'plane' | 'furrowed' | 'ridged';
  cell: number;                 // leaf atlas cell
  trunkH: number; trunkR: number;
  crown: { y0: number; y1: number; r: number; shape: 'dome' | 'vase' | 'teardrop' | 'pyramid' | 'oval' };
  limbs: number; leader: boolean; droop: number;
  cards: number; cardSize: number;
}
const HABIT: Record<TreeSpecies, Habit> = {
  plane: { bark: 'plane', cell: 0, trunkH: 2.6, trunkR: 0.24, crown: { y0: 3.6, y1: 9.4, r: 4.0, shape: 'dome' }, limbs: 5, leader: false, droop: 0, cards: 260, cardSize: 1.85 },
  locust: { bark: 'furrowed', cell: 1, trunkH: 2.3, trunkR: 0.19, crown: { y0: 4.2, y1: 8.6, r: 3.6, shape: 'vase' }, limbs: 4, leader: false, droop: 0, cards: 280, cardSize: 1.4 },
  pear: { bark: 'ridged', cell: 2, trunkH: 1.7, trunkR: 0.17, crown: { y0: 2.4, y1: 8.8, r: 2.4, shape: 'teardrop' }, limbs: 5, leader: false, droop: 0, cards: 260, cardSize: 1.5 },
  oak: { bark: 'furrowed', cell: 3, trunkH: 2.0, trunkR: 0.21, crown: { y0: 2.2, y1: 10.0, r: 3.1, shape: 'pyramid' }, limbs: 9, leader: true, droop: 0.35, cards: 240, cardSize: 1.6 },
  linden: { bark: 'ridged', cell: 4, trunkH: 2.2, trunkR: 0.19, crown: { y0: 2.9, y1: 9.0, r: 2.8, shape: 'oval' }, limbs: 6, leader: true, droop: 0.1, cards: 250, cardSize: 1.55 },
};

/** Crown radius at height y for a habit (0 outside the crown). */
function crownR(h: Habit, y: number) {
  const { y0, y1, r, shape } = h.crown, t = (y - y0) / (y1 - y0);
  if (t < 0 || t > 1) return 0;
  switch (shape) {
    case 'dome': return r * Math.sqrt(Math.max(0, 1 - Math.pow(2 * t - 0.8, 2) / 1.44));
    case 'vase': return r * Math.min(1, 0.45 + 1.1 * t) * Math.sqrt(Math.max(0, 1 - Math.pow(t, 4)));
    case 'teardrop': return r * Math.sin(Math.PI * Math.pow(t, 0.75));
    case 'pyramid': return r * Math.pow(1 - t, 0.8) * Math.min(1, 0.4 + 3 * t);
    default: return r * Math.sin(Math.PI * t);
  }
}

function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

class Builder {
  pos: number[] = []; nrm: number[] = []; uv: number[] = []; ao: number[] = []; idx: number[] = [];
  /** tapered tube along points (radius r0 -> r1), bark UVs in metres / 0.7 */
  tube(pts: THREE.Vector3[], r0: number, r1: number, radial: number) {
    const base = this.pos.length / 3, up = new THREE.Vector3(0, 1, 0), t = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3();
    let len = 0;
    for (let i = 0; i < pts.length; i++) {
      if (i) len += pts[i].distanceTo(pts[i - 1]);
      t.subVectors(pts[Math.min(pts.length - 1, i + 1)], pts[Math.max(0, i - 1)]).normalize();
      a.crossVectors(Math.abs(t.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : up, t).normalize();
      b.crossVectors(t, a);
      const r = r0 + (r1 - r0) * (i / (pts.length - 1));
      for (let k = 0; k <= radial; k++) {
        const ang = (k / radial) * Math.PI * 2, c = Math.cos(ang), s = Math.sin(ang);
        const nx = a.x * c + b.x * s, ny = a.y * c + b.y * s, nz = a.z * c + b.z * s;
        this.pos.push(pts[i].x + nx * r, pts[i].y + ny * r, pts[i].z + nz * r);
        this.nrm.push(nx, ny, nz);
        this.uv.push((k / radial) * Math.max(1, Math.round((2 * Math.PI * r) / 0.7 * 2)) / 2, len / 0.7);
        this.ao.push(1);
      }
    }
    for (let i = 0; i + 1 < pts.length; i++) for (let k = 0; k < radial; k++) {
      const p = base + i * (radial + 1) + k, q = p + radial + 1;
      this.idx.push(p, q, p + 1, p + 1, q, q + 1);
    }
  }
  /** a two-sided card (two quads, outward normals) centred at c, facing n, rolled; UVs into the atlas cell */
  card(c: THREE.Vector3, n: THREE.Vector3, roll: number, size: number, cell: number, crownC: THREE.Vector3, shade: number) {
    const t = new THREE.Vector3().crossVectors(Math.abs(n.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0), n).normalize();
    const bt = new THREE.Vector3().crossVectors(n, t);
    const cr = Math.cos(roll), sr = Math.sin(roll);
    const u = t.clone().multiplyScalar(cr).addScaledVector(bt, sr), v = t.clone().multiplyScalar(-sr).addScaledVector(bt, cr);
    const bent = c.clone().sub(crownC).normalize().multiplyScalar(0.75).addScaledVector(n, 0.25).normalize();
    const cu = (cell % 4) / 4, cv = 1 - (Math.floor(cell / 4) + 1) / 2;
    const corners: [number, number][] = [[-0.5, 0], [0.5, 0], [0.5, 1], [-0.5, 1]];   // card base at the twig end (v = 0)
    for (const side of [1, -1]) {
      const base = this.pos.length / 3;
      for (const [x, y] of corners) {
        const p = c.clone().addScaledVector(u, x * size).addScaledVector(v, (y - 0.35) * size);
        this.pos.push(p.x, p.y, p.z);
        this.nrm.push(bent.x, bent.y, bent.z);
        this.uv.push(cu + (side > 0 ? x + 0.5 : 0.5 - x) * 0.25, cv + y * 0.5);
        this.ao.push(shade);
      }
      if (side > 0) this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      else this.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('ao', new THREE.Float32BufferAttribute(this.ao, 1));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/** Bark and leaf geometry of one species (deterministic). */
export function buildTree(sp: TreeSpecies): { bark: THREE.BufferGeometry; leaves: THREE.BufferGeometry; bark_kind: Habit['bark'] } {
  const h = HABIT[sp], R = rng(7919 * (sp.length + 3) + sp.charCodeAt(0) * 131);
  const B = new Builder(), L = new Builder();
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  // trunk with a slight lean and flare
  const lean = V((R() - 0.5) * 0.15, 0, (R() - 0.5) * 0.15);
  const trunk = [V(0, 0, 0), V(lean.x * 0.3, h.trunkH * 0.35, lean.z * 0.3), V(lean.x * 0.7, h.trunkH * 0.7, lean.z * 0.7), V(lean.x, h.trunkH, lean.z)];
  B.tube([V(0, 0, 0), V(0, 0.35, 0)], h.trunkR * 1.35, h.trunkR * 1.05, 10);
  B.tube(trunk, h.trunkR, h.trunkR * 0.78, 10);
  const top = trunk[trunk.length - 1].clone();
  if (h.leader) B.tube([top, V(top.x, (h.crown.y0 + h.crown.y1) / 2, top.z), V(top.x * 1.2, h.crown.y1 - 0.4, top.z * 1.2)], h.trunkR * 0.78, 0.04, 7);
  const tips: THREE.Vector3[] = [];
  const crownC = V(0, (h.crown.y0 + h.crown.y1) / 2, 0);
  for (let i = 0; i < h.limbs; i++) {
    const ang = (i / h.limbs) * Math.PI * 2 + R() * 0.6;
    const fy = h.leader ? h.crown.y0 + (h.crown.y1 - h.crown.y0) * (0.08 + 0.78 * (i / h.limbs)) : top.y;
    const start = h.leader ? V(top.x, fy, top.z) : top.clone();
    const ty = h.leader ? fy + (0.4 - h.droop) * 1.2 : h.crown.y0 + (h.crown.y1 - h.crown.y0) * (0.35 + 0.35 * R());
    const rr = Math.max(0.6, crownR(h, ty) * (0.75 + 0.2 * R()));
    const end = V(Math.cos(ang) * rr, ty, Math.sin(ang) * rr);
    const mid = start.clone().lerp(end, 0.5); mid.y += 0.5 - h.droop;
    const r0 = h.trunkR * (h.leader ? 0.38 : 0.58) * (0.85 + 0.3 * R());
    B.tube([start, mid, end], r0, r0 * 0.4, 6);
    // sub-branches and twigs towards the crown shell
    for (let j = 0; j < 3; j++) {
      const s0 = start.clone().lerp(end, 0.45 + 0.25 * j);
      const a2 = ang + (R() - 0.5) * 1.4, y2 = s0.y + (R() - 0.25) * 1.6;
      const r2 = Math.max(0.4, crownR(h, y2) * (0.85 + 0.15 * R()));
      const e2 = V(Math.cos(a2) * r2, Math.max(h.crown.y0, Math.min(h.crown.y1, y2)), Math.sin(a2) * r2);
      const m2 = s0.clone().lerp(e2, 0.5); m2.y += 0.25 - h.droop * 0.6;
      B.tube([s0, m2, e2], r0 * 0.45, 0.025, 5);
      tips.push(e2);
    }
    tips.push(end);
  }
  // leaf cards: points in the crown shell (0.55..1.0 of the envelope), denser outside, facing outwards
  const ext = h.crown.y1 - h.crown.y0;
  for (let k = 0, n = 0; n < h.cards && k < h.cards * 30; k++) {
    const y = h.crown.y0 + ext * R(), cr = crownR(h, y);
    if (cr < 0.25) continue;
    const a = R() * Math.PI * 2, d = cr * Math.pow(0.55 + 0.45 * R(), 0.6);
    const c = V(Math.cos(a) * d, y, Math.sin(a) * d);
    const out = c.clone().sub(V(0, y - 0.6, 0)).normalize();
    const nrm = out.clone().add(V((R() - 0.5) * 0.9, (R() - 0.3) * 0.9, (R() - 0.5) * 0.9)).normalize();
    const depth = d / cr;   // 1 = outer shell
    L.card(c, nrm, R() * Math.PI * 2, h.cardSize * (0.8 + 0.4 * R()), h.cell, crownC, 0.42 + 0.58 * depth);
    n++;
  }
  return { bark: B.geometry(), leaves: L.geometry(), bark_kind: h.bark };
}

const loader = new THREE.TextureLoader();
const tex = (url: string, srgb: boolean, repeat = true) => {
  const t = loader.load(url);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
};
let leafMat: THREE.MeshStandardNodeMaterial | null = null;
const barkMats = new Map<string, THREE.MeshStandardNodeMaterial>();

/** Leaves: the atlas, alpha-tested, per-tree tone variation, darker inside the crown. */
export function leafMaterial() {
  if (leafMat) return leafMat;
  const map = tex('/assets/trees/leaves.webp', true, false);
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.72, metalness: 0, side: THREE.FrontSide });
  const t = texture(map, uv());
  const ao = attribute('ao', 'float');
  const tone = mix(vec3(0.86, 0.95, 0.82), vec3(1.08, 1.04, 0.92), hash(instanceIndex));
  m.colorNode = t.rgb.mul(tone).mul(ao.mul(ao).mul(0.85).add(0.15));
  m.opacityNode = t.a;
  m.alphaTest = 0.45;
  leafMat = m;
  return m;
}
export function barkMaterial(kind: string) {
  let m = barkMats.get(kind);
  if (!m) {
    m = new THREE.MeshStandardNodeMaterial({ map: tex(`/assets/trees/bark_${kind}.jpg`, true), normalMap: tex(`/assets/trees/bark_${kind}_n.jpg`, false), roughness: 0.92, metalness: 0 });
    m.normalScale.set(1.2, 1.2);
    m.color.setScalar(kind === 'plane' ? 0.75 : 0.62);
    barkMats.set(kind, m);
  }
  return m;
}
