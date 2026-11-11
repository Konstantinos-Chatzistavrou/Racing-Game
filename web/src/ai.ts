// AI rivals: cars that race the player round the city route. Kinematic Rapier bodies
// (kinematicPositionBased) follow a smoothed racing lane: no tyre model, a fraction of a CoreCar's
// cost. The player collides with them (Rapier gives a kinematic body the velocity of its per-tick
// move), and since 2026-11-11 the hit is SHARED (afterStep): the player keeps half of the velocity
// change the solver gave them, the rival takes the other half as a shove along and across its lane,
// a yaw kick (a tap on the rear quarter spins it), and damage. A damaged rival is slower; a wrecked
// one rolls to a stop where it is and stays there as an obstacle that can still be pushed.
//
// Pace comes from the same limits as the core's AIDriver (core/src/ai.cpp), worked out from the
// default car's physics JSON: cornering v^2 k <= skill * 0.82 mu g, braking skill * 0.85 mu g,
// acceleration limited by grip, engine power and drag. Each car has its own skill and preferred
// line across the road; a car blocked by a slower one (or the player) moves over to pass it and
// slows down only while it can't get by.
//
// Modes: 'off' (parked out of sight: free roam and online are just you), 'race' (on the grid,
// held until go(), then racing). ?ai=0..5 sets the number of rivals (default 5: a grid of six);
// ?blackcar=1 makes them matte black with lights off (night lighting test).
import * as THREE from 'three/webgpu';
import RAPIER from '@dimforge/rapier3d-compat';
import { GROUP_CAR, GROUP_VIEW, type PhysicsWorld } from './physics/world';
import { materialsOf } from './scene/city';
import { mergeSpinningWheels, mergeStaticMeshes } from './scene/merge';
import { applyPlate } from './scene/plate';
import { botName } from './username';
import { createContactShadow, setupCarMaterials, type CarVisualConfig } from './scene/car';
import { assetUrl, loadGLTF } from './scene/loaders';
import { drawEarly } from './scene/nyc/breach';

/** strength of a rival's headlight pool on the road (a clustered point light, see create()) */
const AI_BEAM = 60;
/** the pool sits this far ahead of the nose and this high: low and close, so it lights road, not the car in front */
const BEAM_AHEAD = 5.2, BEAM_Y = 0.4;
/**
 * A rival's speed change (m/s) from one crash that does no damage, and the damage per (m/s above it)^2. One crash
 * that changes its speed by 18 m/s wrecks it outright (a 130 km/h hit on a standing rival; the cars share the change);
 * an 80 km/h rear-end costs it about a fifth. Like the player's car (core damage.hpp), bumps never add up.
 */
const HIT_FREE = 5, HIT_DMG = 1 / 169;

interface RouteSample { x: number; y: number; z: number; width_left: number; width_right: number }

const G = 9.81, WHEEL_R = 0.34;
export const STEP = 2;     // lane resolution, m
const PAINTS = [0x15181d, 0x0c1a33, 0xb8bcc2, 0x6b0f12, 0x1f3d2b];   // gunmetal, deep blue, silver, oxblood, racing green
/** Rival names and skills (fraction of the car's grip they use). Spread so a decent driver beats some and has to work for the rest. */
/** The computer drivers, strongest first: #Bot1 .. #Bot5 (username.ts: '#' marks a bot, no player name can have one). */
export const RIVALS = [
  { skill: 0.95, line: -1.8, push: 1 },
  { skill: 0.92, line: 1.6, push: 0.7 },
  { skill: 0.89, line: -0.6, push: 0.4 },
  { skill: 0.85, line: 0.8, push: 0 },
  { skill: 0.81, line: 2.2, push: 0 },
].map((r, i) => ({ ...r, name: botName(i) }));
const X = new THREE.Vector3(1, 0, 0), UP = new THREE.Vector3(0, 1, 0);

/** What the default car can do (from its physics JSON): limits for the speed profiles. */
export interface CarLimits { mu: number; muX: number; power: number; mass: number; dragArea: number }
export function limitsOf(phys: any): CarLimits {
  const p = Math.max(...phys.engine.torque_curve.map(([rpm, t]: [number, number]) => (t * rpm * 2 * Math.PI) / 60));
  return {
    mu: Math.min(phys.tire_front.lateral.mu, phys.tire_rear?.lateral.mu ?? phys.tire_front.lateral.mu),
    muX: phys.tire_front.longitudinal.mu,
    power: p * (phys.drivetrain?.efficiency ?? 0.9),
    mass: phys.chassis.mass_kg,
    dragArea: phys.aero?.drag_area_m2 ?? 0.7,
  };
}

/** The route as a closed, smoothed driving line every 2 m: centre (ground height), right vector, room either side, curvature. */
export class Lane {
  readonly pts: THREE.Vector3[];
  readonly right: THREE.Vector3[] = [];
  readonly wl: number[] = [];
  readonly wr: number[] = [];
  readonly curv: number[] = [];
  readonly length: number;
  readonly n: number;

  constructor(samples: RouteSample[]) {
    const src = samples.map((p) => new THREE.Vector3(p.x, p.z, -p.y));   // core Z-up -> three (x, z, -y)
    // resample to STEP m (closed loop)
    const m = src.length, raw: THREE.Vector3[] = [], wl: number[] = [], wr: number[] = [];
    for (let i = 0; i < m; i++) {
      const a = src[i], b = src[(i + 1) % m], d = a.distanceTo(b), k = Math.max(1, Math.round(d / STEP));
      for (let j = 0; j < k; j++) {
        raw.push(a.clone().lerp(b, j / k));
        wl.push(samples[i].width_left); wr.push(samples[i].width_right);
      }
    }
    const n = raw.length;
    // round the corners: the route turns 90 degrees within one 7 m sample; a car takes them wide
    let cur = raw.map((p) => p.clone());
    const W = 5;
    for (let pass = 0; pass < 4; pass++) {
      const next = cur.map((p) => p.clone());
      for (let i = 0; i < n; i++) {
        let x = 0, z = 0;
        for (let k = -W; k <= W; k++) { const q = cur[(i + k + n) % n]; x += q.x; z += q.z; }
        next[i].x = x / (2 * W + 1); next[i].z = z / (2 * W + 1);
      }
      cur = next;
    }
    let acc = 0;
    const s: number[] = [];
    for (let i = 0; i < n; i++) { if (i) acc += cur[i].distanceTo(cur[i - 1]); s.push(acc); }
    const total = acc + cur[n - 1].distanceTo(cur[0]);
    // equal spacing again (smoothing bunches points in corners), then tangents and curvature
    const pts: THREE.Vector3[] = [], segs = Math.round(total / STEP);
    for (let j = 0, i = 0; j < segs; j++) {
      const target = (j * total) / segs;
      while (i < n - 1 && s[i + 1] <= target) i++;
      const s1 = i + 1 < n ? s[i + 1] : total;
      pts.push(cur[i].clone().lerp(cur[(i + 1) % n], (target - s[i]) / Math.max(1e-6, s1 - s[i])));
      this.wl.push(wl[i]); this.wr.push(wr[i]);
    }
    this.n = segs;
    const head: number[] = [];
    for (let i = 0; i < segs; i++) {
      const a = pts[(i - 1 + segs) % segs], b = pts[(i + 1) % segs];
      head.push(Math.atan2(b.x - a.x, b.z - a.z));
      this.right.push(new THREE.Vector3(-(b.z - a.z), 0, b.x - a.x).normalize());   // forward x up
    }
    for (let i = 0; i < segs; i++) {
      // heading change over +-3 points (12 m) / 12 m
      let d = head[(i + 3) % segs] - head[(i - 3 + segs) % segs];
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      this.curv.push(Math.abs(d) / (6 * STEP));
    }
    this.pts = pts;
    this.length = segs * STEP;   // points are total/segs apart: within 0.1 % of STEP
  }

  wrap(s: number) { return ((s % this.length) + this.length) % this.length; }
  idx(s: number) { return Math.floor(this.wrap(s) / STEP) % this.n; }

  /** Point at arc length s, lat metres right of the line (ground height of the line; the car keeps its own). */
  at(s: number, lat: number, out: THREE.Vector3) {
    s = this.wrap(s);
    const i = Math.floor(s / STEP) % this.n, j = (i + 1) % this.n, f = s / STEP - Math.floor(s / STEP);
    out.lerpVectors(this.pts[i], this.pts[j], f);
    out.x += (this.right[i].x * (1 - f) + this.right[j].x * f) * lat;
    out.z += (this.right[i].z * (1 - f) + this.right[j].z * f) * lat;
    return out;
  }

  /** Room either side of the line at s (route half-widths, less a car's half width and a margin). */
  room(s: number) { const i = this.idx(s); return { left: this.wl[i] - 1.9, right: this.wr[i] - 1.9 }; }

  /** Arc length of the lane point nearest p (whole lane; fine for a one-off at the start). */
  project(p: { x: number; z: number }) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < this.n; i++) { const d = (this.pts[i].x - p.x) ** 2 + (this.pts[i].z - p.z) ** 2; if (d < bd) { bd = d; best = i; } }
    return best * STEP;
  }

  /** Speed profile for one driver: corner limits, then braking zones (two backward passes round the loop). */
  profile(aLat: number, aBrake: number, vmax: number) {
    const v = this.curv.map((k) => Math.min(vmax, Math.sqrt(aLat / Math.max(1e-5, k))));
    for (let pass = 0; pass < 2; pass++)
      for (let i = this.n - 1; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[(i + 1) % this.n] ** 2 + 2 * aBrake * STEP));
    return v;
  }
}

/** rivals' small parts (AiCar.detail) are drawn within this distance of the camera */
const DETAIL_M = 30;

interface AiCar {
  name: string;
  root: THREE.Group;
  model: THREE.Object3D;
  shadow: THREE.Object3D | null;
  body: RAPIER.RigidBody;
  wheels: { node: THREE.Object3D; rest: THREE.Quaternion }[];
  light: THREE.PointLight | null;
  /** small parts drawn only near the camera (interior, brake discs, calipers, exhaust, plate, underbody) and whether they are shown */
  detail: THREE.Object3D[]; detailOn: boolean;
  /** merged wheel meshes (merge.ts mergeSpinningWheels): userData.spin = wheel angle */
  spinners: THREE.Mesh[];
  /** arc length, speed, lateral offset (+ = right of the line), lateral target, preferred line */
  s: number; v: number; lat: number; latTarget: number; line: number;
  vprof: number[]; aGrip: number;
  spin: number; y: number; yTick: number;
  parked: boolean;
  /** crash state: sideways slide (m/s, + = right), yaw off the lane heading and its rate (rad, rad/s), damage 0..1, out of the race */
  latV: number; yawOff: number; yawRate: number; dmg: number; wrecked: boolean;
  /** how hard this driver leans on a car it cannot pass (0 = waits behind, 1 = bumper to bumper) */
  push: number;
  collider: RAPIER.Collider;
  prevPos: THREE.Vector3; prevQuat: THREE.Quaternion;
  pos: THREE.Vector3; quat: THREE.Quaternion;
}

export type AiMode = 'off' | 'race';

export class AiTraffic {
  readonly cars: AiCar[] = [];
  mode: AiMode = 'off';
  /** race: cars wait on the grid until go() */
  held = true;
  readonly lane: Lane;
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private of = new THREE.Vector3();
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  private player = new THREE.Vector3();
  private playerV = 0;
  private playerS = 0;
  private grid: { s: number; lat: number }[] = [];

  private constructor(private pw: PhysicsWorld, samples: RouteSample[]) {
    this.lane = new Lane(samples);
  }

  /** Must run after the city's colliders are queryable (after the first world.step()). */
  static async create(scene: THREE.Scene, pw: PhysicsWorld, cfg: CarVisualConfig, samples: RouteSample[], count: number, black: boolean, phys: any) {
    const ai = new AiTraffic(pw, samples);
    if (!count) return ai;
    const lim = limitsOf(phys);
    // The traffic version of the car (lod_model: same parts and materials, ~28k triangles, 1k
    // textures): the player's hero model is dented by the damage system, these never are. The AI
    // cars (and remote players, net.ts) share it, geometry and all.
    const gltf = await loadGLTF(assetUrl(cfg.lod_model ?? cfg.model));
    const blackMat = new THREE.MeshStandardMaterial({ name: 'ai_black', color: 0x000000, roughness: 0.6, metalness: 0 });
    // Black paint: reduced base specular + a thin, sharp clear coat (measured in the night test).
    const blackPaint = new THREE.MeshPhysicalMaterial({
      name: 'ai_black_paint', color: 0x000000, roughness: 0.6, metalness: 0, specularIntensity: 0.2, clearcoat: 0.15, clearcoatRoughness: 0.05,
    });
    const cb = cfg.collision_box;
    for (let i = 0; i < count; i++) {
      const rival = RIVALS[i % RIVALS.length];
      const model = gltf.scene.clone(true);
      const wheels: AiCar['wheels'] = [];
      for (const name of Object.values(cfg.wheel_nodes)) {
        const node = model.getObjectByName(name);
        if (node) wheels.push({ node, rest: node.quaternion.clone() });
      }
      // The body follows the lane on the ground, the wheels stay at their modelled hubs: drop the
      // model so the hub sits at the rolling radius (the modelled tyre is 0.345 m).
      if (wheels.length) model.position.y = WHEEL_R - wheels[0].node.position.y;
      if (!black) setupCarMaterials(model, cfg, PAINTS[i % PAINTS.length], false);
      else {
        model.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          m.castShadow = true;
          m.receiveShadow = false;
          const mat = materialsOf(m)[0];
          if (mat.name === 'light_beam') { m.visible = false; return; }
          m.material = mat.name === cfg.paint_material ? blackPaint : blackMat;
        });
      }
      if (new URLSearchParams(location.search).get('merge') !== '0') mergeStaticMeshes(model, wheels.map((w) => w.node));   // ~89 meshes -> one per material (the wheels spin: kept)
      // Draw calls per rival (46 meshes, each costs CPU in three's WebGPU backend, measured as most of a race frame):
      //  - headlight shadows: only the outer shell and the tyres cast (45 -> 12 casters); interior, lights, discs, calipers,
      //    exhaust, plate and underbody all sit inside that silhouette, so the shadow is the same;
      //  - beyond DETAIL_M the parts hidden by the night, the fog and tinted glass are not drawn (46 -> 30 draws).
      // the four wheels: one mesh per material, spun in the vertex shader (merge.ts); ?merge=0 keeps the separate nodes
      applyPlate(model, rival.name);   // #BOT1 on the plate
      const spinners = wheels.length === 4 && new URLSearchParams(location.search).get('merge') !== '0' ? mergeSpinningWheels(model, wheels.map((w) => w.node)) : [];
      const detail: THREE.Object3D[] = [];
      const casters: THREE.Mesh[] = [];
      model.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        if (/^merged_(paint|trim|carbon|rubber)$|_tyre_\d$|^wheels_tyre/.test(m.name)) casters.push(m);
        if (/^interior|_disc$|^exhaust_tips|^plate$|mirror_glass|^underbody_merged|^wheels_disc$/.test(m.name)) detail.push(m);
      });
      if (casters.length >= 4 && !black) model.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = casters.includes(o as THREE.Mesh); });
      const root = new THREE.Group();
      root.name = `ai_${i}`;
      root.add(model);
      drawEarly(model);
      let shadow: THREE.Object3D | null = null;
      if (!black) root.add(shadow = createContactShadow(cb.size_m[0] * 1.22, cb.size_m[2] * 1.16, cb.centre_in_model_m[2]));
      scene.add(root);
      // One unshadowed spot per car (cheap): lights up the road ahead, walls and the player as it
      // passes. The light set never changes (that recompiles materials): 'off' parks the cars far below the city instead.
      // A POINT light on the road ahead of the nose, not a spot at the lenses: spots are evaluated for every pixel of
      // the frame (five rivals = five per-pixel lights, even switched off in free roam, ~1.5 ms at 1080p on the iGPU),
      // point lights go through the clustered path and cost only where their pool reaches.
      let light: THREE.PointLight | null = null;
      if (!black) {
        light = new THREE.PointLight(0xfff3e0, AI_BEAM, 12, 2);
        light.position.set(0, BEAM_Y, cb.size_m[2] / 2 + BEAM_AHEAD);
        root.add(light);
      }
      const body = pw.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
      // Box from 0.15 m (nothing wedges under it) to 1.0 m: BELOW the top of the player's hull (1.2 m).
      // With equal heights the two top edges met edge-on and a player pushing against a side-on AI
      // car climbed it and rolled over. No bounce either: the AI car is immovable.
      const [sx, , sz] = cb.size_m, [cx, , cz] = cb.centre_in_model_m;
      const top = 1.0, bottom = 0.15;
      const collider = pw.world.createCollider(RAPIER.ColliderDesc.cuboid(sx / 2, (top - bottom) / 2, sz / 2).setTranslation(cx, (top + bottom) / 2, cz)
        .setFriction(0.3).setRestitution(0).setCollisionGroups(GROUP_CAR), body);
      const aLat = rival.skill * 0.82 * lim.mu * G, aBrake = rival.skill * 0.85 * lim.muX * G;
      const car: AiCar = {
        name: rival.name, root, model, shadow, body, wheels: spinners.length ? [] : wheels, spinners, light, detail, detailOn: true,
        s: 0, v: 0, lat: rival.line, latTarget: rival.line, line: rival.line,
        vprof: ai.lane.profile(aLat, aBrake, 75), aGrip: rival.skill * 0.6 * lim.muX * G,   // driven wheels carry ~60 % of the weight
        spin: 0, y: 0, yTick: 0, parked: false,
        latV: 0, yawOff: 0, yawRate: 0, dmg: 0, wrecked: false, push: rival.push, collider,
        prevPos: new THREE.Vector3(), prevQuat: new THREE.Quaternion(), pos: new THREE.Vector3(), quat: new THREE.Quaternion(),
      };
      (car as AiCar & { lim: CarLimits }).lim = lim;
      ai.cars.push(car);
    }
    ai.setMode('off');
    return ai;
  }

  /**
   * Grid for a race: the player's start pose fixes slot 0's row. Two columns, rows 8 m apart;
   * the player starts in the middle of the field (P4 of 6), rivals ahead and behind.
   * Returns the player's lateral offset from the lane (their column, + = right).
   */
  setGrid(playerStart: { x: number; y: number; z: number }) {
    const s0 = this.lane.project(playerStart);
    const col = 2.2;
    const slots: { s: number; lat: number }[] = [];
    const total = this.cars.length + 1, playerSlot = Math.min(3, this.cars.length);
    for (let k = 0; k < total; k++) slots.push({ s: s0 + (playerSlot - k) * 8, lat: k % 2 ? col : -col });
    const mine = slots.splice(playerSlot, 1)[0];
    this.grid = slots;
    this.playerS = s0;
    return mine.lat;
  }

  /** Race: on the grid, held (go() releases them). Off: parked out of sight, out of every query. */
  setMode(mode: AiMode) {
    this.mode = mode;
    this.held = true;
    for (const c of this.cars) {
      c.model.visible = mode === 'race';
      if (c.shadow) c.shadow.visible = mode === 'race';
      if (c.light) c.light.intensity = mode === 'race' ? AI_BEAM : 0;
      c.body.setEnabled(mode === 'race');
    }
    this.reset();
  }

  go() { this.held = false; }

  /** Back to the grid (race) or out of sight (off). */
  reset() {
    this.held = true;
    this.player.set(0, 0, 0); this.playerV = 0;
    for (const [i, c] of this.cars.entries()) {
      c.v = 0; c.parked = false; c.spin = 0;
      c.latV = c.yawOff = c.yawRate = c.dmg = 0; c.wrecked = false;
      if (this.mode === 'race') {
        const g = this.grid[i] ?? { s: 40 + 10 * i, lat: c.line };
        c.s = this.lane.wrap(g.s); c.lat = c.latTarget = g.lat;
        this.lane.at(c.s, c.lat, c.pos);
        c.y = this.ground(c.pos.x, c.pos.z, c.pos.y + 30) ?? c.pos.y;
        c.pos.y = c.y;
        this.orient(c, 0);
      } else {
        c.pos.set(0, -500 - 10 * i, 0); c.quat.identity();
      }
      c.prevPos.copy(c.pos); c.prevQuat.copy(c.quat);
      c.body.setTranslation(c.pos, true);
      c.body.setRotation(c.quat, true);
      c.root.position.copy(c.pos); c.root.quaternion.copy(c.quat);
    }
  }

  /** Debug/tests: stop car i at arc length s (or at a free pose); it stays until reset(). */
  park(i: number, s: number, pose?: { pos: THREE.Vector3; yaw: number }) {
    const c = this.cars[i];
    if (!c) return;
    c.parked = true; c.v = 0; c.s = this.lane.wrap(s);
    if (pose) {
      c.pos.copy(pose.pos);
      c.quat.setFromAxisAngle(UP, pose.yaw);
      c.pos.y = this.ground(c.pos.x, c.pos.z, c.pos.y + 3) ?? c.pos.y;
    } else {
      this.lane.at(c.s, c.lat, c.pos);
      c.pos.y = this.ground(c.pos.x, c.pos.z, c.pos.y + 30) ?? c.pos.y;
      this.orient(c, 0);
    }
    c.y = c.pos.y;
    c.prevPos.copy(c.pos); c.prevQuat.copy(c.quat);
    c.body.setTranslation(c.pos, true);
    c.body.setRotation(c.quat, true);
  }

  /**
   * Shader warm-up (loading screen): park every car in the player's headlight beam so the first
   * render builds all their pipelines, shadow pass included. Call setMode() afterwards.
   */
  stage(ground: THREE.Vector3, yaw: number) {
    for (const c of this.cars) { c.model.visible = true; if (c.shadow) c.shadow.visible = true; if (c.light) c.light.intensity = AI_BEAM; c.body.setEnabled(true); }
    for (let i = 0; i < this.cars.length; i++) {
      const d = 9 + 6 * i;
      this.park(i, 0, { pos: new THREE.Vector3(ground.x + Math.sin(yaw) * d, ground.y, ground.z + Math.cos(yaw) * d), yaw });
    }
  }

  /** Static ground under (x, z) from height top down len m, ignoring every car and piece of debris (dynamic + kinematic bodies). */
  groundAt(x: number, z: number, top: number, len = 60) { return this.ground(x, z, top, len); }
  private ground(x: number, z: number, top: number, len = 60): number | null {
    this.ray.origin = { x, y: top, z };
    const hit = this.pw.world.castRay(this.ray, len, true,
      RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC, GROUP_VIEW);
    return hit ? top - hit.timeOfImpact : null;
  }

  /** Heading along the lane, plus the angle of any sideways move. */
  private orient(c: AiCar, latRate: number) {
    // flat on the road: heading only (yaw), never pitch or roll. Own vectors: f, x and up must not share storage.
    const f = this.lane.at(c.s + 2.5, c.lat, this.of).sub(this.lane.at(c.s - 2.5, c.lat, this.b)).setY(0).normalize();
    if (c.v > 0.5 && latRate) f.applyAxisAngle(UP, -Math.atan2(latRate, c.v));
    c.quat.setFromAxisAngle(UP, Math.atan2(f.x, f.z) - c.yawOff);
  }

  /** Arc length of a point near the lane: projection on the 2 m segment around a hint. */
  private sOf(p: { x: number; z: number }, hint: number) {
    let best = hint, bd = Infinity;
    for (let d = -30; d <= 30; d += STEP) {
      const s = hint + d, q = this.lane.at(s, 0, this.a), dd = (q.x - p.x) ** 2 + (q.z - p.z) ** 2;
      if (dd < bd) { bd = dd; best = s; }
    }
    return bd > 60 * 60 ? this.lane.project(p) : this.lane.wrap(best);
  }

  /** One physics tick (before world.step()). player = the player's chassis position. */
  tick(dt: number, player: { x: number; y: number; z: number }) {
    if (this.mode === 'off') return;
    this.tickNo++;
    this.dt = dt;
    this.playerV = this.player.lengthSq() === 0 ? 0 : Math.hypot(player.x - this.player.x, player.z - this.player.z) / dt;
    this.player.set(player.x, player.y, player.z);
    this.playerS = this.sOf(player, this.playerS);
    const L = this.lane.length;
    const others: { car: AiCar | null; p: THREE.Vector3; v: number; lat: number }[] =
      [{ car: null, p: this.player, v: this.playerV, lat: this.latOf(this.player, this.playerS) }, ...this.cars.map((o) => ({ car: o, p: o.pos, v: o.v, lat: o.lat }))];
    for (const c of this.cars) {
      c.prevPos.copy(c.pos); c.prevQuat.copy(c.quat);
      // headlight pool: fades out as the player's car comes under it (a rival close behind used to flood the car white)
      if (c.light) {
        const fw = this.a.set(0, 0, 1).applyQuaternion(c.quat);
        const lx = c.pos.x + fw.x * (BEAM_AHEAD + 2.2) - player.x, lz = c.pos.z + fw.z * (BEAM_AHEAD + 2.2) - player.z;
        const k = Math.min(1, Math.max(0, (Math.hypot(lx, lz) - 2.5) / 4.5));
        c.light.intensity = c.wrecked ? 0 : AI_BEAM * k * k * (3 - 2 * k);
      }
      const still = c.v < 0.05 && Math.abs(c.latV) < 0.05 && Math.abs(c.yawRate) < 0.02;
      if (this.held || ((c.parked || c.wrecked) && still)) { c.body.setNextKinematicTranslation(c.pos); c.body.setNextKinematicRotation(c.quat); continue; }
      const i = this.lane.idx(c.s);
      // out of the race (parked for a test, or wrecked): no driver, it only rolls to a stop from whatever hit it
      const driven = !c.parked && !c.wrecked;
      // spun round (more than ~35 deg off the road): brake to a stop, gather it up, then go again
      const spun = Math.abs(c.yawOff) > 0.6;
      let target = driven && !spun ? c.vprof[(i + 1) % this.lane.n] * (1 - 0.3 * Math.min(1, c.dmg)) : 0;
      // mild catch-up: a rival far ahead of the player eases off, one far behind pushes (up to 5 %)
      let gap = c.s - this.playerS;
      if (gap > L / 2) gap -= L; else if (gap < -L / 2) gap += L;
      target *= 1 - 0.07 * Math.max(-1, Math.min(1, gap / 250));
      // traffic in front: the player or another rival, inside the car's own track
      const fwd = this.a.set(0, 0, 1).applyQuaternion(c.quat);
      const look = 14 + c.v * 0.9;
      let bF = Infinity, bV = 0, bLat = 0;
      for (const o of others) {
        if (o.car === c) continue;
        const dx = o.p.x - c.pos.x, dz = o.p.z - c.pos.z;
        const f = dx * fwd.x + dz * fwd.z, l = dz * fwd.x - dx * fwd.z;
        if (f > 0 && f < look && Math.abs(l) < 2.3 && f < bF) { bF = f; bV = o.v; bLat = o.lat; }
      }
      const room = this.lane.room(c.s);
      if (bF < Infinity) {
        if (bV < target - 1) {
          // pass on the side with more room, 3 m clear of it
          const left = bLat - 3, right = bLat + 3;
          const goRight = right <= room.right && (bLat <= c.lat || left < -room.left);
          c.latTarget = goRight ? right : left >= -room.left ? left : right;
        }
        // stuck behind it: the patient drivers hold 8 m, the pushy ones close right up and lean on its bumper
        if (Math.abs(c.lat - bLat) < 2.3) target = Math.min(target, Math.max(0, bV + c.push * 1.5 + (bF - (8 - 3.2 * c.push)) * 0.8));
      } else c.latTarget += (c.line - c.latTarget) * Math.min(1, dt * 0.4);
      c.latTarget = Math.max(-room.left, Math.min(room.right, c.latTarget));
      // longitudinal: grip / power / drag limited acceleration, braking to the profile
      const lim = (c as AiCar & { lim: CarLimits }).lim;
      const drag = (0.5 * 1.2 * lim.dragArea * c.v * c.v) / lim.mass;
      const acc = Math.min(c.aGrip, lim.power / (lim.mass * Math.max(3, c.v))) - drag;
      // a car with no driver (wrecked, parked) only rolls out; a driven one brakes
      c.v = target > c.v ? Math.min(target, c.v + acc * dt) : Math.max(target, c.v - (driven ? 11 : 3.5) * dt);
      // lateral: at most 2.5 m/s and never sharper than the speed allows; no steering while it slides or has no driver
      const sliding = Math.abs(c.latV) > 0.4 || spun || !driven;
      const maxLat = sliding ? 0 : Math.min(2.5, 0.25 + c.v * 0.12) * dt;
      let dl = Math.max(-maxLat, Math.min(maxLat, c.latTarget - c.lat));
      const steerRate = dl / dt;   // the heading leans into a lane change, not into a crash slide
      // crash motion: the sideways slide scrubs off on the tyres (7 m/s^2); the kerb or wall ends it and costs speed
      if (c.latV !== 0) {
        dl += c.latV * dt;
        c.latV -= Math.sign(c.latV) * Math.min(Math.abs(c.latV), 7 * dt);
        const edge = c.lat + dl > room.right + 0.6 ? room.right + 0.6 : c.lat + dl < -room.left - 0.6 ? -room.left - 0.6 : null;
        if (edge !== null) {
          const hit = Math.abs(c.latV);
          this.damage(c, hit);
          dl = edge - c.lat; c.latV = 0; c.v *= 0.7;
        }
      }
      if (c.yawRate !== 0 || c.yawOff !== 0) {
        c.yawOff += c.yawRate * dt;
        c.yawRate *= Math.exp(-2.2 * dt);
        // the driver (or the tyres, once it has stopped sliding) pulls the car straight again
        if (driven || c.v < 1) c.yawOff -= c.yawOff * Math.min(1, (spun ? 0.9 : 2.4) * dt);
        if (Math.abs(c.yawOff) < 0.002 && Math.abs(c.yawRate) < 0.002) c.yawOff = c.yawRate = 0;
      }
      c.lat += dl;
      c.s = this.lane.wrap(c.s + c.v * dt);
      c.spin += (c.v * dt) / WHEEL_R;
      this.lane.at(c.s, c.lat, c.pos);
      // follow the ground (streamed city: keep the last height where nothing is loaded)
      // (the city streams in around the player: a rival far ahead may cross tiles that aren't loaded yet, so when the
      // short probe finds nothing, a tall one re-acquires the road once they are)
      if (++c.yTick % 8 === 0) {
        const y = this.ground(c.pos.x, c.pos.z, c.y + 2.5, 5) ?? this.ground(c.pos.x, c.pos.z, c.y + 25, 50);
        if (y !== null) c.y = y;
      }
      c.pos.y = c.y;
      this.orient(c, steerRate);
      c.body.setNextKinematicTranslation(c.pos);
      c.body.setNextKinematicRotation(c.quat);
    }
  }

  /** dv: this tick's part of a crash. A crash arrives over several ticks: damage is charged on the event's running total. */
  private damage(c: AiCar, dv: number) {
    const ev = c as AiCar & { evDv?: number; evTick?: number };
    if (ev.evTick === undefined || this.tickNo - ev.evTick > 36) ev.evDv = 0;   // 0.15 s apart = a new crash
    ev.evTick = this.tickNo;
    const f = (x: number) => Math.max(0, x - HIT_FREE) ** 2 * HIT_DMG;
    const before = ev.evDv ?? 0;
    ev.evDv = before + dv;
    c.dmg = Math.min(1, c.dmg + f(ev.evDv) - f(before));
    if (c.dmg >= 1 && !c.wrecked) { c.wrecked = true; this.onWreck(c.name); }
  }
  /** a rival has just been wrecked (HUD / audio hook) */
  onWreck: (name: string) => void = () => {};
  private tmpV = new THREE.Vector3();
  private tickNo = 0;
  private dt = 1 / 240;

  /**
   * After world.step(): share the player's collisions with rivals. The rival's body is kinematic, so the solver
   * treated it as an immovable wall and gave the player the whole velocity change. Two cars of about the same mass
   * split it: the player gets half of it back, the rival takes the other half (opposite direction) as a shove along
   * its lane, a slide across it, a yaw kick and damage. Returns true when a rival was touched this tick.
   */
  afterStep(playerCollider: RAPIER.Collider, playerBody: RAPIER.RigidBody, preV: THREE.Vector3, preW: THREE.Vector3): boolean {
    if (this.mode === 'off') return false;
    let hit: AiCar | null = null;
    for (const c of this.cars) {
      let touching = false;
      this.pw.world.contactPair(playerCollider, c.collider, (m) => { if (m.numContacts() > 0) touching = true; });
      if (touching) { hit = c; break; }
    }
    if (!hit) return false;
    const c = hit, lv = playerBody.linvel(), av = playerBody.angvel();
    const dvx = lv.x - preV.x, dvz = lv.z - preV.z, dv = Math.hypot(dvx, dvz);
    if (dv < 0.02) return true;   // resting against it
    playerBody.setLinvel({ x: (preV.x + lv.x) / 2, y: lv.y, z: (preV.z + lv.z) / 2 }, true);
    playerBody.setAngvel({ x: (preW.x + av.x) / 2, y: (preW.y + av.y) / 2, z: (preW.z + av.z) / 2 }, true);
    // the rival's half, in its own frame (forward along its heading, right across it)
    const i = this.lane.idx(c.s), right = this.lane.right[i];
    const fwd = this.tmpV.set(0, 0, 1).applyQuaternion(c.quat);
    const rx = -dvx / 2, rz = -dvz / 2;
    const along = rx * fwd.x + rz * fwd.z, across = rx * right.x + rz * right.z;
    c.v = Math.max(0, c.v + along);
    c.latV += across;
    // where the player is along the rival's length: a shove behind its middle swings the tail out (the nose turns the other way)
    const p = playerBody.translation(), lever = Math.max(-1, Math.min(1, ((p.x - c.pos.x) * fwd.x + (p.z - c.pos.z) * fwd.z) / 2.2));
    c.yawRate += across * lever * 0.55;
    // pushing is not crashing (same rule as the core: under 3 g of contact force nothing breaks)
    if (dv / 2 > 3 * G * this.dt) this.damage(c, dv / 2);
    return true;
  }

  private latOf(p: { x: number; z: number }, s: number) {
    const c = this.lane.at(s, 0, this.b), i = this.lane.idx(s);
    return (p.x - c.x) * this.lane.right[i].x + (p.z - c.z) * this.lane.right[i].z;
  }

  /** Draw between the last two ticks (alpha as for the player's car). */
  update(alpha: number, camera: THREE.Camera) {
    if (this.mode === 'off') return;
    for (const c of this.cars) {
      c.root.position.lerpVectors(c.prevPos, c.pos, alpha);
      c.root.quaternion.slerpQuaternions(c.prevQuat, c.quat, alpha);
      // hide the model in the fog (lights stay: changing the light set recompiles materials)
      const d2 = c.root.position.distanceToSquared(camera.position);
      c.model.visible = d2 < 230 * 230;
      const near = d2 < (c.detailOn ? DETAIL_M + 4 : DETAIL_M) ** 2;   // hysteresis: no flicker at the edge
      if (near !== c.detailOn) { c.detailOn = near; for (const o of c.detail) o.visible = near; }
      for (const w of c.wheels) w.node.quaternion.setFromAxisAngle(X, c.spin).multiply(w.rest);
      for (const m of c.spinners) m.userData.spin = c.spin;
    }
  }
}
