// Parts that FIT: every add-on is built from the car's own surface, not from its bounding box.
//
// The first generation of parts (aero.ts, body.ts) placed slabs relative to the car's box: a splitter was a plate
// 0.22 m in front of the box, a flare a torus at a fixed wheelbase, a "vented hood" a board over the nose. On any car
// whose nose is not a box they floated or cut through the body. Here a BodyFit samples the model's vertices once
// (model space: x left, y up, z forward) into a few outlines -
//   nose / tail outline   foremost / rearmost z per column of x, low on the bumper, and the underside height there
//   sill outline          widest |x| per row of z below the doors, per side, and the underside height there
//   shoulder outline      widest |x| per row of z at wheel-arch height (flares and canards sit on it)
//   deck                  highest y per (x, z) cell (wing mounts stand on it)
// - and the builders sweep thin sections along those outlines. A splitter is then a blade that follows the bumper's
// own curve and touches its underside; a flare is a lip around the real arch of the real wheel.
import * as THREE from 'three/webgpu';

const NX = 72, NZ = 180;
/** hub centre and tyre radius in model space */
export interface FitWheel { x: number; y: number; z: number; r: number }

export class BodyFit {
  readonly box = new THREE.Box3();
  readonly wheels: FitWheel[];
  /** ground under the tyres (model space y) */
  readonly ground: number;
  private x0 = 0; private dx = 1; private z0 = 0; private dz = 1;
  private noseZ = new Float32Array(NX).fill(-Infinity); private noseY = new Float32Array(NX).fill(Infinity);
  private tailZ = new Float32Array(NX).fill(Infinity); private tailY = new Float32Array(NX).fill(Infinity);
  private sillX = [new Float32Array(NZ).fill(0), new Float32Array(NZ).fill(0)]; private sillY = [new Float32Array(NZ).fill(Infinity), new Float32Array(NZ).fill(Infinity)];
  private shoulderX = [new Float32Array(NZ).fill(0), new Float32Array(NZ).fill(0)];
  private cornerX = [new Float32Array(NZ).fill(0), new Float32Array(NZ).fill(0)];
  private deck = new Float32Array(NX * NZ).fill(-Infinity);

  /**
   * model: the car (its world matrix current). skip(o): meshes that are not body (wheels, calipers, the stock wing,
   * beams, shadows, generated parts). wheels: hub centres / radii in model space.
   */
  constructor(model: THREE.Object3D, wheels: FitWheel[], skip: (o: THREE.Mesh) => boolean) {
    this.wheels = wheels;
    this.ground = wheels.length ? Math.min(...wheels.map((w) => w.y - w.r)) : 0;
    const inv = new THREE.Matrix4().copy(model.matrixWorld).invert(), m4 = new THREE.Matrix4(), v = new THREE.Vector3();
    const pts: number[] = [];
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry || skip(mesh)) return;
      let hidden = false;
      for (let p: THREE.Object3D | null = mesh; p && p !== model; p = p.parent) if (!p.visible) hidden = true;
      if (hidden) return;
      const pos = mesh.geometry.attributes.position as THREE.BufferAttribute | undefined;
      if (!pos) return;
      m4.multiplyMatrices(inv, mesh.matrixWorld);
      for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(m4); pts.push(v.x, v.y, v.z); this.box.expandByPoint(v); }
    });
    const b = this.box;
    if (b.isEmpty()) b.set(new THREE.Vector3(-1, 0, -2.2), new THREE.Vector3(1, 1.2, 2.2));
    this.x0 = b.min.x; this.dx = (b.max.x - b.min.x) / NX; this.z0 = b.min.z; this.dz = (b.max.z - b.min.z) / NZ;
    const col = (x: number) => Math.min(NX - 1, Math.max(0, Math.floor((x - this.x0) / this.dx)));
    const row = (z: number) => Math.min(NZ - 1, Math.max(0, Math.floor((z - this.z0) / this.dz)));
    const low = this.ground + 0.5;                       // bumper band: below the lamps and the bonnet line
    const sill = this.ground + 0.36;                     // below the doors
    const wy = wheels.length ? wheels[0].y : this.ground + 0.34, wr = wheels.length ? wheels[0].r : 0.34;
    for (let i = 0; i < pts.length; i += 3) {
      const x = pts[i], y = pts[i + 1], z = pts[i + 2], c = col(x), r = row(z), s = x >= 0 ? 0 : 1, ax = Math.abs(x);
      if (y > this.deck[r * NX + c]) this.deck[r * NX + c] = y;
      if (y < low) { if (z > this.noseZ[c]) this.noseZ[c] = z; if (z < this.tailZ[c]) this.tailZ[c] = z; }
      if (y < sill && ax > this.sillX[s][r]) this.sillX[s][r] = ax;
      if (y > wy && y < wy + wr + 0.3 && ax > this.shoulderX[s][r]) this.shoulderX[s][r] = ax;
      if (y > this.ground + 0.3 && y < this.ground + 0.6 && ax > this.cornerX[s][r]) this.cornerX[s][r] = ax;
    }
    // underside heights: the lowest body point within 0.3 m behind the nose outline / ahead of the tail outline, and
    // within 0.14 m inboard of the sill outline
    for (let i = 0; i < pts.length; i += 3) {
      const x = pts[i], y = pts[i + 1], z = pts[i + 2], c = col(x), r = row(z), s = x >= 0 ? 0 : 1;
      if (y >= low) continue;
      if (z > this.noseZ[c] - 0.3 && y < this.noseY[c]) this.noseY[c] = y;
      if (z < this.tailZ[c] + 0.3 && y < this.tailY[c]) this.tailY[c] = y;
      if (y < sill && Math.abs(x) > this.sillX[s][r] - 0.14 && y < this.sillY[s][r]) this.sillY[s][r] = y;
    }
    for (const a of [this.noseZ, this.noseY, this.tailZ, this.tailY, ...this.shoulderX, ...this.cornerX]) heal(a, 1);
    // sills are stepped and vented on race bodies: a blade must run past that in one clean line
    for (const a of [...this.sillX, ...this.sillY]) heal(a, 5);
  }

  get halfWidth() { return Math.max(this.box.max.x, -this.box.min.x); }
  private sample(a: Float32Array, t: number) {
    const f = Math.min(a.length - 1.001, Math.max(0, t - 0.5)), i = Math.floor(f), k = f - i;
    return a[i] * (1 - k) + a[Math.min(a.length - 1, i + 1)] * k;
  }
  /** the bumper's foremost z at x, and the underside height there */
  nose(x: number) { const t = (x - this.x0) / this.dx; return { z: this.sample(this.noseZ, t), y: this.sample(this.noseY, t) }; }
  tail(x: number) { const t = (x - this.x0) / this.dx; return { z: this.sample(this.tailZ, t), y: this.sample(this.tailY, t) }; }
  /** side: +1 = left (x > 0), -1 = right. The sill's outermost |x| at z, and its underside height */
  sill(z: number, side: 1 | -1) { const t = (z - this.z0) / this.dz, s = side > 0 ? 0 : 1; return { x: this.sample(this.sillX[s], t), y: this.sample(this.sillY[s], t) }; }
  shoulder(z: number, side: 1 | -1) { return this.sample(this.shoulderX[side > 0 ? 0 : 1], (z - this.z0) / this.dz); }
  /** the body side at bumper-corner height (0.3-0.6 m above the ground): canards sit on it */
  corner(z: number, side: 1 | -1) { return this.sample(this.cornerX[side > 0 ? 0 : 1], (z - this.z0) / this.dz); }
  /** highest body point within r of (x, z): where a wing mount stands */
  deckAt(x: number, z: number, r = 0.06) {
    let y = -Infinity;
    const c0 = Math.max(0, Math.floor((x - r - this.x0) / this.dx)), c1 = Math.min(NX - 1, Math.floor((x + r - this.x0) / this.dx));
    const r0 = Math.max(0, Math.floor((z - r - this.z0) / this.dz)), r1 = Math.min(NZ - 1, Math.floor((z + r - this.z0) / this.dz));
    for (let rr = r0; rr <= r1; rr++) for (let cc = c0; cc <= c1; cc++) y = Math.max(y, this.deck[rr * NX + cc]);
    return Number.isFinite(y) ? y : this.box.max.y;
  }
  /**
   * Where a rear wing mounts: the tail deck, as the box the wing builders expect (wings.ts WingCtx.wb): its bottom is
   * the deck surface under the mounts, its z the mount line 0.2-0.35 m ahead of the tail.
   */
  wingBase(): THREE.Box3 {
    const hw = this.halfWidth, zt = this.box.min.z;
    let best = zt + 0.3, y = -Infinity;
    // the highest stretch of deck in the last 0.55 m of the car (a fastback's lip, a notchback's boot lid)
    for (let z = zt + 0.16; z <= zt + 0.56; z += 0.04) {
      const yy = Math.min(this.deckAt(hw * 0.3, z), this.deckAt(-hw * 0.3, z));
      if (yy > y + 0.004) { y = yy; best = z; }
    }
    return new THREE.Box3(new THREE.Vector3(-hw * 0.8, y, best - 0.13), new THREE.Vector3(hw * 0.8, y + 0.02, best + 0.13));
  }
}

/**
 * The exact extent of a subtree's vertices in another space (`to` = that space's inverse world matrix). A geometry's
 * own bounding box pushed through a rotated matrix is a box around a box: a wheel modelled at an angle measured 1 m
 * across instead of 0.76.
 */
export function exactBox(root: THREE.Object3D, to: THREE.Matrix4, skip?: (m: THREE.Mesh) => boolean): THREE.Box3 {
  const box = new THREE.Box3(), m4 = new THREE.Matrix4(), v = new THREE.Vector3();
  root.updateWorldMatrix(true, true);
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    const pos = m.isMesh ? (m.geometry?.attributes.position as THREE.BufferAttribute | undefined) : undefined;
    if (!pos || skip?.(m)) return;
    m4.multiplyMatrices(to, m.matrixWorld);
    const step = Math.max(1, Math.floor(pos.count / 4000));   // a few thousand samples bound a wheel to the millimetre
    for (let i = 0; i < pos.count; i += step) box.expandByPoint(v.fromBufferAttribute(pos, i).applyMatrix4(m4));
  });
  return box;
}

/** empty bins take their neighbours' values; a median over 2k+1 bins drops single rough vertices and steps, then a
 *  box blur of the same width makes the outline one clean line */
function heal(a: Float32Array, k = 1) {
  const n = a.length;
  let last = NaN;
  for (let i = 0; i < n; i++) { if (Number.isFinite(a[i]) && a[i] !== 0) last = a[i]; else if (!Number.isNaN(last)) a[i] = last; }
  last = NaN;
  for (let i = n - 1; i >= 0; i--) { if (Number.isFinite(a[i]) && a[i] !== 0) last = a[i]; else if (!Number.isNaN(last)) a[i] = last; }
  const c = Float32Array.from(a), win: number[] = [];
  for (let i = 0; i < n; i++) {
    win.length = 0;
    for (let j = -k; j <= k; j++) win.push(c[Math.min(n - 1, Math.max(0, i + j))]);
    win.sort((x, y) => x - y);
    a[i] = win[k];
  }
  const m = Float32Array.from(a);
  for (let i = 0; i < n; i++) { let sum = 0; for (let j = -k; j <= k; j++) sum += m[Math.min(n - 1, Math.max(0, i + j))]; a[i] = sum / (2 * k + 1); }
}

// ---- geometry: a thin section swept along an outline --------------------------------------------------------------------
/** one station of a ribbon: a point on the outline, the outward direction there (unit, in the xz plane), how far the
 *  section reaches inboard / outboard of the outline, its top height, and how much higher the outer edge sits */
export interface Station { x: number; z: number; ox: number; oz: number; inw: number; outw: number; y: number; rise?: number }

class Tris {
  private p: number[] = [];
  /** both windings: the part reads correctly whatever side the camera is on, with any single-sided material */
  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) { this.tri(a, b, c); this.tri(a, c, d); }
  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) {
    this.p.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, a.x, a.y, a.z, c.x, c.y, c.z, b.x, b.y, b.z);
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    const uv = new Float32Array((this.p.length / 3) * 2);
    for (let i = 0, j = 0; i < this.p.length; i += 3, j += 2) { uv[j] = this.p[i] * 4; uv[j + 1] = this.p[i + 2] * 4; }   // carbon weave: 25 cm tiles, planar
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.computeVertexNormals();
    return g;
  }
  get empty() { return this.p.length === 0; }
}

/** A flat section of thickness t swept along the stations (a blade, a lip, a rail). */
export function ribbon(st: Station[], t: number, out = new Tris()): Tris {
  const corner = (s: Station, outer: boolean, top: boolean) => {
    const d = outer ? s.outw : -s.inw;
    return new THREE.Vector3(s.x + s.ox * d, s.y + (outer ? s.rise ?? 0 : 0) - (top ? 0 : t), s.z + s.oz * d);
  };
  for (let i = 0; i + 1 < st.length; i++) {
    const a = st[i], b = st[i + 1];
    out.quad(corner(a, false, true), corner(a, true, true), corner(b, true, true), corner(b, false, true));       // top
    out.quad(corner(a, false, false), corner(b, false, false), corner(b, true, false), corner(a, true, false));   // bottom
    out.quad(corner(a, true, true), corner(a, true, false), corner(b, true, false), corner(b, true, true));       // outer edge
    out.quad(corner(a, false, true), corner(b, false, true), corner(b, false, false), corner(a, false, false));   // inner edge
  }
  for (const s of [st[0], st[st.length - 1]]) if (s) out.quad(corner(s, false, true), corner(s, false, false), corner(s, true, false), corner(s, true, true));
  return out;
}
/** A thin vertical plate between two points of the xz plane, from y0 to y1 (a fin, an endplate, a strake). */
export function plate(x0: number, z0: number, x1: number, z1: number, y0: number, y1a: number, y1b: number, t: number, out = new Tris()): Tris {
  const dx = x1 - x0, dz = z1 - z0, l = Math.hypot(dx, dz) || 1, nx = (-dz / l) * t / 2, nz = (dx / l) * t / 2;
  const P = (x: number, y: number, z: number, s: number) => new THREE.Vector3(x + nx * s, y, z + nz * s);
  for (const s of [-1, 1]) out.quad(P(x0, y0, z0, s), P(x1, y0, z1, s), P(x1, y1b, z1, s), P(x0, y1a, z0, s));
  out.quad(P(x0, y1a, z0, -1), P(x1, y1b, z1, -1), P(x1, y1b, z1, 1), P(x0, y1a, z0, 1));
  out.quad(P(x0, y0, z0, -1), P(x0, y1a, z0, -1), P(x0, y1a, z0, 1), P(x0, y0, z0, 1));
  out.quad(P(x1, y0, z1, -1), P(x1, y1b, z1, -1), P(x1, y1b, z1, 1), P(x1, y0, z1, 1));
  return out;
}
const meshOf = (t: Tris, mat: THREE.Material, name: string) => { const m = new THREE.Mesh(t.geometry(), mat); m.name = name; m.castShadow = false; return m; };
const smooth = (a: number, b: number, x: number) => { const k = Math.min(1, Math.max(0, (x - a) / (b - a))); return k * k * (3 - 2 * k); };

// ---- splitters ------------------------------------------------------------------------------------------------------------
export interface SplitterP {
  /** how far the blade stands proud of the bumper, m */ out: number;
  /** thickness, m */ t?: number;
  /** share of the car's width it spans */ span?: number;
  /** endplate height at the tips, m (0 = none) */ plates?: number;
  /** canards per side on the bumper corners */ canards?: number;
  /** a second, shorter blade under the first */ twin?: boolean;
  /** only the outer thirds (a gap in the middle) */ split?: boolean;
  /** the middle third stands further out by this much */ step?: number;
  /** the tips turn up by this much */ curl?: number;
}
export function fittedSplitter(fit: BodyFit, mat: THREE.Material, p: SplitterP): THREE.Object3D {
  const g = new THREE.Group(), T = new Tris();
  const hw = fit.halfWidth * (p.span ?? 0.9), t = p.t ?? 0.016, N = 40;
  // one flat blade: it touches the lowest part of the bumper's underside (a real splitter is a flat board)
  let y = Infinity;
  for (let i = 0; i <= 12; i++) y = Math.min(y, fit.nose((i / 12 - 0.5) * hw * 1.2).y);
  y = Math.max(y, fit.ground + 0.07) + 0.002;
  const run = (from: number, to: number, out: number, dy: number, back: number) => {
    const st: Station[] = [];
    for (let i = 0; i <= N; i++) {
      const u = from + (to - from) * (i / N), x = u * hw, e = Math.abs(u);
      const taper = 1 - smooth(0.86, 1, e) * 0.75;                       // the blade thins into the bumper's corner
      const o = (out + (p.step && e < 0.36 ? p.step * (1 - smooth(0.26, 0.36, e)) : 0)) * taper;
      st.push({ x, z: fit.nose(x).z, ox: 0, oz: 1, inw: back, outw: o, y: y + dy + (p.curl ? p.curl * smooth(0.6, 1, e) : 0) });
    }
    ribbon(st, t, T);
  };
  if (p.split) { run(-1, -0.34, p.out, 0, 0.2); run(0.34, 1, p.out, 0, 0.2); }
  else run(-1, 1, p.out, 0, 0.22);
  if (p.twin) run(-0.8, 0.8, p.out * 0.55, -0.045, 0.16);
  if (p.plates) for (const s of [-1, 1]) {
    const x = s * hw * 0.985, z = fit.nose(x).z;
    plate(x, z - 0.16, x, z + p.out * 0.3, y - t, y + p.plates * 0.55, y + p.plates, 0.012, T);
  }
  for (let k = 0; k < (p.canards ?? 0); k++) for (const s of [-1, 1] as const) {
    // a canard: a small blade on the bumper's corner, along the body side, rising to the rear
    const zf = fit.box.max.z - 0.2 - k * 0.02, st: Station[] = [];
    for (let i = 0; i <= 6; i++) {
      const z = zf - i * 0.045, e = i / 6;
      st.push({ x: s * (fit.corner(z, s) - 0.012), z, ox: s, oz: 0, inw: 0.012, outw: 0.02 + 0.06 * Math.sin(Math.PI * Math.min(1, e * 1.15)) * (1 - 0.25 * k), y: fit.ground + 0.4 + k * 0.1 + e * 0.06 });
    }
    ribbon(st, 0.01, T);
  }
  g.add(meshOf(T, mat, 'splitter'));
  return g;
}

// ---- diffusers ------------------------------------------------------------------------------------------------------------
export interface DiffuserP {
  /** how far the trailing edge stands behind the bumper, m */ out: number;
  /** vertical strakes */ fins?: number; finH?: number;
  /** share of the width */ span?: number;
  /** endplates */ plates?: number;
  /** a second deck above */ twin?: boolean;
  /** how much the trailing edge is kicked up, m */ kick?: number;
}
export function fittedDiffuser(fit: BodyFit, mat: THREE.Material, p: DiffuserP): THREE.Object3D {
  const g = new THREE.Group(), T = new Tris();
  const rear = fit.wheels.filter((w) => w.z < 0);
  // between the rear tyres (a diffuser is the floor's exit), never wider than the body
  const inner = rear.length ? Math.max(0.3, Math.min(...rear.map((w) => Math.abs(w.x))) - 0.17) : fit.halfWidth * 0.6;
  const hw = Math.min(fit.halfWidth * 0.9, inner) * (p.span ?? 1), N = 28, kick = p.kick ?? 0.05;
  let y = Infinity;
  for (let i = 0; i <= 10; i++) y = Math.min(y, fit.tail((i / 10 - 0.5) * hw * 1.4).y);
  y = Math.max(y, fit.ground + 0.1) + 0.002;
  const run = (wf: number, out: number, dy: number, back: number) => {
    const st: Station[] = [];
    for (let i = 0; i <= N; i++) {
      const u = -1 + (2 * i) / N, x = u * hw * wf;
      st.push({ x, z: fit.tail(x).z, ox: 0, oz: -1, inw: back, outw: out * (1 - 0.5 * smooth(0.85, 1, Math.abs(u))), y: y + dy, rise: kick });
    }
    ribbon(st, 0.014, T);
  };
  run(1, p.out, 0, 0.34);
  if (p.twin) run(0.78, p.out * 0.6, 0.075, 0.2);
  const n = p.fins ?? 0, fh = Math.min(p.finH ?? 0.08, y - fit.ground - 0.035);
  for (let i = 0; i < n; i++) {
    const x = n === 1 ? 0 : (-1 + (2 * i) / (n - 1)) * hw * 0.86, z = fit.tail(x).z;
    plate(x, z + 0.3, x, z - p.out * 0.85, y - 0.014 - Math.max(0.03, fh), y - 0.014, y - 0.014 + kick * 0.8, 0.012, T);
  }
  if (p.plates) for (const s of [-1, 1]) { const x = s * hw, z = fit.tail(x).z; plate(x, z + 0.26, x, z - p.out * 0.7, y - 0.014 - Math.max(0.03, fh), y + p.plates, y + p.plates + kick, 0.012, T); }
  g.add(meshOf(T, mat, 'diffuser'));
  return g;
}

// ---- side skirts ----------------------------------------------------------------------------------------------------------
export interface SkirtP {
  /** how far the blade stands out from the sill, m */ out: number;
  t?: number;
  /** a second blade below */ twin?: boolean;
  /** two pieces with a gap amidships */ split?: boolean;
  /** rises towards the rear by this much */ rake?: number;
  /** a winglet at the rear end: extra reach there */ winglet?: number;
  /** upright fins at both ends */ fins?: number;
  /** an upright lip along the outer edge */ lip?: number;
}
export function fittedSkirt(fit: BodyFit, mat: THREE.Material, p: SkirtP): THREE.Object3D {
  const g = new THREE.Group(), T = new Tris();
  const fr = fit.wheels.filter((w) => w.z > 0), rr = fit.wheels.filter((w) => w.z < 0);
  const rf = fr[0]?.r ?? 0.34, rb = rr[0]?.r ?? 0.34;
  // between the wheel arches
  const zf = (fr[0]?.z ?? fit.box.max.z * 0.6) - rf - 0.09, zr = (rr[0]?.z ?? fit.box.min.z * 0.6) + rb + 0.09;
  const N = 30, t = p.t ?? 0.016;
  for (const s of [-1, 1] as const) {
    let y = Infinity;
    for (let i = 2; i <= N - 2; i++) y = Math.min(y, fit.sill(zr + (zf - zr) * (i / N), s).y);
    y = Math.max(y, fit.ground + 0.08) + 0.002;
    const run = (a: number, b: number, out: number, dy: number) => {
      const st: Station[] = [];
      for (let i = 0; i <= N; i++) {
        const u = a + (b - a) * (i / N), z = zr + (zf - zr) * u;
        const ends = smooth(0, 0.07, u) * (1 - smooth(0.93, 1, u));                      // the blade fades into the arches
        const o = out * (0.35 + 0.65 * ends) + (p.winglet ? p.winglet * smooth(0.3, 0.02, u) : 0);
        st.push({ x: s * fit.sill(z, s).x, z, ox: s, oz: 0, inw: 0.07, outw: o, y: y + dy + (p.rake ?? 0) * (1 - u) });
      }
      ribbon(st, t, T);
      return st;
    };
    const main = p.split ? [...run(0, 0.44, p.out, 0), ...run(0.56, 1, p.out, 0)] : run(0, 1, p.out, 0);
    if (p.twin) run(0.06, 0.94, p.out * 0.6, -0.04);
    if (p.lip) for (let i = 0; i + 1 < main.length; i++) {
      const a = main[i], b = main[i + 1];
      if (Math.abs(a.z - b.z) > 0.2) continue;   // the gap of a split skirt
      plate(a.x + s * a.outw, a.z, b.x + s * b.outw, b.z, a.y - t, a.y + p.lip, b.y + p.lip, 0.01, T);
    }
    if (p.fins) for (const u of [0.03, 0.97]) {
      const z = zr + (zf - zr) * u, x = fit.sill(z, s).x;
      plate(s * (x - 0.02), z, s * (x + p.out), z, y - t, y + p.fins, y + p.fins * 0.5, 0.012, T);
    }
  }
  g.add(meshOf(T, mat, 'skirt'));
  return g;
}

// ---- fender flares --------------------------------------------------------------------------------------------------------
export interface FlareP {
  /** how far the lip stands out from the body, m */ out: number;
  /** radial depth of the lip above the arch, m */ lip: number;
  /** exposed bolts along the lip */ bolts?: boolean;
}
export function fittedFlares(fit: BodyFit, mat: THREE.Material, p: FlareP): THREE.Object3D {
  const g = new THREE.Group(), T = new Tris();
  for (const w of fit.wheels) {
    const s = (w.x >= 0 ? 1 : -1) as 1 | -1;
    const R = w.r + 0.055;                                            // the arch opening: the tyre plus its clearance
    const N = 44, a0 = -0.12 * Math.PI, a1 = 1.12 * Math.PI;
    let prev: THREE.Vector3[] | null = null;
    for (let i = 0; i <= N; i++) {
      const a = a0 + (a1 - a0) * (i / N), ca = Math.cos(a), sa = Math.sin(a);
      const z = w.z + ca * R, body = fit.shoulder(Math.min(fit.box.max.z, Math.max(fit.box.min.z, z)), s);
      // the lip is widest over the top of the arch and blends into the body at its feet
      const k = 0.35 + 0.65 * Math.sin(Math.min(Math.PI, Math.max(0, (a - a0) / (a1 - a0) * Math.PI)));
      const xin = s * (body - 0.03), xout = s * (body + p.out * k);
      const at = (rad: number, x: number) => new THREE.Vector3(x, w.y + sa * rad, w.z + ca * rad);
      // section: inner foot (in the body), arch edge, outer edge, outer top, inner top
      const sec = [at(R, xin), at(R, xout), at(R + p.lip * 0.45, xout), at(R + p.lip, xin)];
      if (prev) for (let j = 0; j < sec.length; j++) T.quad(prev[j], prev[(j + 1) % sec.length], sec[(j + 1) % sec.length], sec[j]);
      prev = sec;
      if (p.bolts && i % 6 === 2) {
        const c = at(R + p.lip * 0.5, xout + s * 0.004);
        T.tri(c.clone().add(new THREE.Vector3(0, 0.012, 0)), c.clone().add(new THREE.Vector3(0, -0.008, 0.011)), c.clone().add(new THREE.Vector3(0, -0.008, -0.011)));
      }
    }
  }
  g.add(meshOf(T, mat, 'flares'));
  return g;
}

// ---- the designs: every id of the old catalogue keeps its name and gets a fitted shape -----------------------------------------
export const SPLITTERS_FIT: Record<string, SplitterP> = {
  'splitter-lip-01': { out: 0.035, t: 0.014 },
  'splitter-deep-02': { out: 0.09, t: 0.018, plates: 0.05 },
  'splitter-split-03': { out: 0.07, split: true },
  'splitter-canard-04': { out: 0.05, canards: 1 },
  'splitter-step-05': { out: 0.045, step: 0.05 },
  'splitter-curved-06': { out: 0.055, curl: 0.035 },
  'splitter-plate-07': { out: 0.075, plates: 0.09 },
  'splitter-twin-08': { out: 0.08, twin: true },
  'splitter-side-09': { out: 0.085, split: true, plates: 0.06 },
  'splitter-aggr-10': { out: 0.13, t: 0.02, plates: 0.11, canards: 2, twin: true },
};
export const DIFFUSERS_FIT: Record<string, DiffuserP> = {
  'diffuser-plate-11': { out: 0.03 },
  'diffuser-fins4-12': { out: 0.05, fins: 4 },
  'diffuser-fins6-13': { out: 0.06, fins: 6 },
  'diffuser-channel-14': { out: 0.06, fins: 2, finH: 0.1, plates: 0.04 },
  'diffuser-twin-15': { out: 0.07, fins: 4, twin: true },
  'diffuser-strake-16': { out: 0.05, fins: 5, finH: 0.06 },
  'diffuser-max-17': { out: 0.11, fins: 7, finH: 0.1, plates: 0.06, kick: 0.08 },
  'diffuser-vane-18': { out: 0.07, fins: 3, kick: 0.09 },
  'diffuser-step-19': { out: 0.08, twin: true },
  'diffuser-endplate-20': { out: 0.08, fins: 3, plates: 0.09 },
};
export const SKIRTS_FIT: Record<string, SkirtP> = {
  'skirt-blade-21': { out: 0.04 },
  'skirt-step-22': { out: 0.05, twin: true },
  'skirt-deep-23': { out: 0.055, t: 0.035 },
  'skirt-split-24': { out: 0.05, split: true },
  'skirt-fin-25': { out: 0.05, fins: 0.07 },
  'skirt-winglet-26': { out: 0.04, winglet: 0.07 },
  'skirt-twin-27': { out: 0.035, twin: true, lip: 0.02 },
  'skirt-angled-28': { out: 0.05, rake: 0.03 },
  'skirt-lip-29': { out: 0.045, lip: 0.03 },
  'skirt-cap-30': { out: 0.06, fins: 0.05, lip: 0.02 },
};
export const FLARES_FIT: Record<string, FlareP> = {
  'fender-smooth': { out: 0.012, lip: 0.035 },
  'fender-plus': { out: 0.022, lip: 0.045 },
  'fender-wide': { out: 0.035, lip: 0.055 },
  'fender-bolt': { out: 0.04, lip: 0.06, bolts: true },
  'fender-race': { out: 0.055, lip: 0.07 },
  'fender-extreme': { out: 0.075, lip: 0.085, bolts: true },
};

/**
 * A copy of one of the car's own panels with its vertices moved, baked to plain float geometry in model space.
 * (The models are quantized: a panel's positions are integers under a scaled node, so editing them in place moved
 * vertices by "0.035 integer units" and left normals no shader could light - the replacement shells rendered black.)
 */
export function reshaped(model: THREE.Object3D, stock: THREE.Object3D, mat: THREE.Material | null, move: (p: THREE.Vector3) => void): THREE.Object3D {
  const g = new THREE.Group(), inv = new THREE.Matrix4().copy(model.matrixWorld).invert(), m4 = new THREE.Matrix4(), v = new THREE.Vector3();
  stock.updateWorldMatrix(true, true);
  stock.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry?.attributes.position) return;
    const src = m.geometry, pos = src.attributes.position as THREE.BufferAttribute, out = new Float32Array(pos.count * 3);
    m4.multiplyMatrices(inv, m.matrixWorld);
    for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(m4); move(v); out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z; }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(out, 3));
    const uv = src.attributes.uv as THREE.BufferAttribute | undefined;
    if (uv) { const u = new Float32Array(uv.count * 2); for (let i = 0; i < uv.count; i++) { u[i * 2] = uv.getX(i); u[i * 2 + 1] = uv.getY(i); } geo.setAttribute('uv', new THREE.BufferAttribute(u, 2)); }
    if (src.index) geo.setIndex(src.index.clone());
    for (const gr of src.groups) geo.addGroup(gr.start, gr.count, gr.materialIndex);
    geo.computeVertexNormals();
    const c = new THREE.Mesh(geo, mat ?? m.material);
    c.name = m.name + '_fit';
    c.castShadow = m.castShadow;
    g.add(c);
  });
  return g;
}
