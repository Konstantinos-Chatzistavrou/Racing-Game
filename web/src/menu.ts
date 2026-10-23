// Front end: title screen, garage, pause, results, countdown. Plain DOM over the live 3D scene
// (the canvas keeps rendering behind it: the car on the start line is the backdrop). main.ts owns
// the state machine; this file draws and reports choices through callbacks.
import { FINISHES, MODS, MOD_KEYS, SWATCHES, applyMods, modsOf, noMods, paintOf, saveSelection, statsOf,
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
  /** the shown screen changed (title <-> garage move the camera) */
  screen(s: Screen): void;
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
    const html = { none: () => '', title: () => this.title(), garage: () => this.garage(), pause: () => this.pause(),
      results: () => '', busy: () => `<div class="card center"><div class="spin"></div><p>${esc(this.busyText)}</p></div>` }[this.screen]();
    this.root.innerHTML = html;
  }
  showResults(r: ResultData) {
    this.screen = 'results';
    this.root.hidden = false;
    this.root.dataset.screen = 'results';
    const rows = r.laps.map((t, i) => `<div class="row"><span>Lap ${i + 1}</span><b class="${t === r.best ? 'best' : ''}">${formatLap(t)}</b></div>`).join('');
    this.root.innerHTML = `<div class="card center"><h2>Race complete</h2>
      <div class="big">${formatLap(r.total)}</div><div class="dim">${r.laps_target} lap${r.laps_target > 1 ? 's' : ''} · best ${formatLap(r.best)}</div>
      <div class="rows">${rows}</div>
      <div class="btns"><button class="primary" data-act="restart">Race again</button><button data-act="garage">Garage</button></div></div>`;
  }

  // ---- screens ---------------------------------------------------------------------------------
  private title() {
    const g = (k: Gfx, label: string) => `<button class="chip ${this.gfx === k ? 'on' : ''}" data-act="gfx" data-v="${k}">${label}</button>`;
    return `${this.tuning ? '<div class="cover"><div class="card center"><div class="spin"></div><p>Tuning graphics for this device…</p><span class="dim">A few seconds, once. The picture will flicker.</span></div></div>' : ''}
      <div class="title"><div class="logo">NIGHT<span>RUN</span></div><div class="sub">A night street racing sim in your browser</div>
      <div class="btnrow"><button class="primary huge" data-act="go" ${this.tuning ? 'disabled' : ''}>Play</button>
      <button class="huge" data-act="start" ${this.tuning ? 'disabled' : ''}>Garage</button></div>
      <div class="gfx"><span class="dim">Graphics</span>${g('auto', 'Auto')}${g('max', 'Max')}${g('ultra', 'Ultra')}${g('high', 'High')}${g('medium', 'Medium')}${g('low', 'Low')}</div>
      <div class="dim note">${esc(this.gfxNote)}</div></div>`;
  }

  private garage() {
    const sel = this.sel;
    const cards = this.cars.map((c) => {
      const st = statsOf(applyMods(this.physics[c.id], noMods()));
      return `<button class="car ${c.id === sel.car ? 'on' : ''}" data-act="car" data-v="${c.id}"><b>${esc(c.name)}</b><span>${esc(c.tag)}</span>
        <div class="mini"><em>${Math.round(st.power)} kW</em><em>${Math.round(st.mass)} kg</em><em>${st.grip.toFixed(2)} µ</em></div></button>`;
    }).join('');
    const paint = paintOf(sel, this.cars).toLowerCase();
    const sw = SWATCHES.map((c) => `<button class="sw ${c === paint ? 'on' : ''}" style="background:${c}" data-act="paint" data-v="${c}" aria-label="${c}"></button>`).join('');
    const fin = (Object.keys(FINISHES) as Finish[]).map((f) => `<button class="chip ${sel.finish === f ? 'on' : ''}" data-act="finish" data-v="${f}">${FINISHES[f].label}</button>`).join('');
    const mods = modsOf(sel);
    const rows = MOD_KEYS.map((k) => {
      const m = MODS[k];
      const pips = m.levels.map((l, i) => `<button class="pip ${i <= mods[k] && mods[k] > 0 ? 'on' : ''} ${i === mods[k] ? 'cur' : ''}" data-act="mod" data-k="${k}" data-v="${i}" title="${l}">${i}</button>`).join('');
      return `<div class="mod"><div><b>${m.label}</b><span class="dim">${m.levels[mods[k]]}</span></div><div class="pips">${pips}</div><small class="dim">${m.hint}</small></div>`;
    }).join('');
    const base = statsOf(this.physics[sel.car] as never), now = statsOf(applyMods(this.physics[sel.car], mods));
    const stat = (label: string, v: number, text: string, ref: number, f: number) =>
      `<div class="stat"><span>${label}</span><div class="bar">${bar(f)}${ref >= 0 ? `<u style="left:${Math.round(ref * 100)}%"></u>` : ''}</div><b>${text}</b></div>`;
    const stats = [
      stat('Power', now.power, `${Math.round(now.power)} kW`, base.power / 480, now.power / 480),
      stat('Grip', now.grip, now.grip.toFixed(2) + ' µ', (base.grip - 1) / 0.7, (now.grip - 1) / 0.7),
      stat('Light', 0, `${Math.round(now.mass)} kg`, (1700 - base.mass) / 500, (1700 - now.mass) / 500),
      stat('Downforce', now.downforce, `${now.downforce.toFixed(2)} m²`, base.downforce / 1.2, now.downforce / 1.2),
      stat('Power/weight', now.ratio, `${Math.round(now.ratio)} W/kg`, base.ratio / 400, now.ratio / 400),
    ].join('');
    const modeBtn = (m: Mode, label: string, sub: string) => `<button class="mode ${sel.mode === m ? 'on' : ''}" data-act="mode" data-v="${m}"><b>${label}</b><span>${sub}</span></button>`;
    const laps = [1, 3, 5, 10].map((n) => `<button class="chip ${sel.laps === n ? 'on' : ''}" data-act="laps" data-v="${n}">${n}</button>`).join('');
    const opts = sel.mode === 'race' ? `<div class="opts"><span class="dim">Laps</span>${laps}</div>`
      : sel.mode === 'online' ? `<div class="opts"><span class="dim">Server</span><input id="server" type="text" value="${esc(sel.server)}" spellcheck="false" autocomplete="off" />
        <button class="chip" data-act="probe">Check</button><span id="servernote" class="dim">${esc(this.serverNote)}</span></div>`
      : '<div class="opts"><span class="dim">Drive the night city at your own pace. Traffic on the road, laps counted forever.</span></div>';
    const go = { free: 'Free run', race: `Race · ${sel.laps} lap${sel.laps > 1 ? 's' : ''}`, online: 'Join server' }[sel.mode];
    return `<div class="garage">
      <div class="g-top"><button data-act="back">← Menu</button><div class="g-title">Garage</div></div>
      <div class="g-left panel"><h3>Cars</h3>${cards}</div>
      <div class="g-right panel"><h3>Paint</h3><div class="sws">${sw}<label class="sw custom" title="Custom colour"><input id="custom" type="color" value="${paint}" /></label></div>
        <div class="chips">${fin}</div>
        <h3>Tuning</h3>${rows}<h3>Stats <small class="dim">(marker = stock)</small></h3>${stats}</div>
      <div class="g-bottom"><div class="modes">${modeBtn('free', 'Free run', 'Open city')}${modeBtn('race', 'Race', 'Laps against the clock')}${modeBtn('online', 'Online', 'Join a server')}</div>
        ${opts}<button class="primary huge go" data-act="go">${go} →</button></div>
    </div>`;
  }

  private pause() {
    return `<div class="card center"><h2>Paused</h2><div class="btns col">
      <button class="primary" data-act="resume">Resume</button><button data-act="restart">Restart</button><button data-act="garage">Back to garage</button></div></div>`;
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
