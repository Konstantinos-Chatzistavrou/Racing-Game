// Garage data: the car catalog, tuning mods (a patch applied to the car's physics JSON before the
// core is created), paint, and the saved selection. No DOM and no three.js here (menu.ts draws it).

export interface CatalogCar { id: string; name: string; tag: string; physics: string; paint: string; /** visual config (default: the shared Vela GT body) */ visual?: string; /** Shop price, credits */ price?: number }
export type Finish = 'gloss' | 'satin' | 'metallic' | 'pearl' | 'candy' | 'matte';
export type ModKey = 'engine' | 'tyres' | 'weight' | 'aero';
export type Mods = Record<ModKey, number>;   // level 0 (stock) .. 3
/** free roam (just you), race (you + AI rivals), online (a party session: its rules come from the party) */
export type Mode = 'free' | 'race' | 'online';

export interface Selection {
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
}

/** iridescence: strength of the angle-dependent colour shift of pearl paint (0 = none). */
export const FINISHES: Record<Finish, { label: string; clearcoat: number; roughness: number; metalness: number; iridescence?: number }> = {
  gloss:    { label: 'Gloss',    clearcoat: 1,    roughness: 0.22, metalness: 0.45 },
  satin:    { label: 'Satin',    clearcoat: 0.35, roughness: 0.42, metalness: 0.32 },
  metallic: { label: 'Metallic', clearcoat: 1,    roughness: 0.18, metalness: 0.88 },
  pearl:    { label: 'Pearl',    clearcoat: 1,    roughness: 0.20, metalness: 0.65, iridescence: 1 },
  candy:    { label: 'Candy',    clearcoat: 1,    roughness: 0.14, metalness: 0.94 },
  matte:    { label: 'Matte',    clearcoat: 0.04, roughness: 0.72, metalness: 0.15 },
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

export interface Stats { power: number; mass: number; grip: number; downforce: number; ratio: number }
const statsCache = new WeakMap<object, Stats>();
/** Numbers for the garage bars, straight from the physics JSON (cached per object). */
export function statsOf(d: any): Stats {
  if (d && typeof d === 'object') {
    const cached = statsCache.get(d);
    if (cached) return cached;
  }
  const power = Math.max(...d.engine.torque_curve.map(([rpm, t]: [number, number]) => (t * rpm * 2 * Math.PI) / 60)) / 1000;   // kW
  const mass = d.chassis.mass_kg;
  const st = { power, mass, grip: d.tire_front.lateral.mu, downforce: d.aero.downforce_area_m2, ratio: (power * 1000) / mass };
  if (d && typeof d === 'object') statsCache.set(d, st);
  return st;
}

const KEY = 'nr.garage.v1';
export function loadSelection(cars: CatalogCar[], params: URLSearchParams): Selection {
  const sel: Selection = { car: cars[1]?.id ?? cars[0].id, paint: {}, finish: 'gloss', mods: {}, mode: 'race', laps: 3, name: `Driver ${Math.floor(1000 + Math.random() * 9000)}`, realism: true };
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (s && typeof s === 'object') {
      if (cars.some((c) => c.id === s.car)) sel.car = s.car;
      if (s.paint && typeof s.paint === 'object') for (const [k, v] of Object.entries(s.paint)) if (/^#[0-9a-f]{6}$/i.test(v as string)) sel.paint[k] = v as string;
      if (s.finish in FINISHES) sel.finish = s.finish;
      if (s.mods && typeof s.mods === 'object') for (const [k, v] of Object.entries(s.mods as Record<string, Mods>)) {
        const m = noMods();
        for (const key of MOD_KEYS) m[key] = Math.max(0, Math.min(3, Math.round(Number((v as Mods)?.[key]) || 0)));
        sel.mods[k] = m;
      }
      if (['free', 'race'].includes(s.mode)) sel.mode = s.mode;
      if ([1, 3, 5, 10].includes(s.laps)) sel.laps = s.laps;
      if (typeof s.name === 'string' && s.name.trim()) sel.name = s.name.trim().slice(0, 18);
      if (typeof s.realism === 'boolean') sel.realism = s.realism;
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
