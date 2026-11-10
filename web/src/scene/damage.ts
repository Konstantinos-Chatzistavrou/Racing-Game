// Visual side of crash damage (port of game/scripts/damage_visuals.gd). The CORE decides how far
// each zone is crushed (energy -> crush depth, core/src/damage.cpp); this module SHOWS it:
//   - dents at the actual impact point, in the vertex shader (dents.ts: accumulated, zero CPU),
//   - parts breaking off as physics debris (bumpers, mirrors; wheels in a heavy wreck), broken lights (headlights flicker
//     for 2 s after a heavy front hit, then die), engine smoke, sparks,
//   - engine fire: the core's smoulder -> fire state (smoke, then growing flames + a flickering
//     orange point light from the engine bay). No explosion; R repairs.
// The physical consequences (bent steering, weaker springs, lost power, drag, brake fade) are in the core.
import * as THREE from 'three/webgpu';
import RAPIER from '@dimforge/rapier3d-compat';
import { instancedDynamicBufferAttribute, uv, vec2, vec3, vec4, smoothstep, float, mix, sin, time, uniform, mx_fractal_noise_float } from 'three/tsl';
import type { Damage } from '../physics/core';
import { GROUP_DEBRIS, type PhysicsWorld } from '../physics/world';
import type { CarVisual } from './car';
import { materialsOf } from './city';
import { Dents } from './dents';

const ZONES = ['front', 'rear', 'left', 'right'] as const;
// Crush direction per zone in model space (X left, Y up, Z forward): the dent goes INTO the car.
const INWARD = [new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, 1), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0)];
// never dented: wheels, calipers, glass cabin, wheel-well liners and underbody (checked across full ancestor chain)
const SKIP = ['wheel_', 'caliper_', 'interior', 'seat', 'dashboard', 'steering', 'wheel_well', 'underbody', 'hood_inner', 'glass'];
// Break-off thresholds in metres of zone crush (same as the Godot build).
const BREAK_CRUSH: Record<string, number> = { bumper_front: 0.3, bumper_rear: 0.3, mirror_L: 0.12, mirror_R: 0.12 };
const UNIT = new THREE.Vector3(1, 1, 1);
const LIGHTS_CRUSH = 0.12;
// Core wheel damage from which the wheel is gone (DamageParams::wheel_off): it rolls away, the hub drags and sparks.
const WHEEL_OFF = 0.95;
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
/** Layer for parts that broke off the car: the main camera renders it, the car's reflection probe doesn't. */
export const DEBRIS_LAYER = 1;

/** Shared by the fire sprites and the smoke they light from below (orange, scaled by the fire's strength). */
const fireGlow = uniform(new THREE.Color(0, 0, 0));

type Style = 'soft' | 'fire' | 'smoke' | 'ember';

/**
 * Instanced camera-facing sprites, simulated on the CPU (a few hundred at most), shaded per style:
 *  - soft:  round soft dot (impact sparks)
 *  - fire:  a flame tongue per sprite (taller than wide): fractal noise scrolling upward bends and tears its outline,
 *           and its colour comes from a temperature: white-yellow core -> orange -> deep red -> gone, cooling with age
 *           (blackbody-ish ramp, HDR so bloom makes it glow). Additive.
 *  - smoke: a billow per sprite: fractal-noise density inside a soft disc, random rotation that keeps turning, bright
 *           top / dark base, lit from below by the fire (fireGlow), fading in fast and out slowly. Alpha-blended.
 *  - ember: tiny hot flecks that flicker.
 * Per particle: life fraction and a random seed (attribute ls), so every sprite looks and moves differently.
 */
export class Particles {
  private pos: THREE.InstancedBufferAttribute;
  private col: THREE.InstancedBufferAttribute;
  private size: THREE.InstancedBufferAttribute;
  private ls: THREE.InstancedBufferAttribute;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  readonly sprite: THREE.Sprite;
  private next = 0;
  private active = 0;
  color = new THREE.Color(1, 1, 1);

  constructor(private max: number, private opts: { additive: boolean; gravity: number; grow: number; drag: number; style?: Style; heat?: number; opacity?: number }) {
    this.pos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.col = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    this.size = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
    this.ls = new THREE.InstancedBufferAttribute(new Float32Array(max * 2), 2);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max).fill(1);
    const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
    m.blending = opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    m.positionNode = instancedDynamicBufferAttribute(this.pos);
    const sz = instancedDynamicBufferAttribute(this.size) as unknown as THREE.Node<'float'>;
    const c = instancedDynamicBufferAttribute(this.col, 'vec4') as unknown as THREE.Node<'vec4'>;
    const ls = instancedDynamicBufferAttribute(this.ls, 'vec2') as unknown as THREE.Node<'vec2'>;
    const age = ls.x, seed = ls.y;
    const style = opts.style ?? 'soft';
    const p = uv().sub(0.5);
    if (style === 'fire') {
      m.scaleNode = vec2(sz.mul(0.72), sz.mul(1.55));
      const heat = float(opts.heat ?? 1);
      // tongue: narrows toward the top; noise rising through it bends and tears the outline
      const n = mx_fractal_noise_float(vec3(p.x.mul(2.6).add(seed.mul(13)), p.y.mul(2.2).sub(time.mul(3.4)).add(seed.mul(7)), time.mul(0.9).add(seed.mul(5))), 3, 2.1, 0.55);
      const width = mix(float(0.95), float(0.28), p.y.add(0.5).clamp(0, 1));
      const q = vec2(p.x.add(n.mul(0.13).mul(p.y.add(0.6))).div(width), p.y.mul(1.05).add(0.06));
      const core = smoothstep(float(0.5), float(0.02), q.length().add(n.mul(0.2)));
      const T = core.mul(heat).mul(float(1).sub(age.mul(0.75)));                     // temperature 0..~1.4
      const col = mix(vec3(0.55, 0.05, 0.005), vec3(1.0, 0.32, 0.04), smoothstep(0.18, 0.45, T))
        .add(vec3(1.0, 0.75, 0.32).mul(smoothstep(0.45, 0.8, T)))
        .add(vec3(1.0, 0.95, 0.8).mul(smoothstep(0.85, 1.2, T).mul(1.5)));
      const a = smoothstep(float(0.06), float(0.3), T).mul(float(1).sub(age).pow(0.6)).mul(c.w);
      m.colorNode = vec4(col.mul(smoothstep(0.1, 1.2, T).mul(5.5).add(0.6)), a);
    } else if (style === 'smoke') {
      m.scaleNode = vec2(sz, sz);
      m.rotationNode = seed.mul(6.283).add(age.mul(seed.sub(0.5).mul(2.4)));
      const n = mx_fractal_noise_float(vec3(p.x.mul(3.1).add(seed.mul(17)), p.y.mul(3.1).sub(time.mul(0.35)), time.mul(0.18).add(seed.mul(9))), 3, 2.0, 0.5);
      const r = p.length();
      const dens = smoothstep(float(0.5), float(0.12), r).mul(smoothstep(float(-0.35), float(0.4), n.add(0.32).sub(r.mul(0.7))));
      const shade = mix(float(0.6), float(1.15), p.y.add(0.5).clamp(0, 1));         // sprite uv y is up: lit top, dark base
      // young smoke right over the fire is lit orange from below (underside only); older smoke has drifted out of it
      const under = fireGlow.mul(smoothstep(float(0.1), float(-0.45), p.y)).mul(float(1).sub(age).pow(3));
      const fade = smoothstep(float(0), float(0.07), age).mul(float(1).sub(age).pow(1.3));
      m.colorNode = vec4(c.xyz.mul(shade).add(under), dens.mul(fade).mul(opts.opacity ?? 0.85).mul(c.w));
    } else if (style === 'ember') {
      m.scaleNode = vec2(sz, sz);
      const flick = sin(time.mul(31).add(seed.mul(40))).mul(0.35).add(0.75);
      const soft = smoothstep(float(0.5), float(0.0), p.length());
      m.colorNode = vec4(c.xyz.mul(flick).mul(float(1).sub(age.mul(0.6))), c.w.mul(soft).mul(float(1).sub(age)));
    } else {
      m.scaleNode = vec2(sz, sz);
      const soft = smoothstep(float(0.5), float(0.0), p.length());   // round, soft edge
      m.colorNode = vec4(c.xyz, c.w.mul(soft));
    }
    this.sprite = new THREE.Sprite(m);
    this.sprite.count = 1;
    this.sprite.frustumCulled = false;
  }

  emit(p: THREE.Vector3, v: THREE.Vector3, life: number, size: number) {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    if (this.life[i] <= 0) this.active++;
    this.pos.setXYZ(i, p.x, p.y, p.z);
    this.vel[i * 3] = v.x; this.vel[i * 3 + 1] = v.y; this.vel[i * 3 + 2] = v.z;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size.setX(i, size);
    this.ls.setXY(i, 0, Math.random());
    this.sprite.count = this.max;
    this.sprite.visible = true;
  }

  update(dt: number) {
    if (this.active === 0) {
      if (this.sprite.visible) this.sprite.visible = false;
      return;
    }
    const { gravity, grow, drag } = this.opts;
    const k = Math.exp(-drag * dt);
    const soft = (this.opts.style ?? 'soft') === 'soft';
    let alive = 0;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) { this.col.setW(i, 0); continue; }
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.col.setW(i, 0); continue; }
      alive++;
      const t = 1 - this.life[i] / this.maxLife[i];   // 0 -> 1 over the life
      const o = i * 3;
      this.vel[o] *= k; this.vel[o + 2] *= k;
      this.vel[o + 1] = this.vel[o + 1] * k + gravity * dt;
      this.pos.setXYZ(i, this.pos.getX(i) + this.vel[o] * dt, this.pos.getY(i) + this.vel[o + 1] * dt, this.pos.getZ(i) + this.vel[o + 2] * dt);
      this.size.setX(i, this.size.getX(i) * (1 + grow * dt));
      this.ls.setX(i, t);
      // soft sprites fade by colour alpha here; the shaded styles fade in their shader (from the life fraction)
      this.col.setXYZW(i, this.color.r, this.color.g, this.color.b, soft ? (1 - t) * (this.opts.additive ? 1 : 0.6) : 1);
    }
    this.active = alive;
    if (alive === 0) this.sprite.visible = false;
    this.pos.needsUpdate = this.col.needsUpdate = this.size.needsUpdate = this.ls.needsUpdate = true;
  }

  clear() { this.life.fill(0); this.active = 0; this.sprite.visible = false; }
}

interface Debris { node: THREE.Object3D; parent: THREE.Object3D; local: THREE.Matrix4; body: RAPIER.RigidBody; age: number; wheel?: number; scale?: THREE.Vector3 }

export class DamageVisuals {
  private deformables: THREE.Mesh[] = [];
  readonly dents = new Dents();
  private applied = [0, 0, 0, 0];
  private detached = new Map<string, Debris>();
  private lightsOff = { front: false, rear: false };
  private lightMats = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private lastImpacts = 0;
  private t = 0;
  private smoke = new Particles(150, { additive: false, gravity: 0.9, grow: 0.5, drag: 0.45, style: 'smoke', opacity: 0.88 });
  private sparks = new Particles(80, { additive: true, gravity: -9.8, grow: -0.8, drag: 0.4 });
  // fire: flame tongues + a hotter inner layer (style 'fire': noise-torn outline, temperature colour ramp, HDR additive:
  // bloom does the glow), and embers drifting up out of it
  private flames = new Particles(64, { additive: true, gravity: 2.2, grow: -0.35, drag: 1.4, style: 'fire', heat: 1.05 });
  private flameCore = new Particles(28, { additive: true, gravity: 1.6, grow: -0.6, drag: 1.8, style: 'fire', heat: 1.45 });
  private embers = new Particles(60, { additive: true, gravity: 1.1, grow: -0.3, drag: 0.7, style: 'ember' });
  // Created up front at intensity 0: adding a light mid-race recompiles every lit material.
  private fireLight = new THREE.PointLight(0xff6a1c, 0, 10, 2);
  private fireAcc = 0;
  private emberAcc = 0;
  private flicker = 0;        // s of headlight flicker left (> 0 = flickering)
  private flickerHold = 0;    // s until the next flicker level
  private smokeAcc = 0;
  private wheelsOff: number[] = [];
  private hubAcc = 0;
  private dmg: Damage | null = null;
  get last(): Damage | null { return this.dmg; }
  get debrisCount(): number { return this.detached.size; }
  onImpact: (kj: number, glass: boolean) => void = () => {};

  /** Detachable parts' rest pose (parent space) and the point they hang from, for sagging before they tear off. */
  private hang = new Map<string, { node: THREE.Object3D; pos: THREE.Vector3; quat: THREE.Quaternion; pivot: THREE.Vector3; amount: number; side: number }>();
  private crushShown = [0, 0, 0, 0];

  constructor(private car: CarVisual, private cfg: DamageVisualConfig, private pw: PhysicsWorld, private scene: THREE.Scene) {
    this.dents.setWheels(car.wheelWells());
    {
      // body extent in model space, for the zone crumple
      car.model.updateWorldMatrix(true, true);
      const inv = car.model.matrixWorld.clone().invert();
      const box = new THREE.Box3();
      car.model.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && !m.name.startsWith('wheel')) box.union(new THREE.Box3().setFromObject(m, true).applyMatrix4(inv)); });
      if (!box.isEmpty()) this.dents.setBounds(box);
      // hanging parts: bumpers hang from their top edge (one corner lower), mirrors fold back from their inner end
      for (const name of Object.keys(cfg.detachable)) {
        const node = car.model.getObjectByName(name);
        if (!node?.parent) continue;
        const pinv = node.parent.matrixWorld.clone().invert();
        const b = new THREE.Box3().setFromObject(node, true).applyMatrix4(pinv);
        const mirror = name.startsWith('mirror');
        const inner = Math.abs(b.min.x) < Math.abs(b.max.x) ? b.min.x : b.max.x;
        const side = Math.random() < 0.5 ? -1 : 1;
        const pivot = mirror ? new THREE.Vector3(inner, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2)
          : new THREE.Vector3(side > 0 ? b.min.x : b.max.x, b.max.y, (b.min.z + b.max.z) / 2);
        this.hang.set(name, { node, pos: node.position.clone(), quat: node.quaternion.clone(), pivot, amount: 0, side });
      }
    }
    const isSkipped = (o: THREE.Object3D) => {
      let cur: THREE.Object3D | null = o;
      while (cur && cur !== car.model) {
        if (SKIP.some((p) => cur!.name.startsWith(p))) return true;
        cur = cur.parent;
      }
      return false;
    };
    car.model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !isSkipped(o)) this.deformables.push(m);
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
    this.embers.color.setRGB(5, 1.7, 0.3);
    scene.add(this.smoke.sprite, this.sparks.sprite, this.flames.sprite, this.flameCore.sprite, this.embers.sprite);
  }

  /** Garage car swap: take this car's sprites and fire light out of the scene (the model itself is dropped by the caller). */
  dispose() {
    this.scene.remove(this.smoke.sprite, this.sparks.sprite, this.flames.sprite, this.flameCore.sprite, this.embers.sprite);
    this.car.root.remove(this.fireLight);
    for (const d of this.detached.values()) {
      if (d.body.isValid()) this.pw.world.removeRigidBody(d.body);
      this.scene.remove(d.node);          // loose parts of the car being swapped out
    }
    this.detached.clear();
    this.wheelsOff.length = 0;
  }

  /** Every frame. Damage is read from the core at 20 Hz; dents are applied one panel per frame. */
  update(dt: number, damage: () => Damage) {
    this.smoke.update(dt);
    this.sparks.update(dt);
    this.flames.update(dt);
    this.flameCore.update(dt);
    this.embers.update(dt);
    this.updateDebris(dt);
    this.updateFlicker(dt);
    if (this.dmg && (this.dmg.engine > 0.25 || this.dmg.totaled || this.dmg.smoulder > 0)) this.emitSmoke(dt);
    this.updateFire(dt);
    if (this.wheelsOff.length) this.hubSparks(dt);
    this.t += dt;
    if (this.t < 0.05) return;
    this.t = 0;
    const d = (this.dmg = damage());
    // ---- whole-zone crumple follows the core's crush depth (eased so it folds in over ~0.15 s, never springs back)
    for (let z = 0; z < 4; z++) this.crushShown[z] = Math.max(this.crushShown[z], this.crushShown[z] + (d.crush[z] * 0.55 - this.crushShown[z]) * 0.35);
    this.dents.setCrush(this.crushShown[0], this.crushShown[1], this.crushShown[2], this.crushShown[3]);
    this.updateHang(d);

    // ---- deformation: show the crush the core added since last time, at the impact point
    const z = d.lastZone;
    const delta = d.crush[z] - this.applied[z];
    if (delta > 0.01) {
      this.applied[z] = d.crush[z];
      const p = new THREE.Vector3(...d.lastPoint).add(this.car.cg);   // car local (CG) -> model space
      // dent radius grows with the zone's total crush (same rule as the old CPU path)
      this.dents.add(p, INWARD[z], delta * 0.65, THREE.MathUtils.clamp(0.5 + 1.1 * d.crush[z], 0.5, 1.6));
    }
    // ---- break-offs
    for (const [name, [zone]] of Object.entries(this.cfg.detachable)) {
      const zi = ZONES.indexOf(zone as (typeof ZONES)[number]);
      if (zi >= 0 && d.crush[zi] > (BREAK_CRUSH[name] ?? 0.3)) this.detach(name);
    }
    for (let i = 0; i < 4; i++) if (d.wheel[i] >= WHEEL_OFF) this.detachWheel(i);
    // ---- lights
    let glass = false;
    const heavyFront = d.impacts > this.lastImpacts && d.lastZone === 0 && d.lastKj >= HEADLIGHT_KJ;
    if ((d.crush[0] > LIGHTS_CRUSH || heavyFront) && !this.lightsOff.front) {
      // headlights: loose connector -> flicker for FLICKER_S, then dead (updateFlicker)
      this.lightsOff.front = glass = true;
      this.flicker = this.car.lightsOn ? FLICKER_S : 0.001;   // lights off at the time: just dead
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
    // Burning: a thick, near-black column (oil, plastics, tyres), big billows rising and spreading, lit orange from below.
    // Before that: grey-white smoke / coolant steam from the engine bay, thicker as the engine dies.
    const burning = d.fire > 0 || d.totaled;
    const rate = burning ? 26 + 14 * d.fire : Math.max(5 + 12 * THREE.MathUtils.clamp((d.engine - 0.25) / 0.6, 0, 1), 7 + 14 * d.smoulder);
    this.smokeAcc += dt * rate;
    const grey = burning ? 0.065 : Math.min(0.62 - 0.4 * d.engine, 0.58 - 0.35 * d.smoulder);   // charcoal: still reads against a night sky
    this.smoke.color.setRGB(grey, grey * 0.98, grey * 0.96);
    const origin = new THREE.Vector3(...this.cfg.engine_smoke_in_model_m).sub(this.car.cg).applyMatrix4(this.car.root.matrixWorld);
    const v = new THREE.Vector3(), p = new THREE.Vector3();
    while (this.smokeAcc >= 1) {
      this.smokeAcc -= 1;
      p.set((Math.random() - 0.5) * 0.6, 0.15, (Math.random() - 0.5) * 0.6).add(origin);
      if (burning) {
        v.set((Math.random() - 0.5) * 0.6, 1.5 + Math.random() * 1.1, (Math.random() - 0.5) * 0.6);
        this.smoke.emit(p.setY(p.y + 0.4), v, 4.5 + Math.random() * 2, 0.8 + Math.random() * 0.6);
      } else {
        v.set((Math.random() - 0.5) * 0.5, 0.7 + Math.random() * 0.7, (Math.random() - 0.5) * 0.5);
        this.smoke.emit(p, v, 2.6 + Math.random(), 0.45 + Math.random() * 0.35);
      }
    }
  }

  /**
   * Engine fire from the core's fire state (0..1, grows over ~45 s): flames from the engine bay,
   * rate and size growing with it, plus an orange point light flickering on two incommensurate
   * sines and noise (fire light never holds still).
   */
  private updateFire(dt: number) {
    const f = this.dmg?.fire ?? 0;
    if (f <= 0) { this.fireLight.intensity = 0; fireGlow.value.setRGB(0, 0, 0); return; }
    const g = 0.25 + 0.75 * f;                                   // visual size: small flames at ignition
    const time = performance.now() / 1000;
    const flick = 0.7 + 0.18 * Math.sin(time * 23) + 0.12 * Math.sin(time * 37.7) + 0.15 * (Math.random() - 0.5);
    this.fireLight.intensity = 60 * g * flick;
    this.fireLight.distance = 6 + 6 * g;
    const origin = new THREE.Vector3(...this.cfg.engine_smoke_in_model_m).sub(this.car.cg).applyMatrix4(this.car.root.matrixWorld);
    fireGlow.value.setRGB(1.0, 0.38, 0.09).multiplyScalar(0.32 * g * flick);
    this.fireAcc += dt * (14 + 40 * f);
    this.emberAcc += dt * (5 + 20 * f);
    const v = new THREE.Vector3(), p = new THREE.Vector3();
    while (this.fireAcc >= 1) {
      this.fireAcc -= 1;
      // flames lick out across the engine bay (wider as it spreads) and from the gaps under the bonnet
      p.set((Math.random() - 0.5) * 0.9 * g, 0.05 + Math.random() * 0.1, (Math.random() - 0.5) * 0.7 * g).add(origin);
      v.set((Math.random() - 0.5) * 0.4, 1.4 + Math.random() * 1.2 * g, (Math.random() - 0.5) * 0.4);
      this.flames.emit(p, v, 0.45 + Math.random() * 0.35 * g, (0.42 + Math.random() * 0.35) * g);
      if (Math.random() < 0.55) this.flameCore.emit(p, v.multiplyScalar(0.75), 0.3 + Math.random() * 0.2, (0.28 + Math.random() * 0.16) * g);
    }
    while (this.emberAcc >= 1) {
      this.emberAcc -= 1;
      p.set((Math.random() - 0.5) * 0.8 * g, 0.4, (Math.random() - 0.5) * 0.6 * g).add(origin);
      v.set((Math.random() - 0.5) * 2.2, 2 + Math.random() * 2.5, (Math.random() - 0.5) * 2.2);
      this.embers.emit(p, v, 1.2 + Math.random() * 1.4, 0.025 + Math.random() * 0.03);
    }
  }

  /** Headlights after a heavy front hit: random on/dim/off levels held 30-150 ms, then dead. */
  private updateFlicker(dt: number) {
    if (this.flicker <= 0) return;
    this.flicker -= dt;
    // intensity changes only, NOT visible = false: changing the scene's light set recompiles every
    // lit material (a ~300 ms freeze on impact)
    if (this.flicker <= 0) {
      this.car.lightsBroken = true;                              // dead until repair, whatever L says
      this.car.applyHeadlights();
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
    // Off the car it would be drawn by the reflection probe (which hides the car, so car materials are never compiled
    // for its cube pass): a 150+ ms shader compile in the middle of the crash. Layer 1 is seen by the main camera only.
    node.traverse((o) => o.layers.set(DEBRIS_LAYER));
    this.detached.set(name, { node, parent, local, body, age: 0 });
  }

  /**
   * A wheel is torn off (core wheel damage >= WHEEL_OFF): an 18 kg cylinder that leaves with the car's speed, rolling,
   * kicked outward. The caliper and disc stay on the hub; the core drops that corner's grip to steel-on-asphalt.
   */
  private detachWheel(i: number) {
    const key = `wheel${i}`;
    if (this.detached.has(key)) return;
    const w = this.car.wheel(i);
    const node = w.node;
    if (!node.parent) return;
    const parent = node.parent;
    const local = node.matrix.clone();
    node.updateWorldMatrix(true, true);
    const wp = new THREE.Vector3(), wq = new THREE.Quaternion(), ws = new THREE.Vector3();
    node.matrixWorld.decompose(wp, wq, ws);
    const rootQ = this.car.root.getWorldQuaternion(new THREE.Quaternion());
    const axle = new THREE.Vector3(1, 0, 0).applyQuaternion(rootQ);                     // world; model X = left
    const out = axle.clone().multiplyScalar(w.hub.x >= 0 ? 1 : -1);
    const body = this.pw.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(wp.x, wp.y, wp.z).setRotation(wq).setLinearDamping(0.05).setAngularDamping(0.25));
    // Rapier's cylinder stands on Y: turn it onto the axle, in the wheel node's own frame.
    const axleLocal = axle.clone().applyQuaternion(wq.clone().invert());
    const cq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axleLocal);
    this.pw.world.createCollider(RAPIER.ColliderDesc.cylinder(0.11, w.radius).setRotation(cq).setMass(18).setFriction(0.9).setRestitution(0.45).setCollisionGroups(GROUP_DEBRIS), body);
    const v = this.car.velocity;
    const lin = new THREE.Vector3(v.x * 0.9, v.y * 0.9 + 1.8, v.z * 0.9).addScaledVector(out, 2.5 + Math.random() * 1.5);
    body.setLinvel(lin, true);
    const spin = new THREE.Vector3(0, 1, 0).cross(lin).multiplyScalar(1 / Math.max(0.2, w.radius));   // rolling: w = n x v / r
    body.setAngvel({ x: spin.x + (Math.random() - 0.5) * 3, y: spin.y, z: spin.z + (Math.random() - 0.5) * 3 }, true);
    this.car.setWheelOff(i, true);
    this.scene.attach(node);
    node.matrixAutoUpdate = false;
    node.traverse((o) => { o.layers.set(DEBRIS_LAYER); if (o.name.startsWith('wheel_blur_')) o.visible = false; });   // no spin blur on a loose wheel
    this.detached.set(key, { node, parent, local, body, age: 0, wheel: i, scale: ws });
    this.wheelsOff.push(i);
  }

  /** The bare hub drags along the road: a spray of sparks behind every missing wheel while the car moves. */
  private hubSparks(dt: number) {
    const speed = this.car.velocity.length();
    if (speed < 2) return;
    this.hubAcc += dt * Math.min(70, 8 + speed * 2.2);
    const p = new THREE.Vector3(), v = new THREE.Vector3();
    while (this.hubAcc >= 1) {
      this.hubAcc -= 1;
      const w = this.car.wheel(this.wheelsOff[Math.floor(Math.random() * this.wheelsOff.length)]);
      p.copy(w.hub).setY(w.hub.y - w.radius * 0.85);
      this.car.model.localToWorld(p);
      v.copy(this.car.velocity).multiplyScalar(0.25 + Math.random() * 0.3);
      v.x += (Math.random() - 0.5) * 2.5; v.y += 0.8 + Math.random() * 2.2; v.z += (Math.random() - 0.5) * 2.5;
      this.sparks.emit(p, v, 0.25 + Math.random() * 0.35, 0.03 + Math.random() * 0.025);
    }
  }

  /**
   * Parts that are hit but not yet torn off hang: a bumper sags on its top clips with one corner dropping (up to ~20 deg),
   * a mirror folds back on its hinge. From 35 % of the crush that tears the part off, fully hanging at 100 %.
   */
  private updateHang(d: Damage) {
    for (const [name, h] of this.hang) {
      if (this.detached.has(name)) continue;
      const zone = ZONES.indexOf(this.cfg.detachable[name][0] as (typeof ZONES)[number]);
      const brk = BREAK_CRUSH[name] ?? 0.3;
      const amount = THREE.MathUtils.clamp((d.crush[zone] - 0.35 * brk) / (0.65 * brk), 0, 1);
      if (amount <= h.amount + 1e-3) continue;
      h.amount = amount;
      const q = new THREE.Quaternion();
      if (name.startsWith('mirror')) {
        const left = h.pivot.x > 0;
        q.setFromEuler(new THREE.Euler(0, (left ? 1 : -1) * 1.15 * amount, (left ? -1 : 1) * 0.25 * amount));
      } else {
        const front = name.includes('front');
        q.setFromEuler(new THREE.Euler((front ? -1 : 1) * 0.22 * amount, 0, h.side * 0.16 * amount));
      }
      h.node.quaternion.copy(q).multiply(h.quat);
      h.node.position.copy(h.pos).sub(h.pivot).applyQuaternion(q).add(h.pivot);
    }
  }

  private updateDebris(dt: number) {
    for (const d of this.detached.values()) {
      if (!d.body.isValid()) continue;
      d.age += dt;
      const t = d.body.translation(), r = d.body.rotation();
      d.node.matrix.compose(new THREE.Vector3(t.x, t.y, t.z), new THREE.Quaternion(r.x, r.y, r.z, r.w), d.scale ?? UNIT);
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
      d.node.traverse((o) => { o.layers.set(0); if (o.name.startsWith('wheel_blur_')) o.visible = true; });
      if (d.wheel !== undefined) this.car.setWheelOff(d.wheel, false);
      d.node.matrix.copy(d.local);
      d.node.matrix.decompose(d.node.position, d.node.quaternion, d.node.scale);
      d.node.matrixAutoUpdate = true;
      d.node.visible = true;
    }
    this.detached.clear();
    this.wheelsOff.length = 0;
    for (const [m, mat] of this.lightMats) m.material = mat;
    this.lightMats.clear();
    this.car.lightsBroken = false;
    this.car.applyHeadlights();
    this.lightsOff = { front: false, rear: false };
    this.applied = [0, 0, 0, 0];
    this.crushShown = [0, 0, 0, 0];
    for (const h of this.hang.values()) { h.amount = 0; h.node.position.copy(h.pos); h.node.quaternion.copy(h.quat); h.node.updateMatrix(); }
    this.lastImpacts = 0;
    this.dmg = null;
    this.smoke.clear();
    this.sparks.clear();
    this.flames.clear();
    this.flameCore.clear();
    this.embers.clear();
    fireGlow.value.setRGB(0, 0, 0);
    this.flicker = 0;
    this.fireLight.intensity = 0;
  }

  /** Force particle sprites visible (1 degenerate instance) during shader warm-up, then hide until emitted. */
  warmup(on: boolean) {
    for (const p of [this.smoke, this.sparks, this.flames, this.flameCore, this.embers]) {
      p.sprite.count = 1;
      p.sprite.visible = on;
    }
  }
}
