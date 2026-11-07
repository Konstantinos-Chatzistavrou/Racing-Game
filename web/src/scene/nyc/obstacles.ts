// Street poles and trees as solid obstacles. The props (props.ts) are instanced meshes with no physics; this keeps a
// fixed Rapier collider on every pole, hydrant, bin, shelter, kiosk and tree trunk within RANGE of the car (added and
// removed as the car moves, ~10 Hz), so cars actually hit them.
//
// Trees never break: Rapier stops the car, the core's damage model dents it (CarBody.feedCrash).
// Breakables (PROP_PHYS): after each physics step, a contact with one is checked against its breakaway energy.
//   - Too slow to shear it: it stays, and acts like a steel post (the car stops on it, takes the damage).
//   - Fast enough: the step's wall-like stop is undone and replaced by the real exchange. The car first shares momentum
//     with the part of the prop it has to accelerate (effFrac * mass), then pays the breakaway energy:
//       v1 = m v / (m + m_eff),   v2 = sqrt(v1^2 - 2 E / m)      (normal component only; sideways speed is kept)
//     e.g. a 1450 kg car into a lamp post (420 kg, 22 kJ) at 72 km/h leaves at ~64 km/h; into a kiosk at ~47 km/h.
//     The collider goes, the prop falls (props.knockDown), the car's front is damaged by the energy it lost.
import RAPIER from '@dimforge/rapier3d-compat';
import { GROUP_PROP, type PhysicsWorld } from '../../physics/world';
import { PROP_PHYS, type BreakablePole, type NycProps } from './props';

const RANGE = 40;          // m around the car
const SYNC_S = 0.1;

type TreeRef = { x: number; y: number; z: number; scale: number };

export interface PoleHit { pole: BreakablePole; point: { x: number; y: number; z: number }; impulse: number; vx: number; vz: number }

export class StreetObstacles {
  private cols = new Map<BreakablePole | TreeRef, RAPIER.Collider>();
  private byCollider = new Map<number, BreakablePole>();
  private poles: BreakablePole[] = [];
  private trees: TreeRef[] = [];
  private t = SYNC_S;
  private keep = new Set<BreakablePole | TreeRef>();

  constructor(private pw: PhysicsWorld, private props: NycProps) {
    props.solidPoles = true;
  }

  get count() { return this.cols.size; }

  /** Per frame: colliders for what is near the car (three coords). */
  sync(dt: number, car: { x: number; z: number }, force = false) {
    if ((this.t += dt) < SYNC_S && !force) return;
    this.t = 0;
    this.props.near(car.x, -car.z, RANGE, this.poles, this.trees);
    this.keep.clear();
    for (const p of this.poles) { this.keep.add(p); if (!this.cols.has(p)) this.add(p); }
    for (const tr of this.trees) { this.keep.add(tr); if (!this.cols.has(tr)) this.addTree(tr); }
    for (const [o, c] of this.cols) if (!this.keep.has(o) || (o as BreakablePole).broken) this.drop(o, c);
  }

  private add(p: BreakablePole) {
    const sh = PROP_PHYS[p.kind].shape;
    let d: RAPIER.ColliderDesc;
    if ('r' in sh) d = RAPIER.ColliderDesc.cylinder(sh.h / 2, sh.r).setTranslation(p.x, p.z + sh.h / 2, -p.y);
    else d = RAPIER.ColliderDesc.cuboid(sh.hx, sh.hy, sh.hz).setTranslation(p.x, p.z + sh.hy, -p.y)
      .setRotation({ x: 0, y: Math.sin(p.yaw / 2), z: 0, w: Math.cos(p.yaw / 2) });   // writeMatrix: yaw about +Y
    const c = this.pw.world.createCollider(d.setFriction(0.4).setRestitution(0.05).setCollisionGroups(GROUP_PROP));
    this.cols.set(p, c);
    this.byCollider.set(c.handle, p);
  }
  private addTree(t: TreeRef) {
    // trunk (0.26 m at the foot, scaled with the tree) up to the first limbs
    const r = 0.24 * t.scale, h = 2.8 * t.scale;
    const c = this.pw.world.createCollider(RAPIER.ColliderDesc.cylinder(h / 2, r).setTranslation(t.x, t.z + h / 2, -t.y)
      .setFriction(0.5).setRestitution(0.02).setCollisionGroups(GROUP_PROP));
    this.cols.set(t, c);
  }
  private drop(o: BreakablePole | TreeRef, c: RAPIER.Collider) {
    this.byCollider.delete(c.handle);
    this.pw.world.removeCollider(c, false);
    this.cols.delete(o);
  }

  /** A pole knocked down elsewhere (another player): its collider goes too. */
  release(p: BreakablePole) { const c = this.cols.get(p); if (c) this.drop(p, c); }

  /**
   * After world.step(): did the car (collider, body) hit a breakable hard enough to shear it? preV / preW = the car's
   * velocities before the step. Returns the hit (the caller knocks it down and dents the car) or null.
   */
  afterStep(carCol: RAPIER.Collider, body: RAPIER.RigidBody, mass: number, preV: { x: number; y: number; z: number }, preW: { x: number; y: number; z: number }): PoleHit | null {
    let hit: PoleHit | null = null;
    this.pw.world.contactPairsWith(carCol, (o) => {
      if (hit) return;
      const p = this.byCollider.get(o.handle);
      if (!p || p.broken) return;
      let touching = false;
      this.pw.world.contactPair(carCol, o, (m) => { for (let i = 0; i < m.numContacts(); i++) if (m.contactDist(i) < 0.05) touching = true; });
      if (!touching) return;
      const t = body.translation();
      const dx = p.x - t.x, dz = -p.y - t.z, d = Math.hypot(dx, dz) || 1;
      const nx = dx / d, nz = dz / d;
      const vn = preV.x * nx + preV.z * nz;          // closing speed
      if (vn <= 0) return;
      const ph = PROP_PHYS[p.kind];
      const v1 = (mass * vn) / (mass + ph.effFrac * ph.mass);
      const v2sq = v1 * v1 - (2 * ph.breakJ) / mass;
      if (v2sq <= 0) return;                         // not enough to shear it: a solid post (the step's stop stands)
      const v2 = Math.sqrt(v2sq), dv = vn - v2;
      body.setLinvel({ x: preV.x - nx * dv, y: preV.y, z: preV.z - nz * dv }, true);
      body.setAngvel(preW, true);
      const c = this.cols.get(p);
      if (c) this.drop(p, c);
      // damage by the energy the car lost (shearing + accelerating the prop), as the impulse that carries it: the bare
      // momentum change m dv would read as a 2 kJ tap for a 60 kJ hit
      const lost = 0.5 * mass * (vn * vn - v2 * v2);
      hit = { pole: p, point: { x: p.x, y: p.z + 0.55, z: -p.y }, impulse: Math.sqrt(2 * mass * lost), vx: preV.x, vz: preV.z };
    });
    return hit;
  }

  dispose() { for (const [o, c] of this.cols) this.drop(o, c); }
}
