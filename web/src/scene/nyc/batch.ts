// Cross-tile batching for the static NYC tiles (docs/raw_city_pass.md).
//
// A tile GLB ships one small mesh per material, and every mesh is a draw call: ~200 of the frame's 261 draws
// come from ~70 streamed tiles, at roughly 56 us of renderer CPU each. This module appends every tile's
// geometry into one growable vertex/index buffer PER MATERIAL and draws the whole streamed city with one mesh
// per material. three keeps the materials (and so the shading); we own only the buffers and the draw list.
//
// Rules:
//  * a geometry is batched only when every one of its attributes is in ATTRS - a material with a bespoke
//    attribute (some tile meshes carry "glow") keeps its own mesh instead of silently losing data;
//  * quantized attributes are dequantized here (attribute.normalized: int8/uint8/int16/uint16), so tiles built
//    with different quantization settings still share one layout. Positions are transformed by the mesh's
//    world matrix and normals by its normal matrix; every other attribute is copied dequantized, so the
//    values the material reads are the ones the GPU read from the original vertex format;
//  * slots are per tile: a tile's meshes take contiguous ranges; unloading the tile zeroes their index range
//    (no ghost triangles) and returns the ranges to free lists; a material with no live tiles is disposed.
//
// Only the near (LOD0) path is batched. Far tiles stay per-tile because their visibility is toggled per tile
// when a near tile covers them (hideFarIfNear), which one batch mesh cannot express.
import * as THREE from 'three/webgpu';

interface AttrSpec { name: string; size: number; def: number[]; raw?: boolean }
/** The one vertex layout a batched geometry may use. */
const ATTRS: AttrSpec[] = [
  { name: 'position', size: 3, def: [0, 0, 0] },
  { name: 'normal', size: 3, def: [0, 1, 0] },
  { name: 'uv', size: 2, def: [0, 0] },
  { name: 'color', size: 3, def: [1, 1, 1] },
  { name: '_bld', size: 1, def: [0] },   // building id; dequantized like the GPU would (normalized storage)
];
const ATTR_BY_NAME = new Map(ATTRS.map((a) => [a.name, a]));
const ALLOWED = new Set(ATTRS.map((a) => a.name));

interface Range { start: number; count: number }
export interface Alloc {
  vertStart: number;
  vertCount: number;
  idxStart: number;
  idxCount: number;
}
export interface BatchReport {
  materials: number;
  draws: number;
  vertices: number;
  indices: number;
  tiles: number;
  rejected: number;
}

const NORMAL_MATRIX = new THREE.Matrix3();

/** Normalized integer storage -> 0..1 (unsigned) or -1..1 (signed), the convention three uses. */
function dequant(v: number, arr: ArrayLike<number>): number {
  if (arr instanceof Int8Array) return Math.max(v / 127, -1);
  if (arr instanceof Uint8Array) return v / 255;
  if (arr instanceof Int16Array) return Math.max(v / 32767, -1);
  if (arr instanceof Uint16Array) return v / 65535;
  if (arr instanceof Int32Array) return Math.max(v / 2147483647, -1);
  if (arr instanceof Uint32Array) return v / 4294967295;
  return v;
}

/** One component of an attribute, dequantized unless the attribute is a raw id. */
function component(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined, i: number, k: number, raw: boolean, def: number): number {
  if (!a) return def;
  const kk = Math.min(k, a.itemSize - 1);
  const inter = a as THREE.InterleavedBufferAttribute;
  if (inter.isInterleavedBufferAttribute) {
    const arr = inter.data.array as unknown as ArrayLike<number>;
    const v = arr[i * inter.data.stride + inter.offset + kk];
    return inter.normalized && !raw ? dequant(v, arr) : v;
  }
  const b = a as THREE.BufferAttribute;
  const arr = b.array as unknown as ArrayLike<number>;
  const v = arr[i * b.itemSize + kk];
  return b.normalized && !raw ? dequant(v, arr) : v;
}

/** Mark a written element range for upload without re-sending the whole buffer. */
function dirty(attr: THREE.BufferAttribute, start: number, count: number) {
  if (count <= 0) return;
  (attr as unknown as { addUpdateRange?: (s: number, c: number) => void }).addUpdateRange?.(start, count);
  attr.needsUpdate = true;
}

/** Append-only buffers + free lists for one material. One THREE.Mesh draws all of it. */
export class MaterialBatch {
  private data: Record<string, Float32Array> = {};
  private index = new Uint32Array(0);
  private capV = 0;
  private capI = 0;
  private usedV = 0;
  private usedI = 0;
  /** vertices owned by live tiles: usedV - liveV is dead space */
  private liveV = 0;
  private freeV: Range[] = [];
  private freeI: Range[] = [];
  readonly allocs = new Set<Alloc>();
  readonly geometry = new THREE.BufferGeometry();
  readonly mesh: THREE.Mesh;

  constructor(private scene: THREE.Scene, readonly material: THREE.Material) {
    this.grow(4096, 8192);
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.name = 'nyc_batch_' + (material.name || 'material');
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.frustumCulled = false;   // the batch spans the whole streamed city
    this.scene.add(this.mesh);
  }

  get empty() { return this.allocs.size === 0; }
  get vertices() { return this.liveV; }
  get indices() { return this.usedI; }

  // ---- buffers -------------------------------------------------------------------------------------------------------
  private grow(capV: number, capI: number) {
    for (const a of ATTRS) {
      const next = new Float32Array(capV * a.size);
      const prev = this.data[a.name];
      if (prev) next.set(prev.subarray(0, Math.min(prev.length, this.usedV * a.size)));
      this.data[a.name] = next;
    }
    const nextIdx = new Uint32Array(capI);
    if (this.index.length) nextIdx.set(this.index.subarray(0, Math.min(this.index.length, this.usedI)));
    this.index = nextIdx;
    this.capV = capV;
    this.capI = capI;
    this.rebuild();
  }

  /** (Re)build the geometry's attributes over the current arrays; a fresh attribute uploads in full. */
  private rebuild() {
    for (const a of ATTRS) {
      // Static + update ranges: r186 re-uploads a DynamicDrawUsage attribute in FULL at every draw (see
      // docs/performance.md, "Race CPU cost"), which for a 158 k-vertex batch is ~8 MB per frame. Static uploads
      // once and then only the written ranges after `needsUpdate`.
      this.geometry.setAttribute(a.name, new THREE.BufferAttribute(this.data[a.name], a.size).setUsage(THREE.StaticDrawUsage));
    }
    this.geometry.setIndex(new THREE.BufferAttribute(this.index, 1).setUsage(THREE.StaticDrawUsage));
    this.geometry.setDrawRange(0, this.usedI);
  }

  private reserveVerts(n: number): number {
    for (let k = 0; k < this.freeV.length; k++) {
      const r = this.freeV[k];
      if (r.count >= n) {
        const start = r.start;
        if (r.count === n) this.freeV.splice(k, 1);
        else { r.start += n; r.count -= n; }
        return start;
      }
    }
    if (this.usedV + n > this.capV) this.grow(Math.max(4096, this.capV * 2, this.usedV + n), this.capI);
    const start = this.usedV;
    this.usedV += n;
    return start;
  }

  private reserveIndices(n: number): number {
    for (let k = 0; k < this.freeI.length; k++) {
      const r = this.freeI[k];
      if (r.count >= n) {
        const start = r.start;
        if (r.count === n) this.freeI.splice(k, 1);
        else { r.start += n; r.count -= n; }
        return start;
      }
    }
    if (this.usedI + n > this.capI) {
      this.grow(Math.max(this.capV, this.usedV), Math.max(8192, this.capI * 2, this.usedI + n));
    }
    const start = this.usedI;
    this.usedI += n;
    return start;
  }

  // ---- add / remove --------------------------------------------------------------------------------------------------
  /** Copy one mesh's geometry in (world matrix applied). False = not batchable: keep the mesh. */
  add(mesh: THREE.Mesh): Alloc | null {
    const geo = mesh.geometry as THREE.BufferGeometry;
    const pos = geo.attributes.position as THREE.BufferAttribute | undefined;
    if (!pos || !pos.count) return null;
    for (const name of Object.keys(geo.attributes)) if (!ALLOWED.has(name)) return null;
    const count = pos.count;
    const srcIndex = geo.index;
    const idxCount = srcIndex ? srcIndex.count : count;
    if (!idxCount) return null;

    const vertStart = this.reserveVerts(count);
    const idxStart = this.reserveIndices(idxCount);
    mesh.updateWorldMatrix(true, false);
    const m = mesh.matrixWorld;
    NORMAL_MATRIX.getNormalMatrix(m);

    const posOut = this.data.position, nrmOut = this.data.normal, uvOut = this.data.uv, colOut = this.data.color, bldOut = this.data._bld;
    const src = (name: string) => geo.attributes[name] as THREE.BufferAttribute | undefined;
    const sp = src('position'), sn = src('normal'), su = src('uv'), sc = src('color'), sb = src('_bld');
    for (let i = 0; i < count; i++) {
      const px = component(sp, i, 0, false, 0), py = component(sp, i, 1, false, 0), pz = component(sp, i, 2, false, 0);
      const o = (vertStart + i) * 3;
      posOut[o] = m.elements[0] * px + m.elements[4] * py + m.elements[8] * pz + m.elements[12];
      posOut[o + 1] = m.elements[1] * px + m.elements[5] * py + m.elements[9] * pz + m.elements[13];
      posOut[o + 2] = m.elements[2] * px + m.elements[6] * py + m.elements[10] * pz + m.elements[14];

      const nx = component(sn, i, 0, false, 0), ny = component(sn, i, 1, false, 1), nz = component(sn, i, 2, false, 0);
      const tx = NORMAL_MATRIX.elements[0] * nx + NORMAL_MATRIX.elements[3] * ny + NORMAL_MATRIX.elements[6] * nz;
      const ty = NORMAL_MATRIX.elements[1] * nx + NORMAL_MATRIX.elements[4] * ny + NORMAL_MATRIX.elements[7] * nz;
      const tz = NORMAL_MATRIX.elements[2] * nx + NORMAL_MATRIX.elements[5] * ny + NORMAL_MATRIX.elements[8] * nz;
      const len = Math.hypot(tx, ty, tz) || 1;
      nrmOut[o] = tx / len; nrmOut[o + 1] = ty / len; nrmOut[o + 2] = tz / len;

      const u = (vertStart + i) * 2;
      uvOut[u] = component(su, i, 0, false, 0);
      uvOut[u + 1] = component(su, i, 1, false, 0);

      colOut[o] = component(sc, i, 0, false, 1);
      colOut[o + 1] = component(sc, i, 1, false, 1);
      colOut[o + 2] = component(sc, i, 2, false, 1);

      bldOut[vertStart + i] = component(sb, i, 0, false, 0);
    }
    for (let j = 0; j < idxCount; j++) {
      const s = srcIndex ? Number((srcIndex.array as ArrayLike<number>)[j]) : j;
      this.index[idxStart + j] = vertStart + s;
    }
    for (const a of ATTRS) dirty(this.geometry.attributes[a.name] as THREE.BufferAttribute, vertStart * a.size, count * a.size);
    dirty(this.geometry.index as THREE.BufferAttribute, idxStart, idxCount);
    this.geometry.setDrawRange(0, this.usedI);

    const alloc: Alloc = { vertStart, vertCount: count, idxStart, idxCount };
    this.allocs.add(alloc);
    this.liveV += count;
    return alloc;
  }

  /** Free a tile's range: zero its triangles first, so nothing stale is drawn before the buffers compact. */
  remove(alloc: Alloc) {
    if (!this.allocs.delete(alloc)) return;
    this.index.fill(0, alloc.idxStart, alloc.idxStart + alloc.idxCount);
    dirty(this.geometry.index as THREE.BufferAttribute, alloc.idxStart, alloc.idxCount);
    this.freeV.push({ start: alloc.vertStart, count: alloc.vertCount });
    this.freeI.push({ start: alloc.idxStart, count: alloc.idxCount });
    this.liveV -= alloc.vertCount;
  }

  /** Rebuild the arrays without holes once the dead share is large; allocation objects are updated in place. */
  compact() {
    if (this.usedV === this.liveV) return;
    const sorted = [...this.allocs].sort((a, b) => a.vertStart - b.vertStart);
    let nv = 0, ni = 0;
    let scratch = new Uint32Array(0);
    for (const a of sorted) {
      for (const at of ATTRS) {
        const size = at.size, arr = this.data[at.name];
        arr.copyWithin(nv * size, a.vertStart * size, (a.vertStart + a.vertCount) * size);
      }
      if (scratch.length < a.idxCount) scratch = new Uint32Array(a.idxCount);
      // indices first into scratch: the destination can overlap the source block
      for (let j = 0; j < a.idxCount; j++) scratch[j] = this.index[a.idxStart + j] - a.vertStart + nv;
      for (let j = 0; j < a.idxCount; j++) this.index[ni + j] = scratch[j];
      a.vertStart = nv;
      a.idxStart = ni;
      nv += a.vertCount;
      ni += a.idxCount;
    }
    for (const at of ATTRS) this.data[at.name].fill(0, nv * at.size, this.usedV * at.size);
    this.index.fill(0, ni, this.usedI);
    this.usedV = nv;
    this.usedI = ni;
    this.freeV.length = 0;
    this.freeI.length = 0;
    this.rebuild();
  }

  maybeCompact() {
    const dead = this.usedV - this.liveV;
    if (dead > 8192 && dead > this.usedV * 0.25) this.compact();
  }

  dispose() {
    this.geometry.dispose();
    this.mesh.removeFromParent();
    this.allocs.clear();
    this.data = {};
    this.freeV.length = 0;
    this.freeI.length = 0;
  }
}

/**
 * All material batches of the streamer, plus the tile -> allocations map that unload uses to free slots.
 * Enabled with ?batchcity=1; when it is off the streamer never constructs this and nothing changes.
 */
export class CityBatcher {
  private batches = new Map<THREE.Material, MaterialBatch>();
  private tiles = new Map<string, { batch: MaterialBatch; alloc: Alloc }[]>();
  private rejected = 0;

  constructor(private scene: THREE.Scene) {}

  /** Batch a tile mesh. False = leave it in the scene as its own mesh. */
  add(tileKey: string, mesh: THREE.Mesh): boolean {
    const material = mesh.material as THREE.Material;
    if (!material || Array.isArray(mesh.material)) return false;
    let batch = this.batches.get(material);
    if (!batch) { batch = new MaterialBatch(this.scene, material); this.batches.set(material, batch); }
    const alloc = batch.add(mesh);
    if (!alloc) { this.rejected++; return false; }
    const list = this.tiles.get(tileKey);
    const rec = { batch, alloc };
    if (list) list.push(rec); else this.tiles.set(tileKey, [rec]);
    mesh.removeFromParent();
    return true;
  }

  /** Free every slot this tile owned; empty material batches are disposed. */
  removeTile(tileKey: string) {
    const list = this.tiles.get(tileKey);
    if (!list) return;
    this.tiles.delete(tileKey);
    const touched = new Set<MaterialBatch>();
    for (const { batch, alloc } of list) { batch.remove(alloc); touched.add(batch); }
    for (const batch of touched) {
      batch.maybeCompact();
      if (batch.empty) { batch.dispose(); this.batches.delete(batch.material); }
    }
  }

  report(): BatchReport {
    let vertices = 0, indices = 0;
    for (const b of this.batches.values()) { vertices += b.vertices; indices += b.indices; }
    return { materials: this.batches.size, draws: this.batches.size, vertices, indices, tiles: this.tiles.size, rejected: this.rejected };
  }

  dispose() {
    for (const b of this.batches.values()) b.dispose();
    this.batches.clear();
    this.tiles.clear();
  }
}
