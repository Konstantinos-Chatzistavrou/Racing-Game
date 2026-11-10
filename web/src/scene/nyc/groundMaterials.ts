// Procedural TSL materials for the New York ground tiles (tools/nyc/ground.py -> {ix}_{iy}.ground.glb, docs/nyc_ground.md).
// No textures: everything is derived from the UV (metres, u east / v north) and the vertex colour (rgb tint, a = baked edge darkening: 0.6..1, low at the
// kerb). One shared singleton per glb material NAME; the tile loader just does `mesh.material = mats[mesh.material.name]`.
//
// Night, after rain: asphalt is wet-ish (roughness 0.3..0.5, puddles 0.03, more in the gutter) so the game's screen-space reflections
// (fx/depthFx.ts treats every up-facing surface as wet) have something to reflect. The costs are kept low: <= 3 noise lookups on the road, the fine
// detail (grain, cracks, bump) fades out beyond ~90 m.
//
// Special UVs: `crosswalk` uses LOCAL metres (u across the road, v along it, 0..3.2) so the zebra bars are drawn by the shader at any road angle.
import * as THREE from 'three/webgpu';
import {
  uv, vec2, vec3, float, mix, smoothstep, step, fract, floor, abs, max, min, clamp, hash, vertexColor, positionView, time,
  bumpMap, length, normalWorld,
} from 'three/tsl';
import { noise01, worleyEdge } from '../../fx/noiseTex';

export const GROUND_MATERIAL_NAMES = ['road', 'sidewalk', 'curb', 'marking', 'crosswalk', 'plaza', 'grass', 'water', 'rail'] as const;
export type GroundMaterialName = typeof GROUND_MATERIAL_NAMES[number];

// Manhattan's street grid is rotated 29 degrees from true north: slabs and pavers are laid out along it, so they line up with the kerbs.
const GRID = (29 * Math.PI) / 180;
const CS = Math.cos(GRID);
const SN = Math.sin(GRID);

// ---- shared node snippets (built once per createGroundMaterials call; each material owns its own nodes where they are mutated)
const P = uv();                                                         // metres, world aligned
const R = vec2(P.x.mul(CS).sub(P.y.mul(SN)), P.x.mul(SN).add(P.y.mul(CS)));   // metres along (street, avenue)
const dist = length(positionView);
const near = float(1).sub(smoothstep(35, 95, dist));                    // 1 close .. 0 far: fades high frequency detail (cost + shimmer)
const vc = vertexColor();
const ao = vc.a;                                                        // 0.6 at the kerb .. 1
const n01 = (p: any) => noise01(p);   // precomputed gradient noise (fx/noiseTex.ts): one texture read, not ~40 ops
const cellHash = (c: any) => hash(c.x.mul(127.1).add(c.y.mul(311.7)).add(17.0));

function std(rough: number) {
  const m = new THREE.MeshStandardNodeMaterial();
  m.metalness = 0;
  m.roughness = rough;
  return m;
}

function road() {
  const m = std(0.32);
  const wearLo = n01(P.mul(0.035));                  // ~30 m blotches
  const wearMid = n01(P.mul(0.19).add(vec2(5.3, 1.7)));   // ~5 m
  const grain = n01(P.mul(11.0));                    // fine asphalt aggregate
  // tire-track lane polish along the 3.4 m Manhattan lanes (smoother wheel tracks catch long street-lamp & neon streaks)
  const lanePos = fract(R.x.div(3.4)).sub(0.5).abs();
  const tireTrack = smoothstep(0.36, 0.16, abs(lanePos.sub(0.24))).mul(smoothstep(0.75, 0.96, ao));
  // repair patches: a few rectangles per 9 x 5 m cell, darker and smoother (fresh asphalt)
  const cs = vec2(9.0, 5.0);
  const cell = floor(R.div(cs));
  const loc = fract(R.div(cs));
  const h1 = cellHash(cell), h2 = cellHash(cell.add(vec2(3.0, 7.0))), h3 = cellHash(cell.add(vec2(11.0, 2.0)));
  const x0 = float(0.1), y0 = float(0.15).add(h3.mul(0.2));
  const inX = step(x0, loc.x).mul(step(loc.x, x0.add(h2.mul(0.5).add(0.12))));
  const inY = step(y0, loc.y).mul(step(loc.y, y0.add(h2.mul(0.25).add(0.12))));
  const patch = step(h1, 0.14).mul(inX).mul(inY);
  // NYC cast-iron manhole covers (r = 0.42 m with tar collar & waffle pattern)
  const mcs = vec2(12.0, 19.0);
  const mCell = floor(R.div(mcs));
  const mHas = step(cellHash(mCell.add(vec2(19.0, 3.0))), 0.58).mul(step(0.84, ao));
  const mCtr = vec2(0.32, 0.32).add(vec2(cellHash(mCell), cellHash(mCell.add(vec2(7.0, 13.0)))).mul(0.36));
  const mDist = length(fract(R.div(mcs)).sub(mCtr).mul(mcs));
  const manhole = float(1).sub(smoothstep(0.39, 0.43, mDist)).mul(mHas);
  const mCollar = smoothstep(0.37, 0.42, mDist).mul(float(1).sub(smoothstep(0.42, 0.54, mDist))).mul(mHas);
  const waffle = step(0.42, fract(R.x.mul(18.0))).mul(step(0.42, fract(R.y.mul(18.0)))).mul(near);
  // cracks: thin lines where the two nearest cell distances of a worley field nearly meet, only in worn zones
  const w = worleyEdge(R.mul(0.55).add(vec2(11.0, 7.0)));
  const crack = float(1).sub(smoothstep(0.0, 0.028, w)).mul(smoothstep(0.58, 0.78, wearLo)).mul(near);
  // puddles: large-scale noise peaks plus the gutter (low baked alpha at the kerb) collecting water
  const gutter = float(1).sub(smoothstep(0.76, 0.98, ao));
  const pud = max(smoothstep(0.58, 0.74, n01(P.mul(0.068).add(vec2(3.1, 9.4)))), gutter.mul(smoothstep(0.45, 0.72, wearMid))).mul(float(1).sub(manhole));
  let albedo: any = vec3(0.028, 0.030, 0.036).mul(mix(0.72, 1.38, wearLo)).mul(mix(0.88, 1.12, wearMid)).mul(float(0.88).add(grain.mul(0.24)));
  albedo = albedo.mul(mix(1.0, 0.65, patch)).mul(mix(1.0, 0.52, crack)).mul(mix(1.0, 0.86, tireTrack)).mul(mix(1.0, 0.45, mCollar));
  const ironCol = vec3(0.065, 0.058, 0.054).mul(float(0.82).add(waffle.mul(0.35)));
  albedo = mix(albedo, ironCol, manhole).mul(mix(1.0, 0.48, pud)).mul(mix(0.52, 1.0, ao));
  m.colorNode = albedo;
  let rough: any = float(0.29).add(grain.mul(0.15).mul(near)).add(float(1).sub(wearLo).mul(0.06)).sub(tireTrack.mul(0.07)).add(patch.mul(0.05)).add(crack.mul(0.38));
  rough = mix(rough, float(0.36).sub(waffle.mul(0.12)), manhole);
  rough = mix(rough, float(0.022), pud);
  m.roughnessNode = clamp(rough, 0.02, 1.0);
  m.metalnessNode = manhole.mul(0.65);
  // Subtle rain micro-ripples on deep puddles, fading smoothly into asphalt grain outside puddles
  const ripple = n01(P.mul(6.5).add(vec2(time.mul(0.45), time.mul(-0.35)))).mul(pud).mul(0.18);
  const height = grain.mul(0.5).sub(crack.mul(1.5)).add(patch.mul(0.25)).add(manhole.mul(waffle.mul(0.6).add(0.3))).mul(float(1).sub(pud.mul(0.88))).add(ripple);
  m.normalNode = bumpMap(height, near.mul(0.42));
  return m;
}

function sidewalk() {
  const m = std(0.65);
  const SLAB = 1.52;                                  // 5 ft squares
  const q = R.div(SLAB);
  const f = fract(q), id = floor(q);
  const dj = min(min(f.x, float(1).sub(f.x)), min(f.y, float(1).sub(f.y))).mul(SLAB);   // metres to the nearest joint
  const joint = float(1).sub(smoothstep(0.004, 0.022, dj));
  const jointV = joint.mul(mix(0.35, 1.0, near));
  const tint = cellHash(id).mul(0.24).add(0.88);
  const wearLo = n01(P.mul(0.05).add(vec2(2.0, 8.0)));
  const wearMid = n01(P.mul(0.31));
  const speck = n01(P.mul(17.0));
  const damp = step(0.76, cellHash(id.add(vec2(5.0, 1.0)))).mul(0.8).add(smoothstep(0.62, 0.8, wearMid).mul(0.5));   // slabs that stayed wet
  let albedo: any = vec3(0.165, 0.162, 0.158).mul(tint).mul(mix(0.78, 1.12, wearLo)).mul(float(0.92).add(speck.mul(0.16).mul(near)));
  albedo = albedo.mul(mix(1.0, 0.42, jointV)).mul(mix(1.0, 0.68, clamp(damp, 0, 1))).mul(mix(0.48, 1.0, ao));
  m.colorNode = albedo;
  const rough = mix(float(0.72).sub(speck.mul(0.15)), float(0.28), clamp(damp, 0, 1));
  m.roughnessNode = mix(rough, float(0.9), jointV);
  m.normalNode = bumpMap(speck.mul(0.15).sub(joint.mul(0.8)), near.mul(0.32));
  return m;
}

function curb() {
  const m = std(0.62);
  const top = step(0.5, normalWorld.y);
  const s = n01(P.mul(6.0));
  const grime = mix(0.45, 1.0, smoothstep(0.0, 0.14, abs(P.y)));    // faces: UV v = height above the road (m)
  const gradient = mix(grime, float(1.0), top);
  m.colorNode = vec3(0.34, 0.335, 0.32).mul(vc.rgb).mul(mix(0.8, 1.15, s)).mul(gradient);
  m.roughnessNode = float(0.6).add(s.mul(0.2));
  return m;
}

function paint(base: 'marking' | 'crosswalk') {
  const m = std(0.45);
  const wear = n01(P.mul(4.5)).mul(0.6).add(n01(P.mul(23.0)).mul(0.4));
  let coverage: any;
  if (base === 'crosswalk') {
    // local UV: u across, v along the road. Bars run along the traffic direction (continental zebra): 0.5 m paint, 0.4 m gap
    const U = uv().x;
    const bar = step(fract(U.div(0.9).add(0.05)), 0.56);
    coverage = mix(0.7, bar, float(1).sub(smoothstep(22, 60, dist)));   // far: the average, no moire
  } else {
    coverage = float(1);
  }
  const eroded = step(0.78, wear.add(hash(floor(P.mul(60.0)).x.add(floor(P.mul(60.0)).y.mul(91.7))).mul(0.12)));
  m.opacityNode = coverage.mul(float(1).sub(eroded));
  m.alphaTest = 0.5;
  m.transparent = false;
  m.depthWrite = true;
  m.polygonOffset = true;
  m.polygonOffsetFactor = -2;
  m.polygonOffsetUnits = -6;
  const col: any = base === 'crosswalk' ? vec3(0.82, 0.82, 0.8) : vc.rgb.mul(0.82);
  const dull = mix(0.7, 1.0, n01(P.mul(0.4)));
  m.colorNode = col.mul(dull);
  m.emissiveNode = col.mul(0.035);   // glass-bead paint: reads a little at night even away from lamps
  m.roughnessNode = float(0.4).add(wear.mul(0.35));
  return m;
}

function plaza() {
  const m = std(0.5);
  // running-bond pavers 0.9 x 0.45 m
  const row = floor(R.y.div(0.45));
  const off = fract(row.mul(0.5)).mul(0.9);
  const sx = R.x.add(off).div(0.9);
  const col = floor(sx);
  const fx = fract(sx).sub(0.5).abs().mul(0.9), fy = fract(R.y.div(0.45)).sub(0.5).abs().mul(0.45);
  const dj = min(float(0.45).sub(fx), float(0.225).sub(fy));
  const joint = float(1).sub(smoothstep(0.003, 0.016, dj)).mul(mix(0.3, 1.0, near));
  const id = vec2(col, row);
  const tint = cellHash(id).mul(0.4).add(0.8);
  const wearLo = n01(P.mul(0.06).add(vec2(9.0, 3.0)));
  const speck = n01(P.mul(15.0));
  const damp = smoothstep(0.55, 0.78, n01(P.mul(0.2).add(vec2(1.0, 4.0))));
  let albedo: any = vec3(0.3, 0.27, 0.24).mul(vc.rgb).mul(tint).mul(mix(0.75, 1.1, wearLo)).mul(float(0.9).add(speck.mul(0.2).mul(near)));
  albedo = albedo.mul(mix(1.0, 0.45, joint)).mul(mix(1.0, 0.7, damp)).mul(mix(0.55, 1.0, ao));
  m.colorNode = albedo;
  m.roughnessNode = mix(mix(float(0.55), float(0.3), damp), float(0.9), joint);
  m.normalNode = bumpMap(speck.mul(0.12).sub(joint.mul(0.7)), near.mul(0.25));
  return m;
}

function grass() {
  const m = std(0.92);
  const big = n01(P.mul(0.09).add(vec2(4.0, 6.0)));
  const mid = n01(P.mul(0.8));
  const fine = n01(P.mul(14.0));
  const mud = smoothstep(0.7, 0.85, n01(P.mul(0.23).add(vec2(8.0, 2.0))));
  const green = mix(vec3(0.035, 0.07, 0.022), vec3(0.075, 0.125, 0.035), mid.mul(0.6).add(big.mul(0.4)));
  const dry = mix(green, vec3(0.1, 0.09, 0.04), smoothstep(0.55, 0.9, big).mul(0.5));
  m.colorNode = mix(dry, vec3(0.05, 0.04, 0.03), mud).mul(float(0.85).add(fine.mul(0.3).mul(near)));
  m.roughnessNode = float(0.88).sub(mud.mul(0.15));
  m.normalNode = bumpMap(fine.mul(0.5).add(mid.mul(0.3)), near.mul(0.5));
  return m;
}

function water() {
  const m = std(0.05);
  const t = time;
  const a = n01(P.mul(0.55).add(vec2(t.mul(0.22), t.mul(0.13))));
  const b = n01(P.mul(1.7).sub(vec2(t.mul(0.31), t.mul(-0.2))));
  const c = n01(P.mul(5.0).add(vec2(t.mul(0.5), t.mul(-0.4))));
  const h = a.mul(0.6).add(b.mul(0.3)).add(c.mul(0.1).mul(near));
  m.normalNode = bumpMap(h, float(0.9));
  m.colorNode = vec3(0.008, 0.026, 0.04).mul(mix(0.8, 1.35, n01(P.mul(0.02))));
  m.roughnessNode = float(0.05).add(float(1).sub(near).mul(0.12));
  return m;
}

function rail() {
  const m = std(0.85);
  const g = n01(P.mul(11.0));
  const rust = n01(P.mul(0.7));
  m.colorNode = mix(vec3(0.11, 0.1, 0.095), vec3(0.15, 0.09, 0.06), smoothstep(0.55, 0.8, rust)).mul(float(0.8).add(g.mul(0.4)));
  m.normalNode = bumpMap(g, near.mul(0.6));
  return m;
}

let cached: Record<GroundMaterialName, THREE.Material> | null = null;

/** Shared singletons keyed by the glb material names. Compile them once (renderer.compileAsync) before the first tile streams in. */
export function createGroundMaterials(): Record<string, THREE.Material> {
  if (cached) return cached;
  cached = {
    road: road(), sidewalk: sidewalk(), curb: curb(), marking: paint('marking'), crosswalk: paint('crosswalk'),
    plaza: plaza(), grass: grass(), water: water(), rail: rail(),
  };
  for (const [k, m] of Object.entries(cached)) m.name = k;
  return cached;
}
