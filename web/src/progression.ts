// Progression rules, shared by the game and the server (cloud/ imports this file): levels, what each level unlocks,
// prices, race XP and credits, earning caps. No DOM, no three.js.
//
// Two separate careers:
//   single player  XP only, on this device. Reaching a level unlocks cars, upgrade stages and driver gear for free.
//   online         XP and credits, kept by the server. A level makes an item buyable; credits pay for it. Ranked races
//                  (6+ players on 6+ different IP addresses) are the only source of online XP and credits.
// Modelled on what keeps players going in Forza Horizon / Gran Turismo / NFS Heat: XP for how you drive (position,
// overtakes, clean racing, fewer assists), a fast start that flattens out, a reward at most levels, no grind walls.

export const MAX_LEVEL = 50;
/** XP needed to go from level L to L+1: fast early levels, flattening later (1000 * L^1.25, rounded to 50). */
export const xpToNext = (level: number) => Math.round((1000 * Math.pow(level, 1.25)) / 50) * 50;
/** Level and progress from total XP. */
export function levelOf(totalXp: number): { level: number; into: number; need: number } {
  let level = 1, left = Math.max(0, Math.floor(totalXp));
  while (level < MAX_LEVEL && left >= xpToNext(level)) { left -= xpToNext(level); level++; }
  return { level, into: left, need: level >= MAX_LEVEL ? 0 : xpToNext(level) };
}

export type Career = 'sp' | 'mp';
/** What an item needs: single player unlocks at spLevel; online it needs mpLevel and costs price credits. */
export interface Req { spLevel: number; mpLevel: number; price: number }

export const CAR_REQ: Record<string, Req> = {
  vela_gt: { spLevel: 1, mpLevel: 1, price: 0 },
  k_concept: { spLevel: 1, mpLevel: 10, price: 120_000 },
  kestrel_gt: { spLevel: 6, mpLevel: 5, price: 140_000 },
  harrier_gt: { spLevel: 12, mpLevel: 10, price: 160_000 },
};
export const STARTER_CAR = 'vela_gt';
/** Upgrade stages 1..3 per part. */
export const MOD_REQ: Record<'engine' | 'tyres' | 'weight' | 'aero', Req[]> = {
  engine: [{ spLevel: 2, mpLevel: 2, price: 8_000 }, { spLevel: 5, mpLevel: 4, price: 18_000 }, { spLevel: 9, mpLevel: 7, price: 35_000 }],
  tyres: [{ spLevel: 3, mpLevel: 2, price: 5_000 }, { spLevel: 6, mpLevel: 4, price: 12_000 }, { spLevel: 10, mpLevel: 8, price: 25_000 }],
  weight: [{ spLevel: 4, mpLevel: 3, price: 6_000 }, { spLevel: 7, mpLevel: 5, price: 14_000 }, { spLevel: 11, mpLevel: 8, price: 28_000 }],
  aero: [{ spLevel: 4, mpLevel: 3, price: 6_000 }, { spLevel: 8, mpLevel: 6, price: 14_000 }, { spLevel: 13, mpLevel: 9, price: 28_000 }],
};
export const SKIN_REQ: Record<string, Req> = {
  classic: { spLevel: 1, mpLevel: 1, price: 0 },
  midnight: { spLevel: 3, mpLevel: 2, price: 2_500 },
  rosso: { spLevel: 5, mpLevel: 3, price: 4_000 },
  volt: { spLevel: 7, mpLevel: 4, price: 6_000 },
  glacier: { spLevel: 9, mpLevel: 5, price: 6_000 },
  neon: { spLevel: 12, mpLevel: 7, price: 9_000 },
  apex: { spLevel: 15, mpLevel: 9, price: 12_000 },
  jade: { spLevel: 18, mpLevel: 11, price: 12_000 },
  royal: { spLevel: 22, mpLevel: 14, price: 18_000 },
  gold: { spLevel: 28, mpLevel: 18, price: 25_000 },
};
/** Every level-up pays this many credits online (single player has no credits). */
export const levelUpCredits = (newLevel: number) => 2_000 + newLevel * 500;

/** Car top speeds (km/h, core/tests/test_characters.cpp) for the server's plausibility check, with full engine upgrades. */
export const CAR_VMAX_KMH: Record<string, number> = { vela_gt: 288, kestrel_gt: 269, harrier_gt: 300 };

// ---- race rewards ----------------------------------------------------------------------------------------------------
const LAP_FACTOR: Record<number, number> = { 1: 1, 3: 2.4, 5: 3.6, 10: 6.5 };
const lapFactor = (laps: number) => LAP_FACTOR[laps] ?? Math.max(1, laps * 0.65);
const XP_BY_POS = [1500, 1200, 1000, 850, 720, 600, 520, 460];
const CR_BY_POS = [20_000, 14_000, 10_000, 7_500, 5_500, 4_000, 3_000, 2_500];

export interface RaceOutcome {
  pos: number;            // 1-based finishing position (ignored if dnf)
  laps: number;
  dnf: boolean;
  gained: number;         // places gained from the grid to the flag (overtakes, net)
  clean: boolean;         // no contact with another car
  assistsOff: number;     // 0..5: ABS, traction control, stability, countersteer, driving line switched off
  manual: boolean;
  realism: boolean;
}
export interface Reward { xp: number; cr: number; parts: { label: string; xp: number }[] }

/** XP (both careers) and credits (online only) for one race. A DNF earns nothing. */
export function raceReward(o: RaceOutcome, career: Career): Reward {
  if (o.dnf) return { xp: 0, cr: 0, parts: [{ label: 'Did not finish', xp: 0 }] };
  const f = lapFactor(o.laps), i = Math.min(XP_BY_POS.length - 1, Math.max(0, o.pos - 1));
  const base = Math.round(XP_BY_POS[i] * f);
  const parts = [{ label: `P${o.pos} finish`, xp: base }];
  if (o.gained > 0) parts.push({ label: `${o.gained} place${o.gained > 1 ? 's' : ''} gained`, xp: Math.round(o.gained * 80 * f) });
  if (o.clean) parts.push({ label: 'Clean race', xp: Math.round(base * 0.2) });
  const sum = parts.reduce((a, p) => a + p.xp, 0);
  // fewer aids pay more (Forza's difficulty bonus): +5 % per aid off, +10 % manual gears, +10 % full realism
  const mult = o.assistsOff * 0.05 + (o.manual ? 0.1 : 0) + (o.realism ? 0.1 : 0);
  if (mult > 0) parts.push({ label: `Driver bonus +${Math.round(mult * 100)} %`, xp: Math.round(sum * mult) });
  const xp = parts.reduce((a, p) => a + p.xp, 0);
  return { xp, cr: career === 'mp' ? Math.round(CR_BY_POS[i] * f) : 0, parts };
}
/** Free roam: XP per km (both careers; online free roam pays no credits: they come from ranked races only). */
export const FREE_ROAM_XP_PER_KM = 40;

// ---- online rules (enforced by the server) ------------------------------------------------------------------------------
/** Ranked race: at least 6 accounts that genuinely race (moving and covering distance), of which at most 2 count per
 *  network (IPv4 address, or IPv6 /64 = one household): roommates can race together, one person cannot fill a grid. */
export const RANKED_MIN_PLAYERS = 6;
export const MAX_PER_NETWORK = 2;
/** "Genuinely racing": share of the race distance a car must cover (finishers always qualify). */
export const ACTIVE_MIN_DISTANCE = 0.5;
export const DAILY_CAP = { xp: 80_000, cr: 150_000 };
export const NEW_ACCOUNT = { hours: 24, level: 3, factor: 0.5 };   // payouts halved until both are passed
export const STRIKES_TO_BAN = 3;
