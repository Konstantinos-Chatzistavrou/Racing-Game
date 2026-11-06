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
import { InstanceSet, NycSigns, nycTime, writeMatrix, SIGN_LIGHT } from './signage';
import { recordWallBreach } from './facade';

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
  ico(r: number, x: number, y: number, z: number, sx: number, sy: number, sz: number, col: RGB, glow = 0, detail = 1) {
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
 * Multi-branch NYC street tree (London Plane / Honey Locust):
 * - Granite sidewalk tree-pit border + cast-iron hoop guard + dark soil bed
 * - Buttressed lower trunk + 5 primary scaffold limbs + 10 secondary forks
 * - 22 layered organic foliage boughs with lower-canopy streetlight subsurface translucency (`glow`)
 */
function treeGeo() {
  const k = new Kit();
  const barkDark: RGB = [0.052, 0.040, 0.030];
  const barkMid: RGB = [0.068, 0.054, 0.040];
  // Sidewalk tree pit granite border + dark mulch bed + cast-iron tree guard
  k.box(1.55, 0.08, 1.55, 0, 0.04, 0, [0.18, 0.18, 0.17], 0);
  k.box(1.35, 0.09, 1.35, 0, 0.05, 0, [0.035, 0.026, 0.020], 0);
  for (const s of [-0.68, 0.68]) {
    k.box(1.38, 0.03, 0.03, 0, 0.36, s, DARK, 0);
    k.box(0.03, 0.03, 1.38, s, 0.36, 0, DARK, 0);
    k.cyl(0.02, 0.02, 0.36, s, 0, s, DARK, 0, 5);
    k.cyl(0.02, 0.02, 0.36, s, 0, -s, DARK, 0, 5);
  }
  // Buttressed trunk (0..2.9 m)
  k.cyl(0.26, 0.19, 1.1, 0, 0, 0, barkDark, 0, 7);
  k.limb(0.19, 0.145, 0, 1.05, 0, 0.08, 2.85, -0.05, barkMid, 0, 7);

  // 5 primary ascending scaffold limbs + 10 secondary forks + open, flat-tiered leaf sprays
  const scaffolds: [number, number, number, number, number, number][] = [
    [1.45, 4.8, 0.50, 2.55, 6.6, 1.05],
    [-1.35, 4.6, 0.90, -2.40, 6.4, 1.65],
    [0.40, 5.0, -1.45, 0.85, 6.8, -2.50],
    [-1.05, 4.9, -1.15, -1.90, 6.7, -2.05],
    [0.18, 5.5, 0.15, 0.30, 7.9, 0.25],
  ];
  for (let i = 0; i < scaffolds.length; i++) {
    const [mx, my, mz, tx, ty, tz] = scaffolds[i];
    k.limb(0.115, 0.075, 0.06, 2.65, -0.04, mx, my, mz, barkMid, 0, 6);
    k.limb(0.072, 0.042, mx, my, mz, tx, ty, tz, barkMid, 0, 5);
    // Secondary lateral fork off each main scaffold limb
    const fx = mx * 1.18 - mz * 0.62;
    const fy = my + 1.45;
    const fz = mz * 1.18 + mx * 0.62;
    k.limb(0.062, 0.032, mx, my - 0.15, mz, fx, fy, fz, barkMid, 0, 5);

    // Lower foliage spray perched at outer branch (catches warm streetlight bounce from below)
    k.ico(0.76, mx * 1.18, my + 0.42, mz * 1.18, 1.35, 0.48, 1.25, [0.022, 0.048, 0.020], 0.16, 1);
    // Mid-canopy flat foliage sprays at outer twig ends (leaving visible gaps around trunk/limbs)
    k.ico(0.84, tx * 1.04, ty + 0.18, tz * 1.04, 1.38, 0.50, 1.28, [0.019, 0.044, 0.018], 0.08, 1);
    k.ico(0.74, fx * 1.04, fy + 0.22, fz * 1.04, 1.32, 0.46, 1.32, [0.016, 0.038, 0.016], 0.06, 1);
    // Upper-crown sun/moon-facing foliage spray
    k.ico(0.78, tx * 0.72, ty + 1.25, tz * 0.72, 1.28, 0.52, 1.22, [0.024, 0.054, 0.022], 0.02, 1);
  }
  // Open crown apex sprays
  k.ico(0.92, 0.0, 7.65, 0.0, 1.42, 0.52, 1.36, [0.021, 0.048, 0.020], 0.04, 1);
  k.ico(0.78, 0.75, 8.45, -0.45, 1.28, 0.48, 1.25, [0.026, 0.058, 0.024], 0.02, 1);
  k.ico(0.74, -0.75, 8.20, 0.55, 1.25, 0.48, 1.22, [0.020, 0.046, 0.019], 0.02, 1);
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

/**
 * Full 3D Breached Ground-Floor Room (`shatteredBayGeo`):
 * When the car crashes through a building's bottom tier, `recordWallBreach()` punches a jagged 3D hole
 * in the outer wall (`alphaTest`), and this 3D interior room sits behind the hole (`x in [-6.4, 0.1]`)
 * with an interior floor, ceiling with dangling broken light bars, structural concrete columns (which
 * match the physics colliders so the car can pass between them or get wedged!), and jagged masonry/glass collar.
 */
function shatteredBayGeo() {
  const k = new Kit();
  const concrete: RGB = [0.075, 0.072, 0.068];
  const darkWall: RGB = [0.045, 0.042, 0.040];
  const brickBroken: RGB = [0.22, 0.10, 0.07];
  const rebar: RGB = [0.12, 0.11, 0.10];
  const glass: RGB = [0.68, 0.88, 0.98];

  // 1. 3D Interior Floor Slab & Ceiling Slab (extending 6.4m inside the building along -x, 6.4m wide along z)
  k.box(6.4, 0.10, 6.4, -3.2, 0.05, 0, [0.04, 0.04, 0.042], 0);
  k.box(6.4, 0.14, 6.4, -3.2, 3.88, 0, concrete, 0);
  // 2. Interior Back Wall & Side Partition Walls
  k.box(0.14, 3.85, 6.4, -6.35, 1.92, 0, darkWall, 0.02);
  k.box(6.4, 3.85, 0.14, -3.2, 1.92, -3.15, darkWall, 0.01);
  k.box(6.4, 3.85, 0.14, -3.2, 1.92, 3.15, darkWall, 0.01);
  // 3. Two Interior Structural Concrete Columns (at x = -2.85, z = +-1.55m — car can drive between or get wedged!)
  k.box(0.56, 3.85, 0.56, -2.85, 1.92, -1.55, [0.14, 0.135, 0.13], 0);
  k.box(0.56, 3.85, 0.56, -2.85, 1.92, 1.55, [0.14, 0.135, 0.13], 0);
  // 4. Dangling broken fluorescent ceiling light fixtures inside the breached room
  k.box(1.5, 0.05, 0.32, -2.1, 3.76, -1.1, [1.0, 0.88, 0.68], 0.95);
  k.limb(0.05, 0.05, -3.6, 3.80, 0.6, -3.5, 2.95, 1.45, [1.0, 0.78, 0.45], 0.85, 6);
  // 5. Interior masonry rubble mounds & smashed counter on the floor
  k.box(0.85, 0.32, 1.4, -1.7, 0.18, 0.9, brickBroken, 0);
  k.box(0.75, 0.28, 1.1, -3.9, 0.16, -0.7, concrete, 0);
  // 6. Jagged fractured brick/concrete wall collar + bent rebar + jagged glass teeth around the breach
  for (let i = -5; i <= 5; i++) {
    const z = i * 0.42;
    const hTop = 0.22 + ((Math.abs(i * 7 + 3) % 5) * 0.08);
    const hBot = 0.18 + ((Math.abs(i * 11 + 1) % 5) * 0.06);
    k.box(0.28, hTop, 0.38, -0.06, 3.72 - hTop / 2, z, i % 2 === 0 ? brickBroken : concrete, 0);
    k.box(0.10, hTop * 0.8, 0.24, 0.05, 3.55 - hTop / 2, z, glass, 0.45);
    k.box(0.10, hBot, 0.24, 0.05, 0.22 + hBot / 2, z, glass, 0.45);
  }
  for (let j = 0; j < 6; j++) {
    const y = 0.55 + j * 0.55;
    const wSide = 0.32 + (j % 3) * 0.14;
    k.box(0.32, 0.48, wSide, -0.05, y, -2.55, j % 2 ? brickBroken : concrete, 0);
    k.box(0.32, 0.48, wSide, -0.05, y, 2.55, j % 2 ? concrete : brickBroken, 0);
    k.limb(0.02, 0.02, -0.04, y, -2.4, 0.08, y - 0.12, -2.15, rebar, 0, 5);
    k.limb(0.02, 0.02, -0.04, y, 2.4, 0.08, y + 0.10, 2.15, rebar, 0, 5);
  }
  return k.build();
}

/** 3D brick & concrete masonry wall chunk for ground-floor wall demolition. */
function wallDebrisGeo() {
  const k = new Kit();
  k.box(0.38, 0.22, 0.26, 0, 0, 0, [0.28, 0.13, 0.09], 0);
  k.box(0.24, 0.18, 0.22, 0.12, 0.08, 0.06, [0.36, 0.34, 0.31], 0);
  return k.build();
}

/** Sharp 3D triangular glass shard for storefront shattering. */
function glassShardGeo() {
  const k = new Kit();
  k.ico(0.22, 0, 0, 0, 1.35, 0.12, 0.85, [0.75, 0.92, 1.0], 0.65, 0);
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
 * - Procedural 3D leaf-cluster & bark furrow bump normal relief (`bumpMap`)
 * - Warm nocturnal streetlight subsurface scattering on the lower canopy (`glow` attribute)
 */
function treeMaterial() {
  const m = new THREE.MeshStandardNodeMaterial();
  const col = attribute('color', 'vec3');
  const subsurf = attribute('glow', 'float');
  const hInst = hash(instanceIndex);
  const speciesTint = mix(vec3(0.78, 1.04, 0.74), vec3(1.15, 0.96, 0.68), smoothstep(0.2, 0.85, hInst));
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
  m.normalNode = bumpMap(microLeaf.add(macroClump.mul(0.5)).mul(0.45), float(1.15));
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
  const fall = smoothstep(1.0, 0.0, r).pow(2.2);
  const dist = positionView.z.negate();
  const far = smoothstep(260, 120, dist);
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
  const a = smoothstep(1.0, 0.1, rr).mul(smoothstep(0.0, 0.08, age)).mul(float(1).sub(age).pow(1.4)).mul(0.5);
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

type BreakableKind = 'lamp' | 'signalR' | 'signalL' | 'hydrant' | 'bus' | 'kiosk' | 'waste';

interface BreakablePole {
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

export class NycProps {
  readonly root = new THREE.Group();
  readonly signs: NycSigns;
  readonly meshes: THREE.Mesh[] = [];
  private sets: Record<string, InstanceSet> = {};
  private pools: THREE.InstancedMesh;
  private steamSet: InstanceSet;
  private shatteredMesh: THREE.InstancedMesh;
  private shatteredCount = 0;
  private shatteredSet = new Set<string>();
  private shardMesh: THREE.InstancedMesh;
  private shards: Particle[] = [];
  private shardCursor = 0;
  private debrisMesh: THREE.InstancedMesh;
  private debris: Particle[] = [];
  private debrisCursor = 0;
  private sparkMesh: THREE.InstancedMesh;
  private sparks: Particle[] = [];
  private sparkCursor = 0;

  private lights: Slot[] = [];
  private tileLights = new Map<string, TileLights>();
  private tilePoles = new Map<string, BreakablePole[]>();
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
    mk('tree', treeGeo(), treeMaterial(), 14000);
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
    this.pools.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.pools.frustumCulled = false; this.pools.renderOrder = 5; this.pools.name = 'nyc_lamp_pools';
    this.root.add(this.pools); this.meshes.push(this.pools);

    // Steam puffs
    const sd = new THREE.InstancedBufferAttribute(new Float32Array(1200 * 4), 4);
    this.steamSet = new InstanceSet(new THREE.PlaneGeometry(1, 1), steamMaterial(sd), 1200, 4, 'nyc_steam_puffs', sd);
    this.steamSet.mesh.renderOrder = 6;
    this.root.add(this.steamSet.mesh); this.meshes.push(this.steamSet.mesh);

    // Breached 3D ground-floor interior rooms (persistent smashed-through building ground floors)
    this.shatteredMesh = new THREE.InstancedMesh(shatteredBayGeo(), litMaterial(2.2, 0.65, 0.15), 160);
    this.shatteredMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shatteredMesh.instanceMatrix.array.fill(0);
    this.shatteredMesh.count = 1;
    this.shatteredMesh.frustumCulled = false;
    this.shatteredMesh.name = 'nyc_shattered_shops';
    this.root.add(this.shatteredMesh); this.meshes.push(this.shatteredMesh);

    // 3D spinning glass shards (for broken storefronts & bus shelters)
    const SHARD_CAP = 540;
    this.shardMesh = new THREE.InstancedMesh(glassShardGeo(), litMaterial(2.4, 0.08, 0.9), SHARD_CAP);
    this.shardMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
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
    this.debrisMesh = new THREE.InstancedMesh(wallDebrisGeo(), litMaterial(0.0, 0.88, 0.05), DEBRIS_CAP);
    this.debrisMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
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
    this.sparkMesh = new THREE.InstancedMesh(sparkGeo(), litMaterial(6.5, 0.2, 0.5), SPARK_CAP);
    this.sparkMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
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

  async warm(renderer: THREE.WebGPURenderer) {
    this.flush();
    await renderer.compileAsync(this.scene, this.camera);
  }

  setTileBuildings(key: string, boxes: BuildingColliderBox[] | undefined, z = 0) {
    if (!boxes || !boxes.length) { this.tileBuildings.delete(key); return; }
    this.tileBuildings.set(key, { z, boxes });
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

    const treeRows: number[][] = [...(d.tree ?? [])];
    if (d.lamp && d.lamp.length > 1) {
      for (let i = 0; i < d.lamp.length - 1; i++) {
        const l0 = d.lamp[i], l1 = d.lamp[i + 1];
        const yaw = l0[2] ?? 0;
        const dyaw = Math.abs(yaw - (l1[2] ?? 0));
        const dx = l1[0] - l0[0], dy = l1[1] - l0[1];
        // Mast arm points into street along (cos(yaw), sin(yaw)); curb runs along (-sin(yaw), cos(yaw))
        const crossCurb = Math.abs(dx * Math.cos(yaw) + dy * Math.sin(yaw));
        const alongCurb = Math.abs(-dx * Math.sin(yaw) + dy * Math.cos(yaw));
        if (dyaw < 0.12 && crossCurb < 1.0 && alongCurb >= 18 && alongCurb <= 38) {
          const tx = (l0[0] + l1[0]) * 0.5 - Math.cos(yaw) * 0.95;
          const ty = (l0[1] + l1[1]) * 0.5 - Math.sin(yaw) * 0.95;
          const rot = ((Math.abs(tx * 1.7 + ty * 2.3)) % 6.283);
          const sc = 0.88 + ((Math.abs(tx * 3.1 + ty * 1.3)) % 0.24);
          treeRows.push([tx, ty, rot, sc]);
        }
      }
    }
    S.tree.add(key, treeRows, (r, m, mo) => writeMatrix(m, mo, r[0], r[1], z, r[2], r[3], r[3] * (0.9 + 0.2 * ((r[2] * 7) % 1)), r[3]));
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
    for (const s of Object.values(this.sets)) s.remove(key);
    this.steamSet.remove(key);
    this.signs.removeTile(key);
    this.tileLights.delete(key);
    this.tilePoles.delete(key);
    this.tileBuildings.delete(key);
  }

  private flush() {
    const lampDirty = (this.sets.lamp as unknown as { dirty: boolean }).dirty;
    for (const s of Object.values(this.sets)) s.flush();
    this.steamSet.flush();
    this.signs.flush();
    if (lampDirty) {
      (this.pools.instanceMatrix.array as Float32Array).set(this.sets.lamp.mesh.instanceMatrix.array as Float32Array);
      for (const fp of this.flyingPoles) {
        if (fp.kind === 'lamp') (this.pools.instanceMatrix.array as Float32Array).fill(0, fp.slot * 16, fp.slot * 16 + 16);
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

  /** Break a specific pole and launch it with 3D tumbling rigid-body motion. */
  private triggerPoleBreak(
    p: BreakablePole,
    vx: number,
    vz: number,
    onImpact?: (impulse: number, kind?: 'pole' | 'shop' | 'wall', wx?: number, wz?: number) => void,
  ) {
    if (p.broken) return;
    p.broken = true;
    this.brokenPolesCount++;
    const spd = Math.max(8, Math.hypot(vx, vz));
    const dirX = spd > 0.1 ? vx / spd : 1;
    const dirZ = spd > 0.1 ? vz / spd : 0;

    // Extinguish light pool & dynamic point light if this was a streetlamp
    if (p.kind === 'lamp') {
      (this.pools.instanceMatrix.array as Float32Array).fill(0, p.slot * 16, p.slot * 16 + 16);
      this.pools.instanceMatrix.needsUpdate = true;
      const tl = this.tileLights.get(p.tileKey);
      if (tl && p.lightIdx !== undefined) tl.brokenLamps.add(p.lightIdx);
    }

    const tx = p.x, ty = p.z, tz = -p.y;
    this.flyingPoles.push({
      kind: p.kind,
      slot: p.slot,
      x: tx, y: ty + 0.15, z: tz,
      vx: dirX * Math.min(28, spd * 0.92) + (Math.random() - 0.5) * 3.0,
      vy: 3.4 + Math.min(6.5, spd * 0.18),
      vz: dirZ * Math.min(28, spd * 0.92) + (Math.random() - 0.5) * 3.0,
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

  /**
   * Breach a ground-floor building wall & storefront bay at world Three.js coordinates (wx, groundY, wz)
   * with outward normal (nx, nz):
   * 1. Punches a jagged 3D hole through the outer facade (`recordWallBreach`),
   * 2. Places a full 3D breached interior room (`shatteredBayGeo`: floor, ceiling, hanging light bars, structural columns, rubble),
   * 3. Explodes 52 spinning 3D glass prism shards + 36 tumbling brick/concrete wall chunks + 24 electric sparks,
   * 4. Signals `onImpact(210, 'wall', wx, wz)` so `NycStreamer` opens the ground-floor physics collider and `GameAudio` plays the wall demolition sound.
   */
  shatterStorefrontAt(
    wx: number,
    groundY: number,
    wz: number,
    nx: number,
    nz: number,
    vx = 0,
    vz = 0,
    onImpact?: (impulse: number, kind?: 'pole' | 'shop' | 'wall', wx?: number, wz?: number) => void,
  ): boolean {
    const bayKey = `${Math.round(wx / 4.2)}_${Math.round(wz / 4.2)}`;
    if (this.shatteredSet.has(bayKey)) return false;
    this.shatteredSet.add(bayKey);
    this.brokenShopsCount++;

    // Punch a real 3D hole in the building's ground-floor facade mesh
    recordWallBreach(wx, wz, 4.4);

    const slot = this.shatteredCount % 160;
    this.shatteredCount++;
    const yaw = Math.atan2(-nz, nx);
    // Place the 3D breached interior room aligned with the wall
    writeMatrix(this.shatteredMesh.instanceMatrix.array as Float32Array, slot * 16, wx + nx * 0.04, -(wz + nz * 0.04), groundY, yaw, 1, 1, 1);
    this.shatteredMesh.count = Math.min(160, Math.max(1, this.shatteredCount));
    this.shatteredMesh.instanceMatrix.needsUpdate = true;

    this.emitGlassShards(wx, groundY + 1.5, wz, nx, nz, vx, vz, groundY, 52);
    this.emitWallDebris(wx, groundY + 1.6, wz, nx, nz, vx, vz, groundY, 36);
    this.emitSparks(wx, groundY + 2.8, wz, nx * 4, nz * 4, 24);
    onImpact?.(210, 'wall', wx, wz);
    return true;
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

  /** Force-breach the nearest ground-floor building wall & storefront within `maxDist` of `carPos` (Three.js coords). */
  breakNearestShop(
    carPos: THREE.Vector3,
    carVel?: THREE.Vector3,
    maxDist = 60,
    onImpact?: (impulse: number, kind?: 'pole' | 'shop' | 'wall', wx?: number, wz?: number) => void,
  ): boolean {
    const cx = carPos.x, cy = -carPos.z;
    let bestHit: { wx: number; wz: number; nx: number; nz: number; z: number; d: number } | null = null;
    for (const tb of this.tileBuildings.values()) {
      for (const b of tb.boxes) {
        const dx = cx - b.cx, dy = cy - b.cy;
        const c = Math.cos(-b.yaw), s = Math.sin(-b.yaw);
        const lx = dx * c - dy * s, ly = dx * s + dy * c;
        const cxClamped = Math.max(-b.hx, Math.min(b.hx, lx));
        const cyClamped = Math.max(-b.hy, Math.min(b.hy, ly));
        const dist = Math.hypot(lx - cxClamped, ly - cyClamped);
        if (dist < maxDist && (!bestHit || dist < bestHit.d)) {
          const onX = Math.abs(b.hx - Math.abs(lx)) < Math.abs(b.hy - Math.abs(ly));
          const lnx = onX ? (lx >= 0 ? 1 : -1) : 0;
          const lny = onX ? 0 : (ly >= 0 ? 1 : -1);
          const fx = onX ? lnx * b.hx : Math.round(lx / 4.2) * 4.2;
          const fy = onX ? Math.round(ly / 4.2) * 4.2 : lny * b.hy;
          const c2 = Math.cos(b.yaw), s2 = Math.sin(b.yaw);
          const wx = b.cx + (fx * c2 - fy * s2);
          const wy = b.cy + (fx * s2 + fy * c2);
          const wnx = lnx * c2 - lny * s2;
          const wny = lnx * s2 + lny * c2;
          bestHit = { wx, wz: -wy, nx: wnx, nz: -wny, z: tb.z, d: dist };
        }
      }
    }
    if (!bestHit) return false;
    return this.shatterStorefrontAt(bestHit.wx, bestHit.z, bestHit.wz, bestHit.nx, bestHit.nz, carVel?.x ?? 10, carVel?.z ?? -10, onImpact);
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
            if (p.broken) continue;
            const pdx = p.x - cx, pdy = p.y - cy;
            if (pdx * pdx + pdy * pdy < (carR + p.radius) * (carR + p.radius)) {
              this.triggerPoleBreak(p, carVel.x, carVel.z, onImpact);
            }
          }
        }
        const tb = this.tileBuildings.get(key);
        if (tb && speed > 2.4) {
          for (const b of tb.boxes) {
            const bdx = cx - b.cx, bdy = cy - b.cy;
            if (Math.abs(bdx) > b.hx + 18 || Math.abs(bdy) > b.hy + 18) continue;
            const c = Math.cos(-b.yaw), s = Math.sin(-b.yaw);
            const lx = bdx * c - bdy * s, ly = bdy * c + bdx * s;
            const px = Math.max(-b.hx, Math.min(b.hx, lx));
            const py = Math.max(-b.hy, Math.min(b.hy, ly));
            const distSq = (lx - px) * (lx - px) + (ly - py) * (ly - py);
            if (distSq < 3.4 * 3.4) {
              const onX = Math.abs(b.hx - Math.abs(lx)) < Math.abs(b.hy - Math.abs(ly));
              const lnx = onX ? (lx >= 0 ? 1 : -1) : 0;
              const lny = onX ? 0 : (ly >= 0 ? 1 : -1);
              const snapX = onX ? lnx * b.hx : Math.max(-b.hx + 1.8, Math.min(b.hx - 1.8, Math.round(lx / 4.2) * 4.2));
              const snapY = onX ? Math.max(-b.hy + 1.8, Math.min(b.hy - 1.8, Math.round(ly / 4.2) * 4.2)) : lny * b.hy;
              const c2 = Math.cos(b.yaw), s2 = Math.sin(b.yaw);
              const wx = b.cx + (snapX * c2 - snapY * s2);
              const wy = b.cy + (snapX * s2 + snapY * c2);
              const wnx = lnx * c2 - lny * s2;
              const wny = lnx * s2 + lny * c2;
              this.shatterStorefrontAt(wx, tb.z, -wy, wnx, -wny, carVel.x, carVel.z, onImpact);
            }
          }
        }
      }
    }
  }

  private stepPhysics(dt: number) {
    // 1. Flying / toppling broken metal poles
    if (this.flyingPoles.length) {
      const touched = new Set<BreakableKind>();
      for (let i = this.flyingPoles.length - 1; i >= 0; i--) {
        const fp = this.flyingPoles[i];
        fp.age += dt;
        fp.x += fp.vx * dt;
        fp.y += fp.vy * dt;
        fp.z += fp.vz * dt;
        fp.vy -= 17.5 * dt;
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
        touched.add(fp.kind);

        if (fp.age > 5.0 || (fp.bounced && Math.hypot(fp.vx, fp.vz) < 0.15 && fp.age > 2.2)) {
          this.flyingPoles.splice(i, 1);
        }
      }
      for (const k of touched) this.sets[k].mesh.instanceMatrix.needsUpdate = true;
    }

    // 2. 3D glass shards
    let activeShards = false;
    const shardArr = this.shardMesh.instanceMatrix.array as Float32Array;
    for (let i = 0; i < this.shards.length; i++) {
      const p = this.shards[i];
      if (!p.active) continue;
      activeShards = true;
      p.age += dt;
      if (p.age >= p.maxAge) {
        p.active = false;
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
    if (activeShards) {
      this.shardMesh.count = this.shards.length;
      this.shardMesh.instanceMatrix.needsUpdate = true;
    }

    // 3. 3D brick & concrete masonry wall chunks
    let activeDebris = false;
    const debrisArr = this.debrisMesh.instanceMatrix.array as Float32Array;
    for (let i = 0; i < this.debris.length; i++) {
      const p = this.debris[i];
      if (!p.active) continue;
      activeDebris = true;
      p.age += dt;
      if (p.age >= p.maxAge) {
        p.active = false;
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
    if (activeDebris) {
      this.debrisMesh.count = this.debris.length;
      this.debrisMesh.instanceMatrix.needsUpdate = true;
    }

    // 4. Electric & metallic collision sparks
    let activeSparks = false;
    const sparkArr = this.sparkMesh.instanceMatrix.array as Float32Array;
    for (let i = 0; i < this.sparks.length; i++) {
      const p = this.sparks[i];
      if (!p.active) continue;
      activeSparks = true;
      p.age += dt;
      if (p.age >= p.maxAge) {
        p.active = false;
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
    if (activeSparks) {
      this.sparkMesh.count = this.sparks.length;
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
    this.flush();
    if (carPos && carVel && dt > 0) {
      this.checkCollisions(carPos, carVel, onImpact);
    }
    if (dt > 0) {
      this.stepPhysics(Math.min(0.05, dt));
    }
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
    this.shatteredMesh.removeFromParent(); this.shatteredMesh.geometry.dispose(); (this.shatteredMesh.material as THREE.Material).dispose();
    this.shardMesh.removeFromParent(); this.shardMesh.geometry.dispose(); (this.shardMesh.material as THREE.Material).dispose();
    this.debrisMesh.removeFromParent(); this.debrisMesh.geometry.dispose(); (this.debrisMesh.material as THREE.Material).dispose();
    this.sparkMesh.removeFromParent(); this.sparkMesh.geometry.dispose(); (this.sparkMesh.material as THREE.Material).dispose();
    this.signs.dispose();
    for (const s of this.lights) { s.light.removeFromParent(); s.light.dispose?.(); }
    this.root.removeFromParent();
    this.lights.length = 0;
  }
}
