// Front end: title screen, garage, pause, results, countdown. Plain DOM over the live 3D scene
// (the canvas keeps rendering behind it: the car on the start line is the backdrop). main.ts owns
// the state machine; this file draws and reports choices through callbacks.
import { FINISHES, MODS, MOD_KEYS, SWATCHES, applyMods, modsOf, paintOf, saveSelection, statsOf,
  type CatalogCar, type Finish, type Mode, type ModKey, type Selection } from './garage';
import { formatLap } from './hud';
import { probeServer } from './net';

export type Gfx = 'auto' | 'max' | 'ultra' | 'high' | 'medium' | 'low';
export type Screen = 'none' | 'title' | 'garage' | 'pause' | 'results' | 'busy';
export interface ResultData { total: number; best: number; laps: number[]; laps_target: number }

export interface MenuHooks {
  /** a visual choice changed (car, paint, finish): main updates the preview */
  preview(): void;
  go(): void;
  gfx(g: Gfx): void;
  resume(): void;
  restart(): void;
  garage(): void;
  /** title buttons: benchmark (about a minute) / soak test (several minutes) */
  bench(soak: boolean): void;
  /** the shown screen changed (title <-> garage move the camera) */
  screen(s: Screen): void;
  /** garage camera preset */
  cam?(az: number, el: number, dist: number): void;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const bar = (f: number) => `<i style="width:${Math.round(Math.max(0, Math.min(1, f)) * 100)}%"></i>`;

export class Menu {
  private root = document.getElementById('menu')!;
  screen: Screen = 'none';
  /** graphics tuning in progress: the title shows a cover instead of the live scene */
  tuning = false;
  gfx: Gfx = 'auto';
  gfxNote = '';
  private serverNote = '';
  private busyText = '';

  constructor(readonly sel: Selection, private cars: CatalogCar[], private physics: Record<string, unknown>, private hooks: MenuHooks) {
    this.root.addEventListener('click', (e) => this.click(e));
    this.root.addEventListener('input', (e) => this.input(e));
    this.root.addEventListener('change', (e) => this.change(e));
  }

  show(s: Screen, busyText = '') {
    this.screen = s;
    this.busyText = busyText;
    this.root.hidden = s === 'none';
    this.root.dataset.screen = s;
    this.render();
    this.hooks.screen(s);
  }

  setTuning(on: boolean, note = '') {
    this.tuning = on;
    this.gfxNote = note;
    if (this.screen === 'title') this.render();
  }

  /** Big number (3, 2, 1, GO) over the scene; '' hides it. */
  countdown(text: string) {
    const el = document.getElementById('countdown')!;
    el.textContent = text;
    el.classList.toggle('show', !!text);
    if (text) { el.style.animation = 'none'; void el.offsetWidth; el.style.animation = ''; }
  }

  private car() { return this.cars.find((c) => c.id === this.sel.car)!; }
  private save() { saveSelection(this.sel); }

  render() {
    const leftScroll = this.root.querySelector('.g-left')?.scrollTop ?? 0;
    const rightScroll = this.root.querySelector('.g-right')?.scrollTop ?? 0;
    const html = { none: () => '', title: () => this.title(), garage: () => this.garage(), pause: () => this.pause(),
      results: () => '', busy: () => `<div class="card center"><div class="spin"></div><p>${esc(this.busyText)}</p></div>` }[this.screen]();
    this.root.innerHTML = html;
    if (this.screen === 'garage') {
      const l = this.root.querySelector('.g-left'), r = this.root.querySelector('.g-right');
      if (l && leftScroll) l.scrollTop = leftScroll;
      if (r && rightScroll) r.scrollTop = rightScroll;
    }
  }
  showResults(r: ResultData) {
    this.screen = 'results';
    this.root.hidden = false;
    this.root.dataset.screen = 'results';
    const rows = r.laps.map((t, i) => `<div class="row"><span>LAP ${i + 1}</span><b class="${t === r.best ? 'best' : ''}">${formatLap(t)}</b></div>`).join('');
    this.root.innerHTML = `<div class="card center results-card">
      <div class="kicker">SESSION TELEMETRY</div>
      <h2>Race Complete</h2>
      <div class="big">${formatLap(r.total)}</div>
      <div class="dim">${r.laps_target} lap${r.laps_target > 1 ? 's' : ''} · Best lap <b class="best-inline">${formatLap(r.best)}</b></div>
      <div class="rows">${rows}</div>
      <div class="btns">
        <button class="primary" data-act="restart">↻ Race Again</button>
        <button data-act="garage">← Back to Garage</button>
      </div>
    </div>`;
  }

  // ---- screens ---------------------------------------------------------------------------------
  private title() {
    const g = (k: Gfx, label: string) => `<button class="chip ${this.gfx === k ? 'on' : ''}" data-act="gfx" data-v="${k}">${label}</button>`;
    const curCar = this.car();
    return `${this.tuning ? '<div class="cover"><div class="card center"><div class="spin"></div><p>Calibrating WebGPU pipeline…</p><span class="dim">Optimizing resolution &amp; reflections for this display.</span></div></div>' : ''}
      <div class="title">
        <div class="kicker">WEBGPU MOTORSPORT SIM // PACEJKA MF 6.1</div>
        <div class="logo">NIGHT<span>RUN</span></div>
        <div class="sub">Midnight street circuit · Active vehicle: <b>${esc(curCar.name)}</b></div>
        <div class="btnrow">
          <button class="primary huge" data-act="go" ${this.tuning ? 'disabled' : ''}>▶ Drive Now</button>
          <button class="huge" data-act="start" ${this.tuning ? 'disabled' : ''}>⚙ Garage &amp; Tuning</button>
        </div>
        <div class="gfx-panel">
          <div class="gfx"><span class="dim">GRAPHICS</span>${g('auto', 'Auto')}${g('max', 'Max')}${g('ultra', 'Ultra')}${g('high', 'High')}${g('medium', 'Medium')}${g('low', 'Low')}</div>
          <div class="dim note">${esc(this.gfxNote || 'WebGPU Clustered Forward+ · 240 Hz Physics')}</div>
        </div>
        <div class="btnrow util-row">
          <button class="small" data-act="bench" ${this.tuning ? 'disabled' : ''}>⏱ Benchmark</button>
          <button class="small" data-act="soak" ${this.tuning ? 'disabled' : ''}>🔥 Soak Test</button>
        </div>
      </div>`;
  }

  private garage() {
    const sel = this.sel;
    const cards = this.cars.map((c) => {
      const st = statsOf(this.physics[c.id]);
      return `<button class="car ${c.id === sel.car ? 'on' : ''}" data-act="car" data-v="${c.id}">
        <div class="car-head"><b>${esc(c.name)}</b><i class="car-badge">${c.id === sel.car ? 'SELECTED' : 'SELECT'}</i></div>
        <span>${esc(c.tag)}</span>
        <div class="mini"><em>${Math.round(st.power)} kW</em><em>${Math.round(st.mass)} kg</em><em>${st.grip.toFixed(2)} µ</em></div>
      </button>`;
    }).join('');
    const paint = paintOf(sel, this.cars).toLowerCase();
    const sw = SWATCHES.map((c) => `<button class="sw ${c === paint ? 'on' : ''}" style="background:${c}" data-act="paint" data-v="${c}" aria-label="${c}"></button>`).join('');
    const fin = (Object.keys(FINISHES) as Finish[]).map((f) => `<button class="chip ${sel.finish === f ? 'on' : ''}" data-act="finish" data-v="${f}">${FINISHES[f].label}</button>`).join('');
    const mods = modsOf(sel);
    const rows = MOD_KEYS.map((k) => {
      const m = MODS[k];
      const pips = m.levels.map((l, i) => `<button class="pip ${i <= mods[k] && mods[k] > 0 ? 'on' : ''} ${i === mods[k] ? 'cur' : ''}" data-act="mod" data-k="${k}" data-v="${i}" title="${l}">${i === 0 ? 'STK' : 'S' + i}</button>`).join('');
      return `<div class="mod"><div><b>${m.label}</b><span class="dim">${m.levels[mods[k]]}</span></div><div class="pips">${pips}</div><small class="dim">${m.hint}</small></div>`;
    }).join('');
    const base = statsOf(this.physics[sel.car] as never), now = statsOf(applyMods(this.physics[sel.car], mods));
    const stat = (label: string, _v: number, text: string, ref: number, f: number) =>
      `<div class="stat"><span>${label}</span><div class="bar">${bar(f)}${ref >= 0 ? `<u style="left:${Math.round(ref * 100)}%"></u>` : ''}</div><b>${text}</b></div>`;
    const stats = [
      stat('Power', now.power, `${Math.round(now.power)} kW`, base.power / 480, now.power / 480),
      stat('Grip', now.grip, now.grip.toFixed(2) + ' µ', (base.grip - 1) / 0.7, (now.grip - 1) / 0.7),
      stat('Light', 0, `${Math.round(now.mass)} kg`, (1700 - base.mass) / 500, (1700 - now.mass) / 500),
      stat('Downforce', now.downforce, `${now.downforce.toFixed(2)} m²`, base.downforce / 1.2, now.downforce / 1.2),
      stat('Power/wt', now.ratio, `${Math.round(now.ratio)} W/kg`, base.ratio / 400, now.ratio / 400),
    ].join('');
    const modeBtn = (m: Mode, label: string, sub: string) => `<button class="mode ${sel.mode === m ? 'on' : ''}" data-act="mode" data-v="${m}"><b>${label}</b><span>${sub}</span></button>`;
    const laps = [1, 3, 5, 10].map((n) => `<button class="chip ${sel.laps === n ? 'on' : ''}" data-act="laps" data-v="${n}">${n}</button>`).join('');
    const opts = sel.mode === 'race' ? `<div class="opts"><span class="dim">LAPS</span>${laps}</div>`
      : sel.mode === 'online' ? `<div class="opts"><span class="dim">SERVER</span><input id="server" type="text" value="${esc(sel.server)}" spellcheck="false" autocomplete="off" />
        <button class="chip" data-act="probe">Check</button><span id="servernote" class="dim">${esc(this.serverNote)}</span></div>`
      : '<div class="opts"><span class="dim">Open midnight street circuit · Unlimited timed laps &amp; telemetry</span></div>';
    const go = { free: '▶ Launch Free Run', race: `▶ Start Race · ${sel.laps} Lap${sel.laps > 1 ? 's' : ''}`, online: '▶ Join Online Grid' }[sel.mode];
    return `<div class="garage">
      <div class="g-top">
        <button data-act="back" class="back-btn">← Title</button>
        <div class="g-title">GARAGE <span>// PADDOCK</span></div>
        <div class="g-cams">
          <button class="chip" data-act="cam" data-v="2.3,0.17,6.5">3/4 View</button>
          <button class="chip" data-act="cam" data-v="1.57,0.08,6.4">Side</button>
          <button class="chip" data-act="cam" data-v="0,0.15,6.0">Rear</button>
          <button class="chip" data-act="cam" data-v="3.14,0.14,6.0">Front</button>
        </div>
      </div>
      <div class="g-left panel"><h3>Vehicles (${this.cars.length})</h3>${cards}</div>
      <div class="g-right panel">
        <h3>Paint &amp; Finish</h3>
        <div class="sws">${sw}<label class="sw custom" title="Custom colour"><input id="custom" type="color" value="${paint}" /></label></div>
        <div class="chips">${fin}</div>
        <h3>Performance Upgrades</h3>${rows}
        <h3>Telemetry Specs <small class="dim">(red marker = stock)</small></h3>${stats}
      </div>
      <div class="g-bottom">
        <div class="modes">${modeBtn('free', 'Free Run', 'Open circuit')}${modeBtn('race', 'Race', 'Timed laps')}${modeBtn('online', 'Online', 'Multiplayer')}</div>
        ${opts}
        <button class="primary huge go" data-act="go">${go}</button>
      </div>
    </div>`;
  }

  private pause() {
    return `<div class="card center pause-card">
      <div class="kicker">SESSION PAUSED</div>
      <h2>Race Paused</h2>
      <div class="btns col">
        <button class="primary" data-act="resume">▶ Resume Driving</button>
        <button data-act="restart">↻ Restart Session</button>
        <button data-act="garage">← Leave Race &amp; Go to Garage</button>
      </div>
    </div>`;
  }

  // ---- events ----------------------------------------------------------------------------------
  /** Fullscreen needs a user gesture, so the first menu click asks for it (once per page; ?fs=0 turns it off, F toggles later). */
  private fsAsked = false;
  private askFullscreen() {
    if (this.fsAsked || document.fullscreenElement || new URLSearchParams(location.search).get('fs') === '0') return;
    this.fsAsked = true;
    document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).then(() => {
      (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape').catch(() => {});
    }).catch(() => { /* refused (iframe, policy): stay windowed */ });
  }

  private click(e: Event) {
    const b = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (!b || (b as HTMLButtonElement).disabled) return;
    if (b.dataset.act === 'go' || b.dataset.act === 'start') this.askFullscreen();
    const v = b.dataset.v ?? '', sel = this.sel;
    switch (b.dataset.act) {
      case 'start': this.show('garage'); this.hooks.preview(); break;
      case 'back': this.show('title'); break;
      case 'gfx': this.gfx = v as Gfx; this.hooks.gfx(this.gfx); this.render(); break;
      case 'car': sel.car = v; this.save(); this.render(); this.hooks.preview(); break;
      case 'paint': sel.paint[sel.car] = v; this.save(); this.render(); this.hooks.preview(); break;
      case 'finish': sel.finish = v as Finish; this.save(); this.render(); this.hooks.preview(); break;
      case 'mod': { const m = { ...modsOf(sel) }; m[b.dataset.k as ModKey] = Number(v); sel.mods[sel.car] = m; this.save(); this.render(); break; }
      case 'mode': sel.mode = v as Mode; this.save(); this.render(); break;
      case 'laps': sel.laps = Number(v); this.save(); this.render(); break;
      case 'probe': this.probe(); break;
      case 'go': this.hooks.go(); break;
      case 'resume': this.hooks.resume(); break;
      case 'restart': this.hooks.restart(); break;
      case 'garage': this.hooks.garage(); break;
      case 'bench': this.hooks.bench(false); break;
      case 'soak': this.hooks.bench(true); break;
      case 'cam': {
        const [az, el, dist] = v.split(',').map(Number);
        this.hooks.cam?.(az, el, dist);
        break;
      }
    }
  }
  private input(e: Event) {
    const t = e.target as HTMLInputElement;
    if (t.id === 'custom') { this.sel.paint[this.sel.car] = t.value; this.hooks.preview(); }   // live while dragging
    if (t.id === 'server') { this.sel.server = t.value.trim(); }
  }
  private change(e: Event) {
    const t = e.target as HTMLInputElement;
    if (t.id === 'custom' || t.id === 'server') { this.save(); if (t.id === 'custom') this.render(); }
  }
  private async probe() {
    const note = document.getElementById('servernote');
    this.serverNote = 'checking…';
    if (note) note.textContent = this.serverNote;
    const url = this.sel.server;
    const r = /^wss?:\/\//.test(url) ? await probeServer(url) : null;
    this.serverNote = r ? `reachable · ${r.players} player${r.players === 1 ? '' : 's'} driving` : 'cannot reach that server';
    const n = document.getElementById('servernote');
    if (n) { n.textContent = this.serverNote; n.classList.toggle('bad', !r); }
  }
}
