// Photorealistic procedural building facade + roof materials for New York (docs/nyc_buildings.md).
// - True 3D Ray-Box Interior Mapping (PS5 Spider-Man style): exact ray-box intersection in wall-tangent space
//   producing real receding 3D ceilings, floors, side walls, back walls, mid-room furniture depth, and
//   world-space 3D exterior glass reflections with per-pane thermal warp.
// (Wall breaches are geometry + a depth portal, breach.ts: the facade shader never changes.)
import * as THREE from 'three/webgpu';
import {
  attribute, uv, positionView, positionWorld, cameraPosition, normalWorld, frontFacing, uniform,
  float, vec2, vec3, select, mix, step, smoothstep, clamp, floor, fract, mod, abs, min, max,
  sin, cos, dot, length, pow, fwidth, texture, bumpMap, reflect,
} from 'three/tsl';
import { getSignAtlasTexture } from './signAtlas';

export const facadeNight = uniform(1.0);
const WINDOW_EM = uniform(1.35);
const SHOP_EM = uniform(1.25);
const SIGN_EM = uniform(3.6);


const v3 = (r: number, g: number, b: number) => vec3(r, g, b);
const hash11 = (p: any) => fract(sin(p.mul(127.1)).mul(43758.5453));
const hash12 = (p: any) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));
const cov = (d: any, w: any) => smoothstep(w.negate(), w, d);
const pulse = (x: any, a: any, b: any, w: any) => cov(x.sub(a), w).mul(cov(b.sub(x), w));

/**
 * Exact 3D Ray-Box Interior Mapping in wall-tangent coordinates.
 * Given a window's normalized cell coordinates (uWin in 0..1, vWin in 0..1) and room depth `depth`,
 * intersects the camera-to-fragment ray with the 5 interior planes of the 3D box behind the glass:
 * ceiling (y=1), floor (y=0), left wall (x=0), right wall (x=1), and back wall (z=depth).
 */
function rayBoxRoom(uWin: any, vWin: any, rayX: any, rayY: any, rayZ: any, depth: any) {
  // Architectural double-pane glass refracts grazing street-level rays inward (Snell's law IOR ~1.52),
  // ensuring you always see into the 3D room (side wall + ceiling + floor + back wall) down long avenues.
  const rx = rayX.mul(0.54);
  const ry = rayY.mul(0.64);
  const rz = max(mix(rayZ, float(0.82), 0.58), 0.48);
  const tBack = depth.div(rz);
  const rySafe = select(ry.greaterThanEqual(0), max(ry, 0.001), min(ry, -0.001));
  const tY = select(ry.greaterThanEqual(0), float(1).sub(vWin).div(rySafe), vWin.negate().div(rySafe));
  const rxSafe = select(rx.greaterThanEqual(0), max(rx, 0.001), min(rx, -0.001));
  const tX = select(rx.greaterThanEqual(0), float(1).sub(uWin).div(rxSafe), uWin.negate().div(rxSafe));
  const tHit = min(tBack, min(tY, tX));

  const hitX = clamp(uWin.add(rx.mul(tHit)), 0, 1);
  const hitY = clamp(vWin.add(ry.mul(tHit)), 0, 1);
  const hitZ = clamp(rz.mul(tHit).div(depth), 0, 1); // 0 at window plane -> 1 at back wall

  // Mid-room 3D parallax plane at z = 0.46 * depth (for 3D desks, monitors, partitions, retail counters/racks)
  const tMid = tBack.mul(0.46);
  const midX = uWin.add(rx.mul(tMid));
  const midY = vWin.add(ry.mul(tMid));
  const inMid = step(tMid, tHit).mul(step(0.02, midX)).mul(step(midX, 0.98)).mul(step(0.0, midY)).mul(step(midY, 0.96));

  const onCeil = step(tY.sub(0.002), tHit).mul(step(0, ry));
  const onFloor = step(tY.sub(0.002), tHit).mul(step(ry, 0));
  const onSide = step(tX.sub(0.002), tHit).mul(float(1).sub(onCeil)).mul(float(1).sub(onFloor));
  const onBack = float(1).sub(max(onCeil, max(onFloor, onSide)));

  // 3D crease ambient occlusion in the corners where walls, ceiling, and floor meet
  const edgeX = smoothstep(0.0, 0.16, min(hitX, float(1).sub(hitX)));
  const edgeY = smoothstep(0.0, 0.16, min(hitY, float(1).sub(hitY)));
  const edgeZ = smoothstep(0.0, 0.22, float(1).sub(hitZ).add(0.12));
  const roomAO = mix(0.18, 1.0, min(edgeX, edgeY).mul(edgeZ));

  return { hitX, hitY, hitZ, midX, midY, inMid, onCeil, onFloor, onSide, onBack, roomAO };
}

function facadeGraph() {
  const U = uv();
  const u = U.x, v = U.y;
  const col = attribute('color', 'vec4');
  const bld = attribute('_bld', 'vec4');
  const tint = col.rgb, ao = col.a;
  const seed = bld.x, kind = bld.z, era = bld.w;

  const fw = max(fwidth(U), vec2(1e-4, 1e-4)).toVar();
  const dist = positionView.z.negate();
  const dfade = float(1).sub(smoothstep(90.0, 260.0, dist));
  const mfade = float(1).sub(smoothstep(22.0, 72.0, dist));

  // World-space view vector & wall tangent basis for true 3D interior ray-casting and 3D glass reflections
  const V = positionWorld.sub(cameraPosition).normalize();
  const Nw = normalWorld.normalize();
  const Tw = vec3(Nw.z.negate(), float(0.0), Nw.x).normalize();
  const rayX = dot(V, Tw);
  const rayY = V.y;
  const rayZ = max(dot(V.negate(), Nw), 0.05);

  const k0 = step(kind, 0.5);
  const k1 = step(0.5, kind).mul(step(kind, 1.5));
  const k2 = step(1.5, kind).mul(step(kind, 2.5));
  const k3 = step(2.5, kind).mul(step(kind, 3.5));
  const k4 = step(3.5, kind).mul(step(kind, 4.5));

  const fh = select(kind.lessThan(0.5), float(3.4),
    select(kind.lessThan(1.5), float(3.6),
      select(kind.lessThan(2.5), float(4.0),
        select(kind.lessThan(3.5), float(4.1),
          select(kind.lessThan(4.5), float(4.2), float(4.0))))));
  const bw = select(kind.lessThan(0.5), float(1.75),
    select(kind.lessThan(1.5), float(2.2),
      select(kind.lessThan(2.5), float(2.8),
        select(kind.lessThan(3.5), float(1.9),
          select(kind.lessThan(4.5), float(3.4), float(2.6))))));
  const wf = select(kind.lessThan(0.5), float(0.46),
    select(kind.lessThan(1.5), float(0.54),
      select(kind.lessThan(2.5), float(0.68),
        select(kind.lessThan(3.5), float(0.88),
          select(kind.lessThan(4.5), float(0.70), float(0.55))))));
  const hf = select(kind.lessThan(0.5), float(0.56),
    select(kind.lessThan(1.5), float(0.58),
      select(kind.lessThan(2.5), float(0.66),
        select(kind.lessThan(3.5), float(0.82),
          select(kind.lessThan(4.5), float(0.68), float(0.62))))));

  const gf = select(kind.lessThan(0.5), float(3.8), select(kind.lessThan(1.5), float(4.2), float(4.8)));
  const xF = u.div(bw), yF = v.sub(gf).div(fh);
  const bid = floor(xF), fidx = floor(yF);
  const fx = fract(xF), fy = fract(yF);
  const wx = fw.x.div(bw), wy = fw.y.div(fh);

  const x0 = float(1).sub(wf).mul(0.5), x1 = float(1).sub(x0);
  const y0 = float(0.18), y1 = y0.add(hf);
  const inX = pulse(fx, x0, x1, wx);
  const inY = pulse(fy, y0, y1, wy);
  const win = inX.mul(inY);

  const hasTrim = float(1).sub(k3);
  const sill = pulse(fx, x0.sub(0.04), x1.add(0.04), wx).mul(pulse(fy, y0.sub(0.055), y0, wy)).mul(k0.add(k1).add(k4));
  const lint = pulse(fx, x0.sub(0.05), x1.add(0.05), wx).mul(pulse(fy, y1, y1.add(0.075), wy)).mul(k0.add(k1));
  const spandrel = cov(y0.sub(fy), wy).mul(k2.add(k4).add(step(4.5, kind)).add(k1.mul(step(0.6, era))));
  const belt = cov(float(0.09).sub(fy), wy).mul(step(abs(mod(fidx, 4.0)), 0.5)).mul(hasTrim);
  const quoin = cov(float(0.38).sub(u), fw.x).mul(step(0.5, fract(v.mul(1.25)))).mul(k0.add(k1));
  const trim = sill.add(lint).add(spandrel.mul(0.6)).add(belt.mul(0.8)).add(quoin.mul(0.5)).mul(dfade);

  const wl = clamp(fy.sub(y0).div(hf), 0, 1);
  const sash = float(1).sub(cov(abs(wl.sub(0.5)).sub(0.022), wy)).mul(k0.add(k1).add(k4));
  const munt = float(1).sub(cov(abs(fx.sub(0.5)).sub(0.018), wx)).mul(k4);
  const mull = float(1).sub(cov(min(fx, float(1).sub(fx)).sub(0.03), wx)).mul(k2.add(k3));
  const rail = sash.mul(dfade);

  const isBrick = k0.add(k1.mul(step(era, 0.55))).add(k4.mul(step(era, 0.45)));
  const bCourses = fract(v.mul(12.0));
  const bRow = floor(v.mul(12.0));
  const bCols = fract(u.mul(4.2).add(mod(bRow, 2.0).mul(0.5)));
  const brickJ = float(1).sub(smoothstep(0.0, 0.14, bCourses).mul(smoothstep(0.0, 0.1, bCols)));
  const sCourses = fract(v.mul(2.2));
  const sRow = floor(v.mul(2.2));
  const sCols = fract(u.mul(0.9).add(mod(sRow, 2.0).mul(0.5)));
  const stoneJ = float(1).sub(smoothstep(0.0, 0.06, sCourses).mul(smoothstep(0.0, 0.05, sCols)));
  const joint = mix(stoneJ, brickJ, isBrick).mul(mfade);
  const courseVar = hash11(mix(sRow, bRow, isBrick).add(seed.mul(37.0))).sub(0.5).mul(0.07).mul(mfade);
  const wallLit = tint.mul(float(1).add(courseVar)).mul(float(1).sub(joint.mul(0.22)));
  const stoneCol = mix(wallLit, v3(0.56, 0.52, 0.44), 0.55);
  const mullCol = mix(wallLit.mul(0.25), v3(0.035, 0.04, 0.05), k3);
  const wallCol = mix(wallLit, mullCol, mull.mul(dfade));

  // ---- Ground-floor & Upper-floor 3D Ray-Box Interior Mapping (Unified single ray-box trace per pixel for performance) ---------------
  const sd2 = floor(seed.mul(997.0));
  const cell = vec2(bid.add(sd2), fidx.add(sd2.mul(0.73)));
  const h1 = hash12(cell);
  const h2 = hash12(cell.add(vec2(17.3, 41.9)));
  const h3 = hash12(cell.add(vec2(73.1, 19.7)));
  const h4 = hash12(cell.add(vec2(11.7, 83.3)));

  const office = step(1.5, kind).mul(step(kind, 3.5));
  const litFrac = hash11(seed.mul(3.1)).mul(0.22).add(0.28).sub(office.mul(0.06));
  const fullFloor = step(hash12(vec2(fidx.add(sd2), sd2.mul(0.31))), 0.12).mul(office);
  const litOn = max(step(h1, litFrac), fullFloor.mul(step(h3, 0.92)));

  // Ground-floor bay layout & per-bay independent 2D hashes
  const atlas = getSignAtlasTexture();
  const gAA = cov(gf.sub(v), fw.y);
  const isGround = step(v, gf);
  const sbw = hash11(seed.mul(3.3)).mul(2.6).add(4.6);
  const sxF = u.div(sbw).add(fract(seed.mul(5.9)));
  const sid = floor(sxF), sf = fract(sxF), swx = fw.x.div(sbw);
  const pier = select(kind.greaterThan(2.5), float(0.09), hash11(seed.mul(5.1)).mul(0.05).add(0.12));
  const sgx = cov(sf.sub(pier), swx).mul(cov(float(1).sub(pier).sub(sf), swx));
  const sgy = cov(v.sub(0.58), fw.y).mul(cov(gf.sub(1.28).sub(v), fw.y));
  const shopGlass = sgx.mul(sgy);

  const hs = hash12(vec2(sid.mul(1.37), sd2.add(11.0)));
  const hs2 = hash12(vec2(sid.mul(3.91).add(19.7), sd2.add(47.3)));
  const hs3 = hash12(vec2(sid.mul(7.13).add(53.1), sd2.add(89.1)));
  const open = step(hs, 0.84);
  const shut = step(0.84, hs).mul(step(hs, 0.91)).mul(float(1).sub(k3));
  const lobby = step(0.91, hs);

  // Unified 3D Ray-Box trace: selects upper-window cell UVs or ground-shop cell UVs and traces ONCE per fragment
  const uWin = clamp(fx.sub(x0).div(wf), 0, 1);
  const vWin = wl;
  const roomDepth = mix(0.36, 0.56, h2);
  const uShop = clamp(sf.sub(pier).div(max(float(1).sub(pier.mul(2.0)), 0.2)), 0, 1);
  const vShop = clamp(v.sub(0.58).div(max(gf.sub(1.86), 1.4)), 0, 1);
  const shopDepth = mix(0.38, 0.62, hs2);

  const rm = rayBoxRoom(
    mix(uWin, uShop, isGround),
    mix(vWin, vShop, isGround),
    rayX, rayY, rayZ,
    mix(roomDepth, shopDepth, isGround),
  );

  // Upper-floor room interior shading
  const ceilGridX = fract(rm.hitX.mul(mix(1.0, 2.0, office)).add(h1.mul(0.3)));
  const ceilGridZ = fract(rm.hitZ.mul(2.0));
  const officeTroffer = pulse(ceilGridX, float(0.22), float(0.78), float(0.08)).mul(pulse(ceilGridZ, float(0.18), float(0.82), float(0.08)));
  const homePendant = float(1).sub(smoothstep(0.06, 0.34, length(vec2(rm.hitX.sub(0.5), rm.hitZ.sub(0.45)))));
  const ceilFixture = mix(homePendant, officeTroffer, office).mul(rm.onCeil);
  const ceilPlenum = rm.onCeil.mul(0.32);

  const zAtten = float(1.04).sub(rm.hitZ.mul(0.36));
  const wallAccent = mix(v3(0.95, 0.88, 0.78), select(h3.lessThan(0.35), v3(0.72, 0.82, 0.95), select(h3.lessThan(0.7), v3(0.98, 0.76, 0.56), v3(0.85, 0.92, 0.86))), float(0.45));
  const sideShelves = mix(0.76, 1.0, smoothstep(0.12, 0.28, fract(rm.hitY.mul(3.0).add(h2))));
  const backPanel = pulse(rm.hitX, float(0.18), float(0.82), float(0.06)).mul(pulse(rm.hitY, float(0.38), float(0.80), float(0.06)));
  const backSurf = rm.onBack.mul(mix(0.56, 0.74, backPanel.mul(step(0.35, h3)))).mul(zAtten);
  const sideSurf = rm.onSide.mul(0.48).mul(sideShelves).mul(zAtten);
  const floorBounce = rm.onFloor.mul(mix(0.22, 0.44, float(1).sub(rm.hitZ)));

  const deskX0 = h1.mul(0.35).add(0.12);
  const midDesk = pulse(rm.midX, deskX0, deskX0.add(0.42), float(0.06)).mul(float(1).sub(smoothstep(0.24, 0.36, rm.midY))).mul(rm.inMid);
  const monitorGlow = pulse(rm.midX, deskX0.add(0.08), deskX0.add(0.32), float(0.04))
    .mul(pulse(rm.midY, float(0.32), float(0.52), float(0.04))).mul(rm.inMid).mul(step(0.45, h4));

  const wallSurf = backSurf.add(sideSurf).add(ceilPlenum).add(floorBounce).mul(float(1).sub(midDesk.mul(0.42)));

  const warm = mix(v3(1.0, 0.68, 0.38), v3(1.0, 0.86, 0.66), clamp(h2.mul(1.8), 0, 1));
  const cool = select(h2.greaterThan(0.92), v3(0.45, 0.68, 1.0), v3(0.82, 0.91, 1.0));
  const lightCol = mix(warm, cool, step(float(0.72).sub(office.mul(0.28)), h2)).mul(wallAccent);

  const curtain = step(0.68, h4).mul(float(1).sub(office));
  const wlx = select(h3.greaterThan(0.5), uWin, float(1).sub(uWin));
  const curt = mix(1.0, smoothstep(0.08, 0.42, wlx).mul(0.82).add(0.18), curtain);
  const hasBlinds = step(0.64, h4).mul(office);
  const blindDrop = smoothstep(float(1).sub(h2.mul(0.55).add(0.15)), float(1).sub(h2.mul(0.55).add(0.11)), wl);
  const blindSlats = mix(0.35, 0.92, step(0.35, fract(fy.mul(22.0))));
  const blinds = mix(1.0, mix(1.0, blindSlats, blindDrop), hasBlinds.mul(dfade));

  const roomLuminance = wallSurf.add(ceilFixture.mul(1.25)).add(monitorGlow.mul(0.85)).mul(rm.roomAO);
  const unlitRoom = wallSurf.mul(0.08).add(ceilFixture.mul(0.04)).mul(rm.roomAO);
  const lamp = mix(unlitRoom, roomLuminance.mul(h3.mul(0.38).add(0.64)), litOn).mul(curt).mul(blinds);
  const litAvg = litFrac.mul(0.28);
  const lit = mix(litAvg, lamp, dfade);
  const emWin = lightCol.mul(win).mul(lit).mul(WINDOW_EM);

  // Ground-floor retail storefront 3D room shading (reuses `rm`)
  const nSpots = floor(hs3.mul(3.0)).add(2.0);
  const spX = fract(rm.hitX.mul(nSpots).add(hs.mul(0.25))).sub(0.5);
  const spZ = fract(rm.hitZ.mul(2.0)).sub(0.5);
  const shopCeilLights = float(1).sub(smoothstep(0.05, 0.28, length(vec2(spX, spZ)))).mul(rm.onCeil);
  const shopCeilPlenum = rm.onCeil.mul(0.30);

  const wallSpotPool = float(1).sub(smoothstep(0.08, 0.52, length(vec2(fract(rm.hitX.mul(2.0)).sub(0.5), rm.hitY.sub(0.62)))));
  const shelfRows = mix(0.74, 1.0, smoothstep(0.12, 0.32, fract(rm.hitY.mul(4.0).add(hs3))));
  const shopBackLit = rm.onBack.mul(mix(0.52, 0.78, wallSpotPool.mul(0.65).add(0.35)).mul(mix(1.0, shelfRows, step(0.45, hs2)))).mul(zAtten);
  const shopSideLit = rm.onSide.mul(0.46).mul(shelfRows).mul(zAtten);

  const cntX0 = hs.mul(0.28).add(0.14);
  const midCounter = pulse(rm.midX, cntX0, cntX0.add(0.46), float(0.06))
    .mul(float(1).sub(smoothstep(0.20, 0.32, rm.midY))).mul(rm.inMid);
  const midCaseGlow = pulse(rm.midX, cntX0.add(0.06), cntX0.add(0.40), float(0.04))
    .mul(pulse(rm.midY, float(0.18), float(0.28), float(0.03))).mul(rm.inMid).mul(step(0.4, hs3));

  const shopWallLit = shopBackLit.add(shopSideLit).add(shopCeilPlenum).mul(float(1).sub(midCounter.mul(0.38)));
  const shop3D = shopWallLit.add(floorBounce).add(shopCeilLights.mul(1.15)).add(midCaseGlow.mul(0.65)).mul(rm.roomAO);

  const shopCol = select(hs2.lessThan(0.32), v3(1.0, 0.78, 0.50),
    select(hs2.lessThan(0.64), v3(0.98, 0.90, 0.78),
      select(hs2.lessThan(0.85), v3(0.78, 0.90, 1.0), v3(1.0, 0.64, 0.42))));

  const signY = cov(v.sub(gf.sub(1.18)), fw.y).mul(cov(gf.sub(0.36).sub(v), fw.y));
  const signX = cov(sf.sub(0.16), swx).mul(cov(float(0.84).sub(sf), swx));
  const signOn = step(0.28, hs2).mul(float(1).sub(k3)).mul(open);
  const sign = signX.mul(signY).mul(signOn);
  const sIdx = clamp(floor(mod(sid.add(sd2), 8.0)), 0, 7);
  const signCol = mod(sIdx, 2.0), signRow = floor(sIdx.div(2.0));
  const su = clamp(sf.sub(0.16).div(0.68), 0.02, 0.98);
  const sv = clamp(v.sub(gf.sub(1.18)).div(0.82), 0.05, 0.95);
  const signAtlasUV = vec2(signCol.mul(0.5).add(su.mul(0.5)), float(0.25).sub(signRow.add(float(1.0).sub(sv)).mul(0.0625)));
  const signTexCol = texture(atlas, signAtlasUV).rgb;

  const ribs = step(0.5, fract(v.mul(8.0))).mul(0.22).add(0.78);
  const cornice = cov(v.sub(gf.sub(0.28)), fw.y).mul(cov(gf.sub(v), fw.y));
  const pierCol = mix(wallLit.mul(0.76), stoneCol.mul(0.85), cornice);
  const gCol = mix(pierCol, v3(0.012, 0.015, 0.02), shopGlass);
  const gCol2 = mix(gCol, v3(0.07, 0.075, 0.085).mul(ribs), shopGlass.mul(shut));
  const gAlb = mix(gCol2, v3(0.015, 0.018, 0.022), sign);

  const transom = float(1).sub(cov(abs(v.sub(2.62)).sub(0.035), fw.y)).mul(0.88);
  const mullion = float(1).sub(cov(abs(sf.sub(0.5)).mul(sbw).sub(0.028), fw.x)).mul(0.85);
  const frame = float(1).sub(max(transom, mullion));
  const lobbyGlow = shop3D.mul(lobby).mul(0.78);
  const gEm = shopCol.mul(shopGlass).mul(open.mul(shop3D).add(lobbyGlow)).mul(frame).mul(SHOP_EM).add(signTexCol.mul(sign).mul(SIGN_EM));

  // ---- 3D World-Space Exterior Architectural Glass Reflections -----------------------------------------------------------------------
  const paneWarp = sin(fx.mul(3.14159)).mul(sin(wl.mul(3.14159))).mul(h2.sub(0.5)).mul(0.06);
  const Nglass = Nw.add(Tw.mul(paneWarp.mul(0.12))).normalize();
  const R = reflect(V, Nglass);
  const fres = clamp(float(0.06).add(pow(float(1).sub(clamp(dot(V.negate(), Nglass), 0, 1)), 4.0).mul(0.65)), 0, 1);
  // Smooth 3D Manhattan night sky + warm streetlamp horizon reflection along reflected ray R (no hard checkerboard!)
  const horizonBand = smoothstep(-0.22, 0.04, R.y).mul(float(1).sub(smoothstep(0.02, 0.38, R.y)));
  const neonBand = sin(R.x.mul(5.5).add(R.z.mul(6.5))).mul(0.5).add(0.5);
  const horizonCol = mix(v3(0.42, 0.24, 0.12), v3(0.18, 0.34, 0.55), neonBand);
  const skyEnv = mix(v3(0.04, 0.05, 0.08), v3(0.015, 0.025, 0.055), clamp(R.y.mul(2.0).add(0.2), 0, 1));
  const envReflCol = skyEnv.add(horizonCol.mul(horizonBand).mul(0.55));
  const glassMask = mix(win, shopGlass.mul(float(1).sub(shut)), gAA);
  const refl = envReflCol.mul(fres).mul(mix(0.35, 1.15, k3)).mul(glassMask);

  // ---- Compose + Physical Normal Map Relief ------------------------------------------------------------------------------------------
  const glassKind = mix(v3(0.012, 0.016, 0.024), tint.mul(0.85), k3);
  const stoneMix = clamp(trim, 0, 1);
  const upperWall = mix(wallCol, stoneCol, stoneMix);
  const upperAlb = mix(upperWall, glassKind, win.mul(float(1).sub(rail.mul(0.7)).sub(munt.mul(0.7))));
  const albedo = mix(upperAlb, gAlb, gAA);
  const aoG = mix(0.62, 1.0, smoothstep(0.0, 5.0, v));
  const emUpper = emWin.mul(float(1).sub(rail.mul(0.8)).sub(munt.mul(0.8)));
  const winMask = mix(win, clamp(shopGlass.add(sign), 0, 1), gAA);
  const night = facadeNight;
  const glow = upperWall.mul(float(1).sub(smoothstep(0.0, 28.0, v)).mul(0.14).add(0.055)).mul(float(1).sub(winMask)).mul(float(1).sub(k3.mul(0.5)));
  const isLandmark = step(4.5, kind);
  const topFrac = clamp(v.div(max(bld.y.mul(fh), 40.0)), 0, 1);
  const crownBand = smoothstep(0.68, 0.96, topFrac).mul(isLandmark.add(step(120.0, v).mul(0.35)));
  const crownCol = mix(v3(1.0, 0.76, 0.44), v3(0.55, 0.78, 1.0), step(0.55, fract(seed.mul(19.3))));
  const crownGlow = crownCol.mul(crownBand).mul(float(1).sub(win.mul(0.5))).mul(0.38);
  const extEmissive = mix(emUpper, gEm, gAA).mul(night)
    .add(glow.mul(night)).add(crownGlow.mul(night)).add(refl.mul(night.mul(0.85).add(0.25)));
  const extColor = albedo.mul(ao.mul(aoG));
  const extRough = mix(mix(0.88, 0.68, float(1).sub(isBrick)), mix(0.09, 0.035, k3), winMask);
  const extMetal = mix(float(0.0), mix(0.22, 0.45, k3), winMask);

  const hUpper = stoneMix.mul(0.35).sub(joint.mul(0.24)).sub(win.mul(0.45)).add(rail.add(munt).mul(0.22)).add(paneWarp.mul(win));
  const hGround = cornice.mul(0.38).sub(shopGlass.mul(0.42)).add(shut.mul(ribs).mul(0.25)).add(sign.mul(0.18));
  const heightField = mix(hUpper, hGround, gAA);
  const normal = bumpMap(heightField, dfade.mul(0.52));

  return { color: extColor, emissive: extEmissive, rough: extRough, metal: extMetal, normal };
}

/** Fast LOD1 shader for distant `far.glb` skyscraper tiles (>380 m away where 3D room parallax has faded out). */
function farFacadeGraph() {
  const U = uv();
  const u = U.x, v = U.y;
  const col = attribute('color', 'vec4');
  const bld = attribute('_bld', 'vec4');
  const tint = col.rgb, ao = col.a;
  const seed = bld.x, kind = bld.z;
  const fw = max(fwidth(U), vec2(1e-4, 1e-4)).toVar();

  const k3 = step(2.5, kind).mul(step(kind, 3.5));
  const fh = select(kind.lessThan(0.5), float(3.4),
    select(kind.lessThan(1.5), float(3.6),
      select(kind.lessThan(2.5), float(4.0),
        select(kind.lessThan(3.5), float(4.1),
          select(kind.lessThan(4.5), float(4.2), float(4.0))))));
  const bw = select(kind.lessThan(0.5), float(1.75),
    select(kind.lessThan(1.5), float(2.2),
      select(kind.lessThan(2.5), float(2.8),
        select(kind.lessThan(3.5), float(1.9),
          select(kind.lessThan(4.5), float(3.4), float(2.6))))));
  const wf = select(kind.lessThan(0.5), float(0.46),
    select(kind.lessThan(1.5), float(0.54),
      select(kind.lessThan(2.5), float(0.68),
        select(kind.lessThan(3.5), float(0.88),
          select(kind.lessThan(4.5), float(0.70), float(0.55))))));
  const hf = select(kind.lessThan(0.5), float(0.56),
    select(kind.lessThan(1.5), float(0.58),
      select(kind.lessThan(2.5), float(0.66),
        select(kind.lessThan(3.5), float(0.82),
          select(kind.lessThan(4.5), float(0.68), float(0.62))))));

  const gf = select(kind.lessThan(0.5), float(3.8), select(kind.lessThan(1.5), float(4.2), float(4.8)));
  const xF = u.div(bw), yF = v.sub(gf).div(fh);
  const bid = floor(xF), fidx = floor(yF);
  const fx = fract(xF), fy = fract(yF);
  const wx = fw.x.div(bw), wy = fw.y.div(fh);

  const x0 = float(1).sub(wf).mul(0.5), x1 = float(1).sub(x0);
  const y0 = float(0.18), y1 = y0.add(hf);
  const win = pulse(fx, x0, x1, wx).mul(pulse(fy, y0, y1, wy)).mul(step(gf, v));

  const sd2 = floor(seed.mul(997.0));
  const cell = vec2(bid.add(sd2), fidx.add(sd2.mul(0.73)));
  const h1 = hash12(cell);
  const h2 = hash12(cell.add(vec2(17.3, 41.9)));
  const h3 = hash12(cell.add(vec2(73.1, 19.7)));
  const office = step(1.5, kind).mul(step(kind, 3.5));
  const litFrac = hash11(seed.mul(3.1)).mul(0.22).add(0.28).sub(office.mul(0.06));
  const fullFloor = step(hash12(vec2(fidx.add(sd2), sd2.mul(0.31))), 0.12).mul(office);
  const litOn = max(step(h1, litFrac), fullFloor.mul(step(h3, 0.92)));

  const warm = mix(v3(1.0, 0.68, 0.38), v3(1.0, 0.86, 0.66), clamp(h2.mul(1.8), 0, 1));
  const cool = select(h2.greaterThan(0.92), v3(0.45, 0.68, 1.0), v3(0.82, 0.91, 1.0));
  const lightCol = mix(warm, cool, step(float(0.72).sub(office.mul(0.28)), h2));
  const emWin = lightCol.mul(win).mul(mix(0.06, 0.42, litOn)).mul(WINDOW_EM);

  const V = positionWorld.sub(cameraPosition).normalize();
  const Nw = normalWorld.normalize();
  const R = reflect(V, Nw);
  const fres = clamp(float(0.06).add(pow(float(1).sub(clamp(dot(V.negate(), Nw), 0, 1)), 4.0).mul(0.65)), 0, 1);
  const skyEnv = mix(v3(0.04, 0.05, 0.08), v3(0.015, 0.025, 0.055), clamp(R.y.mul(2.0).add(0.2), 0, 1));
  const refl = skyEnv.mul(fres).mul(mix(0.35, 1.15, k3)).mul(win);

  const glassKind = mix(v3(0.012, 0.016, 0.024), tint.mul(0.85), k3);
  const albedo = mix(tint, glassKind, win);
  const night = facadeNight;
  const glow = tint.mul(float(1).sub(smoothstep(0.0, 28.0, v)).mul(0.14).add(0.055)).mul(float(1).sub(win)).mul(float(1).sub(k3.mul(0.5)));
  const isLandmark = step(4.5, kind);
  const topFrac = clamp(v.div(max(bld.y.mul(fh), 40.0)), 0, 1);
  const crownBand = smoothstep(0.68, 0.96, topFrac).mul(isLandmark.add(step(120.0, v).mul(0.35)));
  const crownCol = mix(v3(1.0, 0.76, 0.44), v3(0.55, 0.78, 1.0), step(0.55, fract(seed.mul(19.3))));
  const crownGlow = crownCol.mul(crownBand).mul(float(1).sub(win.mul(0.5))).mul(0.38);

  const emissive = emWin.mul(night).add(glow.mul(night)).add(crownGlow.mul(night)).add(refl.mul(night.mul(0.85).add(0.25)));
  const color = albedo.mul(ao);
  const rough = mix(float(0.78), mix(0.09, 0.035, k3), win);
  const metal = mix(float(0.0), mix(0.22, 0.45, k3), win);
  return { color, emissive, rough, metal };
}

/** Standard opaque `FrontSide` facade material for near tiles (full GPU backface culling + Early-Z occlusion). */
export function createFacadeMaterial(): THREE.Material {
  const g = facadeGraph();
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = 'nyc-facade';
  m.colorNode = g.color;
  m.emissiveNode = g.emissive;
  m.roughnessNode = g.rough;
  m.metalnessNode = g.metal;
  m.normalNode = g.normal;
  return m;
}

/** Lightweight opaque `FrontSide` facade material for distant `far.glb` tiles (>380 m). */
export function createFarFacadeMaterial(): THREE.Material {
  const g = farFacadeGraph();
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = 'nyc-facade-far';
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
  const g1 = hash12(floor(U.mul(3.5))).sub(0.5).mul(0.12);
  const g2 = hash12(floor(U.mul(19.0))).sub(0.5).mul(0.08);
  const tar = col.rgb.mul(float(1).add(g1).add(g2));
  const seam = float(1).sub(cov(abs(fract(U.y.mul(0.9)).sub(0.5)).sub(0.03), fw.y.mul(0.9))).mul(0.18);
  const side = col.rgb.mul(float(1).sub(seam));
  return { color: mix(side, tar, up).mul(col.a) };
}

export function createRoofMaterial(): THREE.Material {
  const g = roofGraph();
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = 'nyc-roof';
  m.colorNode = g.color;
  m.roughness = 0.9;
  m.metalness = 0.08;
  return m;
}
