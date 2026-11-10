// Workshop dressing: CC0 models (Poly Haven, built by tools/garage/build_props.py) placed along the walls and in the
// corners. Every prop stands OUTSIDE the camera's orbit (radius 7.6 m around the turntable), so nothing ever sits
// between the lens and the car. They are shaded by the room's bake (materials.ts bakedPropMaterial): each placement
// gets its own baked light attributes while sharing the model's vertex buffers.
import * as THREE from 'three/webgpu';
import { loadGLTF } from '../loaders';
import type { LightBake } from './bake';
import { bakedPropMaterial } from './materials';

interface Place { m: string; p: [number, number, number]; ry?: number; rx?: number; s?: number }

const HPI = Math.PI / 2;
const tyres = (x: number, z: number, n: number, ry0 = 0): Place[] =>
  Array.from({ length: n }, (_, i) => ({ m: 'old_tyre', p: [x + Math.sin(i * 2.1) * 0.02, 0.083 + i * 0.166, z + Math.cos(i * 1.7) * 0.02] as [number, number, number], rx: HPI, ry: ry0 + i * 0.7 }));

export const PLACES: Place[] = [
  // back wall, right of the mural: racking, crates, drums
  { m: 'steel_frame_shelves_01', p: [6.9, 0, -8.68], s: 0.1 },
  { m: 'steel_frame_shelves_01', p: [8.05, 0, -8.68], s: 0.1 },
  { m: 'steel_frame_shelves_01', p: [9.2, 0, -8.68], s: 0.1 },
  { m: 'plastic_crate_02', p: [10.5, 0, -8.5], ry: 0.1 },
  { m: 'plastic_crate_02', p: [10.52, 0.254, -8.5], ry: -0.05 },
  { m: 'plastic_crate_02', p: [11.15, 0, -8.45], ry: 0.3 },
  { m: 'Barrel_01', p: [11.4, 0, -7.4] },
  { m: 'Barrel_01', p: [11.45, 0, -6.72], ry: 1.3 },
  { m: 'Barrel_01', p: [10.78, 0, -7.05], ry: 2.2 },
  ...tyres(11.3, -5.3, 5), ...tyres(10.62, -4.7, 4, 1), ...tyres(11.35, -4.25, 3, 2),
  { m: 'portable_generator', p: [11.2, 0, -3.3], ry: -HPI + 0.15 },
  // right wall, front: the bench
  { m: 'korean_fire_extinguisher_01', p: [11.72, 0, 3.45], ry: -HPI },
  { m: 'metal_office_desk', p: [11.48, 0, 4.9], ry: -HPI },
  { m: 'metal_tool_chest', p: [11.5, 0.79, 4.35], ry: -HPI },
  { m: 'boombox', p: [11.55, 0.79, 5.45], ry: -HPI + 0.25 },
  { m: 'metal_stool_01', p: [10.55, 0, 5.1], ry: 0.4 },
  { m: 'tool_cart', p: [10.6, 0, 6.9], ry: -1.15 },
  { m: 'metal_jerrycan_green', p: [11.6, 0, 6.25], ry: 0.2 },
  { m: 'metal_jerrycan_green', p: [11.66, 0, 6.62], ry: -0.3 },
  { m: 'utility_box_01', p: [11.76, 1.05, 7.9], ry: -HPI },
  { m: 'WetFloorSign_01', p: [6.9, 0, 8.3], ry: 2.6 },
  // left side: a project under a dust cover, a place to sit, more rubber
  { m: 'covered_car', p: [-10.85, 0, 5.5], ry: 0.04 },
  { m: 'sofa_02', p: [-8.2, 0, 8.4], ry: Math.PI },
  ...tyres(-11.35, 2.9, 4, 0.5), ...tyres(-11.3, -3.75, 5, 1.4),
  { m: 'Barrel_01', p: [-11.4, 0, -4.45], ry: 0.7 },
  { m: 'metal_jerrycan_green', p: [-7.9, 0, -4.7], ry: 1.1 },
  // hanging lamps (their shafts and light are made in garage/index.ts)
  ...[[-9.4, -3], [-9.4, 3], [9.4, -3], [9.4, 3], [-4.6, -6], [4.6, -6], [-4.6, 6], [4.6, 6]].map(([x, z]) => ({ m: 'hanging_industrial_lamp', p: [x, 5.45, z] as [number, number, number] })),
];

export const LAMPS: [number, number][] = PLACES.filter((p) => p.m === 'hanging_industrial_lamp').map((p) => [p.p[0], p.p[2]]);

/** Load every prop and add it to `group`, baked. Resolves when all are in (missing files are skipped). */
export async function loadProps(group: THREE.Group, bake: LightBake, env: THREE.Texture): Promise<number> {
  const names = [...new Set(PLACES.map((p) => p.m))];
  const loaded = new Map<string, THREE.Object3D>();
  await Promise.all(names.map((n) => loadGLTF(`/assets/garage/props/${n}.glb`).then((g) => { loaded.set(n, g.scene); }).catch(() => { /* a missing prop is not fatal */ })));
  const matCache = new Map<THREE.Material, THREE.Material>();
  const v = new THREE.Vector3(), nrm = new THREE.Vector3(), nm = new THREE.Matrix3();
  let count = 0;
  for (const pl of PLACES) {
    const src = loaded.get(pl.m);
    if (!src) continue;
    const root = new THREE.Group();
    root.position.set(...pl.p);
    root.rotation.set(pl.rx ?? 0, pl.ry ?? 0, 0, 'YXZ');
    root.scale.setScalar(pl.s ?? 1);
    src.updateMatrixWorld(true);
    src.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const g0 = mesh.geometry;
      const g = new THREE.BufferGeometry();
      for (const k of Object.keys(g0.attributes)) g.setAttribute(k, g0.attributes[k]);   // share the vertex buffers
      g.setIndex(g0.index);
      g.boundingSphere = g0.boundingSphere; g.boundingBox = g0.boundingBox;
      const clone = new THREE.Mesh(g, mesh.material);
      // model-space transform of this mesh inside the prop, then the placement
      clone.matrix.copy(mesh.matrixWorld);
      clone.matrix.decompose(clone.position, clone.quaternion, clone.scale);
      root.add(clone);
    });
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const g = mesh.geometry, pos = g.attributes.position, nor = g.attributes.normal;
      const col = new Float32Array(pos.count * 3), dir = new Float32Array(pos.count * 3);
      nm.getNormalMatrix(mesh.matrixWorld);
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        if (nor) nrm.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize(); else nrm.set(0, 1, 0);
        bake.sample(v.x, v.y, v.z, nrm.x, nrm.y, nrm.z, col, i * 3, dir, false);
      }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.setAttribute('ldir', new THREE.BufferAttribute(dir, 3));
      const srcMat = mesh.material as THREE.MeshStandardMaterial;
      let bm = matCache.get(srcMat);
      if (!bm) { bm = bakedPropMaterial(srcMat, env); matCache.set(srcMat, bm); }
      mesh.material = bm;
      mesh.matrixAutoUpdate = false;
    });
    root.matrixAutoUpdate = false;
    group.add(root);
    count++;
  }
  return count;
}
