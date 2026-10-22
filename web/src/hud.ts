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
  fps = 60;
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

  show() { ($('hud') as HTMLElement).hidden = false; document.getElementById('loading')?.remove(); }
  hide() { ($('hud') as HTMLElement).hidden = true; }
  get visible() { return !($('hud') as HTMLElement).hidden; }
  toggle() { const h = $('hud') as HTMLElement; h.hidden = !h.hidden; }

  /** Every frame: the dial animates at frame rate; text updates at 10 Hz. */
  /** A frame was actually drawn (the fps readout counts these, not display refreshes: the 30 fps cap skips some). */
  rendered(now: number) { this.frames.push(now); }

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
    const fps = (this.fps = this.frames.length);
    const worst = this.frames.reduce((m, t, i, a) => (i ? Math.max(m, t - a[i - 1]) : m), 0);
    this.text('perf', `${fps} fps   worst ${worst.toFixed(1)} ms\n${this.extra}`);
    this.text('speed', Math.round(kmh).toString());
    const g = out[OUT.gear];
    this.text('gear', g === 0 ? 'R' : g === 1 ? 'N' : String(g - 1));
    const on = (n: string, v: boolean, act = false) => (v ? `<b>${act ? '● ' : ''}${n}</b>` : n);
    const assistHtml = [
      on('ABS', assists.abs, out[OUT.abs] > 0), on('TC', assists.tc, out[OUT.tc] > 0.01),
      on('ESC', assists.esc, out[OUT.esc] !== 0), on('AUTO', assists.autoGearbox),
    ].join(' · ');
    if (assistHtml !== this.assistHtml) $('assists').innerHTML = this.assistHtml = assistHtml;
    this.updateWarnings(dmg);
    const el = $('damage');
    if (!dmg || dmg.totalKj < 1) { el.textContent = ''; return; }
    const pct = (x: number) => Math.round(Math.min(1, x) * 100);
    el.classList.toggle('bad', dmg.totaled);
    el.textContent = dmg.totaled
      ? 'WRECKED · limping · R repairs'
      : `DAMAGE  body ${pct(Math.max(...dmg.zone))}%  engine ${pct(dmg.engine)}%  wheels ${pct(Math.max(...dmg.wheel))}%`;
  }

  /** Fire and brake lamps (DOM rebuilt only when the text changes). */
  private updateWarnings(dmg: Damage | null) {
    const chips: string[] = [];
    if (dmg) {
      if (dmg.fire > 0) chips.push(`<div class="chip red">${ICON_FIRE}ENGINE FIRE</div>`);
      else if (dmg.smoulder > 0) chips.push(`<div class="chip">${ICON_FIRE}ENGINE OVERHEATING</div>`);
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

  resetLaps() { this.lapsSeen = 0; this.toastTimer = 0; $('toast').classList.remove('show'); }
}
