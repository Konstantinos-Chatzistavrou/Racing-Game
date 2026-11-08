// GPS minimap: the real streets (the tiles' road graphs) heading-up around the car, zooming out with speed; the race
// route as the GPS line with the next stretch highlighted; rivals as dots; and a turn-by-turn banner ("↰ 7th Avenue ·
// 250 m") from the route's corners and the street names in the graph. A 2D canvas redrawn ~15 times a second from a
// spatial grid of road segments (a few hundred lines per frame).
// Frames: road graph and route = game frame (x east, y north); three.js = (x, y up, z = -y_game).

interface Seg { x0: number; y0: number; x1: number; y1: number; w: number; major: boolean }
interface Turn { s: number; dir: -1 | 1; sharp: boolean; name: string }
export interface Blip { x: number; z: number; color: string }

const CELL = 100;

export class Minimap {
  readonly el = document.createElement('div');
  private cv = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private banner = document.createElement('div');
  private grid = new Map<string, Seg[]>();
  private named: { x: number; y: number; name: string }[] = [];
  private route: { x: number; y: number }[] = [];
  private routeS: number[] = [];
  private routeLen = 0;
  private turns: Turn[] = [];
  private last = 0;
  private zoom = 1.6;   // m per css px
  visible = true;

  constructor(parent: HTMLElement) {
    this.el.id = 'minimap';
    this.banner.className = 'gps-turn';
    this.el.append(this.banner, this.cv);
    parent.appendChild(this.el);
    this.ctx = this.cv.getContext('2d')!;
  }

  /** Road edges of one tile's graph (game frame). */
  addGraph(g: { nodes: number[][]; edges: { a: number; b: number; w: number; hw: string; name?: string; pts?: number[][] }[] }) {
    for (const e of g.edges) {
      const pts = e.pts ?? [g.nodes[e.a], g.nodes[e.b]];
      const major = ['primary', 'secondary', 'trunk', 'motorway'].includes(e.hw);
      for (let i = 0; i + 1 < pts.length; i++) {
        const s: Seg = { x0: pts[i][0], y0: pts[i][1], x1: pts[i + 1][0], y1: pts[i + 1][1], w: e.w, major };
        const k = `${Math.floor((s.x0 + s.x1) / 2 / CELL)}_${Math.floor((s.y0 + s.y1) / 2 / CELL)}`;
        (this.grid.get(k) ?? this.grid.set(k, []).get(k)!).push(s);
        if (e.name) this.named.push({ x: (s.x0 + s.x1) / 2, y: (s.y0 + s.y1) / 2, name: e.name });
      }
    }
    this.turns = [];   // street names may now be known: recompute
  }

  /** The race route (game frame samples; closed loop). */
  setRoute(samples: { x: number; y: number }[]) {
    this.route = samples.map((p) => ({ x: p.x, y: p.y }));
    this.routeS = []; let acc = 0;
    for (let i = 0; i < this.route.length; i++) {
      this.routeS.push(acc);
      const a = this.route[i], b = this.route[(i + 1) % this.route.length];
      acc += Math.hypot(b.x - a.x, b.y - a.y);
    }
    this.routeLen = acc;
    this.turns = [];
  }

  private streetAt(x: number, y: number) {
    let best = '', bd = 30 * 30;
    for (const n of this.named) { const d = (n.x - x) ** 2 + (n.y - y) ** 2; if (d < bd) { bd = d; best = n.name; } }
    return best;
  }

  /** Corners of the route: heading change of more than 40 deg over ~30 m; the street the route turns into. */
  private findTurns() {
    const R = this.route, n = R.length;
    if (n < 4) return;
    const head = (i: number) => { const a = R[(i + n) % n], b = R[(i + 1 + n) % n]; return Math.atan2(b.y - a.y, b.x - a.x); };
    let i = 0;
    while (i < n) {
      let d = head(i + 4) - head(i - 1);
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      if (Math.abs(d) > 0.7) {
        const after = R[(i + 8) % n];
        this.turns.push({ s: this.routeS[(i + 1) % n], dir: d > 0 ? -1 : 1, sharp: Math.abs(d) > 2.6, name: this.streetAt(after.x, after.y) });   // sharp: hairpins only (> 150 deg)
        i += 8;
      } else i++;
    }
  }

  private routeAt(s: number) {
    s = ((s % this.routeLen) + this.routeLen) % this.routeLen;
    let lo = 0, hi = this.routeS.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.routeS[m] <= s) lo = m; else hi = m; }
    const a = this.route[lo], b = this.route[(lo + 1) % this.route.length], l = (this.routeS[lo + 1] ?? this.routeLen) - this.routeS[lo];
    const t = l > 0 ? (s - this.routeS[lo]) / l : 0;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }

  /**
   * Every frame (drawn at ~15 Hz). car: three.js position; fwd: the car's forward unit vector (three.js x, z);
   * speed m/s; routeS: distance along the route (null: not on the route); others: rivals / players.
   */
  update(now: number, car: { x: number; z: number }, fwd: { x: number; z: number }, speed: number, routeS: number | null, others: Blip[]) {
    if (!this.visible || now - this.last < 66) return;
    this.last = now;
    if (!this.turns.length && this.route.length) this.findTurns();
    const dpr = Math.min(2, devicePixelRatio || 1), size = this.el.clientWidth || 180;
    if (this.cv.width !== Math.round(size * dpr)) { this.cv.width = this.cv.height = Math.round(size * dpr); }
    const c = this.ctx, r = size / 2;
    const cx = car.x, cy = -car.z, hx = fwd.x, hy = -fwd.z;           // game frame
    const theta = Math.atan2(hy, hx);
    this.zoom += (Math.min(3.2, 1.3 + speed * 0.035) - this.zoom) * 0.15;   // zoom out at speed
    const k = 1 / this.zoom;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, size, size);
    c.save();
    c.beginPath(); c.arc(r, r, r - 1, 0, Math.PI * 2); c.clip();
    c.fillStyle = 'rgba(6, 9, 15, 0.82)'; c.fillRect(0, 0, size, size);
    // world -> canvas: translate to the car, rotate so the car points up, scale, flip y
    c.translate(r, r * 1.18);
    c.scale(k, -k);
    c.rotate(Math.PI / 2 - theta);
    c.translate(-cx, -cy);
    const reach = (r * 1.7) * this.zoom, c0x = Math.floor((cx - reach) / CELL), c1x = Math.floor((cx + reach) / CELL);
    const c0y = Math.floor((cy - reach) / CELL), c1y = Math.floor((cy + reach) / CELL);
    c.lineCap = 'round'; c.lineJoin = 'round';
    for (const major of [false, true]) {
      c.strokeStyle = major ? 'rgba(150, 160, 180, 0.55)' : 'rgba(120, 130, 150, 0.38)';
      for (let gx = c0x; gx <= c1x; gx++) for (let gy = c0y; gy <= c1y; gy++) {
        const list = this.grid.get(`${gx}_${gy}`);
        if (!list) continue;
        for (const s of list) {
          if (s.major !== major) continue;
          c.lineWidth = Math.max(s.w * 0.8, 3 * this.zoom);
          c.beginPath(); c.moveTo(s.x0, s.y0); c.lineTo(s.x1, s.y1); c.stroke();
        }
      }
    }
    // the GPS line: the whole route faint, the next 600 m bright
    if (this.route.length > 1) {
      c.strokeStyle = 'rgba(255, 45, 85, 0.35)'; c.lineWidth = Math.max(4, 5 * this.zoom);
      c.beginPath(); this.route.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y))); c.closePath(); c.stroke();
      if (routeS !== null) {
        c.strokeStyle = 'rgba(255, 70, 110, 0.95)'; c.lineWidth = Math.max(5, 7 * this.zoom);
        c.shadowColor = 'rgba(255, 45, 85, 0.9)'; c.shadowBlur = 8;
        c.beginPath();
        for (let d = 0; d <= 600; d += 8) { const p = this.routeAt(routeS + d); if (d) c.lineTo(p.x, p.y); else c.moveTo(p.x, p.y); }
        c.stroke(); c.shadowBlur = 0;
      }
      // start / finish
      const s0 = this.route[0];
      c.fillStyle = '#fff'; c.fillRect(s0.x - 4 * this.zoom, s0.y - 4 * this.zoom, 8 * this.zoom, 8 * this.zoom);
      c.fillStyle = '#000'; c.fillRect(s0.x - 4 * this.zoom, s0.y - 4 * this.zoom, 4 * this.zoom, 4 * this.zoom); c.fillRect(s0.x, s0.y, 4 * this.zoom, 4 * this.zoom);
    }
    // rivals / players
    for (const o of others) {
      c.fillStyle = o.color; c.beginPath(); c.arc(o.x, -o.z, 4.2 * this.zoom, 0, Math.PI * 2); c.fill();
      c.strokeStyle = '#000'; c.lineWidth = 1.2 * this.zoom; c.stroke();
    }
    c.restore();
    // the car: arrow at the centre (screen space)
    c.save();
    c.translate(r, r * 1.18);
    c.fillStyle = '#fff'; c.strokeStyle = 'rgba(0,0,0,0.8)'; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(0, -9); c.lineTo(6.5, 7); c.lineTo(0, 3.5); c.lineTo(-6.5, 7); c.closePath(); c.fill(); c.stroke();
    c.restore();
    // north tick
    c.save(); c.translate(r, r); c.rotate(-(Math.PI / 2 - theta)); c.fillStyle = 'rgba(255,255,255,0.7)'; c.font = '700 10px Inter, system-ui, sans-serif';
    c.textAlign = 'center'; c.fillText('N', 0, -r + 13); c.restore();
    // turn-by-turn
    let txt = '';
    if (routeS !== null && this.turns.length) {
      const s = ((routeS % this.routeLen) + this.routeLen) % this.routeLen;
      let next: Turn | null = null, dist = Infinity;
      for (const t of this.turns) { let d = t.s - s; if (d < -5) d += this.routeLen; if (d >= -5 && d < dist) { dist = d; next = t; } }
      if (next && dist < 900) {
        const arrow = next.sharp ? (next.dir < 0 ? '↶' : '↷') : (next.dir < 0 ? '↰' : '↱');
        const esc = (v: string) => v.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
        txt = `<b>${arrow}</b> ${next.name ? `<span>${esc(next.name)}</span>` : (next.dir < 0 ? 'Turn left' : 'Turn right')} <i>${dist < 30 ? 'now' : `${Math.round(dist / 10) * 10} m`}</i>`;
      }
    }
    if (this.banner.innerHTML !== txt) { this.banner.innerHTML = txt; this.banner.hidden = !txt; }
  }

  show(on: boolean) { this.visible = on; this.el.hidden = !on; }
}
