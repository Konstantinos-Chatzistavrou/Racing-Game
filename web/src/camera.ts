// Chase camera and a bumper camera.
//
// The spring acts on the camera's offset RELATIVE to the car, not on its world position: a world
// spring trails further behind the faster the car goes (~9 m at 144 km/h); a relative spring only
// reacts to ACCELERATION (the car pulls away under power, the camera closes in under braking) and
// to heading changes (the camera swings wide in corners and shows the car rotating).
//   r'' = k (r_target - r) - c r' - a_car
// a_car comes from the 240 Hz physics (low-passed there), not from per-frame differences, which
// jump whenever the number of physics ticks per frame changes.
// On top of the spring (ideas from Threejs-Punk Drive, docs/threejspunk_notes.md):
// - offset smoothing `o.lerp(target, 1 - exp(-SPRING_STRENGTH dt))` = the framerate-independent
//   form of `lerp(target, dt * k)`, applied to the car-RELATIVE offset (a world-space lerp would
//   trail with speed again). It mainly eases the camera back out after a wall pull-in, which used
//   to pop; pulling IN stays instant so the camera never clips into a wall.
// - FOV punch: +0..5 deg on throttle (weighted by forward acceleration), ~1 s in, slower out.
// - Redline shake: ROTATION only, 3-7 Hz smoothed noise, <= 0.15 deg, only within 3 % of the
//   redline. The old high-frequency shake aliased into judder at 30 fps; at <= 7 Hz a 30 fps
//   frame rate still samples each wobble 4+ times, so it reads as engine strain, not stutter.
import * as THREE from 'three/webgpu';
import { GROUP_VIEW, type PhysicsWorld } from './physics/world';
import type RAPIER from '@dimforge/rapier3d-compat';
import { OUT } from './physics/core';

const UP = new THREE.Vector3(0, 1, 0);
const OMEGA = 7.2;          // rad/s: spring natural frequency (tighter response so steering never feels rubbery)
const ZETA = 0.88;          // damping ratio
const MAX_LAG = 1.1;        // m: cap on how far the camera can stray from its rest offset
const DIST = 6.2, HEIGHT = 2.0, LOOK_AHEAD = 2.5, LOOK_HEIGHT = 0.9;
const SPRING_STRENGTH = 20; // 1/s: relative-offset smoothing
const PUNCH_DEG = 4, PUNCH_IN = 3, PUNCH_OUT = 2;   // FOV punch: max, attack/release rates
const FOV_EXTRA_MAX = 11;   // deg: cap on speed FOV + punch together (keeps high-speed frustum expansion reasonable)
const SHAKE_DEG = 0.15, SHAKE_BAND = 0.03;          // redline shake: max amplitude, rpm window below redline
const D2R = Math.PI / 180;

/** Smooth 1D value noise in [-1, 1]: random values at integer knots, smoothstep between them.
 *  Sampled at t * f it has its energy at and below ~f Hz (no high-frequency content). */
function vnoise(x: number, seed: number) {
  const h = (i: number) => { const s = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453; return (s - Math.floor(s)) * 2 - 1; };
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return h(i) + (h(i + 1) - h(i)) * u;
}

export class CameraRig {
  mode: 'chase' | 'bumper' = 'chase';
  private first = true;
  private heading = new THREE.Vector3(0, 0, 1);   // lagged ground-plane heading
  private r = new THREE.Vector3();                // camera offset from the car (world axes)
  private rv = new THREE.Vector3();
  private fov = 60;
  private o = new THREE.Vector3();                // smoothed relative offset (after wall pull-in)
  private fwd = new THREE.Vector3();
  private flat = new THREE.Vector3();
  private rTarget = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private want = new THREE.Vector3();
  private head = new THREE.Vector3();
  private bumperQ = new THREE.Quaternion().setFromAxisAngle(UP, Math.PI);
  private punch = 0;                              // deg
  private shake = 0;                              // 0..1 redline shake envelope
  private t = 0;

  constructor(readonly camera: THREE.PerspectiveCamera, private pw: PhysicsWorld, private car: RAPIER.RigidBody, private redline = 7000) {}

  /** A different car (garage swap): follow its body, snap to it. */
  setTarget(car: RAPIER.RigidBody, redline: number) { this.car = car; this.redline = redline; this.first = true; }
  snap() { this.first = true; }

  toggle() { this.mode = this.mode === 'chase' ? 'bumper' : 'chase'; this.first = true; }

  update(dt: number, carPos: THREE.Vector3, carQuat: THREE.Quaternion, carAcc: THREE.Vector3, out: Float64Array) {
    dt = Math.min(dt, 1 / 20);
    const cam = this.camera;
    const speed = out[OUT.speed];
    this.t += dt;
    const fwd = this.fwd.set(0, 0, 1).applyQuaternion(carQuat);

    // FOV punch: throttle, weighted by forward acceleration so it fades at top speed / on the limiter
    const aFwd = carAcc.dot(fwd);
    const punchTarget = PUNCH_DEG * Math.max(0, out[OUT.throttle]) * (0.35 + 0.65 * Math.min(1, Math.max(0, aFwd / 4)));
    this.punch += (punchTarget - this.punch) * (1 - Math.exp(-dt * (punchTarget > this.punch ? PUNCH_IN : PUNCH_OUT)));
    // redline shake envelope: eases in/out (~0.15 s) so a brief touch of the limiter is a nudge
    const onRedline = out[OUT.rpm] >= this.redline * (1 - SHAKE_BAND) ? 1 : 0;
    this.shake += (onRedline - this.shake) * (1 - Math.exp(-dt * 7));

    if (this.mode === 'bumper') {
      cam.position.copy(carPos).add(this.tmp.set(0, 0.62, 0.25).applyQuaternion(carQuat));
      cam.quaternion.copy(carQuat).multiply(this.bumperQ);
      this.applyShake(0.45);                   // subtler: the bumper view already moves with the body
      this.setFov(72, this.speedFov(speed) * 0.6, this.punch * 0.6, FOV_EXTRA_MAX * 0.6, dt);
      this.first = true;
      return;
    }

    // heading (lagged): a car on its nose/tail has no ground heading; keep the last
    const flat = this.flat.set(fwd.x, 0, fwd.z);
    if (flat.lengthSq() > 0.04) {
      flat.normalize();
      if (this.first) this.heading.copy(flat);
      else this.heading.lerp(flat, 1 - Math.exp(-dt * 10)).normalize();
    }
    const rTarget = this.rTarget.copy(this.heading).multiplyScalar(-DIST).addScaledVector(UP, HEIGHT);

    if (this.first) {
      this.r.copy(rTarget);
      this.rv.set(0, 0, 0);
    } else {
      // semi-implicit Euler in sub-steps of <= 1/120 s: stable at any frame rate
      const k = OMEGA * OMEGA, c = 2 * ZETA * OMEGA;
      const n = Math.max(1, Math.ceil(dt * 120)), h = dt / n;
      for (let i = 0; i < n; i++) {
        const f = this.tmp.copy(rTarget).sub(this.r).multiplyScalar(k).addScaledVector(this.rv, -c).sub(carAcc);
        this.rv.addScaledVector(f, h);
        this.r.addScaledVector(this.rv, h);
      }
      const err = this.tmp.copy(this.r).sub(rTarget);
      if (err.length() > MAX_LAG) this.r.copy(rTarget).add(err.setLength(MAX_LAG));
    }
    const want = this.want.copy(carPos).add(this.r);

    // keep the camera out of walls: pull it in along the car->camera line
    const head = this.head.copy(carPos).addScaledVector(UP, 1.0);
    const hit = this.pw.raycast(head, want, this.car, true, GROUP_VIEW);   // poles / trees don't yank the camera in
    let wall = Infinity;                         // max allowed distance from `head`
    if (hit) {
      const dist = head.distanceTo(want);
      const f = Math.max(0.15, Math.min(1, (hit.toi - 0.4) / dist));   // measure BEFORE moving want
      wall = f * dist;
      want.lerpVectors(head, want, f);
    }

    // relative-offset smoothing: o.lerp(target, 1 - exp(-k dt)); in towards a wall is instant
    const rel = want.sub(head);
    if (this.first) this.o.copy(rel);
    else this.o.lerp(rel, 1 - Math.exp(-dt * SPRING_STRENGTH));
    if (this.o.length() > wall) this.o.setLength(wall);

    cam.position.copy(head).add(this.o);
    cam.lookAt(this.tmp.copy(carPos).addScaledVector(this.heading, LOOK_AHEAD).addScaledVector(UP, LOOK_HEIGHT));
    this.applyShake(1);
    this.setFov(60, this.speedFov(speed), this.punch, FOV_EXTRA_MAX, dt);
    this.first = false;
  }

  /** Low-frequency rotational shake (never position): two octaves of value noise at 3.5 and
   *  6.5 Hz, independent per axis, scaled by the redline envelope. */
  private applyShake(gain: number) {
    const a = this.shake * gain * SHAKE_DEG * D2R;
    if (a < 1e-6) return;
    const n = (seed: number) => (vnoise(this.t * 3.5, seed) * 0.7 + vnoise(this.t * 6.5, seed + 9) * 0.3);
    this.camera.rotateX(n(1) * a);
    this.camera.rotateY(n(2) * a * 0.8);
    this.camera.rotateZ(n(3) * a * 0.6);
  }

  /** +0..10 degrees from 60 km/h up (sense of speed). */
  private speedFov(speed: number) { return Math.min(10, Math.max(0, Math.abs(speed) * 3.6 - 60) * 0.06); }

  /** base + speed FOV is eased here; `punch` arrives already eased (own attack/release). Speed
   *  FOV + punch together never exceed `cap` degrees above the mode's base. */
  private setFov(base: number, speedExtra: number, punch: number, cap: number, dt: number) {
    this.fov += (base + speedExtra - this.fov) * (1 - Math.exp(-dt * 3));
    const fov = Math.min(this.fov + punch, base + cap);
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
