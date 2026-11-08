// Driving assists, per player (localStorage). Every level maps onto the core's EXISTING aids: no new physics, the car
// and tyres are the same for everyone; the aids only act on what the driver asks for.
//   ABS          Off / Weak / Default        brake-pressure modulation to a wheel-slip target (weak lets the tyres
//                                            slip further before releasing: shorter on grip, closer to lock-up)
//   Traction     Off / 1..5                  engine torque cut above a driven-wheel slip target (5 = earliest)
//   Stability    Off / On                    yaw-rate control braking single wheels (the core's ESC)
//   Countersteer Off / Weak / Strong         steering added toward the slide when the rear steps out
//   Gearbox      Auto / Manual
//   Driving line Off / Braking zones / Full  the racing line on the road, coloured by how hard you need to brake
import type { AssistToggles } from './physics/core';

export type AbsLevel = 'off' | 'weak' | 'default';
export type CounterLevel = 'off' | 'weak' | 'strong';
export type LineMode = 'off' | 'braking' | 'full';
export type Preset = 'beginner' | 'intermediate' | 'expert' | 'custom';
export interface AssistSettings {
  preset: Preset;
  abs: AbsLevel;
  tc: number;                 // 0 off, 1..5
  stability: boolean;
  countersteer: CounterLevel;
  gearbox: 'auto' | 'manual';
  line: LineMode;
}

export const PRESETS: Record<Exclude<Preset, 'custom'>, Omit<AssistSettings, 'preset'>> = {
  beginner: { abs: 'default', tc: 5, stability: true, countersteer: 'strong', gearbox: 'auto', line: 'full' },
  intermediate: { abs: 'default', tc: 3, stability: true, countersteer: 'weak', gearbox: 'auto', line: 'braking' },
  expert: { abs: 'weak', tc: 0, stability: false, countersteer: 'off', gearbox: 'manual', line: 'off' },
};
export const PRESET_INFO: Record<Preset, string> = {
  beginner: 'Every aid on. The car helps you catch slides and shows where to brake.',
  intermediate: 'ABS, medium traction control, stability and a light countersteer hand. Braking zones shown.',
  expert: 'Weak ABS only. Manual gearbox, no line: all you.',
  custom: 'Your own mix.',
};

// slip targets: the fitted tyre peaks near 10 % longitudinal slip (data/tires)
const ABS_SLIP: Record<AbsLevel, number> = { off: 0, weak: 0.17, default: 0.10 };
const TC_SLIP = [0, 0.24, 0.18, 0.14, 0.10, 0.07];
const COUNTER_GAIN: Record<CounterLevel, number> = { off: 0, weak: 0.4, strong: 0.8 };

const KEY = 'nr.assists.v1';
export function loadAssists(): AssistSettings {
  const d: AssistSettings = { preset: 'intermediate', ...PRESETS.intermediate };
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (s && typeof s === 'object') {
      if (['beginner', 'intermediate', 'expert', 'custom'].includes(s.preset)) d.preset = s.preset;
      if (['off', 'weak', 'default'].includes(s.abs)) d.abs = s.abs;
      if (Number.isInteger(s.tc) && s.tc >= 0 && s.tc <= 5) d.tc = s.tc;
      if (typeof s.stability === 'boolean') d.stability = s.stability;
      if (['off', 'weak', 'strong'].includes(s.countersteer)) d.countersteer = s.countersteer;
      if (s.gearbox === 'auto' || s.gearbox === 'manual') d.gearbox = s.gearbox;
      if (['off', 'braking', 'full'].includes(s.line)) d.line = s.line;
    }
  } catch { /* storage blocked */ }
  return d;
}
export function saveAssists(a: AssistSettings) { try { localStorage.setItem(KEY, JSON.stringify(a)); } catch { /* blocked */ } }

export function applyPreset(a: AssistSettings, p: Preset) {
  a.preset = p;
  if (p !== 'custom') Object.assign(a, PRESETS[p]);
}
/** A single setting changed: the preset becomes whichever one matches now (or custom). */
export function matchPreset(a: AssistSettings) {
  const same = (p: Omit<AssistSettings, 'preset'>) => (Object.keys(p) as (keyof typeof p)[]).every((k) => p[k] === a[k]);
  a.preset = (Object.keys(PRESETS) as Exclude<Preset, 'custom'>[]).find((p) => same(PRESETS[p])) ?? 'custom';
}

/** Write the levels into the toggles the physics reads every tick. */
export function toToggles(a: AssistSettings, t: AssistToggles) {
  t.abs = a.abs !== 'off';
  t.absSlip = ABS_SLIP[a.abs];
  t.tc = a.tc > 0;
  t.tcSlip = TC_SLIP[a.tc];
  t.esc = a.stability;
  t.countersteer = COUNTER_GAIN[a.countersteer];
  t.autoGearbox = a.gearbox === 'auto';
}
/** The quick keys while driving (1 ABS, 2 TC, 3 stability, 5 gearbox) change the saved settings too. */
export function fromToggles(a: AssistSettings, t: AssistToggles) {
  if (!t.abs) a.abs = 'off'; else if (a.abs === 'off') a.abs = 'default';
  if (!t.tc) a.tc = 0; else if (a.tc === 0) a.tc = 3;
  a.stability = t.esc;
  a.gearbox = t.autoGearbox ? 'auto' : 'manual';
  matchPreset(a);
}
