// New York street furniture, instanced and streamed per tile (data: {ix}_{iy}.props.json from tools/nyc/props.py, contract in docs/nyc_props.md).
//
//   const props = new NycProps(scene, camera);  await props.warm(renderer);
//   props.setTile('0_0', json);  props.removeTile('0_0');  props.update(dt);  props.dispose();
//
// Design (budget: <= ~15 draw calls for everything, no per-instance JS work per frame, no compile or allocation while driving):
//  * one pre-allocated InstancedMesh per kind (lamp, tree, signal, hydrant, bench, bus shelter, subway entrance, steam stack, scaffold shed, cone, newsstand,
//    waste basket, steam puffs, lamp light pools, signs): slots are leased per tile and recycled (InstanceSet in signage.ts); removing a tile zeroes its slots;
//  * each kind is ONE merged geometry with vertex colours + a `glow` attribute (emissive weight), so a lamp is pole + arm + lit lens in one draw;
//  * animation is in the shaders from one shared uniform (nycTime): signal phases (per-instance group/phase), steam puffs, sign screens;
//  * lights: a small pool of PointLights (default 28) re-assigned every 200 ms to the most relevant lamps / signals / big signs near the camera, with a fade
//    per light so nothing pops. The pool size never changes (no shader recompiles); every other lamp is an emissive lens + a cheap additive light pool decal.
import * as THREE from 'three/webgpu';
import { attribute, instancedBufferAttribute, instanceIndex, hash, uv, float, vec2, vec3, vec4, mix, smoothstep, fract, mod, step, select, length, positionView,
  cameraProjectionMatrix, cameraViewMatrix, positionGeometry, sin, cos } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { InstanceSet, NycSigns, nycTime, writeMatrix, SIGN_LIGHT } from './signage';

export interface PropsData {
  /** ground height of the tile (m); props are placed at z + this. Optional, default 0. */
  z?: number;
  lamp?: number[][]; tree?: number[][]; signal?: number[][]; hydrant?: number[][]; bench?: number[][]; bus_stop?: number[][];
  subway_entrance?: number[][]; steam?: number[][]; scaffold?: number[][]; cone?: number[][]; kiosk?: number[][]; waste?: number[][]; sign?: number[][];
}

type RGB = [number, number, number];

// ---- geometry kit (three frame: y up, +x = the prop's forward / arm direction, z lateral) ---------------------------------------------------
class Kit {
  parts: THREE.BufferGeometry[] = [];
  private add(g: THREE.BufferGeometry, col: RGB, glow: number) {
    const n = g.index ? g.toNonIndexed() : g;
    n.deleteAttribute('uv');
    n.computeVertexNormals();
    const c = new Float32Array(n.attributes.position.count * 3), w = new Float32Array(n.attributes.position.count).fill(glow);
    for (let i = 0; i < n.attributes.position.count; i++) { c[i * 3] = col[0]; c[i * 3 + 1] = col[1]; c[i * 3 + 2] = col[2]; }
    n.setAttribute('color', new THREE.BufferAttribute(c, 3));
    n.setAttribute('glow', new THREE.BufferAttribute(w, 1));
    this.parts.push(n);
    return this;
  }
  box(w: number, h: number, d: number, x: number, y: number, z: number, col: RGB, glow = 0) {
    return this.add(new THREE.BoxGeometry(w, h, d).translate(x, y, z), col, glow);
  }
  /** cylinder with its base at y */
  cyl(rb: number, rt: number, h: number, x: number, y: number, z: number, col: RGB, glow = 0, radial = 6) {
    return this.add(new THREE.CylinderGeometry(rt, rb, h, radial, 1, true).translate(x, y + h / 2, z), col, glow);
  }
  ico(r: number, x: number, y: number, z: number, sx: number, sy: number, sz: number, col: RGB, glow = 0, detail = 0) {
    return this.add(new THREE.IcosahedronGeometry(r, detail).scale(sx, sy, sz).translate(x, y, z), col, glow);
  }
  sphere(r: number, x: number, y: number, z: number, col: RGB, glow = 0) {
    return this.add(new THREE.SphereGeometry(r, 8, 6).translate(x, y, z), col, glow);
  }
  build() {
    const g = mergeGeometries(this.parts, false)!;
    for (const p of this.parts) p.dispose();
    g.computeBoundingSphere();
    return g;
  }
}

const GREY: RGB = [0.07, 0.075, 0.08], DARK: RGB = [0.03, 0.032, 0.035], GREEN_MET: RGB = [0.04, 0.16, 0.1];

function lampGeo() {
  const k = new Kit();
  k.cyl(0.14, 0.14, 0.9, 0, 0, 0, GREY, 0, 6);                       // base
  k.cyl(0.1, 0.07, 8.6, 0, 0.9, 0, GREY, 0, 6);                      // pole
  k.box(2.3, 0.1, 0.1, 1.1, 9.35, 0, GREY);                          // arm
  k.box(0.95, 0.14, 0.38, 2.25, 9.3, 0, [0.09, 0.09, 0.1]);          // cobra head
  k.box(0.78, 0.03, 0.3, 2.25, 9.2, 0, [1.0, 0.6, 0.26], 1);         // sodium lens (emissive)
  return k.build();
}

function treeGeo() {
  const k = new Kit();
  k.cyl(0.2, 0.1, 4.6, 0, 0, 0, [0.05, 0.038, 0.03], 0, 5);
  k.ico(3.1, 0, 6.6, 0, 1, 0.82, 1, [0.015, 0.038, 0.018]);
  k.ico(2.1, 0.6, 8.5, -0.4, 1, 0.85, 1, [0.02, 0.046, 0.022]);
  k.ico(1.8, -1.2, 5.9, 1.3, 1, 0.8, 1, [0.013, 0.034, 0.016]);
  return k.build();
}

function signalGeo(side: 1 | -1) {
  // arm along +x from the pole at the origin; heads hang at x = 6.1 and 3.4 facing -z (side = 1) or +z (side = -1); lens index in `glow`: 1 red, 2 yellow, 3 green
  const k = new Kit();
  const f = -side;                                                    // forward z sign of the lenses
  k.cyl(0.13, 0.13, 0.7, 0, 0, 0, GREY, 0, 6);
  k.cyl(0.09, 0.07, 5.6, 0, 0.7, 0, GREY, 0, 6);
  k.box(7.0, 0.1, 0.1, 3.5, 6.1, 0, GREY);
  for (const x of [6.2, 3.6]) {
    k.box(0.4, 1.2, 0.32, x, 5.45, 0, [0.02, 0.02, 0.02]);
    k.box(0.5, 1.3, 0.04, x, 5.45, -f * 0.17, [0.03, 0.03, 0.03]);   // backplate
    k.box(0.26, 0.26, 0.06, x, 5.8, f * 0.17, [1, 0.1, 0.06], 1);
    k.box(0.26, 0.26, 0.06, x, 5.45, f * 0.17, [1, 0.72, 0.06], 2);
    k.box(0.26, 0.26, 0.06, x, 5.1, f * 0.17, [0.1, 1, 0.45], 3);
  }
  return k.build();
}

function hydrantGeo() {
  const k = new Kit();
  const red: RGB = [0.5, 0.05, 0.04];
  k.cyl(0.14, 0.12, 0.55, 0, 0, 0, red, 0, 6);
  k.cyl(0.16, 0.16, 0.08, 0, 0.55, 0, [0.38, 0.04, 0.03], 0, 6);
  k.sphere(0.12, 0, 0.7, 0, red);
  k.box(0.3, 0.1, 0.1, 0, 0.38, 0, red);
  k.box(0.1, 0.1, 0.12, 0.17, 0.28, 0, [0.4, 0.38, 0.1]);
  return k.build();
}

function benchGeo() {
  // faces +x, 1.8 m long along z
  const k = new Kit();
  const wood: RGB = [0.16, 0.1, 0.06];
  k.box(0.5, 0.06, 1.8, 0, 0.45, 0, wood);
  k.box(0.05, 0.5, 1.8, -0.24, 0.78, 0, wood);
  for (const z of [-0.8, 0.8]) k.box(0.45, 0.45, 0.06, 0, 0.22, z, DARK);
  return k.build();
}

function busGeo() {
  // open side faces +x, 3.6 m long along z, 1.5 m deep
  const k = new Kit();
  const metal: RGB = [0.06, 0.07, 0.08];
  k.box(1.6, 0.1, 3.7, 0, 2.55, 0, metal);
  for (const z of [-1.75, 1.75]) for (const x of [-0.7, 0.7]) k.cyl(0.04, 0.04, 2.5, x, 0, z, metal, 0, 5);
  k.box(0.08, 1.9, 3.6, -0.72, 1.25, 0, [0.04, 0.07, 0.09]);                      // back glass
  k.box(0.07, 1.5, 1.1, -0.66, 1.3, 1.15, [0.85, 0.95, 1.0], 0.55);               // lit ad panel
  k.box(0.07, 0.9, 1.1, -0.66, 1.3, -0.1, [0.9, 0.55, 0.3], 0.25);
  k.box(0.5, 0.05, 2.2, -0.35, 0.45, -0.3, metal);                                // bench
  k.box(0.05, 0.3, 3.7, 0.78, 2.4, 0, [0.9, 0.9, 0.95], 0.8);                     // strip light on the roof edge
  return k.build();
}

function subwayGeo() {
  // stairwell aligned along x (road direction), rails green, two green globe lamps: the NYC subway entrance
  const k = new Kit();
  k.box(3.4, 0.03, 1.8, 0, 0.02, 0, [0.005, 0.005, 0.006]);                      // dark opening
  for (const z of [-0.95, 0.95]) {
    k.box(3.4, 0.07, 0.07, 0, 1.05, z, GREEN_MET);
    k.box(3.4, 0.07, 0.07, 0, 0.55, z, GREEN_MET);
    for (const x of [-1.6, -0.8, 0, 0.8, 1.6]) k.cyl(0.035, 0.035, 1.05, x, 0, z, GREEN_MET, 0, 4);
  }
  for (const x of [-1.75, 1.75]) {
    k.cyl(0.07, 0.07, 2.5, x, 0, 0.95, GREEN_MET, 0, 5);
    k.sphere(0.24, x, 2.75, 0.95, [0.25, 1.0, 0.4], 1);
  }
  return k.build();
}

function steamGeo() {
  // orange and white striped stack
  const k = new Kit();
  for (let i = 0; i < 6; i++) k.cyl(0.24, 0.24, 0.5, 0, i * 0.5, 0, i % 2 ? [0.8, 0.8, 0.78] : [0.85, 0.26, 0.04], 0, 8);
  k.cyl(0.24, 0.1, 0.35, 0, 3.0, 0, [0.85, 0.26, 0.04], 0, 8);
  k.cyl(0.3, 0.3, 0.12, 0, 0, 0, DARK, 0, 8);
  return k.build();
}

function scaffoldGeo() {
  // one 4 m module (along x), 3.4 m deep (z), green sidewalk shed with string lights
  const k = new Kit();
  const green: RGB = [0.03, 0.13, 0.08];
  k.box(4.0, 0.12, 3.5, 0, 3.65, 0, green);
  for (const x of [-1.95, 1.95]) for (const z of [-1.7, 1.7]) k.cyl(0.05, 0.05, 3.6, x, 0, z, [0.1, 0.12, 0.1], 0, 5);
  k.box(4.0, 0.1, 0.1, 0, 3.4, -1.7, [0.1, 0.12, 0.1]);
  k.box(4.0, 0.1, 0.1, 0, 3.4, 1.7, [0.1, 0.12, 0.1]);
  k.box(3.7, 0.05, 0.05, 0, 3.52, 0, [1.0, 0.85, 0.55], 1);
  k.box(4.0, 0.9, 0.06, 0, 0.9, 1.75, [0.04, 0.12, 0.07]);                      // low plywood barrier on the street side... (symmetric)
  return k.build();
}

function coneGeo() {
  const k = new Kit();
  k.box(0.42, 0.04, 0.42, 0, 0.02, 0, DARK);
  k.cyl(0.17, 0.06, 0.7, 0, 0.04, 0, [0.95, 0.3, 0.02], 0.12, 8);
  k.cyl(0.125, 0.105, 0.1, 0, 0.36, 0, [0.9, 0.9, 0.9], 0.15, 8);
  return k.build();
}

function kioskGeo() {
  // newsstand facing +x
  const k = new Kit();
  k.box(1.1, 2.1, 1.6, 0, 1.05, 0, [0.04, 0.1, 0.12]);
  k.box(1.3, 0.1, 1.8, 0, 2.15, 0, DARK);
  k.box(0.06, 0.9, 1.3, 0.56, 1.3, 0, [1.0, 0.7, 0.35], 0.7);
  k.box(0.06, 0.25, 1.5, 0.57, 1.85, 0, [1.0, 0.25, 0.3], 0.6);
  return k.build();
}

function wasteGeo() {
  const k = new Kit();
  k.cyl(0.26, 0.24, 0.85, 0, 0, 0, GREEN_MET, 0, 8);
  k.cyl(0.28, 0.28, 0.06, 0, 0.85, 0, DARK, 0, 8);
  return k.build();
}

// ---- materials ----------------------------------------------------------------------------------------------------------------------

function litMaterial(glowGain: number, rough = 0.75, metal = 0.05, tint?: any) {
  const m = new THREE.MeshStandardNodeMaterial();
  const col = attribute('color', 'vec3'), glow = attribute('glow', 'float');
  m.colorNode = tint ? col.mul(tint) : col;
  m.emissiveNode = col.mul(glow).mul(glowGain);
  m.roughness = rough; m.metalness = metal;
  return m;
}

function signalMaterial(phase: THREE.InstancedBufferAttribute) {
  const m = new THREE.MeshStandardNodeMaterial();
  const col = attribute('color', 'vec3'), lens = attribute('glow', 'float');
  const gp: any = instancedBufferAttribute(phase);        // x group, y phase offset (s)
  const u = mod(mod(nycTime.add(gp.y), 60).sub(gp.x.mul(31)).add(60), 60);   // seconds into this group's cycle: green 0-26, yellow 26-29, red 29-60
  const on = select(lens.lessThan(1.5), step(29, u), select(lens.lessThan(2.5), step(26, u).mul(step(u, 28.999)), step(u, 25.999)));
  const isLens = step(0.5, lens);
  m.colorNode = col;
  m.emissiveNode = col.mul(isLens).mul(on.mul(5.5).add(0.03));
  m.roughness = 0.6; m.metalness = 0.1;
  return m;
}

function lampPoolMaterial() {
  const m = new THREE.MeshBasicNodeMaterial();
  const r = length(uv().sub(0.5)).mul(2);
  const fall = smoothstep(1.0, 0.0, r).pow(2.2);
  const dist = positionView.z.negate();
  const far = smoothstep(260, 120, dist);
  m.colorNode = vec3(1.0, 0.56, 0.24).mul(fall).mul(far).mul(0.5);
  m.opacityNode = float(1);
  m.transparent = true; m.blending = THREE.AdditiveBlending; m.depthWrite = false; m.fog = false;
  m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -2;
  return m;
}

const PUFFS = 7;
function steamMaterial(data: THREE.InstancedBufferAttribute) {
  const m = new THREE.MeshBasicNodeMaterial();
  const d: any = instancedBufferAttribute(data);          // x, y, z base (three frame, top of the stack), w phase 0..1
  const age = fract(nycTime.mul(0.16).add(d.w));
  const sway = vec3(sin(nycTime.mul(0.6).add(d.w.mul(40))).mul(age).mul(1.2).add(age.mul(age).mul(2.5)), 0, cos(nycTime.mul(0.5).add(d.w.mul(31))).mul(age).mul(1.0));
  const center = vec3(d.x, d.y, d.z).add(vec3(0, age.mul(6.5), 0)).add(sway);
  const size = mix(0.7, 4.2, age.sqrt());
  const view = cameraViewMatrix.mul(vec4(center, 1));
  const q = positionGeometry.xy.mul(size);
  m.vertexNode = cameraProjectionMatrix.mul(vec4(view.x.add(q.x), view.y.add(q.y), view.z, 1));
  const rr = length(uv().sub(0.5)).mul(2);
  const a = smoothstep(1.0, 0.1, rr).mul(smoothstep(0.0, 0.08, age)).mul(float(1).sub(age).pow(1.4)).mul(0.5);
  m.colorNode = vec3(0.9, 0.8, 0.72).mul(0.55);
  m.opacityNode = a;
  m.transparent = true; m.depthWrite = false;
  return m;
}

// ---- lights -------------------------------------------------------------------------------------------------------------------------

interface Slot { light: THREE.PointLight; id: number; cur: number; target: number; base: number; pend: number; pc: THREE.Color; pbase: number; prange: number; px: number; py: number; pz: number }

const CYCLE = 60;
function signalColor(t: number, group: number, phase: number, out: THREE.Color) {
  const u = (((t + phase) % CYCLE) - group * 31 + CYCLE) % CYCLE;
  if (u < 26) out.setRGB(0.1, 1, 0.45); else if (u < 29) out.setRGB(1, 0.7, 0.05); else out.setRGB(1, 0.08, 0.05);
}

interface TileLights { serial: number; x0: number; y0: number; z: number; lamps: number[][]; signals: number[][]; signs: number[][] }

export interface NycPropsOptions { lights?: number; lampLightIntensity?: number }

export class NycProps {
  readonly root = new THREE.Group();
  readonly signs: NycSigns;
  /** InstancedMeshes (draw calls) added to the scene */
  readonly meshes: THREE.Mesh[] = [];
  private sets: Record<string, InstanceSet> = {};
  private pools: THREE.InstancedMesh;
  private steamSet: InstanceSet;
  private lights: Slot[] = [];
  private tileLights = new Map<string, TileLights>();
  private serial = 0;
  private lightTimer = 0;
  private time = 0;
  private cam = new THREE.Vector3();
  private fwd = new THREE.Vector3();
  private selected = new Set<number>();
  private cand: { id: number; score: number; kind: number; tl: TileLights; i: number }[] = [];
  private lampIntensity: number;

  constructor(private scene: THREE.Scene, private camera: THREE.Camera, opts: NycPropsOptions = {}) {
    this.root.name = 'nyc_props';
    this.lampIntensity = opts.lampLightIntensity ?? 55;
    const mk = (name: string, geo: THREE.BufferGeometry, mat: THREE.Material, cap: number, stride = 0, attr?: THREE.InstancedBufferAttribute) => {
      const s = new InstanceSet(geo, mat, cap, stride, 'nyc_' + name, attr);
      this.sets[name] = s; this.root.add(s.mesh); this.meshes.push(s.mesh);
      return s;
    };
    mk('lamp', lampGeo(), litMaterial(5.0, 0.5, 0.3), 6000);
    mk('tree', treeGeo(), litMaterial(0.0, 0.95, 0.0, mix(0.7, 1.35, hash(instanceIndex))), 14000);
    const phaseA = new THREE.InstancedBufferAttribute(new Float32Array(900 * 2), 2);
    const phaseB = new THREE.InstancedBufferAttribute(new Float32Array(900 * 2), 2);
    mk('signalR', signalGeo(1), signalMaterial(phaseA), 900, 2, phaseA);
    mk('signalL', signalGeo(-1), signalMaterial(phaseB), 900, 2, phaseB);
    mk('hydrant', hydrantGeo(), litMaterial(0, 0.55, 0.2), 1500);
    mk('bench', benchGeo(), litMaterial(0, 0.8), 2200);
    mk('bus', busGeo(), litMaterial(3.0, 0.6, 0.2), 400);
    mk('subway', subwayGeo(), litMaterial(5.0, 0.6, 0.3), 400);
    mk('steam', steamGeo(), litMaterial(0, 0.6, 0.2), 200);
    mk('scaffold', scaffoldGeo(), litMaterial(5.0, 0.8, 0.1), 1500);
    mk('cone', coneGeo(), litMaterial(1.0, 0.6), 600);
    mk('kiosk', kioskGeo(), litMaterial(3.5, 0.7), 300);
    mk('waste', wasteGeo(), litMaterial(0, 0.6, 0.3), 1500);
    // lamp light pools: additive decals sharing the lamp instance matrices
    const disc = new THREE.PlaneGeometry(15, 15).rotateX(-Math.PI / 2).translate(2.2, 0.06, 0);
    this.pools = new THREE.InstancedMesh(disc, lampPoolMaterial(), 6000);
    this.pools.instanceMatrix = this.sets.lamp.mesh.instanceMatrix;
    this.pools.frustumCulled = false; this.pools.renderOrder = 5; this.pools.name = 'nyc_lamp_pools';
    this.root.add(this.pools); this.meshes.push(this.pools);
    // steam puffs
    const sd = new THREE.InstancedBufferAttribute(new Float32Array(1200 * 4), 4);
    this.steamSet = new InstanceSet(new THREE.PlaneGeometry(1, 1), steamMaterial(sd), 1200, 4, 'nyc_steam_puffs', sd);
    this.steamSet.mesh.renderOrder = 6;
    this.root.add(this.steamSet.mesh); this.meshes.push(this.steamSet.mesh);
    this.signs = new NycSigns(this.root);
    this.meshes.push(this.signs.set.mesh);
    scene.add(this.root);
    // light pool
    const n = opts.lights ?? 36;
    for (let i = 0; i < n; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 20, 2);
      scene.add(light);
      this.lights.push({ light, id: -1, cur: 0, target: 0, base: 0, pend: -1, pc: new THREE.Color(), pbase: 0, prange: 20, px: 0, py: 0, pz: 0 });
    }
  }

  /** Immediately flush all instanced props and snap the nearest lights to full intensity (used before environment cubemap capture). */
  primeLights() {
    this.flush();
    this.assignLights();
    for (const s of this.lights) {
      if (s.pend >= 0) {
        s.id = s.pend; s.pend = -1; s.base = s.pbase;
        s.light.position.set(s.px, s.pz, -s.py); s.light.color.copy(s.pc); s.light.distance = s.prange;
        s.target = 1; s.cur = 1; s.light.intensity = s.base;
      }
    }
  }

  /** Compile every pipeline now (all meshes always draw at least one degenerate instance, so this covers them all). */
  async warm(renderer: THREE.WebGPURenderer) {
    this.flush();
    await renderer.compileAsync(this.scene, this.camera);
  }

  setTile(key: string, data: unknown) {
    const d = data as PropsData;
    const z = d.z ?? 0;
    const S = this.sets;
    const plain = (set: InstanceSet, rows: number[][] | undefined, yawOf = 2, scale = false) => set.add(key, rows, (r, m, mo) => {
      const s = scale ? r[3] : 1;
      writeMatrix(m, mo, r[0], r[1], z, r[yawOf] ?? 0, s, s, s);
    });
    plain(S.lamp, d.lamp);
    S.tree.add(key, d.tree, (r, m, mo) => writeMatrix(m, mo, r[0], r[1], z, r[2], r[3], r[3] * (0.9 + 0.2 * ((r[2] * 7) % 1)), r[3]));
    for (const [set, side] of [[S.signalR, 1], [S.signalL, -1]] as [InstanceSet, number][]) {
      set.add(key, d.signal?.filter((r) => r[3] === side), (r, m, mo, ex, eo) => {
        writeMatrix(m, mo, r[0], r[1], z, r[2]);
        ex![eo] = r[4]; ex![eo + 1] = r[5];
      });
    }
    plain(S.hydrant, d.hydrant);
    plain(S.bench, d.bench);
    plain(S.bus, d.bus_stop);
    plain(S.subway, d.subway_entrance);
    plain(S.scaffold, d.scaffold);
    plain(S.kiosk, d.kiosk);
    S.steam.add(key, d.steam, (r, m, mo) => writeMatrix(m, mo, r[0], r[1], z, 0));
    S.cone.add(key, d.cone, (r, m, mo) => writeMatrix(m, mo, r[0], r[1], z, 0));
    S.waste.add(key, d.waste, (r, m, mo) => writeMatrix(m, mo, r[0], r[1], z, 0));
    // steam puffs: PUFFS billboards per stack, phases spread over the life cycle
    const puffs: number[][] = [];
    for (const r of d.steam ?? []) for (let k = 0; k < PUFFS; k++) puffs.push([r[0], r[1], r[2] ?? 3.3, k / PUFFS + ((Math.abs(r[0]) * 0.31) % 0.14)]);
    this.steamSet.add(key, puffs, (r, m, mo, ex, eo) => { ex![eo] = r[0]; ex![eo + 1] = z + r[2] + 0.1; ex![eo + 2] = -r[1]; ex![eo + 3] = r[3]; writeMatrix(m, mo, 0, 0, 0, 0); });
    this.signs.setTile(key, d.sign, z);

    const [ix, iy] = key.split('_').map(Number);
    this.tileLights.set(key, { serial: ++this.serial, x0: ix * 256, y0: iy * 256, z, lamps: d.lamp ?? [], signals: d.signal ?? [], signs: (d.sign ?? []).filter((r) => r[6] < 8) });
  }

  removeTile(key: string) {
    for (const s of Object.values(this.sets)) s.remove(key);
    this.steamSet.remove(key);
    this.signs.removeTile(key);
    this.tileLights.delete(key);
  }

  private flush() {
    for (const s of Object.values(this.sets)) s.flush();
    this.steamSet.flush();
    this.signs.flush();
    this.pools.count = this.sets.lamp.mesh.count;
  }

  update(dt: number) {
    this.time += dt;
    nycTime.value = this.time;
    this.flush();
    if ((this.lightTimer -= dt) <= 0) { this.lightTimer = 0.2; this.assignLights(); }
    const k = Math.min(1, dt * 7);
    for (const s of this.lights) {
      if (s.pend >= 0 && s.cur < 0.02 && (s.target === 0 || s.id < 0)) {   // faded out (or free): take the pending assignment
        s.id = s.pend; s.pend = -1; s.base = s.pbase;
        s.light.position.set(s.px, s.pz, -s.py); s.light.color.copy(s.pc); s.light.distance = s.prange; s.target = 1;
      } else if (s.id >= 0 && s.target === 0 && s.cur < 0.02) s.id = -1;
      s.cur += (s.target - s.cur) * k;
      s.light.intensity = s.cur < 0.01 ? 0 : s.base * s.cur;
    }
  }

  private assignLights() {
    const c = this.camera.position;
    const cx = c.x, cy = -c.z;
    this.camera.getWorldDirection(this.fwd);
    const fx = this.fwd.x, fy = -this.fwd.z;
    const cand = this.cand; cand.length = 0;
    const R = 130;
    for (const tl of this.tileLights.values()) {
      if (cx < tl.x0 - R || cx > tl.x0 + 256 + R || cy < tl.y0 - R || cy > tl.y0 + 256 + R) continue;
      const push = (kind: number, i: number, x: number, y: number, bias: number, range: number) => {
        const dx = x - cx, dy = y - cy, dist = Math.hypot(dx, dy);
        if (dist > range) return;
        const behind = (dx * fx + dy * fy) < -12 ? 2.2 : 1;
        cand.push({ id: tl.serial * 1048576 + kind * 262144 + i, score: dist * bias * behind, kind, tl, i });
      };
      const L = tl.lamps, S = tl.signals, G = tl.signs;
      for (let i = 0; i < L.length; i++) push(0, i, L[i][0], L[i][1], 1, R);
      for (let i = 0; i < S.length; i++) if (S[i][3] === 1) push(1, i, S[i][0], S[i][1], 1.9, 55);
      for (let i = 0; i < G.length; i++) push(2, i, G[i][0], G[i][1], 0.7, 150);
    }
    cand.sort((a, b) => a.score - b.score);
    const n = Math.min(this.lights.length, cand.length);
    const sel = this.selected; sel.clear();
    const byId = new Map<number, (typeof cand)[number]>();
    for (let i = 0; i < n; i++) { sel.add(cand[i].id); byId.set(cand[i].id, cand[i]); }
    const taken = new Set<number>();
    for (const s of this.lights) {
      if (s.id >= 0) {
        if (sel.has(s.id)) { s.target = 1; taken.add(s.id); const cd = byId.get(s.id)!; if (cd.kind === 1) { const r = cd.tl.signals[cd.i]; signalColor(this.time + 0.1, r[4], r[5], s.light.color); } }
        else s.target = 0;
      }
      if (s.pend >= 0) { if (sel.has(s.pend)) taken.add(s.pend); else s.pend = -1; }
    }
    for (let i = 0; i < n; i++) {
      const cd = cand[i];
      if (taken.has(cd.id)) continue;
      const s = this.lights.find((l) => l.pend < 0 && (l.id < 0 || l.target === 0));
      if (!s) break;
      this.describe(cd, s);
      s.pend = cd.id; taken.add(cd.id);
    }
  }

  private describe(cd: { kind: number; tl: TileLights; i: number }, s: Slot) {
    const z = cd.tl.z;
    if (cd.kind === 0) {
      const r = cd.tl.lamps[cd.i];
      // light sits under the lens: 2.2 m out from the pole towards the road
      s.px = r[0] + Math.cos(r[2]) * 2.2; s.py = r[1] + Math.sin(r[2]) * 2.2; s.pz = z + 8.8;
      s.pc.setRGB(1.0, 0.62, 0.3); s.pbase = this.lampIntensity; s.prange = 24;
    } else if (cd.kind === 1) {
      const r = cd.tl.signals[cd.i];
      s.px = r[0] + Math.cos(r[2]) * 6.2; s.py = r[1] + Math.sin(r[2]) * 6.2; s.pz = z + 5.2;
      signalColor(this.time, r[4], r[5], s.pc); s.pbase = 9; s.prange = 12;
    } else {
      const r = cd.tl.signs[cd.i];
      const col = SIGN_LIGHT[r[6]] ?? [1, 1, 1];
      s.px = r[0] + Math.cos(r[3]) * 3.0; s.py = r[1] + Math.sin(r[3]) * 3.0; s.pz = z + r[2];
      s.pc.setRGB(col[0], col[1], col[2]); s.pbase = Math.min(220, 40 + r[4] * r[5] * 0.9); s.prange = 34;
    }
  }

  dispose() {
    for (const s of Object.values(this.sets)) { s.mesh.removeFromParent(); s.dispose(); }
    this.steamSet.mesh.removeFromParent(); this.steamSet.dispose();
    this.pools.removeFromParent(); this.pools.geometry.dispose(); (this.pools.material as THREE.Material).dispose();
    this.signs.dispose();
    for (const s of this.lights) { s.light.removeFromParent(); s.light.dispose?.(); }
    this.root.removeFromParent();
    this.lights.length = 0;
  }
}

