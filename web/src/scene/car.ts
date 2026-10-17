// Car visuals: glTF model, wheels driven by the core's suspension output, headlights.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OUT } from '../physics/core';
import { materialsOf } from './city';

export interface CarVisualConfig {
  model: string;
  cg_in_model_m: [number, number, number];
  wheel_nodes: { fl: string; fr: string; rl: string; rr: string };
  collision_box: { size_m: [number, number, number]; centre_in_model_m: [number, number, number]; end_lift_m: number; end_lift_start_m: number };
  paint_material: string;
  default_paint: [number, number, number];
  headlights: [number, number, number][];
}

const Y = new THREE.Vector3(0, 1, 0), X = new THREE.Vector3(1, 0, 0);

export class CarVisual {
  readonly root = new THREE.Group();          // placed at the physics body (CG)
  private wheels: { node: THREE.Object3D; rest: THREE.Quaternion; caliper?: THREE.Object3D }[] = [];
  private qa = new THREE.Quaternion();
  private qb = new THREE.Quaternion();
  readonly cg: THREE.Vector3;
  headlights: THREE.SpotLight[] = [];

  private constructor(readonly cfg: CarVisualConfig, model: THREE.Object3D) {
    this.cg = new THREE.Vector3(...cfg.cg_in_model_m);
    model.position.copy(this.cg).negate();
    this.root.add(model);
    const n = cfg.wheel_nodes;
    for (const name of [n.fl, n.fr, n.rl, n.rr]) {
      const node = model.getObjectByName(name)!;
      const caliper = model.getObjectByName(name.replace('wheel', 'caliper'));
      this.wheels.push({ node, rest: node.quaternion.clone(), caliper });
    }
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.castShadow = true;
      m.receiveShadow = true;
      for (const mat of materialsOf(m)) {
        if (mat.name === cfg.paint_material) {
          const p = new THREE.MeshPhysicalMaterial({
            name: mat.name, color: new THREE.Color().setRGB(...cfg.default_paint, THREE.SRGBColorSpace),
            metalness: 0.35, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.04,
          });
          m.material = p;
        }
        if (mat.name === 'glass') { mat.transparent = true; mat.opacity = 0.35; mat.roughness = 0.02; }
        if (mat.name === 'light_beam') m.visible = false;   // fake beams: replaced by real spot lights
      }
    });
    // Headlights: two shadow-casting spots (the only dynamic shadows in the scene).
    for (const [i, hp] of cfg.headlights.entries()) {
      const s = new THREE.SpotLight(0xfff3e0, 900, 70, 0.42, 0.45, 2);
      s.position.set(hp[0], hp[1], hp[2]).sub(this.cg);
      s.target.position.copy(s.position).add(new THREE.Vector3(0, -1.1, 14));
      s.castShadow = i === 0;
      s.shadow.mapSize.set(1024, 1024);
      s.shadow.camera.near = 0.3;
      s.shadow.bias = -0.0004;
      this.root.add(s, s.target);
      this.headlights.push(s);
    }
  }

  static async load(cfg: CarVisualConfig): Promise<CarVisual> {
    const file = cfg.model.replace('res://assets/', '/assets/');
    const gltf = await new GLTFLoader().loadAsync(file);
    return new CarVisual(cfg, gltf.scene);
  }

  /** pos/quat: body (CG) transform; out: core output buffer. */
  update(pos: THREE.Vector3, quat: THREE.Quaternion, out: Float64Array) {
    this.root.position.copy(pos);
    this.root.quaternion.copy(quat);
    this.root.updateMatrixWorld();
    const inv = this.root.matrixWorld.clone().invert();
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i], o = OUT.wheel(i);
      const centre = new THREE.Vector3(out[o], out[o + 1], out[o + 2]).applyMatrix4(inv).add(this.cg);
      this.qa.setFromAxisAngle(Y, out[o + 3]);               // steer about the car's up axis
      this.qb.setFromAxisAngle(X, out[o + 4]);               // spin about the axle
      w.node.position.copy(centre);
      w.node.quaternion.copy(this.qa).multiply(this.qb).multiply(w.rest);
      if (w.caliper) { w.caliper.position.copy(centre); w.caliper.quaternion.copy(this.qa); }
    }
  }
}
