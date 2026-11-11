import { OUT, type AssistToggles, type CarInfo, type Damage, type LapInfo } from './physics/core';

const $ = (id: string) => document.getElementById(id)!;
const NS = 'http://www.w3.org/2000/svg';

// Dial geometry: 270 degree sweep, 0 km/h at the lower left, 320 km/h at the lower right.
const MAX_KMH = 320, A0 = -225, SWEEP = 270, CX = 120, CY = 120;
const ang = (f: number) => ((A0 + SWEEP * f) * Math.PI) / 180;
const at = (f: number, r: number) => [CX + Math.cos(ang(f)) * r, CY + Math.sin(ang(f)) * r] as const;
function arc(f0: number, f1: number, r: number) {
  const [x0, y0] = at(f0, r), [x1, y1] = at(f1, r);
  return `M ${x0} ${y0} A ${r} ${r} 0 ${SWEEP * (f1 - f0) > 180 ? 1 : 0} 1 ${x1} ${y1}`;
}

// Warning lamps: flame (engine fire) and the ISO brake symbol, (!) in a circle with side arcs.
const ICON_FIRE = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c1 4 5 6 5 11a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5 0 2 1 3 2 3 0-3-1-6 1-9.5z"/></svg>';
const ICON_BRAKE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="6.5"/><path d="M4.5 6.5a9 9 0 0 0 0 11M19.5 6.5a9 9 0 0 1 0 11M12 8.5v4.5M12 15.6v.1"/></svg>';

export function formatLap(t: number) {
  if (!(t > 0)) return '—';
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

export class Hud {
  private frames: number[] = [];
  private last = 0;
  private needle = 0;            // smoothed needle position, km/h
  private rev = 0;
  private lapsSeen = 0;
  private toastTimer = 0;
  private warnHtml = '';
  private assistHtml = '';
  extra = '';
  /** Race mode: lap count shown as 'n / total' (0 = free run, counted forever). */
  lapTotal = 0;
  /** R repairs (false in a full-realism race: a wreck is out) */
  canRecover = true;
  /** full realism: 'ROLLED OVER · OUT IN 3 s' etc. ('' none) */
  outWarn = '';
  /** the simulation is held while the street under the car is still loading (slow phones, slow networks) */
  holdWarn = '';
  fps = 60;
  /** the frame cap in fps (0 = uncapped), so a 33 ms interval reads as the cap working, not as a slow frame */
  cap = 0;
  /** draw calls and texture VRAM of the frame, set by main once a second */
  stats: { calls: number; textureMB: number; noMips: number } | null = null;
  /** the largest frame interval of the last second: logged, not shown (one hitch is not the frame time) */
  lastMax = 0;
  private el = { needle: $('needle'), rev: $('revfill') };
  private needleKey = '';
  private revKey = -1;

  constructor() {
    const ticks = $('ticks');
    for (let v = 0; v <= MAX_KMH; v += 10) {
      const f = v / MAX_KMH, major = v % 40 === 0;
      const [x0, y0] = at(f, major ? 88 : 93), [x1, y1] = at(f, 100);
      const l = document.createElementNS(NS, 'line');
      l.setAttribute('x1', `${x0}`); l.setAttribute('y1', `${y0}`); l.setAttribute('x2', `${x1}`); l.setAttribute('y2', `${y1}`);
      l.setAttribute('class', major ? 'tick major' : 'tick');
      ticks.appendChild(l);
      if (major) {
        const [tx, ty] = at(f, 76);
        const t = document.createElementNS(NS, 'text');
        t.setAttribute('x', `${tx}`); t.setAttribute('y', `${ty}`); t.setAttribute('class', 'lbl');
        t.textContent = String(v);
        ticks.appendChild(t);
      }
    }
    $('revtrack').setAttribute('d', arc(0, 1, 110));
  }

  show() { ($('hud') as HTMLElement).hidden = false; document.getElementById('loading')?.remove(); this.resetFps(); }
  hide() { ($('hud') as HTMLElement).hidden = true; }
  get visible() { return !($('hud') as HTMLElement).hidden; }
  toggle() { const h = $('hud') as HTMLElement; h.hidden = !h.hidden; }
  resetFps() { this.frames.length = 0; }

  /** Every frame: the dial animates at frame rate; text updates at 10 Hz. */
  /** A frame was actually drawn (the fps readout counts these, not display refreshes: the 30 fps cap skips some). */
  rendered(now: number) { if (this.visible) this.frames.push(now); }

  update(now: number, dt: number, out: Float64Array, info: CarInfo, assists: AssistToggles, dmg: Damage | null, lap: LapInfo | null) {
    while (this.frames.length && this.frames[0] < now - 1000) this.frames.shift();

    // dial: the needle eases toward the true speed (critically damped feel, no ticking)
    const kmh = Math.abs(out[OUT.speed]) * 3.6;
    this.needle += (kmh - this.needle) * (1 - Math.exp(-dt * 14));
    this.rev += (Math.min(1, out[OUT.rpm] / info.redline) - this.rev) * (1 - Math.exp(-dt * 20));
    // DOM writes only when the drawn value changes (0.1 px needle, 0.1 % rev ring): an SVG
    // attribute write invalidates style + paint even when the value is the same, every frame.
    const f = Math.min(1, this.needle / MAX_KMH);
    const [nx, ny] = at(f, 86);
    const nk = `${nx.toFixed(1)} ${ny.toFixed(1)}`;
    if (nk !== this.needleKey) {
      this.needleKey = nk;
      this.el.needle.setAttribute('x2', nx.toFixed(1));
      this.el.needle.setAttribute('y2', ny.toFixed(1));
    }
    const rk = this.rev > 0.002 ? Math.round(this.rev * 1000) : 0;
    if (rk !== this.revKey) {
      this.revKey = rk;
      this.el.rev.setAttribute('d', rk ? arc(0, rk / 1000, 110) : '');
      this.el.rev.classList.toggle('red', this.rev > 0.92);
    }

    if (lap) this.updateLaps(lap, dt);

    if (now - this.last < 100) return;   // DOM text at 10 Hz
    this.last = now;
    const n = this.frames.length;
    const span = n > 1 ? this.frames[n - 1] - this.frames[0] : 0;
    const fps = (this.fps = span >= 850 ? n : span > 10 ? Math.round(((n - 1) * 1000) / span) : 30);
    // Frame intervals over the last second: the median is the pace the player sees, p95 is the jitter. The old readout
    // showed the maximum only ("worst 128 ms"), so one shader compile or texture upload made a healthy 30 fps game
    // look like it ran at 128 ms; the maximum is logged (lastMax) instead of displayed.
    const gaps: number[] = [];
    for (let i = 1; i < n; i++) gaps.push(this.frames[i] - this.frames[i - 1]);
    gaps.sort((a, b) => a - b);
    const med = gaps.length ? gaps[gaps.length >> 1] : 0;
    const p95 = gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * 0.95))] : 0;
    this.lastMax = gaps.length ? gaps[gaps.length - 1] : 0;
    const cap = this.cap ? ` (cap ${this.cap})` : '';
    const st = this.stats ? ` · ${this.stats.calls} calls · ${this.stats.textureMB} MB tex${this.stats.noMips ? ` · ${this.stats.noMips} NO MIPS` : ''}` : '';
    this.text('perf', `${fps} fps${cap} · ${med.toFixed(0)} ms · p95 ${p95.toFixed(0)}${st}\n${this.extra}`);
    this.text('speed', Math.round(kmh).toString());
    const g = out[OUT.gear];
    this.text('gear', g === 0 ? 'R' : g === 1 ? 'N' : String(g - 1));
    const on = (n: string, v: boolean, act = false) => (v ? `<b>${act ? '● ' : ''}${n}</b>` : n);
    const assistHtml = [
      on('ABS', assists.abs, out[OUT.abs] > 0), on('TC', assists.tc, out[OUT.tc] > 0.01),
      on('ESC', assists.esc, out[OUT.esc] !== 0), on('AUTO', assists.autoGearbox),
    ].join(' · ');
    if (assistHtml !== this.assistHtml) $('assists').innerHTML = this.assistHtml = assistHtml;
    this.updateWarnings(dmg, out);
    const el = $('damage');
    if (!dmg || dmg.totalKj < 1) { el.textContent = ''; return; }
    const pct = (x: number) => Math.round(Math.min(1, x) * 100);
    el.classList.toggle('bad', dmg.totaled);
    el.textContent = dmg.totaled
      ? (this.canRecover ? 'WRECKED · limping · R repairs' : 'WRECKED')
      : `DAMAGE  body ${pct(Math.max(...dmg.zone))}%  engine ${pct(dmg.engine)}%  wheels ${pct(Math.max(...dmg.wheel))}%`;
  }

  /** Fire and brake lamps (DOM rebuilt only when the text changes). */
  private updateWarnings(dmg: Damage | null, out?: Float64Array) {
    const chips: string[] = [];
    // hot brakes (thermal fade, core brake model): the hottest disc and what the pads have left
    if (out) {
      let t = 0, mu = 1;
      for (let i = 0; i < 4; i++) { t = Math.max(t, out[OUT.brakeTemp(i)]); mu = Math.min(mu, out[OUT.padMu(i)]); }
      if (t > 720 && !(dmg && (dmg.brakesFailed || dmg.brakes < 0.97))) chips.push(`<div class="chip ${mu < 0.75 ? 'red' : ''}">${ICON_BRAKE}BRAKES ${mu < 0.95 ? 'FADING' : 'HOT'} ${Math.round(t / 10) * 10}°C</div>`);
    }
    if (this.outWarn) chips.push(`<div class="chip">${this.outWarn}</div>`);
    if (this.holdWarn) chips.push(`<div class="chip">${this.holdWarn}</div>`);
    if (dmg) {
      if (dmg.fire > 0) chips.push(`<div class="chip red">${ICON_FIRE}ENGINE FIRE</div>`);
      else if (dmg.smoulder > 0) chips.push(`<div class="chip">${ICON_FIRE}ENGINE OVERHEATING</div>`);
      if (dmg.wheel.some((w) => w >= 0.95)) chips.push(`<div class="chip red">WHEEL LOST</div>`);
      if (dmg.brakesFailed) chips.push(`<div class="chip red">${ICON_BRAKE}NO BRAKES</div>`);
      else if (dmg.brakes < 0.97) chips.push(`<div class="chip">${ICON_BRAKE}BRAKES FADING ${Math.round(dmg.brakes * 100)}%</div>`);
    }
    const html = chips.join('');
    if (html !== this.warnHtml) $('warn').innerHTML = this.warnHtml = html;
  }

  private updateLaps(lap: LapInfo, dt: number) {
    this.text('lapno', this.lapTotal ? `${Math.min(lap.laps + 1, this.lapTotal)} / ${this.lapTotal}` : String(lap.laps + 1));
    this.text('lapcur', formatLap(lap.current) === '—' ? '0:00.000' : formatLap(lap.current));
    this.text('laplast', formatLap(lap.last));
    this.text('lapbest', formatLap(lap.best));
    if (lap.laps > this.lapsSeen) {          // a lap just finished: fade a card in, then out
      this.lapsSeen = lap.laps;
      const best = lap.last > 0 && Math.abs(lap.last - lap.best) < 1e-6;
      const t = $('toast');
      t.innerHTML = `LAP ${lap.laps}${best ? ' · <span class="best">BEST</span>' : ''}<b>${formatLap(lap.last)}</b>`;
      t.classList.add('show');
      this.toastTimer = 3;
    }
    if (this.toastTimer > 0 && (this.toastTimer -= dt) <= 0) $('toast').classList.remove('show');
  }

  /** textContent only when it changed (a same-value write still replaces the text node). */
  private texts = new Map<string, string>();
  private text(id: string, v: string) {
    if (this.texts.get(id) !== v) { this.texts.set(id, v); $(id).textContent = v; }
  }

  resetLaps() { this.lapsSeen = 0; this.toastTimer = 0; $('toast').classList.remove('show'); this.board(null); }

  private boardHtml = '';
  /**
   * Race position and the running order (null hides both: free roam). rows: names in order, with the
   * gap to the car in front ('' for the leader), `you` marks the player.
   */
  board(rows: { name: string; gap: string; you: boolean }[] | null) {
    const pos = $('lappos-row') as HTMLElement, el = $('board') as HTMLElement;
    pos.hidden = el.hidden = !rows;
    if (!rows) { this.boardHtml = ''; return; }
    const me = rows.findIndex((r) => r.you) + 1;
    this.text('lappos', `${me} / ${rows.length}`);
    const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const html = rows.map((r, i) => `<div class="b ${r.you ? 'you' : ''}"><i>${i + 1}</i><span>${esc(r.name)}</span><em>${r.gap}</em></div>`).join('');
    if (html !== this.boardHtml) el.innerHTML = this.boardHtml = html;
  }
}
