// The city: visual meshes + collision meshes (nodes named "*-colonly", Godot's convention, kept
// so the same Blender export feeds both builds) + night lighting from the exported lamps, plus the
// instanced props (street lamps, hydrants, bins, shutters, sills, fire escapes...: instancing.ts).
// Both GLBs are meshopt-compressed with KTX2 (Basis) textures (assets_source/scripts/build_city_assets.sh).
// Static base geometry is already merged per material per 160 m tile by make_city.py (one draw call
// per material per tile, culled per tile by three's frustum test).
import * as THREE from 'three/webgpu';
import { texture, uv, floor, hash, vec3, float, mix, step, smoothstep, positionWorld, mx_noise_float } from 'three/tsl';
import { gltfLoader } from './loaders';
import type { PhysicsWorld } from '../physics/world';
import type { CarInfo } from '../physics/core';
import { CityInstances, type PropsJson } from './instancing';

export interface CityLight { pos: THREE.Vector3; color: THREE.Color; intensity: number; range: number }
export interface City {
  root: THREE.Object3D; lights: CityLight[]; lamps: number; neon: number; props: CityInstances;
  /** per frame: re-pick the visible prop instances / LODs (skipped while the camera is still) */
  update: (camera: THREE.Camera, force?: boolean) => void;
}

export async function loadCity(scene: THREE.Scene, pw: PhysicsWorld, surfaces: CarInfo['surfaces'], onProgress: (f: number) => void): Promise<City> {
  const L = gltfLoader();   // shared meshopt + KTX2 decoders (initLoaders ran after renderer.init)
  const prog = [0, 0];
  const report = () => onProgress(prog[0] * 0.75 + prog[1] * 0.25);
  const [gltf, lib, props] = await Promise.all([
    L.loadAsync('/assets/city/city.glb', (e) => { if (e.total) { prog[0] = e.loaded / e.total; report(); } }),
    L.loadAsync('/assets/city/city_props.glb', (e) => { if (e.total) { prog[1] = e.loaded / e.total; report(); } }),
    fetch('/data/city_props.json').then((r) => r.json() as Promise<PropsJson>),
  ]);
  const root = gltf.scene;
  root.updateMatrixWorld(true);

  const collision: THREE.Mesh[] = [];
  const lights: THREE.Light[] = [];
  root.traverse((o) => {
    if (o.name.endsWith('-colonly')) { collision.push(...meshesOf(o)); return; }
    if ((o as THREE.Light).isLight) lights.push(o as THREE.Light);
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = false;
      m.receiveShadow = true;
      m.material = Array.isArray(m.material) ? m.material.map((x) => tuneMaterial(x as THREE.MeshStandardMaterial))
        : tuneMaterial(m.material as THREE.MeshStandardMaterial);
    }
  });

  for (const m of collision) {
    const n = m.name + ' ' + (m.parent?.name ?? '');
    const surface = n.includes('wall') ? surfaces.wall : n.includes('pavement') ? surfaces.pavement : surfaces.asphalt;
    pw.addStaticMesh(m, surface);
  }
  for (const m of collision) m.removeFromParent();
  root.traverse((o) => { if (o.name.endsWith('-colonly')) o.visible = false; });

  // Instanced props. Sidewalk props with a collider (hydrants, bins, utility boxes) get static
  // boxes; lamp posts already have theirs in the "-colonly" meshes.
  const inst = new CityInstances(lib.scene, props);
  let boxes = 0;
  inst.forEachCollider((c, h, q) => { pw.addStaticBox(c, h, q, surfaces.wall); boxes++; });
  root.add(inst.root);
  console.info(`city: ${inst.assets.length} instanced assets, ${inst.assets.reduce((s, a) => s + a.meta.count, 0)} instances, ${boxes} prop colliders`);

  // Exported lamps are physical spot lights in Blender units: replaced by point lights (see
  // CityLighting). Street lamps: warm, short range; neon signs: tinted, very short. Both kept LOW:
  // a faint pool on the road and a little bounce, not floodlit facades (at 260/26 m they lit the
  // street like dusk and the headlights stopped mattering). Range cut with intensity, so fewer
  // lights overlap each cluster (cheaper on WebGPU).
  // The lamp heads and neon tubes themselves stay bright (emissive materials).
  const out: CityLight[] = [];
  let lamps = 0, neon = 0;
  for (const l of lights) {
    const p = new THREE.Vector3();
    l.getWorldPosition(p);
    const isLamp = l.name.startsWith('lamp_light');
    if (isLamp) { p.y -= 0.6; lamps++; } else neon++;
    out.push({ pos: p, color: l.color.clone(), intensity: isLamp ? 40 : 15, range: isLamp ? 18 : 8 });
    l.removeFromParent();
  }
  scene.add(root);
  return { root, lights: out, lamps, neon, props: inst, update: (camera, force) => inst.update(camera, force) };
}

function meshesOf(o: THREE.Object3D): THREE.Mesh[] {
  const r: THREE.Mesh[] = [];
  o.traverse((c) => { if ((c as THREE.Mesh).isMesh) r.push(c as THREE.Mesh); });
  return r;
}

export function materialsOf(m: THREE.Mesh): THREE.MeshStandardMaterial[] {
  return (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshStandardMaterial[];
}

/** Node-material copy of a glTF standard material (maps and factors), for TSL overrides. */
function toNode(src: THREE.MeshStandardMaterial) {
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = src.name;
  m.color.copy(src.color);
  m.map = src.map;
  m.normalMap = src.normalMap;
  m.normalScale.copy(src.normalScale);
  m.roughnessMap = src.roughnessMap;
  m.metalnessMap = src.metalnessMap;
  m.roughness = src.roughness;
  m.metalness = src.metalness;
  m.aoMap = src.aoMap;
  m.emissive.copy(src.emissive);
  m.emissiveMap = src.emissiveMap;
  m.emissiveIntensity = src.emissiveIntensity;
  m.side = src.side;
  return m;
}

// Lit windows: the facade/shop emissive map is a MASK (glass = white); which windows are lit and in
// what colour is decided per window bay in the shader: bay id = floor(uv) (facades are UV-mapped in
// whole bays, each building with its own offset), hashed. A third of the windows lit (warm
// tungsten, cool fluorescent or a dim bluish TV), the rest dark glass reflecting the street.
// Brightness matched by eye to the previous night look (emissive 3 on the old window textures).
function litWindows(mat: THREE.MeshStandardNodeMaterial, share: number, strength: number) {
  const cell = floor(uv());
  const seed = cell.x.add(1000).mul(157).add(cell.y.add(1000).mul(311)).add(7);
  const h = hash(seed), h2 = hash(seed.add(17)), h3 = hash(seed.add(41));
  const warm = vec3(1.0, 0.66, 0.36), cool = vec3(0.72, 0.85, 1.0), tv = vec3(0.35, 0.45, 0.9);
  const col = mix(mix(warm, cool, step(0.62, h2)), tv, step(0.9, h2));
  const lit = step(1 - share, h).mul(float(0.45).add(h3.mul(0.75)));
  mat.emissiveNode = texture(mat.emissiveMap!, uv()).rgb.mul(col).mul(lit).mul(strength);
}

function tuneMaterial(src: THREE.MeshStandardMaterial): THREE.Material {
  for (const t of [src.map, src.emissiveMap, src.normalMap, src.roughnessMap]) if (t) t.anisotropy = 4;
  const name = src.name;
  if (name === 'road_asphalt') {
    // Night street after rain: dark asphalt, glossy where wet. Large-scale (15-60 m) noise breaks
    // the 3 m tiling: patches of darker/lighter wear, and puddles (roughness -> 0.05 and a darker
    // albedo) where the noise peaks, so lamps and headlights leave long reflections in them.
    const m = toNode(src);
    const wp = positionWorld;
    const wear = mx_noise_float(vec3(wp.x.mul(0.017), 0, wp.z.mul(0.017))).mul(0.5).add(0.5);
    const pud = smoothstep(0.32, 0.5, mx_noise_float(vec3(wp.x.mul(0.06), 3.1, wp.z.mul(0.06))));
    const base = texture(src.map!, uv()).rgb.mul(mix(float(0.38), float(0.6), wear));
    m.colorNode = base.mul(mix(float(1), float(0.55), pud));
    m.roughnessNode = mix(texture(src.roughnessMap!, uv()).g.mul(0.62), float(0.05), pud);
    m.normalScale.setScalar(0.8);
    return m;
  }
  if (name === 'road_paint' || name === 'road_decal') {
    // alpha-tested (no blending, no sorting); pulled toward the camera so it never z-fights the road
    src.transparent = false;
    src.alphaTest = 0.5;
    src.depthWrite = true;
    src.polygonOffset = true;
    src.polygonOffsetFactor = -1;
    src.polygonOffsetUnits = -4;
    if (name === 'road_paint') src.color.setScalar(0.8);
    return src;
  }
  if (name.startsWith('facade_') || name === 'shopfront') {
    const m = toNode(src);
    if (name === 'shopfront') litWindows(m, 0.75, 2.2); else litWindows(m, 0.34, 2.6);
    return m;
  }
  return src;
}

/**
 * WebGPU: every city light is a real point light, shaded with clustered (Forward+) lighting.
 * WebGL 2 (no compute shaders): a fixed pool of point lights follows the lights nearest the camera.
 * The pool size never changes, so moving lights never triggers a shader recompile.
 */
export class CityLighting {
  private pool: THREE.PointLight[] = [];
  private timer = 0;
  readonly mode: string;

  constructor(scene: THREE.Scene, private lights: CityLight[], clustered: boolean, poolSize = 12) {
    if (clustered) {
      for (const l of lights) {
        const pl = new THREE.PointLight(l.color, l.intensity, l.range, 2);
        pl.position.copy(l.pos);
        scene.add(pl);
      }
      this.mode = `${lights.length} lights (clustered)`;
      return;
    }
    for (let i = 0; i < poolSize; i++) {
      const pl = new THREE.PointLight(0xffffff, 0, 1, 2);
      scene.add(pl);
      this.pool.push(pl);
    }
    this.mode = `${poolSize} nearest of ${lights.length} lights`;
  }

  update(dt: number, camera: THREE.Camera) {
    if (!this.pool.length || (this.timer -= dt) > 0) return;
    this.timer = 0.2;
    const c = camera.position;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const d = new THREE.Vector3();
    // Rank by distance, favouring lights in front of the camera (those behind matter less).
    const ranked = this.lights
      .map((l) => { d.subVectors(l.pos, c); const dist = d.length(); return { l, k: dist * (d.dot(fwd) < -l.range ? 3 : 1) }; })
      .sort((a, b) => a.k - b.k);
    this.pool.forEach((pl, i) => {
      const l = ranked[i]?.l;
      if (!l) { pl.intensity = 0; return; }
      pl.position.copy(l.pos);
      pl.color.copy(l.color);
      pl.intensity = l.intensity;
      pl.distance = l.range;
    });
  }
}
