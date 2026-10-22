// Car visuals: glTF model, wheels driven by the core's suspension output, headlights.
// The model (generation 3, docs/car_model_v3.md) is meshopt + KTX2 compressed: loaded through the
// shared loaders.ts. Its materials come from the file (clear-coat paint with a metal-flake normal
// map, alpha glass, emissive lights); setupCarMaterials only adapts them for the game.
import * as THREE from 'three/webgpu';
import { OUT } from '../physics/core';
import { materialsOf } from './city';
import { assetUrl, loadGLTF } from './loaders';

import type { DamageVisualConfig } from './damage';
import { FINISHES, type Finish } from '../garage';

export interface CarVisualConfig extends DamageVisualConfig {
  model: string;
  lod_model: string;
  cg_in_model_m: [number, number, number];
  wheel_nodes: { fl: string; fr: string; rl: string; rr: string };
  /** Model track minus physics track, per side (m): the wheels sit this much further out. */
  wheel_visual_offset_m?: number;
  collision_box: { size_m: [number, number, number]; centre_in_model_m: [number, number, number]; end_lift_m: number; end_lift_start_m: number };
  paint_material: string;
  default_paint: [number, number, number];
  headlights: [number, number, number][];
}

/**
 * Orange peel: the faint waviness of a sprayed clear coat. A tileable 256x256 fractal value-noise
 * height field turned into a normal map, used as the clear coat's own normal (the base metal keeps
 * the model's flake normal map). Built once, shared by every car.
 */
let peelTex: THREE.DataTexture | null = null;
function orangePeel() {
  if (peelTex) return peelTex;
  const N = 256, h = new Float32Array(N * N);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let oct = 0, cells = 32, amp = 1; oct < 3; oct++, cells *= 2, amp *= 0.5) {
    const g = new Float32Array(cells * cells).map(rnd);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const fx = (x / N) * cells, fy = (y / N) * cells, x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0, sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const a = g[(y0 % cells) * cells + (x0 % cells)], b = g[(y0 % cells) * cells + ((x0 + 1) % cells)];
      const c = g[((y0 + 1) % cells) * cells + (x0 % cells)], d = g[((y0 + 1) % cells) * cells + ((x0 + 1) % cells)];
      h[y * N + x] += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
    }
  }
  const px = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = h[y * N + ((x + 1) % N)] - h[y * N + ((x + N - 1) % N)];
    const dy = h[((y + 1) % N) * N + x] - h[((y + N - 1) % N) * N + x];
    const nx = -dx * 6, ny = -dy * 6, l = Math.hypot(nx, ny, 1), i = (y * N + x) * 4;
    px[i] = (nx / l * 0.5 + 0.5) * 255; px[i + 1] = (ny / l * 0.5 + 0.5) * 255; px[i + 2] = (1 / l * 0.5 + 0.5) * 255; px[i + 3] = 255;
  }
  peelTex = new THREE.DataTexture(px, N, N, THREE.RGBAFormat);
  peelTex.wrapS = peelTex.wrapT = THREE.RepeatWrapping;
  peelTex.repeat.set(24, 24);
  peelTex.generateMipmaps = true;
  peelTex.minFilter = THREE.LinearMipmapLinearFilter;
  peelTex.magFilter = THREE.LinearFilter;
  peelTex.anisotropy = 4;
  peelTex.needsUpdate = true;
  return peelTex;
}

const Y = new THREE.Vector3(0, 1, 0), X = new THREE.Vector3(1, 0, 0), ONE = new THREE.Vector3(1, 1, 1);

/**
 * Game-side material tweaks shared by the player, AI and remote cars:
 *  - paint: keep the file's MeshPhysicalMaterial (clear coat + flake normal map) and set the colour;
 *    older models without clear coat get a fresh physical material;
 *  - glass: alpha-blended (transmission would cost a second scene pass on the iGPU), no depth
 *    write so the interior behind it never vanishes through sorting;
 *  - shadows on, fake light-beam meshes (old model) hidden.
 * Returns the paint material (callers recolour it).
 */
export function setupCarMaterials(model: THREE.Object3D, cfg: CarVisualConfig, paint: THREE.ColorRepresentation | null, shadows = true) {
  let paintMat: THREE.MeshPhysicalMaterial | null = null;
  const color = paint === null ? new THREE.Color().setRGB(...cfg.default_paint, THREE.SRGBColorSpace) : new THREE.Color(paint);
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.castShadow = true;
    m.receiveShadow = shadows;
    const mats = materialsOf(m);
    mats.forEach((mat, i) => {
      if (mat.name === cfg.paint_material) {
        if (!paintMat) {
          const src = mat as unknown as THREE.MeshPhysicalMaterial;
          paintMat = src.isMeshPhysicalMaterial ? src.clone() : new THREE.MeshPhysicalMaterial({ name: mat.name, metalness: 0.35, roughness: 0.32 });
          paintMat.clearcoat = 1;
          paintMat.clearcoatRoughness = 0.04;
          paintMat.clearcoatNormalMap = orangePeel();
          paintMat.clearcoatNormalScale.set(0.12, 0.12);
          paintMat.iridescenceIOR = 1.7;
          paintMat.iridescenceThicknessRange = [200, 520];
          paintMat.color.copy(color);
        }
        if (Array.isArray(m.material)) m.material[i] = paintMat; else m.material = paintMat;
      }
      if (mat.name === 'glass') { mat.transparent = true; mat.opacity = Math.min(mat.opacity, 0.35); mat.roughness = 0.02; mat.depthWrite = false; }
      if (mat.name === 'light_beam') m.visible = false;   // fake beams: replaced by real spot lights
    });
  });
  return paintMat as THREE.MeshPhysicalMaterial | null;
}

export class CarVisual {
  readonly root = new THREE.Group();          // placed at the physics body (CG)
  private wheels: { node: THREE.Object3D; rest: THREE.Quaternion; caliper?: THREE.Object3D }[] = [];
  private qa = new THREE.Quaternion();
  private qb = new THREE.Quaternion();
  private physInv = new THREE.Matrix4();
  readonly cg: THREE.Vector3;
  headlights: THREE.SpotLight[] = [];
  readonly headlightIntensity = 900;
  /** Headlight switch (L). Off = intensity 0, never visible = false (that recompiles every material). */
  lightsOn = true;
  lightsBroken = false;
  readonly velocity = new THREE.Vector3();   // m/s, world (for debris)
  /** The car's own clone of the paint material (garage colour + finish). */
  readonly paint: THREE.MeshPhysicalMaterial | null;

  private constructor(readonly cfg: CarVisualConfig, readonly model: THREE.Object3D, shared?: THREE.SpotLight[]) {
    this.cg = new THREE.Vector3(...cfg.cg_in_model_m);
    model.position.copy(this.cg).negate();
    this.root.add(model);
    const n = cfg.wheel_nodes;
    for (const name of [n.fl, n.fr, n.rl, n.rr]) {
      const node = model.getObjectByName(name)!;
      const caliper = model.getObjectByName(name.replace('wheel', 'caliper'));
      this.wheels.push({ node, rest: node.quaternion.clone(), caliper });
    }
    this.paint = setupCarMaterials(model, cfg, null);
    // The player's own car never needs to be in its headlight shadow map (the spots sit at its nose and shine away
    // from it; screenshot-identical): skipping its 124k triangles + dent shader saves the biggest part of every
    // shadow-update frame. Other cars (AI, remote) still cast.
    model.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = false; });
    // Headlights: two shadow-casting spots (the only dynamic shadows in the scene). A garage car swap passes the
    // previous car's spots in: removing a shadow-casting light destroys its shadow map mid-frame (WebGPU validation
    // error) and changes the light count (shader recompile), so the same two lights move to the new body.
    for (const [i, hp] of cfg.headlights.entries()) {
      const s = shared?.[i] ?? new THREE.SpotLight(0xfff3e0, this.headlightIntensity, 70, 0.42, 0.45, 2);
      s.position.set(hp[0], hp[1], hp[2]).sub(this.cg);
      s.target.position.copy(s.position).add(new THREE.Vector3(0, -1.1, 14));
      if (!shared) {
        s.castShadow = i === 0;
        s.shadow.mapSize.set(1024, 1024);
        s.shadow.camera.near = 0.3;
        s.shadow.bias = -0.0004;
      }
      this.root.add(s, s.target);
      this.headlights.push(s);
    }
  }

  setPaint(hex: string, finish: Finish) {
    const m = this.paint;
    if (!m) return;
    const f = FINISHES[finish];
    m.color.set(hex);
    m.clearcoat = f.clearcoat; m.roughness = f.roughness; m.metalness = f.metalness;
    m.iridescence = f.iridescence ?? 0;
    m.needsUpdate = true;
  }

  /** Spot intensity from the switch and the damage state. */
  applyHeadlights() {
    for (const s of this.headlights) s.intensity = this.lightsOn && !this.lightsBroken ? this.headlightIntensity : 0;
  }

  static async load(cfg: CarVisualConfig, sharedHeadlights?: THREE.SpotLight[]): Promise<CarVisual> {
    const gltf = await loadGLTF(assetUrl(cfg.model));
    return new CarVisual(cfg, gltf.scene, sharedHeadlights);
  }

  /**
   * pos/quat: where to DRAW the body (interpolated between physics ticks); physPos/physQuat: the
   * body pose the core's wheel centres refer to (the state the last tick STARTED from, i.e. one
   * step before the body's current pose: using the newer pose shifted the wheels back by v*dt, 15 cm at 130 km/h). Wheels are converted to
   * car-local with the physics pose, then follow the drawn body: no drift between car and wheels.
   */
  update(pos: THREE.Vector3, quat: THREE.Quaternion, out: Float64Array, physPos = pos, physQuat = quat) {
    this.root.position.copy(pos);
    this.root.quaternion.copy(quat);
    this.root.updateMatrixWorld();
    const inv = this.physInv.compose(physPos, physQuat, ONE).invert();
    const off = this.cfg.wheel_visual_offset_m ?? 0;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i], o = OUT.wheel(i);
      const centre = new THREE.Vector3(out[o], out[o + 1], out[o + 2]).applyMatrix4(inv).add(this.cg);
      centre.x += Math.sign(centre.x) * off;                 // model track is a little wider than physics
      this.qa.setFromAxisAngle(Y, out[o + 3]);               // steer about the car's up axis
      this.qb.setFromAxisAngle(X, out[o + 4]);               // spin about the axle
      w.node.position.copy(centre);
      w.node.quaternion.copy(this.qa).multiply(this.qb).multiply(w.rest);
      if (w.caliper) { w.caliper.position.copy(centre); w.caliper.quaternion.copy(this.qa); }
    }
  }
}
