// Server-side race timing, a port of core/src/race.cpp + the route projection: progress along the closed route from the
// positions players stream to the room. Distance only accumulates between nearby projections (|ds| <= 40 m per sample);
// a bigger jump (a reset, a teleport, a short cut across blocks) re-acquires the route with ZERO gain.
import nyc from '../../data/tracks/nyc_route.json';
import city from '../../data/tracks/city_route.json';

interface Sample { x: number; y: number; width_left: number; width_right: number }
export class Route {
  readonly s: number[] = [];      // arc length at each sample
  readonly length: number;
  constructor(readonly pts: Sample[]) {
    let acc = 0;
    for (let i = 0; i < pts.length; i++) {
      this.s.push(acc);
      const a = pts[i], b = pts[(i + 1) % pts.length];
      acc += Math.hypot(b.x - a.x, b.y - a.y);
    }
    this.length = acc;
  }
  static named(name: string) { return new Route(((name === 'city' ? city : nyc) as { samples: Sample[] }).samples); }
  /** closest point on the polyline (core coordinates x, y): arc length, lateral distance, segment index */
  project(x: number, y: number, hint = -1): { s: number; lat: number; index: number } {
    const n = this.pts.length;
    let best = { s: 0, lat: Infinity, index: 0 };
    const test = (i: number) => {
      const a = this.pts[i], b = this.pts[(i + 1) % n];
      const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2));
      const px = a.x + dx * t, py = a.y + dy * t, d = Math.hypot(x - px, y - py);
      if (d < best.lat) best = { s: this.s[i] + Math.sqrt(l2) * t, lat: d, index: i };
    };
    if (hint >= 0) for (let k = -25; k <= 25; k++) test((hint + k + n) % n);
    if (hint < 0 || best.lat > 60) for (let i = 0; i < n; i++) test(i);
    return best;
  }
  /**
   * Tracking a moving car (same rule as core Route::project_near): only segments between a little behind lastS and
   * travel x 1.5 + 15 m ahead of it are candidates; the laterally nearest wins. Where the route runs back alongside
   * itself (the NYC U-turn) plain nearest picked the other leg and a car on that side lost 80-190 m a lap.
   */
  projectNear(x: number, y: number, hint: number, lastS: number, travel: number): { s: number; lat: number; index: number } | null {
    const n = this.pts.length, back = Math.min(1, travel * 0.5 + 0.05), ahead = travel * 1.5 + 15;
    let best: { s: number; lat: number; index: number } | null = null;
    for (let k = -60; k <= 60; k++) {
      const i = (hint + k + n * 2) % n, a = this.pts[i], b = this.pts[(i + 1) % n];
      const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2));
      const s = (this.s[i] + Math.sqrt(l2) * t) % this.length, ds = this.delta(lastS, s);
      if (ds < -back || ds > ahead) continue;
      const d = Math.hypot(x - a.x - dx * t, y - a.y - dy * t);
      if (!best || d < best.lat) best = { s, lat: d, index: i };
    }
    return best;
  }
  /** shortest signed distance along the loop from s0 to s1 */
  delta(s0: number, s1: number) {
    let d = s1 - s0;
    if (d > this.length / 2) d -= this.length;
    if (d < -this.length / 2) d += this.length;
    return d;
  }
}

export class Progress {
  distance = 0;            // along the route since the start line (negative on the grid behind it)
  lastS = 0;
  hint = -1;
  private lx: number;
  private ly: number;
  finished = false;
  finishMs = 0;            // server time of crossing the line on the last lap
  constructor(private route: Route, x: number, y: number) {
    const p = route.project(x, y);
    this.hint = p.index; this.lastS = p.s;
    this.distance = route.delta(0, p.s);
    this.lx = x; this.ly = y;
  }
  /** returns the distance gained by this sample (0 when the route had to be re-acquired) */
  update(x: number, y: number, laps: number, nowMs: number, prevMs: number): number {
    if (this.finished) return 0;
    const travel = Math.hypot(x - this.lx, y - this.ly);
    this.lx = x; this.ly = y;
    let p = this.route.projectNear(x, y, this.hint, this.lastS, travel) ?? this.route.project(x, y, this.hint);
    let ds = this.route.delta(this.lastS, p.s);
    if (Math.abs(ds) > 40) { p = this.route.project(x, y); ds = 0; }
    this.hint = p.index; this.lastS = p.s;
    const before = this.distance;
    this.distance += ds;
    const goal = laps * this.route.length;
    if (before < goal && this.distance >= goal) {
      this.finished = true;
      // interpolate the crossing between the two samples (4 Hz stream: up to 250 ms of resolution otherwise)
      const f = ds > 0 ? (goal - before) / ds : 1;
      this.finishMs = prevMs + (nowMs - prevMs) * Math.max(0, Math.min(1, f));
    }
    return ds;
  }
}
