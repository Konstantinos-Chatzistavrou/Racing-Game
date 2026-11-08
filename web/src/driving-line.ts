// Driving line assist: the AI's smoothed racing line drawn on the road for the next ~180 m, coloured by how hard YOU
// would have to brake from your current speed to make each point at the speed your car can take it:
//   blue    no braking needed          yellow  ease off / brake soon          red  brake now
// "Braking zones" mode shows only the yellow / red parts. The target speeds come from the same profile the rivals
// use (corner limit sqrt(a_lat / curvature), then braking backwards), computed for the player's car.
import * as THREE from 'three';
import { STEP, limitsOf, type AiTraffic } from './ai';
import type { LineMode } from './assists';

const G = 9.81, N = 92, BEHIND = 4, WIDTH = 0.55, LIFT = 0.05;
const BLUE = new THREE.Color(0.25, 0.6, 1), YELLOW = new THREE.Color(1, 0.78, 0.1), RED = new THREE.Color(1, 0.12, 0.08);

export class DrivingLine {
  private mesh: THREE.Mesh;
  private pos = new Float32Array(N * 2 * 3);
  private col = new Float32Array(N * 2 * 3);
  private prof: number[] = [];
  private aBrake = 8;
  private groundY: Float32Array;
  private s = -1;
  private tmp = new THREE.Vector3();
  private c = new THREE.Color();

  constructor(scene: THREE.Scene, private ai: AiTraffic) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    const idx: number[] = [];
    for (let i = 0; i < N - 1; i++) { const a = 2 * i; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    g.setIndex(idx);
    const m = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide, fog: false });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.visible = false;
    this.groundY = new Float32Array(ai.lane.n).fill(NaN);
    scene.add(this.mesh);
  }

  /** The player's car (its grip sets the target speeds). */
  setCar(phys: unknown) {
    const lim = limitsOf(phys);
    this.aBrake = 0.85 * lim.muX * G;
    this.prof = this.ai.lane.profile(0.8 * lim.mu * G, this.aBrake, 75);
  }

  private y(i: number) {
    let y = this.groundY[i];
    if (Number.isNaN(y)) {
      const p = this.ai.lane.pts[i];
      y = this.groundY[i] = this.ai.groundAt(p.x, p.z, p.y + 4, 10) ?? p.y;
    }
    return y;
  }

  /** Arc length of the lane point nearest p: a local search around the last one, the whole lane when lost. */
  private track(p: THREE.Vector3) {
    const lane = this.ai.lane;
    let best = 0, bd = Infinity;
    if (this.s >= 0) {
      for (let d = -24; d <= 40; d += STEP) {
        const s = lane.wrap(this.s + d), q = lane.at(s, 0, this.tmp), dd = (q.x - p.x) ** 2 + (q.z - p.z) ** 2;
        if (dd < bd) { bd = dd; best = s; }
      }
    }
    if (bd > 30 * 30) { best = lane.project(p); const q = lane.at(best, 0, this.tmp); bd = (q.x - p.x) ** 2 + (q.z - p.z) ** 2; }
    this.s = best;
    return bd;
  }

  /** Every frame. mode off / not driving: hidden. */
  update(mode: LineMode, driving: boolean, car: THREE.Vector3, speed: number) {
    if (mode === 'off' || !driving || !this.prof.length) { this.mesh.visible = false; this.s = -1; return; }
    const off = this.track(car);
    if (off > 25 * 25) { this.mesh.visible = false; return; }      // far from the route (free roam): no line
    const lane = this.ai.lane, n = lane.n;
    const i0 = Math.floor(lane.wrap(this.s - BEHIND) / STEP);
    const v = Math.max(0, speed);
    for (let k = 0; k < N; k++) {
      const i = (i0 + k) % n, p = lane.pts[i], r = lane.right[i];
      const d = k * STEP - BEHIND;
      // deceleration needed to be at the profile speed by this point, as a fraction of what the car can do
      const vt = this.prof[i];
      const need = d > 1 ? (v * v - vt * vt) / (2 * d) / this.aBrake : v > vt + 1 ? 1 : 0;
      if (need > 0.8) this.c.copy(RED);
      else if (need > 0.35) this.c.copy(BLUE).lerp(YELLOW, Math.min(1, (need - 0.35) / 0.25)).lerp(RED, Math.max(0, (need - 0.6) / 0.2));
      else this.c.copy(BLUE);
      // width: tapered at both ends; braking-zones mode hides the blue parts
      let w = WIDTH * Math.min(1, (k + 1) / 4, (N - k) / 10);
      if (mode === 'braking') w *= Math.max(0, Math.min(1, (need - 0.3) / 0.1));
      const y = this.y(i) + LIFT;
      const o = k * 6;
      this.pos[o] = p.x - r.x * w / 2; this.pos[o + 1] = y; this.pos[o + 2] = p.z - r.z * w / 2;
      this.pos[o + 3] = p.x + r.x * w / 2; this.pos[o + 4] = y; this.pos[o + 5] = p.z + r.z * w / 2;
      this.col[o] = this.col[o + 3] = this.c.r; this.col[o + 1] = this.col[o + 4] = this.c.g; this.col[o + 2] = this.col[o + 5] = this.c.b;
    }
    const g = this.mesh.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
    this.mesh.visible = true;
  }
}
