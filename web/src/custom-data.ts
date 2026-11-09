// Car looks as data (the garage's choices): types, option lists, defaults and the validator. No three.js, so the online
// service (cloud/) can check the looks it stores with each car; scene/custom.ts draws them.
export type WingKind = 'stock' | 'none' | 'ducktail' | 'gt';
export type AeroFinish = 'carbon' | 'gloss' | 'matte' | 'body';
export type RimFinish = 'chrome' | 'gloss' | 'satin' | 'matte';
export type HeadTint = 'white' | 'ice' | 'yellow';
export interface Custom {
  livery: number;            // 0 none, 1 twin stripes, 2 wide stripe, 3 side stripe, 4 two-tone
  liveryColor: string;
  wing: WingKind;
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
export const WINGS: Record<WingKind, string> = { stock: 'Stock', none: 'No wing', ducktail: 'Ducktail', gt: 'GT wing' };
export const AERO_FINISHES: Record<AeroFinish, string> = { carbon: 'Carbon', gloss: 'Gloss black', matte: 'Matte black', body: 'Body colour' };
export const RIM_FINISHES: Record<RimFinish, string> = { chrome: 'Chrome', gloss: 'Gloss', satin: 'Satin', matte: 'Matte' };
export const HEAD_TINTS: Record<HeadTint, string> = { white: 'White', ice: 'Ice blue', yellow: 'Yellow' };
export const PART_COLOURS = ['#f4f4f6', '#15171c', '#9aa0aa', '#c8a24a', '#b0632d', '#c0160f', '#e8890a', '#e6c619', '#1f9d55', '#14b8a6', '#1d4ed8', '#6d28d9', '#d946a8'];
export const GLOW_COLOURS = ['', '#ff2d55', '#2a9dff', '#3ddc84', '#b14dff', '#ffffff', '#ffb547'];

export function defaultCustom(): Custom {
  return { livery: 0, liveryColor: '#f4f4f6', wing: 'stock', aero: 'carbon', rimColor: '#9aa0aa', rimFinish: 'chrome', caliper: '#c0160f',
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
