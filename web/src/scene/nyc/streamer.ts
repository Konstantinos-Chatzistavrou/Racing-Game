// New York tile streamer (docs/nyc_runtime.md; data contract docs/nyc_tiles.md).
// Keeps rings of tiles around the car, all work spread over frames:
//   near  (LOD0)  ground.glb + bld.glb + props.json   within NEAR_LOAD m of the car (unload beyond NEAR_KEEP)
//   far   (LOD1)  far.glb                              within FAR_LOAD m (unload beyond FAR_KEEP); hidden while the tile's near part is shown
//   col           col.json -> Rapier cuboids + ground  within COL_LOAD m (unload beyond COL_KEEP)
// Pipeline per tile: fetch + decode (GLTFLoader, meshopt) is async -> parsed objects wait in a commit queue -> update() drains it under a
// per-frame time budget: scene.add, one mesh revealed per job (its GPU upload happens at its first draw, forced once even if off-screen), a
// batch of colliders per job. A slow frame (dt > SLOW_DT) pauses commits. Materials are shared singletons (never disposed with a tile); unloading
// disposes geometries only. Tile roots are static (matrixAutoUpdate off) and frustum-tested as a whole.
import * as THREE from 'three/webgpu';
import RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from '../../physics/world';
import { gltfLoader } from '../loaders';
import { createPlaceholderFacade, createPlaceholderGround, createPlaceholderRoof } from './placeholders';
import { createGroundMaterials } from './groundMaterials';
import { createFacadeMaterial, createFarFacadeMaterial, createRoofMaterial } from './facade';
import { Breaches } from './breach';
import { NycProps, type BuildingColliderBox } from './props';
import { applyNycAtmosphere, type NycAtmosphere } from './atmosphere';
import { generateProceduralNycTile, type ProceduralNycTileData } from './infiniteNyc';
import { CityBatcher } from './batch';

// ---- content discovery (see index.ts for the expected exports) -------------------------------------------------------------------------
export interface NycPropsLike {
  setTile(key: string, data: unknown): void;
  setTileBuildings?(key: string, boxes: BuildingColliderBox[] | undefined, z?: number): void;
  removeTile(key: string): void;
  update(
    dt: number,
    carPos?: THREE.Vector3,
    carVel?: THREE.Vector3,
    onImpact?: (impulse: number, kind?: 'pole' | 'shop' | 'wall', wx?: number, wz?: number) => void,
  ): void;
  breakNearestPole?(
    carPos: THREE.Vector3,
    carVel?: THREE.Vector3,
    maxDist?: number,
    onImpact?: (impulse: number, kind?: 'pole' | 'shop' | 'wall', wx?: number, wz?: number) => void,
  ): boolean;
  primeLights?(): void;
  dispose(): void;
}
export interface NycMaterials {
  ground: Record<string, THREE.Material>;
  facade: THREE.Material;
  facadeFar: THREE.Material;
  roof: THREE.Material;
  source: string;
}

/** Shared material singletons (one per name). */
export async function loadNycMaterials(): Promise<NycMaterials> {
  const src: string[] = [];
  const tryMake = <T>(fn: () => T, fallback: () => T, label: string): T => {
    try { const r = fn(); src.push(label + ':real'); return r; } catch (e) { console.warn(`nyc: ${label} threw, using the placeholder`, e); }
    src.push(label + ':placeholder');
    return fallback();
  };
  const ground = { ...createPlaceholderGround(), ...tryMake<Record<string, THREE.Material>>(createGroundMaterials, () => ({}), 'ground') };
  const facade = tryMake(createFacadeMaterial, createPlaceholderFacade, 'facade');
  const facadeFar = tryMake(createFarFacadeMaterial, () => facade, 'facadeFar');
  const roof = tryMake(createRoofMaterial, createPlaceholderRoof, 'roof');
  return { ground, facade, facadeFar, roof, source: src.join(' ') };
}

async function createNycProps(scene: THREE.Scene, camera: THREE.Camera): Promise<NycPropsLike | null> {
  try { return new NycProps(scene, camera); } catch (e) { console.warn('nyc: NycProps constructor threw, no props', e); return null; }
}

// ---- types -----------------------------------------------------------------------------------------------------------------------------
const TILE = 256;
const AVENUE = 29 * Math.PI / 180;   // Manhattan's grid is rotated ~29 degrees east of north

interface IndexJson {
  tile?: number; spawn?: { x: number; y: number; heading: number };
  tiles: Record<string, { files?: string[]; bbox?: number[] }>;
}
interface ColJson { ground?: number; buildings?: { cx: number; cy: number; z0: number; z1: number; hx: number; hy: number; yaw: number }[] }
type Part = 'ground' | 'bld' | 'far';

interface Tile {
  key: string; ix: number; iy: number;
  has: Record<Part | 'col' | 'props', boolean>;
  box: THREE.Box3;                 // three coordinates, for the frustum test
  cx: number; cz: number;          // centre, three coordinates
  group: THREE.Group;              // everything visual of the tile; static
  d: number;                       // distance from the car to the tile footprint (m)
  near: 0 | 1 | 2 | 3;             // 0 none, 1 loading, 2 committing, 3 shown
  far: 0 | 1 | 2 | 3;
  col: 0 | 1 | 2 | 3;
  nearGroup: THREE.Group | null; farGroup: THREE.Group | null;
  colliders: RAPIER.Collider[];
  buildingCols?: { box: BuildingColliderBox; col: RAPIER.Collider; breached: boolean }[];
  propsSet: boolean;
  forced: number;                  // meshes revealed but not drawn yet (tile must stay un-culled so their upload happens)
  gen: { near: number; far: number; col: number };   // bumped on every unload of that kind: stale async results are dropped
  procedural?: boolean;
  procData?: ProceduralNycTileData | null;
}

export interface NycSpawn { x: number; y: number; z: number; heading: number }   // game frame (z up); heading = angle from east, CCW (rad)
export interface NycStats {
  near: number; far: number; col: number; loading: number; queued: number; colliders: number; streamMs: number; streamMax: number;
  commitMs: number; tilesLoaded: number; loadMsAvg: number; geometries: number; textures: number; drawCalls: number; triangles: number; pipelines: number;
}
export interface NycOptions {
  surfaces: { asphalt: number; pavement: number; wall: number };
  base?: string; nearLoad?: number; nearKeep?: number; farLoad?: number; farKeep?: number; colLoad?: number; colKeep?: number;
  receiveShadow?: boolean; debug?: boolean; budgetMs?: number; fogDensity?: number;
  /** share of the street trees drawn (and solid), 0..1: potato mode halves them (they are most of its triangles) */
  treeDensity?: number;
  onProgress?: (f: number) => void;
}

const SLOW_DT = 0.05;

/** Streams the NYC tile set around the car. update(carPos, dt) every frame (carPos in three coordinates). */
export class NycStreamer {
  readonly o: Required<Omit<NycOptions, 'surfaces' | 'onProgress'>> & { surfaces: NycOptions['surfaces']; onProgress?: (f: number) => void };
  private index: IndexJson | null = null;
  private tiles = new Map<string, Tile>();
  private mats!: NycMaterials;
  private props: NycPropsLike | null = null;
  private atm: NycAtmosphere | null = null;
  private readyP: Promise<void>;
  private spawn!: NycSpawn;
  private queue: { tile: Tile; kind: 'near' | 'far' | 'col'; gen: number; cost: number; run: () => void }[] = [];
  private inflight = { near: 0, far: 0, col: 0 };
  private pending = new Set<string>();   // "key:kind" being loaded
  private frustum = new THREE.Frustum(); private pv = new THREE.Matrix4();
  private lastPos = new THREE.Vector3(); private fwd = new THREE.Vector3(); private haveLast = false; private speed = 0;
  private sinceSelect = 99; private pause = 0;
  private warmMeshes: THREE.Mesh[] = [];
  private templates: Partial<Record<'ground' | 'bld' | 'far', THREE.BufferGeometry>> = {};
  private stat = { streamMs: 0, streamMax: 0, commitMs: 0, loaded: 0, loadMs: 0 };
  private overlay: HTMLDivElement | null = null; private overlayT = 0;
  private disposed = false;
  /** ?batchcity=1: every near tile's geometry goes into one buffer per material (docs/raw_city_pass.md) */
  private batcher: CityBatcher | null = null;
  private centre = new THREE.Vector3();

  constructor(private scene: THREE.Scene, private renderer: THREE.WebGPURenderer, private pw: PhysicsWorld, private camera: THREE.Camera, opts: NycOptions) {
    this.o = {
      base: '/assets/nyc/tiles/', nearLoad: 380, nearKeep: 460, farLoad: 1000, farKeep: 1150, colLoad: 260, colKeep: 330,
      receiveShadow: true, debug: false, budgetMs: 2.5, fogDensity: 0.0024, treeDensity: 1, ...opts,
    };
    this.atm = applyNycAtmosphere(this.scene, this.renderer, { fogDensity: this.o.fogDensity });
    this.breaches = new Breaches(this.scene, this.pw, {
      building: (h) => { const e = this.buildingOf.get(h); return e && !e.bc.breached ? { key: e.t.key, box: e.bc.box } : null; },
      find: (cx, cy) => {
        for (const t of this.tiles.values()) for (const bc of t.buildingCols ?? [])
          if (!bc.breached && Math.abs(bc.box.cx - cx) < 0.01 && Math.abs(bc.box.cy - cy) < 0.01) return { key: t.key, box: bc.box };
        return null;
      },
      replace: (key, box, descs) => {
        const t = this.tiles.get(key);
        const bc = t?.buildingCols?.find((x) => x.box === box);
        if (!t || !bc) return;
        const surf = (this.pw as unknown as { surfaceOf: Map<number, number> }).surfaceOf;
        surf.delete(bc.col.handle);
        this.buildingOf.delete(bc.col.handle);
        this.pw.world.removeCollider(bc.col, true);
        const i = t.colliders.indexOf(bc.col);
        if (i >= 0) t.colliders.splice(i, 1);
        bc.breached = true;
        for (const d of descs) { const c = this.pw.world.createCollider(d); t.colliders.push(c); surf.set(c.handle, this.o.surfaces.wall); }
      },
      burst: (wx, gy, wz, nx, nz, vx, vz, glass) => this.streetProps?.burst(wx, gy, wz, nx, nz, vx, vz, glass),
      facadeDepth: (from, dir, max) => {
        // the drawn facades of the tiles around the hole (once per breach; ~ms)
        const rc = this.facadeRay ??= new THREE.Raycaster();
        rc.set(from, dir); rc.near = 0; rc.far = max;
        const meshes: THREE.Object3D[] = [];
        for (const t of this.tiles.values()) {
          if (!t.nearGroup || this.dist(t, from.x, from.z) > 260) continue;
          t.nearGroup.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m.material === this.mats.facade) meshes.push(m); });
        }
        const hit = rc.intersectObjects(meshes, false)[0];
        return hit ? hit.distance : null;
      },
    });
    if (this.o.debug) {
      const d = document.createElement('div');
      d.style.cssText = 'position:fixed;left:8px;top:8px;z-index:50;font:11px/1.35 monospace;color:#9fe;background:#0008;padding:6px 8px;white-space:pre;pointer-events:none';
      document.body.appendChild(d);
      this.overlay = d;
    }
    // On by default (measured: 261 -> 208 draws, render CPU 17.9 -> 13.5 ms at the pinned vantage); ?batchcity=0 keeps
    // the per-tile path for A/B and for debugging a tile.
    if (typeof location === 'undefined' || new URLSearchParams(location.search).get('batchcity') !== '0') this.batcher = new CityBatcher(scene);
    this.readyP = this.init();
  }

  /** Resolves when the index, the materials, the spawn tile's colliders and the first ring are loaded and in the scene. */
  ready(): Promise<void> { return this.readyP; }
  spawnPoint(): NycSpawn { return this.spawn; }
  get materials(): NycMaterials { return this.mats; }
  tileCount() { return this.tiles.size; }

  // ---- init ---------------------------------------------------------------------------------------------------------------------------
  private async init() {
    this.o.onProgress?.(0.08);
    const [idx, mats, props] = await Promise.all([
      fetch(this.o.base + 'index.json').then((r) => { if (!r.ok) throw new Error(`NYC tiles missing (${r.status} ${this.o.base}index.json): run python3 tools/nyc/stub_tiles.py or build_tiles.py`); return r.json() as Promise<IndexJson>; }),
      loadNycMaterials(), createNycProps(this.scene, this.camera),
    ]);
    this.index = idx; this.mats = mats; this.props = props;
    if (props instanceof NycProps) props.treeDensity = this.o.treeDensity;
    this.o.onProgress?.(0.2);
    console.info(`nyc: ${Object.keys(idx.tiles).length} tiles, materials ${mats.source}, props ${props ? 'real' : 'none'}`);
    for (const [key, t] of Object.entries(idx.tiles)) {
      const [ix, iy] = key.split('_').map(Number);
      const f = t.files ?? [];
      const bb = t.bbox ?? [ix * TILE, iy * TILE, (ix + 1) * TILE, (iy + 1) * TILE, 150];
      const group = new THREE.Group();
      group.name = 'nyc_' + key;
      group.matrixAutoUpdate = false;
      this.tiles.set(key, {
        key, ix, iy, d: Infinity, near: 0, far: 0, col: 0, nearGroup: null, farGroup: null, colliders: [], propsSet: false, forced: 0, gen: { near: 0, far: 0, col: 0 }, group,
        has: { ground: f.some((n) => n.endsWith('.ground.glb')), bld: f.some((n) => n.endsWith('.bld.glb')), far: f.some((n) => n.endsWith('.far.glb')),
          col: f.some((n) => n.endsWith('.col.json')), props: f.some((n) => n.endsWith('.props.json')) },
        box: new THREE.Box3(new THREE.Vector3(bb[0], -5, -bb[3]), new THREE.Vector3(bb[2], Math.max(20, bb[4] + 10), -bb[1])),
        cx: (bb[0] + bb[2]) / 2, cz: -(bb[1] + bb[3]) / 2,
      });
    }
    this.spawn = await this.findSpawn();
    // prime: everything around the spawn, no budget, until the queue is dry
    this.centre.set(this.spawn.x, 0, -this.spawn.y);
    this.lastPos.copy(this.centre);
    const t0 = performance.now();
    let maxPending = 1;
    for (let i = 0; i < 4000; i++) {
      this.select(this.centre, true);
      this.drain(1e9);
      maxPending = Math.max(maxPending, this.pending.size + this.stat.loaded);
      this.o.onProgress?.(Math.min(0.95, 0.2 + 0.75 * (this.stat.loaded / Math.max(1, maxPending))));
      if (!this.pending.size && !this.queue.length) break;
      await new Promise((r) => setTimeout(r, 4));
    }
    this.o.onProgress?.(1.0);
    // the spawn tile's ground height (col.json of the spawn tile is loaded by now)
    const st = this.tiles.get(this.tileKey(this.spawn.x, this.spawn.y));
    this.spawn.z = (st && this.groundOf.get(st.key)) ?? 0;
    this.makeWarmMeshes();
    this.templates = {};   // the first tile's geometry may be unloaded later: do not keep its arrays alive
    this.updateVisibility(true);
    this.props?.primeLights?.();
    console.info(`nyc: first ring ready in ${Math.round(performance.now() - t0)} ms, ${this.tiles.size} indexed, spawn ${JSON.stringify(this.spawn)}`);
  }

  private groundOf = new Map<string, number>();
  private tileKey(x: number, y: number) { return `${Math.floor(x / TILE)}_${Math.floor(y / TILE)}`; }

  private async findSpawn(): Promise<NycSpawn> {
    const s = this.index!.spawn;
    if (s) return { x: s.x, y: s.y, z: 0, heading: s.heading };
    // nearest road segment to Times Square in the tile graph (wide roads preferred); else the avenue grid direction (southbound)
    try {
      if (this.tiles.has('0_0')) {
        const g = await fetch(this.o.base + '0_0.graph.json').then((r) => (r.ok ? r.json() : null));
        if (g) {
          let best: NycSpawn | null = null, bd = 60;
          for (const e of g.edges ?? []) {
            const pts: number[][] = e.pts ?? [g.nodes[e.a], g.nodes[e.b]];
            for (let i = 0; i + 1 < pts.length; i++) {
              const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
              const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
              if (L2 < 1e-6) continue;
              const t = Math.min(1, Math.max(0, -(ax * dx + ay * dy) / L2));
              const px = ax + t * dx, py = ay + t * dy, dist = Math.hypot(px, py) - Math.min(8, (e.w ?? 0) * 0.3);
              if (dist < bd) { bd = dist; best = { x: px, y: py, z: 0, heading: Math.atan2(dy, dx) }; }
            }
          }
          if (best) return best;
        }
      }
    } catch { /* fall through */ }
    return { x: 0, y: 0, z: 0, heading: Math.atan2(-Math.cos(AVENUE), -Math.sin(AVENUE)) };
  }

  // ---- selection: what should be loaded / unloaded ------------------------------------------------------------------------------------
  /** Distance from (px, pz) (three coords) to the tile's footprint rectangle. */
  private dist(t: Tile, px: number, pz: number) {
    const dx = Math.max(t.box.min.x - px, 0, px - t.box.max.x), dz = Math.max(t.box.min.z - pz, 0, pz - t.box.max.z);
    return Math.hypot(dx, dz);
  }

  private ensureProceduralRing(px: number, pz: number, radius: number) {
    const gx = px;
    const gy = -pz;
    const ix0 = Math.floor((gx - radius) / TILE);
    const ix1 = Math.floor((gx + radius) / TILE);
    const iy0 = Math.floor((gy - radius) / TILE);
    const iy1 = Math.floor((gy + radius) / TILE);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        const key = `${ix}_${iy}`;
        if (this.tiles.has(key)) continue;
        const bb = [ix * TILE, iy * TILE, (ix + 1) * TILE, (iy + 1) * TILE, 260];
        const group = new THREE.Group();
        group.name = 'nyc_proc_' + key;
        group.matrixAutoUpdate = false;
        this.tiles.set(key, {
          key, ix, iy, d: Infinity, near: 0, far: 0, col: 0, nearGroup: null, farGroup: null, colliders: [],
          propsSet: false, forced: 0, gen: { near: 0, far: 0, col: 0 }, group,
          has: { ground: true, bld: true, far: true, col: true, props: true },
          box: new THREE.Box3(new THREE.Vector3(bb[0], -5, -bb[3]), new THREE.Vector3(bb[2], bb[4] + 10, -bb[1])),
          cx: (bb[0] + bb[2]) / 2, cz: -(bb[1] + bb[3]) / 2,
          procedural: true, procData: null,
        });
      }
    }
  }

  private select(p: THREE.Vector3, prime = false) {
    const o = this.o;
    const want: { t: Tile; kind: 'near' | 'far' | 'col'; score: number }[] = [];
    const fwdOn = this.speed > 5;
    const now = performance.now();
    // priming (before the first frame) only loads the immediate ring; the rest streams in budgeted afterwards
    const nearR = prime ? Math.min(o.nearLoad, 300) : o.nearLoad, farR = prime ? Math.min(o.farLoad, 560) : o.farLoad;
    this.ensureProceduralRing(p.x, p.z, farR + TILE * 0.5);
    for (const t of this.tiles.values()) {
      t.d = this.dist(t, p.x, p.z);
      // forward bias: tiles ahead of a moving car load first (up to 150 m of priority)
      let bias = 0;
      if (fwdOn) { const dx = t.cx - p.x, dz = t.cz - p.z, l = Math.hypot(dx, dz) || 1; bias = 150 * Math.max(0, (dx * this.fwd.x + dz * this.fwd.z) / l); }
      const score = t.d - bias;
      // col
      if (t.has.col || t.has.ground) {
        if (t.col === 0 && t.d < o.colLoad && !this.retryLater(t, 'col', now)) want.push({ t, kind: 'col', score: score - 1000 });
        else if (t.col === 3 && t.d > o.colKeep) this.unloadCol(t);
      }
      if (t.has.ground || t.has.bld) {
        if (t.near === 0 && t.d < nearR && !this.retryLater(t, 'near', now)) want.push({ t, kind: 'near', score });
        else if (t.near === 3 && t.d > o.nearKeep) this.unloadNear(t);
      }
      if (t.has.far) {
        if (t.far === 0 && t.d < farR && !this.retryLater(t, 'far', now)) want.push({ t, kind: 'far', score: score + 400 });
        else if (t.far === 3 && t.d > o.farKeep) this.unloadFar(t);
      }
    }
    if (!want.length) return;
    want.sort((a, b) => a.score - b.score);
    const maxIn = prime ? { near: 12, far: 12, col: 16 } : { near: 3, far: 3, col: 4 };
    let started = 0;
    for (const w of want) {
      if (this.inflight[w.kind] >= maxIn[w.kind]) continue;
      if (!prime && w.kind !== 'col' && started >= 1) continue;   // one mesh-tile load started per selection pass
      this.startLoad(w.t, w.kind);
      if (w.kind !== 'col') started++;
    }
  }

  // ---- loading ------------------------------------------------------------------------------------------------------------------------
  private url(t: Tile, ext: string) { return `${this.o.base}${t.key}.${ext}`; }

  private startLoad(t: Tile, kind: 'near' | 'far' | 'col') {
    const id = t.key + ':' + kind;
    if (this.pending.has(id)) return;
    this.pending.add(id);
    this.inflight[kind]++;
    t[kind] = 1;
    const gen = t.gen[kind], t0 = performance.now();
    const done = () => { this.pending.delete(id); this.inflight[kind]--; };

    if (t.procedural) {
      Promise.resolve().then(() => {
        done();
        if (t.gen[kind] !== gen) return;
        if (!t.procData) t.procData = generateProceduralNycTile(t.ix, t.iy);
        const pd = t.procData;
        if (kind === 'col') {
          this.groundOf.set(t.key, pd.col.ground);
          t.col = 2;
          this.queueColliders(t, gen, pd.col);
        } else if (kind === 'far') {
          const fg = pd.farGroup;
          this.prepare(fg, 'far');
          t.farGroup = new THREE.Group();
          t.farGroup.add(fg);
          t.far = 2;
          this.stat.loaded++; this.stat.loadMs += performance.now() - t0;
          this.queue.push({ tile: t, kind: 'far', gen, cost: 0.3, run: () => this.commitFar(t) });
        } else {
          const grp = new THREE.Group();
          const meshes: THREE.Mesh[] = [];
          for (const [g, part] of [[pd.groundGroup, 'ground'], [pd.bldGroup, 'bld']] as const) {
            this.prepare(g, part);
            g.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
            grp.add(g);
          }
          t.nearGroup = grp; t.near = 2;
          this.stat.loaded++; this.stat.loadMs += performance.now() - t0;
          // Attach, then stop the scene graph from walking this static tile every frame: `matrixWorldAutoUpdate = false`
        // skips the subtree in Object3D.updateMatrixWorld (positions were baked by prepare(); nothing in a tile moves).
        this.queue.push({ tile: t, kind: 'near', gen, cost: 0.3, run: () => {
          grp.visible = true; t.group.add(grp); grp.updateMatrixWorld(true); grp.matrixWorldAutoUpdate = false; this.attach(t);
        } });
          for (const m of meshes) this.queue.push({ tile: t, kind: 'near', gen, cost: 0.8, run: () => this.reveal(t, m) });
          this.queue.push({ tile: t, kind: 'near', gen, cost: 0.2, run: () => this.finishNear(t, pd.props) });
        }
      });
      return;
    }

    const L = gltfLoader();
    const glb = (part: Part) => (t.has[part] ? L.loadAsync(this.url(t, part + '.glb')) : Promise.resolve(null));
    const json = (ext: string, has: boolean) => (has ? fetch(this.url(t, ext)).then((r) => (r.ok ? r.json() : null)).catch(() => null) : Promise.resolve(null));
    const fail = (e: unknown) => { done(); if (t.gen[kind] === gen) t[kind] = 0; console.warn(`nyc: ${id} failed`, e); this.failed.set(id, performance.now()); };
    if (kind === 'col') {
      json('col.json', t.has.col).then((c: ColJson | null) => {
        done();
        if (t.gen.col !== gen) return;
        this.groundOf.set(t.key, c?.ground ?? 0);
        t.col = 2;
        this.queueColliders(t, gen, c);
      }).catch(fail);
    } else if (kind === 'far') {
      glb('far').then((g) => {
        done();
        if (t.gen.far !== gen) return void (g && this.disposeObject(g.scene));
        t.farGroup = new THREE.Group();
        if (g) { this.prepare(g.scene, 'far'); t.farGroup.add(g.scene); }
        t.far = 2;
        this.stat.loaded++; this.stat.loadMs += performance.now() - t0;
        this.queue.push({ tile: t, kind: 'far', gen, cost: 0.3, run: () => this.commitFar(t) });
      }).catch(fail);
    } else {
      Promise.all([glb('ground'), glb('bld'), json('props.json', t.has.props)]).then(([gg, bb, props]) => {
        done();
        if (t.gen.near !== gen) { for (const g of [gg, bb]) g && this.disposeObject(g.scene); return; }
        const grp = new THREE.Group();
        const meshes: THREE.Mesh[] = [];
        for (const [g, part] of [[gg, 'ground'], [bb, 'bld']] as const) {
          if (!g) continue;
          this.prepare(g.scene, part);
          g.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
          grp.add(g.scene);
        }
        // ?batchcity=1: hand the tile's meshes to the per-material batch and keep only the ones it refused
        if (this.batcher) {
          const rest: THREE.Mesh[] = [];
          for (const m of meshes) if (!this.batcher.add(t.key, m)) rest.push(m);
          meshes.length = 0;
          for (const m of rest) meshes.push(m);
        }
        t.nearGroup = grp; t.near = 2;
        this.stat.loaded++; this.stat.loadMs += performance.now() - t0;
        // jobs: attach (hidden meshes), then one reveal per mesh (GPU upload spread over frames), then props + hide far
        // Attach, then stop the scene graph from walking this static tile every frame: `matrixWorldAutoUpdate = false`
        // skips the subtree in Object3D.updateMatrixWorld (positions were baked by prepare(); nothing in a tile moves).
        this.queue.push({ tile: t, kind: 'near', gen, cost: 0.3, run: () => {
          grp.visible = true; t.group.add(grp); grp.updateMatrixWorld(true); grp.matrixWorldAutoUpdate = false; this.attach(t);
        } });
        for (const m of meshes) this.queue.push({ tile: t, kind: 'near', gen, cost: 0.8, run: () => this.reveal(t, m) });
        this.queue.push({ tile: t, kind: 'near', gen, cost: 0.2, run: () => this.finishNear(t, props) });
      }).catch(fail);
    }
  }

  private failed = new Map<string, number>();
  private retryLater(t: Tile, kind: string, now: number) { const f = this.failed.get(t.key + ':' + kind); return f !== undefined && now - f < 10000; }

  /** Material swap, static matrices, culling flags, hidden until revealed. */
  private prepare(root: THREE.Object3D, part: Part) {
    root.updateMatrixWorld(true);
    const facadeMat = part === 'far' ? this.mats.facadeFar : this.mats.facade;
    root.traverse((o) => {
      o.matrixAutoUpdate = false;
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.castShadow = false;
      m.receiveShadow = this.o.receiveShadow;
      const old = m.material as THREE.Material;
      const name = old.name;
      const mat = name === 'facade'
        ? facadeMat
        : name === 'roof'
          ? this.mats.roof
          : this.mats.ground[name] ?? (part === 'ground' ? this.mats.ground.sidewalk : facadeMat);
      if (!this.mats.ground[name] && name !== 'facade' && name !== 'roof') console.warn('nyc: unknown glb material name', name);
      old.dispose();
      m.material = mat;
      m.visible = false;
      m.geometry.computeBoundingSphere();
      if (!this.templates[part]) this.templates[part] = m.geometry;
    });
  }

  private attach(t: Tile) {
    if (t.group.parent !== this.scene) this.scene.add(t.group);
  }

  /** Make a prepared mesh visible. Its first draw uploads the buffers, so it is drawn once even if the tile is off-screen. */
  private reveal(t: Tile, m: THREE.Mesh) {
    m.visible = true;
    m.frustumCulled = false;
    t.forced++;
    m.onBeforeRender = () => { m.onBeforeRender = () => {}; m.frustumCulled = true; t.forced = Math.max(0, t.forced - 1); };
  }

  private finishNear(t: Tile, props: unknown) {
    t.near = 3;
    this.hideFarIfNear(t);
    if (props && this.props) { this.props.setTile(t.key, props); t.propsSet = true; }
  }

  private hideFarIfNear(t: Tile) {
    if (t.farGroup) t.farGroup.visible = t.near !== 3;
  }

  private commitFar(t: Tile) {
    const g = t.farGroup!;
    t.group.add(g);
    this.attach(t);
    g.traverse((o) => { if ((o as THREE.Mesh).isMesh) this.reveal(t, o as THREE.Mesh); });
    t.far = 3;
    this.hideFarIfNear(t);
  }

  private queueColliders(t: Tile, gen: number, c: ColJson | null) {
    const ground = c?.ground ?? 0;
    const bs = c?.buildings ?? [];
    t.buildingCols = [];
    this.props?.setTileBuildings?.(t.key, bs, ground);
    const S = this.o.surfaces;
    const make = (d: RAPIER.ColliderDesc, surface: number) => {
      const col = this.pw.world.createCollider(d.setFriction(0.4).setRestitution(0.05));
      t.colliders.push(col);
      (this.pw as unknown as { surfaceOf: Map<number, number> }).surfaceOf.set(col.handle, surface);
      return col;
    };
    // one big ground cuboid (top at the ground height), then buildings in batches
    this.queue.push({ tile: t, kind: 'col', gen, cost: 0.1, run: () => {
      make(RAPIER.ColliderDesc.cuboid(TILE / 2, 2, TILE / 2).setTranslation(t.ix * TILE + TILE / 2, ground - 2, -(t.iy * TILE + TILE / 2)), S.asphalt);
    } });
    const BATCH = 60;
    const q = new THREE.Quaternion(), Y = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < bs.length; i += BATCH) {
      this.queue.push({ tile: t, kind: 'col', gen, cost: 0.4, run: () => {
        for (const b of bs.slice(i, i + BATCH)) {
          q.setFromAxisAngle(Y, b.yaw);
          const hh = Math.max(0.1, (b.z1 - b.z0) / 2);
          const col = make(RAPIER.ColliderDesc.cuboid(b.hx, hh, b.hy).setTranslation(b.cx, (b.z0 + b.z1) / 2, -b.cy).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }), S.wall);
          const bc = { box: b, col, breached: false };
          t.buildingCols?.push(bc);
          this.buildingOf.set(col.handle, { t, bc });
        }
      } });
    }
    this.queue.push({ tile: t, kind: 'col', gen, cost: 0.05, run: () => { t.col = 3; this.breaches.reapply(t.key); } });
  }

  // ---- wall breaches (breach.ts): building lookup by collider / position, collider swap ---------------------------------------------------
  private facadeRay: THREE.Raycaster | null = null;
  private buildingOf = new Map<number, { t: Tile; bc: { box: BuildingColliderBox; col: RAPIER.Collider; breached: boolean } }>();
  /** Ground-floor wall crashes: rooms behind holes, rubble. main.ts calls breaches.check() after each physics step. */
  readonly breaches: Breaches;

  // ---- unloading ----------------------------------------------------------------------------------------------------------------------
  private disposeObject(root: THREE.Object3D) {
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) { m.geometry.dispose(); m.onBeforeRender = () => {}; }   // materials are shared: never disposed
    });
    root.removeFromParent();
  }

  private unloadNear(t: Tile) {
    this.batcher?.removeTile(t.key);
    if (t.propsSet) { this.props?.removeTile(t.key); t.propsSet = false; }
    const g = t.nearGroup;
    t.nearGroup = null; t.near = 0; t.gen.near++;
    t.forced = 0;
    if (t.procedural) t.procData = null;
    if (t.farGroup) t.farGroup.visible = true;
    if (g) this.queue.push({ tile: t, kind: 'near', gen: -1, cost: 0.3, run: () => { this.disposeObject(g); this.maybeDetach(t); } });
  }

  private unloadFar(t: Tile) {
    const g = t.farGroup;
    t.farGroup = null; t.far = 0; t.gen.far++;
    if (t.procedural) t.procData = null;
    if (g) this.queue.push({ tile: t, kind: 'far', gen: -1, cost: 0.2, run: () => { this.disposeObject(g); this.maybeDetach(t); } });
  }

  private unloadCol(t: Tile) {
    const cols = t.colliders;
    for (const bc of t.buildingCols ?? []) this.buildingOf.delete(bc.col.handle);
    this.breaches.dropTile(t.key);
    t.colliders = []; t.buildingCols = []; t.col = 0; t.gen.col++;
    this.props?.setTileBuildings?.(t.key, undefined);
    this.queue.push({ tile: t, kind: 'col', gen: -1, cost: 0.4, run: () => {
      const surf = (this.pw as unknown as { surfaceOf: Map<number, number> }).surfaceOf;
      for (const c of cols) { surf.delete(c.handle); this.pw.world.removeCollider(c, false); }
    } });
  }

  private maybeDetach(t: Tile) {
    if (!t.nearGroup && !t.farGroup) t.group.removeFromParent();
  }

  // ---- per frame ----------------------------------------------------------------------------------------------------------------------
  /** Run queued jobs until the time budget is spent (always at least one). Returns ms used. */
  private drain(budget: number) {
    const t0 = performance.now();
    let n = 0;
    while (this.queue.length) {
      const j = this.queue[0];
      if (n > 0 && performance.now() - t0 + j.cost > budget) break;
      this.queue.shift();
      if (j.gen >= 0 && j.tile.gen[j.kind] !== j.gen) continue;   // tile was unloaded meanwhile
      j.run();
      n++;
    }
    return performance.now() - t0;
  }

  private updateVisibility(force = false) {
    this.camera.updateMatrixWorld();
    this.pv.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv, this.camera.coordinateSystem);
    for (const t of this.tiles.values()) {
      if (!t.group.parent) continue;
      t.group.visible = force || t.forced > 0 || this.frustum.intersectsBox(t.box);
    }
  }

  update(
    carPos: THREE.Vector3,
    dt: number,
    carVel?: THREE.Vector3,
    onImpact?: (impulse: number, kind?: 'pole' | 'shop' | 'wall', wx?: number, wz?: number) => void,
  ) {
    if (!this.index || !this.spawn || this.disposed) return;
    const t0 = performance.now();
    // heading / speed of the car from its motion (horizontal)
    if (this.haveLast && dt > 0) {
      const vx = (carPos.x - this.lastPos.x) / dt, vz = (carPos.z - this.lastPos.z) / dt, s = Math.hypot(vx, vz);
      this.speed += (s - this.speed) * Math.min(1, dt * 3);
      if (s > 3) { this.fwd.x += (vx / s - this.fwd.x) * Math.min(1, dt * 3); this.fwd.z += (vz / s - this.fwd.z) * Math.min(1, dt * 3); const l = Math.hypot(this.fwd.x, this.fwd.z) || 1; this.fwd.x /= l; this.fwd.z /= l; }
    }
    this.lastPos.copy(carPos); this.haveLast = true;
    // selection at ~10 Hz (or after 20 m of motion)
    this.sinceSelect += dt;
    if (this.sinceSelect > 0.1) { this.sinceSelect = 0; this.select(carPos); }
    // commits: paused after a slow frame
    if (dt > SLOW_DT) this.pause = 2;
    let used = 0;
    if (this.pause > 0) this.pause--; else used = this.drain(this.o.budgetMs);
    this.updateVisibility();
    this.props?.update(dt, carPos, carVel, onImpact);
    this.breaches.update(dt, this.camera);
    const ms = performance.now() - t0;
    this.stat.streamMs += (ms - this.stat.streamMs) * 0.05;
    this.stat.commitMs += (used - this.stat.commitMs) * 0.05;
    if (ms > this.stat.streamMax) this.stat.streamMax = ms;
    if (this.overlay && (this.overlayT -= dt) < 0) { this.overlayT = 0.25; this.overlay.textContent = this.report(); }
  }

  /** The street furniture (poles, trees) for obstacles.ts; null until ready or with stub props. */
  get streetProps(): NycProps | null { return this.props instanceof NycProps ? this.props : null; }

  breakNearestPole(carPos: THREE.Vector3, carVel?: THREE.Vector3): boolean {
    return this.props?.breakNearestPole?.(carPos, carVel) ?? false;
  }

  /** Tooling: break the wall of the building nearest carPos (as if hit there). */
  breakNearestShop(carPos: THREE.Vector3): boolean {
    const list: { key: string; box: BuildingColliderBox }[] = [];
    for (const t of this.tiles.values()) for (const bc of t.buildingCols ?? []) if (!bc.breached) list.push({ key: t.key, box: bc.box });
    return this.breaches.breakNearest(carPos, list);
  }

  stats(): NycStats {
    let near = 0, far = 0, col = 0, colliders = 0;
    for (const t of this.tiles.values()) { if (t.near === 3) near++; if (t.far === 3) far++; if (t.col === 3) col++; colliders += t.colliders.length; }
    const info = this.renderer.info as unknown as { memory: { geometries: number; textures: number }; render: { drawCalls?: number; calls: number; triangles: number } };
    const pipes = (this.renderer as unknown as { _pipelines?: { caches: Map<string, unknown> } })._pipelines?.caches.size ?? 0;
    return { near, far, col, loading: this.pending.size, queued: this.queue.length, colliders, streamMs: this.stat.streamMs, streamMax: this.stat.streamMax,
      commitMs: this.stat.commitMs, tilesLoaded: this.stat.loaded, loadMsAvg: this.stat.loaded ? this.stat.loadMs / this.stat.loaded : 0,
      geometries: info.memory.geometries, textures: info.memory.textures, drawCalls: info.render.drawCalls ?? info.render.calls, triangles: info.render.triangles, pipelines: pipes };
  }

  private report() {
    const s = this.stats();
    return `NYC tiles  near ${s.near}  far ${s.far}  col ${s.col}   loading ${s.loading}  queued ${s.queued}\n`
      + `draws ${s.drawCalls}  tris ${(s.triangles / 1000).toFixed(0)}k  geoms ${s.geometries}  tex ${s.textures}  pipes ${s.pipelines}  colliders ${s.colliders}\n`
      + `stream ${s.streamMs.toFixed(2)} ms (commit ${s.commitMs.toFixed(2)}, max ${s.streamMax.toFixed(1)})  loaded ${s.tilesLoaded} tiles, ${s.loadMsAvg.toFixed(0)} ms each`;
  }

  resetMax() { this.stat.streamMax = 0; }

  // ---- warm-up ------------------------------------------------------------------------------------------------------------------------
  /**
   * One tiny mesh per shared material, with the vertex layout of the real tile geometry, added to the scene so main's compile + forced
   * draw covers every pipeline (water, rail... may not be in the first ring). Call endWarm() after that draw.
   */
  private makeWarmMeshes() {
    const mk = (tpl: THREE.BufferGeometry | undefined, mat: THREE.Material) => {
      if (!tpl) return;
      const g = new THREE.BufferGeometry();
      for (const [name, a] of Object.entries(tpl.attributes)) {
        const src = a as THREE.BufferAttribute;
        const Arr = src.array.constructor as new (n: number) => ArrayLike<number> & { set(a: ArrayLike<number>): void };
        const arr = new Arr(3 * src.itemSize);
        for (let i = 0; i < 3 * src.itemSize; i++) (arr as unknown as number[])[i] = src.array[i % src.array.length];
        g.setAttribute(name, new THREE.BufferAttribute(arr as unknown as ArrayLike<number> as never, src.itemSize, src.normalized));
      }
      g.setIndex([0, 1, 2]);
      const m = new THREE.Mesh(g, mat);
      m.receiveShadow = this.o.receiveShadow; m.castShadow = false;
      m.position.set(this.spawn.x, 0, -this.spawn.y);
      m.frustumCulled = false;
      this.scene.add(m);
      this.warmMeshes.push(m);
    };
    for (const mat of Object.values(this.mats.ground)) mk(this.templates.ground ?? this.templates.bld, mat);
    mk(this.templates.bld ?? this.templates.far, this.mats.facade);
    mk(this.templates.far ?? this.templates.bld, this.mats.facadeFar);
    mk(this.templates.bld ?? this.templates.far, this.mats.roof);
    if (this.templates.far && this.templates.far !== this.templates.bld) { mk(this.templates.far, this.mats.roof); }
    // Also warm the procedural Float32Array vertex layout for facade variants and roof so infinite NYC tiles compile 0 pipelines at runtime
    const procTpl = new THREE.BufferGeometry();
    procTpl.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    procTpl.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), 3));
    procTpl.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(6), 2));
    procTpl.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(12).fill(255), 4, true));
    mk(procTpl, this.mats.roof);
    procTpl.setAttribute('_bld', new THREE.BufferAttribute(new Float32Array([0.5, 8, 2, 0.5, 0.5, 8, 2, 0.5, 0.5, 8, 2, 0.5]), 4));
    mk(procTpl, this.mats.facade);
    mk(procTpl, this.mats.facadeFar);
    procTpl.dispose();
  }

  /** Remove the warm-up meshes (after the forced full draw in main.ts). */
  endWarm() {
    for (const m of this.warmMeshes) { m.geometry.dispose(); m.removeFromParent(); }
    this.warmMeshes.length = 0;
  }

  // ---- teardown -----------------------------------------------------------------------------------------------------------------------
  dispose() {
    this.disposed = true;
    this.batcher?.dispose();
    this.batcher = null;
    for (const t of this.tiles.values()) {
      if (t.nearGroup) this.disposeObject(t.nearGroup);
      if (t.farGroup) this.disposeObject(t.farGroup);
      for (const c of t.colliders) this.pw.world.removeCollider(c, false);
      t.group.removeFromParent();
      if (t.propsSet) this.props?.removeTile(t.key);
    }
    this.queue.length = 0;
    this.endWarm();
    this.props?.dispose();
    this.atm?.dispose();
    this.overlay?.remove();
  }
}
