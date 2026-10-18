// Chase camera and a bumper camera.
//
// The spring acts on the camera's offset RELATIVE to the car, not on its world position: a world
// spring trails further behind the faster the car goes (~9 m at 144 km/h); a relative spring only
// reacts to ACCELERATION (the car pulls away under power, the camera closes in under braking) and
// to heading changes (the camera swings wide in corners and shows the car rotating).
//   r'' = k (r_target - r) - c r' - a_car
// a_car comes from the 240 Hz physics (low-passed there), not from per-frame differences, which
// jump whenever the number of physics ticks per frame changes. No camera shake: at 30 fps its
// high-frequency motion aliases into judder.
import * as THREE from 'three/webgpu';
import type { PhysicsWorld } from './physics/world';
import type RAPIER from '@dimforge/rapier3d-compat';
import { OUT } from './physics/core';

const UP = new THREE.Vector3(0, 1, 0);
const OMEGA = 5.0;          // rad/s: spring natural frequency (lower = lazier camera)
const ZETA = 0.85;          // damping ratio
const MAX_LAG = 1.4;        // m: cap on how far the camera can stray from its rest offset
const DIST = 6.2, HEIGHT = 2.0, LOOK_AHEAD = 2.5, LOOK_HEIGHT = 0.9;

export class CameraRig {
  mode: 'chase' | 'bumper' = 'chase';
  private first = true;
  private heading = new THREE.Vector3(0, 0, 1);   // lagged ground-plane heading
  private r = new THREE.Vector3();                // camera offset from the car (world axes)
  private rv = new THREE.Vector3();
  private fov = 60;

  constructor(readonly camera: THREE.PerspectiveCamera, private pw: PhysicsWorld, private car: RAPIER.RigidBody) {}

  toggle() { this.mode = this.mode === 'chase' ? 'bumper' : 'chase'; this.first = true; }

  update(dt: number, carPos: THREE.Vector3, carQuat: THREE.Quaternion, carAcc: THREE.Vector3, out: Float64Array) {
    dt = Math.min(dt, 1 / 20);
    const cam = this.camera;
    const speed = out[OUT.speed];

    if (this.mode === 'bumper') {
      cam.position.copy(carPos).add(new THREE.Vector3(0, 0.62, 0.25).applyQuaternion(carQuat));
      cam.quaternion.copy(carQuat).multiply(new THREE.Quaternion().setFromAxisAngle(UP, Math.PI));
      this.setFov(72 + this.speedFov(speed) * 0.6, dt);
      this.first = true;
      return;
    }

    // heading (lagged): a car on its nose/tail has no ground heading; keep the last
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(carQuat);
    const flat = new THREE.Vector3(fwd.x, 0, fwd.z);
    if (flat.lengthSq() > 0.04) {
      flat.normalize();
      if (this.first) this.heading.copy(flat);
      else this.heading.lerp(flat, 1 - Math.exp(-dt * 6)).normalize();
    }
    const rTarget = this.heading.clone().multiplyScalar(-DIST).addScaledVector(UP, HEIGHT);

    if (this.first) {
      this.r.copy(rTarget);
      this.rv.set(0, 0, 0);
    } else {
      // semi-implicit Euler in sub-steps of <= 1/120 s: stable at any frame rate
      const k = OMEGA * OMEGA, c = 2 * ZETA * OMEGA;
      const n = Math.max(1, Math.ceil(dt * 120)), h = dt / n;
      for (let i = 0; i < n; i++) {
        const f = rTarget.clone().sub(this.r).multiplyScalar(k).addScaledVector(this.rv, -c).sub(carAcc);
        this.rv.addScaledVector(f, h);
        this.r.addScaledVector(this.rv, h);
      }
      const err = this.r.clone().sub(rTarget);
      if (err.length() > MAX_LAG) this.r.copy(rTarget).add(err.setLength(MAX_LAG));
    }
    const want = carPos.clone().add(this.r);

    // keep the camera out of walls: pull it in along the car->camera line
    const head = carPos.clone().addScaledVector(UP, 1.0);
    const hit = this.pw.raycast(head, want, this.car);
    if (hit) {
      const f = Math.max(0.15, Math.min(1, (hit.toi - 0.4) / head.distanceTo(want)));   // measure BEFORE moving want
      want.lerpVectors(head, want, f);
    }

    cam.position.copy(want);
    cam.lookAt(carPos.clone().addScaledVector(this.heading, LOOK_AHEAD).addScaledVector(UP, LOOK_HEIGHT));
    this.setFov(60 + this.speedFov(speed), dt);
    this.first = false;
  }

  /** +0..14 degrees from 60 km/h up (sense of speed). */
  private speedFov(speed: number) { return Math.min(14, Math.max(0, Math.abs(speed) * 3.6 - 60) * 0.075); }

  private setFov(target: number, dt: number) {
    this.fov += (target - this.fov) * (1 - Math.exp(-dt * 3));
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
