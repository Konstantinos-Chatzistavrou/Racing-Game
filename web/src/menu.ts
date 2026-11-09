// Front end: title, garage, game modes, party lobby, pause, results, countdown. Plain DOM over the
// live 3D scene (the canvas keeps rendering behind it: the car on the start line is the backdrop).
// main.ts owns the state machine; this file draws and reports choices through callbacks.
//
// Flow: title -> Play -> game modes (Race / Free Roam / Multiplayer)
//       title -> Garage (cars, paint, upgrades only) -> Main Menu, or Continue -> game modes
import type { Identity } from './identity';
import { PLATE_MAX, USERNAME_MAX, USERNAME_MIN, usernameError } from './username';
import { FINISHES, LOOK_PRESETS, MODS, MOD_KEYS, RIM_EFFECT, SWATCHES, WING_EFFECT, applyLookPreset, applyMods, customOf, kitEffect, modsOf, paintOf, saveSelection, statsOf,
  type CatalogCar, type Finish, type Mode, type ModKey, type Selection } from './garage';
import { formatLap } from './hud';
import { MAX_MEMBERS, cleanCode, type Party, type PartyMode } from './party';
import type { ControlsUi } from './controls-menu';
import { PRESET_INFO, applyPreset, matchPreset, type AssistSettings, type Preset } from './assists';
import { fmt, fmtXp, type Career, type MpCareer, type SpCareer } from './career';
import type { Cloud } from './cloud';
import type { RankedResult } from './ranked';
import { levelOf } from './progression';
import type { Loader } from './loading';
import { AERO_FINISHES, DIFFUSERS, GLOW_COLOURS, HEAD_TINTS, LIVERIES, PART_COLOURS, RIM_FINISHES, RIMS, SKIRTS, SPLITTERS, WINGS, type Custom } from './scene/custom';
import { SKINS, helmetSvg, skinOf } from './scene/driver';

/** Garage tabs: name, camera (azimuth, elevation, distance) that shows those parts. */
const GTABS: { id: string; label: string; cam: string }[] = [
  { id: 'paint', label: 'Paint', cam: '0.8,0.17,6.5' },
  { id: 'aero', label: 'Aero', cam: '2.45,0.24,6.0' },
  { id: 'wheels', label: 'Wheels', cam: '1.25,0.04,4.4' },
  { id: 'lights', label: 'Lights', cam: '0.35,0.1,5.6' },
  { id: 'glass', label: 'Glass', cam: '2.85,0.14,5.2' },
  { id: 'driver', label: 'Driver', cam: '1.45,0.14,4.3' },
  { id: 'perf', label: 'Tune', cam: '0.8,0.17,6.5' },
];

export type Gfx = 'auto' | 'max' | 'ultra' | 'high' | 'medium' | 'low';
export type Screen = 'none' | 'title' | 'garage' | 'modes' | 'lobby' | 'pause' | 'results' | 'busy' | 'controls' | 'settings' | 'shop' | 'profile';
/** One line of the race standings. fin: finish time (s) or -1; d: distance covered (m); dnf: out of the race. */
export interface Standing { name: string; you: boolean; fin: number; d: number; best: number; ai: boolean; dnf?: boolean; why?: string }
export interface ResultData { total: number; best: number; laps: number[]; laps_target: number; standings: Standing[]; routeLength: number; online: boolean; /** credits paid for this race */ earned?: number }

export interface MenuHooks {
  /** a visual choice changed (car, paint, finish): main updates the preview */
  preview(): void;
  /** game modes screen: start a single-player session */
  play(mode: Mode): void;
  gfx(g: Gfx): void;
  resume(): void;
  restart(): void;
  /** leave the session for the main menu / game modes (single player) or the lobby (party) */
  quit(to: 'title' | 'modes'): void;
  /** title buttons: benchmark (about a minute) / soak test (several minutes) */
  bench(soak: boolean): void;
  /** spend reputation to clear the wanted level (the bank/pay choice, docs/design/heat-and-cops.md) */
  layLow?(): void;
  /** the shown screen changed (title <-> garage move the camera) */
  screen(s: Screen): void;
  /** garage camera preset */
  cam?(az: number, el: number, dist: number): void;
  partyCreate(): void;
  partyJoin(code: string): void;
  partyLeave(): void;
  partyMode(mode: PartyMode, laps: number, realism: boolean): void;
  partyStart(): void;
  /** leader: everybody back to the lobby */
  partyLobby(): void;
  /** rejoin a free roam the party is already driving */
  partyRejoin(): void;
  /** our name changed */
  partyMe(): void;
  /** driving assists changed (settings screen) */
  assists(): void;
  /** a visual part, colour or the driver's skin changed: apply to the car on show (no reload) */
  look(): void;
  /** results screen: watch the cars still racing */
  spectate(): void;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const bar = (f: number) => `<i style="width:${Math.round(Math.max(0, Math.min(1, f)) * 100)}%"></i>`;
const hex = (n: number) => '#' + (n >>> 0 & 0xffffff).toString(16).padStart(6, '0');

/** Standings order: finished (by time), then still racing, then out (DNF); each by distance covered. */
export function rank(list: Standing[]) {
  return list.slice().sort((a, b) => {
    if ((a.fin >= 0) !== (b.fin >= 0)) return a.fin >= 0 ? -1 : 1;
    if (a.fin >= 0) return a.fin - b.fin;
    if (!!a.dnf !== !!b.dnf) return a.dnf ? 1 : -1;
    return b.d - a.d;
  });
}
const RULES = {
  realism: 'No resets in races: a wreck, a rollover or 30 s stuck puts you out (DNF) and you spectate the rest.',
  respawn: 'R puts you back on the road, repaired, any time.',
};

export class Menu {
  private root = document.getElementById('menu')!;
  screen: Screen = 'none';
  /** graphics tuning in progress: the title shows a cover instead of the live scene */
  tuning = false;
  gfx: Gfx = 'auto';
  gfxNote = '';
  private busyText = '';
  /** multiplayer: the party we are in (main owns it), a status / error line, an invite from the URL */
  party: Party | null = null;
  partyNote = '';
  partyBusy = false;
  invite = '';
  private joinCode = '';
  private lastResults: ResultData | null = null;
  /** the Controls screen (main sets it up: it needs the input and force-feedback objects) */
  ctl: ControlsUi | null = null;
  private controlsFrom: Screen = 'title';
  /** credits / owned cars and upgrades, and the driving assists (main sets them up) */
  sp!: SpCareer;
  mp!: MpCareer;
  cloud!: Cloud;
  /** username and friends (identity.ts) */
  identity!: Identity;
  private unameDraft: string | null = null;
  private unameNote = '';
  private unameBusy = false;
  private unameSeq = 0;
  /** wanted heat 0-5, shown on the title so the dial is visible outside a session (docs/design/heat-and-cops.md) */
  heat = 0;
  /** XP the Lay low button costs, shown on it (-1 hides the button: the online career has no spend path yet) */
  layLowCost = -1;
  private friendDraft = '';
  private friendNote = '';
  private profileFrom: Screen = 'title';
  private friendsTimer = 0;
  /** the career the garage and shop show (single player / online) */
  get career(): Career { return this.sel.career === 'mp' ? this.mp : this.sp; }
  /** the online race room's verdict on the last party race */
  private rankedRes: RankedResult | null = null;
  private recoveryShown = false;
  private settingsNote = '';
  assists!: AssistSettings;
  private settingsFrom: Screen = 'title';
  /** the loading screen ('busy' shows it; main may hold it while the game warms up) */
  loader!: Loader;
  private shopNote = '';
  private garageTab = 'paint';
  /** the option under the pointer: the live panel previews its effect without applying it */
  private hover: { k: string; v: string | number } | null = null;
  private shopTab: 'cars' | 'upgrades' | 'gear' = 'cars';
  private shopCar = '';

  constructor(readonly sel: Selection, private cars: CatalogCar[], private physics: Record<string, unknown>, private hooks: MenuHooks) {
    this.root.addEventListener('click', (e) => this.click(e));
    // live previews: hovering a part shows what it would do without applying it
    this.root.addEventListener('pointerover', (e) => this.hoverPart(e, true));
    this.root.addEventListener('pointerout', (e) => this.hoverPart(e, false));
    this.root.addEventListener('input', (e) => this.input(e));
    this.root.addEventListener('change', (e) => this.change(e));
    this.root.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      if (e.key === 'Enter' && t.id === 'joincode') this.hooks.partyJoin(this.joinCode);
      if (e.key === 'Enter' && t.id === 'uname') void this.saveName();
      if (e.key === 'Enter' && t.id === 'fadd') void this.friendAct(this.friendDraft, 'add');
      if (t.tagName === 'INPUT' && (t as HTMLInputElement).type === 'text') e.stopPropagation();   // typing a name or code never drives the car
    });
  }

  show(s: Screen, busyText = '') {
    clearInterval(this.friendsTimer);
    if (s === 'profile') { void this.identity.loadFriends(); this.friendsTimer = window.setInterval(() => void this.identity.loadFriends(), 20_000); }
    this.screen = s;
    this.busyText = busyText;
    this.root.hidden = s === 'none';
    this.root.dataset.screen = s;
    if (s === 'busy') void this.loader.show(busyText); else this.loader.hide();
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
    // don't rebuild under the cursor while someone types a name or code
    const focused = document.activeElement as HTMLInputElement | null;
    const keep = focused && this.root.contains(focused) && focused.tagName === 'INPUT' ? { id: focused.id, a: focused.selectionStart, b: focused.selectionEnd } : null;
    const leftScroll = this.root.querySelector('.g-left')?.scrollTop ?? 0;
    const rightScroll = this.root.querySelector('.g-right')?.scrollTop ?? 0;
    const html = {
      none: () => '', title: () => this.title(), garage: () => this.garage(), modes: () => this.modes(), lobby: () => this.lobby(),
      pause: () => this.pause(), controls: () => this.ctl?.html() ?? '', settings: () => this.settings(), shop: () => this.shop(), profile: () => this.profile(), results: () => (this.lastResults ? this.results(this.lastResults) : ''),
      busy: () => '',   // the loading screen (loading.ts) covers it
    }[this.screen]();
    this.root.innerHTML = html;
    if (this.screen === 'garage') {
      const l = this.root.querySelector('.g-left'), r = this.root.querySelector('.g-right');
      if (l && leftScroll) l.scrollTop = leftScroll;
      if (r && rightScroll) r.scrollTop = rightScroll;
    }
    if (keep?.id) {
      const el = document.getElementById(keep.id) as HTMLInputElement | null;
      if (el) { el.focus(); try { el.setSelectionRange(keep.a, keep.b); } catch { /* not a text input */ } }
    }
  }

  showResults(r: ResultData) {
    this.lastResults = r;
    this.screen = 'results';
    this.root.hidden = false;
    this.root.dataset.screen = 'results';
    this.render();
  }
  /** Results already on screen: new finishers came in (party race). */
  updateResults(standings: Standing[]) {
    if (this.screen !== 'results' || !this.lastResults) return;
    this.lastResults.standings = standings;
    this.render();
  }

  // ---- screens ---------------------------------------------------------------------------------
  private title() {
    const curCar = this.car();
    const dis = this.tuning ? 'disabled' : '';
    const invite = this.invite && !this.party ? `<div class="invite"><span>🏁 You're invited to party <b>${esc(this.invite)}</b></span>
        <button class="primary" data-act="invite" ${dis}>Join Party</button><button class="small" data-act="noinvite" aria-label="Dismiss">✕</button></div>` : '';
    const last = this.sp.last ?? this.mp.last;
    const earned = last && (last.xp || last.cr) ? `<div class="earned">+${fmtXp(last.xp)}${last.cr ? ` · +${fmt(last.cr)}` : ''} <span class="dim">${esc(last.reason)}</span>${last.levelUp ? ` <b class="lvup">LEVEL ${last.levelUp}</b>` : ''}</div>` : '';
    if (this.identity.needsPick && !this.tuning) return this.pickName();
    const me = `<button class="me-chip" data-act="profile-open" ${dis}><span class="avatar">${helmetSvg(skinOf(this.sel.skin), 26)}</span><b>${esc(this.identity.name)}</b>
      <span class="dim">${this.identity.friends.incoming.length ? `· ${this.identity.friends.incoming.length} friend request${this.identity.friends.incoming.length > 1 ? 's' : ''}` : '· Profile &amp; friends'}</span></button>`;
    return `${this.tuning ? '<div class="cover"><div class="card center"><div class="spin"></div><p>Calibrating WebGPU pipeline…</p><span class="dim">Optimizing resolution &amp; reflections for this display.</span></div></div>' : ''}
      <div class="title">
        <div class="kicker">OPEN-WORLD STREET RACING // PACEJKA MF 6.1</div>
        <div class="heat-chip ${this.heat >= 5 ? 'maxed' : this.heat === 4 ? 'hot' : ''}">HEAT ${this.heat}/5</div>
        <div class="logo">OPEN<span>GRID</span></div>
        ${me}
        <div class="sub">Active vehicle: <b>${esc(curCar.name)}</b></div>
        <div class="careers">${this.careerCard('sp')}${this.careerCard('mp')}</div>
        ${earned}
        ${invite}
        <div class="title-btns">
          <button class="primary huge" data-act="play" ${dis}>▶ Play</button>
          <button class="huge" data-act="garage-open" ${dis}>⚙ Garage</button>
          <button class="huge" data-act="shop-open" ${dis}>🛒 Shop</button>
          <button class="huge" data-act="settings-open" ${dis}>☰ Settings</button>
          ${this.heat > 0 && this.layLowCost >= 0 ? `<button class="huge lay" data-act="laylow" ${dis} ${this.sp.xp < this.layLowCost ? 'disabled title="Not enough reputation"' : ''}>🕶 Lay low · ${this.layLowCost} XP</button>` : ''}
        </div>
        <div class="dim note">${esc(this.gfxNote || 'WebGPU Clustered Forward+ · 240 Hz Physics')} · Assists: ${this.assists.preset[0].toUpperCase() + this.assists.preset.slice(1)}</div>
        <a class="source-link dim" href="https://github.com/Konstantinos-Chatzistavrou/Racing-Game" target="_blank" rel="noopener">Source code · code AGPL-3.0 · assets CC BY-NC 4.0</a>
      </div>`;
  }

  private settings() {
    const a = this.assists, inSession = this.settingsFrom === 'pause';
    const chip = (act: string, v: string, label: string, on: boolean) => `<button class="chip ${on ? 'on' : ''}" data-act="${act}" data-v="${v}">${label}</button>`;
    const row = (label: string, chips: string, note: string) => `<div class="srow2"><span class="dim">${label}</span><div class="chips">${chips}</div><small class="dim">${note}</small></div>`;
    const presets = (['beginner', 'intermediate', 'expert', 'custom'] as Preset[]).map((p) => chip('as-preset', p, p[0].toUpperCase() + p.slice(1), a.preset === p)).join('');
    const assists = `
      <div class="chips">${presets}</div><div class="dim note">${PRESET_INFO[a.preset]}</div>
      ${row('ABS', chip('as-abs', 'off', 'Off', a.abs === 'off') + chip('as-abs', 'weak', 'Weak', a.abs === 'weak') + chip('as-abs', 'default', 'Default', a.abs === 'default'), 'Stops the wheels locking under braking. Weak lets them slip further first.')}
      ${row('TRACTION', [0, 1, 2, 3, 4, 5].map((n) => chip('as-tc', String(n), n ? String(n) : 'Off', a.tc === n)).join(''), 'Cuts power when the rear wheels spin. 5 steps in earliest.')}
      ${row('STABILITY', chip('as-esc', '0', 'Off', !a.stability) + chip('as-esc', '1', 'On', a.stability), 'Brakes single wheels to stop a spin or a slide wide.')}
      ${row('COUNTERSTEER', chip('as-cs', 'off', 'Off', a.countersteer === 'off') + chip('as-cs', 'weak', 'Weak', a.countersteer === 'weak') + chip('as-cs', 'strong', 'Strong', a.countersteer === 'strong'), 'Steers into a slide for you when the rear steps out (keyboard and controller).')}
      ${row('GEARBOX', chip('as-gb', 'auto', 'Automatic', a.gearbox === 'auto') + chip('as-gb', 'manual', 'Manual', a.gearbox === 'manual'), 'Manual: Q / E, bumpers or paddles.')}
      ${row('DRIVING LINE', chip('as-line', 'off', 'Off', a.line === 'off') + chip('as-line', 'braking', 'Braking zones', a.line === 'braking') + chip('as-line', 'full', 'Full', a.line === 'full'), 'The racing line on the road: blue = keep going, yellow = ease off, red = brake.')}
      <div class="dim note">Assists never change the car: same physics and tyres for everyone; they only help with your inputs. Keys 1 / 2 / 3 / 5 switch ABS / traction / stability / gearbox while driving.</div>`;
    const g = (k: Gfx, label: string) => chip('gfx', k, label, this.gfx === k);
    const more = inSession ? '<div class="dim note">Race rules, graphics and tests can be changed from the main menu.</div>' : `
      <h3>Race rules</h3>
      <div class="chips">${chip('realism', '1', 'Full Realism', this.sel.realism)}${chip('realism', '0', 'Respawns', !this.sel.realism)}</div>
      <div class="dim note">${this.sel.realism ? RULES.realism : RULES.respawn}</div>
      <h3>Graphics</h3>
      <div class="chips">${g('auto', 'Auto')}${g('max', 'Max')}${g('ultra', 'Ultra')}${g('high', 'High')}${g('medium', 'Medium')}${g('low', 'Low')}</div>
      <div class="dim note">${esc(this.gfxNote || 'Auto tunes resolution and effects for this device once.')}</div>
      <h3>Performance tests</h3>
      <div class="chips"><button class="small" data-act="bench">⏱ Benchmark</button><button class="small" data-act="soak">🔥 Soak Test</button></div>`;
    return `<div class="lobby-screen"><div class="card lobby-card settings-card">
      <div class="lobby-head"><button data-act="settings-back" class="back-btn">← Back</button><div><div class="kicker">OPTIONS</div><h2>Settings</h2></div></div>
      <h3>Driving assists</h3>${assists}
      <h3>Controls</h3><div class="chips"><button data-act="controls-open">🎮 Controllers, wheels &amp; keyboard…</button></div>
      <h3>Online account</h3>
      <div class="dim note">${this.cloud.available ? `Your online career is kept on the server, with no e-mail or password. The recovery code moves it to another device: keep it private, anyone with it can use your account.${this.mp.ready ? '' : ` (${esc(this.mp.note)})`}` : 'The online service is not set up for this build.'}</div>
      ${this.cloud.available ? `<div class="chips"><button class="small" data-act="recovery">${this.recoveryShown ? 'Hide' : 'Show'} recovery code</button></div>
        ${this.recoveryShown ? `<input id="reccode" type="text" readonly value="${esc(this.cloud.recoveryCode || 'No account yet: open the multiplayer lobby once.')}" />` : ''}
        <div class="joinrow"><input id="restore" type="text" placeholder="Paste a recovery code to use that account here" spellcheck="false" autocomplete="off" /><button class="small" data-act="restore">Use</button></div>
        ${this.settingsNote ? `<div class="pnote ${this.settingsNote.startsWith('✓') ? '' : 'bad'}">${esc(this.settingsNote)}</div>` : ''}` : ''}
      ${more}
      <div class="lobby-foot"><span></span><button data-act="settings-back" class="primary">Done</button></div>
    </div></div>`;
  }

  /** A career's level, XP bar and (online) credits. */
  private careerCard(k: 'sp' | 'mp') {
    const c = k === 'sp' ? this.sp : this.mp, L = levelOf(c.xp);
    const pct = L.need ? Math.round((L.into / L.need) * 100) : 100;
    const extra = k === 'mp' ? (this.mp.ready ? ` · <span class="credits">${fmt(c.credits)}</span>` : ` · <span class="dim">${esc(this.mp.note || 'offline')}</span>`) : '';
    return `<div class="ccard"><span class="dim">${k === 'sp' ? 'SINGLE PLAYER' : 'ONLINE'}</span><b>Level ${L.level}</b>${extra}
      <div class="xpbar"><i style="width:${pct}%"></i></div><small class="dim">${L.need ? `${fmtXp(L.into)} / ${fmtXp(L.need)}` : 'Max level'}</small></div>`;
  }
  /** The single player / online switch on the garage and shop. */
  private careerBar() {
    const sp = levelOf(this.sp.xp).level, mp = levelOf(this.mp.xp).level;
    return `<div class="career-bar"><button class="chip ${this.sel.career === 'sp' ? 'on' : ''}" data-act="career" data-v="sp">Single player · Lv ${sp}</button>
      <button class="chip ${this.sel.career === 'mp' ? 'on' : ''}" data-act="career" data-v="mp">Online · Lv ${mp}${this.mp.ready ? ` · ${fmt(this.mp.credits)}` : ''}</button></div>`;
  }
  /** The get-it button of a shop item for the active career. */
  private itemBtn(kind: 'car' | 'mod' | 'skin', id: string, stage: number | undefined, label: string, small = true) {
    const c = this.career, r = c.req(kind, id, stage), cls = small ? 'small' : 'pip buy';
    const data = `data-act="buy" data-kind="${kind}" data-v="${id}"${stage ? ` data-stage="${stage}"` : ''}`;
    if (c.kind === 'sp') return `<button class="${cls}" disabled>${label ? `${label} · ` : ''}Unlocks at level ${r.spLevel}</button>`;
    if (!this.mp.ready) return `<button class="${cls}" disabled>${esc(this.mp.note || 'Online service unavailable')}</button>`;
    const lvl = levelOf(this.mp.xp).level;
    let price = r.price;
    if (kind === 'mod') { price = 0; const [car, key] = id.split(':'); for (let s2 = this.mp.stage(car, key as ModKey) + 1; s2 <= (stage ?? 1); s2++) price += c.req('mod', key, s2).price; }
    if (lvl < r.mpLevel) return `<button class="${cls}" disabled>${label ? `${label} · ` : ''}Online level ${r.mpLevel}</button>`;
    if (price > this.mp.credits) return `<button class="${cls}" disabled>${label ? `${label} · ` : ''}Need ${fmt(price - this.mp.credits)} more</button>`;
    return `<button class="${cls} primary" ${data}>${label ? `${label} · ` : ''}Buy · ${fmt(price)}</button>`;
  }

  private shop() {
    const w = this.career, sp = w.kind === 'sp';
    const cars = this.cars.map((c) => {
      const st = statsOf(this.physics[c.id]), owned = w.owns(c.id);
      const btn = owned ? `<button class="small" data-act="shop-drive" data-v="${c.id}">${c.id === this.sel.car ? '✓ Driving' : 'Drive'}</button>` : this.itemBtn('car', c.id, undefined, '');
      const r = w.req('car', c.id);
      return `<div class="scard ${owned ? 'owned' : ''}">
        <div class="car-head"><b>${esc(c.name)}</b><i class="car-badge">${owned ? (sp ? 'UNLOCKED' : 'OWNED') : sp ? `LV ${r.spLevel}` : `LV ${r.mpLevel} · ${fmt(r.price)}`}</i></div>
        <span class="dim">${esc(c.tag)}</span>
        <div class="mini"><em>${Math.round(st.power)} kW</em><em>${Math.round(st.mass)} kg</em><em>${st.grip.toFixed(2)} µ</em></div>
        ${btn}</div>`;
    }).join('');
    const ownedCars = this.cars.filter((c) => w.owns(c.id));
    if (!w.owns(this.shopCar)) this.shopCar = this.sel.car;
    const carChips = ownedCars.map((c) => `<button class="chip ${c.id === this.shopCar ? 'on' : ''}" data-act="shop-car" data-v="${c.id}">${esc(c.name)}</button>`).join('');
    const ups = MOD_KEYS.map((k) => {
      const m = MODS[k], have = w.stage(this.shopCar, k);
      const stages = [1, 2, 3].map((n) => n <= have ? `<button class="pip on" disabled>${m.levels[n]} ✓</button>` : this.itemBtn('mod', sp ? k : `${this.shopCar}:${k}`, n, m.levels[n], false)).join('');
      return `<div class="mod"><div><b>${m.label}</b><span class="dim">${m.hint}</span></div><div class="pips">${stages}</div></div>`;
    }).join('');
    const gear = SKINS.map((k) => {
      const owned = w.ownsSkin(k.id), worn = this.sel.skin === k.id, r = w.req('skin', k.id);
      const btn = owned ? `<button class="small ${worn ? '' : 'primary'}" data-act="wear-skin" data-v="${k.id}" ${worn ? 'disabled' : ''}>${worn ? '✓ Wearing' : 'Wear'}</button>` : this.itemBtn('skin', k.id, undefined, '');
      return `<div class="scard gear ${owned ? 'owned' : ''}">${helmetSvg(k, 64)}<div class="car-head"><b>${esc(k.name)}</b><i class="car-badge">${owned ? (sp ? 'UNLOCKED' : 'OWNED') : sp ? `LV ${r.spLevel}` : fmt(r.price)}</i></div>
        <span class="suit-dot" style="background:${k.suit}"></span>${btn}</div>`;
    }).join('');
    const tab = (id: typeof this.shopTab, label: string) => `<button class="gtab ${this.shopTab === id ? 'on' : ''}" data-act="stab" data-v="${id}">${label}</button>`;
    const content = this.shopTab === 'cars' ? `<div class="shop-cars">${cars}</div>`
      : this.shopTab === 'upgrades' ? `<p class="dim small-note">Fit and remove stages in the Garage → Tune.</p><div class="chips">${carChips}</div>${ups}`
      : `<p class="dim small-note">Helmet and suit: worn by your driver and shown as your avatar to everyone in a party.</p><div class="shop-cars">${gear}</div>`;
    const how = sp ? 'Single player: everything unlocks as you level up (XP from races and free roam). Nothing to buy.'
      : 'Online: credits and XP come only from ranked party races (6+ players who race; at most 2 per network). Each item needs an online level and credits.';
    return `<div class="lobby-screen"><div class="card lobby-card shop-card">
      <div class="lobby-head"><button data-act="home" class="back-btn">← Main Menu</button><div><div class="kicker">${sp ? 'UNLOCKS' : 'SPEND YOUR CREDITS'}</div><h2>Shop</h2></div>${sp ? '' : `<div class="wallet-pill">${this.mp.ready ? fmt(w.credits) : '—'}</div>`}</div>
      ${this.careerBar()}
      <div class="gtabs">${tab('cars', 'Cars')}${tab('upgrades', 'Upgrades')}${tab('gear', 'Driver gear')}</div>
      ${this.shopNote ? `<div class="pnote ${this.shopNote.startsWith('✓') ? '' : 'bad'}">${esc(this.shopNote)}</div>` : ''}
      ${content}
      <div class="dim note">${how}</div>
      <div class="lobby-foot"><button data-act="garage-open">⚙ Garage</button><button class="primary" data-act="play">Play ▶</button></div>
    </div></div>`;
  }

  private garage() {
    const sel = this.sel;
    const w = this.career;
    const cards = this.cars.filter((c) => w.owns(c.id)).map((c) => {
      const st = statsOf(this.physics[c.id]);
      return `<button class="car ${c.id === sel.car ? 'on' : ''}" data-act="car" data-v="${c.id}">
        <div class="car-head"><b>${esc(c.name)}</b><i class="car-badge">${c.id === sel.car ? 'SELECTED' : 'SELECT'}</i></div>
        <span>${esc(c.tag)}</span>
        <div class="mini"><em>${Math.round(st.power)} kW</em><em>${Math.round(st.mass)} kg</em><em>${st.grip.toFixed(2)} µ</em></div>
      </button>`;
    }).join('');
    const mods = modsOf(sel);
    const now = statsOf(applyMods(this.physics[sel.car], mods));
    const stages = MOD_KEYS.reduce((a, k) => a + mods[k], 0);
    const tabs = GTABS.map((t) => `<button class="gtab ${this.garageTab === t.id ? 'on' : ''}" data-act="gtab" data-v="${t.id}">${t.label}</button>`).join('');
    const body = ({ paint: () => this.gPaint(), aero: () => this.gAero(), wheels: () => this.gWheels(), lights: () => this.gLights(),
      glass: () => this.gGlass(), driver: () => this.gDriver(), perf: () => this.gPerf() } as Record<string, () => string>)[this.garageTab]?.() ?? '';
    const rail = GTABS.map((t, i) => `<button class="rail ${this.garageTab === t.id ? 'on' : ''}" data-act="gtab" data-v="${t.id}"><i>0${i + 1}</i><b>${t.label}</b></button>`).join('');
    const cls = now.power > 420 ? 'S' : now.power > 330 ? 'A' : now.power > 250 ? 'B' : 'C';
    return `<div class="garage">
      <header class="g-head">
        <div class="g-brand">GARAGE<span>BUILD YOUR CAR</span></div>
        <div class="g-carsum">
          <div class="g-name">${esc(this.car().name)}<i>CLASS ${cls}</i></div>
          <div class="g-stats">
            <span><b>${Math.round(now.power)}</b> kW</span>
            <span><b>${Math.round(now.mass)}</b> kg</span>
            <span><b>${now.grip.toFixed(2)}</b> µ</span>
          </div>
        </div>
        <div class="g-cams">
          <button class="chip" data-act="cam" data-v="0.8,0.17,6.5">3/4</button>
          <button class="chip" data-act="cam" data-v="1.57,0.08,6.4">Side</button>
          <button class="chip" data-act="cam" data-v="3.14,0.15,6.0">Rear</button>
          <button class="chip" data-act="cam" data-v="0,0.14,6.0">Front</button>
        </div>
      </header>
      <aside class="g-carlist panel"><h3>Your cars (${this.cars.filter((c) => w.owns(c.id)).length}/${this.cars.length})</h3>${cards}
        ${this.cars.some((c) => !w.owns(c.id)) ? '<button class="small more-cars" data-act="shop-open">🛒 More cars in the Shop</button>' : ''}</aside>
      <nav class="g-rail">${rail}</nav>
      <section class="g-stage panel"><div class="g-stage-scroll"><div class="g-tabtitle">${this.garageTab.toUpperCase()}</div>${this.lookNow()}${body}</div></section>
      <section class="g-live" id="g-live">${this.liveStats()}</section>
      <footer class="g-foot">
        <button data-act="home" class="back-btn">← Main Menu</button>
        <div class="g-summary"><b>${esc(this.car().name)}</b><span class="dim">${stages ? `${stages} upgrade stage${stages > 1 ? 's' : ''} fitted` : 'Stock'} · ${FINISHES[sel.finish].label} paint · ${Math.round(now.power)} kW</span></div>
        <button class="primary huge go" data-act="play">Continue ▶</button>
      </footer>
    </div>`;
  }

  /** Live telemetry: bars show the car as it sits, the delta shows what the hovered part would do. */
  private liveStats() {
    const sel = this.sel, parts = customOf(sel);
    const d = applyMods(this.physics[sel.car] as never, modsOf(sel)) as any;
    const st = statsOf(d);
    const fx = (c: ReturnType<typeof customOf>) => {
      const w = WING_EFFECT.find((e) => e.re.test(String(c.wing)));
      const r = RIM_EFFECT.find((e) => e.re.test(String(c.rims)));
      const parts = [kitEffect('splitter', c.splitter), kitEffect('diffuser', c.diffuser), kitEffect('skirt', c.skirt)];
      return {
        df: (w ? w.df : 0) + parts.reduce((a, x) => a + x.df, 0),
        drag: (w ? w.drag : 0) + parts.reduce((a, x) => a + x.drag, 0),
        kg: (w ? w.kg : 0) + (r ? r.kg : 0) + parts.reduce((a, x) => a + x.kg, 0),
      };
    };
    const now = fx(parts);
    const pv = this.hover ? fx({ ...parts, [this.hover.k]: this.hover.v } as ReturnType<typeof customOf>) : null;
    const mass = st.mass + now.kg, pmass = pv ? st.mass + pv.kg : null;
    const drag = st.drag + now.drag, pdrag = pv ? st.drag + pv.drag : null;
    const vmax = st.vmax * Math.cbrt(st.drag / Math.max(0.2, drag));
    const pvmax = pdrag ? st.vmax * Math.cbrt(st.drag / Math.max(0.2, pdrag)) : null;
    const df = st.downforce + now.df, pdf = pv ? st.downforce + pv.df : null;
    const accel = st.accel * (mass / st.mass), paccel = pmass ? st.accel * (pmass / st.mass) : null;
    const dl = (a: number, b: number | null, unit: string, digits = 0, lowerBetter = false) => {
      if (b === null) return '';
      const dv = b - a;
      if (Math.abs(dv) < (digits ? 0.005 : 0.5)) return '<em class="flat">±0</em>';
      return '<em class="' + (lowerBetter ? (dv < 0 ? 'up' : 'down') : (dv > 0 ? 'up' : 'down')) + '">' + (dv > 0 ? '+' : '') + dv.toFixed(digits) + ' ' + unit + '</em>';
    };
    const row = (label: string, text: string, sub: string, frac: number, delta: string) =>
      '<div class="lv"><span>' + label + '</span><div class="lbar">' + bar(frac) + '</div><b>' + text + '</b><i>' + sub + '</i>' + delta + '</div>';
    return [
      row('POWER', Math.round(st.power) + ' kW', Math.round(st.hp) + ' hp', st.power / 600, ''),
      row('WEIGHT', Math.round(mass) + ' kg', 'loaded', (1700 - mass) / 600, dl(mass, pmass, 'kg', 0, true)),
      row('POWER / T', Math.round(st.pwr) + ' kW/t', Math.round(st.ratio) + ' W/kg', st.pwr / 450, ''),
      row('0-100', accel.toFixed(1) + ' s', 'estimate', (6.5 - accel) / 5, dl(accel, paccel, 's', 1, true)),
      row('DOWNFORCE', df.toFixed(2) + ' m²', 'aero', df / 0.95, dl(df, pdf, 'm²', 2)),
      row('TOP SPEED', Math.round(vmax) + ' km/h', 'drag-limited', vmax / 360, dl(vmax, pvmax, 'km/h')),
      row('DRAG', drag.toFixed(2) + ' m²', 'CdA', (0.95 - drag) / 0.8, dl(drag, pdrag, 'm²', 2, true)),
    ].join('');
  }

  /** pointerover/out on a part chip: swap the live panel to the previewed numbers, no garage re-render. */
  private hoverPart(e: Event, on: boolean) {
    const t = (e.target as HTMLElement | null)?.closest?.('[data-act="cu"]') as HTMLElement | null;
    if (!t || this.screen !== 'garage') return;
    if (!on) {
      const to = (e as PointerEvent).relatedTarget as HTMLElement | null;
      if (to && t.contains(to)) return;
    }
    const k = t.dataset.k, v = t.dataset.v;
    this.hover = on && k && v !== undefined ? { k, v } : null;
    const live = document.getElementById('g-live');
    if (live) live.innerHTML = this.liveStats();
  }
  // ---- garage tabs (each a list of rows; every choice is data-act="cu" data-k=<Custom key> data-v=<value>) ----
  private cu(k: keyof Custom, v: string | number | boolean, label: string, on: boolean) {
    return `<button class="chip ${on ? 'on' : ''}" data-act="cu" data-k="${k}" data-v="${v}">${label}</button>`;
  }
  private swatches(k: keyof Custom, cur: string, list = PART_COLOURS) {
    return `<div class="sws">${list.map((c) => c ? `<button class="sw ${c === cur ? 'on' : ''}" style="background:${c}" data-act="cu" data-k="${k}" data-v="${c}" aria-label="${c}"></button>`
      : `<button class="sw off ${cur === '' ? 'on' : ''}" data-act="cu" data-k="${k}" data-v="" aria-label="Off">✕</button>`).join('')}</div>`;
  }
  /** What is on the car right now: the paint swatch and the finish name, right under the tabs (all garage tabs). */
  private lookNow() {
    const paint = paintOf(this.sel, this.cars);
    return `<div class="chips" style="align-items:center;gap:7px;margin:6px 0 0">
      <i aria-hidden="true" style="width:13px;height:13px;border-radius:50%;background:${paint};border:1px solid #ffffff55;box-shadow:0 0 6px ${paint}88"></i>
      <b style="font-size:11px;letter-spacing:.10em;text-transform:uppercase">${FINISHES[this.sel.finish].label}</b>
      <span class="dim" style="font-size:11px">${paint.toUpperCase()}</span></div>`;
  }
  private gPaint() {
    const sel = this.sel, c = customOf(sel), paint = paintOf(sel, this.cars).toLowerCase();
    const sw = SWATCHES.map((x) => `<button class="sw ${x === paint ? 'on' : ''}" style="background:${x}" data-act="paint" data-v="${x}" aria-label="${x}"></button>`).join('');
    const fin = (Object.keys(FINISHES) as Finish[]).map((f) => `<button class="chip ${sel.finish === f ? 'on' : ''}" data-act="finish" data-v="${f}">${FINISHES[f].label}</button>`).join('');
    const looks = LOOK_PRESETS.map((p) => `<button class="chip" data-act="look" data-v="${p.id}" title="${esc(p.blurb)}">${esc(p.label)}</button>`).join('');
    return `<h3>Heat presets <small>one click, everything below changes</small></h3><div class="chips">${looks}</div>
      <h3>Body colour</h3>
      <div class="sws">${sw}<label class="sw custom" title="Custom colour"><input id="custom" type="color" value="${paint}" /></label></div>
      <h3>Finish</h3><div class="chips">${fin}</div>
      <h3>Livery</h3><div class="chips">${LIVERIES.map((l, i) => this.cu('livery', i, l, c.livery === i)).join('')}</div>
      ${c.livery ? `<h3>Livery colour</h3>${this.swatches('liveryColor', c.liveryColor)}` : ''}`;
  }
  private gAero() {
    const c = customOf(this.sel);
    return `<h3>Rear wing</h3><div class="chips">${(Object.keys(WINGS) as (keyof typeof WINGS)[]).map((k) => this.cu('wing', k, WINGS[k], c.wing === k)).join('')}</div>
      <h3>Front splitter</h3><div class="chips">${(Object.keys(SPLITTERS) as string[]).map((k) => this.cu('splitter', k, SPLITTERS[k], c.splitter === k)).join('')}</div>
      <h3>Rear diffuser</h3><div class="chips">${(Object.keys(DIFFUSERS) as string[]).map((k) => this.cu('diffuser', k, DIFFUSERS[k], c.diffuser === k)).join('')}</div>
      <h3>Side skirts</h3><div class="chips">${(Object.keys(SKIRTS) as string[]).map((k) => this.cu('skirt', k, SKIRTS[k], c.skirt === k)).join('')}</div>
      <h3>Splitter, diffuser &amp; wing finish</h3><div class="chips">${(Object.keys(AERO_FINISHES) as (keyof typeof AERO_FINISHES)[]).map((k) => this.cu('aero', k, AERO_FINISHES[k], c.aero === k)).join('')}</div>`;
  }
  private gWheels() {
    const c = customOf(this.sel);
    return `<h3>Rim design</h3><div class="chips">${(Object.keys(RIMS) as string[]).map((k) => this.cu('rims', k, RIMS[k], c.rims === k)).join('')}</div>
      <h3>Rim colour</h3>${this.swatches('rimColor', c.rimColor)}
      <h3>Rim finish</h3><div class="chips">${(Object.keys(RIM_FINISHES) as (keyof typeof RIM_FINISHES)[]).map((k) => this.cu('rimFinish', k, RIM_FINISHES[k], c.rimFinish === k)).join('')}</div>
      <h3>Brake calipers</h3>${this.swatches('caliper', c.caliper)}`;
  }
  private gLights() {
    const c = customOf(this.sel);
    return `<h3>Headlights</h3><div class="chips">${(Object.keys(HEAD_TINTS) as (keyof typeof HEAD_TINTS)[]).map((k) => this.cu('headlights', k, HEAD_TINTS[k], c.headlights === k)).join('')}</div>
      <h3>Tail lights</h3><div class="chips">${this.cu('smokedTails', false, 'Clear red', !c.smokedTails)}${this.cu('smokedTails', true, 'Smoked', c.smokedTails)}</div>
      <h3>Underglow</h3>${this.swatches('underglow', c.underglow, GLOW_COLOURS)}`;
  }
  private gGlass() {
    const c = customOf(this.sel);
    return `<h3>Window tint</h3><div class="chips">${['Light', 'Dark', 'Limo'].map((l, i) => this.cu('tint', i, l, c.tint === i)).join('')}</div>
      <h3>Exhaust tips</h3><div class="chips">${this.cu('exhaust', 'chrome', 'Chrome', c.exhaust === 'chrome')}${this.cu('exhaust', 'black', 'Black', c.exhaust === 'black')}${this.cu('exhaust', 'titanium', 'Burnt titanium', c.exhaust === 'titanium')}</div>`;
  }
  private gDriver() {
    const owned = SKINS.filter((k) => this.career.ownsSkin(k.id));
    const cards = owned.map((k) => `<button class="skin ${this.sel.skin === k.id ? 'on' : ''}" data-act="skin" data-v="${k.id}">${helmetSvg(k, 42)}<span>${esc(k.name)}</span></button>`).join('');
    return `<h3>Driver gear <small class="dim">(your avatar in multiplayer)</small></h3><div class="skins">${cards}</div>
      ${owned.length < SKINS.length ? '<button class="small more-cars" data-act="shop-gear">🛒 More helmets &amp; suits in the Shop</button>' : ''}`;
  }
  private gPerf() {
    const sel = this.sel, w = this.career, mods = modsOf(sel);
    const rows = MOD_KEYS.map((k) => {
      const m = MODS[k];
      const own = w.stage(sel.car, k);
      const pips = m.levels.map((l, i) => i > own
        ? `<button class="pip locked" data-act="shop-open" title="${l}: ${w.kind === 'sp' ? `unlocks at level ${w.req('mod', k, i).spLevel}` : `online level ${w.req('mod', k, i).mpLevel}, ${fmt(w.req('mod', k, i).price)} in the Shop`}">🔒</button>`
        : `<button class="pip ${i <= mods[k] && mods[k] > 0 ? 'on' : ''} ${i === mods[k] ? 'cur' : ''}" data-act="mod" data-k="${k}" data-v="${i}" title="${l}">${i === 0 ? 'STK' : 'S' + i}</button>`).join('');
      return `<div class="mod"><div><b>${m.label}</b><span class="dim">${m.levels[mods[k]]}</span></div><div class="pips">${pips}</div><small class="dim">${m.hint}</small></div>`;
    }).join('');
    const base = statsOf(this.physics[sel.car] as never), now = statsOf(applyMods(this.physics[sel.car], mods));
    const stat = (label: string, text: string, ref: number, f: number) =>
      `<div class="stat"><span>${label}</span><div class="bar">${bar(f)}${ref >= 0 ? `<u style="left:${Math.round(ref * 100)}%"></u>` : ''}</div><b>${text}</b></div>`;
    const stats = [
      stat('Power', `${Math.round(now.power)} kW`, base.power / 480, now.power / 480),
      stat('Grip', now.grip.toFixed(2) + ' µ', (base.grip - 1) / 0.7, (now.grip - 1) / 0.7),
      stat('Light', `${Math.round(now.mass)} kg`, (1700 - base.mass) / 500, (1700 - now.mass) / 500),
      stat('Downforce', `${now.downforce.toFixed(2)} m²`, base.downforce / 1.2, now.downforce / 1.2),
      stat('Power/wt', `${Math.round(now.ratio)} W/kg`, base.ratio / 400, now.ratio / 400),
    ].join('');
    return `<h3>Performance upgrades</h3>${rows}<h3>Telemetry <small class="dim">(red marker = stock)</small></h3>${stats}`;
  }

  private modes() {
    const sel = this.sel;
    const laps = [1, 3, 5, 10].map((n) => `<button class="chip ${sel.laps === n ? 'on' : ''}" data-act="laps" data-v="${n}">${n}</button>`).join('');
    const inParty = this.party ? `<span class="pill">In party ${esc(this.party.code)}</span>` : '';
    return `<div class="modes-screen">
      <div class="m-head">
        <button data-act="home" class="back-btn">← Main Menu</button>
        <div><div class="kicker">SELECT EVENT</div><h2>Choose Game Mode</h2></div>
        <div class="m-car dim">Driving: <b>${esc(this.car().name)}</b></div>
      </div>
      <div class="mode-cards">
        <div class="mcard">
          <div class="mcard-top"><span class="micon">🏁</span><b>Race</b><span class="dim">6-car grid · you vs 5 rivals</span></div>
          <p class="dim">Start mid-pack through the city. Rivals take their own lines and fight for position. Finish ahead of them all.</p>
          <div class="opts"><span class="dim">RULES</span><span class="pill ${sel.realism ? 'gold' : ''}">${sel.realism ? 'FULL REALISM' : 'RESPAWNS'}</span><span class="dim small-note">change on the main menu</span></div>
          <div class="opts"><span class="dim">LAPS</span>${laps}</div>
          <button class="primary huge" data-act="start-race">▶ Start Race · ${sel.laps} Lap${sel.laps > 1 ? 's' : ''}</button>
        </div>
        <div class="mcard">
          <div class="mcard-top"><span class="micon">🌃</span><b>Free Roam</b><span class="dim">Just you · open city</span></div>
          <p class="dim">The streets to yourself. Learn the car, chase lap times, no traffic and no clock pressure.</p>
          <div class="opts"><span class="dim">Unlimited laps · lap timer runs</span></div>
          <button class="primary huge" data-act="start-free">▶ Drive</button>
        </div>
        <div class="mcard">
          <div class="mcard-top"><span class="micon">👥</span><b>Multiplayer</b><span class="dim">Party with friends · up to ${MAX_MEMBERS}</span></div>
          <p class="dim">Create a party, send the invite link, then race or cruise together. Peer-to-peer: no account needed.</p>
          <div class="opts">${inParty || '<span class="dim">Create or join a party</span>'}</div>
          <button class="primary huge" data-act="lobby">Party Lobby ▶</button>
        </div>
      </div>
    </div>`;
  }

  private lobby() {
    const p = this.party, sel = this.sel;
    const note = this.partyNote ? `<div class="pnote ${/^(✓|Copied)/.test(this.partyNote) ? '' : 'bad'}">${esc(this.partyNote)}</div>` : '';
    const nameRow = `<div class="field"><span class="dim">YOU RACE AS</span><b class="uname">${esc(sel.name)}</b><button class="small" data-act="profile-open">Change · Friends</button></div>`;
    if (!p) {
      return `<div class="lobby-screen"><div class="card lobby-card">
        <div class="lobby-head"><button data-act="modes" class="back-btn">← Game Modes</button><div><div class="kicker">MULTIPLAYER</div><h2>Party</h2></div></div>
        ${nameRow}
        <div class="lobby-cols">
          <div class="lcol"><h3>Host</h3><p class="dim">Start a party and invite friends with a link or a 5-letter code.</p>
            <button class="primary huge" data-act="pcreate" ${this.partyBusy ? 'disabled' : ''}>＋ Create Party</button></div>
          <div class="lcol"><h3>Join</h3><p class="dim">Got a code from a friend? Type it here.</p>
            <div class="joinrow"><input id="joincode" type="text" maxlength="8" value="${esc(this.joinCode)}" placeholder="CODE" spellcheck="false" autocomplete="off" />
            <button class="primary" data-act="pjoin" ${this.partyBusy ? 'disabled' : ''}>Join</button></div></div>
        </div>
        ${this.partyBusy ? '<div class="pnote"><span class="spin inline"></span> Connecting…</div>' : note}
      </div></div>`;
    }
    const carName = (id: string) => this.cars.find((c) => c.id === id)?.name ?? '—';
    const members = p.members.map((m) => `<div class="member">
        <span class="avatar">${helmetSvg(skinOf(m.skin), 30)}<i class="dot" style="background:${hex(m.paint)}"></i></span>
        <div class="mtext"><div class="mname"><b>${esc(m.name)}</b>${m.host ? '<span class="pill gold">LEADER</span>' : ''}${m.id === p.selfId ? '<span class="pill">YOU</span>' : ''}</div>
        <span class="dim">${esc(carName(m.car))} · <span class="mstate ${m.ready ? 'ok' : ''}">${p.phase === 'loading' ? (m.ready ? 'on the grid' : 'loading…') : p.phase === 'driving' ? 'driving' : 'in lobby'}</span></span></div>
      </div>`).join('');
    const empty = Array.from({ length: Math.max(0, MAX_MEMBERS - p.members.length) }, () => '<div class="member empty"><i class="dot"></i><div class="mtext"><span class="dim">Open slot</span></div></div>').join('');
    const modeChip = (m: PartyMode, label: string) => `<button class="chip ${p.mode === m ? 'on' : ''}" data-act="pmode" data-v="${m}" ${p.isHost ? '' : 'disabled'}>${label}</button>`;
    const lapChip = (n: number) => `<button class="chip ${p.laps === n ? 'on' : ''}" data-act="plaps" data-v="${n}" ${p.isHost ? '' : 'disabled'}>${n}</button>`;
    const realChip = (on: boolean, label: string) => `<button class="chip ${p.realism === on ? 'on' : ''}" data-act="preal" data-v="${on ? 1 : 0}" ${p.isHost ? '' : 'disabled'}>${label}</button>`;
    const rules = `<div class="opts"><span class="dim">MODE</span>${modeChip('race', 'Race')}${modeChip('free', 'Free Roam')}
      ${p.mode === 'race' ? `<span class="dim sep">LAPS</span>${[1, 3, 5, 10].map(lapChip).join('')}` : ''}</div>
      ${p.mode === 'race' ? `<div class="opts"><span class="dim">RULES</span>${realChip(true, 'Full Realism')}${realChip(false, 'Respawns')}<span class="dim small-note">${p.realism ? RULES.realism : RULES.respawn}</span></div>` : ''}`;
    let action: string;
    if (p.phase === 'driving') action = p.mode === 'free' ? '<button class="primary huge" data-act="prejoin">▶ Rejoin Free Roam</button>' : p.isHost ? '<button class="huge" data-act="plobby">Everyone back to lobby</button>' : '<div class="dim wait">The party is racing. You can join the next one.</div>';
    else if (p.phase === 'loading') action = '<div class="dim wait"><span class="spin inline"></span> Loading…</div>';
    else action = p.isHost ? `<button class="primary huge" data-act="pstart">▶ Start ${p.mode === 'race' ? `Race · ${p.laps} Lap${p.laps > 1 ? 's' : ''}` : 'Free Roam'}</button>`
      : '<div class="dim wait"><span class="spin inline"></span> Waiting for the leader to start…</div>';
    const share = typeof navigator.share === 'function' ? '<button class="small" data-act="pshare">Share…</button>' : '';
    return `<div class="lobby-screen"><div class="card lobby-card">
      <div class="lobby-head"><button data-act="modes" class="back-btn">← Game Modes</button><div><div class="kicker">MULTIPLAYER · ${p.members.length}/${MAX_MEMBERS}</div><h2>Party <span class="code">${esc(p.code)}</span></h2></div></div>
      <div class="invite-box"><span class="dim">INVITE</span><input id="plink" type="text" readonly value="${esc(p.link)}" />
        <button class="small" data-act="pcopy">Copy link</button>${share}</div>
      ${nameRow}
      <h3>Drivers</h3><div class="members">${members}${empty}</div>
      <h3>Event ${p.isHost ? '' : '<small class="dim">(the leader chooses)</small>'}</h3>${rules}
      ${note}
      <div class="lobby-foot"><button data-act="pleave" class="back-btn">${p.isHost ? 'Close Party' : 'Leave Party'}</button>${action}</div>
    </div></div>`;
  }

  private pause() {
    const p = this.party;
    const online = !!p && p.phase !== 'lobby';
    const btns = online
      ? `<button class="primary" data-act="resume">▶ Resume Driving</button>
         ${p!.isHost ? '<button data-act="plobby">↩ End Session · Everyone to Lobby</button>' : '<button data-act="quit">↩ Back to Lobby</button>'}
         <button data-act="settings-open">☰ Assists &amp; Controls</button>
         <button data-act="pleave">${p!.isHost ? 'Close Party' : 'Leave Party'}</button>`
      : `<button class="primary" data-act="resume">▶ Resume Driving</button>
         <button data-act="restart">↻ Restart ${this.sel.mode === 'race' ? 'Race' : 'Session'}</button>
         <button data-act="settings-open">☰ Assists &amp; Controls</button>
         <button data-act="quit">← Quit to Main Menu</button>`;
    return `<div class="card center pause-card">
      <div class="kicker">${online ? 'PARTY SESSION · OTHERS KEEP DRIVING' : 'SESSION PAUSED'}</div>
      <h2>Paused</h2>
      <div class="btns col">${btns}</div>
    </div>`;
  }

  private results(r: ResultData) {
    const ranked = rank(r.standings);
    const pos = ranked.findIndex((s) => s.you) + 1;
    const leader = ranked[0];
    const gap = (s: Standing) => {
      if (s.dnf) return `DNF${s.why ? ' · ' + s.why : ''}`;
      if (s === leader) return s.fin >= 0 ? formatLap(s.fin) : '—';
      if (s.fin >= 0 && leader.fin >= 0) return '+' + (s.fin - leader.fin).toFixed(3);
      const laps = Math.floor((leader.d - s.d) / r.routeLength);
      return laps >= 1 ? `+${laps} lap${laps > 1 ? 's' : ''}` : 'racing…';
    };
    const ord = (n: number) => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
    const table = ranked.length > 1 ? `<div class="standings">${ranked.map((s, i) => `<div class="srow ${s.you ? 'you' : ''}">
        <span class="spos">${i + 1}</span><b>${esc(s.name)}</b><span class="dim">${s.best > 0 ? formatLap(s.best) : ''}</span><span class="sgap">${gap(s)}</span></div>`).join('')}</div>` : '';
    const rows = r.laps.map((t, i) => `<div class="row"><span>LAP ${i + 1}</span><b class="${t === r.best ? 'best' : ''}">${formatLap(t)}</b></div>`).join('');
    const p = this.party;
    const me = ranked.find((s) => s.you);
    const racing = ranked.some((s) => !s.you && s.fin < 0 && !s.dnf);
    const spec = racing ? '<button data-act="spectate">👁 Spectate</button>' : '';
    const btns = r.online
      ? spec + (p?.isHost ? '<button class="primary" data-act="plobby">↩ Everyone to Lobby</button>' : '<span class="dim wait">Waiting for the leader…</span>') + `<button data-act="pleave">${p?.isHost ? 'Close Party' : 'Leave Party'}</button>`
      : '<button class="primary" data-act="restart">↻ Race Again</button>' + spec + '<button data-act="quit-modes">Game Modes</button><button data-act="quit">Main Menu</button>';
    return `<div class="card center results-card">
      <div class="kicker">${r.online ? 'PARTY RACE' : 'RACE'} RESULT</div>
      <h2>${me?.dnf ? `Did not finish${me.why ? ' · ' + esc(me.why) : ''}` : ranked.length > 1 ? `You finished ${ord(pos)}` : 'Race Complete'}</h2>
      <div class="big ${pos === 1 && !me?.dnf ? 'win' : ''}">${me?.dnf ? 'DNF' : ranked.length > 1 ? `P${pos}<small> / ${ranked.length}</small>` : formatLap(r.total)}</div>
      <div class="dim">${me?.dnf ? `${r.laps.length} of ${r.laps_target} laps` : `${formatLap(r.total)} · ${r.laps_target} lap${r.laps_target > 1 ? 's' : ''}`} · Best lap <b class="best-inline">${formatLap(r.best)}</b></div>
      ${this.rewardHtml(r, !!me?.dnf)}
      ${table}
      <div class="rows">${rows}</div>
      <div class="btns">${btns}</div>
    </div>`;
  }

  /** XP for a single-player race, or the online race room's verdict (ranked / unranked, XP, credits, notes). */
  private rewardHtml(r: ResultData, dnf: boolean) {
    if (r.online) {
      const x = this.rankedRes;
      if (!x) return `<div class="reward dim">${this.mp.ready ? 'The online race room is timing the race… (results when every car is in)' : 'Unranked: not connected to the online service.'}</div>`;
      const y = x.you;
      return `<div class="reward"><div class="kicker">${x.ranked ? 'RANKED RACE' : 'UNRANKED'}</div>
        ${y && (y.xp || y.cr) ? `<div class="earned center">+${fmtXp(y.xp)} · +${fmt(y.cr)}</div>` : ''}
        ${(y?.parts ?? []).filter((p) => p.xp).map((p) => `<div class="rpart"><span>${esc(p.label)}</span><b>+${p.xp.toLocaleString('en-US')}</b></div>`).join('')}
        ${(y?.notes ?? []).map((n) => `<div class="dim small-note">${esc(n)}</div>`).join('')}</div>`;
    }
    const e = this.sp.last;
    if (!e || r.earned === undefined) return '';
    if (dnf || !e.xp) return '<div class="reward dim">No XP for a DNF</div>';
    const unlocked = (e.unlocked ?? []).map((u) => {
      const [k, id, st] = u.split(':');
      return k === 'car' ? this.cars.find((c) => c.id === id)?.name ?? id : k === 'skin' ? `${skinOf(id).name} gear` : `${MODS[id as ModKey].levels[Number(st)]} (${MODS[id as ModKey].label})`;
    });
    return `<div class="reward"><div class="earned center">+${fmtXp(e.xp)}</div>
      ${(e.parts ?? []).filter((p) => p.xp).map((p) => `<div class="rpart"><span>${esc(p.label)}</span><b>+${p.xp.toLocaleString('en-US')}</b></div>`).join('')}
      ${e.levelUp ? `<div class="lvup big-lv">LEVEL ${e.levelUp}</div>` : ''}${unlocked.length ? `<div class="dim small-note">Unlocked: ${esc(unlocked.join(', '))}</div>` : ''}
      ${this.careerCard('sp')}</div>`;
  }
  /** The online race room's verdict arrived (results screen or later). */
  ranked(r: RankedResult | null) { this.rankedRes = r; if (this.screen === 'results' || this.screen === 'title') this.render(); }

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
    const act = b.dataset.act!;
    if (['play', 'garage-open', 'start-race', 'start-free', 'pstart', 'invite', 'prejoin'].includes(act)) this.askFullscreen();
    const v = b.dataset.v ?? '', sel = this.sel;
    if (act === 'controls-open') { this.controlsFrom = this.screen; this.show('controls'); return; }
    if (act === 'settings-open') { this.settingsFrom = this.screen; this.show('settings'); return; }
    if (act === 'settings-back') { this.show(this.settingsFrom); return; }
    if (act.startsWith('as-')) { this.assistClick(act, v); return; }
    if (act === 'c-back') { this.ctl?.leave(); this.show(this.controlsFrom); return; }
    if (act.startsWith('c-') && this.ctl?.click(act, v)) return;
    switch (act) {
      case 'play': this.sp.last = this.mp.last = null; this.show('modes'); break;
      case 'laylow': this.hooks.layLow?.(); break;
      case 'garage-open': this.show('garage'); this.hooks.preview(); break;
      case 'home': this.show('title'); break;
      case 'profile-open': this.profileFrom = this.screen === 'profile' ? this.profileFrom : this.screen; this.unameDraft = null; this.unameNote = ''; this.friendNote = ''; this.show('profile'); break;
      case 'profile-back': this.show(this.profileFrom); break;
      case 'uname-save': void this.saveName(); break;
      case 'friend-add': void this.friendAct(this.friendDraft, 'add'); break;
      case 'friend-accept': void this.friendAct(v, 'accept'); break;
      case 'friend-remove': void this.friendAct(v, 'remove'); break;
      case 'friend-join': this.joinCode = v; this.setCareer('mp'); this.show('lobby'); this.hooks.partyJoin(v); break;
      case 'shop-open': this.shopNote = ''; this.shopCar = sel.car; this.shopTab = this.garageTab === 'perf' ? 'upgrades' : 'cars'; this.show('shop'); break;
      case 'shop-gear': this.shopNote = ''; this.shopTab = 'gear'; this.show('shop'); break;
      case 'stab': this.shopTab = v as typeof this.shopTab; this.render(); break;
      case 'gtab': { this.garageTab = v; const t = GTABS.find((x) => x.id === v); if (t) { const [az, el, dist] = t.cam.split(',').map(Number); this.hooks.cam?.(az, el, dist); } this.render(); break; }
      case 'cu': {
        const c = customOf(sel), k = b.dataset.k as keyof Custom;
        const val = k === 'livery' || k === 'tint' ? Number(v) : k === 'smokedTails' ? v === 'true' : v;
        (c as unknown as Record<string, unknown>)[k] = val;
        this.save(); this.hooks.look(); this.render();
        break;
      }
      case 'skin': if (this.career.ownsSkin(v)) { sel.skin = v; this.save(); this.hooks.look(); this.hooks.partyMe(); this.render(); } break;
      case 'wear-skin': if (this.career.ownsSkin(v)) { sel.skin = v; this.save(); this.hooks.look(); this.hooks.partyMe(); this.render(); } break;
      case 'shop-car': this.shopCar = v; this.render(); break;
      case 'shop-drive': sel.car = v; this.shopCar = v; this.save(); this.render(); this.hooks.preview(); break;
      case 'buy': {
        const st = b.dataset.stage ? Number(b.dataset.stage) : undefined;
        this.shopNote = '…'; this.render();
        void this.career.buy(b.dataset.kind as 'car' | 'mod' | 'skin', v, st).then((note) => { this.shopNote = note; if (b.dataset.kind === 'car' && this.career.owns(v)) this.shopCar = v; this.render(); });
        break;
      }
      case 'career': {
        sel.career = v === 'mp' ? 'mp' : 'sp';
        this.career.fit(sel); this.save(); this.shopNote = '';
        if (sel.career === 'mp' && !this.mp.ready) void this.mp.refresh();
        this.render(); this.hooks.preview();
        break;
      }
      case 'recovery': this.recoveryShown = !this.recoveryShown; this.render(); break;
      case 'restore': {
        const code = (document.getElementById('restore') as HTMLInputElement | null)?.value ?? '';
        if (this.cloud.restore(code)) { this.mp.profile = null; this.settingsNote = '✓ Account restored on this device.'; void this.mp.refresh(); } else this.settingsNote = 'That is not a recovery code.';
        this.render();
        break;
      }
      case 'modes': this.show('modes'); break;
      case 'quit-modes': this.lastResults = null; this.hooks.quit('modes'); break;
      case 'lobby': this.partyNote = ''; this.setCareer('mp'); this.show('lobby'); break;
      case 'gfx': this.gfx = v as Gfx; this.hooks.gfx(this.gfx); this.render(); break;
      case 'car': sel.car = v; this.save(); this.render(); this.hooks.preview(); break;
      case 'paint': sel.paint[sel.car] = v; this.save(); this.render(); this.hooks.preview(); break;
      case 'finish': sel.finish = v as Finish; this.save(); this.render(); this.hooks.preview(); break;
      case 'look': {
        // one chip sets paint + finish + every part; preview() re-applies the paint and the look uniforms together
        if (applyLookPreset(sel, v)) { this.save(); this.render(); this.hooks.preview(); this.hooks.look(); }
        break;
      }
      case 'mod': { const m = { ...modsOf(sel) }; m[b.dataset.k as ModKey] = Number(v); sel.mods[sel.car] = m; this.save(); this.render(); break; }
      case 'laps': sel.laps = Number(v); this.save(); this.render(); break;
      case 'start-race': sel.mode = 'race'; this.setCareer('sp'); this.save(); this.hooks.play('race'); break;
      case 'start-free': sel.mode = 'free'; this.setCareer('sp'); this.save(); this.hooks.play('free'); break;
      case 'resume': this.hooks.resume(); break;
      case 'restart': this.hooks.restart(); break;
      case 'quit': this.lastResults = null; this.hooks.quit('title'); break;
      case 'bench': this.hooks.bench(false); break;
      case 'soak': this.hooks.bench(true); break;
      case 'cam': { const [az, el, dist] = v.split(',').map(Number); this.hooks.cam?.(az, el, dist); break; }
      // multiplayer
      case 'invite': this.joinCode = this.invite; this.show('lobby'); this.hooks.partyJoin(this.invite); break;
      case 'noinvite': this.invite = ''; this.render(); break;
      case 'pcreate': this.hooks.partyCreate(); break;
      case 'pjoin': this.hooks.partyJoin(this.joinCode); break;
      case 'pleave': this.hooks.partyLeave(); break;
      case 'pmode': this.party && this.hooks.partyMode(v as PartyMode, this.party.laps, this.party.realism); break;
      case 'plaps': this.party && this.hooks.partyMode(this.party.mode, Number(v), this.party.realism); break;
      case 'preal': this.party && this.hooks.partyMode(this.party.mode, this.party.laps, v === '1'); break;
      case 'realism': sel.realism = v === '1'; this.save(); this.render(); break;
      case 'spectate': this.hooks.spectate(); break;
      case 'pstart': this.hooks.partyStart(); break;
      case 'plobby': this.hooks.partyLobby(); break;
      case 'prejoin': this.hooks.partyRejoin(); break;
      case 'pcopy': this.copyLink(); break;
      case 'pshare': if (this.party) navigator.share?.({ title: 'OpenGrid party', text: `Join my OpenGrid party (code ${this.party.code})`, url: this.party.link }).catch(() => {}); break;
    }
  }
  private assistClick(act: string, v: string) {
    const a = this.assists;
    if (act === 'as-preset') applyPreset(a, v as Preset);
    else {
      if (act === 'as-abs') a.abs = v as typeof a.abs;
      if (act === 'as-tc') a.tc = Number(v);
      if (act === 'as-esc') a.stability = v === '1';
      if (act === 'as-cs') a.countersteer = v as typeof a.countersteer;
      if (act === 'as-gb') a.gearbox = v as typeof a.gearbox;
      if (act === 'as-line') a.line = v as typeof a.line;
      matchPreset(a);
    }
    this.hooks.assists();
    this.render();
  }

  /** The session about to start belongs to this career: its car / upgrades / gear. */
  private setCareer(k: 'sp' | 'mp') {
    if (this.sel.career === k) return;
    this.sel.career = k;
    this.career.fit(this.sel);
    this.save();
    if (k === 'mp' && !this.mp.ready) void this.mp.refresh();
    this.hooks.preview();
  }

  // ---- username and friends (identity.ts) -----------------------------------------------------------------------------------
  /** First start: a username before anything else (how friends find you; shown in races and on your plate). */
  private pickName() {
    const draft = this.unameDraft ?? (usernameError(this.sel.name) ? '' : this.sel.name);
    return `<div class="lobby-screen"><div class="card lobby-card pick-card">
      <div class="kicker">WELCOME TO OPENGRID</div><h2>Choose your username</h2>
      <p class="dim">Friends add you by it, and everyone sees it in races: on the leaderboard, over your car and on your number plate.
        ${this.cloud.available ? 'It is yours alone: nobody else can take it.' : ''}</p>
      ${this.unameField(draft)}
      <div class="lobby-foot"><span class="dim small-note">${USERNAME_MIN}-${USERNAME_MAX} characters · letters, digits, _ . - · no #</span>
        <button class="primary huge" data-act="uname-save" ${this.unameBusy ? 'disabled' : ''}>Continue ▶</button></div>
    </div></div>`;
  }
  private unameField(draft: string) {
    const bad = this.unameNote && !this.unameNote.startsWith('✓');
    return `<div class="joinrow"><input id="uname" type="text" maxlength="${USERNAME_MAX}" value="${esc(draft)}" placeholder="username" spellcheck="false" autocomplete="off" autocapitalize="off" />
      ${this.screen === 'profile' ? `<button class="primary" data-act="uname-save" ${this.unameBusy ? 'disabled' : ''}>Save</button>` : ''}</div>
      <div class="pnote ${bad ? 'bad' : ''}" id="uname-note">${this.unameBusy ? '<span class="spin inline"></span> ' : ''}${esc(this.unameNote)}</div>`;
  }
  private async liveCheck(u: string) {
    const seq = ++this.unameSeq;
    const local = usernameError(u.trim());
    if (local || !u.trim()) { this.unameNote = u.trim() ? local! : ''; this.paintNote(); return; }
    await new Promise((r) => setTimeout(r, 350));   // typing: ask the server once it pauses
    if (seq !== this.unameSeq) return;
    const why = await this.identity.check(u.trim());
    if (seq !== this.unameSeq) return;
    this.unameNote = why || (this.cloud.available ? '✓ Available' : '');
    this.paintNote();
  }
  /** the note under the username input, without re-rendering (the input keeps its caret) */
  private paintNote() {
    const el = document.getElementById('uname-note');
    if (!el) return;
    el.textContent = this.unameNote;
    el.classList.toggle('bad', !!this.unameNote && !this.unameNote.startsWith('✓'));
  }
  private async saveName() {
    const u = (this.unameDraft ?? this.sel.name).trim();
    this.unameBusy = true; this.render();
    const why = await this.identity.pick(u);
    this.unameBusy = false;
    if (why) { this.unameNote = why; this.render(); return; }
    this.unameDraft = null;
    this.unameNote = this.identity.note || '✓ Saved';
    this.hooks.partyMe();
    this.render();
  }
  private async friendAct(u: string, action: 'add' | 'accept' | 'remove') {
    if (!u.trim()) return;
    this.friendNote = await this.identity.friend(u, action);
    if (action === 'add' && this.friendNote.startsWith('✓')) this.friendDraft = '';
    this.render();
  }
  private profile() {
    const id = this.identity, f = id.friends, online = this.cloud.available;
    const draft = this.unameDraft ?? this.sel.name;
    const status = !online ? 'Saved on this device. The online service is not set up for this build, so the name cannot be reserved yet.'
      : id.claimed ? '✓ Reserved for you on the online service.' : id.note || 'Not confirmed by the online service yet.';
    const friend = (x: { username: string; level: number; online: boolean; party: string | null }) => `<div class="member">
        <span class="avatar"><i class="dot ${x.online ? 'on' : ''}"></i></span>
        <div class="mtext"><div class="mname"><b>${esc(x.username)}</b><span class="pill">Lv ${x.level}</span></div>
        <span class="dim">${x.online ? (x.party ? `online · in party ${esc(x.party)}` : 'online') : 'offline'}</span></div>
        ${x.party && !this.party ? `<button class="small primary" data-act="friend-join" data-v="${esc(x.party)}">Join</button>` : ''}
        <button class="small" data-act="friend-remove" data-v="${esc(x.username)}" title="Remove friend">✕</button>
      </div>`;
    const incoming = f.incoming.map((u) => `<div class="member"><div class="mtext"><div class="mname"><b>${esc(u)}</b></div><span class="dim">wants to be friends</span></div>
        <button class="small primary" data-act="friend-accept" data-v="${esc(u)}">Accept</button><button class="small" data-act="friend-remove" data-v="${esc(u)}">Decline</button></div>`).join('');
    const outgoing = f.outgoing.map((u) => `<div class="member"><div class="mtext"><div class="mname"><b>${esc(u)}</b></div><span class="dim">request sent</span></div>
        <button class="small" data-act="friend-remove" data-v="${esc(u)}">Cancel</button></div>`).join('');
    const friendsBlock = !online ? `<div class="dim note">${esc(id.friendsNote || 'Friends need the online service, which is not set up for this build.')}</div>` : `
      <div class="joinrow"><input id="fadd" type="text" maxlength="${USERNAME_MAX}" value="${esc(this.friendDraft)}" placeholder="Add a friend by username" spellcheck="false" autocomplete="off" autocapitalize="off" />
        <button class="primary" data-act="friend-add" ${id.claimed ? '' : 'disabled'}>Add</button></div>
      ${this.friendNote ? `<div class="pnote ${this.friendNote.startsWith('✓') ? '' : 'bad'}">${esc(this.friendNote)}</div>` : ''}
      ${id.friendsNote ? `<div class="pnote bad">${esc(id.friendsNote)}</div>` : ''}
      ${incoming ? `<h3>Requests</h3><div class="members">${incoming}</div>` : ''}
      <h3>Friends <small class="dim">${f.friends.filter((x) => x.online).length} online · ${f.friends.length}</small></h3>
      <div class="members">${f.friends.map(friend).join('') || '<div class="dim note">No friends yet. Share your username, or add theirs above.</div>'}</div>
      ${outgoing ? `<h3>Sent</h3><div class="members">${outgoing}</div>` : ''}`;
    return `<div class="lobby-screen"><div class="card lobby-card profile-card">
      <div class="lobby-head"><button data-act="profile-back" class="back-btn">← Back</button><div><div class="kicker">PROFILE</div><h2>${esc(this.sel.name)}</h2></div></div>
      <h3>Username</h3>
      <p class="dim">Friends add you by it; it shows on the race leaderboard, over your car and on your number plate (up to ${PLATE_MAX} characters).
        ${online ? 'You can change it once every 30 days.' : ''}</p>
      ${this.unameField(draft)}
      <div class="dim note">${esc(status)}</div>
      <h3>Friends</h3>${friendsBlock}
    </div></div>`;
  }

  private copyLink() {
    if (!this.party) return;
    const link = this.party.link;
    const done = (ok: boolean) => { this.partyNote = ok ? 'Copied the invite link. Send it to your friends.' : 'Select the link and copy it.'; this.render(); };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(link).then(() => done(true), () => done(false));
    else { (document.getElementById('plink') as HTMLInputElement | null)?.select(); done(document.execCommand?.('copy') ?? false); }
  }
  private input(e: Event) {
    const t = e.target as HTMLInputElement;
    if (t.id === 'custom') { this.sel.paint[this.sel.car] = t.value; this.hooks.preview(); }   // live while dragging
    if (t.id === 'joincode') { const c = cleanCode(t.value); if (c !== t.value) t.value = c; this.joinCode = c; }
    if (t.id === 'uname') { this.unameDraft = t.value; void this.liveCheck(t.value); }
    if (t.id === 'fadd') this.friendDraft = t.value;
    if (t.type === 'range') this.ctl?.slide(t);
  }
  private change(e: Event) {
    const t = e.target as HTMLInputElement;
    if (t.id === 'custom') { this.save(); this.render(); }
  }
}
