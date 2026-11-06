// Infinite 1:1-scale procedural New York City tile synthesizer.
// When the car drives beyond the pre-baked Midtown tile set in index.json, NycStreamer calls
// generateProceduralNycTile(ix, iy) to synthesize a 256m x 256m tile aligned to Manhattan's 29-degree
// avenue/street grid, complete with district-zoned skyscrapers/brownstones, Central Park, Hudson/East River
// waterfronts & bridges, Rapier building colliders, and breakable street furniture & storefronts.
import * as THREE from 'three/webgpu';
import type { BuildingColliderBox } from './props';

const TILE = 256;
const AVENUE = (29 * Math.PI) / 180;
const COS_A = Math.cos(AVENUE);
const SIN_A = Math.sin(AVENUE);

const AVE_PITCH = 264; // m between Manhattan avenues (u axis)
const ST_PITCH = 80;   // m between cross streets (v axis)
const AVE_W = 22;      // roadway width on avenues (m)
const ST_W = 12.5;     // roadway width on standard cross streets (m)
const MAJOR_ST_W = 21; // roadway width on major crosstown streets (every 6th street)
const SW_W = 4.2;      // sidewalk width around blocks (m)
const KERB_H = 0.15;   // sidewalk/park elevation above roadway (m)

const FLOOR_H = [3.4, 3.6, 4.0, 4.1, 4.2, 4.0];

const PALETTE: Record<number, [number, number, number][]> = {
  0: [[0.42, 0.16, 0.11], [0.34, 0.14, 0.10], [0.30, 0.20, 0.14], [0.46, 0.34, 0.22], [0.38, 0.22, 0.15]],
  1: [[0.46, 0.34, 0.23], [0.40, 0.15, 0.11], [0.52, 0.47, 0.38], [0.44, 0.40, 0.36]],
  2: [[0.50, 0.47, 0.42], [0.38, 0.38, 0.39], [0.18, 0.21, 0.25], [0.46, 0.40, 0.32], [0.55, 0.53, 0.48]],
  3: [[0.08, 0.15, 0.21], [0.07, 0.10, 0.14], [0.16, 0.21, 0.26], [0.10, 0.17, 0.19], [0.11, 0.14, 0.21]],
  4: [[0.33, 0.13, 0.09], [0.30, 0.20, 0.14], [0.32, 0.33, 0.31], [0.42, 0.30, 0.18]],
  5: [[0.50, 0.47, 0.40]],
};

function hash2(a: number, b: number): number {
  let n = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/** Convert Manhattan grid (u across island, v uptown) to game-frame (x east, y north). */
function uvToXY(u: number, v: number): [number, number] {
  return [u * COS_A + v * SIN_A, -u * SIN_A + v * COS_A];
}

/** Convert game-frame (x east, y north) to Manhattan grid (u across island, v uptown). */
function xyToUV(x: number, y: number): [number, number] {
  return [x * COS_A - y * SIN_A, x * SIN_A + y * COS_A];
}

/** Manhattan western & eastern shorelines in grid `u` (metres) as a function of uptown `v`. */
function manhattanShores(v: number): [number, number] {
  // Tapers in Lower Manhattan (v < -3600) down to Battery Park (v = -6600)
  if (v < -3600) {
    const t = Math.max(0, Math.min(1, (v + 6600) / 3000));
    const half = 420 + 1180 * Math.pow(t, 0.75);
    return [-half, half];
  }
  const waveW = Math.sin(v * 0.00045) * 110;
  const waveE = Math.cos(v * 0.00052 + 0.8) * 140;
  return [-1620 + waveW, 1720 + waveE];
}

class GeomBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  bld: number[] = [];
  idx: number[] = [];
  withBld: boolean;

  constructor(withBld = false) {
    this.withBld = withBld;
  }

  addQuadGame(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
    nx: number, ny: number, nz: number,
    u0: number, v0: number, u1: number, v1: number,
    r: number, g: number, b: number, a0: number, a1: number,
    bldTuple?: [number, number, number, number],
  ) {
    const base = this.pos.length / 3;
    // Game (x, y, z) -> Three.js (x, z, -y)
    this.pos.push(
      ax, az, -ay,
      bx, bz, -by,
      cx, cz, -cy,
      dx, dz, -dy,
    );
    this.nrm.push(
      nx, nz, -ny,
      nx, nz, -ny,
      nx, nz, -ny,
      nx, nz, -ny,
    );
    this.uv.push(
      u0, v0,
      u1, v0,
      u1, v1,
      u0, v1,
    );
    const R = Math.min(255, Math.max(0, Math.round(r * 255)));
    const G = Math.min(255, Math.max(0, Math.round(g * 255)));
    const B = Math.min(255, Math.max(0, Math.round(b * 255)));
    const A0 = Math.min(255, Math.max(0, Math.round(a0 * 255)));
    const A1 = Math.min(255, Math.max(0, Math.round(a1 * 255)));
    this.col.push(
      R, G, B, A0,
      R, G, B, A0,
      R, G, B, A1,
      R, G, B, A1,
    );
    if (this.withBld) {
      const bt = bldTuple ?? [0.5, 8, 2, 0.5];
      for (let k = 0; k < 4; k++) this.bld.push(bt[0], bt[1], bt[2], bt[3]);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** Horizontal quad in Manhattan (u, v) coordinates at elevation `z`. */
  addGridHorizontalQuad(
    u0: number, v0: number, u1: number, v1: number, z: number,
    r: number, g: number, b: number, ao = 1.0,
  ) {
    const [ax, ay] = uvToXY(u0, v0);
    const [bx, by] = uvToXY(u1, v0);
    const [cx, cy] = uvToXY(u1, v1);
    const [dx, dy] = uvToXY(u0, v1);
    const base = this.pos.length / 3;
    this.pos.push(ax, z, -ay, bx, z, -by, cx, z, -cy, dx, z, -dy);
    this.nrm.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
    this.uv.push(ax, ay, bx, by, cx, cy, dx, dy);
    const R = Math.min(255, Math.max(0, Math.round(r * 255)));
    const G = Math.min(255, Math.max(0, Math.round(g * 255)));
    const B = Math.min(255, Math.max(0, Math.round(b * 255)));
    const A = Math.min(255, Math.max(0, Math.round(ao * 255)));
    this.col.push(R, G, B, A, R, G, B, A, R, G, B, A, R, G, B, A);
    if (this.withBld) {
      for (let k = 0; k < 4; k++) this.bld.push(0, 1, 0, 0.5);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** Extruded box aligned to Manhattan (u, v) grid with walls in `wallBuilder` and top cap in `roofBuilder`. */
  static addGridPrism(
    wallB: GeomBuilder,
    roofB: GeomBuilder,
    u0: number, v0: number, u1: number, v1: number,
    z0: number, z1: number,
    rgb: [number, number, number],
    aoBottom: number, aoTop: number,
    bldTuple?: [number, number, number, number],
  ) {
    const [x0, y0] = uvToXY(u0, v0);
    const [x1, y1] = uvToXY(u1, v0);
    const [x2, y2] = uvToXY(u1, v1);
    const [x3, y3] = uvToXY(u0, v1);
    const pts: [number, number][] = [[x0, y0], [x1, y1], [x2, y2], [x3, y3], [x0, y0]];
    let uCum = 0;
    for (let e = 0; e < 4; e++) {
      const [ax, ay] = pts[e];
      const [bx, by] = pts[e + 1];
      const dx = bx - ax, dy = by - ay;
      const L = Math.hypot(dx, dy);
      if (L < 0.05) continue;
      const nx = dy / L, ny = -dx / L;
      wallB.addQuadGame(
        ax, ay, z0,
        bx, by, z0,
        bx, by, z1,
        ax, ay, z1,
        nx, ny, 0,
        uCum, z0, uCum + L, z1,
        rgb[0], rgb[1], rgb[2], aoBottom, aoTop,
        bldTuple,
      );
      uCum += L;
    }
    roofB.addGridHorizontalQuad(
      u0, v0, u1, v1, z1,
      Math.min(1, rgb[0] * 1.12), Math.min(1, rgb[1] * 1.12), Math.min(1, rgb[2] * 1.12), 0.96,
    );
  }

  toMesh(materialName: string): THREE.Mesh | null {
    if (!this.idx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    g.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(this.col), 4, true));
    if (this.withBld && this.bld.length) {
      g.setAttribute('_bld', new THREE.BufferAttribute(new Float32Array(this.bld), 4));
    }
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    const mat = new THREE.MeshBasicMaterial();
    mat.name = materialName;
    return new THREE.Mesh(g, mat);
  }
}

export interface ProceduralNycTileData {
  groundGroup: THREE.Group;
  bldGroup: THREE.Group;
  farGroup: THREE.Group;
  col: { ground: number; buildings: BuildingColliderBox[] };
  props: Record<string, number[][]>;
}

/** Synthesize a complete 256m x 256m NYC tile at (ix, iy) in game-frame coordinates. */
export function generateProceduralNycTile(ix: number, iy: number): ProceduralNycTileData {
  const cx = (ix + 0.5) * TILE;
  const cy = (iy + 0.5) * TILE;
  const [cu, cv] = xyToUV(cx, cy);

  // Determine Manhattan grid block range overlapping this 256m tile
  const halfDiag = TILE * 0.74;
  const iu0 = Math.floor((cu - halfDiag) / AVE_PITCH);
  const iu1 = Math.floor((cu + halfDiag) / AVE_PITCH);
  const iv0 = Math.floor((cv - halfDiag) / ST_PITCH);
  const iv1 = Math.floor((cv + halfDiag) / ST_PITCH);

  const gRoad = new GeomBuilder(false);
  const gSidewalk = new GeomBuilder(false);
  const gCurb = new GeomBuilder(false);
  const gCrosswalk = new GeomBuilder(false);
  const gMarking = new GeomBuilder(false);
  const gGrass = new GeomBuilder(false);
  const gWater = new GeomBuilder(false);

  const bFacade = new GeomBuilder(true);
  const bRoof = new GeomBuilder(false);
  const fFacade = new GeomBuilder(true);
  const fRoof = new GeomBuilder(false);

  const colliders: BuildingColliderBox[] = [];
  const props: Record<string, number[][]> = {
    lamp: [],
    tree: [],
    signal: [],
    hydrant: [],
    bench: [],
    bus_stop: [],
    subway_entrance: [],
    steam: [],
    kiosk: [],
    waste: [],
    sign: [],
  };

  const inTile = (x: number, y: number, margin = 0) =>
    x >= ix * TILE - margin && x < (ix + 1) * TILE + margin &&
    y >= iy * TILE - margin && y < (iy + 1) * TILE + margin;

  for (let iu = iu0; iu <= iu1; iu++) {
    for (let iv = iv0; iv <= iv1; iv++) {
      const uStart = iu * AVE_PITCH;
      const vStart = iv * ST_PITCH;
      const uMid = uStart + AVE_PITCH * 0.5;
      const vMid = vStart + ST_PITCH * 0.5;
      const [cellX, cellY] = uvToXY(uMid, vMid);

      // Only emit each grid cell from the tile that owns its centre (or immediate road margin)
      const ownsCell = inTile(cellX, cellY, 0);
      const nearTile = inTile(cellX, cellY, 165);
      if (!nearTile) continue;

      const [westShore, eastShore] = manhattanShores(vMid);
      const inHudson = (uMid < westShore && uMid > westShore - 1080) || vMid < -6600;
      const inEastRiver = uMid > eastShore && uMid < eastShore + 860 && vMid >= -6600;
      const isWater = inHudson || inEastRiver;
      const isCentralPark = !isWater && uMid > -430 && uMid < 430 && vMid > 1120 && vMid < 5120;
      const isMajorCrosstown = Math.abs(iv % 6) === 0;
      const isBridgeCorridor = isWater && Math.abs(iv % 12) === 0;

      const stW = isMajorCrosstown ? MAJOR_ST_W : ST_W;
      const blkU0 = uStart + AVE_W * 0.5;
      const blkU1 = uStart + AVE_PITCH - AVE_W * 0.5;
      const blkV0 = vStart + stW * 0.5;
      const blkV1 = vStart + ST_PITCH - stW * 0.5;

      if (isWater && !isBridgeCorridor) {
        if (ownsCell) {
          gWater.addGridHorizontalQuad(uStart, vStart, uStart + AVE_PITCH, vStart + ST_PITCH, -0.5, 0.08, 0.16, 0.22, 1.0);
        }
        continue;
      }

      // Base asphalt roadway for the avenue and cross-street corridors of this cell
      gRoad.addGridHorizontalQuad(uStart - AVE_W * 0.5, vStart - stW * 0.5, uStart + AVE_W * 0.5, vStart + ST_PITCH + stW * 0.5, 0.0, 0.92, 0.92, 0.94, 0.95);
      gRoad.addGridHorizontalQuad(uStart + AVE_W * 0.5, vStart - stW * 0.5, uStart + AVE_PITCH - AVE_W * 0.5, vStart + stW * 0.5, 0.0, 0.90, 0.90, 0.92, 0.95);

      // Yellow centre line on avenue + crosstown street
      gMarking.addGridHorizontalQuad(uStart - 0.18, blkV0 + 2, uStart + 0.18, blkV1 - 2, 0.025, 1.0, 0.78, 0.12, 1.0);
      if (isMajorCrosstown || isBridgeCorridor) {
        gMarking.addGridHorizontalQuad(blkU0 + 2, vStart - 0.18, blkU1 - 2, vStart + 0.18, 0.025, 1.0, 0.78, 0.12, 1.0);
      }

      // Crosswalks at the intersection
      if (!isBridgeCorridor) {
        gCrosswalk.addGridHorizontalQuad(uStart - AVE_W * 0.44, blkV0 - 3.6, uStart + AVE_W * 0.44, blkV0 - 0.6, 0.025, 0.93, 0.93, 0.90, 1.0);
        gCrosswalk.addGridHorizontalQuad(blkU0 + 0.6, vStart - stW * 0.44, blkU0 + 3.6, vStart + stW * 0.44, 0.025, 0.93, 0.93, 0.90, 1.0);
      }

      if (isBridgeCorridor) {
        // Bridge deck + low barrier curbs across the river
        gWater.addGridHorizontalQuad(uStart, blkV0 + 2, uStart + AVE_PITCH, blkV1 - 2, -0.5, 0.08, 0.16, 0.22, 1.0);
        GeomBuilder.addGridPrism(gCurb, gSidewalk, uStart, vStart + stW * 0.5, uStart + AVE_PITCH, vStart + stW * 0.5 + 1.8, 0, 0.35, [0.55, 0.55, 0.58], 0.6, 1.0);
        GeomBuilder.addGridPrism(gCurb, gSidewalk, uStart, vStart - stW * 0.5 - 1.8, uStart + AVE_PITCH, vStart - stW * 0.5, 0, 0.35, [0.55, 0.55, 0.58], 0.6, 1.0);
        if (ownsCell) {
          for (let s = 0.15; s <= 0.85; s += 0.35) {
            const [lx, ly] = uvToXY(uStart + AVE_PITCH * s, vStart + stW * 0.5 + 0.6);
            props.lamp.push([lx, ly, AVENUE]);
          }
        }
        continue;
      }

      // Elevated sidewalk block + 15cm granite curb around the city block
      GeomBuilder.addGridPrism(
        gCurb, gSidewalk,
        blkU0, blkV0, blkU1, blkV1,
        0.0, KERB_H,
        [0.62, 0.61, 0.59], 0.55, 0.96,
      );

      if (!ownsCell) continue;

      // Street furniture along avenues & cross streets (all breakable on collision!)
      const [ix0, iy0] = uvToXY(blkU0 + 0.8, blkV0 + 0.8);
      const [ix1, iy1] = uvToXY(blkU1 - 0.8, blkV0 + 0.8);
      const [ix2, iy2] = uvToXY(blkU0 + 0.8, blkV1 - 0.8);
      props.signal.push([ix0, iy0, AVENUE]);
      props.signal.push([ix1, iy1, AVENUE + Math.PI]);
      props.waste.push([ix0 + 1.4, iy0 + 0.6, AVENUE]);
      props.hydrant.push([ix2 + 2.5, iy2 - 0.5, AVENUE]);

      // Streetlamps spaced along both sides of the block
      for (const frac of [0.18, 0.5, 0.82]) {
        const uPos = blkU0 + (blkU1 - blkU0) * frac;
        const [lx0, ly0] = uvToXY(uPos, blkV0 + 0.7);
        const [lx1, ly1] = uvToXY(uPos, blkV1 - 0.7);
        props.lamp.push([lx0, ly0, AVENUE]);
        props.lamp.push([lx1, ly1, AVENUE + Math.PI]);
      }
      // Avenue-side lamps & bus stop / newsstand
      const [alx0, aly0] = uvToXY(blkU0 + 0.7, (blkV0 + blkV1) * 0.5);
      const [alx1, aly1] = uvToXY(blkU1 - 0.7, (blkV0 + blkV1) * 0.5);
      props.lamp.push([alx0, aly0, AVENUE + Math.PI * 0.5]);
      props.lamp.push([alx1, aly1, AVENUE - Math.PI * 0.5]);

      const cellRand = hash2(iu * 31 + 7, iv * 53 + 11);
      if (cellRand < 0.45) {
        const [bx, by] = uvToXY(blkU0 + 1.4, blkV0 + (blkV1 - blkV0) * 0.35);
        props.bus_stop.push([bx, by, AVENUE + Math.PI * 0.5]);
      } else if (cellRand < 0.75) {
        const [kx, ky] = uvToXY(blkU0 + 1.6, blkV0 + 6.5);
        props.kiosk.push([kx, ky, AVENUE]);
      }
      if (cellRand > 0.62) {
        const [sx, sy] = uvToXY(uStart, vStart);
        props.steam.push([sx, sy, 0]);
      }

      // Central Park block: lush grass meadow + trees + benches, no buildings
      if (isCentralPark) {
        gGrass.addGridHorizontalQuad(blkU0 + SW_W, blkV0 + SW_W, blkU1 - SW_W, blkV1 - SW_W, KERB_H + 0.02, 0.25, 0.42, 0.20, 0.94);
        for (let t = 0; t < 7; t++) {
          const tu = blkU0 + SW_W + 6 + hash2(iu * 19 + t, iv * 29) * (blkU1 - blkU0 - 2 * SW_W - 12);
          const tv = blkV0 + SW_W + 6 + hash2(iu * 41, iv * 37 + t) * (blkV1 - blkV0 - 2 * SW_W - 12);
          const [tx, ty] = uvToXY(tu, tv);
          props.tree.push([tx, ty, t * 1.1, 0.9 + 0.45 * hash2(iu + t, iv - t)]);
        }
        continue;
      }

      // Street trees along residential/mid-rise cross streets
      for (const frac of [0.32, 0.68]) {
        const uPos = blkU0 + (blkU1 - blkU0) * frac;
        const [tx, ty] = uvToXY(uPos, blkV0 + 1.1);
        props.tree.push([tx, ty, frac * 5, 0.85 + 0.3 * cellRand]);
      }

      // Subdivide the inner block into realistic NYC building lots (2 avenue end-cap lots + 4..6 mid-block lots)
      const innerU0 = blkU0 + SW_W;
      const innerU1 = blkU1 - SW_W;
      const innerV0 = blkV0 + SW_W;
      const innerV1 = blkV1 - SW_W;
      const endDepth = 36;

      // Determine district height envelope
      const inOuterBorough = uMid < westShore || uMid > eastShore;
      const distMidtown = Math.hypot(uMid * 0.7, vMid - 150);
      const distFiDi = Math.hypot(uMid * 0.9, vMid + 5000);
      let maxH = 48;
      let baseH = 18;
      if (!inOuterBorough) {
        if (distMidtown < 2200) {
          const f = 1 - distMidtown / 2200;
          maxH = 75 + 210 * f * f;
          baseH = 28 + 45 * f;
        } else if (distFiDi < 1600) {
          const f = 1 - distFiDi / 1600;
          maxH = 70 + 230 * f * f;
          baseH = 30 + 50 * f;
        } else if (vMid > 1120 && vMid < 5200) {
          // Upper West Side / Upper East Side
          maxH = 68;
          baseH = 22;
        } else if (vMid >= 5200) {
          // Harlem / Upper Manhattan
          maxH = 42;
          baseH = 15;
        } else {
          // Greenwich Village / SoHo / Lower East Side
          maxH = 52;
          baseH = 17;
        }
      } else {
        // Waterfront LIC / Brooklyn / Jersey City
        const shoreDist = uMid < westShore ? (westShore - (uMid + 1080)) : (uMid - (eastShore + 860));
        const wf = Math.max(0, 1 - Math.abs(shoreDist) / 900);
        maxH = 28 + 95 * wf;
        baseH = 12 + 16 * wf;
      }

      const lots: { u0: number; v0: number; u1: number; v1: number; isAvenue: boolean; lotId: number }[] = [
        { u0: innerU0, v0: innerV0, u1: innerU0 + endDepth, v1: innerV1, isAvenue: true, lotId: 0 },
        { u0: innerU1 - endDepth, v0: innerV0, u1: innerU1, v1: innerV1, isAvenue: true, lotId: 1 },
      ];

      const midSpan = innerU1 - innerU0 - 2 * endDepth - 2.0;
      const nMid = maxH > 110 ? 3 : 5;
      const lotW = midSpan / nMid;
      const halfV = (innerV0 + innerV1) * 0.5;
      for (let m = 0; m < nMid; m++) {
        const lu0 = innerU0 + endDepth + 1.0 + m * lotW;
        const lu1 = lu0 + lotW - 0.8;
        lots.push({ u0: lu0, v0: innerV0, u1: lu1, v1: halfV - 1.2, isAvenue: false, lotId: 2 + m * 2 });
        lots.push({ u0: lu0, v0: halfV + 1.2, u1: lu1, v1: innerV1, isAvenue: false, lotId: 3 + m * 2 });
      }

      for (const lot of lots) {
        const r0 = hash2(iu * 97 + lot.lotId * 13, iv * 131 + lot.lotId * 7);
        const r1 = hash2(iu * 173 + lot.lotId * 29, iv * 67 + lot.lotId * 19);
        const hRaw = lot.isAvenue
          ? baseH + Math.pow(r0, 1.35) * (maxH - baseH)
          : baseH * 0.72 + Math.pow(r0, 1.8) * (maxH * 0.62 - baseH * 0.72);
        const kind = hRaw >= 95 ? (r1 > 0.35 ? 3 : 2) : hRaw >= 42 ? (r1 > 0.65 ? 3 : r1 > 0.25 ? 2 : 1) : (lot.isAvenue && r1 > 0.5 ? 4 : r1 > 0.45 ? 1 : 0);
        const fh = FLOOR_H[kind] ?? 3.8;
        const floors = Math.max(3, Math.round(hRaw / fh));
        const h = floors * fh;
        const era = kind === 3 ? 0.88 : kind === 0 ? 0.22 : 0.35 + 0.5 * r1;
        const pal = PALETTE[kind] ?? PALETTE[2];
        const baseRgb = pal[Math.floor(r1 * pal.length) % pal.length];
        const shade = 0.88 + 0.24 * r0;
        const rgb: [number, number, number] = [
          Math.min(1, baseRgb[0] * shade),
          Math.min(1, baseRgb[1] * shade),
          Math.min(1, baseRgb[2] * shade),
        ];
        const bldTuple: [number, number, number, number] = [r0, floors, kind, era];

        // Podium / main volume
        const podiumH = h > 65 ? Math.min(h * 0.34, 28 + 12 * r1) : h;
        GeomBuilder.addGridPrism(
          bFacade, bRoof,
          lot.u0, lot.v0, lot.u1, lot.v1,
          KERB_H, KERB_H + podiumH,
          rgb, 0.58, 0.94, bldTuple,
        );
        // Far LOD1 single prism
        GeomBuilder.addGridPrism(
          fFacade, fRoof,
          lot.u0, lot.v0, lot.u1, lot.v1,
          KERB_H, KERB_H + h,
          rgb, 0.58, 0.96, bldTuple,
        );

        // Setback upper tower + crown on taller buildings
        if (h > podiumH + 4) {
          const insetU = Math.min(5.5, (lot.u1 - lot.u0) * 0.16);
          const insetV = Math.min(5.5, (lot.v1 - lot.v0) * 0.16);
          const towerTop = h > 130 ? h * 0.84 : h;
          GeomBuilder.addGridPrism(
            bFacade, bRoof,
            lot.u0 + insetU, lot.v0 + insetV, lot.u1 - insetU, lot.v1 - insetV,
            KERB_H + podiumH, KERB_H + towerTop,
            rgb, 0.78, 0.98, bldTuple,
          );
          if (h > towerTop + 3) {
            const insetU2 = insetU * 1.85;
            const insetV2 = insetV * 1.85;
            GeomBuilder.addGridPrism(
              bFacade, bRoof,
              lot.u0 + insetU2, lot.v0 + insetV2, lot.u1 - insetU2, lot.v1 - insetV2,
              KERB_H + towerTop, KERB_H + h,
              rgb, 0.85, 1.0, bldTuple,
            );
          }
        }

        // Rooftop mechanical penthouse
        const rw = (lot.u1 - lot.u0) * 0.28;
        const rl = (lot.v1 - lot.v0) * 0.28;
        if (rw > 3 && rl > 3) {
          const mu = (lot.u0 + lot.u1) * 0.5;
          const mv = (lot.v0 + lot.v1) * 0.5;
          GeomBuilder.addGridPrism(
            bRoof, bRoof,
            mu - rw * 0.5, mv - rl * 0.5, mu + rw * 0.5, mv + rl * 0.5,
            KERB_H + h, KERB_H + h + 3.4,
            [0.34, 0.35, 0.37], 0.75, 0.98,
          );
        }

        // Illuminated storefront / billboard sign on avenue-fronting buildings
        if (lot.isAvenue) {
          const su = lot.lotId === 0 ? lot.u0 - 0.12 : lot.u1 + 0.12;
          const sv = (lot.v0 + lot.v1) * 0.5;
          const [sx, sy] = uvToXY(su, sv);
          const sYaw = lot.lotId === 0 ? AVENUE + Math.PI : AVENUE;
          props.sign.push([sx, sy, 3.6, sYaw, 10.5, 2.2, 1]);
          if (distMidtown < 950 && h > 50) {
            props.sign.push([sx, sy, 14.5, sYaw, 16.0, 7.5, 0]);
          }
        }

        // Rapier oriented bounding box collider (game frame: cx, cy, z0, z1, hx, hy, yaw)
        const [bcx, bcy] = uvToXY((lot.u0 + lot.u1) * 0.5, (lot.v0 + lot.v1) * 0.5);
        colliders.push({
          cx: bcx,
          cy: bcy,
          z0: 0,
          z1: KERB_H + h,
          hx: (lot.u1 - lot.u0) * 0.5,
          hy: (lot.v1 - lot.v0) * 0.5,
          yaw: AVENUE,
        });
      }
    }
  }

  const groundGroup = new THREE.Group();
  for (const [b, name] of [
    [gRoad, 'road'],
    [gSidewalk, 'sidewalk'],
    [gCurb, 'curb'],
    [gCrosswalk, 'crosswalk'],
    [gMarking, 'marking'],
    [gGrass, 'grass'],
    [gWater, 'water'],
  ] as const) {
    const m = b.toMesh(name);
    if (m) groundGroup.add(m);
  }

  const bldGroup = new THREE.Group();
  for (const [b, name] of [
    [bFacade, 'facade'],
    [bRoof, 'roof'],
  ] as const) {
    const m = b.toMesh(name);
    if (m) bldGroup.add(m);
  }

  const farGroup = new THREE.Group();
  for (const [b, name] of [
    [fFacade, 'facade'],
    [fRoof, 'roof'],
  ] as const) {
    const m = b.toMesh(name);
    if (m) farGroup.add(m);
  }

  return {
    groundGroup,
    bldGroup,
    farGroup,
    col: { ground: 0, buildings: colliders },
    props,
  };
}
