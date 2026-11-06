// New York signage: Times Square style LED screens and neon shop signs.
//
// One InstancedMesh of unit quads (2 triangles each) with ONE procedural TSL material: no textures, no per-sign texture, nothing animated from JS
// (the shader reads the shared `nycTime` uniform). Instance data: the matrix (position, yaw, width x height) plus a vec4 (kind, seed, widthM, heightM).
//   kind 0..7   big screens (props.py "sign" entries): 0 scrolling colour fields, 1 flashing neon bars, 2 glyph-like text, 3 pulsing rings,
//               4 sweeping diagonal stripes, 5 LED video noise, 6 ticker band + big shape, 7 slow colour flash.
//   kind 10..15 neon shop signs (frame tube + glyph pattern): pink, cyan, amber, green, red, violet.
// Everything is generic and fictional: the "text" is a hashed pixel pattern (no letters, no brand shapes).
// Emissive strength is capped (CAP) so bloom never blows out.
//
// Also exported here: the slot allocator (`InstanceSet`) the props use, so tiles can stream in and out without re-allocating or recompiling.
import * as THREE from 'three/webgpu';
import {
  uniform, instancedBufferAttribute, uv, float, vec2, vec3, floor, fract, mix, step, smoothstep, abs, max, min, sin, length,
  mod, hash, select, clamp, mx_noise_float, Fn,
} from 'three/tsl';

/** Shared night-time clock (seconds) driving every procedural animation of the New York props. Advanced by NycProps.update. */
export const nycTime = uniform(0);

// ---- slot allocator --------------------------------------------------------------------------------------------------------------------

export type InstanceFill = (row: number[], m: Float32Array, mo: number, extra: Float32Array | null, eo: number) => void;

/** Writes a column-major instance matrix: translation (game frame x, y, z up -> three x, z, -y), yaw about three Y, per-axis scale. */
export function writeMatrix(a: Float32Array, o: number, x: number, y: number, z: number, yaw: number, sx = 1, sy = 1, sz = 1) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  a[o] = sx * c; a[o + 1] = 0; a[o + 2] = -sx * s; a[o + 3] = 0;
  a[o + 4] = 0; a[o + 5] = sy; a[o + 6] = 0; a[o + 7] = 0;
  a[o + 8] = sz * s; a[o + 9] = 0; a[o + 10] = sz * c; a[o + 11] = 0;
  a[o + 12] = x; a[o + 13] = z; a[o + 14] = -y; a[o + 15] = 1;
}

/**
 * A pre-allocated InstancedMesh whose slots are leased per tile. Slots of unloaded tiles are zeroed (degenerate) and reused; the draw count is the
 * high-water mark (never below 1, so the pipeline is compiled at the first frame). Uploads happen at most once per frame, from flush().
 */
export class InstanceSet {
  readonly mesh: THREE.InstancedMesh;
  readonly extra: THREE.InstancedBufferAttribute | null;
  private tiles = new Map<string, number[]>();
  private free: number[] = [];
  private high = 0;
  private dirty = true;
  private warned = false;
  dropped = 0;

  constructor(geometry: THREE.BufferGeometry, material: THREE.Material, readonly capacity: number, private extraStride = 0, name = 'nyc', extraAttr?: THREE.InstancedBufferAttribute) {
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceMatrix.array.fill(0);
    this.mesh.count = 1;
    if (extraStride) {
      this.extra = extraAttr ?? new THREE.InstancedBufferAttribute(new Float32Array(capacity * extraStride), extraStride);
      this.extra.setUsage(THREE.DynamicDrawUsage);
    } else this.extra = null;
  }

  get used() { return this.high - this.free.length; }

  add(key: string, rows: number[][] | undefined, fill: InstanceFill) {
    this.remove(key);
    if (!rows || !rows.length) return;
    const slots: number[] = [];
    const m = this.mesh.instanceMatrix.array as Float32Array;
    const ex = this.extra ? (this.extra.array as Float32Array) : null;
    for (const row of rows) {
      let s: number;
      if (this.free.length) s = this.free.pop()!;
      else if (this.high < this.capacity) s = this.high++;
      else { this.dropped++; if (!this.warned) { this.warned = true; console.warn(`nyc ${this.mesh.name}: capacity ${this.capacity} reached`); } continue; }
      fill(row, m, s * 16, ex, s * this.extraStride);
      slots.push(s);
    }
    this.tiles.set(key, slots);
    this.dirty = true;
  }

  remove(key: string) {
    const slots = this.tiles.get(key);
    if (!slots) return;
    const m = this.mesh.instanceMatrix.array as Float32Array;
    for (const s of slots) { m.fill(0, s * 16, s * 16 + 16); this.free.push(s); }
    this.tiles.delete(key);
    this.dirty = true;
  }

  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    // shrink the high-water mark over a free tail
    if (this.free.length) {
      const set = new Set(this.free);
      while (this.high > 0 && set.has(this.high - 1)) { set.delete(this.high - 1); this.high--; }
      this.free = [...set];
    }
    this.mesh.count = Math.max(1, this.high);
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.extra) this.extra.needsUpdate = true;
  }

  dispose() { this.mesh.geometry.dispose(); (this.mesh.material as THREE.Material).dispose(); this.mesh.dispose(); }
}

// ---- the sign material --------------------------------------------------------------------------------------------------------------

const CAP = 2.4;   // max linear emissive per channel after all gains (bloom stays sane)

const hsv = (h: any) => clamp(abs(fract(h.add(vec3(0, 2 / 3, 1 / 3))).mul(6).sub(3)).sub(1), 0, 1);

/** Pseudo text: rows of "glyphs" (5x7 hashed pixel cells with a 1 px gap) scrolling along x. `p` = pixel coords, returns 0/1. */
const glyphs: any = Fn(([p, seed, scroll]: any[]) => {
  const px = p.x.add(scroll);
  const cx = floor(px.div(6));
  const gx = mod(px, 6), gy = mod(p.y, 9);
  const inGlyph = step(gx, 4.99).mul(step(1, gy)).mul(step(gy, 7.99)).mul(step(1, gy));
  const bit = step(0.46, hash(cx.mul(13.7).add(floor(gx).mul(3.1)).add(floor(gy).mul(17.3)).add(seed.mul(91.0)).add(floor(p.y.div(9)).mul(53.0))));
  const wordGap = step(0.18, hash(cx.mul(0.37).add(seed.mul(7.0)).add(floor(p.y.div(9)).mul(9.0)).floor().div(3).floor()));   // spaces between "words"
  return inGlyph.mul(bit).mul(wordGap);
});

export function createSignMaterial(data: THREE.InstancedBufferAttribute) {
  const d: any = instancedBufferAttribute(data);          // x kind, y seed, z width m, w height m
  const kind = d.x, seed = d.y, W = d.z, H = d.w;
  const U: any = uv();
  const t = nycTime;
  const px = float(0.22);                            // fine physical LED pitch in metres
  const grid = vec2(W.div(px), H.div(px));
  const P: any = floor(U.mul(grid));                      // LED pixel coordinates
  const F: any = fract(U.mul(grid));
  const dot2 = smoothstep(0.64, 0.26, length(F.sub(0.5)));
  // Physical LED module cabinet seams every ~1.6 m + micro-louver shading
  const cab = smoothstep(0.015, 0.04, min(fract(U.x.mul(W).div(1.6)), fract(U.y.mul(H).div(1.6))));
  const led = mix(0.68, 1.0, dot2).mul(mix(0.82, 1.0, cab));
  const S = seed;
  const is = (k: number) => step(abs(kind.sub(k)), 0.5);

  // 0 Luxury / Fashion Editorial Billboard: studio-lit portrait silhouette on deep charcoal/obsidian with crisp editorial typography
  const puv0 = U.sub(vec2(0.5, 0.46)).mul(vec2(W.div(max(H, 1.0)), 1.0));
  const head0 = smoothstep(0.26, 0.22, length(puv0.sub(vec2(0.0, 0.14))));
  const shld0 = smoothstep(0.48, 0.38, length(puv0.sub(vec2(0.0, -0.32)).mul(vec2(0.75, 1.2))));
  const fig0 = max(head0, shld0);
  const rim0 = smoothstep(0.1, 0.45, puv0.x.add(0.25)).mul(smoothstep(-0.35, 0.35, puv0.y));
  const skin0 = mix(vec3(0.18, 0.11, 0.08), vec3(0.95, 0.72, 0.54), rim0);
  const bg0 = mix(vec3(0.025, 0.028, 0.038), vec3(0.12, 0.08, 0.06), U.y);
  const txt0 = glyphs(vec2(P.x.div(2).floor(), P.y.div(2).floor()), S, float(0)).mul(step(0.76, U.y).add(step(U.y, 0.16)));
  const c0 = mix(bg0, skin0, fig0).add(vec3(0.98, 0.92, 0.82).mul(txt0).mul(0.95));

  // 1 Broadway Musical Marquee: deep velvet crimson with warm gold spotlight frame & bold marquee title lettering
  const bdr1 = step(0.06, U.x).mul(step(U.x, 0.94)).mul(step(0.08, U.y)).mul(step(U.y, 0.92));
  const frame1 = bdr1.sub(step(0.09, U.x).mul(step(U.x, 0.91)).mul(step(0.13, U.y)).mul(step(U.y, 0.87)));
  const bulb1 = smoothstep(0.45, 0.1, length(fract(U.mul(vec2(24.0, 14.0))).sub(0.5))).mul(frame1);
  const spot1 = smoothstep(0.75, 0.05, length(U.sub(vec2(0.5, 0.55)).mul(vec2(1.1, 1.3))));
  const bg1 = mix(vec3(0.18, 0.015, 0.03), vec3(0.68, 0.06, 0.08), spot1);
  const g1 = glyphs(vec2(P.x.div(3).floor(), P.y.div(3).floor()), S.add(1.7), float(0)).mul(step(0.28, U.y)).mul(step(U.y, 0.76)).mul(step(0.14, U.x)).mul(step(U.x, 0.86));
  const c1 = bg1.add(vec3(1.0, 0.78, 0.28).mul(bulb1.mul(1.2))).add(vec3(1.0, 0.9, 0.58).mul(g1.mul(1.15)));

  // 2 NASDAQ / Financial Market Tower Display: deep navy-teal data grid with live green/amber/cyan market bars & scrolling tickers
  const rowsN = float(4.0);
  const band = floor(U.y.mul(rowsN));
  const gp = vec2(P.x, floor(U.y.mul(rowsN).mul(9.0)));
  const g2 = glyphs(vec2(P.x.div(2).floor(), gp.y.mul(0.5).floor().mul(2)), S.add(band), floor(t.mul(4.5)).mul(mix(1, -1, step(0.5, hash(band.add(S))))));
  const bg2 = mix(vec3(0.012, 0.032, 0.065), vec3(0.02, 0.07, 0.13), U.y);
  const chartBar = step(fract(U.y.mul(rowsN)), hash(floor(U.x.mul(18.0)).add(band.mul(7.0)).add(floor(t.mul(0.8)))).mul(0.65).add(0.15)).mul(step(0.25, fract(U.x.mul(18.0))));
  const fgCol2 = select(band.lessThan(1.5), vec3(0.15, 0.92, 0.52), select(band.lessThan(2.5), vec3(0.32, 0.78, 1.0), vec3(1.0, 0.78, 0.28)));
  const c2 = bg2.add(fgCol2.mul(chartBar.mul(0.22))).add(fgCol2.mul(g2.mul(step(0.14, fract(U.y.mul(rowsN))).mul(step(fract(U.y.mul(rowsN)), 0.88))).mul(1.05)));

  // 3 Tech / Smartphone Hero Launch Ad: sleek dark sapphire gradient with glowing angled product frame & ice-white header
  const q = U.sub(0.5).mul(vec2(W, H)).div(max(W, H).mul(0.5));
  const rx = q.x.mul(0.88).add(q.y.mul(0.32)), ry = q.y.mul(0.88).sub(q.x.mul(0.32));
  const devBody = smoothstep(0.02, 0.0, max(abs(rx).sub(0.24), abs(ry).sub(0.44)));
  const devRim = smoothstep(0.035, 0.0, abs(max(abs(rx).sub(0.24), abs(ry).sub(0.44))));
  const devScrn = devBody.mul(mix(vec3(0.08, 0.35, 0.78), vec3(0.45, 0.85, 1.0), smoothstep(-0.4, 0.4, ry.add(sin(t.mul(0.8)).mul(0.15)))));
  const bg3 = mix(vec3(0.015, 0.022, 0.045), vec3(0.04, 0.09, 0.18), U.y);
  const txt3 = glyphs(vec2(P.x.div(2).floor(), P.y.div(2).floor()), S.add(3.1), float(0)).mul(step(0.78, U.y));
  const c3 = mix(bg3, devScrn, devBody).add(vec3(0.75, 0.94, 1.0).mul(devRim)).add(vec3(0.95, 0.98, 1.0).mul(txt3));

  // 4 Iconic Beverage Red & White Wave Billboard: rich crimson backdrop with flowing white ribbon wave & bold headline
  const waveY = sin(U.x.mul(4.2).sub(t.mul(1.1)).add(S.mul(6.0))).mul(0.14).add(0.38);
  const ribbon = smoothstep(0.09, 0.015, abs(U.y.sub(waveY)));
  const bg4 = mix(vec3(0.48, 0.015, 0.025), vec3(0.88, 0.04, 0.06), smoothstep(0.0, 0.85, U.y));
  const txt4 = glyphs(vec2(P.x.div(3).floor(), P.y.div(3).floor()), S.add(4.4), float(0)).mul(step(0.58, U.y)).mul(step(U.y, 0.86)).mul(step(0.12, U.x)).mul(step(U.x, 0.88));
  const c4 = mix(bg4, vec3(0.98, 0.96, 0.94), max(ribbon, txt4.mul(0.95)));

  // 5 High-Contrast Automotive / Sports Action Screen: dark carbon left, warm amber/cobalt speed graphic right
  const split5 = smoothstep(-0.04, 0.04, U.x.sub(0.46).add(U.y.sub(0.5).mul(0.22)));
  const streak5 = smoothstep(0.3, 0.85, sin(U.y.mul(16.0).add(U.x.mul(8.0)).sub(t.mul(3.5))).mul(0.5).add(0.5));
  const col5R = mix(vec3(0.05, 0.16, 0.42), vec3(0.98, 0.48, 0.12), streak5.mul(U.y));
  const txt5 = glyphs(vec2(P.x.div(2).floor(), P.y.div(2).floor()), S.add(5.2), float(0)).mul(step(U.x, 0.44)).mul(step(0.25, U.y)).mul(step(U.y, 0.82));
  const c5 = mix(vec3(0.02, 0.024, 0.032).add(vec3(1.0, 0.82, 0.32).mul(txt5)), col5R, split5);

  // 6 24-Hour Network News / Studio Feed + Breaking Ticker Band
  const isBand = step(U.y, 0.24);
  const g6 = glyphs(vec2(P.x.div(2).floor(), floor(U.y.mul(4.0).mul(9.0)).mul(0.5).floor().mul(2)), S, floor(t.mul(8.0)));
  const globe = smoothstep(0.04, 0.0, length(vec2(U.x.sub(0.68).mul(W), U.y.sub(0.62).mul(H))).sub(H.mul(0.26)));
  const studioBg = mix(vec3(0.02, 0.05, 0.14), vec3(0.12, 0.38, 0.72), globe);
  const head6 = glyphs(vec2(P.x.div(2).floor(), P.y.div(2).floor()), S.add(6.3), float(0)).mul(step(U.x, 0.52)).mul(step(0.42, U.y)).mul(step(U.y, 0.82));
  const tickerBg = mix(vec3(0.75, 0.04, 0.05), vec3(0.95, 0.88, 0.25), g6);
  const c6 = mix(studioBg.add(vec3(0.96, 0.96, 0.98).mul(head6)), tickerBg, isBand);

  // 7 Cinema Blockbuster / Streaming Key Art: teal & amber anamorphic horizon flare + billing block
  const flare7 = smoothstep(0.28, 0.0, abs(U.y.sub(0.48))).mul(smoothstep(0.65, 0.0, abs(U.x.sub(0.5))));
  const sil7 = step(0.42, U.y).mul(smoothstep(0.18, 0.22, length(U.sub(vec2(0.5, 0.56)).mul(vec2(1.4, 0.9)))));
  const bg7 = mix(vec3(0.015, 0.06, 0.09), vec3(0.04, 0.22, 0.32), sil7).add(vec3(1.0, 0.52, 0.16).mul(flare7));
  const bill7 = glyphs(vec2(P.x, P.y), S.add(7.7), float(0)).mul(step(U.y, 0.22)).mul(0.45);
  const title7 = glyphs(vec2(P.x.div(3).floor(), P.y.div(3).floor()), S.add(8.1), float(0)).mul(step(0.24, U.y)).mul(step(U.y, 0.42)).mul(step(0.18, U.x)).mul(step(U.x, 0.82));
  const c7 = bg7.add(vec3(0.98, 0.88, 0.72).mul(title7)).add(vec3(0.65, 0.72, 0.78).mul(bill7));

  const screen = c0.mul(is(0)).add(c1.mul(is(1))).add(c2.mul(is(2))).add(c3.mul(is(3))).add(c4.mul(is(4))).add(c5.mul(is(5))).add(c6.mul(is(6))).add(c7.mul(is(7)));

  // neon shop sign: tube frame + glyphs, one colour, occasional flicker
  const idx = kind.sub(10);
  const neonCol = select(idx.lessThan(0.5), vec3(1.0, 0.18, 0.55),
    select(idx.lessThan(1.5), vec3(0.15, 0.85, 1.0),
      select(idx.lessThan(2.5), vec3(1.0, 0.62, 0.12),
        select(idx.lessThan(3.5), vec3(0.2, 1.0, 0.35),
          select(idx.lessThan(4.5), vec3(1.0, 0.12, 0.1), vec3(0.75, 0.4, 1.0))))));
  const edge = min(min(U.x.mul(W), W.mul(U.x.oneMinus())), min(U.y.mul(H), H.mul(U.y.oneMinus())));
  const tube = smoothstep(0.07, 0.0, abs(edge.sub(0.1)));
  const ng = glyphs(vec2(floor(U.x.mul(W).div(0.075)), floor(U.y.mul(H).div(0.075))), S, float(0));
  const inner = step(0.22, edge);
  const flick = mix(1.0, 0.25, step(0.93, hash(floor(t.mul(7.0)).add(S.mul(100.0)))));
  const neon = neonCol.mul(max(tube, ng.mul(inner).mul(0.9))).mul(flick).add(neonCol.mul(0.02));
  const isNeon = step(9.5, kind);

  // dark metal frame around the big screens (0.25 m)
  const fr = step(0.25, edge);
  const lit = mix(screen.mul(led).mul(fr).add(vec3(0.015)), neon, isNeon);
  const capped = min(lit, vec3(CAP));
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.colorNode = capped.mul(mix(1.55, 1.9, isNeon));
  mat.side = THREE.FrontSide;
  mat.name = 'nyc_sign';
  return mat;
}

/** Colour (rgb 0..1) the pooled lights use for a sign of this kind (static approximation of the animated screen). */
export const SIGN_LIGHT: Record<number, [number, number, number]> = {
  0: [0.9, 0.45, 0.8], 1: [1.0, 0.35, 0.6], 2: [1.0, 0.85, 0.55], 3: [0.4, 0.55, 1.0], 4: [0.4, 0.9, 0.8], 5: [0.7, 0.5, 1.0], 6: [1.0, 0.7, 0.3], 7: [0.9, 0.9, 1.0],
  10: [1.0, 0.18, 0.55], 11: [0.15, 0.85, 1.0], 12: [1.0, 0.62, 0.12], 13: [0.2, 1.0, 0.35], 14: [1.0, 0.12, 0.1], 15: [0.75, 0.4, 1.0],
};

/** Streams the `sign` entries of the tiles: [x, y, z(centre, above ground), yaw (outward wall normal), w, h, kind]. */
export class NycSigns {
  readonly set: InstanceSet;
  constructor(scene: THREE.Object3D, capacity = 3200) {
    const data = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.set = new InstanceSet(new THREE.PlaneGeometry(1, 1), createSignMaterial(data), capacity, 4, 'nyc_signs', data);
    scene.add(this.set.mesh);
  }
  setTile(key: string, rows: number[][] | undefined, groundZ = 0) {
    this.set.add(key, rows, (r, m, mo, ex, eo) => {
      ex![eo] = r[6]; ex![eo + 1] = (Math.abs(r[0]) * 0.137 + Math.abs(r[1]) * 0.291) % 1; ex![eo + 2] = r[4]; ex![eo + 3] = r[5];
      writeMatrix(m, mo, r[0], r[1], r[2] + groundZ, r[3] + Math.PI / 2, r[4], r[5], 1);   // quad faces local +Z; +90 deg maps it onto the wall normal
    });
  }
  removeTile(key: string) { this.set.remove(key); }
  flush() { this.set.flush(); }
  dispose() { this.set.mesh.removeFromParent(); this.set.dispose(); }
}
