// Visual side of crash damage (port of game/scripts/damage_visuals.gd). The CORE decides how far
// each zone is crushed (energy -> crush depth, core/src/damage.cpp); this module SHOWS it:
//   - dents at the actual impact point, in the vertex shader (dents.ts: accumulated, zero CPU),
//   - parts breaking off as physics debris (bumpers, mirrors), broken lights (headlights flicker
//     for 2 s after a heavy front hit, then die), engine smoke, sparks,
//   - engine fire: the core's smoulder -> fire state (smoke, then growing flames + a flickering
//     orange point light from the engine bay). No explosion; R repairs.
// The physical consequences (bent steering, weaker springs, lost power, drag, brake fade) are in the core.
import * as THREE from 'three/webgpu';
import RAPIER from '@dimforge/rapier3d-compat';
import { instancedDynamicBufferAttribute, uv, vec4, smoothstep, float } from 'three/tsl';
import type { Damage } from '../physics/core';
import { GROUP_DEBRIS, type PhysicsWorld } from '../physics/world';
import type { CarVisual } from './car';
import { materialsOf } from './city';
import { Dents } from './dents';

const ZONES = ['front', 'rear', 'left', 'right'] as const;
// Crush direction per zone in model space (X left, Y up, Z forward): the dent goes INTO the car.
const INWARD = [new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, 1), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0)];
const SKIP = ['wheel_', 'caliper_', 'interior_shell', 'seat', 'dashboard', 'steering', 'wheel_well'];
// Break-off thresholds in metres of zone crush (same as the Godot build).
const BREAK_CRUSH: Record<string, number> = { bumper_front: 0.3, bumper_rear: 0.3, mirror_L: 0.12, mirror_R: 0.12 };
const LIGHTS_CRUSH = 0.12;
// A front hit this big (kJ; ~15 kJ = a 16 km/h stop for this car) breaks the headlights too,
// even below LIGHTS_CRUSH. Either way they flicker (loose connector) for FLICKER_S, then die.
const HEADLIGHT_KJ = 15;
const FLICKER_S = 2;

export interface DamageVisualConfig {
  detachable: Record<string, [string, number]>;
  front_lights: string[];
  rear_lights: string[];
  engine_smoke_in_model_m: [number, number, number];
}

/** Instanced camera-facing sprites, simulated on the CPU (tens of particles: cheap), one draw call. */
export class Particles {
  private pos: THREE.InstancedBufferAttribute;
  private col: THREE.InstancedBufferAttribute;
  private size: THREE.InstancedBufferAttribute;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  readonly sprite: THREE.Sprite;
  private next = 0;
  color = new THREE.Color(1, 1, 1);

  constructor(private max: number, private opts: { additive: boolean; gravity: number; grow: number; drag: number }) {
    this.pos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.col = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    this.size = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max).fill(1);
    const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
    m.blending = opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    m.positionNode = instancedDynamicBufferAttribute(this.pos);
    m.scaleNode = instancedDynamicBufferAttribute(this.size);
    const c = instancedDynamicBufferAttribute(this.col, 'vec4') as unknown as THREE.Node<'vec4'>;
    const soft = smoothstep(float(0.5), float(0.0), uv().sub(0.5).length());   // round, soft edge
    m.colorNode = vec4(c.xyz, c.w.mul(soft));
    this.sprite = new THREE.Sprite(m);
    this.sprite.count = max;
    this.sprite.frustumCulled = false;
  }

  emit(p: THREE.Vector3, v: THREE.Vector3, life: number, size: number) {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.pos.setXYZ(i, p.x, p.y, p.z);
    this.vel.set([v.x, v.y, v.z], i * 3);
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size.setX(i, size);
  }

  update(dt: number) {
    const { gravity, grow, drag } = this.opts;
    const k = Math.exp(-drag * dt);
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) { this.col.setW(i, 0); continue; }
      this.life[i] -= dt;
      const t = 1 - Math.max(0, this.life[i]) / this.maxLife[i];   // 0 -> 1 over the life
      const o = i * 3;
      this.vel[o] *= k; this.vel[o + 2] *= k;
      this.vel[o + 1] = this.vel[o + 1] * k + gravity * dt;
      this.pos.setXYZ(i, this.pos.getX(i) + this.vel[o] * dt, this.pos.getY(i) + this.vel[o + 1] * dt, this.pos.getZ(i) + this.vel[o + 2] * dt);
      this.size.setX(i, this.size.getX(i) * (1 + grow * dt));
      this.col.setXYZW(i, this.color.r, this.color.g, this.color.b, (1 - t) * (this.opts.additive ? 1 : 0.6));
    }
    this.pos.needsUpdate = this.col.needsUpdate = this.size.needsUpdate = true;
  }

  clear() { this.life.fill(0); }
}

interface Debris { node: THREE.Object3D; parent: THREE.Object3D; local: THREE.Matrix4; body: RAPIER.RigidBody; age: number }

export class DamageVisuals {
  private deformables: THREE.Mesh[] = [];
  readonly dents = new Dents();
  private applied = [0, 0, 0, 0];
  private detached = new Map<string, Debris>();
  private lightsOff = { front: false, rear: false };
  private lightMats = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private lastImpacts = 0;
  private t = 0;
  private smoke = new Particles(64, { additive: false, gravity: 0.6, grow: 0.9, drag: 0.6 });
  private sparks = new Particles(80, { additive: true, gravity: -9.8, grow: -0.8, drag: 0.4 });
  // fire: orange outer flames + a hotter yellow core, both additive HDR (bloom does the glow)
  private flames = new Particles(72, { additive: true, gravity: 3, grow: -0.9, drag: 1.6 });
  private flameCore = new Particles(32, { additive: true, gravity: 2, grow: -1.4, drag: 2 });
  // Created up front at intensity 0: adding a light mid-race recompiles every lit material.
  private fireLight = new THREE.PointLight(0xff6a1c, 0, 10, 2);
  private fireAcc = 0;
  private flicker = 0;        // s of headlight flicker left (> 0 = flickering)
  private flickerHold = 0;    // s until the next flicker level
  private smokeAcc = 0;
  private dmg: Damage | null = null;
  get last(): Damage | null { return this.dmg; }
  onImpact: (kj: number, glass: boolean) => void = () => {};

  constructor(private car: CarVisual, private cfg: DamageVisualConfig, private pw: PhysicsWorld, private scene: THREE.Scene) {
    car.model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !SKIP.some((p) => o.name.startsWith(p))) this.deformables.push(m);
    });
    // Shader dents on every body material (set before the first compile: no mid-race pipeline).
    // A skipped mesh sharing one of these materials has no dent matrices -> dentOn = 0.
    for (const m of this.deformables) {
      this.dents.register(m, car.model);
      for (const mat of materialsOf(m)) (mat as unknown as { positionNode: THREE.Node }).positionNode = this.dents.positionNode;
    }
    this.sparks.color.setRGB(4, 2.2, 0.7);   // HDR: blooms
    this.flames.color.setRGB(5, 1.5, 0.25);
    this.flameCore.color.setRGB(6, 3.6, 1.1);
    this.fireLight.position.set(...cfg.engine_smoke_in_model_m).sub(car.cg);
    car.root.add(this.fireLight);
    scene.add(this.smoke.sprite, this.sparks.sprite, this.flames.sprite, this.flameCore.sprite);
  }

  /** Every frame. Damage is read from the core at 20 Hz; dents are applied one panel per frame. */
  update(dt: number, damage: () => Damage) {
    this.smoke.update(dt);
    this.sparks.update(dt);
    this.flames.update(dt);
    this.flameCore.update(dt);
    this.updateDebris(dt);
    this.updateFlicker(dt);
    if (this.dmg && (this.dmg.engine > 0.25 || this.dmg.totaled || this.dmg.smoulder > 0)) this.emitSmoke(dt);
    this.updateFire(dt);
    this.t += dt;
    if (this.t < 0.05) return;
    this.t = 0;
    const d = (this.dmg = damage());

    // ---- deformation: show the crush the core added since last time, at the impact point
    const z = d.lastZone;
    const delta = d.crush[z] - this.applied[z];
    if (delta > 0.01) {
      this.applied[z] = d.crush[z];
      const p = new THREE.Vector3(...d.lastPoint).add(this.car.cg);   // car local (CG) -> model space
      // dent radius grows with the zone's total crush (same rule as the old CPU path)
      this.dents.add(p, INWARD[z], delta, THREE.MathUtils.clamp(0.45 + 0.9 * d.crush[z], 0.45, 1.2));
    }
    // ---- break-offs
    for (const [name, [zone]] of Object.entries(this.cfg.detachable)) {
      const zi = ZONES.indexOf(zone as (typeof ZONES)[number]);
      if (zi >= 0 && d.crush[zi] > (BREAK_CRUSH[name] ?? 0.3)) this.detach(name);
    }
    // ---- lights
    let glass = false;
    const heavyFront = d.impacts > this.lastImpacts && d.lastZone === 0 && d.lastKj >= HEADLIGHT_KJ;
    if ((d.crush[0] > LIGHTS_CRUSH || heavyFront) && !this.lightsOff.front) {
      // headlights: loose connector -> flicker for FLICKER_S, then dead (updateFlicker)
      this.lightsOff.front = glass = true;
      this.flicker = FLICKER_S;
      this.flickerHold = 0;
    }
    if (d.crush[1] > LIGHTS_CRUSH && !this.lightsOff.rear) {
      this.lightsOff.rear = glass = true;
      this.killLights(this.cfg.rear_lights);
    }
    // ---- sparks + sound on a new hit
    if (d.impacts > this.lastImpacts) {
      this.lastImpacts = d.impacts;
      this.onImpact(d.lastKj, glass);
      if (d.lastKj > 2) {
        const p = new THREE.Vector3(...d.lastPoint).applyMatrix4(this.car.root.matrixWorld);
        const n = Math.min(60, 12 + d.lastKj * 2);
        for (let i = 0; i < n; i++) {
          const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9 + 0.2, Math.random() - 0.5).normalize().multiplyScalar(3 + Math.random() * 6);
          this.sparks.emit(p, v, 0.3 + Math.random() * 0.4, 0.035 + Math.random() * 0.03);
        }
      }
    }
  }

  private emitSmoke(dt: number) {
    const d = this.dmg!;
    // particles/s: engine damage, more while it smoulders, thick and black once burning
    const burning = d.fire > 0 || d.totaled;
    const rate = burning ? 24 : Math.max(6 + 14 * THREE.MathUtils.clamp((d.engine - 0.25) / 0.6, 0, 1), 8 + 16 * d.smoulder);
    this.smokeAcc += dt * rate;
    const grey = burning ? 0.03 : Math.min(0.55 - 0.43 * d.engine, 0.5 - 0.4 * d.smoulder);   // grey -> black
    this.smoke.color.setRGB(grey, grey, grey);
    const origin = new THREE.Vector3(...this.cfg.engine_smoke_in_model_m).sub(this.car.cg).applyMatrix4(this.car.root.matrixWorld);
    while (this.smokeAcc >= 1) {
      this.smokeAcc -= 1;
      const v = new THREE.Vector3((Math.random() - 0.5) * 0.6, 0.6 + Math.random() * 0.8, (Math.random() - 0.5) * 0.6);
      this.smoke.emit(origin.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.4, 0, (Math.random() - 0.5) * 0.4)), v, 2.5, 0.5 + Math.random() * 0.4);
    }
  }

  /**
   * Engine fire from the core's fire state (0..1, grows over ~45 s): flames from the engine bay,
   * rate and size growing with it, plus an orange point light flickering on two incommensurate
   * sines and noise (fire light never holds still).
   */
  private updateFire(dt: number) {
    const f = this.dmg?.fire ?? 0;
    if (f <= 0) { this.fireLight.intensity = 0; return; }
    const g = 0.25 + 0.75 * f;                                   // visual size: small flames at ignition
    const time = performance.now() / 1000;
    const flick = 0.7 + 0.18 * Math.sin(time * 23) + 0.12 * Math.sin(time * 37.7) + 0.15 * (Math.random() - 0.5);
    this.fireLight.intensity = 60 * g * flick;
    this.fireLight.distance = 6 + 6 * g;
    const origin = new THREE.Vector3(...this.cfg.engine_smoke_in_model_m).sub(this.car.cg).applyMatrix4(this.car.root.matrixWorld);
    this.fireAcc += dt * (12 + 48 * f);
    const v = new THREE.Vector3(), p = new THREE.Vector3();
    while (this.fireAcc >= 1) {
      this.fireAcc -= 1;
      p.set((Math.random() - 0.5) * 0.7 * g, 0.05, (Math.random() - 0.5) * 0.5 * g).add(origin);
      v.set((Math.random() - 0.5) * 0.5, 1 + Math.random() * 1.2 * g, (Math.random() - 0.5) * 0.5);
      this.flames.emit(p, v, 0.35 + Math.random() * 0.35 * g, (0.22 + Math.random() * 0.2) * g);
      if (Math.random() < 0.5) this.flameCore.emit(p, v.multiplyScalar(0.7), 0.25 + Math.random() * 0.15, (0.14 + Math.random() * 0.1) * g);
    }
  }

  /** Headlights after a heavy front hit: random on/dim/off levels held 30-150 ms, then dead. */
  private updateFlicker(dt: number) {
    if (this.flicker <= 0) return;
    this.flicker -= dt;
    // intensity changes only, NOT visible = false: changing the scene's light set recompiles every
    // lit material (a ~300 ms freeze on impact)
    if (this.flicker <= 0) {
      for (const s of this.car.headlights) s.intensity = 0;
      this.killLights(this.cfg.front_lights);
      return;
    }
    if ((this.flickerHold -= dt) > 0) return;
    this.flickerHold = 0.03 + Math.random() * 0.12;
    const alive = this.flicker / FLICKER_S;                      // fewer "on" moments toward the end
    for (const s of this.car.headlights) {
      const on = Math.random() < 0.25 + 0.4 * alive;
      s.intensity = on ? this.car.headlightIntensity * (0.25 + 0.75 * Math.random()) : 0;
    }
  }

  /** A part breaks off: it becomes a 6 kg Rapier body carrying the car's velocity, gone after 30 s. */
  private detach(name: string) {
    if (this.detached.has(name)) return;
    const node = this.car.model.getObjectByName(name);
    if (!node || !node.parent) return;
    const parent = node.parent;
    const local = node.matrix.clone();
    node.updateWorldMatrix(true, true);
    const world = node.matrixWorld.clone();
    const box = new THREE.Box3().setFromObject(node, true);
    const size = box.getSize(new THREE.Vector3()).max(new THREE.Vector3(0.05, 0.05, 0.05));
    const centre = box.getCenter(new THREE.Vector3());
    const wp = new THREE.Vector3(), wq = new THREE.Quaternion(), ws = new THREE.Vector3();
    world.decompose(wp, wq, ws);
    const body = this.pw.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(wp.x, wp.y, wp.z).setRotation(wq));
    // The box is world-aligned at detach time: a good-enough hull for a tumbling bumper.
    const off = centre.clone().sub(wp).applyQuaternion(wq.clone().invert());
    this.pw.world.createCollider(RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2).setTranslation(off.x, off.y, off.z).setMass(6).setFriction(0.6).setCollisionGroups(GROUP_DEBRIS), body);
    const v = this.car.velocity;
    body.setLinvel({ x: v.x * 0.8 + (Math.random() - 0.5) * 2, y: v.y * 0.8 + 1.5, z: v.z * 0.8 + (Math.random() - 0.5) * 2 }, true);
    body.setAngvel({ x: (Math.random() - 0.5) * 8, y: (Math.random() - 0.5) * 8, z: (Math.random() - 0.5) * 8 }, true);
    this.scene.attach(node);   // keeps its world transform
    node.matrixAutoUpdate = false;
    this.detached.set(name, { node, parent, local, body, age: 0 });
  }

  private updateDebris(dt: number) {
    for (const d of this.detached.values()) {
      if (!d.body.isValid()) continue;
      d.age += dt;
      const t = d.body.translation(), r = d.body.rotation();
      d.node.matrix.compose(new THREE.Vector3(t.x, t.y, t.z), new THREE.Quaternion(r.x, r.y, r.z, r.w), new THREE.Vector3(1, 1, 1));
      d.node.matrixWorldNeedsUpdate = true;
      if (d.age > 30) { this.pw.world.removeRigidBody(d.body); d.node.visible = false; }
    }
  }

  /**
   * Broken lights: a CLONE of the light's own material with the glow switched off. Same material
   * type and features -> the GPU pipeline is reused (a brand-new material type here compiled a
   * pipeline mid-crash: a 383 ms freeze on impact).
   */
  private killLights(names: string[]) {
    for (const nm of names) {
      this.car.model.getObjectByName(nm)?.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        this.lightMats.set(m, m.material);
        const src = Array.isArray(m.material) ? m.material[0] : m.material;
        const dark = src.clone() as THREE.MeshStandardMaterial;
        // clone() drops custom node properties: keep the dents (same node -> same pipeline)
        (dark as unknown as { positionNode: unknown }).positionNode = (src as unknown as { positionNode: unknown }).positionNode;
        dark.color?.setScalar(0.05);
        dark.emissive?.setScalar(0);
        m.material = dark;
      });
    }
  }

  /** Full repair (reset): geometry, parts, lights, effects. */
  repair() {
    this.dents.clear();
    for (const d of this.detached.values()) {
      if (d.body.isValid()) this.pw.world.removeRigidBody(d.body);
      d.parent.add(d.node);
      d.node.matrix.copy(d.local);
      d.node.matrix.decompose(d.node.position, d.node.quaternion, d.node.scale);
      d.node.matrixAutoUpdate = true;
      d.node.visible = true;
    }
    this.detached.clear();
    for (const [m, mat] of this.lightMats) m.material = mat;
    this.lightMats.clear();
    for (const s of this.car.headlights) s.intensity = this.car.headlightIntensity;
    this.lightsOff = { front: false, rear: false };
    this.applied = [0, 0, 0, 0];
    this.lastImpacts = 0;
    this.dmg = null;
    this.smoke.clear();
    this.sparks.clear();
    this.flames.clear();
    this.flameCore.clear();
    this.flicker = 0;
    this.fireLight.intensity = 0;
  }
}
