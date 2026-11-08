// Instanced city props (the threejspunk approach, docs/threejspunk_notes.md): ONE InstancedMesh per
// asset per LOD (per material primitive), fed every update with only the instances that are in view
// and in range, at the LOD their distance asks for. Placements come from data/city_props.json
// (make_city.py); the meshes from city_props.glb (make_city_props.py), nodes "<asset>__lod<n>".
//
// Culling, coarse to fine:
//  1. cells (city_props.json "cell", 120 m): AABB of every instance in the cell (plus its radius);
//     a cell farther than its farthest asset's draw distance, or outside the frustum, is skipped
//     whole (most of the city at any moment);
//  2. per instance in surviving cells: distance (each asset has its own draw distance: sills 70 m,
//     lamps 230 m) and a bounding-sphere frustum test;
//  3. LOD by distance (asset "lod": [d1, d2] -> LOD0 below d1, LOD1 below d2, LOD2 beyond).
// The fog (FogExp2 0.0085) leaves ~6 % contrast at 200 m and ~0.1 % at 300 m, so nothing beyond
// ~230 m is worth drawing. Updates are skipped while the camera hasn't moved/turned noticeably.
//
// Each (asset, LOD) owns one InstancedBufferAttribute shared by the InstancedMeshes of its
// primitives (one per material), so a multi-material prop costs one matrix upload, not one per
// material. Instance matrices are precomputed per LOD (placement x the node's dequantization matrix:
// meshopt's KHR_mesh_quantization stores positions as int16 + a node transform, which has to apply
// BEFORE the instance transform), so an update only copies 16 floats per drawn instance.
import * as THREE from 'three/webgpu';

/**
 * Upload rules of three.js WebGPU (r186), measured 2026-11-08 in a 6-car race (3.2 MB and ~2,100 buffer writes per frame):
 *  - an attribute with DynamicDrawUsage is re-uploaded WHOLE at every draw that uses it, changed or not (Attributes.update);
 *  - an InstancedMesh whose matrices fit a uniform buffer (<= 1024 instances = 64 KiB) reads them from a uniform array,
 *    which is re-uploaded every frame too (Buffer.update() is always true).
 * So instance buffers stay StaticDrawUsage (uploaded only after needsUpdate, honouring updateRanges) and every instanced
 * mesh gets at least INSTANCE_MIN slots, which puts its matrices in a vertex buffer. The extra slots are never drawn.
 */
export const INSTANCE_MIN = 1025;
export const instanceSlots = (n: number) => Math.max(n, INSTANCE_MIN);

export interface PropAssetJson {
  lod: [number, number]; draw: number; radius: number; count: number;
  data: number[];   // rows of 5: x, y, z, yaw, sx (three.js coordinates)
  collider?: { half: [number, number, number]; centre: [number, number, number] };
}
export interface PropsJson { schema: string; library: string; cell: number; assets: Record<string, PropAssetJson> }

interface LodSet { attr: THREE.InstancedBufferAttribute; meshes: THREE.InstancedMesh[]; mats: Float32Array; n: number }
interface Asset {
  name: string; meta: PropAssetJson; lods: LodSet[];
  pos: Float32Array;          // instance positions (x, y, z), for distance tests
  d1: number; d2: number; draw: number; radius: number;
}
interface Cell { box: THREE.Box3; reach: number; items: { asset: Asset; idx: Uint32Array }[] }

export class CityInstances {
  readonly root = new THREE.Group();
  readonly assets: Asset[] = [];
  private cells: Cell[] = [];
  private frustum = new THREE.Frustum();
  private projView = new THREE.Matrix4();
  private sphere = new THREE.Sphere();
  private lastPos = new THREE.Vector3(Infinity, 0, 0);
  private lastDir = new THREE.Vector3();
  private dir = new THREE.Vector3();
  /** instances drawn in the last update (all LODs) */
  drawn = 0;
  /** multiplier on prop draw distances (lowered on medium/low presets to cut distant fogged instances) */
  drawScale = 1;

  constructor(library: THREE.Object3D, json: PropsJson) {
    this.root.name = 'city_props';
    library.updateMatrixWorld(true);
    const nodes = new Map<string, THREE.Object3D>();
    library.traverse((o) => { if (/__lod\d$/.test(o.name)) nodes.set(o.name, o); });
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    for (const [name, meta] of Object.entries(json.assets)) {
      const n = meta.count, d = meta.data;
      // placement matrices (rows: x, y, z, yaw, sx)
      const place = new Float32Array(n * 16), pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const r = i * 5;
        p.set(d[r], d[r + 1], d[r + 2]);
        q.setFromAxisAngle(up, d[r + 3]);
        s.set(d[r + 4], 1, 1);
        m.compose(p, q, s).toArray(place, i * 16);
        pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
      }
      const lods: LodSet[] = [];
      // Single instanced draw call per asset (using LOD1 where available, else LOD0): avoids splitting
      // small prop counts across 3 simultaneous LOD draw calls and 3 buffer uploads per asset every frame.
      const singleNode = nodes.get(`${name}__lod1`) ?? nodes.get(`${name}__lod0`);
      for (const node of singleNode ? [singleNode] : []) {
        const prims: THREE.Mesh[] = [];
        node.traverse((o) => { if ((o as THREE.Mesh).isMesh) prims.push(o as THREE.Mesh); });
        // all primitives of one glTF mesh share the node transform (= the dequantization matrix)
        const deq = prims[0].matrixWorld;
        const mats = new Float32Array(n * 16);
        const a = new THREE.Matrix4();
        for (let i = 0; i < n; i++) a.fromArray(place, i * 16).multiply(deq).toArray(mats, i * 16);
        const attr = new THREE.InstancedBufferAttribute(new Float32Array(instanceSlots(n) * 16), 16);   // static: see INSTANCE_MIN
        const meshes = prims.map((src) => {
          const im = new THREE.InstancedMesh(src.geometry, src.material, instanceSlots(n));
          im.instanceMatrix = attr;
          im.count = 0;
          im.frustumCulled = false;   // culled here, per instance
          im.castShadow = false;
          im.receiveShadow = true;
          im.name = node.name;
          for (const mat of (Array.isArray(im.material) ? im.material : [im.material]) as THREE.MeshStandardMaterial[]) {
            // blended props (aircon grille, glass) -> alpha test: no sorting, depth-correct, cheaper
            if (mat.transparent) { mat.transparent = false; mat.alphaTest = 0.5; mat.depthWrite = true; }
          }
          this.root.add(im);
          return im;
        });
        lods.push({ attr, meshes, mats, n: 0 });
      }
      if (!lods.length) { console.warn(`city props: no meshes for ${name}`); continue; }
      this.assets.push({ name, meta, lods, pos, d1: meta.lod[0], d2: meta.lod[1], draw: meta.draw, radius: meta.radius });
    }
    this.buildCells(json.cell);
  }

  private buildCells(size: number) {
    const map = new Map<string, { box: THREE.Box3; reach: number; items: Map<Asset, number[]> }>();
    const v = new THREE.Vector3();
    for (const a of this.assets) {
      for (let i = 0; i < a.meta.count; i++) {
        const x = a.pos[i * 3], y = a.pos[i * 3 + 1], z = a.pos[i * 3 + 2];
        const key = `${Math.floor(x / size)},${Math.floor(z / size)}`;
        let c = map.get(key);
        if (!c) map.set(key, (c = { box: new THREE.Box3(), reach: 0, items: new Map() }));
        c.box.expandByPoint(v.set(x - a.radius, y - a.radius, z - a.radius)).expandByPoint(v.set(x + a.radius, y + a.radius * 2, z + a.radius));
        c.reach = Math.max(c.reach, a.draw);
        let list = c.items.get(a);
        if (!list) c.items.set(a, (list = []));
        list.push(i);
      }
    }
    for (const c of map.values()) this.cells.push({ box: c.box, reach: c.reach, items: [...c.items].map(([asset, l]) => ({ asset, idx: Uint32Array.from(l) })) });
  }

  /** Re-pick visible instances and LODs. Cheap when the camera hasn't moved (skipped). */
  update(camera: THREE.Camera, force = false) {
    const cp = camera.position;
    camera.getWorldDirection(this.dir);
    if (!force && cp.distanceToSquared(this.lastPos) < 3.2 && this.dir.dot(this.lastDir) > 0.9985) return;
    this.lastPos.copy(cp);
    this.lastDir.copy(this.dir);
    camera.updateMatrixWorld();
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView, camera.coordinateSystem);
    for (const a of this.assets) for (const l of a.lods) l.n = 0;
    const cx = cp.x, cy = cp.y, cz = cp.z, sph = this.sphere, ds = this.drawScale, ds2 = ds * ds;
    for (const c of this.cells) {
      const dc = c.box.distanceToPoint(cp);
      if (dc > c.reach * ds || !this.frustum.intersectsBox(c.box)) continue;
      for (const { asset: a, idx } of c.items) {
        const adraw = a.draw * ds;
        if (dc > adraw) continue;
        const draw2 = adraw * adraw, d1 = a.d1 * a.d1 * ds2, d2 = a.d2 * a.d2 * ds2, last = a.lods.length - 1;
        for (let j = 0; j < idx.length; j++) {
          const i = idx[j], x = a.pos[i * 3], y = a.pos[i * 3 + 1], z = a.pos[i * 3 + 2];
          const dd = (x - cx) * (x - cx) + (y - cy) * (y - cy) + (z - cz) * (z - cz);
          if (dd > draw2) continue;
          sph.center.set(x, y + a.radius * 0.5, z);
          sph.radius = a.radius;
          if (!this.frustum.intersectsSphere(sph)) continue;
          const l = a.lods[Math.min(last, dd < d1 ? 0 : dd < d2 ? 1 : 2)];
          const dst = l.attr.array as Float32Array, src = l.mats, si = i * 16, di = l.n * 16;
          for (let k = 0; k < 16; k++) dst[di + k] = src[si + k];
          l.n++;
        }
      }
    }
    let drawn = 0;
    for (const a of this.assets) for (const l of a.lods) {
      drawn += l.n;
      for (const im of l.meshes) { im.count = l.n; im.visible = l.n > 0; }
      if (l.n) {
        l.attr.clearUpdateRanges();
        l.attr.addUpdateRange(0, l.n * 16);
        l.attr.needsUpdate = true;
      }
    }
    this.drawn = drawn;
  }

  /**
   * Warm-up: every (asset, LOD, material) mesh visible with one (degenerate, all-zero) instance, so
   * its pipeline is compiled and its GPU buffers made behind the loading screen. Without it each LOD
   * first coming into range while driving compiled a pipeline mid-frame (40-250 ms hitches).
   * Call with false afterwards, then update(camera, true).
   */
  warmup(on: boolean) {
    for (const a of this.assets) for (const l of a.lods) for (const im of l.meshes) { im.count = on ? 1 : l.n; im.visible = on || l.n > 0; }
  }

  /** World-space box colliders for the assets that declare one (hydrants, bins, utility boxes). */
  forEachCollider(cb: (centre: THREE.Vector3, half: THREE.Vector3, rot: THREE.Quaternion) => void) {
    const up = new THREE.Vector3(0, 1, 0), c = new THREE.Vector3(), h = new THREE.Vector3(), q = new THREE.Quaternion();
    for (const a of this.assets) {
      const col = a.meta.collider;
      if (!col) continue;
      const d = a.meta.data;
      for (let i = 0; i < a.meta.count; i++) {
        const r = i * 5;
        q.setFromAxisAngle(up, d[r + 3]);
        c.set(col.centre[0] * d[r + 4], col.centre[1], col.centre[2]).applyQuaternion(q).add(new THREE.Vector3(d[r], d[r + 1], d[r + 2]));
        h.set(col.half[0] * d[r + 4], col.half[1], col.half[2]);
        cb(c, h, q);
      }
    }
  }
}
