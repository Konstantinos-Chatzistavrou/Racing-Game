// Procedural New York facades: NO textures. One TSL material per surface kind (facade walls, roofs), driven by
//   - TEXCOORD_0 = (metres along the wall, metres up from the ground)      [tools/nyc/buildings.py]
//   - COLOR_0    = wall tint (rgb, linear), alpha = baked AO
//   - _BLD       = (seed 0..1, floors, kind, era)  kind 0 walk-up, 1 mid-rise, 2 office, 3 glass tower, 4 loft/industrial, 5 landmark; era 0 (<1900) .. 1 (>2000)
// and builds floors, bays, windows (sills, lintels, sashes, ribbon glazing), a storefront band with signage on the lower 4.6 m, brick/stone
// courses, grime, and per-window night lighting (hash per window: lit/unlit, colour, curtains, fully lit office floors) that drives bloom.
// Cheap by construction: no texture fetches, a handful of integer-free hashes, no per-pixel branches (selects only). Detail is filtered with
// screen-space derivatives (fwidth): windows, bricks and storefront fade to their average colour as a pixel covers more than a fraction of one
// period, so far facades (and far.glb) do not shimmer and cost the same.
import * as THREE from 'three/webgpu';
import { attribute, clamp, dot, float, floor, fract, fwidth, max, mix, normalView, normalWorld, abs, positionView, positionWorld, pow, select, sin, smoothstep, step, uniform, uv, vec2, vec3 } from 'three/tsl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** Shared knobs: facadeUniforms.night 0 (day, windows dark) .. 1 (night, windows lit). Changing it needs no recompile. */
export const facadeUniforms = { night: uniform(1.0), lit: uniform(1.0) };

/** Floor height (m) per kind: keep in sync with FLOOR_H in tools/nyc/buildings.py. */
export const FLOOR_H = [3.4, 3.6, 4.0, 4.1, 4.2, 4.0];
/** Height of the storefront band (m). */
export const GROUND_H = 4.6;
// emissive peaks (the bloom threshold is 1.0: only the brightest lit windows / signs bloom)
const WINDOW_EM = 1.08, SHOP_EM = 0.26, SIGN_EM = 0.62;

const lut = (k: N, v: number[]): N => {
  let r: N = float(v[0]);
  for (let i = 1; i < v.length; i++) r = select(k.greaterThan(i - 0.5), float(v[i]), r);
  return r;
};
/** box-filtered step: 1 when x >= 0, with a ramp of width w (pixel footprint) around 0. */
const cov = (x: N, w: N): N => clamp(x.div(max(w, 1e-4)).add(0.5), 0, 1);
const hash11 = (x: N): N => fract(sin(x.mul(127.1)).mul(43758.5453));
const hash12 = (p: N): N => {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(0.1031));
  const q = p3.add(dot(p3, p3.yzx.add(33.33)));
  return fract(q.x.add(q.y).mul(q.z));
};
const v3 = (a: number, b: number, c: number): N => vec3(a, b, c);

function facadeGraph() {
  const U = uv();
  const u = U.x, v = U.y;
  const bld = attribute('_bld', 'vec4');
  const col = attribute('color', 'vec4');
  const seed = bld.x, kind = bld.z, era = bld.w;
  const tint = col.rgb, ao = col.a;
  const fw = fwidth(U).toVar();
  const night = facadeUniforms.night;

  // ---- per-building parameters
  const k2 = step(1.5, kind).mul(step(kind, 2.5));          // office
  const k3 = step(2.5, kind).mul(step(kind, 3.5));          // glass tower
  const modern = step(0.5, era);
  const fh = lut(kind, [3.4, 3.6, 4.0, 4.1, 4.2, 4.0]);
  const bw = mix(lut(kind, [2.5, 3.3, 3.0, 1.5, 3.4, 2.6]), mix(3.0, 1.5, modern), k2).mul(hash11(seed.mul(7.3)).mul(0.24).add(0.88));
  const kmod = k2.mul(modern);
  const wf = mix(lut(kind, [0.42, 0.52, 0.55, 0.96, 0.7, 0.45]), 0.93, kmod);
  const wy0 = mix(lut(kind, [0.22, 0.27, 0.25, 0.06, 0.18, 0.22]), 0.2, kmod);
  const wy1 = mix(lut(kind, [0.82, 0.78, 0.8, 0.93, 0.88, 0.82]), 0.9, kmod);
  const old = float(1).sub(k3).mul(float(1).sub(kmod));      // sills / lintels / sashes
  const gf = float(GROUND_H);

  // ---- floors and bays
  const yy = max(v.sub(gf), 0);
  const fidx: N = floor(yy.div(fh)).toVar();
  const fy = fract(yy.div(fh));
  const cx = u.div(bw).add(fract(seed.mul(13.7)));
  const ci: N = floor(cx).toVar();
  const fx = fract(cx);
  const wx = fw.x.div(bw), wyw = fw.y.div(fh);
  const x0 = float(1).sub(wf).mul(0.5);
  const winArea = wf.mul(wy1.sub(wy0));
  const dfade = float(1).sub(smoothstep(0.24, 0.78, max(wx, wyw)));              // 1 = pattern visible, 0 = averaged
  const winP = cov(fx.sub(x0), wx).mul(cov(float(1).sub(x0).sub(fx), wx)).mul(cov(fy.sub(wy0), wyw)).mul(cov(wy1.sub(fy), wyw));
  const win = mix(winArea, winP, dfade).toVar();
  // sash rail (double hung) and a muntin on wide windows; thin lines, vanish with distance
  const wl = fy.sub(wy0).div(wy1.sub(wy0));
  const rail = float(1).sub(cov(abs(wl.sub(0.5)).mul(wy1.sub(wy0)).mul(fh).sub(0.025), fw.y)).mul(old).mul(dfade);
  const munt = float(1).sub(cov(abs(fx.sub(0.5)).mul(bw).sub(0.025), fw.x)).mul(step(0.5, kind)).mul(step(kind, 1.5).add(step(3.5, kind).mul(step(kind, 4.5)))).mul(dfade).mul(old);
  // sills and lintels in stone
  const sx = float(0.07).div(bw), sH = float(0.15).div(fh), lH = float(0.2).div(fh);
  const inX = cov(fx.sub(x0.sub(sx)), wx).mul(cov(float(1).sub(x0).add(sx).sub(fx), wx));
  const sill = inX.mul(cov(fy.sub(wy0.sub(sH)), wyw)).mul(cov(wy0.sub(fy), wyw));
  const lintel = inX.mul(cov(fy.sub(wy1), wyw)).mul(cov(wy1.add(lH).sub(fy), wyw));
  const slab = cov(float(0.07).sub(fy), wyw).mul(step(1.5, kind));
  const trim = clamp(sill.add(lintel).mul(old).add(slab.mul(float(1).sub(k3).mul(0.8))), 0, 1).mul(dfade);

  // ---- wall surface: brick courses or stone joints, per-brick noise, blotches, grime
  const isBrick = step(1.7, tint.r.div(tint.b.add(0.02)));
  const cH = mix(0.9, 0.0825, isBrick), cL = mix(1.4, 0.215, isBrick);
  const rowF = v.div(cH), row = floor(rowF);
  const colF = u.div(cL).add(row.mul(0.5).sub(floor(row.mul(0.5))).mul(1.0));       // stagger every other row by half a brick
  const jy = float(1).sub(cov(fract(rowF).sub(mix(0.03, 0.14, isBrick)), fw.y.div(cH)));
  const jx = float(1).sub(cov(fract(colF).sub(mix(0.012, 0.045, isBrick)), fw.x.div(cL)));
  const bfade = float(1).sub(smoothstep(0.25, 0.8, max(fw.y.div(cH), fw.x.div(cL))));
  const joint = max(jy, jx.mul(isBrick.add(0.35))).mul(bfade);
  const bnoise = hash12(vec2(floor(colF), row.add(seed.mul(61.0))));
  const blot = sin(u.mul(0.23).add(seed.mul(40))).mul(0.5).add(0.5).mul(sin(v.mul(0.11).add(seed.mul(20))).mul(0.5).add(0.5)).mul(0.16).add(0.92);
  const streak = hash12(vec2(floor(u.mul(2.5)), floor(seed.mul(997))));
  const grime = streak.mul(smoothstep(0.5, 0.0, fy)).mul(0.3).mul(dfade).add(float(1).sub(smoothstep(0.0, 25.0, v)).mul(0.14));
  const brickCol = tint.mul(bnoise.sub(0.5).mul(0.35).mul(bfade).mul(isBrick).add(1.0)).mul(blot);
  const jointCol = tint.mul(0.45).add(0.1);
  const wallLit = mix(brickCol, jointCol, joint.mul(0.55)).mul(float(1).sub(grime));
  const wallCol = mix(wallLit, tint.mul(0.3), k3);                                  // glass towers: dark spandrel panels
  const stoneCol = clamp(tint.mul(1.4).add(0.06), 0, 1);

  // ---- window light at night
  const sd2: N = floor(seed.mul(997)).toVar();
  const h1 = hash12(vec2(ci.add(sd2.mul(1.37)), fidx));
  const h2 = hash12(vec2(ci.mul(1.7).add(11.3), fidx.add(sd2.mul(0.73)).add(5.1)));
  const h3 = hash12(vec2(ci.add(31.7), fidx.mul(1.3).add(sd2)));
  const h4 = hash12(vec2(ci.mul(0.37).add(sd2), fidx.mul(2.1).add(77.0)));
  const office = step(1.5, kind).mul(step(kind, 3.5));
  const litFrac = hash11(seed.mul(3.1)).mul(0.2).add(0.25).sub(office.mul(0.1));
  const fullFloor = step(hash12(vec2(fidx.add(sd2), sd2.mul(0.31))), 0.1).mul(office);
  const litOn = max(step(h1, litFrac), fullFloor.mul(step(h3, 0.9)));
  const warm = mix(v3(1.0, 0.66, 0.34), v3(1.0, 0.82, 0.58), clamp(h2.mul(2.2), 0, 1));
  const cool = select(h2.greaterThan(0.93), v3(0.35, 0.5, 1.0), v3(0.72, 0.86, 1.0));
  const coolSel = step(float(0.74).sub(office.mul(0.3)), h2);
  const lightCol = mix(warm, cool, coolSel);
  const curtain = step(0.7, h4).mul(float(1).sub(office));
  const wlx = select(h3.greaterThan(0.5), fx.sub(x0).div(wf), float(1).sub(fx.sub(x0).div(wf)));
  const curt = mix(1.0, smoothstep(0.0, 0.75, wlx).mul(0.7).add(0.3), curtain);
  // Venetian blinds, interior parallax room partitions & ceiling troffer light strips inside lit rooms
  const hasBlinds = step(0.62, h4).mul(office);
  const blindDrop = smoothstep(float(1).sub(h2.mul(0.55).add(0.2)), float(1).sub(h2.mul(0.55).add(0.15)), wl);
  const blindSlats = mix(0.45, 0.92, step(0.38, fract(fy.mul(22.0))));
  const blinds = mix(1.0, mix(1.0, blindSlats, blindDrop), hasBlinds.mul(dfade));
  // Fake interior parallax using view-space angle
  const vDir = positionView.normalize();
  const roomX = clamp(wlx.add(vDir.x.mul(0.28)), 0, 1);
  const roomY = clamp(wl.sub(vDir.y.mul(0.32)), 0, 1);
  // Ceiling fluorescent troffers (offices) + back-wall vertical partitions/furniture silhouettes
  const troffer = smoothstep(0.68, 0.92, roomY).mul(step(0.25, fract(roomX.mul(3.0).add(h1))));
  const partition = mix(1.0, 0.42, step(0.84, fract(roomX.mul(2.0).add(h4))).mul(step(roomY, 0.72)));
  const deskSil = smoothstep(0.12, 0.28, wl);
  const ceilGlow = smoothstep(0.18, 0.92, roomY).mul(0.58).add(0.38).add(troffer.mul(office).mul(0.45));
  const lamp = h3.mul(0.8).add(0.5).mul(ceilGlow).mul(partition).mul(deskSil).mul(curt).mul(blinds);
  const litAvg = litFrac.mul(0.34);
  const lit = mix(litAvg, litOn.mul(lamp), dfade);
  const emWin = lightCol.mul(win).mul(lit).mul(WINDOW_EM);

  // ---- ground floor: storefront glass, bulkhead, signs, roll-down shutters
  const gAA = cov(gf.sub(v), fw.y);                                     // 1 below gf
  const sbw = hash11(seed.mul(3.3)).mul(2.6).add(4.2);
  const sxF = u.div(sbw).add(fract(seed.mul(5.9)));
  const sid = floor(sxF), sf = fract(sxF), swx = fw.x.div(sbw);
  const pier = select(kind.greaterThan(2.5), float(0.10), hash11(seed.mul(5.1)).mul(0.06).add(0.14));
  const sgx = cov(sf.sub(pier), swx).mul(cov(float(1).sub(pier).sub(sf), swx));
  const sgy = cov(v.sub(0.68), fw.y).mul(cov(gf.sub(1.35).sub(v), fw.y));
  const shopGlass = sgx.mul(sgy);
  const hs = hash12(vec2(sid, sd2));
  const hs2 = hash11(sid.mul(1.7).add(sd2));
  const open = step(hs, 0.44);
  const shut = step(0.44, hs).mul(step(hs, 0.72)).mul(float(1).sub(k3));
  const lobby = step(0.72, hs);
  const shopCol = select(hs2.lessThan(0.35), v3(1.0, 0.72, 0.42), select(hs2.lessThan(0.68), v3(0.98, 0.88, 0.72), select(hs2.lessThan(0.88), v3(0.78, 0.88, 1.0), v3(1.0, 0.58, 0.32))));
  const signY = cov(v.sub(gf.sub(1.15)), fw.y).mul(cov(gf.sub(0.42).sub(v), fw.y));
  const signX = cov(sf.sub(0.20), swx).mul(cov(float(0.80).sub(sf), swx));
  const signOn = step(0.58, hs2).mul(float(1).sub(k3)).mul(open);
  const sign = signX.mul(signY).mul(signOn);
  const hc = floor(hs.mul(5.0));
  const signCol = select(hc.lessThan(0.5), v3(1.0, 0.88, 0.72), select(hc.lessThan(1.5), v3(0.95, 0.68, 0.22), select(hc.lessThan(2.5), v3(0.75, 0.9, 1.0),
    select(hc.lessThan(3.5), v3(0.95, 0.28, 0.18), v3(0.92, 0.95, 0.98)))));
  // Crisp procedural glyph strokes inside centered fascia band
  const gx = floor(u.mul(6.5)), gy = floor(v.mul(9.0));
  const gCell = hash12(vec2(gx.add(sid.mul(19.0)), gy.add(sd2)));
  const gStroke = step(0.48, gCell).mul(step(0.22, fract(u.mul(6.5)))).mul(step(0.25, fract(v.mul(9.0))));
  const letters = mix(0.28, gStroke, float(1).sub(smoothstep(0.08, 0.32, fw.x.mul(6.5))));
  const ribs = step(0.5, fract(v.mul(8.0))).mul(0.22).add(0.78);
  const cornice = cov(v.sub(gf.sub(0.28)), fw.y).mul(cov(gf.sub(v), fw.y));
  const pierCol = mix(wallLit.mul(0.76), stoneCol.mul(0.85), cornice);
  const gCol = mix(pierCol, v3(0.012, 0.015, 0.02), shopGlass);
  const gCol2 = mix(gCol, v3(0.07, 0.075, 0.085).mul(ribs), shopGlass.mul(shut));
  const gAlb = mix(gCol2, v3(0.015, 0.018, 0.022), sign);
  // Storefront interior: horizontal display shelves, back-wall depth, wide bronze mullions & transom bar
  const shelf = mix(0.48, 1.0, step(0.22, fract(v.mul(1.35).add(hs))));
  const bayArch = smoothstep(0.0, 0.18, sf.sub(pier)).mul(smoothstep(0.0, 0.18, float(1).sub(pier).sub(sf)));
  const sgrad = smoothstep(0.68, 1.45, v).mul(smoothstep(0.5, 3.2, v).mul(0.65).add(0.35)).mul(shelf).mul(bayArch);
  const transom = float(1).sub(cov(abs(v.sub(2.55)).sub(0.045), fw.y)).mul(0.9);
  const mullion = float(1).sub(cov(abs(sf.sub(0.5)).mul(sbw).sub(0.035), fw.x)).mul(0.88);
  const frame = float(1).sub(max(transom, mullion));
  const lobbyGlow = smoothstep(1.9, 3.0, v).mul(bayArch).mul(lobby).mul(0.26);
  const gEm = shopCol.mul(shopGlass).mul(open.mul(sgrad).add(lobbyGlow)).mul(frame).mul(SHOP_EM).add(signCol.mul(sign).mul(letters).mul(SIGN_EM));

  // ---- compose
  const glassKind = mix(v3(0.012, 0.016, 0.024), tint.mul(0.9), k3);
  const stoneMix = clamp(trim, 0, 1);
  const upperWall = mix(wallCol, stoneCol, stoneMix);
  const upperAlb = mix(upperWall, glassKind, win.mul(float(1).sub(rail.mul(0.7)).sub(munt.mul(0.7))));
  const albedo = mix(upperAlb, gAlb, gAA);
  const aoG = mix(0.6, 1.0, smoothstep(0.0, 5.0, v));
  const emUpper = emWin.mul(float(1).sub(rail.mul(0.8)).sub(munt.mul(0.8)));
  const winMask = mix(win, clamp(shopGlass.add(sign), 0, 1), gAA);
  // glass reflection of the lit city (fake, view dependent) on every window, strong on glass towers
  const fres = pow(float(1).sub(clamp(dot(normalView, positionView.negate().normalize()), 0, 1)), 3.0);
  const skyC = mix(v3(0.05, 0.07, 0.11), v3(0.24, 0.14, 0.07), float(1).sub(smoothstep(0.0, 140.0, v)));
  const refl = skyC.mul(fres).mul(mix(0.35, 1.1, k3)).mul(win.add(shopGlass.mul(float(1).sub(shut)).mul(gAA)));
  // city glow on the walls themselves (light pollution / street light spill, strongest near the street), keeps brick vs stone readable at night
  const glow = upperWall.mul(float(1).sub(smoothstep(0.0, 28.0, v)).mul(0.14).add(0.055)).mul(float(1).sub(winMask)).mul(float(1).sub(k3.mul(0.5)));
  // architectural crown floodlighting on landmarks (Empire State, Chrysler, 30 Rock, One WTC) and high setback tiers
  const isLandmark = step(4.5, kind);
  const topFrac = clamp(v.div(max(bld.y.mul(fh), 40.0)), 0, 1);
  const crownBand = smoothstep(0.68, 0.96, topFrac).mul(isLandmark.add(step(120.0, v).mul(0.35)));
  const crownCol = mix(v3(1.0, 0.76, 0.44), v3(0.55, 0.78, 1.0), step(0.55, fract(seed.mul(19.3))));
  const crownGlow = crownCol.mul(crownBand).mul(float(1).sub(win.mul(0.5))).mul(0.38);
  const emissive = mix(emUpper, gEm, gAA).mul(night).add(glow.mul(night)).add(crownGlow.mul(night)).add(refl.mul(night.mul(0.75).add(0.3)));
  const color = albedo.mul(ao.mul(aoG));
  const rough = mix(mix(0.9, 0.72, float(1).sub(isBrick)), mix(0.14, 0.05, k3), winMask);
  const metal = mix(float(0.0), mix(0.15, 0.32, k3), winMask);
  return { color, emissive, rough, metal };
}

export function createFacadeMaterial(): THREE.Material {
  const g = facadeGraph();
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = 'nyc-facade';
  m.colorNode = g.color;
  m.emissiveNode = g.emissive;
  m.roughnessNode = g.rough;
  m.metalnessNode = g.metal;
  return m;
}

function roofGraph() {
  const U = uv();
  const col = attribute('color', 'vec4');
  const fw = fwidth(U).toVar();
  const up = step(0.7, normalWorld.y);
  // tar roofs: speckle; vertical faces (penthouses, parapets): panel / louvre bands
  const speck = hash12(floor(positionWorld.xz.mul(5.0))).mul(0.3).add(0.85);
  const band = step(0.5, fract(U.y.div(0.35))).mul(0.2).add(0.8);
  const lod = float(1).sub(smoothstep(0.1, 0.4, fw.y.div(0.35)));
  const panel = mix(1.0, band, lod);
  const detail = mix(panel, speck, up);
  const color = col.rgb.mul(detail).mul(col.a);
  return { color };
}

export function createRoofMaterial(): THREE.Material {
  const g = roofGraph();
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = 'nyc-roof';
  m.colorNode = g.color;
  m.roughnessNode = float(0.9);
  m.metalnessNode = float(0.0);
  return m;
}
