// Visual side of crash damage (port of game/scripts/damage_visuals.gd). The CORE decides how far
// each zone is crushed (energy -> crush depth, core/src/damage.cpp); this module SHOWS it:
//   - mesh deformation at the actual impact point (vertices pushed in along the crash direction by
//     the increase in crush depth, smooth falloff + crumple wrinkles, normals recomputed),
//   - parts breaking off as physics debris (bumpers, mirrors), broken lights, engine smoke, sparks.
// The physical consequences (bent steering, weaker springs, lost power, drag) are in the core.
import * as THREE from 'three/webgpu';
import RAPIER from '@dimforge/rapier3d-compat';
import { instancedDynamicBufferAttribute, uv, vec4, smoothstep, float } from 'three/tsl';
import type { Damage } from '../physics/core';
import { GROUP_DEBRIS, type PhysicsWorld } from '../physics/world';
import type { CarVisual } from './car';

const ZONES = ['front', 'rear', 'left', 'right'] as const;
// Crush direction per zone in model space (X left, Y up, Z forward): the dent goes INTO the car.
const INWARD = [new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, 1), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0)];
const SKIP = ['wheel_', 'caliper_', 'interior_shell', 'seat', 'dashboard', 'steering', 'wheel_well'];
// Break-off thresholds in metres of zone crush (same as the Godot build).
const BREAK_CRUSH: Record<string, number> = { bumper_front: 0.3, bumper_rear: 0.3, mirror_L: 0.12, mirror_R: 0.12 };
const LIGHTS_CRUSH = 0.12;

export interface DamageVisualConfig {
  detachable: Record<string, [string, number]>;
  front_lights: string[];
  rear_lights: string[];
  engine_smoke_in_model_m: [number, number, number];
}

/** Instanced camera-facing sprites, simulated on the CPU (tens of particles: cheap), one draw call. */
class Particles {
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
  private original = new Map<THREE.Mesh, { pos: Float32Array; nrm: Float32Array | null }>();
  private applied = [0, 0, 0, 0];
  private detached = new Map<string, Debris>();
  private lightsOff = { front: false, rear: false };
  private lightMats = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private dentQueue: [THREE.Mesh, THREE.Vector3, THREE.Vector3, number, number][] = [];
  private lastImpacts = 0;
  private t = 0;
  private smoke = new Particles(48, { additive: false, gravity: 0.6, grow: 0.9, drag: 0.6 });
  private sparks = new Particles(80, { additive: true, gravity: -9.8, grow: -0.8, drag: 0.4 });
  private smokeAcc = 0;
  private dmg: Damage | null = null;
  get last(): Damage | null { return this.dmg; }
  onImpact: (kj: number, glass: boolean) => void = () => {};

  constructor(private car: CarVisual, private cfg: DamageVisualConfig, private pw: PhysicsWorld, private scene: THREE.Scene) {
    car.model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !SKIP.some((p) => o.name.startsWith(p))) this.deformables.push(m);
    });
    this.sparks.color.setRGB(4, 2.2, 0.7);   // HDR: blooms
    scene.add(this.smoke.sprite, this.sparks.sprite);
  }

  /** Every frame. Damage is read from the core at 20 Hz; dents are applied one panel per frame. */
  update(dt: number, damage: () => Damage) {
    const job = this.dentQueue.shift();
    if (job) this.dentMesh(...job);
    this.smoke.update(dt);
    this.sparks.update(dt);
    this.updateDebris(dt);
    if (this.dmg && (this.dmg.engine > 0.25 || this.dmg.totaled)) this.emitSmoke(dt);
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
      this.dent(p, INWARD[z], delta, d.crush[z]);
    }
    // ---- break-offs
    for (const [name, [zone]] of Object.entries(this.cfg.detachable)) {
      const zi = ZONES.indexOf(zone as (typeof ZONES)[number]);
      if (zi >= 0 && d.crush[zi] > (BREAK_CRUSH[name] ?? 0.3)) this.detach(name);
    }
    // ---- lights
    let glass = false;
    if (d.crush[0] > LIGHTS_CRUSH && !this.lightsOff.front) {
      this.lightsOff.front = glass = true;
      this.killLights(this.cfg.front_lights);
      // intensity 0, NOT visible = false: changing the scene's light set recompiles every lit
      // material (a ~300 ms freeze on impact)
      for (const s of this.car.headlights) s.intensity = 0;
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
    const rate = d.totaled ? 22 : 6 + 14 * Math.min(1, (d.engine - 0.25) / 0.6);   // particles/s
    this.smokeAcc += dt * rate;
    const grey = d.totaled ? 0.03 : 0.55 - 0.43 * d.engine;   // grey -> black as the engine dies
    this.smoke.color.setRGB(grey, grey, grey);
    const origin = new THREE.Vector3(...this.cfg.engine_smoke_in_model_m).sub(this.car.cg).applyMatrix4(this.car.root.matrixWorld);
    while (this.smokeAcc >= 1) {
      this.smokeAcc -= 1;
      const v = new THREE.Vector3((Math.random() - 0.5) * 0.6, 0.6 + Math.random() * 0.8, (Math.random() - 0.5) * 0.6);
      this.smoke.emit(origin.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.4, 0, (Math.random() - 0.5) * 0.4)), v, 2.5, 0.5 + Math.random() * 0.4);
    }
  }

  /**
   * Push vertices near p (model space) along dir by depth metres. Falloff w = (1 - (r/R)^2)^2
   * (smooth, zero slope at the edge); the dent radius grows with total crush. A deterministic
   * per-vertex jitter perpendicular to the push adds crumple wrinkles. Work is queued per panel.
   */
  private dent(p: THREE.Vector3, dir: THREE.Vector3, depth: number, total: number) {
    const R = THREE.MathUtils.clamp(0.45 + 0.9 * total, 0.45, 1.2);
    const invModel = this.car.model.matrixWorld.clone().invert();
    for (const m of this.deformables) {
      if (!m.parent || this.detached.has(m.name)) continue;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      const box = m.geometry.boundingBox!.clone().applyMatrix4(invModel.clone().multiply(m.matrixWorld)).expandByScalar(R);
      if (box.containsPoint(p)) this.dentQueue.push([m, p, dir, depth, R]);
    }
  }

  private dentMesh(m: THREE.Mesh, p: THREE.Vector3, dir: THREE.Vector3, depth: number, R: number) {
    if (!m.parent || this.detached.has(m.name)) return;
    if (!this.original.has(m)) {   // per-car copy before editing (models are shared between cars)
      m.geometry = m.geometry.clone();
      const n = m.geometry.getAttribute('normal') as THREE.BufferAttribute | undefined;
      this.original.set(m, { pos: (m.geometry.getAttribute('position').array as Float32Array).slice(), nrm: n ? (n.array as Float32Array).slice() : null });
    }
    const g = m.geometry;
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const xf = new THREE.Matrix4().copy(this.car.model.matrixWorld).invert().multiply(m.matrixWorld);   // mesh -> model
    const xinv = xf.clone().invert();
    const side = dir.clone().cross(new THREE.Vector3(0, 1, 0)).normalize();
    const vm = new THREE.Vector3(), disp = new THREE.Vector3();
    const moved: number[] = [];
    for (let i = 0; i < pos.count; i++) {
      vm.fromBufferAttribute(pos, i).applyMatrix4(xf);
      const r = vm.distanceTo(p);
      if (r >= R) continue;
      let w = 1 - (r / R) * (r / R);
      w *= w;
      const h = Math.sin(vm.x * 41 + vm.y * 17) * Math.cos(vm.z * 29);   // wrinkle noise
      disp.copy(dir).multiplyScalar(depth * w)
        .addScaledVector(side, h * depth * 0.25 * w)
        .addScaledVector(new THREE.Vector3(0, 1, 0), h * 0.5 * depth * 0.25 * w);
      vm.add(disp).applyMatrix4(xinv);
      pos.setXYZ(i, vm.x, vm.y, vm.z);
      moved.push(i);
    }
    if (!moved.length) return;
    pos.needsUpdate = true;
    this.renormal(g, moved);
    g.computeBoundingSphere();
  }

  /** Recompute normals only for moved vertices: sum of the face normals around them (CCW faces). */
  private renormal(g: THREE.BufferGeometry, moved: number[]) {
    const n = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
    if (!n) return;
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const isMoved = new Uint8Array(pos.count);
    for (const i of moved) { isMoved[i] = 1; n.setXYZ(i, 0, 0, 0); }
    const idx = g.index;
    const tri = idx ? idx.count : pos.count;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), fn = new THREE.Vector3();
    for (let t = 0; t < tri; t += 3) {
      const ia = idx ? idx.getX(t) : t, ib = idx ? idx.getX(t + 1) : t + 1, ic = idx ? idx.getX(t + 2) : t + 2;
      if (!(isMoved[ia] || isMoved[ib] || isMoved[ic])) continue;
      a.fromBufferAttribute(pos, ia); b.fromBufferAttribute(pos, ib); c.fromBufferAttribute(pos, ic);
      fn.subVectors(b, a).cross(c.sub(a));
      for (const k of [ia, ib, ic]) if (isMoved[k]) n.setXYZ(k, n.getX(k) + fn.x, n.getY(k) + fn.y, n.getZ(k) + fn.z);
    }
    for (const i of moved) {
      a.fromBufferAttribute(n, i);
      if (a.lengthSq() > 0) a.normalize(); else a.set(0, 1, 0);
      n.setXYZ(i, a.x, a.y, a.z);
    }
    n.needsUpdate = true;
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
        const dark = (Array.isArray(m.material) ? m.material[0] : m.material).clone() as THREE.MeshStandardMaterial;
        dark.color?.setScalar(0.05);
        dark.emissive?.setScalar(0);
        m.material = dark;
      });
    }
  }

  /** Full repair (reset): geometry, parts, lights, effects. */
  repair() {
    for (const [m, o] of this.original) {
      (m.geometry.getAttribute('position').array as Float32Array).set(o.pos);
      m.geometry.getAttribute('position').needsUpdate = true;
      const n = m.geometry.getAttribute('normal');
      if (n && o.nrm) { (n.array as Float32Array).set(o.nrm); n.needsUpdate = true; }
      m.geometry.computeBoundingSphere();
    }
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
    this.dentQueue = [];
    this.lastImpacts = 0;
    this.dmg = null;
    this.smoke.clear();
    this.sparks.clear();
  }
}
