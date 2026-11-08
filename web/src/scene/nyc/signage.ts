// New York signage: Times Square style LED screens and neon shop signs, driven by the photorealistic 2048x2048 CanvasTexture atlas (signAtlas.ts).
//
// One InstancedMesh of unit quads (2 triangles each) with ONE TSL material sampling the high-resolution sign atlas:
//   kind 0..7   big Times Square LED megascreens (rows 0..3 of the atlas)
//   kind 10..15 street-level backlit / neon shop signs (rows 4..7 of the atlas)
// Also exported here: the slot allocator (`InstanceSet`) the props use, so tiles can stream in and out without re-allocating or recompiling.
import * as THREE from 'three/webgpu';
import {
  uniform, instancedBufferAttribute, uv, float, vec2, vec3, floor, fract, mix, step, smoothstep, abs, min, sin, length,
  mod, hash, clamp, texture,
} from 'three/tsl';
import { getSignAtlasTexture } from './signAtlas';

/** Shared night-time clock (seconds) driving every procedural animation of the New York props. Advanced by NycProps.update. */
export const nycTime = uniform(0);

// ---- slot allocator --------------------------------------------------------------------------------------------------------------------

export type InstanceFill = (row: number[], m: Float32Array, mo: number, extra: Float32Array | null, eo: number) => void;

/** Writes a column-major instance matrix: translation (game frame x, y, z up -> three x, z, -y), yaw about three Y, per-axis scale. */
export function writeMatrix(a: Float32Array, o: number, x: number, y: number, z: number, yaw: number, sx = 1, sy = 1, sz = 1) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  a[o] = sx * c; a[o + 1] = 0; a[o + 2] = -sx * s; a[o + 3] = 0;
  a[o + 4] = 0; a[o + 5] = sy; a[o + 6] = 0; a[o + 7] = 0;
  a[o + 8] = sz * s; a[o + 9] = 0; a[o + 10] = sz * c; a[o + 11] = 0;
  a[o + 12] = x; a[o + 13] = z; a[o + 14] = -y; a[o + 15] = 1;
}

/**
 * A pre-allocated InstancedMesh whose slots are leased per tile. Slots of unloaded tiles are zeroed (degenerate) and reused; the draw count is the
 * high-water mark (never below 1, so the pipeline is compiled at the first frame). Uploads happen at most once per frame, from flush().
 */
export class InstanceSet {
  readonly mesh: THREE.InstancedMesh;
  readonly extra: THREE.InstancedBufferAttribute | null;
  private tiles = new Map<string, number[]>();
  private free: number[] = [];
  private high = 0;
  private dirty = true;
  private warned = false;
  dropped = 0;

  constructor(geometry: THREE.BufferGeometry, material: THREE.Material, readonly capacity: number, private extraStride = 0, name = 'nyc', extraAttr?: THREE.InstancedBufferAttribute) {
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceMatrix.array.fill(0);
    this.mesh.count = 1;
    if (extraStride) {
      this.extra = extraAttr ?? new THREE.InstancedBufferAttribute(new Float32Array(capacity * extraStride), extraStride);
      this.extra.setUsage(THREE.DynamicDrawUsage);
    } else this.extra = null;
  }

  get used() { return this.high - this.free.length; }

  add(key: string, rows: number[][] | undefined, fill: InstanceFill): number[] {
    this.remove(key);
    if (!rows || !rows.length) return [];
    const slots: number[] = [];
    const m = this.mesh.instanceMatrix.array as Float32Array;
    const ex = this.extra ? (this.extra.array as Float32Array) : null;
    for (const row of rows) {
      let s: number;
      if (this.free.length) s = this.free.pop()!;
      else if (this.high < this.capacity) s = this.high++;
      else { this.dropped++; if (!this.warned) { this.warned = true; console.warn(`nyc ${this.mesh.name}: capacity ${this.capacity} reached`); } continue; }
      fill(row, m, s * 16, ex, s * this.extraStride);
      slots.push(s);
    }
    this.tiles.set(key, slots);
    this.dirty = true;
    return slots;
  }

  /** Hide a single instance slot (used when a breakable pole or street prop is knocked down by collision). */
  hideSlot(slot: number) {
    const m = this.mesh.instanceMatrix.array as Float32Array;
    m.fill(0, slot * 16, slot * 16 + 16);
    this.dirty = true;
  }

  /** Copy of one instance's matrix (16 floats). */
  getSlot(slot: number) { return (this.mesh.instanceMatrix.array as Float32Array).slice(slot * 16, slot * 16 + 16); }
  /** Put a saved matrix back into a slot (after hideSlot). */
  setSlot(slot: number, m: Float32Array) {
    (this.mesh.instanceMatrix.array as Float32Array).set(m, slot * 16);
    this.dirty = true;
  }

  remove(key: string) {
    const slots = this.tiles.get(key);
    if (!slots) return;
    const m = this.mesh.instanceMatrix.array as Float32Array;
    for (const s of slots) { m.fill(0, s * 16, s * 16 + 16); this.free.push(s); }
    this.tiles.delete(key);
    this.dirty = true;
  }

  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    if (this.free.length) {
      const set = new Set(this.free);
      while (this.high > 0 && set.has(this.high - 1)) { set.delete(this.high - 1); this.high--; }
      this.free = [...set];
    }
    this.mesh.count = Math.max(1, this.high);
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.extra) this.extra.needsUpdate = true;
  }

  dispose() { this.mesh.geometry.dispose(); (this.mesh.material as THREE.Material).dispose(); this.mesh.dispose(); }
}

// ---- the sign material --------------------------------------------------------------------------------------------------------------

const CAP = 2.2;   // max linear emissive per channel after all gains (keeps bloom crisp)

export function createSignMaterial(data: THREE.InstancedBufferAttribute) {
  const atlas = getSignAtlasTexture();
  const d: any = instancedBufferAttribute(data);          // x kind, y seed, z width m, w height m
  const kind = d.x, seed = d.y, W = d.z, H = d.w;
  const U: any = uv();
  const t = nycTime;
  const isNeon = step(9.5, kind);

  // Physical LED diode pitch (12 cm) + 1.6 m modular cabinet seam grid
  const px = float(0.12);
  const grid = vec2(W.div(px), H.div(px));
  const F: any = fract(U.mul(grid));
  const diode = smoothstep(0.66, 0.22, length(F.sub(0.5)));
  const cab = smoothstep(0.012, 0.035, min(fract(U.x.mul(W).div(1.6)), fract(U.y.mul(H).div(1.6))));
  const ledMask = mix(0.76, 1.0, diode).mul(mix(0.86, 1.0, cab));

  // Big billboard atlas cell (kinds 0..7 -> 2 cols x 4 rows in top 75% of atlas)
  const bIdx = clamp(floor(mod(kind.add(floor(seed.mul(8.0))), 8.0)), 0, 7);
  const bCol = mod(bIdx, 2.0);
  const bRow = floor(bIdx.div(2.0));
  // Subtle scrolling ticker animation on bottom 16% of financial/news boards (bIdx == 2 or 6)
  const isTicker = step(abs(bIdx.sub(2.0)), 0.5).add(step(abs(bIdx.sub(6.0)), 0.5)).mul(step(U.y, 0.16));
  const uScroll = fract(U.x.add(t.mul(0.06).mul(isTicker)));
  const uBig = bCol.mul(0.5).add(clamp(uScroll, 0.015, 0.985).mul(0.5));
  const vBig = float(1.0).sub(bRow.add(float(1.0).sub(clamp(U.y, 0.02, 0.98))).mul(0.1875));

  // Street-level shop sign atlas cell (kinds 10..15 -> 2 cols x 4 rows in bottom 25% of atlas)
  const sIdx = clamp(floor(mod(kind.sub(10.0).add(floor(seed.mul(8.0))), 8.0)), 0, 7);
  const sCol = mod(sIdx, 2.0);
  const sRow = floor(sIdx.div(2.0));
  const uShop = sCol.mul(0.5).add(clamp(U.x, 0.015, 0.985).mul(0.5));
  const vShop = float(0.25).sub(sRow.add(float(1.0).sub(clamp(U.y, 0.04, 0.96))).mul(0.0625));

  const atlasUV = mix(vec2(uBig, vBig), vec2(uShop, vShop), isNeon);
  const texCol = texture(atlas, atlasUV).rgb;

  // Subtle video scanline & brightness breath on big screens; occasional warm neon tube flicker on small shop signs
  const breath = sin(t.mul(1.4).add(seed.mul(19.0))).mul(0.06).add(0.96);
  const flick = mix(1.0, 0.72, step(0.96, hash(floor(t.mul(6.0)).add(seed.mul(100.0)))).mul(isNeon));

  // Dark structural steel bezel around billboards (0.22 m)
  const edge = min(min(U.x.mul(W), W.mul(U.x.oneMinus())), min(U.y.mul(H), H.mul(U.y.oneMinus())));
  const bezel = smoothstep(0.14, 0.22, edge);
  const screenLit = texCol.mul(ledMask).mul(breath).mul(bezel).add(vec3(0.012, 0.014, 0.018));
  const shopLit = texCol.mul(flick).mul(smoothstep(0.03, 0.07, edge));
  const lit = mix(screenLit, shopLit, isNeon);
  const capped = min(lit.mul(mix(1.38, 1.55, isNeon)), vec3(CAP));

  const mat = new THREE.MeshBasicNodeMaterial();
  mat.colorNode = capped;
  mat.side = THREE.FrontSide;
  mat.name = 'nyc_sign';
  return mat;
}

/** Colour (rgb 0..1) the pooled lights use for a sign of this kind. */
export const SIGN_LIGHT: Record<number, [number, number, number]> = {
  0: [0.95, 0.75, 0.48], 1: [1.0, 0.38, 0.32], 2: [0.25, 0.85, 0.75], 3: [0.42, 0.75, 1.0], 4: [1.0, 0.22, 0.25], 5: [0.95, 0.55, 0.28], 6: [0.55, 0.78, 1.0], 7: [0.95, 0.68, 0.38],
  10: [0.35, 0.78, 1.0], 11: [1.0, 0.68, 0.28], 12: [0.3, 0.92, 0.62], 13: [0.45, 0.72, 1.0], 14: [1.0, 0.84, 0.45], 15: [0.95, 0.48, 0.75],
};

/** Streams the `sign` entries of the tiles: [x, y, z(centre, above ground), yaw (outward wall normal), w, h, kind]. */
export class NycSigns {
  readonly set: InstanceSet;
  constructor(scene: THREE.Object3D, capacity = 4000) {
    const data = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.set = new InstanceSet(new THREE.PlaneGeometry(1, 1), createSignMaterial(data), capacity, 4, 'nyc_signs', data);
    scene.add(this.set.mesh);
  }
  setTile(key: string, rows: number[][] | undefined, groundZ = 0) {
    this.set.add(key, rows, (r, m, mo, ex, eo) => {
      ex![eo] = r[6]; ex![eo + 1] = (Math.abs(r[0]) * 0.137 + Math.abs(r[1]) * 0.291) % 1; ex![eo + 2] = r[4]; ex![eo + 3] = r[5];
      writeMatrix(m, mo, r[0], r[1], r[2] + groundZ, r[3] + Math.PI / 2, r[4], r[5], 1);   // quad faces local +Z; +90 deg maps it onto the wall normal
    });
  }
  removeTile(key: string) { this.set.remove(key); }
  flush() { this.set.flush(); }
  dispose() { this.set.mesh.removeFromParent(); this.set.dispose(); }
}
