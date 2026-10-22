// Draw-call reduction for rigid models: all meshes that share a material (and the same render flags)
// are baked into ONE mesh in the model's space. The AI cars are ~89 meshes each, so three of them
// were ~250 of the ~445 draw calls of a frame (each draw costs CPU in three's WebGPU backend, and
// again in the headlight shadow pass); merged by material they are ~25 each.
import * as THREE from 'three/webgpu';
import { materialsOf } from './city';

/** Float32 copy of an attribute (glTF meshopt/quantization stores int16 + normalized). */
function toFloat(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): THREE.BufferAttribute {
  const out = new Float32Array(a.count * a.itemSize);
  for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) out[i * a.itemSize + k] = a.getComponent(i, k);
  return new THREE.BufferAttribute(out, a.itemSize);
}

/**
 * Merge the meshes under `model` that are not inside any of `keep` (nodes that move, e.g. the wheels)
 * and have a single material, grouped by (material, castShadow, receiveShadow, renderOrder, visible).
 * The merged meshes are added to `model`; the originals are removed. Returns the draw calls saved.
 */
export function mergeStaticMeshes(model: THREE.Object3D, keep: THREE.Object3D[]): number {
  model.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(model.matrixWorld).invert();
  const groups = new Map<string, { mat: THREE.Material; src: THREE.Mesh; parts: THREE.Mesh[] }>();
  const ids = new Map<THREE.Material, number>();
  const isKept = (o: THREE.Object3D) => { for (let p: THREE.Object3D | null = o; p && p !== model; p = p.parent) if (keep.includes(p)) return true; return false; };
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as THREE.SkinnedMesh).isSkinnedMesh || m.morphTargetInfluences?.length || isKept(m)) return;
    if (Array.isArray(m.material) || !m.geometry.attributes.position) return;
    const mat = materialsOf(m)[0];
    if (!ids.has(mat)) ids.set(mat, ids.size);
    const key = `${ids.get(mat)}|${+m.castShadow}${+m.receiveShadow}${+m.visible}|${m.renderOrder}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { mat, src: m, parts: [] }));
    g.parts.push(m);
  });
  let saved = 0;
  const rel = new THREE.Matrix4();
  for (const { mat, src, parts } of groups.values()) {
    if (parts.length < 2) continue;
    // attributes present on every part
    const names = Object.keys(parts[0].geometry.attributes).filter((n) => parts.every((p) => p.geometry.attributes[n]));
    const geos = parts.map((p) => {
      const g = new THREE.BufferGeometry();
      for (const n of names) g.setAttribute(n, toFloat(p.geometry.attributes[n]));
      const idx = p.geometry.index;
      if (idx) g.setIndex(new THREE.BufferAttribute(idx.array.slice(), 1));
      g.applyMatrix4(rel.multiplyMatrices(inv, p.matrixWorld));
      if (rel.determinant() < 0) {
        // mirrored part (scale -1): three flips the front face per object at draw time; baked, the winding must flip
        if (g.index) { const a = g.index.array as Uint16Array | Uint32Array; for (let i = 0; i < a.length; i += 3) { const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; } }
        else for (const n of names) { const a = g.attributes[n].array as Float32Array, s = g.attributes[n].itemSize; for (let i = 0; i < g.attributes[n].count; i += 3) for (let k = 0; k < s; k++) { const t = a[(i + 1) * s + k]; a[(i + 1) * s + k] = a[(i + 2) * s + k]; a[(i + 2) * s + k] = t; } }
      }
      return g;
    });
    const indexed = geos.every((g) => g.index);
    if (!indexed) for (let i = 0; i < geos.length; i++) if (geos[i].index) geos[i] = geos[i].toNonIndexed();
    let count = 0, vcount = 0;
    for (const g of geos) { vcount += g.attributes.position.count; count += g.index ? g.index.count : 0; }
    const merged = new THREE.BufferGeometry();
    for (const n of names) {
      const itemSize = geos[0].attributes[n].itemSize;
      const arr = new Float32Array(vcount * itemSize);
      let o = 0;
      for (const g of geos) { arr.set(g.attributes[n].array as Float32Array, o); o += g.attributes[n].count * itemSize; }
      merged.setAttribute(n, new THREE.BufferAttribute(arr, itemSize));
    }
    if (indexed) {
      const arr = vcount > 65535 ? new Uint32Array(count) : new Uint16Array(count);
      let io = 0, vo = 0;
      for (const g of geos) { const ia = g.index!.array; for (let i = 0; i < ia.length; i++) arr[io + i] = ia[i] + vo; io += ia.length; vo += g.attributes.position.count; }
      merged.setIndex(new THREE.BufferAttribute(arr, 1));
    }
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, mat);
    mesh.name = `merged_${mat.name}`;
    mesh.castShadow = src.castShadow; mesh.receiveShadow = src.receiveShadow; mesh.visible = src.visible; mesh.renderOrder = src.renderOrder;
    model.add(mesh);
    for (const p of parts) p.removeFromParent();
    saved += parts.length - 1;
  }
  return saved;
}
