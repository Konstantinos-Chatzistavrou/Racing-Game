// Other players' cars (party.ts carries the data), solid: each one is a kinematic Rapier body with the same hull as
// ours, moved every physics tick to where that player is predicted to be. Every client resolves contacts against the
// others' bodies, so both sides of a hit feel it. A kinematic body is infinitely heavy, so in a contact we keep only
// half of our car's velocity change (main.ts, halveRemoteHits): half the momentum each way, as two equal cars.
//
// Where a remote car is: NOW, not where it was. A pose is ~50 ms old when it lands, so the car (body and drawing) is
// predicted forward from its last pose with the velocity it sent (up to 300 ms; heartbeats of a parked car carry no
// velocity). A new pose that disagrees with the prediction doesn't snap: the difference fades out over ~120 ms
// (teleports beyond 15 m do snap). Rotation eases to the newest pose. Each car carries a name tag.
//
// Our pose goes out at up to 20 Hz when it changed meaningfully, plus a 1 s heartbeat.
import * as THREE from 'three/webgpu';
import RAPIER from '@dimforge/rapier3d-compat';
import { setupCarMaterials, type CarVisual } from './scene/car';
import { assetUrl, loadGLTF } from './scene/loaders';
import { GROUP_CAR, carHull, type CarShape, type PhysicsWorld } from './physics/world';
import type { Pose } from './party';
import { drawEarly } from './scene/nyc/breach';

const SEND_HZ = 20;
const HEARTBEAT_MS = 1000;      // resend an unchanged pose this often (keeps the newcomer view fresh)
const LATENCY_S = 0.05;         // assumed one-way delay: a pose describes the car this long ago
const MAX_PREDICT_S = 0.3;      // never extrapolate further than this past the newest pose
const BLEND_S = 0.12;           // a correction fades out with this time constant
const SNAP_M = 15;              // a jump this big is a reset: no blending
const MOVED_M = 0.02, TURNED = 0.005;   // "changed meaningfully": 2 cm or ~0.6 deg
const TAG_RANGE = 180;          // name tags beyond this many metres are hidden

interface Remote {
  root: THREE.Group;
  body: RAPIER.RigidBody | null;
  tag: HTMLDivElement | null;
  /** newest pose: received at t (ms), position, velocity, rotation */
  t: number; p: THREE.Vector3; v: THREE.Vector3; q: THREE.Quaternion;
  /** correction still being faded out (added to the prediction), set at time tOff */
  off: THREE.Vector3; tOff: number;
  /** drawn / simulated rotation (eases to q) */
  qNow: THREE.Quaternion;
  seen: boolean;
  /** touching our car: prediction doesn't run past tHold (ms) until holdUntil (only real poses move it on) */
  tHold: number; holdUntil: number;
}

export class RemoteCars {
  private remotes = new Map<string, Remote>();
  private proto: THREE.Object3D;          // car model as loaded (rest wheels, no lights, no damage)
  private lastSend = 0;
  private sentPos = new THREE.Vector3(Infinity, 0, 0);
  private sentQuat = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private w = new THREE.Vector3();
  private tags = document.getElementById('tags');
  /** names by player id (from the party lobby) */
  names = new Map<string, string>();

  constructor(private scene: THREE.Scene, private visual: CarVisual, private pw: PhysicsWorld, private shape: CarShape) {
    this.proto = visual.model.clone(true);
    this.proto.traverse((o) => { if ((o as THREE.Light).isLight) o.visible = false; });
    // Remote cars use the light traffic model (~28k triangles, shared with the AI cars) once it is
    // in; until then (or if it fails) a copy of the player's model. Same CG offset as the player's.
    if (visual.cfg.lod_model) {
      loadGLTF(assetUrl(visual.cfg.lod_model)).then((g) => {
        const p = g.scene.clone(true);
        p.position.copy(visual.cg).negate();
        this.proto = p;
      }).catch(() => {});
    }
  }

  get count() { return this.remotes.size; }
  ids() { return [...this.remotes.keys()].filter((id) => id !== 'warm'); }
  /** For the spectator camera: a remote car's body and drawn pose. */
  get(id: string) { const r = this.remotes.get(id); return r ? { body: r.body, root: r.root } : null; }

  /** Our pose to send now (null: nothing new). pos/quat = drawn body pose, vel = body velocity. */
  outgoing(now: number, pos: THREE.Vector3, quat: THREE.Quaternion, vel: { x: number; y: number; z: number }): Pose | null {
    if (now - this.lastSend < 1000 / SEND_HZ) return null;
    const moved = pos.distanceTo(this.sentPos) > MOVED_M || quat.angleTo(this.sentQuat) > TURNED;
    if (!moved && now - this.lastSend < HEARTBEAT_MS) return null;
    this.sentPos.copy(pos);
    this.sentQuat.copy(quat);
    this.lastSend = now;
    const r2 = (v: number) => Math.round(v * 100) / 100, r3 = (v: number) => Math.round(v * 1000) / 1000, r4 = (v: number) => Math.round(v * 10000) / 10000;
    return { x: r3(pos.x), y: r3(pos.y), z: r3(pos.z), qx: r4(quat.x), qy: r4(quat.y), qz: r4(quat.z), qw: r4(quat.w), vx: r2(vel.x), vy: r2(vel.y), vz: r2(vel.z) };
  }
  /** Send our pose at the next update (after a respawn). */
  kick() { this.sentPos.set(Infinity, 0, 0); this.lastSend = 0; }

  /** Predicted position at time now (ms) into out. */
  private predict(r: Remote, now: number, out: THREE.Vector3) {
    // in contact with us: extrapolating on would drive their car on into ours (a pose is ~50-100 ms behind what they
    // do; they may have stopped against us already), so the clock stops at the moment of contact
    if (now < r.holdUntil) now = Math.min(now, r.tHold);
    const age = Math.min(MAX_PREDICT_S, Math.max(0, (now - r.t) / 1000 + LATENCY_S));
    out.copy(r.p).addScaledVector(r.v, age);
    const fade = Math.exp(-Math.max(0, now - r.tOff) / 1000 / BLEND_S);
    if (fade > 0.002) out.addScaledVector(r.off, fade);
    return out;
  }

  receive(id: string, s: Pose, paint?: number) {
    const now = performance.now();
    let r = this.remotes.get(id);
    if (!r) {
      r = { root: this.makeCar(id, Number.isInteger(paint) ? paint : undefined), body: this.makeBody(), tag: this.makeTag(id),
        t: now, p: new THREE.Vector3(), v: new THREE.Vector3(), q: new THREE.Quaternion(), off: new THREE.Vector3(), tOff: now, qNow: new THREE.Quaternion(), seen: false, tHold: 0, holdUntil: 0 };
      this.remotes.set(id, r);
      this.scene.add(r.root);
    }
    const before = r.seen ? this.predict(r, now, this.w) : null;
    if (now < r.holdUntil) r.tHold = Math.max(r.tHold, now);   // a fresh pose: the held clock may move up to it
    r.t = now;
    r.p.set(s.x, s.y, s.z);
    r.v.set(s.vx ?? 0, s.vy ?? 0, s.vz ?? 0);
    r.q.set(s.qx, s.qy, s.qz, s.qw).normalize();
    r.off.set(0, 0, 0); r.tOff = now;
    if (before) {
      const after = this.predict(r, now, this.v);
      if (before.distanceTo(after) < SNAP_M) r.off.subVectors(before, after);   // fade the disagreement out instead of jumping
    }
    if (!r.seen) {
      r.qNow.copy(r.q);
      this.predict(r, now, this.v);
      r.body?.setTranslation(this.v, true); r.body?.setRotation(r.qNow, true);
    }
    r.seen = true;
  }

  remove(id: string) {
    const r = this.remotes.get(id);
    if (!r) return;
    r.root.removeFromParent();
    r.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.userData.netPaint) (m.material as THREE.Material).dispose();
    });
    if (r.body) {
      for (let i = 0; i < r.body.numColliders(); i++) this.colliders.delete(r.body.collider(i));
      this.pw.world.removeRigidBody(r.body);
    }
    r.tag?.remove();
    this.remotes.delete(id);
  }

  clear() { for (const id of [...this.remotes.keys()]) this.remove(id); }

  /** Put a tinted car at our car (true) for the startup shader compile, then take it away (false). */
  warmup(on: boolean) {
    if (on) {
      const now = performance.now();
      const r: Remote = { root: this.makeCar('warm'), body: null, tag: null, t: now, p: new THREE.Vector3(), v: new THREE.Vector3(), q: new THREE.Quaternion(),
        off: new THREE.Vector3(), tOff: now, qNow: new THREE.Quaternion(), seen: false, tHold: 0, holdUntil: 0 };
      this.remotes.set('warm', r);
      r.root.position.copy(this.visual.root.position);
      this.scene.add(r.root);
    } else this.remove('warm');
  }

  /** Same hull as ours, kinematic: moved every physics tick to the predicted pose (Rapier derives its velocity from the move). */
  private makeBody() {
    const body = this.pw.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
    const collider = this.pw.world.createCollider(carHull(this.shape, this.visual.cg).setFriction(0.3).setRestitution(0.05).setCollisionGroups(GROUP_CAR), body);
    this.colliders.add(collider);
    return body;
  }
  /** Colliders of the other players' cars (contact checks). */
  readonly colliders = new Set<RAPIER.Collider>();

  /** Our car touched this collider (at time now, ms): hold that car's prediction for a moment (see predict()). */
  touched(c: RAPIER.Collider, now: number) {
    for (const r of this.remotes.values()) {
      if (r.body !== c.parent()) continue;
      if (now >= r.holdUntil) r.tHold = now;
      r.holdUntil = now + 250;
    }
  }

  private makeTag(id: string) {
    if (!this.tags) return null;
    const el = document.createElement('div');
    el.className = 'tag';
    el.textContent = this.names.get(id) ?? 'Driver';
    this.tags.append(el);
    return el;
  }
  /** Names changed (lobby update). */
  refreshTags() {
    for (const [id, r] of this.remotes) if (r.tag) r.tag.textContent = this.names.get(id) ?? 'Driver';
  }

  /** A copy of the loaded car with its own paint colour (geometry and other materials shared). */
  private makeCar(id: string, rgb?: number) {
    const root = new THREE.Group();
    root.name = `player_${id}`;
    const model = this.proto.clone(true);
    let h = 0;
    for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const paint = rgb !== undefined && rgb >= 0 && rgb <= 0xffffff ? new THREE.Color(rgb) : new THREE.Color().setHSL((h % 1000) / 1000, 0.75, 0.45, THREE.SRGBColorSpace);
    // own clone of the clear-coat paint in that colour (setupCarMaterials), flagged for dispose()
    const paintMat = setupCarMaterials(model, this.visual.cfg, paint, false);
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && paintMat && (Array.isArray(m.material) ? m.material.includes(paintMat) : m.material === paintMat)) m.userData.netPaint = true;
    });
    root.add(model);
    drawEarly(model);
    return root;
  }

  /** One physics tick (before world.step()) at time now (ms): bodies to their predicted poses at the end of the tick. */
  tick(now: number, dt: number) {
    const k = 1 - Math.exp(-dt * 15);
    for (const r of this.remotes.values()) {
      if (!r.body || !r.seen) continue;
      r.qNow.slerp(r.q, k);
      r.body.setNextKinematicTranslation(this.predict(r, now + dt * 1000, this.v));
      r.body.setNextKinematicRotation(r.qNow);
    }
  }

  /** Per frame: draw the remote cars at their predicted poses, move their name tags. */
  update(now: number, camera: THREE.Camera) {
    const w = innerWidth, h = innerHeight;
    for (const r of this.remotes.values()) {
      if (!r.seen) continue;
      const root = r.root;
      this.predict(r, now, root.position);
      root.quaternion.copy(r.qNow);
      if (r.tag) {
        const d = root.position.distanceTo(camera.position);
        this.v.copy(root.position).setY(root.position.y + 1.6).project(camera);
        const show = d < TAG_RANGE && this.v.z < 1 && Math.abs(this.v.x) < 1.1 && Math.abs(this.v.y) < 1.1;
        r.tag.style.display = show ? '' : 'none';
        if (show) r.tag.style.transform = `translate(${((this.v.x + 1) / 2) * w}px, ${((1 - this.v.y) / 2) * h}px) translate(-50%, -100%)`;
      }
    }
  }
}
