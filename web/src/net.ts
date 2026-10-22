// Minimal multiplayer: send our car pose to the relay in server/, draw the other players' cars.
// Off unless the URL asks for it: ?mp=ws://host:port (or wss://), ?mp=1 -> <page host>:8787.
// Remote cars are drawn ~100 ms in the past, interpolated between the network frames around that
// time (lerp position, slerp rotation), briefly extrapolated when a frame is late, snapped on teleports.
import * as THREE from 'three/webgpu';
import { setupCarMaterials, type CarVisual } from './scene/car';
import { assetUrl, loadGLTF } from './scene/loaders';

const SEND_HZ = 20;
const HEARTBEAT_MS = 1000;      // resend an unchanged pose this often (keeps the newcomer view and timelines fresh)
const DELAY_MS = 100;           // remote render delay
const EXTRAPOLATE_MS = 200;     // max time to run past the newest frame
const SNAP_M = 15;              // a jump this big between frames is a reset: no interpolation
const MOVED_M = 0.02, TURNED = 0.005;   // "changed meaningfully": 2 cm or ~0.6 deg

interface Frame { t: number; p: THREE.Vector3; q: THREE.Quaternion }
interface Remote { root: THREE.Group; frames: Frame[] }
type Pose = { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number };

/** Relay URL from the page URL, or null for single-player. */
export function netUrl(params: URLSearchParams): string | null {
  const mp = params.get('mp');
  if (!mp || mp === '0') return null;
  if (/^wss?:\/\//.test(mp)) return mp;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:8787`;
}

const finite = (m: Record<string, unknown>, ...k: string[]) => k.every((key) => typeof m[key] === 'number' && Number.isFinite(m[key]));

export class Net {
  private ws: WebSocket | null = null;
  private remotes = new Map<number, Remote>();
  private proto: THREE.Object3D;          // car model as loaded (rest wheels, no lights, no damage)
  private lastSend = 0;
  private sentPos = new THREE.Vector3(Infinity, 0, 0);
  private sentQuat = new THREE.Quaternion();
  private retry = 1000;
  private v = new THREE.Vector3();
  id = 0;
  connected = false;
  onChange = () => {};

  constructor(private url: string, private scene: THREE.Scene, private visual: CarVisual) {
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
    this.connect();
  }

  /** HUD text: connection state and player count (us included). */
  get status() {
    return this.connected ? `online · ${this.remotes.size + 1} player${this.remotes.size ? 's' : ''}` : 'offline';
  }

  private connect() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => { this.retry = 1000; };
    ws.onmessage = (e) => {
      let m: Record<string, unknown>;
      try { m = JSON.parse(e.data as string); } catch { return; }
      if (!m || typeof m !== 'object') return;
      if (m.type === 'welcome' && typeof m.id === 'number') {
        this.id = m.id;
        this.connected = true;
        this.sentPos.set(Infinity, 0, 0);   // send our pose right away
        for (const p of Array.isArray(m.players) ? m.players : []) this.receive(p);
        this.onChange();
      } else if (m.type === 'state') this.receive(m);
      else if (m.type === 'leave' && typeof m.id === 'number') this.remove(m.id);
    };
    ws.onclose = () => {
      const was = this.connected;
      this.connected = false;
      this.ws = null;
      for (const id of [...this.remotes.keys()]) this.remove(id, false);
      if (was) this.onChange();
      setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(10000, this.retry * 2);
    };
  }

  private receive(m: Record<string, unknown>) {
    if (typeof m.id !== 'number' || m.id === this.id || !finite(m, 'x', 'y', 'z', 'qx', 'qy', 'qz', 'qw')) return;
    const s = m as unknown as Pose & { id: number };
    let r = this.remotes.get(s.id);
    if (!r) {
      r = { root: this.makeCar(s.id), frames: [] };
      this.remotes.set(s.id, r);
      this.scene.add(r.root);
      this.onChange();
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

  private remove(id: number, notify = true) {
    const r = this.remotes.get(id);
    if (!r) return;
    r.root.removeFromParent();
    r.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.userData.netPaint) (m.material as THREE.Material).dispose();
    });
    this.remotes.delete(id);
    if (notify) this.onChange();
  }

  /** Put a tinted car at our car (true) for the startup shader compile, then take it away (false). */
  warmup(on: boolean) {
    if (on) {
      this.remotes.set(-1, { root: this.makeCar(-1), frames: [] });
      const r = this.remotes.get(-1)!.root;
      r.position.copy(this.visual.root.position);
      this.scene.add(r);
    } else this.remove(-1, false);
  }

  /** A copy of the loaded car with its own paint colour (geometry and other materials shared). */
  private makeCar(id: number) {
    const root = new THREE.Group();
    root.name = `player_${id}`;
    const model = this.proto.clone(true);
    const paint = new THREE.Color().setHSL(((id * 0.618034) % 1), 0.75, 0.45, THREE.SRGBColorSpace);
    // own clone of the clear-coat paint in that colour (setupCarMaterials), flagged for dispose()
    const paintMat = setupCarMaterials(model, this.visual.cfg, paint, false);
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && paintMat && (Array.isArray(m.material) ? m.material.includes(paintMat) : m.material === paintMat)) m.userData.netPaint = true;
    });
    root.add(model);
    return root;
  }

  /** Per frame: maybe send our pose (pos/quat = drawn body pose), move the remote cars. */
  update(now: number, pos: THREE.Vector3, quat: THREE.Quaternion) {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN && now - this.lastSend >= 1000 / SEND_HZ) {
      const moved = pos.distanceTo(this.sentPos) > MOVED_M || quat.angleTo(this.sentQuat) > TURNED;
      if (moved || now - this.lastSend >= HEARTBEAT_MS) {
        const r3 = (v: number) => Math.round(v * 1000) / 1000, r4 = (v: number) => Math.round(v * 10000) / 10000;
        this.ws.send(JSON.stringify({
          type: 'state', x: r3(pos.x), y: r3(pos.y), z: r3(pos.z), qx: r4(quat.x), qy: r4(quat.y), qz: r4(quat.z), qw: r4(quat.w),
        }));
        this.sentPos.copy(pos);
        this.sentQuat.copy(quat);
        this.lastSend = now;
      }
    }
    const t = now - DELAY_MS;
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
    }
  }
}
