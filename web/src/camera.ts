// Chase camera with physics ("GT camera") and a bumper camera.
//
// The spring acts on the camera's offset RELATIVE to the car, not on its world position: a world
// spring trails further behind the faster the car goes (~9 m at 144 km/h); a relative spring only
// reacts to ACCELERATION (the car pulls away under power, the camera surges in under braking) and
// to heading changes (the camera swings wide in corners and shows the car rotating).
//   r'' = k (r_target - r) - c r' - a_car        (a_car: the car's own acceleration, low-passed)
// Shake: suspension jolts (kerbs, landings, crashes: from the core's suspension compression rate)
// plus a fine buzz near the redline. Applied as small camera rotations, never to the position.
import * as THREE from 'three/webgpu';
import type { PhysicsWorld } from './physics/world';
import type RAPIER from '@dimforge/rapier3d-compat';
import { OUT } from './physics/core';

const UP = new THREE.Vector3(0, 1, 0);
const OMEGA = 5.0;          // rad/s: spring natural frequency (lower = lazier camera)
const ZETA = 0.75;          // damping ratio (< 1: a slight overshoot when the car stops)
const MAX_LAG = 1.6;        // m: cap on how far the camera can stray from its rest offset
const DIST = 6.2, HEIGHT = 2.0, LOOK_AHEAD = 2.5, LOOK_HEIGHT = 0.9;

export class CameraRig {
  mode: 'chase' | 'bumper' = 'chase';
  private first = true;
  private heading = new THREE.Vector3(0, 0, 1);   // lagged ground-plane heading
  private r = new THREE.Vector3();                // camera offset from the car (world axes)
  private rv = new THREE.Vector3();
  private acc = new THREE.Vector3();              // car acceleration, low-passed
  private prevVel = new THREE.Vector3();
  private prevComp = [0, 0, 0, 0];
  private jolt = 0;                               // shake energy from suspension hits
  private fov = 60;
  private t = 0;
  shakeScale = 1;

  constructor(readonly camera: THREE.PerspectiveCamera, private pw: PhysicsWorld, private car: RAPIER.RigidBody) {}

  toggle() { this.mode = this.mode === 'chase' ? 'bumper' : 'chase'; this.first = true; }

  update(dt: number, carPos: THREE.Vector3, carQuat: THREE.Quaternion, carVel: THREE.Vector3, out: Float64Array, redline: number) {
    dt = Math.min(dt, 1 / 20);
    this.t += dt;
    const cam = this.camera;
    const speed = out[OUT.speed];

    // ---- shake sources
    let comp = 0;
    for (let i = 0; i < 4; i++) {
      const c = out[OUT.wheel(i) + 9];
      comp += Math.abs(c - this.prevComp[i]);
      this.prevComp[i] = c;
    }
    if (!this.first) this.jolt = Math.min(1, this.jolt + Math.max(0, comp / dt - 0.35) * 0.06);   // ignore normal body motion
    this.jolt *= Math.exp(-dt * 6);
    const rev = THREE.MathUtils.smoothstep(out[OUT.rpm] / redline, 0.86, 1.0);

    if (this.mode === 'bumper') {
      cam.position.copy(carPos).add(new THREE.Vector3(0, 0.62, 0.25).applyQuaternion(carQuat));
      cam.quaternion.copy(carQuat).multiply(new THREE.Quaternion().setFromAxisAngle(UP, Math.PI));
      this.applyShake(this.jolt * 0.01 + rev * 0.0015);
      this.setFov(72 + this.speedFov(speed) * 0.6, dt);
      this.first = true;
      return;
    }

    // ---- heading (lagged): a car on its nose/tail has no ground heading; keep the last
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(carQuat);
    const flat = new THREE.Vector3(fwd.x, 0, fwd.z);
    if (flat.lengthSq() > 0.04) {
      flat.normalize();
      if (this.first) this.heading.copy(flat);
      else this.heading.lerp(flat, 1 - Math.exp(-dt * 6)).normalize();
    }
    const rTarget = this.heading.clone().multiplyScalar(-DIST).addScaledVector(UP, HEIGHT);

    // ---- relative spring-damper, driven by the car's acceleration
    if (this.first) {
      this.r.copy(rTarget);
      this.rv.set(0, 0, 0);
      this.acc.set(0, 0, 0);
      this.prevVel.copy(carVel);
    } else {
      const a = carVel.clone().sub(this.prevVel).divideScalar(dt);
      this.prevVel.copy(carVel);
      if (a.length() > 60) a.setLength(60);                     // crashes: let the shake carry it
      this.acc.lerp(a, 1 - Math.exp(-dt * 8));                  // physics-tick noise off
      const k = OMEGA * OMEGA, c = 2 * ZETA * OMEGA;
      const f = rTarget.clone().sub(this.r).multiplyScalar(k).addScaledVector(this.rv, -c).sub(this.acc);
      this.rv.addScaledVector(f, dt);
      this.r.addScaledVector(this.rv, dt);
      const err = this.r.clone().sub(rTarget);
      if (err.length() > MAX_LAG) this.r.copy(rTarget).add(err.setLength(MAX_LAG));
    }
    const want = carPos.clone().add(this.r);

    // ---- keep the camera out of walls: pull it in along the car->camera line
    const head = carPos.clone().addScaledVector(UP, 1.0);
    const hit = this.pw.raycast(head, want, this.car);
    if (hit) {
      const f = Math.max(0.15, Math.min(1, (hit.toi - 0.4) / head.distanceTo(want)));   // measure BEFORE moving want
      want.lerpVectors(head, want, f);
    }

    cam.position.copy(want);
    cam.lookAt(carPos.clone().addScaledVector(this.heading, LOOK_AHEAD).addScaledVector(UP, LOOK_HEIGHT));
    this.applyShake(this.jolt * 0.018 + rev * 0.0022 + Math.min(1, Math.abs(speed) / 70) * 0.0006);
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

  /** Smooth pseudo-random rotation (sum of incommensurate sines), amplitude in radians. */
  private applyShake(amp: number) {
    amp *= this.shakeScale;
    if (amp < 1e-5) return;
    const t = this.t;
    const x = Math.sin(t * 37.1) * 0.6 + Math.sin(t * 61.7 + 1.3) * 0.4;
    const y = Math.sin(t * 43.3 + 2.1) * 0.6 + Math.sin(t * 71.9 + 0.4) * 0.4;
    const z = Math.sin(t * 29.3 + 4.2);
    this.camera.rotateX(x * amp);
    this.camera.rotateY(y * amp);
    this.camera.rotateZ(z * amp * 0.5);
  }
}
