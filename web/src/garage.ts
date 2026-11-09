// Garage data: the car catalog, tuning mods (a patch applied to the car's physics JSON before the
// core is created), paint, visual parts (scene/custom.ts), the driver's skin, and the saved selection. No DOM here.

import { cleanCustom, defaultCustom, type Custom } from './scene/custom';
import { SKINS } from './scene/driver';

export interface CatalogCar { id: string; name: string; tag: string; physics: string; paint: string; /** visual config (default: the shared Vela GT body) */ visual?: string; /** Shop price, credits */ price?: number }
export type Finish = 'gloss' | 'satin' | 'metallic' | 'pearl' | 'candy' | 'matte';
export type ModKey = 'engine' | 'tyres' | 'weight' | 'aero';
export type Mods = Record<ModKey, number>;   // level 0 (stock) .. 3
/** free roam (just you), race (you + AI rivals), online (a party session: its rules come from the party) */
export type Mode = 'free' | 'race' | 'online';

/** What each career drives (they own different things): car, fitted upgrade stages, driver gear. */
export interface Side { car: string; mods: Record<string, Mods>; skin: string }
export interface Selection {
  /** which career the garage, shop and next session use (single player / online) */
  career: 'sp' | 'mp';
  sides: { sp: Side; mp: Side };
  /** the active career's car / mods / skin (accessors onto sides[career]) */
  car: string;
  paint: Record<string, string>;     // per car: '#rrggbb'
  finish: Finish;
  mods: Record<string, Mods>;        // per car
  mode: Mode;
  laps: number;
  /** multiplayer display name */
  name: string;
  /** races: true = full realism (no resets; wrecked / rolled / stuck = DNF, then spectate), false = R respawns */
  realism: boolean;
  /** visual parts per car (garage tabs) */
  custom: Record<string, Custom>;
  /** the driver's skin (helmet, suit): also the multiplayer avatar */
  skin: string;
}

/** iridescence: strength of the angle-dependent colour shift of pearl paint (0 = none). */
/**
 * Each finish is a different *layering*, not one number: the clear coat's own roughness (the crisp highlight), how
 * much metallic flake shows through it, and how strongly the world (the car's reflection probe) mirrors in it. That
 * separation is what makes candy, pearl and metallic read as paint instead of plastic - see docs/art_direction.md.
 */
export const FINISHES: Record<Finish, {
  label: string; clearcoat: number; roughness: number; metalness: number; iridescence?: number;
  /** clear coat roughness: crisp mirror highlight (candy) -> soft sheen (satin) -> none (matte) */
  ccRough: number;
  /** envMapIntensity: how much of the world reflects in the coat */
  env: number;
}> = {
  gloss:    { label: 'Gloss',    clearcoat: 1,    ccRough: 0.020, roughness: 0.22, metalness: 0.45, env: 1.45 },
  satin:    { label: 'Satin',    clearcoat: 0.35, ccRough: 0.120, roughness: 0.42, metalness: 0.32, env: 1.05 },
  metallic: { label: 'Metallic', clearcoat: 1,    ccRough: 0.028, roughness: 0.18, metalness: 0.88, env: 1.70 },
  pearl:    { label: 'Pearl',    clearcoat: 1,    ccRough: 0.020, roughness: 0.20, metalness: 0.65, env: 1.60, iridescence: 1 },
  candy:    { label: 'Candy',    clearcoat: 1,    ccRough: 0.012, roughness: 0.14, metalness: 0.94, env: 1.90 },
  matte:    { label: 'Matte',    clearcoat: 0.04, ccRough: 0.500, roughness: 0.72, metalness: 0.15, env: 0.65 },
};

export const SWATCHES = ['#c0160f', '#e8890a', '#e6c619', '#1f9d55', '#0e7c86', '#1d4ed8', '#6d28d9', '#d946a8', '#b9bcc4', '#15171c'];

/** Level names and what one level changes, shown in the garage. */
export const MODS: Record<ModKey, { label: string; levels: string[]; hint: string }> = {
  engine: { label: 'Engine',  levels: ['Stock', 'Stage 1', 'Stage 2', 'Stage 3'], hint: '+5 % torque per stage' },
  tyres:  { label: 'Tyres',   levels: ['Street', 'Sport', 'Semi-slick', 'Slick'], hint: '+5 % grip per step' },
  weight: { label: 'Weight',  levels: ['Stock', 'Light', 'Lighter', 'Stripped'], hint: '-3 % mass per step' },
  aero:   { label: 'Aero kit', levels: ['Stock', 'Splitter', 'Wing', 'Race kit'], hint: '+25 % downforce, +6 % drag per step' },
};
export const MOD_KEYS = Object.keys(MODS) as ModKey[];
export const noMods = (): Mods => ({ engine: 0, tyres: 0, weight: 0, aero: 0 });

/** Physics JSON with the mods applied (a new object; the catalog JSON is never touched). */
export function applyMods(base: any, m: Mods): any {
  const d = JSON.parse(JSON.stringify(base));
  const torque = 1 + 0.05 * m.engine, grip = 1 + 0.05 * m.tyres, mass = 1 - 0.03 * m.weight;
  d.engine.torque_curve = d.engine.torque_curve.map(([rpm, t]: [number, number]) => [rpm, Math.round(t * torque * 10) / 10]);
  for (const k of ['tire_front', 'tire_rear']) {
    if (!d[k]) continue;
    d[k].longitudinal.mu *= grip;
    d[k].lateral.mu *= grip;
  }
  d.chassis.mass_kg *= mass;
  for (const k of ['inertia_roll_kgm2', 'inertia_pitch_kgm2', 'inertia_yaw_kgm2']) d.chassis[k] *= mass;
  d.aero.downforce_area_m2 *= 1 + 0.25 * m.aero;
  d.aero.drag_area_m2 *= 1 + 0.06 * m.aero;
  d.name = `${d.name}${MOD_KEYS.some((k) => m[k]) ? ' (tuned)' : ''}`;
  return d;
}

export interface Stats { power: number; hp: number; mass: number; grip: number; downforce: number; drag: number; vmax: number; accel: number; ratio: number; pwr: number }
const statsCache = new WeakMap<object, Stats>();
/** Numbers for the garage bars, straight from the physics JSON (cached per object). */
export function statsOf(d: any): Stats {
  if (d && typeof d === 'object') {
    const cached = statsCache.get(d);
    if (cached) return cached;
  }
  const power = Math.max(...d.engine.torque_curve.map(([rpm, t]: [number, number]) => (t * rpm * 2 * Math.PI) / 60)) / 1000;   // kW
  const mass = d.chassis.mass_kg;
  const drag = d.aero.drag_area_m2;
  // top speed from power vs drag: P = 0.5 rho Cd A v^3 (a good estimate, not a simulation)
  const vmax = Math.cbrt((2 * power * 1000) / (1.2 * Math.max(0.2, drag))) * 3.6;   // km/h
  // 0-100: energy over power, floored by the tyres (mu g), with a drivetrain/launch factor
  const v100 = 100 / 3.6;
  const tyre = (d.tire_front.lateral.mu * 9.81) / 0.62;
  const accel = Math.max((0.5 * mass * v100 * v100) / (power * 1000 * 0.45), v100 / tyre);
  const st = {
    power, hp: power * 1.34102, mass, grip: d.tire_front.lateral.mu, downforce: d.aero.downforce_area_m2,
    drag, vmax, accel, ratio: (power * 1000) / mass, pwr: power / (mass / 1000),
  };
  if (d && typeof d === 'object') statsCache.set(d, st);
  return st;
}

/** What the cosmetic parts actually do to the car: downforce (m2), drag (m2), mass (kg). */
export const WING_EFFECT: { re: RegExp; name: string; df: number; drag: number; kg: number }[] = [
  { re: /^lip/, name: 'lip', df: 0.03, drag: 0.004, kg: 0.5 },
  { re: /^duck/, name: 'ducktail', df: 0.02, drag: 0.008, kg: 1 },
  { re: /^basket/, name: 'basket', df: 0.05, drag: 0.020, kg: 1.5 },
  { re: /^chassis/, name: 'chassis', df: 0.06, drag: 0.030, kg: 2 },
  { re: /^pillar/, name: 'pillar', df: 0.07, drag: 0.040, kg: 2 },
  { re: /^gt-/, name: 'GT', df: 0.08, drag: 0.040, kg: 2.5 },
  { re: /^dual/, name: 'dual', df: 0.09, drag: 0.050, kg: 2.5 },
  { re: /^swan/, name: 'swan', df: 0.10, drag: 0.050, kg: 2.5 },
  { re: /^gt2/, name: 'GT2', df: 0.11, drag: 0.060, kg: 3 },
  { re: /^wide/, name: 'wide', df: 0.12, drag: 0.070, kg: 3 },
];
/** Rim families trade mass for stiffness: forged mesh is heavier, deep dish is lighter. */
export const RIM_EFFECT: { re: RegExp; kg: number }[] = [
  { re: /^five/, kg: -0.6 }, { re: /^six/, kg: -0.4 }, { re: /^seven/, kg: -0.2 },
  { re: /^split5/, kg: -0.3 }, { re: /^turbine/, kg: 0 }, { re: /^mesh/, kg: 1.6 },
  { re: /^concave/, kg: -0.8 }, { re: /^dish/, kg: -0.4 }, { re: /^lip/, kg: 0.4 }, { re: /^rally/, kg: 1.2 },
];
const KEY = 'nr.garage.v1';
export function loadSelection(cars: CatalogCar[], params: URLSearchParams): Selection {
  const starter = cars.find((c) => c.id === 'vela_gt')?.id ?? cars[0].id;
  const side = (): Side => ({ car: starter, mods: {}, skin: 'classic' });
  const sel = { career: 'sp', sides: { sp: side(), mp: side() }, paint: {}, finish: 'gloss', mode: 'race', laps: 3,
    name: `Driver ${Math.floor(1000 + Math.random() * 9000)}`, realism: true, custom: {} } as unknown as Selection;
  for (const k of ['car', 'mods', 'skin'] as const)
    Object.defineProperty(sel, k, { enumerable: false, get: () => sel.sides[sel.career][k], set: (v) => { (sel.sides[sel.career] as unknown as Record<string, unknown>)[k] = v; } });
  const cleanMods = (o: unknown) => {
    const out: Record<string, Mods> = {};
    if (o && typeof o === 'object') for (const [k, v] of Object.entries(o as Record<string, Mods>)) {
      const m = noMods();
      for (const key of MOD_KEYS) m[key] = Math.max(0, Math.min(3, Math.round(Number((v as Mods)?.[key]) || 0)));
      out[k] = m;
    }
    return out;
  };
  const cleanSide = (o: Partial<Side> | undefined, into: Side) => {
    if (!o || typeof o !== 'object') return;
    if (cars.some((c) => c.id === o.car)) into.car = o.car!;
    into.mods = cleanMods(o.mods);
    if (SKINS.some((k) => k.id === o.skin)) into.skin = o.skin!;
  };
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (s && typeof s === 'object') {
      // older saves had one car / mods / skin: they become the single-player side
      if (s.sides) { cleanSide(s.sides.sp, sel.sides.sp); cleanSide(s.sides.mp, sel.sides.mp); }
      else cleanSide({ car: s.car, mods: s.mods, skin: s.skin }, sel.sides.sp);
      if (s.career === 'mp' || s.career === 'sp') sel.career = s.career;
      if (s.paint && typeof s.paint === 'object') for (const [k, v] of Object.entries(s.paint)) if (/^#[0-9a-f]{6}$/i.test(v as string)) sel.paint[k] = v as string;
      if (s.finish in FINISHES) sel.finish = s.finish;
      if (['free', 'race'].includes(s.mode)) sel.mode = s.mode;
      if ([1, 3, 5, 10].includes(s.laps)) sel.laps = s.laps;
      if (typeof s.name === 'string' && s.name.trim()) sel.name = s.name.trim().slice(0, 18);
      if (typeof s.realism === 'boolean') sel.realism = s.realism;
      if (s.custom && typeof s.custom === 'object') for (const [k, v] of Object.entries(s.custom)) if (cars.some((c) => c.id === k)) sel.custom[k] = cleanCustom(v);
    }
  } catch { /* storage blocked or corrupt: defaults */ }
  const q = params.get('car');   // ?car=<id>: pick the car from the URL (tests, links)
  if (q && cars.some((c) => c.id === q)) sel.car = q;
  return sel;
}
export function saveSelection(sel: Selection) {
  try { localStorage.setItem(KEY, JSON.stringify(sel)); } catch { /* storage blocked */ }
}
export const paintOf = (sel: Selection, cars: CatalogCar[]) => sel.paint[sel.car] ?? cars.find((c) => c.id === sel.car)!.paint;
export const modsOf = (sel: Selection): Mods => sel.mods[sel.car] ?? noMods();
/** The selected car's visual parts (created on first use). */
export const customOf = (sel: Selection): Custom => (sel.custom[sel.car] ??= defaultCustom());
/** One-click Heat looks: paint, finish and parts together, applied through the same uniforms the tabs use. */
export interface LookPreset { id: string; label: string; blurb: string; paint: string; finish: Finish; parts: Partial<Custom> }
export const LOOK_PRESETS: LookPreset[] = [
  {
    id: 'neon', label: 'Neon street', blurb: 'Cyan candy with a magenta side stripe and underglow',
    paint: '#00d5ff', finish: 'candy',
    parts: { livery: 3, liveryColor: '#ff2d55', wing: 'gt', aero: 'gloss', rimColor: '#15171c', rimFinish: 'gloss',
      caliper: '#ff2d55', headlights: 'ice', smokedTails: true, underglow: '#ff2d55', tint: 1, exhaust: 'black' },
  },
  {
    id: 'blackout', label: 'Blackout', blurb: 'Matte black, no wing, dark rims, smoked glass',
    paint: '#0a0b0e', finish: 'matte',
    parts: { livery: 0, wing: 'none', aero: 'matte', rimColor: '#15171c', rimFinish: 'matte',
      caliper: '#9aa0aa', headlights: 'white', smokedTails: true, underglow: '', tint: 2, exhaust: 'black' },
  },
  {
    id: 'chrome', label: 'Candy chrome', blurb: 'Deep candy with chrome rims and a violet underglow',
    paint: '#8e0038', finish: 'candy',
    parts: { livery: 0, wing: 'ducktail', aero: 'carbon', rimColor: '#f4f4f6', rimFinish: 'chrome',
      caliper: '#c8a24a', headlights: 'white', smokedTails: false, underglow: '#b14dff', tint: 1, exhaust: 'titanium' },
  },
  {
    id: 'sunset', label: 'Heat sunset', blurb: 'Amber metallic with a gold underglow, two-tone roof',
    paint: '#ff7a00', finish: 'metallic',
    parts: { livery: 4, liveryColor: '#15171c', wing: 'gt', aero: 'gloss', rimColor: '#c8a24a', rimFinish: 'satin',
      caliper: '#c0160f', headlights: 'yellow', smokedTails: true, underglow: '#ffb547', tint: 1, exhaust: 'titanium' },
  },
];
/** Apply a preset to the selected car. Returns false for an unknown id (the menu then just re-renders). */
export function applyLookPreset(sel: Selection, id: string): boolean {
  const p = LOOK_PRESETS.find((x) => x.id === id);
  if (!p) return false;
  sel.paint[sel.car] = p.paint;
  sel.finish = p.finish;
  Object.assign(customOf(sel), p.parts);
  return true;
}
