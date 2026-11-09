// The two careers (progression.ts has the rules):
//   SpCareer  single player, this device: XP only; a level unlocks cars, upgrade stages and driver gear.
//   MpCareer  online, kept by the server (cloud.ts): XP and credits from ranked races; a level makes an item buyable,
//             credits pay for it. This class only shows the server's profile and asks it to buy things.
// Both answer the same questions for the menus: is it mine, what does it need, get it.
import { CAR_REQ, MOD_REQ, SKIN_REQ, STARTER_CAR, levelOf, xpToNext, type Career as CareerKind, type Req } from './progression';
import { MOD_KEYS, type CatalogCar, type ModKey, type Selection } from './garage';
import { SKINS } from './scene/driver';
import type { Cloud, Profile } from './cloud';

export const fmt = (n: number) => `${Math.round(n).toLocaleString('en-US')} Cr`;
export const fmtXp = (n: number) => `${Math.round(n).toLocaleString('en-US')} XP`;

/** What the last session earned (shown on the title / results). */
export interface Earned { xp: number; cr: number; reason: string; parts?: { label: string; xp: number }[]; levelUp?: number; unlocked?: string[] }

export interface Career {
  readonly kind: CareerKind;
  readonly xp: number;
  readonly credits: number;
  readonly ready: boolean;        // online: profile loaded
  readonly note: string;          // online: why it is not ready
  last: Earned | null;
  owns(car: string): boolean;
  stage(car: string, k: ModKey): number;
  ownsSkin(id: string): boolean;
  /** what an item needs, for the shop */
  req(kind: 'car' | 'mod' | 'skin', id: string, stage?: number): Req;
  buy(kind: 'car' | 'mod' | 'skin', id: string, stage?: number): Promise<string>;
  /** the selection may only use what this career has (fallbacks) */
  fit(sel: Selection): void;
}

const reqOf = (kind: 'car' | 'mod' | 'skin', id: string, stage = 1): Req =>
  kind === 'car' ? CAR_REQ[id] ?? { spLevel: 1, mpLevel: 1, price: 0 }
  : kind === 'skin' ? SKIN_REQ[id] ?? { spLevel: 1, mpLevel: 1, price: 0 }
  : MOD_REQ[id as ModKey]?.[stage - 1] ?? { spLevel: 99, mpLevel: 99, price: 0 };

const fitSel = (c: Career, sel: Selection) => {
  if (!c.owns(sel.car)) sel.car = STARTER_CAR;
  if (!c.ownsSkin(sel.skin)) sel.skin = SKINS[0].id;
  for (const [car, m] of Object.entries(sel.mods)) for (const k of MOD_KEYS) m[k] = Math.min(m[k], c.stage(car, k));
};

// ---- single player ----------------------------------------------------------------------------------------------------
const SP_KEY = 'nr.sp.v1';
export class SpCareer implements Career {
  readonly kind = 'sp' as const;
  readonly credits = 0;
  readonly ready = true;
  readonly note = '';
  last: Earned | null = null;
  private data = { xp: 0 };

  constructor(private unlockAll = false) {
    try {
      const s = JSON.parse(localStorage.getItem(SP_KEY) ?? 'null');
      if (s && Number.isFinite(s.xp)) this.data.xp = Math.max(0, Math.floor(s.xp));
      else this.migrate();
    } catch { /* storage blocked */ }
  }

  /** Players of the one-day credits shop keep the best car they bought: they start at the level that unlocks it. */
  private migrate() {
    try {
      const w = JSON.parse(localStorage.getItem('nr.wallet.v2') ?? 'null');
      const need = Math.max(1, ...((w?.cars ?? []) as string[]).map((c) => CAR_REQ[c]?.spLevel ?? 1));
      let xp = 0;
      for (let l = 1; l < need; l++) xp += xpToNext(l);
      this.data.xp = xp;
      this.save();
    } catch { /* nothing to migrate */ }
  }

  private save() { try { localStorage.setItem(SP_KEY, JSON.stringify(this.data)); } catch { /* blocked */ } }
  get xp() { return this.unlockAll ? 10_000_000 : this.data.xp; }
  get level() { return levelOf(this.xp).level; }
  owns(car: string) { return this.level >= reqOf('car', car).spLevel; }
  stage(_car: string, k: ModKey) { return MOD_REQ[k].filter((r) => r.spLevel <= this.level).length; }
  ownsSkin(id: string) { return this.level >= reqOf('skin', id).spLevel; }
  req = reqOf;
  async buy(kind: 'car' | 'mod' | 'skin', id: string, stage?: number) {
    const r = reqOf(kind, id, stage);
    return this.level >= r.spLevel ? '' : `Unlocks at level ${r.spLevel} in single player.`;
  }
  fit(sel: Selection) { fitSel(this, sel); }

  /** Add XP; returns what it did (level-ups, newly unlocked items) and remembers it for the menus. */
  /** Spend reputation: an impound fine, or paying to lay low (docs/design/heat-and-cops.md). */
  penalty(xp: number): number {
    this.data.xp = Math.max(0, this.data.xp - Math.max(0, Math.round(xp)));
    try { localStorage.setItem(SP_KEY, JSON.stringify(this.data)); } catch { /* blocked */ }
    (this as { onChange?: () => void }).onChange?.();
    return this.data.xp;
  }

  earn(xp: number, reason: string, parts?: Earned['parts']): Earned {
    const before = this.level;
    this.data.xp += Math.max(0, Math.round(xp));
    this.save();
    const after = this.level, unlocked: string[] = [];
    if (after > before) {
      for (const [id, r] of Object.entries(CAR_REQ)) if (r.spLevel > before && r.spLevel <= after) unlocked.push(`car:${id}`);
      for (const [id, r] of Object.entries(SKIN_REQ)) if (r.spLevel > before && r.spLevel <= after) unlocked.push(`skin:${id}`);
      for (const k of MOD_KEYS) MOD_REQ[k].forEach((r, i) => { if (r.spLevel > before && r.spLevel <= after) unlocked.push(`mod:${k}:${i + 1}`); });
    }
    this.last = { xp: Math.round(xp), cr: 0, reason, parts, levelUp: after > before ? after : undefined, unlocked };
    return this.last;
  }
}

// ---- online --------------------------------------------------------------------------------------------------------------
export class MpCareer implements Career {
  readonly kind = 'mp' as const;
  last: Earned | null = null;
  profile: Profile | null = null;
  note = 'Connecting to the online service…';
  onChange = () => {};

  constructor(readonly cloud: Cloud, private catalog: CatalogCar[]) {}

  get ready() { return !!this.profile; }
  get xp() { return this.profile?.xp ?? 0; }
  get credits() { return this.profile?.credits ?? 0; }
  get level() { return levelOf(this.xp).level; }
  owns(car: string) { return car === STARTER_CAR || !!this.profile?.cars.includes(car); }
  stage(car: string, k: ModKey) { return this.profile?.mods[car]?.[k] ?? 0; }
  ownsSkin(id: string) { return id === SKINS[0].id || !!this.profile?.skins.includes(id); }
  req = reqOf;
  fit(sel: Selection) { if (this.profile) fitSel(this, sel); }

  /** Load (and on first use create) the online account. */
  async refresh() {
    if (!this.cloud.available) { this.note = 'The online service is not set up for this build.'; this.onChange(); return; }
    try { this.profile = await this.cloud.me(); this.note = ''; }
    catch (e) { this.note = `Online service unreachable: ${(e as Error).message}`; }
    this.onChange();
  }

  async buy(kind: 'car' | 'mod' | 'skin', id: string, stage?: number) {
    if (!this.profile) return this.note;
    const r = reqOf(kind, id, stage);
    if (this.level < r.mpLevel) return `Needs online level ${r.mpLevel}.`;
    try {
      this.profile = await this.cloud.buy(kind, id, stage);
      this.onChange();
      const name = kind === 'car' ? this.catalog.find((c) => c.id === id)?.name ?? id : kind === 'skin' ? (SKINS.find((s) => s.id === id)?.name ?? id) + ' gear' : 'Upgrade';
      return `✓ ${name} bought.`;
    } catch (e) { return (e as Error).message; }
  }

  /** The server paid a race (from the race room's result message). */
  paid(e: Earned, profile: Profile) { this.profile = profile; this.last = e; this.onChange(); }
}
