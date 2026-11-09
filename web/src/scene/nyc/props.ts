// New York street furniture + breakable metal poles & shatterable glass storefronts, instanced and streamed per tile.
//
//   const props = new NycProps(scene, camera);  await props.warm(renderer);
//   props.setTile('0_0', json);  props.setTileBuildings('0_0', blds, z);  props.removeTile('0_0');
//   props.update(dt, carPos, carVel, onImpact);  props.dispose();
//
// Design:
//  * Pre-allocated InstancedMeshes per kind (lamp, tree, signalR, signalL, hydrant, bench, bus, subway, steam, scaffold, cone, kiosk, waste,
//    steam puffs, lamp light pools, signs, shattered storefront cavities, 3D glass shards, and electric/metal collision sparks);
//  * Breakable Metal Poles: colliding with any lamp, traffic signal, hydrant, bus shelter, kiosk, or waste bin detaches its instance slot into
//    a 3D rigid-body simulation (flying, tumbling end-over-end, bouncing off the wet asphalt with metallic sparks, and extinguishing its lamp light);
//  * Breakable Glass Storefronts: colliding with or scraping a building's ground-floor wall shatters the storefront bay at the impact point,
//    placing a jagged broken-glass cavity on the facade and exploding 45 spinning 3D glass prism shards across the sidewalk and street.
import * as THREE from 'three/webgpu';
import { attribute, instancedBufferAttribute, instanceIndex, hash, uv, float, vec3, vec4, mix, smoothstep, fract, mod, step, select, length, positionView,
  positionWorld, cameraProjectionMatrix, cameraViewMatrix, positionGeometry, sin, cos, bumpMap } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { barkMaterial, buildTree, leafMaterial } from './trees';
import { InstanceSet, NycSigns, nycTime, writeMatrix, SIGN_LIGHT } from './signage';
import { instanceSlots } from '../instancing';

export interface PropsData {
  /** ground height of the tile (m); props are placed at z + this. Optional, default 0. */
  z?: number;
  lamp?: number[][]; tree?: number[][]; signal?: number[][]; hydrant?: number[][]; bench?: number[][]; bus_stop?: number[][];
  subway_entrance?: number[][]; steam?: number[][]; scaffold?: number[][]; cone?: number[][]; kiosk?: number[][]; waste?: number[][]; sign?: number[][];
}

export interface BuildingColliderBox {
  cx: number; cy: number; z0: number; z1: number; hx: number; hy: number; yaw: number;
}

type RGB = [number, number, number];

// ---- geometry kit (three frame: y up, +x = the prop's forward / arm direction, z lateral) ---------------------------------------------------
class Kit {
  parts: THREE.BufferGeometry[] = [];
  private add(g: THREE.BufferGeometry, col: RGB, glow: number) {
    const n = g.index ? g.toNonIndexed() : g;
    n.deleteAttribute('uv');
    n.computeVertexNormals();
    const c = new Float32Array(n.attributes.position.count * 3), w = new Float32Array(n.attributes.position.count).fill(glow);
    for (let i = 0; i < n.attributes.position.count; i++) { c[i * 3] = col[0]; c[i * 3 + 1] = col[1]; c[i * 3 + 2] = col[2]; }
    n.setAttribute('color', new THREE.BufferAttribute(c, 3));
    n.setAttribute('glow', new THREE.BufferAttribute(w, 1));
    this.parts.push(n);
    return this;
  }
  box(w: number, h: number, d: number, x: number, y: number, z: number, col: RGB, glow = 0) {
    return this.add(new THREE.BoxGeometry(w, h, d).translate(x, y, z), col, glow);
  }
  /** cylinder with its base at y */
  cyl(rb: number, rt: number, h: number, x: number, y: number, z: number, col: RGB, glow = 0, radial = 8) {
    return this.add(new THREE.CylinderGeometry(rt, rb, h, radial, 1, true).translate(x, y + h / 2, z), col, glow);
  }
  /** Angled branch/limb cylinder from (x0, y0, z0) to (x1, y1, z1). */
  limb(rb: number, rt: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, col: RGB, glow = 0, radial = 6) {
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-3) return this;
    const g = new THREE.CylinderGeometry(rt, rb, len, radial, 1, true);
    const up = new THREE.Vector3(0, 1, 0);
    const dir = new THREE.Vector3(dx / len, dy / len, dz / len);
    const q = new THREE.Quaternion().setFromUnitVectors(up, dir);
    const m = new THREE.Matrix4().compose(new THREE.Vector3((x0 + x1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5), q, new THREE.Vector3(1, 1, 1));
    g.applyMatrix4(m);
    return this.add(g, col, glow);
  }
  ico(r: number, x: number, y: number, z: number, sx: number, sy: number, sz: number, col: RGB, glow = 0, detail = 0) {
    const g = new THREE.IcosahedronGeometry(r, detail);
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const vx = pos.getX(i), vy = pos.getY(i), vz = pos.getZ(i);
      const crinkle = 0.72 + 0.42 * Math.sin(vx * 7.3 + x * 2.1 + vy * 5.7) * Math.cos(vz * 6.9 + z * 1.7 - vx * 4.1);
      pos.setXYZ(i, vx * sx * crinkle + x, vy * sy * crinkle + y, vz * sz * crinkle + z);
    }
    const n = g.index ? g.toNonIndexed() : g;
    n.deleteAttribute('uv');
    n.computeVertexNormals();
    const nrm = n.attributes.normal as THREE.BufferAttribute;
    const nPos = n.attributes.position as THREE.BufferAttribute;
    const c = new Float32Array(nPos.count * 3), w = new Float32Array(nPos.count);
    for (let i = 0; i < nPos.count; i++) {
      const ny = nrm.getY(i);
      const px = nPos.getX(i), py = nPos.getY(i), pz = nPos.getZ(i);
      const leafShade = Math.max(0.32, Math.min(1.38, 0.78 + 0.35 * ny + 0.25 * Math.sin(px * 9.1 + py * 7.3 + pz * 8.7)));
      c[i * 3] = col[0] * leafShade;
      c[i * 3 + 1] = col[1] * leafShade;
      c[i * 3 + 2] = col[2] * leafShade;
      w[i] = glow * Math.max(0.15, 0.65 - 0.35 * ny);
    }
    n.setAttribute('color', new THREE.BufferAttribute(c, 3));
    n.setAttribute('glow', new THREE.BufferAttribute(w, 1));
    this.parts.push(n);
    return this;
  }
  sphere(r: number, x: number, y: number, z: number, col: RGB, glow = 0) {
    return this.add(new THREE.SphereGeometry(r, 8, 6).translate(x, y, z), col, glow);
  }
  build() {
    const g = mergeGeometries(this.parts, false)!;
    for (const p of this.parts) p.dispose();
    g.computeBoundingSphere();
    return g;
  }
}

const GREY: RGB = [0.08, 0.085, 0.095], DARK: RGB = [0.03, 0.032, 0.038], GREEN_MET: RGB = [0.04, 0.16, 0.1];

function lampGeo() {
  const k = new Kit();
  k.cyl(0.16, 0.14, 0.95, 0, 0, 0, GREY, 0, 8);                       // cast-iron octagon base
  k.cyl(0.10, 0.065, 8.5, 0, 0.95, 0, GREY, 0, 8);                    // tapered steel shaft
  k.box(2.35, 0.09, 0.09, 1.15, 9.35, 0, GREY);                       // mast arm
  k.box(0.95, 0.14, 0.38, 2.25, 9.3, 0, [0.11, 0.11, 0.12]);          // cobra head housing
  k.box(0.78, 0.03, 0.3, 2.25, 9.2, 0, [1.0, 0.64, 0.3], 1);          // warm high-pressure sodium / LED luminaire
  // NYC blue/white street-name blade sign on pole
  k.box(0.12, 0.22, 0.85, 0, 4.2, 0.38, [0.05, 0.22, 0.55], 0.15);
  return k.build();
}

/**
 * New York street trees: the five most planted species of the 2015 NYC Street Tree Census, weighted by their share
 * among these five (London planetree 12.7 %, honeylocust 9.9 %, Callery pear 9.0 %, pin oak 7.0 %, littleleaf linden
 * 4.6 % of all street trees). Each has its own silhouette and leaf colour; a tree's species comes from a hash of its
 * position, so it is the same on every visit. ~800-1150 triangles each (the old single model was ~1700).
 */
export const TREE_SPECIES = [
  { id: 'plane', w: 0.29 },    // London planetree: broad round crown on spreading limbs, mottled cream / olive bark
  { id: 'locust', w: 0.23 },   // honeylocust: airy vase, fine light leaves, branches show through
  { id: 'pear', w: 0.21 },     // Callery pear: dense upright teardrop, glossy mid green
  { id: 'oak', w: 0.16 },      // pin oak: central leader, narrowing tiers, drooping lower branches, dark green
  { id: 'linden', w: 0.11 },   // littleleaf linden: dense symmetric pyramid-oval
] as const;
export type TreeSpecies = typeof TREE_SPECIES[number]['id'];
/** photoreal tree range (m around the camera) and its capacity per species */
const NEAR_CAP = 90;
export function speciesOf(x: number, y: number): TreeSpecies {
  const h = Math.abs(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1;
  let acc = 0;
  for (const sp of TREE_SPECIES) { acc += sp.w; if (h < acc) return sp.id; }
  return TREE_SPECIES[0].id;
}

/** Sidewalk tree pit: granite border, mulch, cast-iron guard (NYC Parks standard). */
function treePit(k: Kit) {
  k.box(1.55, 0.08, 1.55, 0, 0.04, 0, [0.18, 0.18, 0.17], 0);
  k.box(1.35, 0.09, 1.35, 0, 0.05, 0, [0.035, 0.026, 0.020], 0);
  for (const s of [-0.68, 0.68]) {
    k.box(1.38, 0.03, 0.03, 0, 0.36, s, DARK, 0);
    k.box(0.03, 0.03, 1.38, s, 0.36, 0, DARK, 0);
    k.cyl(0.02, 0.02, 0.36, s, 0, s, DARK, 0, 4);
    k.cyl(0.02, 0.02, 0.36, s, 0, -s, DARK, 0, 4);
  }
}
const ring = (n: number, r: number, off = 0) => Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2 + off; return [Math.cos(a) * r, Math.sin(a) * r] as const; });

function treeGeo(sp: TreeSpecies) {
  const k = new Kit();
  treePit(k);
  const bark: RGB = [0.052, 0.040, 0.030], barkMid: RGB = [0.068, 0.054, 0.040];
  if (sp === 'plane') {
    // mottled bark: cream and olive patches
    const p1: RGB = [0.13, 0.12, 0.09], p2: RGB = [0.085, 0.085, 0.065];
    k.cyl(0.25, 0.2, 1.0, 0, 0, 0, p2, 0, 7);
    k.limb(0.2, 0.16, 0, 0.95, 0, 0.05, 2.6, 0.02, p1, 0, 7);
    const leaf: RGB = [0.020, 0.046, 0.018];
    for (const [i, [cx, cz]] of ring(5, 1.0, 0.3).entries()) {
      k.limb(0.12, 0.08, 0.04, 2.5, 0.02, cx * 1.9, 4.6, cz * 1.9, i % 2 ? p1 : p2, 0, 5);
      k.limb(0.08, 0.045, cx * 1.9, 4.6, cz * 1.9, cx * 3.0, 6.0, cz * 3.0, p1, 0, 4);
      k.ico(1.35, cx * 2.9, 6.1, cz * 2.9, 1.1, 0.85, 1.1, leaf, 0.12, 0);
    }
    for (const [cx, cz] of ring(5, 1.8, 0.93)) k.ico(1.28, cx, 7.3, cz, 1.05, 0.9, 1.05, [0.022, 0.050, 0.020], 0.03, 0);
    k.ico(1.5, 0, 6.3, 0, 1.0, 0.8, 1.0, [0.016, 0.038, 0.015], 0, 0);
    k.ico(1.2, 0.3, 8.2, -0.2, 1.0, 0.85, 1.0, [0.024, 0.054, 0.022], 0, 0);
    k.ico(1.05, -0.6, 7.9, 0.6, 1.0, 0.85, 1.0, [0.022, 0.050, 0.020], 0, 0);
  } else if (sp === 'locust') {
    k.cyl(0.2, 0.15, 1.0, 0, 0, 0, bark, 0, 6);
    k.limb(0.15, 0.12, 0, 0.95, 0, 0, 2.3, 0, bark, 0, 6);
    const leaf: RGB = [0.034, 0.052, 0.015];
    for (const [i, [cx, cz]] of ring(4, 1.0, 0.4).entries()) {
      k.limb(0.09, 0.055, 0, 2.2, 0, cx * 2.0, 5.1, cz * 2.0, barkMid, 0, 5);
      k.limb(0.05, 0.03, cx * 2.0, 5.1, cz * 2.0, cx * 3.0, 6.8, cz * 3.0, barkMid, 0, 4);
      k.limb(0.04, 0.025, cx * 1.5, 4.3, cz * 1.5, cx * 2.6 - cz * 0.9, 5.6, cz * 2.6 + cx * 0.9, barkMid, 0, 4);
      void i;
    }
    // airy: small sprays with gaps, the branches stay visible
    for (const [i, [cx, cz]] of ring(7, 2.7, 0.2).entries()) k.ico(0.72, cx, 6.3 + (i % 2) * 0.6, cz, 1.25, 0.6, 1.25, leaf, 0.1, 0);
    for (const [cx, cz] of ring(5, 1.5, 0.7)) k.ico(0.7, cx, 7.3, cz, 1.2, 0.6, 1.2, [0.038, 0.058, 0.017], 0.02, 0);
    k.ico(0.68, 0, 7.9, 0, 1.2, 0.6, 1.2, [0.038, 0.058, 0.017], 0, 0);
  } else if (sp === 'pear') {
    k.cyl(0.18, 0.15, 1.6, 0, 0, 0, bark, 0, 6);
    for (const [cx, cz] of ring(4, 0.9, 0.5)) k.limb(0.09, 0.05, 0, 1.5, 0, cx, 4.6, cz, barkMid, 0, 4);
    const leaf: RGB = [0.024, 0.052, 0.024];
    k.ico(1.45, 0, 3.6, 0, 1.25, 1.0, 1.25, [0.020, 0.045, 0.021], 0.12, 0);
    for (const [cx, cz] of ring(4, 1.1, 0.0)) k.ico(1.25, cx, 4.8, cz, 1.0, 1.05, 1.0, leaf, 0.05, 0);
    for (const [cx, cz] of ring(3, 0.8, 0.6)) k.ico(1.15, cx, 6.2, cz, 1.0, 1.05, 1.0, leaf, 0, 0);
    k.ico(1.0, 0, 7.3, 0, 1.0, 1.1, 1.0, [0.026, 0.056, 0.026], 0, 0);
    k.ico(0.7, 0.1, 8.2, 0, 1.0, 1.1, 1.0, [0.028, 0.060, 0.028], 0, 0);
  } else if (sp === 'oak') {
    k.cyl(0.21, 0.17, 1.0, 0, 0, 0, bark, 0, 6);
    k.limb(0.17, 0.05, 0, 0.95, 0, 0.05, 9.4, 0, barkMid, 0, 6);   // central leader
    const leaf: RGB = [0.017, 0.038, 0.016];
    for (const [cx, cz] of ring(4, 1.0, 0.2)) k.limb(0.075, 0.035, 0, 3.0, 0, cx * 2.6, 2.6, cz * 2.6, barkMid, 0, 4);   // drooping
    for (const [cx, cz] of ring(4, 1.0, 0.98)) k.limb(0.06, 0.03, 0, 5.0, 0, cx * 2.1, 5.6, cz * 2.1, barkMid, 0, 4);
    for (const [cx, cz] of ring(4, 2.3, 0.2)) k.ico(1.1, cx, 3.2, cz, 1.2, 0.72, 1.2, leaf, 0.12, 0);
    for (const [cx, cz] of ring(4, 1.75, 0.98)) k.ico(1.05, cx, 5.2, cz, 1.15, 0.78, 1.15, leaf, 0.03, 0);
    for (const [cx, cz] of ring(3, 1.05, 0.4)) k.ico(0.95, cx, 7.0, cz, 1.1, 0.85, 1.1, [0.019, 0.042, 0.018], 0, 0);
    k.ico(0.8, 0, 8.6, 0, 1.0, 0.95, 1.0, [0.020, 0.044, 0.019], 0, 0);
    k.ico(0.5, 0, 9.5, 0, 1.0, 1.0, 1.0, [0.021, 0.046, 0.020], 0, 0);
  } else {
    // littleleaf linden
    k.cyl(0.2, 0.16, 1.0, 0, 0, 0, bark, 0, 6);
    k.limb(0.16, 0.12, 0, 0.95, 0, 0, 2.2, 0, bark, 0, 6);
    for (const [cx, cz] of ring(4, 1.0, 0.3)) k.limb(0.08, 0.04, 0, 2.1, 0, cx * 1.3, 5.2, cz * 1.3, barkMid, 0, 4);
    const leaf: RGB = [0.026, 0.054, 0.022];
    k.ico(1.4, 0, 5.0, 0, 1.0, 1.0, 1.0, [0.020, 0.044, 0.018], 0, 0);
    for (const [cx, cz] of ring(5, 2.0, 0.1)) k.ico(1.15, cx, 3.9, cz, 1.05, 0.85, 1.05, leaf, 0.12, 0);
    for (const [cx, cz] of ring(4, 1.5, 0.75)) k.ico(1.05, cx, 5.7, cz, 1.0, 0.9, 1.0, leaf, 0.03, 0);
    for (const [cx, cz] of ring(3, 0.9, 0.2)) k.ico(0.9, cx, 7.3, cz, 1.0, 0.95, 1.0, [0.028, 0.058, 0.024], 0, 0);
    k.ico(0.75, 0, 8.5, 0, 1.0, 1.0, 1.0, [0.030, 0.060, 0.025], 0, 0);
  }
  return k.build();
}

function signalGeo(side: 1 | -1) {
  const k = new Kit();
  const f = -side;
  k.cyl(0.14, 0.14, 0.75, 0, 0, 0, [0.22, 0.16, 0.03], 0, 8);         // NYC yellow/bronze base
  k.cyl(0.095, 0.075, 5.55, 0, 0.75, 0, [0.24, 0.18, 0.04], 0, 8);
  k.box(7.0, 0.1, 0.1, 3.5, 6.1, 0, GREY);
  // NYC green street name sign on mast arm
  k.box(1.4, 0.32, 0.06, 2.1, 6.1, f * 0.08, [0.03, 0.24, 0.11], 0.18);
  for (const x of [6.2, 3.6]) {
    k.box(0.4, 1.2, 0.32, x, 5.45, 0, [0.18, 0.13, 0.02]);            // NYC yellow signal housing
    k.box(0.5, 1.3, 0.04, x, 5.45, -f * 0.17, [0.03, 0.03, 0.03]);
    k.box(0.26, 0.26, 0.06, x, 5.8, f * 0.17, [1, 0.1, 0.06], 1);
    k.box(0.26, 0.26, 0.06, x, 5.45, f * 0.17, [1, 0.72, 0.06], 2);
    k.box(0.26, 0.26, 0.06, x, 5.1, f * 0.17, [0.1, 1, 0.45], 3);
  }
  return k.build();
}

function hydrantGeo() {
  const k = new Kit();
  const body: RGB = [0.04, 0.04, 0.045], dome: RGB = [0.68, 0.7, 0.74]; // NYC black body + silver bonnet
  k.cyl(0.14, 0.12, 0.55, 0, 0, 0, body, 0, 8);
  k.cyl(0.16, 0.16, 0.08, 0, 0.55, 0, dome, 0, 8);
  k.sphere(0.12, 0, 0.7, 0, dome);
  k.box(0.32, 0.1, 0.1, 0, 0.38, 0, dome);
  k.box(0.1, 0.1, 0.12, 0.17, 0.28, 0, dome);
  return k.build();
}

function benchGeo() {
  const k = new Kit();
  const wood: RGB = [0.14, 0.09, 0.05];
  k.box(0.5, 0.06, 1.8, 0, 0.45, 0, wood);
  k.box(0.05, 0.5, 1.8, -0.24, 0.78, 0, wood);
  for (const z of [-0.8, 0.8]) k.box(0.45, 0.45, 0.06, 0, 0.22, z, DARK);
  return k.build();
}

function busGeo() {
  const k = new Kit();
  const metal: RGB = [0.05, 0.055, 0.065];
  k.box(1.6, 0.1, 3.7, 0, 2.55, 0, metal);
  for (const z of [-1.75, 1.75]) for (const x of [-0.7, 0.7]) k.cyl(0.045, 0.045, 2.5, x, 0, z, metal, 0, 6);
  k.box(0.06, 1.9, 3.6, -0.72, 1.25, 0, [0.03, 0.06, 0.09]);
  k.box(0.07, 1.5, 1.1, -0.66, 1.3, 1.15, [0.82, 0.92, 1.0], 0.55);
  k.box(0.07, 0.9, 1.1, -0.66, 1.3, -0.1, [0.95, 0.62, 0.32], 0.3);
  k.box(0.5, 0.05, 2.2, -0.35, 0.45, -0.3, metal);
  k.box(0.05, 0.12, 3.7, 0.78, 2.45, 0, [0.9, 0.92, 0.98], 0.75);
  return k.build();
}

function subwayGeo() {
  const k = new Kit();
  k.box(3.4, 0.03, 1.8, 0, 0.02, 0, [0.005, 0.005, 0.006]);
  for (const z of [-0.95, 0.95]) {
    k.box(3.4, 0.07, 0.07, 0, 1.05, z, GREEN_MET);
    k.box(3.4, 0.07, 0.07, 0, 0.55, z, GREEN_MET);
    for (const x of [-1.6, -0.8, 0, 0.8, 1.6]) k.cyl(0.035, 0.035, 1.05, x, 0, z, GREEN_MET, 0, 6);
  }
  for (const x of [-1.75, 1.75]) {
    k.cyl(0.07, 0.07, 2.5, x, 0, 0.95, GREEN_MET, 0, 6);
    k.sphere(0.24, x, 2.75, 0.95, [0.25, 1.0, 0.4], 1);
  }
  return k.build();
}

function steamGeo() {
  const k = new Kit();
  for (let i = 0; i < 6; i++) k.cyl(0.24, 0.24, 0.5, 0, i * 0.5, 0, i % 2 ? [0.82, 0.82, 0.8] : [0.88, 0.26, 0.04], 0, 8);
  k.cyl(0.24, 0.1, 0.35, 0, 3.0, 0, [0.88, 0.26, 0.04], 0, 8);
  k.cyl(0.3, 0.3, 0.12, 0, 0, 0, DARK, 0, 8);
  return k.build();
}

function scaffoldGeo() {
  const k = new Kit();
  const green: RGB = [0.025, 0.11, 0.065];
  k.box(4.0, 0.12, 3.5, 0, 3.65, 0, green);
  for (const x of [-1.95, 1.95]) for (const z of [-1.7, 1.7]) k.cyl(0.05, 0.05, 3.6, x, 0, z, [0.1, 0.12, 0.1], 0, 6);
  k.box(4.0, 0.1, 0.1, 0, 3.4, -1.7, [0.1, 0.12, 0.1]);
  k.box(4.0, 0.1, 0.1, 0, 3.4, 1.7, [0.1, 0.12, 0.1]);
  k.box(3.7, 0.05, 0.05, 0, 3.52, 0, [1.0, 0.85, 0.55], 1);
  k.box(4.0, 0.9, 0.06, 0, 0.9, 1.75, [0.035, 0.1, 0.06]);
  return k.build();
}

function coneGeo() {
  const k = new Kit();
  k.box(0.42, 0.04, 0.42, 0, 0.02, 0, DARK);
  k.cyl(0.17, 0.06, 0.7, 0, 0.04, 0, [0.95, 0.3, 0.02], 0.12, 8);
  k.cyl(0.125, 0.105, 0.1, 0, 0.36, 0, [0.9, 0.9, 0.9], 0.15, 8);
  return k.build();
}

function kioskGeo() {
  const k = new Kit();
  k.box(1.1, 2.1, 1.6, 0, 1.05, 0, [0.04, 0.09, 0.11]);
  k.box(1.3, 0.1, 1.8, 0, 2.15, 0, DARK);
  k.box(0.06, 0.9, 1.3, 0.56, 1.3, 0, [1.0, 0.72, 0.38], 0.65);
  k.box(0.06, 0.25, 1.5, 0.57, 1.85, 0, [0.95, 0.25, 0.3], 0.55);
  return k.build();
}

function wasteGeo() {
  const k = new Kit();
  k.cyl(0.26, 0.24, 0.85, 0, 0, 0, GREEN_MET, 0, 8);
  k.cyl(0.28, 0.28, 0.06, 0, 0.85, 0, DARK, 0, 8);
  return k.build();
}

/** 3D brick & concrete masonry wall chunk for ground-floor wall demolition. */
function wallDebrisGeo() {
  const k = new Kit();
  k.box(0.38, 0.22, 0.26, 0, 0, 0, [0.28, 0.13, 0.09], 0);
  k.box(0.24, 0.18, 0.22, 0.12, 0.08, 0.06, [0.36, 0.34, 0.31], 0);
  return k.build();
}

/** Sharp 3D triangular tempered-glass shard for storefront shattering. */
function glassShardGeo() {
  const k = new Kit();
  k.ico(0.19, 0, 0, 0, 1.45, 0.06, 0.78, [0.34, 0.48, 0.58], 0.45, 0);
  return k.build();
}

/** Bright orange-white electric/metal spark streak for pole & storefront impacts. */
function sparkGeo() {
  const k = new Kit();
  k.box(0.32, 0.045, 0.045, 0, 0, 0, [1.0, 0.72, 0.28], 1.0);
  return k.build();
}

// ---- materials ----------------------------------------------------------------------------------------------------------------------

function litMaterial(glowGain: number, rough = 0.75, metal = 0.05, tint?: any) {
  const m = new THREE.MeshStandardNodeMaterial();
  const col = attribute('color', 'vec3'), glow = attribute('glow', 'float');
  m.colorNode = tint ? col.mul(tint) : col;
  m.emissiveNode = col.mul(glow).mul(glowGain);
  m.roughness = rough; m.metalness = metal;
  return m;
}

/**
 * Photorealistic NYC street tree material:
 * - Per-instance species/seasonal tint variation (London Plane emerald, Honey Locust olive, Pin Oak warm green)
 * - Distance-faded procedural 3D leaf-cluster & bark furrow bump normal relief (`bumpMap`)
 * - Warm nocturnal streetlight subsurface scattering on the lower canopy (`glow` attribute)
 */
function treeMaterial() {
  const m = new THREE.MeshStandardNodeMaterial();
  const col = attribute('color', 'vec3');
  const subsurf = attribute('glow', 'float');
  const hInst = hash(instanceIndex);
  const speciesTint = mix(vec3(0.9, 1.02, 0.88), vec3(1.08, 0.98, 0.9), smoothstep(0.2, 0.85, hInst));   // per tree; species have their own colours
  // Multi-scale 3D leaf-cluster shadowing so each bough has deep interior shadow pockets and crisp outer leaf tufts
  const macroClump = sin(positionWorld.x.mul(9.5).add(positionWorld.y.mul(8.2))).mul(cos(positionWorld.z.mul(10.3).sub(positionWorld.y.mul(7.1))));
  const microLeaf = sin(positionWorld.x.mul(27.0)).mul(cos(positionWorld.y.mul(31.0))).mul(sin(positionWorld.z.mul(25.0)));
  const leafClump = smoothstep(-0.42, 0.48, macroClump.add(microLeaf.mul(0.45)));
  const leafShade = mix(0.24, 1.38, leafClump);
  m.colorNode = col.mul(speciesTint).mul(leafShade);
  // Warm amber streetlight subsurface translucency on the outer leaf tips of the lower boughs
  m.emissiveNode = vec3(1.0, 0.66, 0.30).mul(col).mul(subsurf).mul(leafClump).mul(1.85);
  m.roughness = 0.86;
  m.metalness = 0.02;
  const dfadeTree = float(1).sub(smoothstep(18.0, 52.0, positionView.z.negate()));
  m.normalNode = bumpMap(microLeaf.add(macroClump.mul(0.5)).mul(0.45), dfadeTree.mul(1.15));
  return m;
}

function signalMaterial(phase: THREE.InstancedBufferAttribute) {
  const m = new THREE.MeshStandardNodeMaterial();
  const col = attribute('color', 'vec3'), lens = attribute('glow', 'float');
  const gp: any = instancedBufferAttribute(phase);
  const u = mod(mod(nycTime.add(gp.y), 60).sub(gp.x.mul(31)).add(60), 60);
  const on = select(lens.lessThan(1.5), step(29, u), select(lens.lessThan(2.5), step(26, u).mul(step(u, 28.999)), step(u, 25.999)));
  const isLens = step(0.5, lens);
  m.colorNode = col;
  m.emissiveNode = col.mul(isLens).mul(on.mul(5.5).add(0.03));
  m.roughness = 0.55; m.metalness = 0.15;
  return m;
}

function lampPoolMaterial() {
  const m = new THREE.MeshBasicNodeMaterial();
  const r = length(uv().sub(0.5)).mul(2);
  const fall = float(1).sub(smoothstep(0.0, 1.0, r)).pow(2.2);
  const dist = positionView.z.negate();
  const far = float(1).sub(smoothstep(120, 260, dist));
  m.colorNode = vec3(1.0, 0.56, 0.24).mul(fall).mul(far).mul(0.5);
  m.opacityNode = float(1);
  m.transparent = true; m.blending = THREE.AdditiveBlending; m.depthWrite = false; m.fog = false;
  m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -2;
  return m;
}

const PUFFS = 7;
function steamMaterial(data: THREE.InstancedBufferAttribute) {
  const m = new THREE.MeshBasicNodeMaterial();
  const d: any = instancedBufferAttribute(data);
  const age = fract(nycTime.mul(0.16).add(d.w));
  const sway = vec3(sin(nycTime.mul(0.6).add(d.w.mul(40))).mul(age).mul(1.2).add(age.mul(age).mul(2.5)), 0, cos(nycTime.mul(0.5).add(d.w.mul(31))).mul(age).mul(1.0));
  const center = vec3(d.x, d.y, d.z).add(vec3(0, age.mul(6.5), 0)).add(sway);
  const size = mix(0.7, 4.2, age.sqrt());
  const view = cameraViewMatrix.mul(vec4(center, 1));
  const q = positionGeometry.xy.mul(size);
  m.vertexNode = cameraProjectionMatrix.mul(vec4(view.x.add(q.x), view.y.add(q.y), view.z, 1));
  const rr = length(uv().sub(0.5)).mul(2);
  const a = float(1).sub(smoothstep(0.1, 1.0, rr)).mul(smoothstep(0.0, 0.08, age)).mul(float(1).sub(age).pow(1.4)).mul(0.5);
  m.colorNode = vec3(0.9, 0.8, 0.72).mul(0.55);
  m.opacityNode = a;
  m.transparent = true; m.depthWrite = false;
  return m;
}

// ---- lights & breakable physics types -----------------------------------------------------------------------------------------------

interface Slot { light: THREE.PointLight; id: number; cur: number; target: number; base: number; pend: number; pc: THREE.Color; pbase: number; prange: number; px: number; py: number; pz: number }

const CYCLE = 60;
function signalColor(t: number, group: number, phase: number, out: THREE.Color) {
  const u = (((t + phase) % CYCLE) - group * 31 + CYCLE) % CYCLE;
  if (u < 26) out.setRGB(0.1, 1, 0.45); else if (u < 29) out.setRGB(1, 0.7, 0.05); else out.setRGB(1, 0.08, 0.05);
}

interface TileLights { serial: number; x0: number; y0: number; z: number; lamps: number[][]; signals: number[][]; signs: number[][]; brokenLamps: Set<number>; brokenSignals: Set<number> }

export type BreakableKind = 'lamp' | 'signalR' | 'signalL' | 'hydrant' | 'bus' | 'kiosk' | 'waste';

/**
 * Street furniture as physical objects (see obstacles.ts): mass (kg), breakaway energy (J: what it takes to shear the
 * base / tear it out), the part of the mass a car has to bring up to its own speed at the instant of the hit (a pole
 * struck at its foot acts like ~1/4 of its mass, a box like all of it), collision shape, and how it falls:
 * 'topple' = a rod pivoting on its foot (length L), 'tumble' = thrown and rolling.
 */
export const PROP_PHYS: Record<BreakableKind, { mass: number; breakJ: number; effFrac: number; fall: 'topple' | 'tumble'; L: number;
  shape: { r: number; h: number } | { hx: number; hy: number; hz: number; ox?: number } }> = {
  lamp:    { mass: 420, breakJ: 22000, effFrac: 0.25, fall: 'topple', L: 9.5, shape: { r: 0.15, h: 3 } },
  signalR: { mass: 650, breakJ: 35000, effFrac: 0.25, fall: 'topple', L: 6.3, shape: { r: 0.15, h: 3 } },
  signalL: { mass: 650, breakJ: 35000, effFrac: 0.25, fall: 'topple', L: 6.3, shape: { r: 0.15, h: 3 } },
  hydrant: { mass: 180, breakJ: 14000, effFrac: 0.5, fall: 'topple', L: 0.8, shape: { r: 0.16, h: 0.8 } },
  waste:   { mass: 45, breakJ: 800, effFrac: 0.9, fall: 'tumble', L: 0.9, shape: { r: 0.27, h: 0.9 } },
  bus:     { mass: 450, breakJ: 18000, effFrac: 0.6, fall: 'tumble', L: 2.6, shape: { hx: 0.8, hy: 1.3, hz: 1.85 } },
  kiosk:   { mass: 650, breakJ: 25000, effFrac: 0.9, fall: 'tumble', L: 2.2, shape: { hx: 0.55, hy: 1.05, hz: 0.8 } },
};

/** The player's car for falling poles: body centre, rotation, hull half extents and their centre in the body frame. */
export interface CarBox { pos: THREE.Vector3; quat: THREE.Quaternion; half: [number, number, number]; centre: [number, number, number] }

export interface BreakablePole {
  kind: BreakableKind;
  slot: number;
  x: number;          // game frame x (three x)
  y: number;          // game frame y (three -z)
  z: number;          // ground height (three y)
  yaw: number;
  radius: number;
  broken: boolean;
  tileKey: string;
  lightIdx?: number;  // index in tileLights.lamps or signals
}

interface FlyingPole {
  kind: BreakableKind;
  slot: number;
  /** topple: a rod pivoting on its sliding foot; fields below (tumble uses the free-flight ones above them) */
  topple?: { dx: number; dz: number; theta: number; omega: number; vb: number; vbx: number; vbz: number; L: number; mass: number; yaw: number; hitCar: boolean; settled: boolean };
  x: number; y: number; z: number;       // three coordinates (y up)
  vx: number; vy: number; vz: number;
  rx: number; ry: number; rz: number;    // Euler angles
  wx: number; wy: number; wz: number;    // angular velocity
  groundY: number;
  age: number;
  bounced: boolean;
}

interface Particle {
  active: boolean;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  rx: number; ry: number; rz: number;
  wx: number; wy: number; wz: number;
  scale: number;
  groundY: number;
  age: number;
  maxAge: number;
}

export interface NycPropsOptions { lights?: number; lampLightIntensity?: number }

const _mat4 = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _scale = new THREE.Vector3(1, 1, 1);
const _inv = new THREE.Quaternion(), _quat2 = new THREE.Quaternion(), _axis = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);

export class NycProps {
  readonly root = new THREE.Group();
  readonly signs: NycSigns;
  readonly meshes: THREE.Mesh[] = [];
  private sets: Record<string, InstanceSet> = {};
  private pools: THREE.InstancedMesh;
  private steamSet: InstanceSet;
  private shardMesh: THREE.InstancedMesh;
  private shards: Particle[] = [];
  private shardCursor = 0;
  private activeShardCount = 0;
  private debrisMesh: THREE.InstancedMesh;
  private debris: Particle[] = [];
  private debrisCursor = 0;
  private activeDebrisCount = 0;
  private sparkMesh: THREE.InstancedMesh;
  private sparks: Particle[] = [];
  private sparkCursor = 0;
  private activeSparkCount = 0;

  private lights: Slot[] = [];
  private tileLights = new Map<string, TileLights>();
  private tilePoles = new Map<string, BreakablePole[]>();
  private tileTrees = new Map<string, { set: string; slot: number; x: number; y: number; z: number; scale: number }[]>();
  /** near-range photoreal trees: per species two instanced meshes; the trees currently drawn there (key set:slot) */
  private nearTrees: Partial<Record<TreeSpecies, { bark: THREE.InstancedMesh; leaves: THREE.InstancedMesh }>> = {};
  private nearNow = new Map<string, { set: string; slot: number; tile: string; m: Float32Array }>();
  private nearAt = 0;
  /** photoreal tree range around the camera, m (main.ts sets it per quality preset: 80 on max/ultra, less on phones' presets) */
  nearR = 80;
  private camPos = new THREE.Vector3();
  /** Poles and trees are solid Rapier colliders (obstacles.ts): no proximity break here. */
  solidPoles = false;
  /** Player's car, for falling poles landing on it (set every frame by main). */
  carBox: CarBox | null = null;
  /** A falling pole hit the car: where (three coords) and the energy it brought (J). */
  onLand: ((x: number, y: number, z: number, energy: number) => void) | null = null;
  private tileBuildings = new Map<string, { z: number; boxes: BuildingColliderBox[] }>();
  private flyingPoles: FlyingPole[] = [];
  brokenPolesCount = 0;
  brokenShopsCount = 0;

  private serial = 0;
  private lightTimer = 0;
  private time = 0;
  private fwd = new THREE.Vector3();
  private selected = new Set<number>();
  private cand: { id: number; score: number; kind: number; tl: TileLights; i: number }[] = [];
  private lampIntensity: number;

  constructor(private scene: THREE.Scene, private camera: THREE.Camera, opts: NycPropsOptions = {}) {
    this.root.name = 'nyc_props';
    this.lampIntensity = opts.lampLightIntensity ?? 55;
    const mk = (name: string, geo: THREE.BufferGeometry, mat: THREE.Material, cap: number, stride = 0, attr?: THREE.InstancedBufferAttribute) => {
      const s = new InstanceSet(geo, mat, cap, stride, 'nyc_' + name, attr);
      this.sets[name] = s; this.root.add(s.mesh); this.meshes.push(s.mesh);
      return s;
    };
    mk('lamp', lampGeo(), litMaterial(5.0, 0.45, 0.35), 6000);
    // one instanced mesh per species (capacity ~ census share; 19,000 in all)
    const treeMat = treeMaterial();
    for (const sp of TREE_SPECIES) mk(`tree_${sp.id}`, treeGeo(sp.id), treeMat, Math.round(19000 * sp.w));
    // photoreal near range (trees.ts): bark + leaf cards per species; the trees around the camera are moved here
    for (const sp of TREE_SPECIES) {
      const g = buildTree(sp.id);
      const mkNear = (geo: THREE.BufferGeometry, mat: THREE.Material, nm: string) => {
        const m = new THREE.InstancedMesh(geo, mat, instanceSlots(NEAR_CAP));
        m.name = nm; m.frustumCulled = false; m.castShadow = false; m.receiveShadow = true;
        m.instanceMatrix.array.fill(0);
        m.count = 1;   // one degenerate instance: the pipeline compiles with the rest (warm), not at the first near tree
        this.root.add(m); this.meshes.push(m);
        return m;
      };
      this.nearTrees[sp.id] = { bark: mkNear(g.bark, barkMaterial(g.bark_kind), `nyc_tree_${sp.id}_bark`), leaves: mkNear(g.leaves, leafMaterial(), `nyc_tree_${sp.id}_leaves`) };
    }
    const phaseA = new THREE.InstancedBufferAttribute(new Float32Array(900 * 2), 2);
    const phaseB = new THREE.InstancedBufferAttribute(new Float32Array(900 * 2), 2);
    mk('signalR', signalGeo(1), signalMaterial(phaseA), 900, 2, phaseA);
    mk('signalL', signalGeo(-1), signalMaterial(phaseB), 900, 2, phaseB);
    mk('hydrant', hydrantGeo(), litMaterial(0, 0.4, 0.5), 1500);
    mk('bench', benchGeo(), litMaterial(0, 0.8), 2200);
    mk('bus', busGeo(), litMaterial(3.0, 0.5, 0.3), 400);
    mk('subway', subwayGeo(), litMaterial(5.0, 0.55, 0.35), 400);
    mk('steam', steamGeo(), litMaterial(0, 0.6, 0.2), 200);
    mk('scaffold', scaffoldGeo(), litMaterial(5.0, 0.8, 0.1), 1500);
    mk('cone', coneGeo(), litMaterial(1.0, 0.6), 600);
    mk('kiosk', kioskGeo(), litMaterial(3.5, 0.65), 300);
    mk('waste', wasteGeo(), litMaterial(0, 0.55, 0.35), 1500);

    // Lamp light pools: own matrix buffer so broken lamps can extinguish their light pool on the street
    const disc = new THREE.PlaneGeometry(15, 15).rotateX(-Math.PI / 2).translate(2.2, 0.06, 0);
    this.pools = new THREE.InstancedMesh(disc, lampPoolMaterial(), 6000);
    this.pools.frustumCulled = false; this.pools.renderOrder = 5; this.pools.name = 'nyc_lamp_pools';
    this.root.add(this.pools); this.meshes.push(this.pools);

    // Steam puffs
    const sd = new THREE.InstancedBufferAttribute(new Float32Array(1200 * 4), 4);
    this.steamSet = new InstanceSet(new THREE.PlaneGeometry(1, 1), steamMaterial(sd), 1200, 4, 'nyc_steam_puffs', sd);
    this.steamSet.mesh.renderOrder = 6;
    this.root.add(this.steamSet.mesh); this.meshes.push(this.steamSet.mesh);

    // Breached 3D ground-floor interior rooms (persistent smashed-through building ground floors)

    // 3D spinning glass shards (for broken storefronts & bus shelters)
    const SHARD_CAP = 540;
    this.shardMesh = new THREE.InstancedMesh(glassShardGeo(), litMaterial(0.28, 0.06, 0.92), instanceSlots(SHARD_CAP));
    this.shardMesh.instanceMatrix.array.fill(0);
    this.shardMesh.count = 1;
    this.shardMesh.frustumCulled = false;
    this.shardMesh.name = 'nyc_glass_shards';
    this.root.add(this.shardMesh); this.meshes.push(this.shardMesh);
    for (let i = 0; i < SHARD_CAP; i++) {
      this.shards.push({ active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, rx: 0, ry: 0, rz: 0, wx: 0, wy: 0, wz: 0, scale: 1, groundY: 0, age: 0, maxAge: 1 });
    }

    // 3D brick & concrete masonry wall chunks (for ground-floor building wall demolition)
    const DEBRIS_CAP = 360;
    this.debrisMesh = new THREE.InstancedMesh(wallDebrisGeo(), litMaterial(0.0, 0.88, 0.05), instanceSlots(DEBRIS_CAP));
    this.debrisMesh.instanceMatrix.array.fill(0);
    this.debrisMesh.count = 1;
    this.debrisMesh.frustumCulled = false;
    this.debrisMesh.name = 'nyc_wall_debris';
    this.root.add(this.debrisMesh); this.meshes.push(this.debrisMesh);
    for (let i = 0; i < DEBRIS_CAP; i++) {
      this.debris.push({ active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, rx: 0, ry: 0, rz: 0, wx: 0, wy: 0, wz: 0, scale: 1, groundY: 0, age: 0, maxAge: 1 });
    }

    // Electric & metallic collision sparks (for sheared poles & storefronts)
    const SPARK_CAP = 320;
    this.sparkMesh = new THREE.InstancedMesh(sparkGeo(), litMaterial(6.5, 0.2, 0.5), instanceSlots(SPARK_CAP));
    this.sparkMesh.instanceMatrix.array.fill(0);
    this.sparkMesh.count = 1;
    this.sparkMesh.frustumCulled = false;
    this.sparkMesh.name = 'nyc_pole_sparks';
    this.root.add(this.sparkMesh); this.meshes.push(this.sparkMesh);
    for (let i = 0; i < SPARK_CAP; i++) {
      this.sparks.push({ active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, rx: 0, ry: 0, rz: 0, wx: 0, wy: 0, wz: 0, scale: 1, groundY: 0, age: 0, maxAge: 1 });
    }

    this.signs = new NycSigns(this.root);
    this.meshes.push(this.signs.set.mesh);
    scene.add(this.root);

    // Light pool
    const n = opts.lights ?? 36;
    for (let i = 0; i < n; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 20, 2);
      scene.add(light);
      this.lights.push({ light, id: -1, cur: 0, target: 0, base: 0, pend: -1, pc: new THREE.Color(), pbase: 0, prange: 20, px: 0, py: 0, pz: 0 });
    }
  }

  /** Immediately flush all instanced props and snap the nearest lights to full intensity. */
  primeLights() {
    this.flush();
    this.assignLights();
    for (const s of this.lights) {
      if (s.pend >= 0) {
        s.id = s.pend; s.pend = -1; s.base = s.pbase;
        s.light.position.set(s.px, s.pz, -s.py); s.light.color.copy(s.pc); s.light.distance = s.prange;
        s.target = 1; s.cur = 1; s.light.intensity = s.base;
      }
    }
  }

  /**
   * Every 250 ms: the trees within NEAR_R of the camera (nearest first, NEAR_CAP per species) are drawn photoreal; their
   * low-poly instances are hidden (matrix saved) and restored when they leave the range.
   */
  private updateNearTrees() {
    const now = performance.now();
    if (now - this.nearAt < 250) return;
    this.nearAt = now;
    this.camera.getWorldPosition(this.camPos);
    const NEAR_R = this.nearR, cx = this.camPos.x, cy = -this.camPos.z, r2 = NEAR_R * NEAR_R;
    const cand: { d: number; set: string; slot: number; tile: string }[] = [];
    // only the tiles (256 m) that reach into the range: a scan of every loaded tree (~19,000) was a CPU spike every 250 ms
    for (let ix = Math.floor((cx - NEAR_R) / 256); ix <= Math.floor((cx + NEAR_R) / 256); ix++)
      for (let iy = Math.floor((cy - NEAR_R) / 256); iy <= Math.floor((cy + NEAR_R) / 256); iy++) {
        const tile = `${ix}_${iy}`, list = this.tileTrees.get(tile);
        if (list) for (const t of list) {
          const d = (t.x - cx) ** 2 + (t.y - cy) ** 2;
          if (d < r2) cand.push({ d, set: t.set, slot: t.slot, tile });
        }
      }
    cand.sort((a, b) => a.d - b.d);
    const want = new Map<string, { set: string; slot: number; tile: string }>(), per = new Map<string, number>();
    for (const c of cand) { const n = per.get(c.set) ?? 0; if (n < NEAR_CAP) { per.set(c.set, n + 1); want.set(`${c.set}:${c.slot}`, c); } }
    let changed = false;
    for (const [k, t] of this.nearNow) if (!want.has(k)) { this.sets[t.set].setSlot(t.slot, t.m); this.nearNow.delete(k); changed = true; }
    for (const [k, c] of want) if (!this.nearNow.has(k)) { const m = this.sets[c.set].getSlot(c.slot); this.sets[c.set].hideSlot(c.slot); this.nearNow.set(k, { ...c, m }); changed = true; }
    if (!changed) return;   // nothing entered or left the range: no upload
    for (const sp of TREE_SPECIES) {
      const N = this.nearTrees[sp.id]!, set = `tree_${sp.id}`;
      const arr = N.bark.instanceMatrix.array as Float32Array, arr2 = N.leaves.instanceMatrix.array as Float32Array;
      let i = 0;
      for (const t of this.nearNow.values()) if (t.set === set && i < NEAR_CAP) { arr.set(t.m, i * 16); arr2.set(t.m, i * 16); i++; }
      N.bark.count = N.leaves.count = Math.max(1, i);
      if (!i) { arr.fill(0, 0, 16); arr2.fill(0, 0, 16); }
      for (const a of [N.bark.instanceMatrix, N.leaves.instanceMatrix]) { a.addUpdateRange(0, Math.max(1, i) * 16); a.needsUpdate = true; }
    }
  }

  async warm(renderer: THREE.WebGPURenderer) {
    this.flush();
    await renderer.compileAsync(this.scene, this.camera);
  }

  private isInsideAnyBuilding(gx: number, gy: number, margin = 0.85): boolean {
    const ix0 = Math.floor(gx / 256), iy0 = Math.floor(gy / 256);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const tb = this.tileBuildings.get(`${ix0 + dx}_${iy0 + dy}`);
        if (!tb) continue;
        for (const b of tb.boxes) {
          const bdx = gx - b.cx, bdy = gy - b.cy;
          if (Math.abs(bdx) > b.hx + 16 || Math.abs(bdy) > b.hy + 16) continue;
          const c = Math.cos(-b.yaw), s = Math.sin(-b.yaw);
          const lx = bdx * c - bdy * s, ly = bdx * s + bdy * c;
          if (Math.abs(lx) < b.hx + margin && Math.abs(ly) < b.hy + margin) return true;
        }
      }
    }
    return false;
  }

  private cullTreesInBuildings(centerKey: string) {
    const [ix0, iy0] = centerKey.split('_').map(Number);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const list = this.tileTrees.get(`${ix0 + dx}_${iy0 + dy}`);
        if (!list) continue;
        for (let i = list.length - 1; i >= 0; i--) {
          const tr = list[i];
          if (this.isInsideAnyBuilding(tr.x, tr.y)) {
            this.sets[tr.set].hideSlot(tr.slot);
            if (this.nearNow.delete(`${tr.set}:${tr.slot}`)) this.nearAt = 0;   // drawn photoreal: never restored
            list.splice(i, 1);
          }
        }
      }
    }
  }

  setTileBuildings(key: string, boxes: BuildingColliderBox[] | undefined, z = 0) {
    if (!boxes || !boxes.length) { this.tileBuildings.delete(key); return; }
    this.tileBuildings.set(key, { z, boxes });
    this.cullTreesInBuildings(key);
  }

  setTile(key: string, data: unknown) {
    const d = data as PropsData;
    const z = d.z ?? 0;
    const S = this.sets;
    const poles: BreakablePole[] = [];

    const registerBreakable = (kind: BreakableKind, rows: number[][] | undefined, radius: number, yawOf = 2) => {
      const slots = S[kind].add(key, rows, (r, m, mo) => writeMatrix(m, mo, r[0], r[1], z, r[yawOf] ?? 0, 1, 1, 1));
      if (rows) {
        for (let i = 0; i < slots.length; i++) {
          const r = rows[i];
          poles.push({ kind, slot: slots[i], x: r[0], y: r[1], z, yaw: r[yawOf] ?? 0, radius, broken: false, tileKey: key, lightIdx: kind === 'lamp' ? i : undefined });
        }
      }
    };

    registerBreakable('lamp', d.lamp, 0.55);
    // Sync lamp light pool matrices
    (this.pools.instanceMatrix.array as Float32Array).set(S.lamp.mesh.instanceMatrix.array as Float32Array);
    this.pools.instanceMatrix.needsUpdate = true;

    // trees come from the tile data only (OSM street trees + the generator's), each drawn as its census species
    const treeRows = (d.tree ?? []).filter((r) => !this.isInsideAnyBuilding(r[0], r[1]));
    const trees: { set: string; slot: number; x: number; y: number; z: number; scale: number }[] = [];
    for (const sp of TREE_SPECIES) {
      const rows = treeRows.filter((r) => speciesOf(r[0], r[1]) === sp.id), set = `tree_${sp.id}`;
      const slots = S[set].add(key, rows, (r, m, mo) => writeMatrix(m, mo, r[0], r[1], z, r[2], r[3], r[3] * (0.9 + 0.2 * ((r[2] * 7) % 1)), r[3]));
      slots.forEach((slot, i) => trees.push({ set, slot, x: rows[i][0], y: rows[i][1], z, scale: rows[i][3] ?? 1 }));
    }
    this.tileTrees.set(key, trees);
    for (const [set, side, kName] of [[S.signalR, 1, 'signalR'], [S.signalL, -1, 'signalL']] as [InstanceSet, number, BreakableKind][]) {
      const sigRows = d.signal?.filter((r) => r[3] === side);
      const slots = set.add(key, sigRows, (r, m, mo, ex, eo) => {
        writeMatrix(m, mo, r[0], r[1], z, r[2]);
        ex![eo] = r[4]; ex![eo + 1] = r[5];
      });
      if (sigRows) {
        for (let i = 0; i < slots.length; i++) {
          const r = sigRows[i];
          poles.push({ kind: kName, slot: slots[i], x: r[0], y: r[1], z, yaw: r[2] ?? 0, radius: 0.55, broken: false, tileKey: key });
        }
      }
    }
    registerBreakable('hydrant', d.hydrant, 0.45);
    S.bench.add(key, d.bench, (r, m, mo) => writeMatrix(m, mo, r[0], r[1], z, r[2] ?? 0));
    registerBreakable('bus', d.bus_stop, 1.35);
    S.subway.add(key, d.subway_entrance, (r, m, mo) => writeMatrix(m, mo, r[0], r[1], z, r[2] ?? 0));
    S.scaffold.add(key, d.scaffold, (r, m, mo) => writeMatrix(m, mo, r[0], r[1], z, r[2] ?? 0));
    registerBreakable('kiosk', d.kiosk, 1.05);
    S.steam.add(key, d.steam, (r, m, mo) => writeMatrix(m, mo, r[0], r[1], z, 0));
    S.cone.add(key, d.cone, (r, m, mo) => writeMatrix(m, mo, r[0], r[1], z, 0));
    registerBreakable('waste', d.waste, 0.45, 99);

    const puffs: number[][] = [];
    for (const r of d.steam ?? []) for (let k = 0; k < PUFFS; k++) puffs.push([r[0], r[1], r[2] ?? 3.3, k / PUFFS + ((Math.abs(r[0]) * 0.31) % 0.14)]);
    this.steamSet.add(key, puffs, (r, m, mo, ex, eo) => { ex![eo] = r[0]; ex![eo + 1] = z + r[2] + 0.1; ex![eo + 2] = -r[1]; ex![eo + 3] = r[3]; writeMatrix(m, mo, 0, 0, 0, 0); });
    this.signs.setTile(key, d.sign, z);

    this.tilePoles.set(key, poles);
    const [ix, iy] = key.split('_').map(Number);
    this.tileLights.set(key, {
      serial: ++this.serial, x0: ix * 256, y0: iy * 256, z,
      lamps: d.lamp ?? [], signals: d.signal ?? [], signs: (d.sign ?? []).filter((r) => r[6] < 8),
      brokenLamps: new Set(), brokenSignals: new Set(),
    });
  }

  removeTile(key: string) {
    for (const [k, t] of this.nearNow) if (t.tile === key) this.nearNow.delete(k);   // its slots are freed: nothing to restore
    this.nearAt = 0;
    for (const s of Object.values(this.sets)) s.remove(key);
    this.steamSet.remove(key);
    this.signs.removeTile(key);
    this.tileLights.delete(key);
    this.tilePoles.delete(key);
    this.tileTrees.delete(key);
    this.tileBuildings.delete(key);
  }

  private flush() {
    const lampDirty = (this.sets.lamp as unknown as { dirty: boolean }).dirty;
    for (const s of Object.values(this.sets)) s.flush();
    this.steamSet.flush();
    this.signs.flush();
    if (lampDirty) {
      (this.pools.instanceMatrix.array as Float32Array).set(this.sets.lamp.mesh.instanceMatrix.array as Float32Array);
      // knocked-down lamps (flying or lying) stay dark
      for (const poles of this.tilePoles.values()) for (const p of poles) {
        if (p.broken && p.kind === 'lamp') (this.pools.instanceMatrix.array as Float32Array).fill(0, p.slot * 16, p.slot * 16 + 16);
      }
      this.pools.instanceMatrix.needsUpdate = true;
    }
    this.pools.count = this.sets.lamp.mesh.count;
  }

  /** Spawn a burst of orange-white metallic/electric sparks at (x, y, z) in Three.js coordinates. */
  private emitSparks(x: number, y: number, z: number, vxBase: number, vzBase: number, count = 28) {
    for (let i = 0; i < count; i++) {
      const p = this.sparks[this.sparkCursor];
      this.sparkCursor = (this.sparkCursor + 1) % this.sparks.length;
      if (!p.active) this.activeSparkCount++;
      const ang = Math.random() * Math.PI * 2;
      const spd = 3.0 + Math.random() * 11.0;
      p.active = true;
      p.x = x + (Math.random() - 0.5) * 0.3;
      p.y = y + Math.random() * 0.4;
      p.z = z + (Math.random() - 0.5) * 0.3;
      p.vx = vxBase * 0.35 + Math.cos(ang) * spd;
      p.vy = 2.5 + Math.random() * 7.5;
      p.vz = vzBase * 0.35 + Math.sin(ang) * spd;
      p.rx = Math.random() * 6.28; p.ry = Math.random() * 6.28; p.rz = Math.random() * 6.28;
      p.wx = (Math.random() - 0.5) * 20; p.wy = (Math.random() - 0.5) * 20; p.wz = (Math.random() - 0.5) * 20;
      p.scale = 0.6 + Math.random() * 0.9;
      p.groundY = y - 0.25;
      p.age = 0;
      p.maxAge = 0.45 + Math.random() * 0.55;
    }
  }

  /** Spawn a burst of 3D spinning reflective glass shards at (x, y, z) in Three.js coordinates. */
  private emitGlassShards(x: number, y: number, z: number, nx: number, nz: number, vxCar: number, vzCar: number, groundY: number, count = 48) {
    for (let i = 0; i < count; i++) {
      const p = this.shards[this.shardCursor];
      this.shardCursor = (this.shardCursor + 1) % this.shards.length;
      if (!p.active) this.activeShardCount++;
      const lat = (Math.random() - 0.5) * 3.4;
      const out = (Math.random() - 0.25) * 7.5;
      p.active = true;
      p.x = x - nz * lat + nx * 0.15;
      p.y = groundY + 0.75 + Math.random() * 2.3;
      p.z = z + nx * lat + nz * 0.15;
      p.vx = vxCar * 0.35 + nx * out + (Math.random() - 0.5) * 4.5;
      p.vy = 1.2 + Math.random() * 5.2;
      p.vz = vzCar * 0.35 + nz * out + (Math.random() - 0.5) * 4.5;
      p.rx = Math.random() * 6.28; p.ry = Math.random() * 6.28; p.rz = Math.random() * 6.28;
      p.wx = (Math.random() - 0.5) * 18; p.wy = (Math.random() - 0.5) * 18; p.wz = (Math.random() - 0.5) * 18;
      p.scale = 0.55 + Math.random() * 1.1;
      p.groundY = groundY + 0.04;
      p.age = 0;
      p.maxAge = 4.5 + Math.random() * 2.5;
    }
  }

  /** Spawn a burst of 3D tumbling brick & concrete masonry wall chunks at (x, y, z) in Three.js coordinates. */
  private emitWallDebris(x: number, y: number, z: number, nx: number, nz: number, vxCar: number, vzCar: number, groundY: number, count = 36) {
    for (let i = 0; i < count; i++) {
      const p = this.debris[this.debrisCursor];
      this.debrisCursor = (this.debrisCursor + 1) % this.debris.length;
      if (!p.active) this.activeDebrisCount++;
      const lat = (Math.random() - 0.5) * 4.2;
      // Half the wall chunks fly inward with the car into the breached ground floor, half burst outward
      const inOut = (Math.random() - 0.62) * 8.5;
      p.active = true;
      p.x = x - nz * lat + nx * (Math.random() - 0.5) * 0.4;
      p.y = groundY + 0.35 + Math.random() * 2.9;
      p.z = z + nx * lat + nz * (Math.random() - 0.5) * 0.4;
      p.vx = vxCar * 0.45 + nx * inOut + (Math.random() - 0.5) * 4.0;
      p.vy = 1.0 + Math.random() * 4.5;
      p.vz = vzCar * 0.45 + nz * inOut + (Math.random() - 0.5) * 4.0;
      p.rx = Math.random() * 6.28; p.ry = Math.random() * 6.28; p.rz = Math.random() * 6.28;
      p.wx = (Math.random() - 0.5) * 11; p.wy = (Math.random() - 0.5) * 11; p.wz = (Math.random() - 0.5) * 11;
      p.scale = 0.65 + Math.random() * 1.15;
      p.groundY = groundY + 0.08;
      p.age = 0;
      p.maxAge = 8.0 + Math.random() * 4.0;
    }
  }

  /** A wall breaking (breach.ts): brick, dust and (storefronts) glass out of the hole at (wx, groundY, wz), outward (nx, nz). */
  burst(wx: number, groundY: number, wz: number, nx: number, nz: number, vx: number, vz: number, glass: boolean) {
    if (glass) this.emitGlassShards(wx, groundY + 1.4, wz, nx, nz, vx, vz, groundY, 26);
    this.emitWallDebris(wx, groundY + 1.5, wz, nx, nz, vx, vz, groundY, 18);
    this.emitSparks(wx, groundY + 2.4, wz, nx * 3, nz * 3, 10);
  }

  /** Unbroken breakables and trees within r m of (cx, cy) (game frame: three x, -z). */
  near(cx: number, cy: number, r: number, poles: BreakablePole[], trees: { x: number; y: number; z: number; scale: number }[]) {
    poles.length = 0; trees.length = 0;
    const r2 = r * r, ix0 = Math.floor(cx / 256), iy0 = Math.floor(cy / 256);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const key = `${ix0 + dx}_${iy0 + dy}`;
      for (const p of this.tilePoles.get(key) ?? []) if (!p.broken && (p.x - cx) ** 2 + (p.y - cy) ** 2 < r2) poles.push(p);
      for (const t of this.tileTrees.get(key) ?? []) if ((t.x - cx) ** 2 + (t.y - cy) ** 2 < r2) trees.push(t);
    }
  }

  /** The unbroken breakable nearest (x, y) within maxD m (other players' hits arrive as a position). */
  poleAt(x: number, y: number, maxD = 1.5): BreakablePole | null {
    let best: BreakablePole | null = null, bd = maxD * maxD;
    const ix0 = Math.floor(x / 256), iy0 = Math.floor(y / 256);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const p of this.tilePoles.get(`${ix0 + dx}_${iy0 + dy}`) ?? []) {
        const d = (p.x - x) ** 2 + (p.y - y) ** 2;
        if (!p.broken && d < bd) { bd = d; best = p; }
      }
    }
    return best;
  }

  /**
   * Knocked down by a car moving (vx, vz) m/s (three frame) at the hit. A tall pole sheared at its foot topples as a
   * rod: the foot is kicked along with the car while the top lags, so after a fast hit the top swings back over the
   * car (and may land on it); a slow push tips it forward. Real gravity: a 9.5 m lamp post takes about a second.
   * Boxes and bins are thrown and roll.
   */
  knockDown(p: BreakablePole, vx: number, vz: number, onImpact?: (impulse: number, kind?: 'pole' | 'shop' | 'wall', wx?: number, wz?: number) => void) {
    if (p.broken) return;
    const ph = PROP_PHYS[p.kind];
    if (ph.fall === 'tumble') { this.triggerPoleBreak(p, vx, vz, onImpact, 0.75); return; }
    p.broken = true;
    this.brokenPolesCount++;
    this.extinguish(p);
    const spd = Math.hypot(vx, vz), dirX = spd > 0.1 ? vx / spd : 1, dirZ = spd > 0.1 ? vz / spd : 0;
    const back = spd > 8;                              // fast: foot kicked out, top falls back toward the car
    const vb = Math.min(14, spd * 0.45);
    const jitter = (Math.random() - 0.5) * 0.5;        // never quite straight
    const fx = (back ? -dirX : dirX), fz = (back ? -dirZ : dirZ);
    const c = Math.cos(jitter), s = Math.sin(jitter);
    const tx = p.x, ty = p.z, tz = -p.y;
    this.flyingPoles.push({
      kind: p.kind, slot: p.slot,
      x: tx, y: ty, z: tz, vx: 0, vy: 0, vz: 0, rx: 0, ry: p.yaw, rz: 0, wx: 0, wy: 0, wz: 0, groundY: ty, age: 0, bounced: false,
      topple: { dx: fx * c - fz * s, dz: fx * s + fz * c, theta: 0.02, omega: Math.min(2.2, (1.5 * vb) / ph.L) + 0.15, vb, vbx: dirX, vbz: dirZ,
        L: ph.L, mass: ph.mass, yaw: p.yaw, hitCar: false, settled: false },
    });
    this.emitSparks(tx, ty + 0.3, tz, vx, vz, 30);
    onImpact?.(p.kind === 'hydrant' ? 85 : 155, 'pole', tx, tz);
  }

  private extinguish(p: BreakablePole) {
    if (p.kind !== 'lamp') return;
    (this.pools.instanceMatrix.array as Float32Array).fill(0, p.slot * 16, p.slot * 16 + 16);
    this.pools.instanceMatrix.needsUpdate = true;
    const tl = this.tileLights.get(p.tileKey);
    if (tl && p.lightIdx !== undefined) tl.brokenLamps.add(p.lightIdx);
  }

  /** Break a specific pole and launch it with 3D tumbling rigid-body motion. */
  private triggerPoleBreak(
    p: BreakablePole,
    vx: number,
    vz: number,
    onImpact?: (impulse: number, kind?: 'pole' | 'shop' | 'wall', wx?: number, wz?: number) => void,
    throwK = 0.92,
  ) {
    if (p.broken) return;
    p.broken = true;
    this.brokenPolesCount++;
    const spd = Math.max(8, Math.hypot(vx, vz));
    const dirX = spd > 0.1 ? vx / spd : 1;
    const dirZ = spd > 0.1 ? vz / spd : 0;

    // Extinguish light pool & dynamic point light if this was a streetlamp
    this.extinguish(p);

    const tx = p.x, ty = p.z, tz = -p.y;
    this.flyingPoles.push({
      kind: p.kind,
      slot: p.slot,
      x: tx, y: ty + 0.15, z: tz,
      vx: dirX * Math.min(28, spd * throwK) + (Math.random() - 0.5) * 3.0,
      vy: throwK < 0.9 ? 1.2 + Math.min(3, spd * 0.08) : 3.4 + Math.min(6.5, spd * 0.18),
      vz: dirZ * Math.min(28, spd * throwK) + (Math.random() - 0.5) * 3.0,
      rx: 0, ry: p.yaw, rz: 0,
      wx: dirZ * (3.2 + Math.random() * 2.2),
      wy: (Math.random() - 0.5) * 2.5,
      wz: -dirX * (3.2 + Math.random() * 2.2),
      groundY: ty,
      age: 0,
      bounced: false,
    });

    this.emitSparks(tx, ty + 0.35, tz, vx, vz, 32);
    if (p.kind === 'bus' || p.kind === 'kiosk') {
      this.emitGlassShards(tx, ty + 1.2, tz, dirX, dirZ, vx, vz, ty, 36);
    }
    onImpact?.(p.kind === 'hydrant' || p.kind === 'waste' ? 85 : 155, 'pole', tx, tz);
  }



  /** Force-break the nearest metal pole within `maxDist` of `carPos` (Three.js coords) — also exposed for automated verification. */
  breakNearestPole(
    carPos: THREE.Vector3,
    carVel?: THREE.Vector3,
    maxDist = 45,
    onImpact?: (impulse: number, kind?: 'pole' | 'shop' | 'wall', wx?: number, wz?: number) => void,
  ): boolean {
    const cx = carPos.x, cy = -carPos.z;
    let best: BreakablePole | null = null, bestD = maxDist;
    for (const poles of this.tilePoles.values()) {
      for (const p of poles) {
        if (p.broken) continue;
        const d = Math.hypot(p.x - cx, p.y - cy);
        if (d < bestD) { bestD = d; best = p; }
      }
    }
    if (!best) return false;
    this.triggerPoleBreak(best, carVel?.x ?? 12, carVel?.z ?? -12, onImpact);
    return true;
  }


  private checkCollisions(
    carPos: THREE.Vector3,
    carVel: THREE.Vector3,
    onImpact?: (impulse: number, kind?: 'pole' | 'shop' | 'wall', wx?: number, wz?: number) => void,
  ) {
    const speed = Math.hypot(carVel.x, carVel.z);
    if (speed < 1.8) return;
    const cx = carPos.x, cy = -carPos.z;
    const ix0 = Math.floor(cx / 256), iy0 = Math.floor(cy / 256);
    const carR = 2.25;

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const key = `${ix0 + dx}_${iy0 + dy}`;
        const poles = this.tilePoles.get(key);
        if (poles) {
          for (const p of poles) {
            if (p.broken || this.solidPoles) continue;
            const pdx = p.x - cx, pdy = p.y - cy;
            if (pdx * pdx + pdy * pdy < (carR + p.radius) * (carR + p.radius)) {
              this.triggerPoleBreak(p, carVel.x, carVel.z, onImpact);
            }
          }
        }
      }
    }
  }

  /**
   * One step of a toppling pole: the foot slides (friction ~0.6 g), the rod pivots on it under gravity
   * (theta'' = 3 g / 2L sin theta), it rests on the player's car while any point of the shaft is inside the car's hull
   * (first touch dents the car: onLand), bounces faintly when it hits the street. Returns true when it has come to rest.
   */
  private stepTopple(fp: FlyingPole, dt: number): boolean {
    const t = fp.topple!;
    const LIE = Math.PI / 2 - 0.03;
    if (!t.settled) {
      t.vb = Math.max(0, t.vb - 6 * dt);
      fp.x += t.vbx * t.vb * dt; fp.z += t.vbz * t.vb * dt;
      const prevTheta = t.theta;
      t.omega += ((3 * 9.81) / (2 * t.L)) * Math.sin(t.theta) * dt;
      t.theta += t.omega * dt;
      // resting on the car?
      const cb = this.carBox;
      // only a pole that has really tipped can land on the car, and only on its top (roof, bonnet, boot): right after
      // the hit the car is still over the pole's foot, and a near-upright pole must not hang in it
      if (cb && t.L > 2 && t.theta > 0.35) {
        _inv.copy(cb.quat).invert();
        for (let sd = 1.5; sd <= t.L; sd += 0.45) {
          const st = Math.sin(t.theta), ct = Math.cos(t.theta);
          _pos.set(fp.x + t.dx * st * sd - cb.pos.x, fp.y + ct * sd - cb.pos.y, fp.z + t.dz * st * sd - cb.pos.z).applyQuaternion(_inv);
          const lx = _pos.x - cb.centre[0], ly = _pos.y - cb.centre[1], lz = _pos.z - cb.centre[2];
          if (Math.abs(lx) < cb.half[0] + 0.08 && ly > 0 && ly < cb.half[1] + 0.08 && Math.abs(lz) < cb.half[2] + 0.08) {
            if (!t.hitCar) {
              t.hitCar = true;
              // the rod's kinetic energy about its foot (I = m L^2 / 3); most of it goes into the car (a 420 kg lamp
              // post falling onto a roof brings ~10 kJ)
              const energy = 0.7 * 0.5 * ((t.mass * t.L * t.L) / 3) * t.omega * t.omega;
              _pos.set(fp.x + t.dx * Math.sin(t.theta) * sd, fp.y + Math.cos(t.theta) * sd, fp.z + t.dz * Math.sin(t.theta) * sd);
              this.emitSparks(_pos.x, _pos.y, _pos.z, t.dx * 3, t.dz * 3, 18);
              this.onLand?.(_pos.x, _pos.y, _pos.z, energy);
            }
            t.theta = prevTheta; t.omega = 0;     // held up by the car until it drives out from under
            break;
          }
        }
      }
      if (t.theta >= LIE) {
        t.theta = LIE;
        if (!fp.bounced && t.omega > 1) {
          fp.bounced = true;
          this.emitSparks(fp.x + t.dx * t.L * 0.85, fp.groundY + 0.1, fp.z + t.dz * t.L * 0.85, t.dx * 2, t.dz * 2, 16);
          t.omega = -t.omega * 0.12;               // heavy: a small rebound, no bounce-around
        } else t.omega = 0;
        if (t.vb < 0.05 && Math.abs(t.omega) < 0.01) t.settled = true;
      }
    }
    // pose: foot at (x, ground, z), tipped by theta toward (dx, dz), turned by its own yaw
    _quat.setFromAxisAngle(_axis.set(t.dz, 0, -t.dx), t.theta).multiply(_quat2.setFromAxisAngle(_up, t.yaw));
    _mat4.compose(_pos.set(fp.x, fp.groundY + Math.sin(t.theta) * 0.12, fp.z), _quat, _scale.set(1, 1, 1));
    _mat4.toArray(this.sets[fp.kind].mesh.instanceMatrix.array as Float32Array, fp.slot * 16);
    this.sets[fp.kind].markSlot(fp.slot);
    return t.settled || fp.age > 12;
  }

  private stepPhysics(dt: number) {
    // 1. Flying / toppling broken metal poles
    if (this.flyingPoles.length) {
      for (let i = this.flyingPoles.length - 1; i >= 0; i--) {
        const fp = this.flyingPoles[i];
        fp.age += dt;
        if (fp.topple) {
          if (this.stepTopple(fp, dt)) this.flyingPoles.splice(i, 1);
          continue;
        }
        fp.x += fp.vx * dt;
        fp.y += fp.vy * dt;
        fp.z += fp.vz * dt;
        fp.vy -= (fp.kind === 'bus' || fp.kind === 'kiosk' || fp.kind === 'waste' ? 9.81 : 17.5) * dt;
        fp.rx += fp.wx * dt;
        fp.ry += fp.wy * dt;
        fp.rz += fp.wz * dt;

        // Limit tilt to horizontal resting on the street after bounce
        if (fp.y <= fp.groundY + 0.16) {
          fp.y = fp.groundY + 0.16;
          if (!fp.bounced && Math.abs(fp.vy) > 1.5) {
            fp.bounced = true;
            this.emitSparks(fp.x + Math.cos(fp.ry) * 3.0, fp.groundY + 0.1, fp.z - Math.sin(fp.ry) * 3.0, fp.vx * 0.4, fp.vz * 0.4, 16);
          }
          fp.vy = Math.abs(fp.vy) * 0.28;
          fp.vx *= Math.max(0, 1 - dt * 4.5);
          fp.vz *= Math.max(0, 1 - dt * 4.5);
          fp.wx *= Math.max(0, 1 - dt * 5.0);
          fp.wy *= Math.max(0, 1 - dt * 5.0);
          fp.wz *= Math.max(0, 1 - dt * 5.0);
        }

        _pos.set(fp.x, fp.y, fp.z);
        _euler.set(fp.rx, fp.ry, fp.rz);
        _quat.setFromEuler(_euler);
        _scale.set(1, 1, 1);
        _mat4.compose(_pos, _quat, _scale);
        const arr = this.sets[fp.kind].mesh.instanceMatrix.array as Float32Array;
        _mat4.toArray(arr, fp.slot * 16);
        this.sets[fp.kind].markSlot(fp.slot);

        if (fp.age > 5.0 || (fp.bounced && Math.hypot(fp.vx, fp.vz) < 0.15 && fp.age > 2.2)) {
          this.flyingPoles.splice(i, 1);
        }
      }
    }

    // 2. 3D glass shards (zero CPU cost when inactive)
    if (this.activeShardCount > 0) {
      const shardArr = this.shardMesh.instanceMatrix.array as Float32Array;
      for (let i = 0; i < this.shards.length; i++) {
        const p = this.shards[i];
        if (!p.active) continue;
        p.age += dt;
        if (p.age >= p.maxAge) {
          p.active = false;
          this.activeShardCount--;
          shardArr.fill(0, i * 16, i * 16 + 16);
          continue;
        }
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        p.vy -= 18.0 * dt;
        p.rx += p.wx * dt; p.ry += p.wy * dt; p.rz += p.wz * dt;
        if (p.y <= p.groundY) {
          p.y = p.groundY;
          p.vy = Math.abs(p.vy) * 0.35;
          p.vx *= 0.82; p.vz *= 0.82;
          p.wx *= 0.75; p.wy *= 0.75; p.wz *= 0.75;
        }
        const s = p.scale * Math.min(1, (p.maxAge - p.age) * 1.5);
        _pos.set(p.x, p.y, p.z);
        _euler.set(p.rx, p.ry, p.rz);
        _quat.setFromEuler(_euler);
        _scale.set(s, s, s);
        _mat4.compose(_pos, _quat, _scale);
        _mat4.toArray(shardArr, i * 16);
      }
      this.shardMesh.count = this.activeShardCount > 0 ? this.shards.length : 1;
      this.shardMesh.instanceMatrix.needsUpdate = true;
    }

    // 3. 3D brick & concrete masonry wall chunks (zero CPU cost when inactive)
    if (this.activeDebrisCount > 0) {
      const debrisArr = this.debrisMesh.instanceMatrix.array as Float32Array;
      for (let i = 0; i < this.debris.length; i++) {
        const p = this.debris[i];
        if (!p.active) continue;
        p.age += dt;
        if (p.age >= p.maxAge) {
          p.active = false;
          this.activeDebrisCount--;
          debrisArr.fill(0, i * 16, i * 16 + 16);
          continue;
        }
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        p.vy -= 21.0 * dt;
        p.rx += p.wx * dt; p.ry += p.wy * dt; p.rz += p.wz * dt;
        if (p.y <= p.groundY) {
          p.y = p.groundY;
          p.vy = Math.abs(p.vy) * 0.22;
          p.vx *= 0.68; p.vz *= 0.68;
          p.wx *= 0.6; p.wy *= 0.6; p.wz *= 0.6;
        }
        const s = p.scale * Math.min(1, (p.maxAge - p.age) * 1.2);
        _pos.set(p.x, p.y, p.z);
        _euler.set(p.rx, p.ry, p.rz);
        _quat.setFromEuler(_euler);
        _scale.set(s, s, s);
        _mat4.compose(_pos, _quat, _scale);
        _mat4.toArray(debrisArr, i * 16);
      }
      this.debrisMesh.count = this.activeDebrisCount > 0 ? this.debris.length : 1;
      this.debrisMesh.instanceMatrix.needsUpdate = true;
    }

    // 4. Electric & metallic collision sparks (zero CPU cost when inactive)
    if (this.activeSparkCount > 0) {
      const sparkArr = this.sparkMesh.instanceMatrix.array as Float32Array;
      for (let i = 0; i < this.sparks.length; i++) {
        const p = this.sparks[i];
        if (!p.active) continue;
        p.age += dt;
        if (p.age >= p.maxAge) {
          p.active = false;
          this.activeSparkCount--;
          sparkArr.fill(0, i * 16, i * 16 + 16);
          continue;
        }
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        p.vy -= 22.0 * dt;
        if (p.y <= p.groundY) {
          p.y = p.groundY;
          p.vy = Math.abs(p.vy) * 0.45;
          p.vx *= 0.78; p.vz *= 0.78;
        }
        const s = p.scale * (1 - p.age / p.maxAge);
        _pos.set(p.x, p.y, p.z);
        _euler.set(0, Math.atan2(-p.vz, p.vx), Math.atan2(p.vy, Math.hypot(p.vx, p.vz)));
        _quat.setFromEuler(_euler);
        _scale.set(s * 1.4, s, s);
        _mat4.compose(_pos, _quat, _scale);
        _mat4.toArray(sparkArr, i * 16);
      }
      this.sparkMesh.count = this.activeSparkCount > 0 ? this.sparks.length : 1;
      this.sparkMesh.instanceMatrix.needsUpdate = true;
    }
  }

  update(
    dt: number,
    carPos?: THREE.Vector3,
    carVel?: THREE.Vector3,
    onImpact?: (impulse: number, kind?: 'pole' | 'shop' | 'wall', wx?: number, wz?: number) => void,
  ) {
    this.time += dt;
    nycTime.value = this.time;
    this.updateNearTrees();
    if (carPos && carVel && dt > 0) {
      this.checkCollisions(carPos, carVel, onImpact);
    }
    if (dt > 0) {
      this.stepPhysics(Math.min(0.05, dt));
    }
    this.flush();   // after everything that moves or hides a slot this frame (uploads only the written slot ranges)
    if ((this.lightTimer -= dt) <= 0) { this.lightTimer = 0.2; this.assignLights(); }
    const k = Math.min(1, dt * 7);
    for (const s of this.lights) {
      if (s.pend >= 0 && s.cur < 0.02 && (s.target === 0 || s.id < 0)) {
        s.id = s.pend; s.pend = -1; s.base = s.pbase;
        s.light.position.set(s.px, s.pz, -s.py); s.light.color.copy(s.pc); s.light.distance = s.prange; s.target = 1;
      } else if (s.id >= 0 && s.target === 0 && s.cur < 0.02) s.id = -1;
      s.cur += (s.target - s.cur) * k;
      s.light.intensity = s.cur < 0.01 ? 0 : s.base * s.cur;
    }
  }

  private assignLights() {
    const c = this.camera.position;
    const cx = c.x, cy = -c.z;
    this.camera.getWorldDirection(this.fwd);
    const fx = this.fwd.x, fy = -this.fwd.z;
    const cand = this.cand; cand.length = 0;
    const R = 130;
    for (const tl of this.tileLights.values()) {
      if (cx < tl.x0 - R || cx > tl.x0 + 256 + R || cy < tl.y0 - R || cy > tl.y0 + 256 + R) continue;
      const push = (kind: number, i: number, x: number, y: number, bias: number, range: number) => {
        const dx = x - cx, dy = y - cy, dist = Math.hypot(dx, dy);
        if (dist > range) return;
        const behind = (dx * fx + dy * fy) < -12 ? 2.2 : 1;
        cand.push({ id: tl.serial * 1048576 + kind * 262144 + i, score: dist * bias * behind, kind, tl, i });
      };
      const L = tl.lamps, S = tl.signals, G = tl.signs;
      for (let i = 0; i < L.length; i++) if (!tl.brokenLamps.has(i)) push(0, i, L[i][0], L[i][1], 1, R);
      for (let i = 0; i < S.length; i++) if (S[i][3] === 1 && !tl.brokenSignals.has(i)) push(1, i, S[i][0], S[i][1], 1.9, 55);
      for (let i = 0; i < G.length; i++) push(2, i, G[i][0], G[i][1], 0.7, 150);
    }
    cand.sort((a, b) => a.score - b.score);
    const n = Math.min(this.lights.length, cand.length);
    const sel = this.selected; sel.clear();
    const byId = new Map<number, (typeof cand)[number]>();
    for (let i = 0; i < n; i++) { sel.add(cand[i].id); byId.set(cand[i].id, cand[i]); }
    const taken = new Set<number>();
    for (const s of this.lights) {
      if (s.id >= 0) {
        if (sel.has(s.id)) { s.target = 1; taken.add(s.id); const cd = byId.get(s.id)!; if (cd.kind === 1) { const r = cd.tl.signals[cd.i]; signalColor(this.time + 0.1, r[4], r[5], s.light.color); } }
        else s.target = 0;
      }
      if (s.pend >= 0) { if (sel.has(s.pend)) taken.add(s.pend); else s.pend = -1; }
    }
    for (let i = 0; i < n; i++) {
      const cd = cand[i];
      if (taken.has(cd.id)) continue;
      const s = this.lights.find((l) => l.pend < 0 && (l.id < 0 || l.target === 0));
      if (!s) break;
      this.describe(cd, s);
      s.pend = cd.id; taken.add(cd.id);
    }
  }

  private describe(cd: { kind: number; tl: TileLights; i: number }, s: Slot) {
    const z = cd.tl.z;
    if (cd.kind === 0) {
      const r = cd.tl.lamps[cd.i];
      s.px = r[0] + Math.cos(r[2]) * 2.2; s.py = r[1] + Math.sin(r[2]) * 2.2; s.pz = z + 8.8;
      s.pc.setRGB(1.0, 0.62, 0.3); s.pbase = this.lampIntensity; s.prange = 24;
    } else if (cd.kind === 1) {
      const r = cd.tl.signals[cd.i];
      s.px = r[0] + Math.cos(r[2]) * 6.2; s.py = r[1] + Math.sin(r[2]) * 6.2; s.pz = z + 5.2;
      signalColor(this.time, r[4], r[5], s.pc); s.pbase = 9; s.prange = 12;
    } else {
      const r = cd.tl.signs[cd.i];
      const col = SIGN_LIGHT[r[6]] ?? [1, 1, 1];
      s.px = r[0] + Math.cos(r[3]) * 3.0; s.py = r[1] + Math.sin(r[3]) * 3.0; s.pz = z + r[2];
      s.pc.setRGB(col[0], col[1], col[2]); s.pbase = Math.min(220, 40 + r[4] * r[5] * 0.9); s.prange = 34;
    }
  }

  dispose() {
    for (const s of Object.values(this.sets)) { s.mesh.removeFromParent(); s.dispose(); }
    this.steamSet.mesh.removeFromParent(); this.steamSet.dispose();
    this.pools.removeFromParent(); this.pools.geometry.dispose(); (this.pools.material as THREE.Material).dispose();
    this.shardMesh.removeFromParent(); this.shardMesh.geometry.dispose(); (this.shardMesh.material as THREE.Material).dispose();
    this.debrisMesh.removeFromParent(); this.debrisMesh.geometry.dispose(); (this.debrisMesh.material as THREE.Material).dispose();
    this.sparkMesh.removeFromParent(); this.sparkMesh.geometry.dispose(); (this.sparkMesh.material as THREE.Material).dispose();
    this.signs.dispose();
    for (const s of this.lights) { s.light.removeFromParent(); s.light.dispose?.(); }
    this.root.removeFromParent();
    this.lights.length = 0;
  }
}
