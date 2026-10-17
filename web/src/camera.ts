// Chase camera (same feel numbers as game/scripts/camera_rig.gd) and a bumper camera.
import * as THREE from 'three/webgpu';
import type { PhysicsWorld } from './physics/world';
import type RAPIER from '@dimforge/rapier3d-compat';

export class CameraRig {
  mode: 'chase' | 'bumper' = 'chase';
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private first = true;
  private lastFlat = new THREE.Vector3(0, 0, 1);

  constructor(readonly camera: THREE.PerspectiveCamera, private pw: PhysicsWorld, private car: RAPIER.RigidBody) {}

  toggle() { this.mode = this.mode === 'chase' ? 'bumper' : 'chase'; this.first = true; }

  update(dt: number, carPos: THREE.Vector3, carQuat: THREE.Quaternion, speed: number) {
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(carQuat);
    const cam = this.camera;
    if (this.mode === 'bumper') {
      cam.position.copy(carPos).add(new THREE.Vector3(0, 0.62, 0.25).applyQuaternion(carQuat));
      cam.quaternion.copy(carQuat).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
      cam.fov = 72;
      cam.updateProjectionMatrix();
      return;
    }
    // Heading on the ground plane. A car on its nose/tail (after a crash) has none: keep the last.
    const flat = new THREE.Vector3(fwd.x, 0, fwd.z);
    if (flat.lengthSq() > 0.04) this.lastFlat.copy(flat.normalize()); else flat.copy(this.lastFlat);
    const want = carPos.clone().addScaledVector(flat, -6.4).add(new THREE.Vector3(0, 2.1, 0));
    // Keep the camera out of walls: pull it in along the car->camera line.
    const head = carPos.clone().add(new THREE.Vector3(0, 1.0, 0));
    const hit = this.pw.raycast(head, want, this.car);
    if (hit) {
      const f = Math.max(0.15, Math.min(1, (hit.toi - 0.4) / head.distanceTo(want)));   // measure BEFORE moving want
      want.lerpVectors(head, want, f);
    }
    // Follow stiffly along the car's travel (no lag-induced zoom-out at speed), softly sideways/up.
    const k = this.first ? 1 : 1 - Math.exp(-dt * 7);
    const along = this.first ? 1 : 1 - Math.exp(-dt * 25);
    const err = want.clone().sub(this.pos);
    const e1 = flat.clone().multiplyScalar(err.dot(flat));
    this.pos.add(e1.multiplyScalar(along)).add(err.sub(flat.clone().multiplyScalar(err.dot(flat))).multiplyScalar(k));
    this.look.lerp(carPos.clone().addScaledVector(flat, 2.5).add(new THREE.Vector3(0, 0.9, 0)), this.first ? 1 : 1 - Math.exp(-dt * 12));
    this.first = false;
    cam.position.copy(this.pos);
    cam.lookAt(this.look);
    cam.fov = 62 + Math.min(14, Math.max(0, speed * 3.6 - 60) * 0.06);   // widen with speed
    cam.updateProjectionMatrix();
  }
}
