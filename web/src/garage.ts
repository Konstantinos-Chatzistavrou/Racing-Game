// Garage data: the car catalog, tuning mods (a patch applied to the car's physics JSON before the
// core is created), paint, and the saved selection. No DOM and no three.js here (menu.ts draws it).

export interface CatalogCar { id: string; name: string; tag: string; physics: string; paint: string }
export type Finish = 'gloss' | 'satin' | 'metallic' | 'pearl' | 'candy' | 'matte';
export type ModKey = 'engine' | 'tyres' | 'weight' | 'aero';
export type Mods = Record<ModKey, number>;   // level 0 (stock) .. 3
export type Mode = 'free' | 'race' | 'online';

export interface Selection {
  car: string;
  paint: Record<string, string>;     // per car: '#rrggbb'
  finish: Finish;
  mods: Record<string, Mods>;        // per car
  mode: Mode;
  laps: number;
  server: string;
}

/** iridescence: strength of the angle-dependent colour shift of pearl paint (0 = none). */
export const FINISHES: Record<Finish, { label: string; clearcoat: number; roughness: number; metalness: number; iridescence?: number }> = {
  gloss:    { label: 'Gloss',    clearcoat: 1,   roughness: 0.32, metalness: 0.35 },
  satin:    { label: 'Satin',    clearcoat: 0.3, roughness: 0.45, metalness: 0.25 },
  metallic: { label: 'Metallic', clearcoat: 1,   roughness: 0.22, metalness: 0.9 },
  pearl:    { label: 'Pearl',    clearcoat: 1,   roughness: 0.24, metalness: 0.6, iridescence: 1 },
  candy:    { label: 'Candy',    clearcoat: 1,   roughness: 0.16, metalness: 0.95 },
  matte:    { label: 'Matte',    clearcoat: 0,   roughness: 0.8,  metalness: 0.1 },
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

export const DEFAULT_SERVER = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname || 'localhost'}:8787`;

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
/** Numbers for the garage bars, straight from the physics JSON. */
export function statsOf(d: any): Stats {
  const power = Math.max(...d.engine.torque_curve.map(([rpm, t]: [number, number]) => (t * rpm * 2 * Math.PI) / 60)) / 1000;   // kW
  const mass = d.chassis.mass_kg;
  return { power, mass, grip: d.tire_front.lateral.mu, downforce: d.aero.downforce_area_m2, ratio: (power * 1000) / mass };
}

const KEY = 'nr.garage.v1';
export function loadSelection(cars: CatalogCar[], params: URLSearchParams): Selection {
  const sel: Selection = { car: cars[1]?.id ?? cars[0].id, paint: {}, finish: 'gloss', mods: {}, mode: 'free', laps: 3, server: DEFAULT_SERVER() };
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
      if (['free', 'race', 'online'].includes(s.mode)) sel.mode = s.mode;
      if ([1, 3, 5, 10].includes(s.laps)) sel.laps = s.laps;
      if (typeof s.server === 'string' && /^wss?:\/\//.test(s.server)) sel.server = s.server;
    }
  } catch { /* storage blocked or corrupt: defaults */ }
  const mp = params.get('mp');
  if (mp && mp !== '0') { sel.mode = 'online'; if (/^wss?:\/\//.test(mp)) sel.server = mp; }
  return sel;
}
export function saveSelection(sel: Selection) {
  try { localStorage.setItem(KEY, JSON.stringify(sel)); } catch { /* storage blocked */ }
}
export const paintOf = (sel: Selection, cars: CatalogCar[]) => sel.paint[sel.car] ?? cars.find((c) => c.id === sel.car)!.paint;
export const modsOf = (sel: Selection): Mods => sel.mods[sel.car] ?? noMods();
