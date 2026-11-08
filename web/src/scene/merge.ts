// Draw-call reduction for rigid models: all meshes that share a material (and the same render flags)
// are baked into ONE mesh in the model's space. The AI cars are ~89 meshes each, so three of them
// were ~250 of the ~445 draw calls of a frame (each draw costs CPU in three's WebGPU backend, and
// again in the headlight shadow pass); merged by material they are ~25 each.
import * as THREE from 'three/webgpu';
import { materialsOf } from './city';
import { Fn, attribute, cos, cross, dot, float, normalLocal, positionLocal, sin, uniform } from 'three/tsl';

/** Float32 copy of an attribute (glTF meshopt/quantization stores int16 + normalized). */
function toFloat(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): THREE.BufferAttribute {
  const out = new Float32Array(a.count * a.itemSize);
  for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) out[i * a.itemSize + k] = a.getComponent(i, k);
  return new THREE.BufferAttribute(out, a.itemSize);
}

const NO_DENT_PREFIX = ['wheel_', 'caliper_', 'interior', 'seat', 'dashboard', 'steering', 'wheel_well', 'underbody', 'hood_inner'];

/**
 * Merge the meshes under `model` that are not inside any of `keep` (nodes that move, e.g. the wheels)
 * and have a single material, grouped by (material, castShadow, receiveShadow, renderOrder, visible, noDent).
 * The merged meshes are added to `model`; the originals are removed. Returns the draw calls saved.
 */
export function mergeStaticMeshes(model: THREE.Object3D, keep: THREE.Object3D[]): number {
  model.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(model.matrixWorld).invert();
  const groups = new Map<string, { mat: THREE.Material; src: THREE.Mesh; parts: THREE.Mesh[]; noDent: boolean }>();
  const ids = new Map<THREE.Material, number>();
  const isKept = (o: THREE.Object3D) => { for (let p: THREE.Object3D | null = o; p && p !== model; p = p.parent) if (keep.includes(p)) return true; return false; };
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as THREE.SkinnedMesh).isSkinnedMesh || m.morphTargetInfluences?.length || isKept(m)) return;
    if (Array.isArray(m.material) || !m.geometry.attributes.position) return;
    const mat = materialsOf(m)[0];
    if (!ids.has(mat)) ids.set(mat, ids.size);
    const noDent = NO_DENT_PREFIX.some((p) => m.name.startsWith(p));
    const attrs = Object.keys(m.geometry.attributes).sort().join(',');
    const key = `${ids.get(mat)}|${+m.castShadow}${+m.receiveShadow}${+m.visible}${+noDent}|${m.renderOrder}|${attrs}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { mat, src: m, parts: [], noDent }));
    g.parts.push(m);
  });
  let saved = 0;
  const rel = new THREE.Matrix4();
  for (const { mat, src, parts, noDent } of groups.values()) {
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
    mesh.name = noDent ? `underbody_merged_${mat.name}` : `merged_${mat.name}`;
    mesh.castShadow = src.castShadow; mesh.receiveShadow = src.receiveShadow; mesh.visible = src.visible; mesh.renderOrder = src.renderOrder;
    model.add(mesh);
    for (const p of parts) p.removeFromParent();
    saved += parts.length - 1;
  }
  return saved;
}

/**
 * The four wheels of a rigid model that only SPIN (the AI cars: no steering, one angle for all four) merged into one mesh
 * per material: 20 draws (5 materials x 4 wheels) -> 5, and the same again in the headlight shadow pass. Each vertex keeps
 * its wheel's hub and spin axis (model space) and the vertex shader turns it by the mesh's `userData.spin` (radians), the
 * normal with it; the shadow pass gets the same transform. Materials are converted to node materials once per source
 * material (shared by every model merged here). Returns the merged meshes (set their userData.spin every frame).
 */
const wheelMats = new Map<THREE.Material, THREE.Material>();
const spinU = uniform(0).onObjectUpdate(({ object }) => (object?.userData.spin as number) ?? 0);
function spinMaterial(src: THREE.Material): THREE.Material {
  let m = wheelMats.get(src);
  if (m) return m;
  const lib = new Map<string, new () => THREE.Material>([
    ['MeshPhysicalMaterial', THREE.MeshPhysicalNodeMaterial], ['MeshStandardMaterial', THREE.MeshStandardNodeMaterial],
    ['MeshBasicMaterial', THREE.MeshBasicNodeMaterial], ['MeshLambertMaterial', THREE.MeshLambertNodeMaterial], ['MeshPhongMaterial', THREE.MeshPhongNodeMaterial],
  ]);
  let nm: THREE.NodeMaterial;
  if ((src as THREE.NodeMaterial).isNodeMaterial) nm = src.clone() as THREE.NodeMaterial;
  else {
    const C = lib.get(src.type) ?? THREE.MeshStandardNodeMaterial;
    nm = new C() as THREE.NodeMaterial;
    for (const k in src) if (k !== 'uuid' && k !== 'id') (nm as unknown as Record<string, unknown>)[k] = (src as unknown as Record<string, unknown>)[k];
  }
  const hub = attribute('whub', 'vec3'), axis = attribute('waxis', 'vec3');
  const c = cos(spinU), s = sin(spinU);
  // Rodrigues: v' = v c + (k x v) s + k (k . v)(1 - c)
  const rot = (v: THREE.Node<'vec3'>) => v.mul(c).add(cross(axis, v).mul(s)).add(axis.mul(dot(axis, v).mul(float(1).sub(c))));
  nm.positionNode = Fn(() => {
    normalLocal.assign(rot(normalLocal));
    return hub.add(rot(positionLocal.sub(hub)));
  })();
  nm.castShadowPositionNode = hub.add(rot(positionLocal.sub(hub)));
  nm.name = src.name;
  wheelMats.set(src, nm);
  return nm;
}

export function mergeSpinningWheels(model: THREE.Object3D, wheels: THREE.Object3D[]): THREE.Mesh[] {
  model.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(model.matrixWorld).invert();
  const groups = new Map<THREE.Material, { parts: { m: THREE.Mesh; hub: THREE.Vector3; axis: THREE.Vector3 }[] }>();
  const rel = new THREE.Matrix4(), q = new THREE.Quaternion();
  for (const w of wheels) {
    const hub = new THREE.Vector3().setFromMatrixPosition(rel.multiplyMatrices(inv, w.matrixWorld));
    // node.quaternion = Rx(spin) * rest: the spin turns about the PARENT's x axis
    rel.multiplyMatrices(inv, w.parent!.matrixWorld);
    rel.decompose(new THREE.Vector3(), q, new THREE.Vector3());
    const axis = new THREE.Vector3(1, 0, 0).applyQuaternion(q).normalize();
    w.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || Array.isArray(m.material) || !m.geometry.attributes.position) return;
      const mat = materialsOf(m)[0];
      let g = groups.get(mat);
      if (!g) groups.set(mat, (g = { parts: [] }));
      g.parts.push({ m, hub, axis });
    });
  }
  const out: THREE.Mesh[] = [];
  for (const [mat, { parts }] of groups) {
    const names = Object.keys(parts[0].m.geometry.attributes).filter((n) => parts.every((p) => p.m.geometry.attributes[n]) && n !== 'tangent');
    const geos = parts.map(({ m, hub, axis }) => {
      const g = new THREE.BufferGeometry();
      for (const n of names) g.setAttribute(n, toFloat(m.geometry.attributes[n]));
      const idx = m.geometry.index;
      g.setIndex(idx ? new THREE.BufferAttribute(idx.array.slice(), 1) : null);
      g.applyMatrix4(rel.multiplyMatrices(inv, m.matrixWorld));
      if (rel.determinant() < 0 && g.index) { const a = g.index.array as Uint16Array | Uint32Array; for (let i = 0; i < a.length; i += 3) { const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; } }
      const n = g.attributes.position.count, h = new Float32Array(n * 3), ax = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { h[i * 3] = hub.x; h[i * 3 + 1] = hub.y; h[i * 3 + 2] = hub.z; ax[i * 3] = axis.x; ax[i * 3 + 1] = axis.y; ax[i * 3 + 2] = axis.z; }
      g.setAttribute('whub', new THREE.BufferAttribute(h, 3));
      g.setAttribute('waxis', new THREE.BufferAttribute(ax, 3));
      return g.index ? g : g.toNonIndexed();
    });
    const all = [...names, 'whub', 'waxis'];
    let vcount = 0, icount = 0;
    for (const g of geos) { vcount += g.attributes.position.count; icount += g.index!.count; }
    const merged = new THREE.BufferGeometry();
    for (const n of all) {
      const size = geos[0].attributes[n].itemSize, arr = new Float32Array(vcount * size);
      let o = 0;
      for (const g of geos) { arr.set(g.attributes[n].array as Float32Array, o); o += g.attributes[n].count * size; }
      merged.setAttribute(n, new THREE.BufferAttribute(arr, size));
    }
    const ia = vcount > 65535 ? new Uint32Array(icount) : new Uint16Array(icount);
    let io = 0, vo = 0;
    for (const g of geos) { const a = g.index!.array; for (let i = 0; i < a.length; i++) ia[io + i] = a[i] + vo; io += a.length; vo += g.attributes.position.count; }
    merged.setIndex(new THREE.BufferAttribute(ia, 1));
    merged.computeBoundingSphere();
    merged.boundingSphere!.radius += 0.05;
    const src = parts[0].m;
    const mesh = new THREE.Mesh(merged, spinMaterial(mat));
    mesh.name = `wheels_${mat.name}`;
    mesh.castShadow = src.castShadow; mesh.receiveShadow = src.receiveShadow; mesh.renderOrder = src.renderOrder;
    mesh.userData.spin = 0;
    model.add(mesh);
    for (const p of parts) p.m.removeFromParent();
    out.push(mesh);
  }
  return out;
}
