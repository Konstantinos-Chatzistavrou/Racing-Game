// Credits, owned cars and owned upgrade stages (localStorage). Earned by racing (by finishing position, more for
// longer races) and by driving in free roam; spent in the Shop. Paint and finishes are free.
//
// A new player starts with the Vela GT and STARTING_CREDITS. A player from before the shop existed keeps the car they
// had selected and the upgrades fitted to it.
import { MOD_KEYS, type CatalogCar, type ModKey, type Mods, type Selection } from './garage';
import { SKINS } from './scene/driver';

export const STARTER_CAR = 'vela_gt';
export const STARTING_CREDITS = 5_000;
/** Upgrade stage prices (stage 1, 2, 3). Buying a stage also buys the ones below it. */
export const MOD_PRICES: Record<ModKey, number[]> = {
  engine: [8_000, 18_000, 35_000],
  tyres: [5_000, 12_000, 25_000],
  weight: [6_000, 14_000, 28_000],
  aero: [6_000, 14_000, 28_000],
};
/** Race payouts by finishing position (1 lap); longer races pay more. */
const PAYOUT = [20_000, 14_000, 10_000, 7_500, 5_500, 4_000];
const LAP_FACTOR: Record<number, number> = { 1: 1, 3: 2.4, 5: 3.6, 10: 6.5 };
/** Free roam: credits per km driven. */
export const FREE_ROAM_PER_KM = 400;

export interface WalletData { credits: number; cars: string[]; mods: Record<string, Mods>; skins: string[] }
const KEY = 'nr.wallet.v2';   // v1 (35,000 Cr start, paid DNFs) lived for one day: everyone starts again

export const fmt = (n: number) => `${Math.round(n).toLocaleString('en-US')} Cr`;

export class Wallet {
  data: WalletData;
  /** credits earned in the session that just ended (shown on the next menu) */
  lastEarned = 0;
  lastReason = '';

  /** unlockAll: tests on the dev server own every car and stage */
  constructor(private catalog: CatalogCar[], sel: Selection, unlockAll = false) {
    let d: WalletData | null = null;
    try {
      const s = JSON.parse(localStorage.getItem(KEY) ?? 'null');
      if (s && typeof s === 'object' && Number.isFinite(s.credits)) {
        d = { credits: Math.max(0, Math.round(s.credits)), cars: Array.isArray(s.cars) ? s.cars.filter((c: unknown) => typeof c === 'string') : [], mods: {},
          skins: Array.isArray(s.skins) ? s.skins.filter((k: unknown) => SKINS.some((x) => x.id === k)) : [] };
        for (const [car, m] of Object.entries((s.mods ?? {}) as Record<string, Mods>)) {
          const o = { engine: 0, tyres: 0, weight: 0, aero: 0 } as Mods;
          for (const k of MOD_KEYS) o[k] = Math.max(0, Math.min(3, Math.round(Number(m?.[k]) || 0)));
          d.mods[car] = o;
        }
      }
    } catch { /* storage blocked */ }
    if (!d) {
      // first run with the shop: the starter car, plus whatever this player was already driving
      d = { credits: STARTING_CREDITS, cars: [STARTER_CAR], mods: {}, skins: [] };
      let had = false;
      try { had = localStorage.getItem('nr.garage.v1') !== null; } catch { /* blocked */ }
      if (had && sel.car !== STARTER_CAR) d.cars.push(sel.car);
      if (had && sel.mods[sel.car]) d.mods[sel.car] = { ...sel.mods[sel.car] };
    }
    if (!d.cars.includes(STARTER_CAR)) d.cars.push(STARTER_CAR);
    for (const k of SKINS) if (k.price === 0 && !d.skins.includes(k.id)) d.skins.push(k.id);   // free skins are always yours
    if (unlockAll) { for (const c of catalog) { if (!d.cars.includes(c.id)) d.cars.push(c.id); d.mods[c.id] = { engine: 3, tyres: 3, weight: 3, aero: 3 }; } d.skins = SKINS.map((k) => k.id); }
    this.data = d;
    this.fitOwned(sel);
    this.save();
  }

  save() { try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch { /* blocked */ } }
  get credits() { return this.data.credits; }

  owns(car: string) { return this.data.cars.includes(car); }
  ownsSkin(id: string) { return this.data.skins.includes(id); }
  buySkin(id: string): string {
    const k = SKINS.find((x) => x.id === id);
    if (!k || this.ownsSkin(id)) return '';
    if (k.price > this.data.credits) return `Not enough credits: ${k.name} costs ${fmt(k.price)}.`;
    this.data.credits -= k.price;
    this.data.skins.push(id);
    this.save();
    return `✓ ${k.name} gear is yours. Wear it from the Garage → Driver tab.`;
  }
  /** highest owned stage of an upgrade on a car */
  stage(car: string, k: ModKey) { return this.data.mods[car]?.[k] ?? 0; }

  /** Selection must only use owned things (a car / stage removed or never bought: fall back). */
  fitOwned(sel: Selection) {
    if (!this.owns(sel.car)) sel.car = STARTER_CAR;
    if (!this.ownsSkin(sel.skin)) sel.skin = SKINS[0].id;
    for (const [car, m] of Object.entries(sel.mods)) for (const k of MOD_KEYS) m[k] = Math.min(m[k], this.stage(car, k));
  }

  price(car: CatalogCar) { return car.price ?? 0; }
  /** What buying stage `to` of k on a car costs now (the stages below it that aren't owned are included). */
  modCost(car: string, k: ModKey, to: number) {
    let c = 0;
    for (let s = this.stage(car, k) + 1; s <= to; s++) c += MOD_PRICES[k][s - 1];
    return c;
  }

  buyCar(id: string): string {
    const car = this.catalog.find((c) => c.id === id);
    if (!car || this.owns(id)) return '';
    const p = this.price(car);
    if (p > this.data.credits) return `Not enough credits: ${car.name} costs ${fmt(p)}.`;
    this.data.credits -= p;
    this.data.cars.push(id);
    this.save();
    return `✓ ${car.name} is yours. Find it in the Garage.`;
  }
  buyMod(car: string, k: ModKey, to: number): string {
    const c = this.modCost(car, k, to);
    if (to <= this.stage(car, k)) return '';
    if (c > this.data.credits) return `Not enough credits: that costs ${fmt(c)}.`;
    this.data.credits -= c;
    const m = this.data.mods[car] ?? { engine: 0, tyres: 0, weight: 0, aero: 0 };
    m[k] = to;
    this.data.mods[car] = m;
    this.save();
    return '';
  }

  earn(n: number, reason: string) {
    n = Math.max(0, Math.round(n));
    if (!n) return 0;
    this.data.credits += n;
    this.lastEarned = n;
    this.lastReason = reason;
    this.save();
    return n;
  }

  /** Race payout: position 1-based among `field` cars, or dnf with the laps done. */
  static racePayout(pos: number, laps: number, dnf: boolean) {
    const f = LAP_FACTOR[laps] ?? Math.max(1, laps * 0.65);
    if (dnf) return 0;   // did not finish: no prize money
    return Math.round(PAYOUT[Math.min(PAYOUT.length - 1, Math.max(0, pos - 1))] * f);
  }
}
