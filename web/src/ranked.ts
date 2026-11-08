// A party race's link to the online service's race room (cloud/src/room.ts). The room times the race from the
// positions sent here (4 Hz), runs its checks, and pays the online career; this side only reports what the car does.
// Opened when a party race session loads (so joining is done before the start); the host's GO starts the clock.
import type { Cloud, Profile } from './cloud';

export interface RankedResult {
  raceId: string; ranked: boolean; counted: number;
  table: { id: string; name: string; pos: number; finished: boolean; dnf: boolean; timeMs: number; why: string; flagged: boolean }[];
  you?: { pos: number; finished: boolean; xp: number; cr: number; parts: { label: string; xp: number }[]; notes: string[]; replay: boolean };
  profile: Profile | null;
}

export class RankedLink {
  private ws: WebSocket | null = null;
  private lastSent = 0;
  private open = false;
  private queue: string[] = [];
  raceId = '';
  status = 'connecting';
  onResult: (r: RankedResult) => void = () => {};
  onStatus: () => void = () => {};

  constructor(cloud: Cloud, party: string, join: { car: string; assistsOff: number; manual: boolean; host: boolean }) {
    try { this.ws = cloud.room(party); } catch { this.status = 'offline'; return; }
    this.ws.addEventListener('open', () => { this.open = true; this.status = 'connected'; this.send({ t: 'join', ...join }); for (const m of this.queue.splice(0)) this.ws?.send(m); this.onStatus(); });
    this.ws.addEventListener('message', (e) => {
      let m: Record<string, unknown>;
      try { m = JSON.parse(String(e.data)); } catch { return; }
      if (m.t === 'race') { this.raceId = String(m.id); this.status = 'racing'; this.onStatus(); }
      if (m.t === 'result') { this.status = 'done'; this.onResult(m as unknown as RankedResult); this.close(); }
      if (m.t === 'error') { this.status = String(m.error); this.onStatus(); }
    });
    this.ws.addEventListener('close', () => { this.open = false; if (this.status !== 'done') { this.status = 'disconnected'; this.onStatus(); } });
  }

  private send(m: unknown) {
    const s = JSON.stringify(m);
    if (this.open) this.ws?.send(s); else if (this.queue.length < 8) this.queue.push(s);
  }
  /** host, at GO */
  start(laps: number, route: 'nyc' | 'city', realism: boolean) { this.send({ t: 'start', laps, route, realism }); }
  /** every frame while racing (sent at 4 Hz): body centre in three.js coordinates, speed m/s */
  pos(now: number, p: { x: number; y: number; z: number }, v: number) {
    if (now - this.lastSent < 250 || !this.raceId) return;
    this.lastSent = now;
    const r = (x: number) => Math.round(x * 100) / 100;
    this.send({ t: 'pos', x: r(p.x), y: r(p.y), z: r(p.z), v: r(v) });
  }
  reset() { this.send({ t: 'reset' }); this.lastSent = 0; }
  dnf(why: string) { this.send({ t: 'dnf', why }); }
  close() { try { this.ws?.close(); } catch { /* closed */ } this.ws = null; }
}
