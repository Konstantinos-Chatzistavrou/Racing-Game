// AI traffic: rival cars that lap the city route. Kinematic Rapier bodies (kinematicPositionBased)
// follow the route at a target speed: no tyre model, a fraction of a CoreCar's cost, can't spin out
// or get stuck, but the player still collides with them (Rapier gives a kinematic body the velocity
// of its per-tick move, so a crash into one feeds the core's damage model like a wall that moves).
// Speed: limited by the curvature ahead (lateral grip ~5.5 m/s^2) and by whatever is in the lane
// ahead (player or another AI car): they brake rather than push through.
// ?ai=0..3 sets the number of cars (default 3); ?blackcar=1 makes them matte black with lights off
// (night lighting test: the player's headlights should be the only way to see them).
import * as THREE from 'three/webgpu';
import RAPIER from '@dimforge/rapier3d-compat';
import { GROUP_CAR, type PhysicsWorld } from './physics/world';
import { materialsOf } from './scene/city';
import { mergeStaticMeshes } from './scene/merge';
import { setupCarMaterials, type CarVisualConfig } from './scene/car';
import { assetUrl, loadGLTF } from './scene/loaders';

interface RouteSample { x: number; y: number; z: number; curvature: number; width_left: number; width_right: number }

const LAT_ACC = 5.5, ACCEL = 3, BRAKE = 7, WHEEL_R = 0.34;
const PAINTS = [0x15181d, 0x0c1a33, 0xb8bcc2];   // gunmetal, deep blue, silver
const X = new THREE.Vector3(1, 0, 0), UP = new THREE.Vector3(0, 1, 0);

/** The route resampled for driving: lane centre (three coords, on the ground) and arc length. */
class Lane {
  readonly pts: THREE.Vector3[] = [];
  readonly s: number[] = [];              // arc length at each point
  readonly curv: number[] = [];           // |curvature| (1/m)
  readonly length: number;

  constructor(samples: RouteSample[], pw: PhysicsWorld) {
    const n = samples.length;
    const c = samples.map((p) => new THREE.Vector3(p.x, p.z, -p.y));   // core Z-up -> three (x, z, -y)
    // lane offset to the right of the centre line, kept inside narrow streets, smoothed so the car
    // doesn't step sideways where the width changes
    const raw = samples.map((p) => THREE.MathUtils.clamp(Math.min(p.width_left, p.width_right) - 1.4, 0, 2.6));
    const off = raw.map((_, i) => { let a = 0; for (let k = -6; k <= 6; k++) a += raw[(i + k + n) % n]; return a / 13; });
    const t = new THREE.Vector3(), right = new THREE.Vector3(), from = new THREE.Vector3(), down = new THREE.Vector3();
    let acc = 0;
    for (let i = 0; i < n; i++) {
      t.subVectors(c[(i + 1) % n], c[(i - 1 + n) % n]).setY(0).normalize();
      right.set(-t.z, 0, t.x);                                       // forward x up
      const p = c[i].clone().addScaledVector(right, off[i]);
      const hit = pw.raycast(from.copy(p).setY(p.y + 3), down.copy(p).setY(p.y - 17));
      if (hit) p.y = p.y + 3 - hit.toi;
      if (i > 0) acc += p.distanceTo(this.pts[i - 1]);
      this.pts.push(p);
      this.s.push(acc);
      this.curv.push(Math.abs(samples[i].curvature));
    }
    this.length = acc + this.pts[n - 1].distanceTo(this.pts[0]);
  }

  wrap(s: number) { return ((s % this.length) + this.length) % this.length; }

  /** Point at arc length s (linear between points; they are ~2 m apart). */
  at(s: number, out: THREE.Vector3) {
    s = this.wrap(s);
    const n = this.pts.length;
    let lo = 0, hi = n - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.s[m] <= s) lo = m; else hi = m - 1; }
    const s1 = lo + 1 < n ? this.s[lo + 1] : this.length;
    return out.lerpVectors(this.pts[lo], this.pts[(lo + 1) % n], (s - this.s[lo]) / Math.max(1e-6, s1 - this.s[lo]));
  }

  /** Highest |curvature| over [s, s + ahead]. */
  maxCurv(s: number, ahead: number) {
    let k = 0;
    for (let d = 0; d <= ahead; d += 2) {
      const ss = this.wrap(s + d), i = Math.min(this.pts.length - 1, Math.round((ss / this.length) * this.pts.length));
      k = Math.max(k, this.curv[i]);
    }
    return k;
  }
}

interface AiCar {
  root: THREE.Group;
  model: THREE.Object3D;
  body: RAPIER.RigidBody;
  wheels: { node: THREE.Object3D; rest: THREE.Quaternion }[];
  light: THREE.SpotLight | null;
  s: number; v: number; vmax: number; spin: number;
  parked: boolean;
  prevPos: THREE.Vector3; prevQuat: THREE.Quaternion;
  pos: THREE.Vector3; quat: THREE.Quaternion;
}

export class AiTraffic {
  readonly cars: AiCar[] = [];
  private lane: Lane;
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private m = new THREE.Matrix4();

  private constructor(private pw: PhysicsWorld, samples: RouteSample[], private starts: number[]) {
    this.lane = new Lane(samples, pw);
  }

  /** Must run after the city's colliders are queryable (after the first world.step()). */
  static async create(scene: THREE.Scene, pw: PhysicsWorld, cfg: CarVisualConfig, samples: RouteSample[], count: number, black: boolean) {
    const starts = [45, 140, 260].slice(0, count);
    const ai = new AiTraffic(pw, samples, starts);
    if (!count) return ai;
    // The traffic version of the car (lod_model: same parts and materials, ~28k triangles, 1k
    // textures): the player's hero model is dented by the damage system, these never are. The AI
    // cars (and remote players, net.ts) share it, geometry and all.
    const gltf = await loadGLTF(assetUrl(cfg.lod_model ?? cfg.model));
    const blackMat = new THREE.MeshStandardMaterial({ name: 'ai_black', color: 0x000000, roughness: 0.6, metalness: 0 });
    // Black paint: black albedo reflects nothing diffusely, so the car only shows through specular.
    // Measured in the night test: a full-strength layer (F0 4 %, or clear coat 1) on the rear panel
    // facing the headlights at 11 m blew out to a white slab (that surface gets ~10x the road's
    // light), a car with none was a hole in the picture. Reduced base specular + a thin, sharp clear
    // coat: dark body, readable edges and highlights.
    const blackPaint = new THREE.MeshPhysicalMaterial({
      name: 'ai_black_paint', color: 0x000000, roughness: 0.6, metalness: 0, specularIntensity: 0.2, clearcoat: 0.15, clearcoatRoughness: 0.05,
    });
    const cb = cfg.collision_box;
    for (const [i, s] of starts.entries()) {
      const model = gltf.scene.clone(true);
      const wheels: AiCar['wheels'] = [];
      for (const name of Object.values(cfg.wheel_nodes)) {
        const node = model.getObjectByName(name);
        if (node) wheels.push({ node, rest: node.quaternion.clone() });
      }
      // The body follows the lane on the ground, the wheels stay at their modelled hubs: drop the
      // model so the hub sits at the rolling radius (the modelled tyre is 0.345 m).
      if (wheels.length) model.position.y = WHEEL_R - wheels[0].node.position.y;
      // own paint colour per car (a clone of the file's clear-coat paint), shadows cast only:
      // they are in the player's headlight beam (the only shadow caster)
      if (!black) setupCarMaterials(model, cfg, PAINTS[i % PAINTS.length], false);
      else {
        model.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          m.castShadow = true;
          m.receiveShadow = false;
          const mat = materialsOf(m)[0];
          if (mat.name === 'light_beam') { m.visible = false; return; }
          m.material = mat.name === cfg.paint_material ? blackPaint : blackMat;
        });
      }
      if (new URLSearchParams(location.search).get('merge') !== '0') mergeStaticMeshes(model, wheels.map((w) => w.node));   // ~89 meshes -> one per material (the wheels spin: kept)
      const root = new THREE.Group();
      root.add(model);
      scene.add(root);
      // One unshadowed spot per car (cheap): lights up the road ahead, walls and the player as it
      // passes. None at all in the black-car test (lights off).
      let light: THREE.SpotLight | null = null;
      if (!black) {
        light = new THREE.SpotLight(0xfff3e0, 700, 55, 0.5, 0.5, 2);
        light.position.set(0, 0.55, 2.2);   // at the projector lenses (vela_gt.visual.json headlights)
        light.target.position.set(0, -0.5, 16);
        root.add(light, light.target);
      }
      const body = pw.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
      // Box from 0.15 m (nothing wedges under it) to 1.0 m: BELOW the top of the player's hull (1.2 m).
      // With equal heights the two top edges met edge-on, Rapier's contact normal tilted and a player
      // pushing against a side-on AI car climbed it and rolled over. No bounce either: the AI car is
      // immovable, any restitution flings the player back.
      const [sx, , sz] = cb.size_m, [cx, , cz] = cb.centre_in_model_m;
      const top = 1.0, bottom = 0.15;
      pw.world.createCollider(RAPIER.ColliderDesc.cuboid(sx / 2, (top - bottom) / 2, sz / 2).setTranslation(cx, (top + bottom) / 2, cz)
        .setFriction(0.3).setRestitution(0).setCollisionGroups(GROUP_CAR), body);
      const car: AiCar = {
        root, model, body, wheels, light, s, v: 0, vmax: [17, 21, 15][i % 3], spin: 0, parked: false,
        prevPos: new THREE.Vector3(), prevQuat: new THREE.Quaternion(), pos: new THREE.Vector3(), quat: new THREE.Quaternion(),
      };
      ai.cars.push(car);
    }
    ai.reset();
    return ai;
  }

  /** Back to the start positions (player reset). */
  reset() {
    for (const [i, c] of this.cars.entries()) {
      c.s = this.starts[i]; c.v = 0; c.parked = false;
      this.pose(c.s, c.pos, c.quat);
      c.prevPos.copy(c.pos); c.prevQuat.copy(c.quat);
      c.body.setTranslation(c.pos, true);
      c.body.setRotation(c.quat, true);
    }
  }

  /** Debug/tests: stop car i at arc length s (or at a free pose); it stays until reset(). */
  park(i: number, s: number, pose?: { pos: THREE.Vector3; yaw: number }) {
    const c = this.cars[i];
    if (!c) return;
    c.parked = true; c.v = 0; c.s = this.lane.wrap(s);
    if (pose) {
      c.pos.copy(pose.pos);
      c.quat.setFromAxisAngle(UP, pose.yaw);
      // on the ground (the AI's own collider is excluded)
      const hit = this.pw.raycast(this.a.copy(c.pos).setY(c.pos.y + 3), this.b.copy(c.pos).setY(c.pos.y - 17), c.body);
      if (hit) c.pos.y = c.pos.y + 3 - hit.toi;
    } else this.pose(c.s, c.pos, c.quat);
    c.prevPos.copy(c.pos); c.prevQuat.copy(c.quat);
    c.body.setTranslation(c.pos, true);
    c.body.setRotation(c.quat, true);
  }

  /**
   * Shader warm-up (loading screen): park every car in the player's headlight beam so the first
   * render builds all their pipelines, shadow pass included. Without it the first car to drive
   * into the beam froze the game for ~0.7 s. Call reset() afterwards.
   */
  stage(ground: THREE.Vector3, yaw: number) {
    for (let i = 0; i < this.cars.length; i++) {
      const d = 9 + 6 * i;
      this.park(i, 0, { pos: new THREE.Vector3(ground.x + Math.sin(yaw) * d, ground.y, ground.z + Math.cos(yaw) * d), yaw });
    }
  }

  /** Pose on the lane: position on the ground, heading/pitch from the chord over +-2.5 m. */
  private pose(s: number, pos: THREE.Vector3, quat: THREE.Quaternion) {
    this.lane.at(s, pos);
    const f = this.lane.at(s + 2.5, this.a).sub(this.lane.at(s - 2.5, this.b)).normalize();
    const x = this.b.crossVectors(UP, f).normalize();
    quat.setFromRotationMatrix(this.m.makeBasis(x, this.a.crossVectors(f, x), f));
  }

  /** One physics tick (before world.step()). player = the player's chassis position. */
  tick(dt: number, player: { x: number; y: number; z: number }) {
    for (const c of this.cars) {
      c.prevPos.copy(c.pos); c.prevQuat.copy(c.quat);
      if (c.parked) continue;
      let target = Math.min(c.vmax, Math.sqrt(LAT_ACC / Math.max(1e-4, this.lane.maxCurv(c.s, 10 + c.v * 2.2))));
      // anything in the lane ahead: player or another AI car -> slow to a stop ~7 m behind it
      const fwd = this.a.set(0, 0, 1).applyQuaternion(c.quat);
      const block = (p: { x: number; y: number; z: number }) => {
        const dx = p.x - c.pos.x, dz = p.z - c.pos.z;
        const f = dx * fwd.x + dz * fwd.z, l = dz * fwd.x - dx * fwd.z;
        if (f > 0 && f < 25 && Math.abs(l) < 2.4) target = Math.min(target, Math.max(0, (f - 7) * 0.9));
      };
      block(player);
      for (const o of this.cars) if (o !== c) block(o.pos);
      c.v = target > c.v ? Math.min(target, c.v + ACCEL * dt) : Math.max(target, c.v - BRAKE * dt);
      c.s = this.lane.wrap(c.s + c.v * dt);
      c.spin += (c.v * dt) / WHEEL_R;
      this.pose(c.s, c.pos, c.quat);
      c.body.setNextKinematicTranslation(c.pos);
      c.body.setNextKinematicRotation(c.quat);
    }
  }

  /** Draw between the last two ticks (alpha as for the player's car). */
  update(alpha: number, camera: THREE.Camera) {
    for (const c of this.cars) {
      c.root.position.lerpVectors(c.prevPos, c.pos, alpha);
      c.root.quaternion.slerpQuaternions(c.prevQuat, c.quat, alpha);
      // hide the model in the fog (lights stay: changing the light set recompiles materials)
      c.model.visible = c.root.position.distanceToSquared(camera.position) < 230 * 230;
      for (const w of c.wheels) w.node.quaternion.setFromAxisAngle(X, c.spin).multiply(w.rest);
    }
  }
}
