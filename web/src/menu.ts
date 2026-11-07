// Front end: title, garage, game modes, party lobby, pause, results, countdown. Plain DOM over the
// live 3D scene (the canvas keeps rendering behind it: the car on the start line is the backdrop).
// main.ts owns the state machine; this file draws and reports choices through callbacks.
//
// Flow: title -> Play -> game modes (Race / Free Roam / Multiplayer)
//       title -> Garage (cars, paint, upgrades only) -> Main Menu, or Continue -> game modes
import { FINISHES, MODS, MOD_KEYS, SWATCHES, applyMods, modsOf, paintOf, saveSelection, statsOf,
  type CatalogCar, type Finish, type Mode, type ModKey, type Selection } from './garage';
import { formatLap } from './hud';
import { MAX_MEMBERS, cleanCode, type Party, type PartyMode } from './party';

export type Gfx = 'auto' | 'max' | 'ultra' | 'high' | 'medium' | 'low';
export type Screen = 'none' | 'title' | 'garage' | 'modes' | 'lobby' | 'pause' | 'results' | 'busy';
/** One line of the race standings. fin: finish time (s) or -1; d: distance covered (m). */
export interface Standing { name: string; you: boolean; fin: number; d: number; best: number; ai: boolean }
export interface ResultData { total: number; best: number; laps: number[]; laps_target: number; standings: Standing[]; routeLength: number; online: boolean }

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
  /** the shown screen changed (title <-> garage move the camera) */
  screen(s: Screen): void;
  /** garage camera preset */
  cam?(az: number, el: number, dist: number): void;
  partyCreate(): void;
  partyJoin(code: string): void;
  partyLeave(): void;
  partyMode(mode: PartyMode, laps: number): void;
  partyStart(): void;
  /** leader: everybody back to the lobby */
  partyLobby(): void;
  /** rejoin a free roam the party is already driving */
  partyRejoin(): void;
  /** our name changed */
  partyMe(): void;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const bar = (f: number) => `<i style="width:${Math.round(Math.max(0, Math.min(1, f)) * 100)}%"></i>`;
const hex = (n: number) => '#' + (n >>> 0 & 0xffffff).toString(16).padStart(6, '0');

/** Standings order: finished (by time), then by distance covered. */
export function rank(list: Standing[]) {
  return list.slice().sort((a, b) => {
    if ((a.fin >= 0) !== (b.fin >= 0)) return a.fin >= 0 ? -1 : 1;
    if (a.fin >= 0) return a.fin - b.fin;
    return b.d - a.d;
  });
}

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

  constructor(readonly sel: Selection, private cars: CatalogCar[], private physics: Record<string, unknown>, private hooks: MenuHooks) {
    this.root.addEventListener('click', (e) => this.click(e));
    this.root.addEventListener('input', (e) => this.input(e));
    this.root.addEventListener('change', (e) => this.change(e));
    this.root.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      if (e.key === 'Enter' && t.id === 'joincode') this.hooks.partyJoin(this.joinCode);
      e.stopPropagation();   // typing a name or code never drives the car
    });
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
    // don't rebuild under the cursor while someone types a name or code
    const focused = document.activeElement as HTMLInputElement | null;
    const keep = focused && this.root.contains(focused) && focused.tagName === 'INPUT' ? { id: focused.id, a: focused.selectionStart, b: focused.selectionEnd } : null;
    const leftScroll = this.root.querySelector('.g-left')?.scrollTop ?? 0;
    const rightScroll = this.root.querySelector('.g-right')?.scrollTop ?? 0;
    const html = {
      none: () => '', title: () => this.title(), garage: () => this.garage(), modes: () => this.modes(), lobby: () => this.lobby(),
      pause: () => this.pause(), results: () => (this.lastResults ? this.results(this.lastResults) : ''),
      busy: () => `<div class="card center"><div class="spin"></div><p>${esc(this.busyText)}</p></div>`,
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
    const g = (k: Gfx, label: string) => `<button class="chip ${this.gfx === k ? 'on' : ''}" data-act="gfx" data-v="${k}">${label}</button>`;
    const curCar = this.car();
    const dis = this.tuning ? 'disabled' : '';
    const invite = this.invite && !this.party ? `<div class="invite"><span>🏁 You're invited to party <b>${esc(this.invite)}</b></span>
        <button class="primary" data-act="invite" ${dis}>Join Party</button><button class="small" data-act="noinvite" aria-label="Dismiss">✕</button></div>` : '';
    return `${this.tuning ? '<div class="cover"><div class="card center"><div class="spin"></div><p>Calibrating WebGPU pipeline…</p><span class="dim">Optimizing resolution &amp; reflections for this display.</span></div></div>' : ''}
      <div class="title">
        <div class="kicker">1:1 NEW YORK CITY // PACEJKA MF 6.1</div>
        <div class="logo">OPEN<span>GRID</span></div>
        <div class="sub">1:1 Midtown Manhattan · Active vehicle: <b>${esc(curCar.name)}</b></div>
        ${invite}
        <div class="btnrow">
          <button class="primary huge" data-act="play" ${dis}>▶ Play</button>
          <button class="huge" data-act="garage-open" ${dis}>⚙ Garage</button>
        </div>
        <div class="gfx-panel">
          <div class="gfx"><span class="dim">GRAPHICS</span>${g('auto', 'Auto')}${g('max', 'Max')}${g('ultra', 'Ultra')}${g('high', 'High')}${g('medium', 'Medium')}${g('low', 'Low')}</div>
          <div class="dim note">${esc(this.gfxNote || 'WebGPU Clustered Forward+ · 240 Hz Physics')}</div>
        </div>
        <div class="btnrow util-row">
          <button class="small" data-act="bench" ${dis}>⏱ Benchmark</button>
          <button class="small" data-act="soak" ${dis}>🔥 Soak Test</button>
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
    const stat = (label: string, text: string, ref: number, f: number) =>
      `<div class="stat"><span>${label}</span><div class="bar">${bar(f)}${ref >= 0 ? `<u style="left:${Math.round(ref * 100)}%"></u>` : ''}</div><b>${text}</b></div>`;
    const stats = [
      stat('Power', `${Math.round(now.power)} kW`, base.power / 480, now.power / 480),
      stat('Grip', now.grip.toFixed(2) + ' µ', (base.grip - 1) / 0.7, (now.grip - 1) / 0.7),
      stat('Light', `${Math.round(now.mass)} kg`, (1700 - base.mass) / 500, (1700 - now.mass) / 500),
      stat('Downforce', `${now.downforce.toFixed(2)} m²`, base.downforce / 1.2, now.downforce / 1.2),
      stat('Power/wt', `${Math.round(now.ratio)} W/kg`, base.ratio / 400, now.ratio / 400),
    ].join('');
    const stages = MOD_KEYS.reduce((a, k) => a + mods[k], 0);
    return `<div class="garage">
      <div class="g-top">
        <div class="g-title">GARAGE <span>// UPGRADES &amp; PAINT</span></div>
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
        <button data-act="home" class="back-btn">← Main Menu</button>
        <div class="g-summary"><b>${esc(this.car().name)}</b><span class="dim">${stages ? `${stages} upgrade stage${stages > 1 ? 's' : ''} fitted` : 'Stock'} · ${FINISHES[sel.finish].label} paint · ${Math.round(now.power)} kW · ${Math.round(now.mass)} kg</span></div>
        <button class="primary huge go" data-act="play">Continue ▶</button>
      </div>
    </div>`;
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
          <p class="dim">Start mid-pack through Midtown. Rivals take their own lines and fight for position. Finish ahead of them all.</p>
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
    const nameRow = `<label class="field"><span class="dim">YOUR NAME</span><input id="pname" type="text" maxlength="18" value="${esc(sel.name)}" placeholder="Driver" spellcheck="false" autocomplete="off" /></label>`;
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
        <i class="dot" style="background:${hex(m.paint)}"></i>
        <div class="mtext"><div class="mname"><b>${esc(m.name)}</b>${m.host ? '<span class="pill gold">LEADER</span>' : ''}${m.id === p.selfId ? '<span class="pill">YOU</span>' : ''}</div>
        <span class="dim">${esc(carName(m.car))} · <span class="mstate ${m.ready ? 'ok' : ''}">${p.phase === 'loading' ? (m.ready ? 'on the grid' : 'loading…') : p.phase === 'driving' ? 'driving' : 'in lobby'}</span></span></div>
      </div>`).join('');
    const empty = Array.from({ length: Math.max(0, MAX_MEMBERS - p.members.length) }, () => '<div class="member empty"><i class="dot"></i><div class="mtext"><span class="dim">Open slot</span></div></div>').join('');
    const modeChip = (m: PartyMode, label: string) => `<button class="chip ${p.mode === m ? 'on' : ''}" data-act="pmode" data-v="${m}" ${p.isHost ? '' : 'disabled'}>${label}</button>`;
    const lapChip = (n: number) => `<button class="chip ${p.laps === n ? 'on' : ''}" data-act="plaps" data-v="${n}" ${p.isHost ? '' : 'disabled'}>${n}</button>`;
    const rules = `<div class="opts"><span class="dim">MODE</span>${modeChip('race', 'Race')}${modeChip('free', 'Free Roam')}
      ${p.mode === 'race' ? `<span class="dim sep">LAPS</span>${[1, 3, 5, 10].map(lapChip).join('')}` : ''}</div>`;
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
         <button data-act="pleave">${p!.isHost ? 'Close Party' : 'Leave Party'}</button>`
      : `<button class="primary" data-act="resume">▶ Resume Driving</button>
         <button data-act="restart">↻ Restart ${this.sel.mode === 'race' ? 'Race' : 'Session'}</button>
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
    const btns = r.online
      ? (p?.isHost ? '<button class="primary" data-act="plobby">↩ Everyone to Lobby</button>' : '<span class="dim wait">Waiting for the leader…</span>') + `<button data-act="pleave">${p?.isHost ? 'Close Party' : 'Leave Party'}</button>`
      : '<button class="primary" data-act="restart">↻ Race Again</button><button data-act="quit-modes">Game Modes</button><button data-act="quit">Main Menu</button>';
    return `<div class="card center results-card">
      <div class="kicker">${r.online ? 'PARTY RACE' : 'RACE'} RESULT</div>
      <h2>${ranked.length > 1 ? `You finished ${ord(pos)}` : 'Race Complete'}</h2>
      <div class="big ${pos === 1 ? 'win' : ''}">${ranked.length > 1 ? `P${pos}<small> / ${ranked.length}</small>` : formatLap(r.total)}</div>
      <div class="dim">${formatLap(r.total)} · ${r.laps_target} lap${r.laps_target > 1 ? 's' : ''} · Best lap <b class="best-inline">${formatLap(r.best)}</b></div>
      ${table}
      <div class="rows">${rows}</div>
      <div class="btns">${btns}</div>
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
    const act = b.dataset.act!;
    if (['play', 'garage-open', 'start-race', 'start-free', 'pstart', 'invite', 'prejoin'].includes(act)) this.askFullscreen();
    const v = b.dataset.v ?? '', sel = this.sel;
    switch (act) {
      case 'play': this.show('modes'); break;
      case 'garage-open': this.show('garage'); this.hooks.preview(); break;
      case 'home': this.show('title'); break;
      case 'modes': this.show('modes'); break;
      case 'quit-modes': this.lastResults = null; this.hooks.quit('modes'); break;
      case 'lobby': this.partyNote = ''; this.show('lobby'); break;
      case 'gfx': this.gfx = v as Gfx; this.hooks.gfx(this.gfx); this.render(); break;
      case 'car': sel.car = v; this.save(); this.render(); this.hooks.preview(); break;
      case 'paint': sel.paint[sel.car] = v; this.save(); this.render(); this.hooks.preview(); break;
      case 'finish': sel.finish = v as Finish; this.save(); this.render(); this.hooks.preview(); break;
      case 'mod': { const m = { ...modsOf(sel) }; m[b.dataset.k as ModKey] = Number(v); sel.mods[sel.car] = m; this.save(); this.render(); break; }
      case 'laps': sel.laps = Number(v); this.save(); this.render(); break;
      case 'start-race': sel.mode = 'race'; this.save(); this.hooks.play('race'); break;
      case 'start-free': sel.mode = 'free'; this.save(); this.hooks.play('free'); break;
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
      case 'pmode': this.party && this.hooks.partyMode(v as PartyMode, this.party.laps); break;
      case 'plaps': this.party && this.hooks.partyMode(this.party.mode, Number(v)); break;
      case 'pstart': this.hooks.partyStart(); break;
      case 'plobby': this.hooks.partyLobby(); break;
      case 'prejoin': this.hooks.partyRejoin(); break;
      case 'pcopy': this.copyLink(); break;
      case 'pshare': if (this.party) navigator.share?.({ title: 'OpenGrid party', text: `Join my OpenGrid party (code ${this.party.code})`, url: this.party.link }).catch(() => {}); break;
    }
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
    if (t.id === 'pname') this.sel.name = t.value.slice(0, 18);
  }
  private change(e: Event) {
    const t = e.target as HTMLInputElement;
    if (t.id === 'custom') { this.save(); this.render(); }
    if (t.id === 'pname') { this.sel.name = t.value.trim().slice(0, 18) || 'Driver'; this.save(); this.hooks.partyMe(); }
  }
}
