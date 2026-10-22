// Rigid-body world (Rapier): integrates the chassis, answers wheel raycasts against the city's
// collision meshes and resolves crashes. Mirrors godot_ext/src/rs_vehicle.cpp: the core computes
// tyre/suspension/aero forces, this file applies them and moves the body.
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three/webgpu';
import { CoreCar, OUT, type AssistToggles, type RawInput } from './core';

export const DT = 1 / 240;

// Collision groups ((membership << 16) | filter): cars never collide with their own debris, so a
// bumper that breaks off inside the car's hull doesn't register as a second crash.
export const GROUP_CAR = (0x0001 << 16) | 0xfffd;
export const GROUP_DEBRIS = (0x0002 << 16) | 0xfffe;   // same tick as the Godot build (physics_ticks_per_second = 240)

export async function loadRapier() { await RAPIER.init(); }

export class PhysicsWorld {
  readonly world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  private surfaceOf = new Map<number, number>();   // collider handle -> core surface index

  constructor() { this.world.timestep = DT; }

  /**
   * Static trimesh from a mesh already placed in the world (uses its world matrix). Created with NO
   * parent body: Rapier treats such colliders as fixed (never integrated, no solver islands, never
   * paired with other fixed colliders), same as a fixed body. Measured (drive.mjs crash/damage):
   * world.step() = ~0.08-0.12 ms with the 42 city colliders and the car awake; +~0.1 ms while debris
   * tumbles, back to the baseline once it sleeps (debris uses Rapier's default canSleep = true; the
   * player car is kept awake on purpose: it is driven every tick).
   */
  addStaticMesh(mesh: THREE.Mesh, surface: number) {
    mesh.updateWorldMatrix(true, false);
    const g = mesh.geometry;
    const pos = g.getAttribute('position');
    const v = new Float32Array(pos.count * 3);
    const t = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      t.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      v[3 * i] = t.x; v[3 * i + 1] = t.y; v[3 * i + 2] = t.z;
    }
    const idx = g.index ? new Uint32Array(g.index.array) : Uint32Array.from({ length: pos.count }, (_, i) => i);
    const col = this.world.createCollider(RAPIER.ColliderDesc.trimesh(v, idx).setFriction(0.4).setRestitution(0.05));
    this.surfaceOf.set(col.handle, surface);
  }

  /**
   * Static box (no parent body = fixed, like the trimeshes): the city's sidewalk props (hydrants,
   * bins, utility boxes) so the car can't drive through them. ~200 boxes, all fixed: they are never
   * integrated and never paired with each other, so the step cost doesn't change measurably.
   */
  addStaticBox(centre: THREE.Vector3, half: THREE.Vector3, rot: THREE.Quaternion, surface: number) {
    const col = this.world.createCollider(RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
      .setTranslation(centre.x, centre.y, centre.z).setRotation(rot).setFriction(0.4).setRestitution(0.05));
    this.surfaceOf.set(col.handle, surface);
  }

  surface(c: RAPIER.Collider): number { return this.surfaceOf.get(c.handle) ?? 0; }

  /**
   * First hit along a segment, ignoring one body (the car itself). Only colliders the CAR collides
   * with count (groups = GROUP_CAR): a bumper that broke off and lies in front of a wheel is not
   * road (wheel rays used to land on debris and kick the car sideways).
   */
  raycast(from: THREE.Vector3, to: THREE.Vector3, exclude?: RAPIER.RigidBody) {
    const d = to.clone().sub(from);
    const len = d.length();
    if (len < 1e-6) return null;
    d.divideScalar(len);
    const hit = this.world.castRayAndGetNormal(new RAPIER.Ray(from, d), len, true, undefined, GROUP_CAR, undefined, exclude);
    if (!hit) return null;
    return { toi: hit.timeOfImpact, normal: hit.normal, collider: hit.collider };
  }
}

export interface CarShape { boxSize: [number, number, number]; boxCentre: [number, number, number]; endLift: number; endLiftStart: number }

/** One car: core vehicle + Rapier body. Origin of the body = centre of gravity. */
export class CarBody {
  readonly body: RAPIER.RigidBody;
  out: Float64Array = new Float64Array(256);
  private state = new Float64Array(13);
  private contacts = new Float64Array(32);
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  readonly collider: RAPIER.Collider;
  private prevV = new THREE.Vector3();
  private prevF = new THREE.Vector3();
  private hasPrev = false;

  constructor(private pw: PhysicsWorld, readonly core: CoreCar, shape: CarShape, cgInModel: THREE.Vector3) {
    const { mass, inertia } = core.info;
    this.body = pw.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setAdditionalMassProperties(mass, { x: 0, y: 0, z: 0 }, { x: inertia[0], y: inertia[1], z: inertia[2] }, { x: 0, y: 0, z: 0, w: 1 })
        .setCcdEnabled(true)
        .setCanSleep(false),
    );
    // Convex hull: flat underside between +-endLiftStart, rising endLift to each bumper (see car visual json).
    const [sx, sy, sz] = shape.boxSize, [cx, cy, cz] = shape.boxCentre;
    const x = sx / 2, y0 = cy - sy / 2, y1 = cy + sy / 2, z = sz / 2, zs = shape.endLiftStart;
    const pts: number[] = [];
    for (const px of [-x, x]) {
      for (const [pz, py] of [[-z, y0 + shape.endLift], [-zs, y0], [zs, y0], [z, y0 + shape.endLift], [-z, y1], [z, y1]] as const) {
        pts.push(cx + px - cgInModel.x, py - cgInModel.y, cz + pz - cgInModel.z);
      }
    }
    const hull = RAPIER.ColliderDesc.convexHull(new Float32Array(pts))!.setDensity(0).setFriction(0.3).setRestitution(0.1)
      .setCollisionGroups(GROUP_CAR).setActiveEvents(RAPIER.ActiveEvents.NONE);
    this.collider = pw.world.createCollider(hull, this.body);
  }

  place(pos: THREE.Vector3, yaw: number, speed = 0) {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.body.setTranslation(pos, true);
    this.body.setRotation(q, true);
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q).multiplyScalar(speed);
    this.body.setLinvel(fwd, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    // gear: 2nd when launched rolling, else 1st (also clears a pedal-engaged reverse on respawn)
    this.core.resetMotion(speed, speed > 0 ? 3 : 2);
    this.hasPrev = false;
  }

  /** One physics tick: rays -> contacts -> core forces -> applied to the body (world steps after). */
  tick(raw: RawInput, assists: AssistToggles) {
    const t = this.body.translation(), r = this.body.rotation(), v = this.body.linvel(), w = this.body.angvel();
    const s = this.state;
    s[0] = t.x; s[1] = t.y; s[2] = t.z; s[3] = r.x; s[4] = r.y; s[5] = r.z; s[6] = r.w;
    s[7] = v.x; s[8] = v.y; s[9] = v.z; s[10] = w.x; s[11] = w.y; s[12] = w.z;
    const rays = this.core.rays(s);
    const c = this.contacts;
    for (let i = 0; i < 4; i++) {
      this.a.set(rays[6 * i], rays[6 * i + 1], rays[6 * i + 2]);
      this.b.set(rays[6 * i + 3], rays[6 * i + 4], rays[6 * i + 5]);
      const hit = this.pw.raycast(this.a, this.b, this.body);
      const o = 8 * i;
      if (!hit) { c[o] = 0; continue; }
      const dir = this.b.sub(this.a).normalize();
      c[o] = 1;
      c[o + 1] = this.a.x + dir.x * hit.toi; c[o + 2] = this.a.y + dir.y * hit.toi; c[o + 3] = this.a.z + dir.z * hit.toi;
      c[o + 4] = hit.normal.x; c[o + 5] = hit.normal.y; c[o + 6] = hit.normal.z;
      c[o + 7] = this.pw.surface(hit.collider);
    }
    this.feedCrash(v);
    const out = this.core.step(c, raw, assists, DT);
    this.body.resetForces(false);
    this.body.resetTorques(false);
    this.body.addForce({ x: out[OUT.force], y: out[OUT.force + 1], z: out[OUT.force + 2] }, true);
    this.body.addTorque({ x: out[OUT.torque], y: out[OUT.torque + 1], z: out[OUT.torque + 2] }, true);
    this.out = out;
    this.prevF.set(out[OUT.force], out[OUT.force + 1], out[OUT.force + 2]);
  }

  /**
   * Crash impulse from the car's own motion (same method as the Godot build): the velocity change
   * since last tick that the known forces (core output + gravity) do NOT explain was caused by
   * collisions:  J = m |v_now - (v_prev + (F_prev / m + g) dt)|. Rapier's contacts only say WHERE
   * and WITH WHAT. (Engine-reported contact impulses over-count crash energy: measured in Godot.)
   */
  private feedCrash(v: { x: number; y: number; z: number }) {
    const m = this.core.info.mass;
    const ex = this.prevV.x + (this.prevF.x / m) * DT;
    const ey = this.prevV.y + (this.prevF.y / m - 9.81) * DT;
    const ez = this.prevV.z + (this.prevF.z / m) * DT;
    const j = m * Math.hypot(v.x - ex, v.y - ey, v.z - ez);
    const first = !this.hasPrev;
    this.prevV.set(v.x, v.y, v.z);
    this.hasPrev = true;
    if (first || j < 150) return;   // the core ignores < 600 N s per event anyway; skip the query
    // Contact points after the step live in the manifold in each collider's LOCAL frame (the
    // solver-point list is empty by then). The car hull sits at the body origin, so body pose
    // maps them to world.
    let best: THREE.Vector3 | null = null, bestI = -1, other = 0;
    const w = this.pw.world;
    const t = this.body.translation(), r = this.body.rotation();
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    w.contactPairsWith(this.collider, (o) => {
      w.contactPair(this.collider, o, (man, flipped) => {
        for (let i = 0; i < man.numContacts(); i++) {
          if (man.contactDist(i) > 0.05) continue;   // predicted contact, not touching
          const imp = man.contactImpulse(i);
          if (imp < bestI) continue;
          const lp = flipped ? man.localContactPoint2(i) : man.localContactPoint1(i);
          if (!lp) continue;
          best = new THREE.Vector3(lp.x, lp.y, lp.z).applyQuaternion(q).add(t as THREE.Vector3);
          bestI = imp;
          other = o.handle + 1;
        }
      });
    });
    if (best) this.core.contact(best, j, other);
  }
}
