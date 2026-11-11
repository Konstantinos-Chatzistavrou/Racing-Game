// Client for the online service (cloud/, a Cloudflare Worker): the online career's account, profile and purchases, and
// the race room every ranked race reports to. No passwords or e-mail: an account is a random id + secret token kept in
// this browser; the "recovery code" (both together) moves it to another device.
//
// URL: VITE_CLOUD_URL at build time; the dev server defaults to a local `wrangler dev` on :8787.
import type { Mods } from './garage';
import type { Custom } from './custom-data';

export interface Profile {
  id: string; name: string; username: string | null; usernameAt: number | null; xp: number; credits: number;
  cars: string[]; mods: Record<string, Mods>; skins: string[];
  /** the account's saved car looks: car id -> the garage's parts and colours */
  looks: Record<string, Custom>;
  clean: number; strikes: number; banned: boolean; created: number;
}

const KEY = 'nr.cloud.v1';
const envUrl = (import.meta as unknown as { env?: Record<string, string | boolean | undefined> }).env ?? {};
const BASE = String(envUrl.VITE_CLOUD_URL ?? (envUrl.DEV ? 'http://127.0.0.1:8787' : '')).replace(/\/$/, '');

/** seenAgo: ms since the friend's last heartbeat when the list was fetched (null = never; absent on an older server) */
export interface Friend { username: string; level: number; online: boolean; party: string | null; seenAgo?: number | null }
export interface Friends { friends: Friend[]; incoming: string[]; outgoing: string[] }

export class Cloud {
  readonly base = BASE;
  private acct: { id: string; token: string } | null = null;

  constructor() {
    try { const s = JSON.parse(localStorage.getItem(KEY) ?? 'null'); if (s?.id && s?.token) this.acct = s; } catch { /* blocked */ }
  }
  get available() { return !!this.base; }
  get id() { return this.acct?.id ?? ''; }
  /** The recovery code: paste it on another device (Settings) to use this account there. */
  get recoveryCode() { return this.acct ? `${this.acct.id}.${this.acct.token}` : ''; }
  restore(code: string) {
    const [id, token] = code.trim().split('.');
    if (!/^[a-z0-9]{8,32}$/i.test(id ?? '') || !/^[A-Za-z0-9_-]{20,128}$/.test(token ?? '')) return false;
    this.acct = { id, token };
    try { localStorage.setItem(KEY, JSON.stringify(this.acct)); } catch { /* blocked */ }
    return true;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.base) throw new Error('no online service');
    if (!this.acct && path !== '/v1/account') await this.create();
    const r = await fetch(this.base + path, {
      method, headers: { 'content-type': 'application/json', ...(this.acct ? { authorization: `Bearer ${this.acct.id}.${this.acct.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    return j as T;
  }

  private async create() {
    const j = await this.call<{ id: string; token: string }>('POST', '/v1/account', {});
    this.acct = { id: j.id, token: j.token };
    try { localStorage.setItem(KEY, JSON.stringify(this.acct)); } catch { /* blocked */ }
  }

  me() { return this.call<Profile>('GET', '/v1/me'); }
  /** Is that username free? (no account needed) */
  async usernameFree(u: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.base) throw new Error('no online service');
    const r = await fetch(`${this.base}/v1/username?u=${encodeURIComponent(u)}`);
    return r.json();
  }
  /** Claim / change this account's username (unique; the server checks the rules again). */
  claimUsername(username: string) { return this.call<Profile>('POST', '/v1/username', { username }); }
  friends() { return this.call<Friends>('GET', '/v1/friends'); }
  friend(username: string, action: 'add' | 'accept' | 'remove') { return this.call<{ ok: true; state: string }>('POST', '/v1/friends', { username, action }); }
  /** Heartbeat while the game is open: friends see you online, and your party (they can join it). */
  presence(party: string | null) { return this.call<{ ok: true }>('POST', '/v1/presence', { party: party ?? '' }); }
  buy(kind: 'car' | 'mod' | 'skin', id: string, stage?: number) { return this.call<Profile>('POST', '/v1/buy', { kind, id, stage }); }
  /** Keep this car's look with the account, so another device (and the other career) draws the same car. */
  saveLook(car: string, look: Custom) { return this.call<Profile>('POST', '/v1/look', { car, look }); }
  report(raceId: string, player: string, why: string) { return this.call<{ ok: true }>('POST', '/v1/report', { raceId, player, why }); }
  /** Upload the input recording of a race the server asked for (replay check). */
  replay(raceId: string, data: string) { return this.call<{ ok: true }>('POST', `/v1/replay/${encodeURIComponent(raceId)}`, { data }); }

  /** The race room of a party (WebSocket). */
  room(party: string): WebSocket {
    if (!this.acct) throw new Error('no account');
    const u = new URL(this.base.replace(/^http/, 'ws') + `/v1/room/${encodeURIComponent(party)}`);
    u.searchParams.set('auth', `${this.acct.id}.${this.acct.token}`);
    return new WebSocket(u);
  }
}
