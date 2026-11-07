// Other players' cars (party.ts carries the data). Our pose goes out at up to 20 Hz when it changed
// meaningfully, plus a 1 s heartbeat. Remote cars are drawn ~100 ms in the past, interpolated between
// the network frames around that time (lerp position, slerp rotation), briefly extrapolated when a
// frame is late, snapped on teleports. Each carries a name tag.
import * as THREE from 'three/webgpu';
import { setupCarMaterials, type CarVisual } from './scene/car';
import { assetUrl, loadGLTF } from './scene/loaders';
import type { Pose } from './party';

const SEND_HZ = 20;
const HEARTBEAT_MS = 1000;      // resend an unchanged pose this often (keeps the newcomer view and timelines fresh)
const DELAY_MS = 100;           // remote render delay
const EXTRAPOLATE_MS = 200;     // max time to run past the newest frame
const SNAP_M = 15;              // a jump this big between frames is a reset: no interpolation
const MOVED_M = 0.02, TURNED = 0.005;   // "changed meaningfully": 2 cm or ~0.6 deg
const TAG_RANGE = 180;          // name tags beyond this many metres are hidden

interface Frame { t: number; p: THREE.Vector3; q: THREE.Quaternion }
interface Remote { root: THREE.Group; frames: Frame[]; paint?: number; tag: HTMLDivElement | null }

export class RemoteCars {
  private remotes = new Map<string, Remote>();
  private proto: THREE.Object3D;          // car model as loaded (rest wheels, no lights, no damage)
  private lastSend = 0;
  private sentPos = new THREE.Vector3(Infinity, 0, 0);
  private sentQuat = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private tags = document.getElementById('tags');
  /** names by player id (from the party lobby) */
  names = new Map<string, string>();

  constructor(private scene: THREE.Scene, private visual: CarVisual) {
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

  /** Our pose to send now (null: nothing new). pos/quat = drawn body pose. */
  outgoing(now: number, pos: THREE.Vector3, quat: THREE.Quaternion): Pose | null {
    if (now - this.lastSend < 1000 / SEND_HZ) return null;
    const moved = pos.distanceTo(this.sentPos) > MOVED_M || quat.angleTo(this.sentQuat) > TURNED;
    if (!moved && now - this.lastSend < HEARTBEAT_MS) return null;
    this.sentPos.copy(pos);
    this.sentQuat.copy(quat);
    this.lastSend = now;
    const r3 = (v: number) => Math.round(v * 1000) / 1000, r4 = (v: number) => Math.round(v * 10000) / 10000;
    return { x: r3(pos.x), y: r3(pos.y), z: r3(pos.z), qx: r4(quat.x), qy: r4(quat.y), qz: r4(quat.z), qw: r4(quat.w) };
  }
  /** Send our pose at the next update (after a respawn). */
  kick() { this.sentPos.set(Infinity, 0, 0); this.lastSend = 0; }

  receive(id: string, s: Pose, paint?: number) {
    let r = this.remotes.get(id);
    if (!r) {
      r = { root: this.makeCar(id, Number.isInteger(paint) ? paint : undefined), frames: [], paint, tag: this.makeTag(id) };
      this.remotes.set(id, r);
      this.scene.add(r.root);
    }
    const now = performance.now();
    const f: Frame = { t: now, p: new THREE.Vector3(s.x, s.y, s.z), q: new THREE.Quaternion(s.qx, s.qy, s.qz, s.qw).normalize() };
    const last = r.frames[r.frames.length - 1];
    if (!last || last.p.distanceTo(f.p) > SNAP_M) r.frames = [];      // first frame or teleport: snap
    else if (now - last.t > 250) {
      // after a pause (parked car only heartbeats) restart the timeline one send interval back,
      // otherwise the car would creep across the whole gap
      r.frames = [{ t: now - 1000 / SEND_HZ, p: last.p.clone(), q: last.q.clone() }];
    }
    r.frames.push(f);
    if (r.frames.length > 8) r.frames.shift();
  }

  remove(id: string) {
    const r = this.remotes.get(id);
    if (!r) return;
    r.root.removeFromParent();
    r.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.userData.netPaint) (m.material as THREE.Material).dispose();
    });
    r.tag?.remove();
    this.remotes.delete(id);
  }

  clear() { for (const id of [...this.remotes.keys()]) this.remove(id); }

  /** Put a tinted car at our car (true) for the startup shader compile, then take it away (false). */
  warmup(on: boolean) {
    if (on) {
      const r: Remote = { root: this.makeCar('warm'), frames: [], tag: null };
      this.remotes.set('warm', r);
      r.root.position.copy(this.visual.root.position);
      this.scene.add(r.root);
    } else this.remove('warm');
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
    return root;
  }

  /** Per frame: move the remote cars and their name tags. */
  update(now: number, camera: THREE.Camera) {
    const t = now - DELAY_MS;
    const w = innerWidth, h = innerHeight;
    for (const r of this.remotes.values()) {
      const fr = r.frames, n = fr.length;
      if (!n) continue;
      const root = r.root;
      if (n === 1) {
        root.position.copy(fr[0].p);
        root.quaternion.copy(fr[0].q);
      } else {
        let i = n - 2;
        while (i > 0 && fr[i].t > t) i--;        // frames [i, i+1] bracket t (or i = n-2: extrapolate)
        const a = fr[i], b = fr[i + 1];
        const span = Math.max(1, b.t - a.t);
        let k = (t - a.t) / span;
        k = Math.max(0, Math.min(k, 1 + EXTRAPOLATE_MS / span));   // > 1: late frame, keep going briefly
        root.position.copy(this.v.lerpVectors(a.p, b.p, k));
        if (k <= 1) root.quaternion.slerpQuaternions(a.q, b.q, k);
        else root.quaternion.copy(b.q);
      }
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
