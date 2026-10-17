// The city: visual meshes + collision meshes (nodes named "*-colonly", Godot's convention, kept
// so the same Blender export feeds both builds) + night lighting from the exported lamps.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { PhysicsWorld } from '../physics/world';
import type { CarInfo } from '../physics/core';

export interface CityLight { pos: THREE.Vector3; color: THREE.Color; intensity: number; range: number }
export interface City { root: THREE.Object3D; lights: CityLight[]; lamps: number; neon: number }

export async function loadCity(scene: THREE.Scene, pw: PhysicsWorld, surfaces: CarInfo['surfaces'], onProgress: (f: number) => void): Promise<City> {
  const gltf = await new GLTFLoader().loadAsync('/assets/city/city.glb', (e) => e.total && onProgress(e.loaded / e.total));
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
      for (const mat of materialsOf(m)) tuneMaterial(mat);
    }
  });

  for (const m of collision) {
    const n = m.name + ' ' + (m.parent?.name ?? '');
    const surface = n.includes('wall') ? surfaces.wall : n.includes('pavement') ? surfaces.pavement : surfaces.asphalt;
    pw.addStaticMesh(m, surface);
  }
  for (const m of collision) m.removeFromParent();
  root.traverse((o) => { if (o.name.endsWith('-colonly')) o.visible = false; });

  // Exported lamps are physical spot lights in Blender units: replaced by point lights (see
  // CityLighting). Street lamps: warm, short range; neon signs: tinted, very short.
  const out: CityLight[] = [];
  let lamps = 0, neon = 0;
  for (const l of lights) {
    const p = new THREE.Vector3();
    l.getWorldPosition(p);
    const isLamp = l.name.startsWith('lamp_light');
    if (isLamp) { p.y -= 0.6; lamps++; } else neon++;
    out.push({ pos: p, color: l.color.clone(), intensity: isLamp ? 260 : 60, range: isLamp ? 26 : 12 });
    l.removeFromParent();
  }
  scene.add(root);
  return { root, lights: out, lamps, neon };
}

function meshesOf(o: THREE.Object3D): THREE.Mesh[] {
  const r: THREE.Mesh[] = [];
  o.traverse((c) => { if ((c as THREE.Mesh).isMesh) r.push(c as THREE.Mesh); });
  return r;
}

export function materialsOf(m: THREE.Mesh): THREE.MeshStandardMaterial[] {
  return (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshStandardMaterial[];
}

function tuneMaterial(mat: THREE.MeshStandardMaterial) {
  for (const t of [mat.map, mat.emissiveMap, mat.normalMap, mat.roughnessMap]) if (t) t.anisotropy = 4;
  switch (mat.name) {
    case 'road_asphalt':
      // Night street after rain: darker, glossier asphalt picks up lamp and neon reflections.
      mat.color.setScalar(0.45);
      mat.roughness = 0.35;
      break;
    case 'road_paint':
      mat.roughness = 0.5;
      break;
  }
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
