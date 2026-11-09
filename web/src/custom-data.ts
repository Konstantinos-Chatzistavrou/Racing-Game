// Car looks as data (the garage's choices): types, option lists, defaults and the validator. No three.js, so the online
// service (cloud/) can check the looks it stores with each car; scene/custom.ts draws them.
import { AERO_NAMES, BODY_NAMES, RIM_NAMES, WING_NAMES, type AeroPartKind, type BodyPartKind } from './parts-names';

/** the model's own wing is 'stock'; 'none' removes it; everything else is a generated design */
export type WingKind = string;
export type AeroFinish = 'carbon' | 'gloss' | 'matte' | 'body';
export type RimFinish = 'chrome' | 'gloss' | 'satin' | 'matte';
export type HeadTint = 'white' | 'ice' | 'yellow';
export interface Custom {
  livery: number;            // 0 none, 1 twin stripes, 2 wide stripe, 3 side stripe, 4 two-tone
  liveryColor: string;
  wing: WingKind;
  splitter: string;
  diffuser: string;
  skirt: string;
  frontB: string;
  rearB: string;
  hood: string;
  fenders: string;
  rims: string;
  aero: AeroFinish;          // splitter, diffuser, skirts, wing, mirrors' carbon
  rimColor: string;
  rimFinish: RimFinish;
  caliper: string;
  headlights: HeadTint;
  smokedTails: boolean;
  underglow: string;         // '' = off
  tint: number;              // 0 light, 1 dark, 2 limo
  exhaust: 'chrome' | 'black' | 'titanium';
}
export const LIVERIES = ['None', 'Twin stripes', 'Wide stripe', 'Side stripe', 'Two-tone'];
export const WINGS: Record<WingKind, string> = {
  stock: 'Stock', none: 'No wing',
  ...Object.fromEntries(WING_NAMES.map((s) => [s.id, s.name])),
};
const kits = (k: AeroPartKind) => Object.fromEntries(AERO_NAMES.filter((s) => s.kind === k).map((s) => [s.id, s.name]));
export const SPLITTERS: Record<string, string> = { stock: 'Stock', ...kits('splitter') };
export const DIFFUSERS: Record<string, string> = { stock: 'Stock', ...kits('diffuser') };
export const SKIRTS: Record<string, string> = { stock: 'Stock', ...kits('skirt') };
const bodyKits = (k: BodyPartKind) => Object.fromEntries(BODY_NAMES.filter((s) => s.kind === k).map((s) => [s.id, s.name]));
export const FRONT_BUMPERS: Record<string, string> = { stock: 'Stock', ...bodyKits('front') };
export const REAR_BUMPERS: Record<string, string> = { stock: 'Stock', ...bodyKits('rear') };
export const HOODS: Record<string, string> = { stock: 'Stock', ...bodyKits('hood') };
export const FENDERS: Record<string, string> = { stock: 'Stock', ...bodyKits('fender') };
export const RIMS: Record<string, string> = { stock: 'Factory', ...Object.fromEntries(RIM_NAMES.map((s) => [s.id, s.name])) };
/** every wing, in menu order (stock/none are the model's own parts) */
export const WING_KINDS = Object.keys(WINGS);
export const AERO_FINISHES: Record<AeroFinish, string> = { carbon: 'Carbon', gloss: 'Gloss black', matte: 'Matte black', body: 'Body colour' };
export const RIM_FINISHES: Record<RimFinish, string> = { chrome: 'Chrome', gloss: 'Gloss', satin: 'Satin', matte: 'Matte' };
export const HEAD_TINTS: Record<HeadTint, string> = { white: 'White', ice: 'Ice blue', yellow: 'Yellow' };
export const PART_COLOURS = ['#f4f4f6', '#15171c', '#9aa0aa', '#c8a24a', '#b0632d', '#c0160f', '#e8890a', '#e6c619', '#1f9d55', '#14b8a6', '#1d4ed8', '#6d28d9', '#d946a8'];
export const GLOW_COLOURS = ['', '#ff2d55', '#2a9dff', '#3ddc84', '#b14dff', '#ffffff', '#ffb547'];

export function defaultCustom(): Custom {
  return { livery: 0, liveryColor: '#f4f4f6', wing: 'stock', aero: 'carbon', rimColor: '#9aa0aa', rimFinish: 'chrome', caliper: '#c0160f',
    splitter: 'stock', diffuser: 'stock', skirt: 'stock', frontB: 'stock', rearB: 'stock', hood: 'stock', fenders: 'stock', rims: 'stock',
    headlights: 'white', smokedTails: false, underglow: '', tint: 1, exhaust: 'chrome' };
}
const hexOk = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
/** Anything from storage or the network becomes a valid Custom. */
export function cleanCustom(v: unknown): Custom {
  const d = defaultCustom(), s = (v && typeof v === 'object' ? v : {}) as Partial<Custom>;
  return {
    livery: Number.isInteger(s.livery) && s.livery! >= 0 && s.livery! < LIVERIES.length ? s.livery! : d.livery,
    liveryColor: hexOk(s.liveryColor) ? s.liveryColor : d.liveryColor,
    wing: s.wing && s.wing in WINGS ? s.wing : d.wing,
    splitter: s.splitter && s.splitter in SPLITTERS ? s.splitter : d.splitter,
    diffuser: s.diffuser && s.diffuser in DIFFUSERS ? s.diffuser : d.diffuser,
    skirt: s.skirt && s.skirt in SKIRTS ? s.skirt : d.skirt,
    frontB: s.frontB && s.frontB in FRONT_BUMPERS ? s.frontB : d.frontB,
    rearB: s.rearB && s.rearB in REAR_BUMPERS ? s.rearB : d.rearB,
    hood: s.hood && s.hood in HOODS ? s.hood : d.hood,
    fenders: s.fenders && s.fenders in FENDERS ? s.fenders : d.fenders,
    rims: s.rims && s.rims in RIMS ? s.rims : d.rims,
    aero: s.aero && s.aero in AERO_FINISHES ? s.aero : d.aero,
    rimColor: hexOk(s.rimColor) ? s.rimColor : d.rimColor,
    rimFinish: s.rimFinish && s.rimFinish in RIM_FINISHES ? s.rimFinish : d.rimFinish,
    caliper: hexOk(s.caliper) ? s.caliper : d.caliper,
    headlights: s.headlights && s.headlights in HEAD_TINTS ? s.headlights : d.headlights,
    smokedTails: typeof s.smokedTails === 'boolean' ? s.smokedTails : d.smokedTails,
    underglow: s.underglow === '' || hexOk(s.underglow) ? s.underglow! : d.underglow,
    tint: Number.isInteger(s.tint) && s.tint! >= 0 && s.tint! <= 2 ? s.tint! : d.tint,
    exhaust: s.exhaust === 'black' || s.exhaust === 'titanium' || s.exhaust === 'chrome' ? s.exhaust : d.exhaust,
  };
}
