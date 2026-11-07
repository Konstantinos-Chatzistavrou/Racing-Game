// Ground-floor wall crashes. Buildings are solid boxes; a car only gets through a wall by bringing the energy to
// break it, and then only a car-sized hole opens into a furnished room (shop, deli, apartment, lobby), not an empty
// shell. The wall's breaking energy and the rubble come off the car's speed; the lintel and ceiling above the hole come
// down as heavy slabs and chunks (real Rapier bodies) on and around the car, so it ends up pinned under rubble.
//
// Wall strength (energy along the wall's normal, E = 1/2 m vn^2):
//   glazed storefront  ~110 kJ  (a 1450 kg car at ~45 km/h straight on)
//   brick / masonry    ~360 kJ  (~80 km/h)
// Below that the wall stands: Rapier stops the car and the core's damage model dents it (CarBody.feedCrash).
// Above: v_n' = sqrt(vn^2 - 2E/m) * 0.6 (rubble, shelving), sideways speed * 0.7; damage = the energy the car lost.
//
// Cheap to draw. No facade shader changes (the old breached facade material made every nearby facade double-sided
// with per-pixel discard: +35 % frame time after a crash). The hole is a depth "portal": the room is drawn first, then
// an invisible box in the hole writes depth just in front of the wall, so the facade fails the depth test there and the
// room shows through. Cars, rubble and furniture are drawn before the portal (drawEarly) so they stay visible in the
// hole. Per breach: 4 draw calls; 3 unlit materials (baked shading), compiled at startup (warmup).
import * as THREE from 'three/webgpu';
import RAPIER from '@dimforge/rapier3d-compat';
import type { BuildingColliderBox } from './props';
import { GROUP_CAMERA_ONLY } from '../../physics/world';

/** Membership bit 0x8: hit by cars and the world, ignored by GROUP_VIEW rays (camera, AI ground). */
export const GROUP_RUBBLE = (0x0008 << 16) | 0xffff;

const H = 4.2;            // ground floor height (room ceiling): Manhattan storefront floors run 4 m and more
const HOLE_W = 3.4, HOLE_H = 3.3, WALL_T = 0.4;   // the lintel comes down with the wall: a tall, car-wide hole
const PORTAL_OUT = 0.15, PORTAL_IN = 1.2;          // portal box: just proud of the wall (the camera never ends up inside it), deep inside
const ORDER_EARLY = -4, ORDER_ROOM = -2, ORDER_PORTAL = -1;
const MAX_LIVE = 3;       // breaches whose loose objects are still simulated

type Room = 'shop' | 'deli' | 'apartment' | 'lobby';
type RGB = [number, number, number];

/** Opaque meshes under obj are drawn before the breach portals (so they stay visible inside a hole). */
export function drawEarly(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    if (mats.every((x) => !x.transparent)) m.renderOrder = ORDER_EARLY;
  });
}

export interface BreachHost {
  building(handle: number): { key: string; box: BuildingColliderBox } | null;
  find(cx: number, cy: number): { key: string; box: BuildingColliderBox } | null;
  /** Swap the building's solid collider for these (static, wall surface); marks it breached. */
  replace(key: string, box: BuildingColliderBox, descs: RAPIER.ColliderDesc[]): void;
  /** Distance along the ray (three coords) to the drawn facade, or null: the box collider is the footprint's bounding box,
   *  the visible wall may stand back from it. */
  facadeDepth?(from: THREE.Vector3, dir: THREE.Vector3, max: number): number | null;
  /** Dust, glass and brick flying out of the hole (visual only). */
  burst?(wx: number, groundY: number, wz: number, nx: number, nz: number, vx: number, vz: number, glass: boolean): void;
}

/** What a breach is, enough to rebuild it (tile reload, other players): building centre (game frame), face, offset, seed. */
export interface BreachSpec { cx: number; cy: number; face: number; u: number; seed: number }

export interface WallHit { spec: BreachSpec; point: { x: number; y: number; z: number }; impulse: number; storefront: boolean }

interface Piece { body: RAPIER.RigidBody | null; size: THREE.Vector3; slot: number }
interface Live {
  spec: BreachSpec; key: string;
  group: THREE.Group;                 // building frame (ground level at y = 0)
  portal: THREE.Mesh;
  face: { ax: 'x' | 'z'; s: number; plane: number };   // plane: where the drawn facade is (building frame, along ax)
  center: THREE.Vector3; quat: THREE.Quaternion;
  /** furniture and rubble: bodies while simulated (null once frozen), slots in the shared instance pool */
  pieces: Piece[];
  pending: { at: number; make: () => void }[];
  age: number;
}

const rand = (seed: number) => { let s = (seed * 2654435761) >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); };

/** Box / quad geometry with baked light (vertex colours) in the building frame. */
class Geo {
  pos: number[] = []; col: number[] = [];
  constructor(private map: (u: number, w: number, y: number) => THREE.Vector3, private light: (u: number, w: number, y: number) => number) {}
  /** quad from 4 face-frame corners, facing direction n (face-frame: u, w, y), colour c */
  quad(p: [number, number, number][], n: [number, number, number], c: RGB, glow = 1) {
    const v = p.map(([u, w, y]) => this.map(u, w, y));
    const want = this.map(p[0][0] + n[0], p[0][1] + n[1], p[0][2] + n[2]).sub(v[0]);
    const e1 = v[1].clone().sub(v[0]), e2 = v[2].clone().sub(v[0]);
    const order = e1.cross(e2).dot(want) >= 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
    const shade = n[2] > 0.5 ? 1 : n[2] < -0.5 ? 0.5 : Math.abs(n[0]) > 0.5 ? 0.8 : 0.7;
    for (const i of order) {
      const q = p[i], L = glow > 1 ? glow : shade * this.light(q[0], q[1], q[2]);
      this.pos.push(v[i].x, v[i].y, v[i].z);
      this.col.push(c[0] * L, c[1] * L, c[2] * L);
    }
  }
  /** solid box u0..u1, w0..w1, y0..y1 (outward faces) */
  box(u0: number, u1: number, w0: number, w1: number, y0: number, y1: number, c: RGB, glow = 1) {
    this.quad([[u0, w0, y1], [u1, w0, y1], [u1, w1, y1], [u0, w1, y1]], [0, 0, 1], c, glow);
    this.quad([[u0, w0, y0], [u1, w0, y0], [u1, w1, y0], [u0, w1, y0]], [0, 0, -1], c, glow);
    this.quad([[u0, w0, y0], [u1, w0, y0], [u1, w0, y1], [u0, w0, y1]], [0, -1, 0], c, glow);
    this.quad([[u0, w1, y0], [u1, w1, y0], [u1, w1, y1], [u0, w1, y1]], [0, 1, 0], c, glow);
    this.quad([[u0, w0, y0], [u0, w1, y0], [u0, w1, y1], [u0, w0, y1]], [-1, 0, 0], c, glow);
    this.quad([[u1, w0, y0], [u1, w1, y0], [u1, w1, y1], [u1, w0, y1]], [1, 0, 0], c, glow);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

/** Unit box with baked face shading (top light, bottom dark), for instanced loose pieces. */
function unitBox() {
  const g = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
  const n = g.getAttribute('normal');
  const c: number[] = [];
  for (let i = 0; i < n.count; i++) { const y = n.getY(i), s = y > 0.5 ? 1 : y < -0.5 ? 0.5 : Math.abs(n.getX(i)) > 0.5 ? 0.82 : 0.7; c.push(s, s, s); }
  g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
  g.deleteAttribute('uv');
  return g;
}

export class Breaches {
  private live: Live[] = [];
  private specs: BreachSpec[] = [];         // every breach so far (rebuilt when its tile reloads)
  private roomMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  private looseMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  /** One instanced mesh for every loose piece of every breach: created at startup (so it is compiled with the rest), 1 draw call. */
  private pool: THREE.InstancedMesh;
  private free: number[] = [];
  private used = 0;
  private static readonly POOL = 320;
  private zero = new THREE.Matrix4().makeScale(0, 0, 0);
  private portalMat = new THREE.MeshBasicMaterial({ colorWrite: false });
  private box = unitBox();
  private warm: THREE.Object3D[] = [];
  private m4 = new THREE.Matrix4(); private v = new THREE.Vector3(); private q = new THREE.Quaternion(); private s = new THREE.Vector3();
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

  constructor(private scene: THREE.Scene, private pw: { world: RAPIER.World }, private host: BreachHost) {
    this.portalMat.name = 'breach_portal';
    this.pool = new THREE.InstancedMesh(this.box, this.looseMat, Breaches.POOL);
    this.pool.name = 'breach_pieces';
    for (let i = 0; i < Breaches.POOL; i++) { this.pool.setMatrixAt(i, this.zero); this.pool.setColorAt(i, new THREE.Color(1, 1, 1)); this.free.push(Breaches.POOL - 1 - i); }
    this.pool.count = 1;                 // one degenerate instance: always drawn, so its pipeline is built at load time
    this.pool.frustumCulled = false;
    this.pool.renderOrder = ORDER_EARLY;
    this.pool.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.pool);
  }

  private take(color: THREE.Color) {
    const slot = this.free.pop();
    if (slot === undefined) return -1;
    this.pool.setColorAt(slot, color);
    this.pool.instanceColor!.needsUpdate = true;
    this.used = Math.max(this.used, slot + 1);
    this.pool.count = Math.max(1, this.used);
    return slot;
  }
  private release(slot: number) {
    if (slot < 0) return;
    this.pool.setMatrixAt(slot, this.zero);
    this.pool.instanceMatrix.needsUpdate = true;
    this.free.push(slot);
  }

  get count() { return this.live.length; }

  /** Compile the room and portal materials now (the piece pool is always in the scene) (loading screen), not at the first crash: tiny meshes at p, removed with warmup(false). */
  warmup(on: boolean, p?: THREE.Vector3) {
    if (!on) { for (const o of this.warm) o.removeFromParent(); this.warm.length = 0; return; }
    const g = new Geo((u, w, y) => new THREE.Vector3(u, y, w), () => 1);
    g.box(0, 0.01, 0, 0.01, 0, 0.01, [0.5, 0.5, 0.5]);
    const room = new THREE.Mesh(g.build(), this.roomMat);
    const portal = new THREE.Mesh(this.box, this.portalMat);
    for (const o of [room, portal]) {
      o.position.copy(p ?? new THREE.Vector3()).y -= 3; o.scale.setScalar(0.01); o.frustumCulled = false;
      (o as THREE.Mesh).renderOrder = ORDER_ROOM;
      this.scene.add(o); this.warm.push(o);
    }
  }

  /**
   * After world.step(): did the car hit a building wall hard enough to break it? preV / preW = the car's velocity
   * before the step. On a break the car's velocity is set to what is left; returns the hit (the caller dents the car).
   */
  check(carCol: RAPIER.Collider, body: RAPIER.RigidBody, mass: number, preV: { x: number; y: number; z: number }, preW: { x: number; y: number; z: number }): WallHit | null {
    // find a touched building first (no world changes inside Rapier's iteration), then judge and open it
    const w = this.pw.world;
    let found: { key: string; box: BuildingColliderBox } | null = null;
    w.contactPairsWith(carCol, (o) => {
      if (found) return;
      const b = this.host.building(o.handle);
      if (!b) return;
      let touching = false;
      w.contactPair(carCol, o, (m) => { for (let i = 0; i < m.numContacts(); i++) if (m.contactDist(i) < 0.05) touching = true; });
      if (touching) found = b;
    });
    if (!found) return null;
    const box = (found as { box: BuildingColliderBox }).box, t = body.translation();
    const { center, quat } = this.frame(box);
    // car centre in the building frame -> the face it is at, and where along it
    const lp = this.v.set(t.x, t.y, t.z).sub(center).applyQuaternion(this.q.copy(quat).invert());
    const dx = Math.abs(lp.x) - box.hx, dz = Math.abs(lp.z) - box.hy;
    const face = dx > dz ? (lp.x > 0 ? 0 : 1) : (lp.z > 0 ? 2 : 3);
    const f = this.faceOf(box, face);
    const nW = new THREE.Vector3(f.ax === 'x' ? f.s : 0, 0, f.ax === 'z' ? f.s : 0).applyQuaternion(quat);
    const vn = -(preV.x * nW.x + preV.z * nW.z);                // speed into the wall
    if (vn <= 0) return null;
    const height = box.z1 - box.z0, seed = Math.floor(Math.abs(box.cx * 7.31 + box.cy * 3.17) * 100) % 100000;
    const masonry = height < 22 ? true : height > 60 ? false : seed % 3 === 0;
    const E = masonry ? 360e3 : 110e3;
    if (0.5 * mass * vn * vn < E) return null;                   // the wall stands: the step's stop stays
    const uLocal = f.ax === 'x' ? lp.z : lp.x;
    if (2 * f.half < 4.5 || 2 * f.uHalf < HOLE_W + 1.2 || height < H + 0.2) return null;   // too small to hold a room
    const spec: BreachSpec = { cx: box.cx, cy: box.cy, face, u: uLocal, seed };
    // the car keeps what is left after the wall, then ploughs through rubble and shelving
    const vn2 = Math.sqrt(vn * vn - (2 * E) / mass) * 0.6;
    const vtx = preV.x + nW.x * vn, vtz = preV.z + nW.z * vn;       // sideways part
    const nv = { x: vtx * 0.7 - nW.x * vn2, y: preV.y, z: vtz * 0.7 - nW.z * vn2 };
    if (!this.open(spec, { carPos: { x: t.x, y: t.y, z: t.z }, carVel: nv, preV })) return null;
    body.setLinvel(nv, true);
    body.setAngvel({ x: preW.x * 0.5, y: preW.y * 0.5, z: preW.z * 0.5 }, true);
    const lost = 0.5 * mass * ((preV.x ** 2 + preV.z ** 2) - (nv.x ** 2 + nv.z ** 2));
    const wallPt = this.map(box, face, uLocal, 0, 0.8);
    return { spec, point: { x: wallPt.x, y: wallPt.y, z: wallPt.z }, impulse: Math.sqrt(2 * mass * Math.max(0, lost)), storefront: !masonry };
  }

  private frame(box: BuildingColliderBox) {
    return {
      center: new THREE.Vector3(box.cx, box.z0, -box.cy),
      quat: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), box.yaw),
    };
  }
  private faceOf(box: BuildingColliderBox, face: number) {
    return face < 2 ? { ax: 'x' as const, s: face === 0 ? 1 : -1, half: box.hx, uHalf: box.hy } : { ax: 'z' as const, s: face === 2 ? 1 : -1, half: box.hy, uHalf: box.hx };
  }
  /** face frame (u along the wall, w inward from it, y up from the ground) -> building local */
  private local(box: BuildingColliderBox, face: number, u: number, w: number, y: number) {
    const f = this.faceOf(box, face), a = f.s * (f.half - w);
    return f.ax === 'x' ? new THREE.Vector3(a, y, u) : new THREE.Vector3(u, y, a);
  }
  /** face frame -> world */
  private map(box: BuildingColliderBox, face: number, u: number, w: number, y: number) {
    const { center, quat } = this.frame(box);
    return this.local(box, face, u, w, y).applyQuaternion(quat).add(center);
  }

  /** Open a breach: colliders, room, portal; with `crash`, rubble on and around the car. Also for other players' breaches. */
  open(spec: BreachSpec, crash?: { carPos: { x: number; y: number; z: number }; carVel: { x: number; y: number; z: number }; preV: { x: number; y: number; z: number } }) {
    const b = this.host.find(spec.cx, spec.cy);
    if (!b) return false;
    const box = b.box, face = spec.face, f = this.faceOf(box, face);
    if (!this.specs.some((x) => x.cx === spec.cx && x.cy === spec.cy)) this.specs.push(spec);
    const R = rand(spec.seed + 17);
    // room: width along the wall, depth into the building; hole centred on the hit
    const W = Math.min(7.5, 2 * f.uHalf - 0.8);
    const u0 = Math.max(-f.uHalf + 0.4, Math.min(f.uHalf - 0.4 - W, spec.u - W / 2)), u1 = u0 + W;
    const h0 = Math.max(u0 + 0.35, Math.min(u1 - 0.35 - HOLE_W, spec.u - HOLE_W / 2)), h1 = h0 + HOLE_W;
    const height = box.z1 - box.z0;
    // where the drawn wall really is behind this box face (0 for a rectangular building); everything below is measured
    // from it: w = 0 at the facade, the box face at w = -wo
    const full = 2 * f.half;
    let wo = 0;
    {
      const from = this.map(box, face, (h0 + h1) / 2, -2, 1.5), to = this.map(box, face, (h0 + h1) / 2, 0, 1.5);
      const d = this.host.facadeDepth?.(from, to.sub(from).normalize(), 2 + Math.min(4, full - 5));
      if (d !== null && d !== undefined) wo = Math.max(0, Math.min(full - 5, d - 2));
    }
    const D = Math.min(10, full - wo - 0.8);
    const local = (u: number, w: number, y: number) => this.local(box, face, u, w + wo, y);
    const mapW = (u: number, w: number, y: number) => this.map(box, face, u, w + wo, y);
    const kind: Room = height > 60 ? 'lobby' : height < 22 ? (spec.seed % 2 ? 'apartment' : 'shop') : (['shop', 'deli', 'shop', 'apartment'] as Room[])[spec.seed % 4];

    // ---- colliders: the building box becomes upper floors + solid ground floor around the room + a front wall with the hole
    const { center, quat } = this.frame(box);
    const descs: RAPIER.ColliderDesc[] = [];
    const cuboid = (uA: number, uB: number, wA: number, wB: number, yA: number, yB: number) => {
      if (uB - uA < 0.05 || wB - wA < 0.05 || yB - yA < 0.05) return;
      const c = local((uA + uB) / 2, (wA + wB) / 2, (yA + yB) / 2).applyQuaternion(quat).add(center);
      const hu = (uB - uA) / 2, hw = (wB - wA) / 2, hy = (yB - yA) / 2;
      descs.push(RAPIER.ColliderDesc.cuboid(f.ax === 'x' ? hw : hu, hy, f.ax === 'x' ? hu : hw).setTranslation(c.x, c.y, c.z)
        .setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w }).setFriction(0.5).setRestitution(0.05));
    };
    cuboid(-f.uHalf, f.uHalf, -wo, full - wo, H, height);         // upper floors
    cuboid(-f.uHalf, u0, -wo, full - wo, 0, H);                    // ground floor left of the room
    cuboid(u1, f.uHalf, -wo, full - wo, 0, H);                     // right of it
    cuboid(u0, u1, D, full - wo, 0, H);                            // behind it
    cuboid(u0, h0, 0, WALL_T, 0, H);                               // front wall either side of the hole
    cuboid(h1, u1, 0, WALL_T, 0, H);
    cuboid(h0, h1, 0, WALL_T, HOLE_H, H);                          // lintel
    // the hole, for the chase camera only: with the car inside, the camera stays in the room instead of watching it
    // through the wall from the street
    cuboid(h0, h1, 0.1, 0.3, 0, HOLE_H);
    descs[descs.length - 1].setCollisionGroups(GROUP_CAMERA_ONLY);
    // ---- room contents (static: shelving, counters, desks are fixed; loose: tables, chairs, stands, boxes)
    const statics: [number, number, number, number, number, number][] = [];
    const looseSpec: { u: number; w: number; y: number; su: number; sw: number; sy: number; kg: number; c: RGB }[] = [];
    const light = (u: number, w: number, y: number) => {
      const du = (u - (u0 + u1) / 2) / W, dw = (w - D / 2) / D;
      return (0.34 + 0.32 * Math.max(0, 1 - Math.hypot(du, dw) * 1.6)) * (0.8 + 0.2 * (y / H));
    };
    const geo = new Geo(local, light);
    const wallC: RGB = kind === 'apartment' ? [0.55, 0.42, 0.33] : kind === 'lobby' ? [0.62, 0.6, 0.56] : kind === 'deli' ? [0.66, 0.6, 0.48] : [0.72, 0.72, 0.7];
    const floorC: RGB = kind === 'apartment' ? [0.36, 0.22, 0.12] : kind === 'lobby' ? [0.78, 0.76, 0.72] : kind === 'deli' ? [0.4, 0.3, 0.22] : [0.5, 0.5, 0.48];
    const T = WALL_T, L = u0 + 0.02, Rr = u1 - 0.02;
    // shell (inward faces): floor, ceiling, side walls, back wall, inner face of the front wall with its opening
    geo.quad([[L, T, 0.01], [Rr, T, 0.01], [Rr, D, 0.01], [L, D, 0.01]], [0, 0, 1], floorC);
    geo.quad([[L, T, H], [Rr, T, H], [Rr, D, H], [L, D, H]], [0, 0, -1], [0.6, 0.6, 0.58]);
    geo.quad([[L, T, 0], [L, D, 0], [L, D, H], [L, T, H]], [1, 0, 0], wallC);
    geo.quad([[Rr, T, 0], [Rr, D, 0], [Rr, D, H], [Rr, T, H]], [-1, 0, 0], wallC);
    geo.quad([[L, D, 0], [Rr, D, 0], [Rr, D, H], [L, D, H]], [0, -1, 0], wallC);
    geo.quad([[L, T, 0], [h0, T, 0], [h0, T, H], [L, T, H]], [0, 1, 0], wallC);
    geo.quad([[h1, T, 0], [Rr, T, 0], [Rr, T, H], [h1, T, H]], [0, 1, 0], wallC);
    geo.quad([[h0, T, HOLE_H], [h1, T, HOLE_H], [h1, T, H], [h0, T, H]], [0, 1, 0], wallC);
    // the hole's raw edges: brick / concrete reveal around the opening (both jambs and the lintel underside)
    const edgeC: RGB = [0.42, 0.26, 0.2];
    geo.quad([[h0, -wo, 0], [h0, T, 0], [h0, T, HOLE_H], [h0, -wo, HOLE_H]], [1, 0, 0], edgeC);
    geo.quad([[h1, -wo, 0], [h1, T, 0], [h1, T, HOLE_H], [h1, -wo, HOLE_H]], [-1, 0, 0], edgeC);
    geo.quad([[h0, -wo, HOLE_H], [h1, -wo, HOLE_H], [h1, T, HOLE_H], [h0, T, HOLE_H]], [0, 0, -1], edgeC);
    // ceiling lights (bright: they bloom)
    for (let w = 2; w < D - 1; w += 3) geo.quad([[u0 + W * 0.3, w, H - 0.02], [u1 - W * 0.3, w, H - 0.02], [u1 - W * 0.3, w + 0.5, H - 0.02], [u0 + W * 0.3, w + 0.5, H - 0.02]], [0, 0, -1], kind === 'apartment' ? [1, 0.75, 0.45] : [1, 0.97, 0.9], 1.5);
    const bright = (): RGB => [[0.9, 0.2, 0.15], [0.95, 0.75, 0.1], [0.15, 0.5, 0.9], [0.2, 0.75, 0.3], [0.95, 0.45, 0.1], [0.85, 0.85, 0.85]][Math.floor(R() * 6)] as RGB;
    const stat = (uA: number, uB: number, wA: number, wB: number, yA: number, yB: number, c: RGB) => { geo.box(uA, uB, wA, wB, yA, yB, c); statics.push([uA, uB, wA, wB, yA, yB]); };
    const loose = (u: number, w: number, su: number, sw: number, sy: number, kg: number, c: RGB, y = 0) => looseSpec.push({ u, w, y: y + sy / 2, su, sw, sy, kg, c });
    const back = D - 0.05, mid = (u0 + u1) / 2;
    if (kind === 'shop') {
      for (const [a, bb] of [[L, L + 0.55], [Rr - 0.55, Rr]] as [number, number][]) {
        stat(a, bb, 1.6, back - 1.8, 0, 1.9, [0.35, 0.35, 0.37]);
        for (let y = 0.35; y < 1.9; y += 0.45) for (let w = 1.65; w < back - 1.9; w += 0.4)
          geo.box(a + 0.04, bb - 0.04, w, w + 0.34, y, y + 0.28, bright());
      }
      stat(mid - 1.3, mid + 0.3, back - 1.5, back - 0.9, 0, 1.0, [0.3, 0.22, 0.16]);          // checkout counter
      geo.quad([[L + 0.7, back - 0.02, 0.2], [Rr - 0.7, back - 0.02, 0.2], [Rr - 0.7, back - 0.02, 2.1], [L + 0.7, back - 0.02, 2.1]], [0, -1, 0], [0.75, 0.9, 1], 1.3);   // drinks fridges
      loose(mid - 0.9, D * 0.45, 0.9, 0.5, 1.3, 55, [0.5, 0.5, 0.52]); loose(mid + 0.9, D * 0.55, 0.9, 0.5, 1.3, 55, [0.5, 0.5, 0.52]);
      for (let i = 0; i < 5; i++) loose(mid + (R() - 0.5) * (W - 2), 1.2 + R() * 1.5, 0.45, 0.45, 0.4, 6, [0.62, 0.48, 0.3]);
    } else if (kind === 'deli') {
      stat(L + 0.3, Rr - 0.3, back - 1.2, back - 0.6, 0, 1.05, [0.45, 0.32, 0.2]);
      geo.box(L + 0.5, Rr - 0.5, back - 1.15, back - 0.65, 1.05, 1.45, [0.8, 0.9, 1.0], 1.2);                     // deli case
      geo.quad([[mid - 1.6, back - 0.02, 2.4], [mid + 1.6, back - 0.02, 2.4], [mid + 1.6, back - 0.02, 3.2], [mid - 1.6, back - 0.02, 3.2]], [0, -1, 0], [1, 0.6, 0.25], 1.4);   // menu board
      for (const [du, w] of [[-1.4, 2.6], [1.4, 2.6], [-1.4, 5], [1.4, 5]]) {
        if (w > back - 1.8) continue;
        loose(mid + du, w, 0.8, 0.8, 0.75, 22, [0.55, 0.38, 0.22]);
        loose(mid + du - 0.6, w, 0.42, 0.42, 0.85, 5, [0.2, 0.2, 0.22]); loose(mid + du + 0.6, w, 0.42, 0.42, 0.85, 5, [0.2, 0.2, 0.22]);
      }
    } else if (kind === 'apartment') {
      geo.quad([[mid - 1.6, 2.2, 0.02], [mid + 1.6, 2.2, 0.02], [mid + 1.6, 5.2, 0.02], [mid - 1.6, 5.2, 0.02]], [0, 0, 1], [0.45, 0.12, 0.1]);   // rug
      stat(Rr - 0.38, Rr, 1.5, Math.min(back - 0.5, 4.5), 0, 2.1, [0.3, 0.2, 0.12]);                                  // bookshelf
      for (let y = 0.25; y < 2; y += 0.45) for (let w = 1.55; w < Math.min(back - 0.6, 4.4); w += 0.12) geo.box(Rr - 0.34, Rr - 0.06, w, w + 0.09, y, y + 0.3 + R() * 0.08, bright());
      loose(mid - 0.3, Math.min(back - 1, 5.6), 2.0, 0.9, 0.85, 70, [0.25, 0.3, 0.42]);                               // sofa
      loose(mid, 3.6, 1.1, 0.6, 0.45, 18, [0.35, 0.24, 0.14]);                                                         // coffee table
      loose(L + 0.6, 2.6, 1.5, 0.45, 0.5, 25, [0.18, 0.18, 0.2]);                                                      // TV stand
      geo.box(L + 0.25, L + 0.45, back - 0.8, back - 0.6, 0, 1.6, [1, 0.7, 0.35], 1.4);                                 // floor lamp
    } else {
      stat(mid - 1.2, mid + 1.2, back - 1.6, back - 0.8, 0, 1.1, [0.25, 0.22, 0.2]);                                   // reception desk
      geo.quad([[mid - 1, back - 0.02, 0], [mid + 1, back - 0.02, 0], [mid + 1, back - 0.02, 2.6], [mid - 1, back - 0.02, 2.6]], [0, -1, 0], [0.75, 0.72, 0.66], 1.1);   // elevator doors
      loose(L + 0.7, 2, 0.7, 0.7, 0.9, 90, [0.25, 0.4, 0.2]); loose(Rr - 0.7, 2, 0.7, 0.7, 0.9, 90, [0.25, 0.4, 0.2]);  // planters
      loose(L + 0.9, 4.4, 1.6, 0.5, 0.45, 45, [0.3, 0.3, 0.32]); loose(Rr - 0.9, 4.4, 1.6, 0.5, 0.45, 45, [0.3, 0.3, 0.32]);
    }
    for (const [uA, uB, wA, wB, yA, yB] of statics) cuboid(uA, uB, wA, wB, yA, yB);
    this.host.replace(b.key, box, descs);

    // ---- visuals: room (one mesh), portal, loose pieces, rubble
    const group = new THREE.Group();
    group.position.copy(center); group.quaternion.copy(quat);
    const room = new THREE.Mesh(geo.build(), this.roomMat);
    room.renderOrder = ORDER_ROOM;
    group.add(room);
    const portal = new THREE.Mesh(this.box, this.portalMat);
    portal.renderOrder = ORDER_PORTAL;
    const pc = local((h0 + h1) / 2, (PORTAL_IN - PORTAL_OUT) / 2, HOLE_H / 2 + 0.03);
    portal.position.copy(pc);
    portal.scale.set(f.ax === 'x' ? PORTAL_IN + PORTAL_OUT : HOLE_W, HOLE_H - 0.06, f.ax === 'x' ? HOLE_W : PORTAL_IN + PORTAL_OUT);
    group.add(portal);
    this.scene.add(group);
    group.updateMatrixWorld(true);
    const live: Live = { spec, key: b.key, group, portal, face: { ax: f.ax, s: f.s, plane: f.half - wo }, center, quat, pieces: [], pending: [], age: 0 };
    const add = (p: THREE.Vector3, size: THREE.Vector3, kg: number, c: RGB, v?: THREE.Vector3, spin = false) => {
      const slot = this.take(new THREE.Color(...c));
      if (slot < 0) return;
      live.pieces.push({ body: this.dynBox(p, quat, size, kg, v, spin), size, slot });
    };

    // loose furniture: light dynamic boxes (they get shoved and thrown)
    for (const l of looseSpec) {
      const c = local(l.u, l.w, l.y).applyQuaternion(quat).add(center);
      const size = new THREE.Vector3(f.ax === 'x' ? l.sw : l.su, l.sy, f.ax === 'x' ? l.su : l.sw);
      add(c, size, l.kg, l.c);
    }

    // ---- rubble: the breach brings down brick and the lintel / ceiling over the hole, onto the car if it is there
    if (crash) {
      const out = mapW((h0 + h1) / 2, -0.2, 0).sub(mapW((h0 + h1) / 2, 0.8, 0)).normalize();   // outward
      const storefront = height >= 22 && !(height <= 60 && spec.seed % 3 === 0);
      this.host.burst?.(pc.x, box.z0, pc.z, out.x, out.z, crash.preV.x, crash.preV.z, storefront);
      const pieces: { p: THREE.Vector3; size: THREE.Vector3; kg: number; c: RGB; v?: THREE.Vector3 }[] = [];
      for (let i = 0; i < 12; i++) {
        const s = 0.22 + R() * 0.32;
        const brick = R() < 0.6;
        pieces.push({
          p: mapW(h0 + 0.3 + R() * (HOLE_W - 0.6), -0.2 + R() * 1.2, HOLE_H - 0.2 + R() * 0.8),
          size: new THREE.Vector3(s * (1 + R()), s * 0.8, s), kg: Math.round(1800 * s * s * s * 1.6), c: brick ? [0.24, 0.11, 0.08] : [0.27, 0.26, 0.25],
          v: new THREE.Vector3(crash.carVel.x * 0.3 + (R() - 0.5) * 2, -1, crash.carVel.z * 0.3 + (R() - 0.5) * 2),
        });
      }
      for (const pc2 of pieces) add(pc2.p, pc2.size, pc2.kg, pc2.c, pc2.v, true);
      // two ceiling slabs, ~0.3 s later, over where the car will be (inside the room)
      const carIn = new THREE.Vector3(crash.carPos.x + crash.carVel.x * 0.3, 0, crash.carPos.z + crash.carVel.z * 0.3);
      const lc = carIn.sub(center).applyQuaternion(this.q.copy(quat).invert());
      const wIn = Math.max(1.4, Math.min(D - 1.2, f.half - wo - f.s * (f.ax === 'x' ? lc.x : lc.z)));
      const uIn = Math.max(u0 + 1, Math.min(u1 - 1, f.ax === 'x' ? lc.z : lc.x));
      live.pending.push({ at: 0.28, make: () => {
        for (const [du, dw] of [[-0.35, -0.4], [0.4, 0.5]]) {
          const p = mapW(uIn + du, wIn + dw, H - 0.35);
          const size = new THREE.Vector3(f.ax === 'x' ? 0.9 : 1.5, 0.2, f.ax === 'x' ? 1.5 : 0.9);
          add(p, size, 430, [0.3, 0.29, 0.28], new THREE.Vector3(0, -1.5, 0), true);
        }
      } });
    }
    this.live.push(live);
    // keep the simulation small: the oldest breaches' loose objects freeze where they lie
    this.sync(live);
    const simulated = () => this.live.filter((x) => x.pieces.some((p) => p.body));
    while (simulated().length > MAX_LIVE) this.freeze(simulated()[0]);
    return true;
  }

  private dynBox(p: THREE.Vector3, q: THREE.Quaternion, size: THREE.Vector3, kg: number, v?: THREE.Vector3, spin = false) {
    const body = this.pw.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(p.x, p.y, p.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .setLinearDamping(0.2).setAngularDamping(0.6).setCcdEnabled(kg > 100));
    const vol = size.x * size.y * size.z;
    this.pw.world.createCollider(RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2).setDensity(kg / Math.max(1e-3, vol))
      .setFriction(0.8).setRestitution(0.05).setCollisionGroups(GROUP_RUBBLE), body);
    if (v) body.setLinvel(v, true);
    if (spin) body.setAngvel({ x: (Math.random() - 0.5) * 3, y: (Math.random() - 0.5) * 2, z: (Math.random() - 0.5) * 3 }, true);
    return body;
  }

  /** Pool instances follow their bodies. */
  private sync(l: Live) {
    for (const p of l.pieces) {
      if (!p.body) continue;
      const t = p.body.translation(), r = p.body.rotation();
      this.m4.compose(this.v.set(t.x, t.y, t.z), this.q.set(r.x, r.y, r.z, r.w), this.s.copy(p.size));
      this.pool.setMatrixAt(p.slot, this.m4);
    }
    this.pool.instanceMatrix.needsUpdate = true;
  }

  /** Loose objects stop being simulated (they stay drawn where they are). */
  private freeze(l: Live) {
    for (const p of l.pieces) if (p.body) { this.pw.world.removeRigidBody(p.body); p.body = null; }
  }

  /** Per frame: loose pieces follow their bodies; portals only when the camera is outside the wall. */
  update(dt: number, camera: THREE.Camera) {
    for (const l of this.live) {
      l.age += dt;
      for (let i = l.pending.length - 1; i >= 0; i--) if (l.age >= l.pending[i].at) { l.pending[i].make(); l.pending.splice(i, 1); }
      const lc = this.v.copy(camera.position).sub(l.center).applyQuaternion(this.q.copy(l.quat).invert());
      l.portal.visible = l.face.s * (l.face.ax === 'x' ? lc.x : lc.z) > l.face.plane - 0.05;
      if (l.pieces.some((p) => p.body && !p.body.isSleeping())) this.sync(l);
    }
  }

  /** A tile unloads: its breaches go (colliders went with the tile); their specs stay for when it comes back. */
  dropTile(key: string) {
    for (const l of this.live.filter((x) => x.key === key)) {
      this.freeze(l);
      l.group.removeFromParent();
      (l.group.children[0] as THREE.Mesh).geometry.dispose();
      for (const p of l.pieces) this.release(p.slot);
    }
    this.live = this.live.filter((x) => x.key !== key);
  }

  /** A tile's colliders are back: rebuild its breaches (no rubble). */
  reapply(key: string) {
    for (const s of this.specs) {
      const b = this.host.find(s.cx, s.cy);
      if (b && b.key === key && !this.live.some((l) => l.spec === s)) this.open(s);
    }
  }

  /** Test / tooling: break the wall of the building nearest p (three coords), facing p. */
  breakNearest(p: THREE.Vector3, list: { key: string; box: BuildingColliderBox }[]) {
    let best: { key: string; box: BuildingColliderBox } | null = null, bd = 80;
    for (const b of list) { const d = Math.hypot(b.box.cx - p.x, b.box.cy + p.z) - Math.max(b.box.hx, b.box.hy); if (d < bd) { bd = d; best = b; } }
    if (!best) return false;
    const { center, quat } = this.frame(best.box);
    const lp = this.v.copy(p).sub(center).applyQuaternion(this.q.copy(quat).invert());
    const dx = Math.abs(lp.x) - best.box.hx, dz = Math.abs(lp.z) - best.box.hy;
    const face = dx > dz ? (lp.x > 0 ? 0 : 1) : (lp.z > 0 ? 2 : 3);
    const seed = Math.floor(Math.abs(best.box.cx * 7.31 + best.box.cy * 3.17) * 100) % 100000;
    return this.open({ cx: best.box.cx, cy: best.box.cy, face, u: face < 2 ? lp.z : lp.x, seed }, { carPos: p, carVel: { x: 0, y: 0, z: 0 }, preV: { x: 0, y: 0, z: 0 } });
  }
}
