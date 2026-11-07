// Multiplayer parties: no game server. Players connect peer to peer over WebRTC (PeerJS); the
// public PeerJS broker (0.peerjs.com) only introduces them, PeerJS's STUN/TURN servers get them
// through home routers. The party leader's browser is the hub: everyone else connects to it and it
// forwards what each player sends (car pose, race progress) to the rest.
//
// Create a party -> a 5-letter code and an invite link (…/?party=CODE). Friends open the link (or
// type the code) and land in the leader's lobby. The leader picks Free Roam or a Race and starts;
// everyone loads, the leader waits until all are on the grid, then sends GO (race: 3-2-1 together).
// ?peer=host:port[/path] uses your own PeerJS server instead of the public one (see server/).
import Peer, { type DataConnection, type PeerOptions } from 'peerjs';

export const MAX_MEMBERS = 6;
const PREFIX = 'opengrid-v1-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O, 1/I: easy to read out
const LOAD_TIMEOUT_MS = 20000;
const BROKER_TRIES = 4;          // the public broker drops connections now and then: try again before giving up
const brokerTrouble = (type?: string) => type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed';

export interface Member { id: string; name: string; car: string; paint: number; host: boolean; ready: boolean }
export type PartyMode = 'free' | 'race';
export type Phase = 'lobby' | 'loading' | 'driving';
/** Car pose (body centre) and velocity (m/s, optional: older senders and heartbeats of a parked car). */
export interface Pose { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number; vx?: number; vy?: number; vz?: number }
/** Race progress: distance along the route (m), laps done, finish time (s, -1 still racing), out of the race (1 = DNF). */
export interface Progress { d: number; lap: number; fin: number; best: number; dnf?: number }

type Msg =
  | { t: 'hello'; name: string; car: string; paint: number }
  | { t: 'lobby'; members: Member[]; mode: PartyMode; laps: number; realism: boolean; phase: Phase }
  | { t: 'start'; mode: PartyMode; laps: number; realism: boolean }
  | { t: 'loaded' }
  | { t: 'go' }
  | { t: 'lobbyback' }
  | { t: 'pose'; id?: string; p: Pose; c?: number }
  | { t: 'prog'; id?: string; g: Progress }
  | { t: 'gone'; id?: string }
  | { t: 'pole'; id?: string; x: number; y: number; vx: number; vz: number }
  | { t: 'bye'; reason: string };

export interface PartyHooks {
  /** members, mode, laps or phase changed */
  changed(): void;
  /** the leader started a session: load it, then call loaded() */
  start(mode: PartyMode, laps: number): void;
  /** everyone is loaded: drive (race: 3-2-1) */
  go(): void;
  /** the leader went back to the lobby */
  lobby(): void;
  pose(id: string, p: Pose, paint: number | undefined): void;
  progress(id: string, g: Progress): void;
  left(id: string): void;
  /** a player left the session (back to the lobby): take their car off the road */
  gone(id: string): void;
  /** a player knocked down the pole at (x, y) (game frame) driving at (vx, vz) */
  pole(x: number, y: number, vx: number, vz: number): void;
  /** the party is over for us (leader left, kicked, network gone) */
  closed(reason: string): void;
}

const noop: PartyHooks = { changed() {}, start() {}, go() {}, lobby() {}, pose() {}, progress() {}, left() {}, gone() {}, pole() {}, closed() {} };

export function newCode() {
  let s = '';
  const r = crypto.getRandomValues(new Uint32Array(5));
  for (const v of r) s += CODE_CHARS[v % CODE_CHARS.length];
  return s;
}
export const cleanCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
export const inviteLink = (code: string) => {
  const peer = new URLSearchParams(location.search).get('peer');   // own broker: friends must use the same one
  return `${location.origin}${location.pathname}?party=${code}${peer ? `&peer=${encodeURIComponent(peer)}` : ''}`;
};

function peerOptions(): PeerOptions {
  const q = new URLSearchParams(location.search).get('peer');
  if (!q) return { debug: 1 };
  const m = /^(wss?:\/\/|https?:\/\/)?([^/:]+)(?::(\d+))?(\/.*)?$/.exec(q);
  if (!m) return { debug: 1 };
  const secure = m[1] ? /^(wss|https)/.test(m[1]) : location.protocol === 'https:';
  return { debug: 1, host: m[2], port: Number(m[3]) || (secure ? 443 : 80), path: m[4] || '/', secure };
}

const finite = (o: Record<string, unknown>, keys: string[]) => keys.every((k) => typeof o[k] === 'number' && Number.isFinite(o[k] as number));
const POSE_KEYS = ['x', 'y', 'z', 'qx', 'qy', 'qz', 'qw'];
/** Pose with finite numbers; velocity dropped if it isn't (or is absurd). */
function cleanPose(p: unknown): Pose | null {
  if (!p || typeof p !== 'object' || !finite(p as Record<string, unknown>, POSE_KEYS)) return null;
  const q = p as Pose;
  const out: Pose = { x: q.x, y: q.y, z: q.z, qx: q.qx, qy: q.qy, qz: q.qz, qw: q.qw };
  if (finite(p as Record<string, unknown>, ['vx', 'vy', 'vz']) && Math.hypot(q.vx!, q.vy!, q.vz!) < 150) { out.vx = q.vx; out.vy = q.vy; out.vz = q.vz; }
  return out;
}
const cleanName = (s: unknown) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 18) : '') || 'Driver';

export class Party {
  members: Member[] = [];
  mode: PartyMode = 'race';
  laps = 3;
  /** race rules (the leader's): full realism (no resets, DNF + spectate) or respawns */
  realism = true;
  phase: Phase = 'lobby';
  hooks: PartyHooks = noop;
  private conns = new Map<string, DataConnection>();   // leader: every member's connection; member: the leader's
  private loaded = new Set<string>();
  private loadTimer = 0;
  private closed = false;

  private constructor(private peer: Peer, readonly code: string, readonly isHost: boolean) {
    peer.on('disconnected', () => { if (!this.closed) peer.reconnect(); });   // broker link only: peers stay connected
    peer.on('error', (e) => {
      const type = (e as { type?: string }).type;
      if (type === 'network' || type === 'server-error') return;     // broker trouble: existing connections keep working
      if (!this.isHost && (type === 'peer-unavailable')) this.end('The party is gone (the leader left).');
    });
  }

  get selfId() { return this.peer.id; }
  get host() { return this.members.find((m) => m.host); }
  get link() { return inviteLink(this.code); }

  /** New party with us as leader. Rejects if the broker can't be reached. */
  static create(me: { name: string; car: string; paint: number }): Promise<Party> {
    return new Promise((resolve, reject) => {
      let tries = 0;
      const attempt = () => {
        const code = newCode();
        const peer = new Peer(PREFIX + code, peerOptions());
        const fail = (e: unknown) => {
          const type = (e as { type?: string }).type;
          peer.destroy();
          if ((type === 'unavailable-id' || brokerTrouble(type)) && ++tries < BROKER_TRIES) setTimeout(attempt, brokerTrouble(type) ? 1200 * tries : 0);   // code taken / broker hiccup: again
          else reject(new Error(brokerTrouble(type) ? 'Cannot reach the matchmaking service. Check your connection and try again.' : String((e as Error).message ?? e)));
        };
        peer.once('error', fail);
        peer.once('open', () => {
          peer.off('error', fail);
          const p = new Party(peer, code, true);
          p.members = [{ id: peer.id, name: cleanName(me.name), car: me.car, paint: me.paint, host: true, ready: true }];
          peer.on('connection', (c) => p.accept(c));
          resolve(p);
        });
      };
      attempt();
    });
  }

  /** Join a friend's party by code. Rejects if it doesn't exist, is full or is mid-session. */
  static async join(code: string, me: { name: string; car: string; paint: number }): Promise<Party> {
    code = cleanCode(code);
    for (let tries = 1; ; tries++) {
      try { return await Party.joinOnce(code, me); } catch (e) {
        if (!(e as { broker?: boolean }).broker || tries >= BROKER_TRIES) throw e;
        await new Promise((r) => setTimeout(r, 1200 * tries));
      }
    }
  }
  private static joinOnce(code: string, me: { name: string; car: string; paint: number }): Promise<Party> {
    return new Promise((resolve, reject) => {
      const peer = new Peer(peerOptions());
      let settled = false;
      const fail = (msg: string, broker = false) => { if (settled) return; settled = true; clearTimeout(timer); peer.destroy(); reject(Object.assign(new Error(msg), { broker })); };
      const timer = setTimeout(() => fail('No answer from that party. Check the code, or ask the leader to send a new invite.'), 15000);
      peer.once('error', (e) => {
        const type = (e as { type?: string }).type;
        fail(type === 'peer-unavailable' ? `There is no party ${code}. Check the code.` : brokerTrouble(type) ? 'Cannot reach the matchmaking service. Check your connection and try again.' : String((e as Error).message ?? e), brokerTrouble(type));
      });
      peer.once('open', () => {
        const c = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
        const p = new Party(peer, code, false);
        c.on('open', () => c.send({ t: 'hello', name: cleanName(me.name), car: me.car, paint: me.paint } satisfies Msg));
        c.on('data', (d) => {
          const m = d as Msg;
          if (!settled) {
            if (m?.t === 'bye') { fail(m.reason); return; }
            if (m?.t !== 'lobby') return;
            settled = true; clearTimeout(timer);
            p.conns.set(c.peer, c);
            c.on('close', () => p.end('Lost the connection to the party leader.'));
            resolve(p);
          }
          p.onData(c, m);
        });
        c.on('error', () => fail('Could not connect to that party.'));
      });
    });
  }

  // ---- leader --------------------------------------------------------------------------------
  private accept(c: DataConnection) {
    c.on('data', (d) => this.onData(c, d as Msg));
    c.on('close', () => this.drop(c.peer));
    c.on('error', () => this.drop(c.peer));
  }

  private drop(id: string) {
    if (!this.conns.delete(id)) return;
    this.members = this.members.filter((m) => m.id !== id);
    this.loaded.delete(id);
    this.hooks.left(id);
    this.broadcast({ t: 'lobby', members: this.members, mode: this.mode, laps: this.laps, realism: this.realism, phase: this.phase });
    this.hooks.changed();
    this.checkLoaded();
  }

  /** Leader: race or free roam, number of laps, realism (no resets) or respawns. */
  setMode(mode: PartyMode, laps: number, realism = this.realism) {
    if (!this.isHost || this.phase !== 'lobby') return;
    this.mode = mode; this.laps = laps; this.realism = realism;
    this.pushLobby();
  }

  /** Leader: everyone loads the session. */
  start() {
    if (!this.isHost || this.phase !== 'lobby') return;
    this.phase = 'loading';
    this.loaded.clear();
    for (const m of this.members) m.ready = false;
    this.broadcast({ t: 'start', mode: this.mode, laps: this.laps, realism: this.realism });
    this.pushLobby();
    this.hooks.start(this.mode, this.laps);
    clearTimeout(this.loadTimer);
    this.loadTimer = window.setTimeout(() => this.release(), LOAD_TIMEOUT_MS);   // a slow loader doesn't hold everyone forever
  }

  /** Leader: everybody back to the lobby (after a race, or to change the mode). */
  backToLobby() {
    if (!this.isHost) return;
    clearTimeout(this.loadTimer);
    this.phase = 'lobby';
    for (const m of this.members) m.ready = true;
    this.broadcast({ t: 'lobbyback' });
    this.pushLobby();
  }

  private checkLoaded() {
    if (this.isHost && this.phase === 'loading' && this.members.every((m) => this.loaded.has(m.id))) this.release();
  }
  private release() {
    if (this.phase !== 'loading') return;
    clearTimeout(this.loadTimer);
    this.phase = 'driving';
    this.broadcast({ t: 'go' });
    this.pushLobby();
    this.hooks.go();
  }

  private pushLobby() {
    this.broadcast({ t: 'lobby', members: this.members, mode: this.mode, laps: this.laps, realism: this.realism, phase: this.phase });
    this.hooks.changed();
  }

  private broadcast(m: Msg, except?: string) {
    for (const [id, c] of this.conns) if (id !== except && c.open) c.send(m);
  }

  // ---- both -----------------------------------------------------------------------------------
  /** We finished loading the session. */
  ready() {
    if (this.isHost) { this.loaded.add(this.selfId); const me = this.members.find((m) => m.id === this.selfId); if (me) me.ready = true; this.pushLobby(); this.checkLoaded(); }
    else this.sendHost({ t: 'loaded' });
  }

  /** Our name, car or paint changed. */
  updateMe(me: { name: string; car: string; paint: number }) {
    if (this.isHost) {
      const m = this.members.find((x) => x.id === this.selfId);
      if (m) { m.name = cleanName(me.name); m.car = me.car; m.paint = me.paint; }
      this.pushLobby();
    } else this.sendHost({ t: 'hello', name: cleanName(me.name), car: me.car, paint: me.paint });
  }

  sendPose(p: Pose, paint: number) {
    const m: Msg = { t: 'pose', p, c: paint };
    if (this.isHost) this.broadcast({ ...m, id: this.selfId });
    else this.sendHost(m);
  }
  sendProgress(g: Progress) {
    const m: Msg = { t: 'prog', g };
    if (this.isHost) this.broadcast({ ...m, id: this.selfId });
    else this.sendHost(m);
  }

  /** We knocked down a pole: it falls for everyone. */
  sendPole(x: number, y: number, vx: number, vz: number) {
    const m: Msg = { t: 'pole', x, y, vx, vz };
    if (this.isHost) this.broadcast({ ...m, id: this.selfId });
    else this.sendHost(m);
  }

  /** We left the session (lobby, menu): the others take our car off the road. */
  sendGone() {
    if (this.isHost) this.broadcast({ t: 'gone', id: this.selfId });
    else this.sendHost({ t: 'gone' });
  }

  private sendHost(m: Msg) {
    for (const c of this.conns.values()) if (c.open) c.send(m);
  }

  private onData(c: DataConnection, m: Msg) {
    if (!m || typeof m !== 'object' || this.closed) return;
    if (this.isHost) {
      const from = c.peer;
      switch (m.t) {
        case 'hello': {
          let mem = this.members.find((x) => x.id === from);
          if (!mem) {
            if (this.members.length >= MAX_MEMBERS) { c.send({ t: 'bye', reason: `That party is full (${MAX_MEMBERS} players).` } satisfies Msg); setTimeout(() => c.close(), 300); return; }
            if (this.phase !== 'lobby') { c.send({ t: 'bye', reason: 'That party is mid-race. Try again when they are back in the lobby.' } satisfies Msg); setTimeout(() => c.close(), 300); return; }
            mem = { id: from, name: '', car: '', paint: 0, host: false, ready: true };
            this.members.push(mem);
            this.conns.set(from, c);
          }
          mem.name = cleanName(m.name);
          mem.car = typeof m.car === 'string' ? m.car.slice(0, 32) : '';
          mem.paint = Number.isInteger(m.paint) && m.paint >= 0 && m.paint <= 0xffffff ? m.paint : 0;
          this.pushLobby();
          break;
        }
        case 'loaded': {
          if (!this.conns.has(from)) return;
          this.loaded.add(from);
          const mem = this.members.find((x) => x.id === from);
          if (mem) mem.ready = true;
          this.pushLobby();
          this.checkLoaded();
          break;
        }
        case 'pose': {
          const p = cleanPose(m.p);
          if (!this.conns.has(from) || !p) return;
          this.broadcast({ t: 'pose', id: from, p, c: m.c }, from);
          this.hooks.pose(from, p, m.c);
          break;
        }
        case 'prog':
          if (!this.conns.has(from) || !m.g || !finite(m.g as unknown as Record<string, unknown>, ['d', 'lap', 'fin', 'best'])) return;
          this.broadcast({ t: 'prog', id: from, g: m.g }, from);
          this.hooks.progress(from, m.g);
          break;
        case 'pole':
          if (!this.conns.has(from) || !finite(m as unknown as Record<string, unknown>, ['x', 'y', 'vx', 'vz'])) return;
          this.broadcast({ t: 'pole', id: from, x: m.x, y: m.y, vx: m.vx, vz: m.vz }, from);
          this.hooks.pole(m.x, m.y, m.vx, m.vz);
          break;
        case 'gone':
          if (!this.conns.has(from)) return;
          this.broadcast({ t: 'gone', id: from }, from);
          this.hooks.gone(from);
          break;
      }
      return;
    }
    // member: everything comes from the leader
    switch (m.t) {
      case 'lobby':
        if (!Array.isArray(m.members)) return;
        this.members = m.members.map((x) => ({ ...x, name: cleanName(x.name) }));
        this.mode = m.mode === 'free' ? 'free' : 'race';
        this.laps = Number(m.laps) || 3;
        this.realism = m.realism !== false;
        this.phase = m.phase;
        this.hooks.changed();
        break;
      case 'start': this.mode = m.mode === 'free' ? 'free' : 'race'; this.laps = Number(m.laps) || 3; this.realism = m.realism !== false; this.phase = 'loading'; this.hooks.start(this.mode, this.laps); break;
      case 'go': this.phase = 'driving'; this.hooks.go(); break;
      case 'lobbyback': this.phase = 'lobby'; this.hooks.lobby(); break;
      case 'pose': { const p = cleanPose(m.p); if (m.id && m.id !== this.selfId && p) this.hooks.pose(m.id, p, m.c); break; }
      case 'prog': if (m.id && m.id !== this.selfId && m.g) this.hooks.progress(m.id, m.g); break;
      case 'gone': if (m.id && m.id !== this.selfId) this.hooks.gone(m.id); break;
      case 'pole': if (m.id !== this.selfId && finite(m as unknown as Record<string, unknown>, ['x', 'y', 'vx', 'vz'])) this.hooks.pole(m.x, m.y, m.vx, m.vz); break;
      case 'bye': this.end(m.reason); break;
    }
  }

  private end(reason: string) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.loadTimer);
    const h = this.hooks;
    this.hooks = noop;
    try { this.peer.destroy(); } catch { /* gone */ }
    h.closed(reason);
  }

  /** Leave (a leader leaving ends the party for everyone). */
  leave() {
    if (this.closed) return;
    if (this.isHost) this.broadcast({ t: 'bye', reason: 'The party leader closed the party.' });
    this.closed = true;
    clearTimeout(this.loadTimer);
    this.hooks = noop;
    // give the goodbye a moment to go out before the connections drop
    setTimeout(() => { try { this.peer.destroy(); } catch { /* gone */ } }, 200);
  }
}
