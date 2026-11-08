// Input devices: what is plugged in, what it is, and how to read it.
//
//   keyboard            always
//   gamepads            Gamepad API "standard" mapping (Chrome / Edge / Firefox / Safari): Xbox (XInput), PlayStation
//                       (DualShock 4, DualSense), Switch Pro, 8BitDo & co.; labels per family. Non-standard pads are
//                       read with the same indices (most cheap pads match) and can be remapped by calibration.
//   steering wheels     Gamepad API (no standard mapping exists for wheels): recognised by USB vendor / product,
//                       axes and buttons from a short calibration (turn, press each pedal, pull each paddle, put the
//                       H-shifter in each gate), stored per device. Force feedback: ffb/ (WebHID).
//   touch / tilt        phones and tablets (touch.ts); tilt steering from the accelerometer.
//
// Nothing here talks to the game: input.ts reads devices through this module.

export type PadFamily = 'xbox' | 'playstation' | 'switch' | 'generic';
export type DeviceKind = 'keys' | 'pad' | 'wheel' | 'touch';

/** USB vendor / product from a Gamepad id (Chrome: "... (Vendor: 046d Product: c24f)", Firefox: "046d-c24f-..."). */
export function usbIds(id: string): { vendor: number; product: number } | null {
  const c = /Vendor:\s*([0-9a-f]{4})\s*Product:\s*([0-9a-f]{4})/i.exec(id);
  if (c) return { vendor: parseInt(c[1], 16), product: parseInt(c[2], 16) };
  const f = /^([0-9a-f]{1,4})-([0-9a-f]{1,4})-/i.exec(id);
  if (f) return { vendor: parseInt(f[1], 16), product: parseInt(f[2], 16) };
  return null;
}

// ---- steering wheels -------------------------------------------------------------------------------------------------
export interface WheelModel {
  name: string;
  /** wheel rotation lock-to-lock, degrees (what the hardware reports full axis travel as) */
  rotation: number;
  /** force feedback protocol over WebHID: Logitech classic (documented by Logitech), USB HID PID (the standard most
   *  direct-drive bases speak; detected from the report descriptor at connect time anyway), or none we can drive */
  ffb: 'logitech' | 'pid' | 'unknown';
}

const LOGITECH = 0x046d, THRUSTMASTER = 0x044f, FANATEC = 0x0eb7;
/** Known wheels by vendor:product (hex). Unknown wheels from these vendors still work (calibration, PID if present). */
const WHEELS: Record<string, WheelModel> = {
  // Logitech: classic protocol on everything up to the G923 in PlayStation mode
  '046d:c294': { name: 'Logitech (compatibility mode)', rotation: 200, ffb: 'logitech' },
  '046d:c295': { name: 'Logitech MOMO Force', rotation: 270, ffb: 'logitech' },
  '046d:ca03': { name: 'Logitech MOMO Racing', rotation: 270, ffb: 'logitech' },
  '046d:c298': { name: 'Logitech Driving Force Pro', rotation: 900, ffb: 'logitech' },
  '046d:c29a': { name: 'Logitech Driving Force GT', rotation: 900, ffb: 'logitech' },
  '046d:c299': { name: 'Logitech G25', rotation: 900, ffb: 'logitech' },
  '046d:c29b': { name: 'Logitech G27', rotation: 900, ffb: 'logitech' },
  '046d:c24f': { name: 'Logitech G29', rotation: 900, ffb: 'logitech' },
  '046d:c266': { name: 'Logitech G923 (PlayStation)', rotation: 900, ffb: 'logitech' },
  '046d:c262': { name: 'Logitech G920', rotation: 900, ffb: 'unknown' },          // HID++ force feedback
  '046d:c26d': { name: 'Logitech G923 (Xbox)', rotation: 900, ffb: 'unknown' },
  '046d:c26e': { name: 'Logitech G923 (Xbox)', rotation: 900, ffb: 'unknown' },
  '046d:c272': { name: 'Logitech G PRO Racing Wheel', rotation: 1080, ffb: 'pid' },
  '046d:c268': { name: 'Logitech G PRO Racing Wheel', rotation: 1080, ffb: 'pid' },
  // Thrustmaster (proprietary protocols: input + calibration; force feedback only if the base exposes HID PID)
  '044f:b66e': { name: 'Thrustmaster T300 RS', rotation: 1080, ffb: 'unknown' },
  '044f:b66f': { name: 'Thrustmaster T300 RS', rotation: 1080, ffb: 'unknown' },
  '044f:b66d': { name: 'Thrustmaster T300 RS (PS4)', rotation: 1080, ffb: 'unknown' },
  '044f:b677': { name: 'Thrustmaster T150', rotation: 1080, ffb: 'unknown' },
  '044f:b67f': { name: 'Thrustmaster TMX', rotation: 900, ffb: 'unknown' },
  '044f:b696': { name: 'Thrustmaster T248', rotation: 900, ffb: 'unknown' },
  '044f:b669': { name: 'Thrustmaster TX', rotation: 900, ffb: 'unknown' },
  '044f:b65d': { name: 'Thrustmaster (setup mode)', rotation: 900, ffb: 'unknown' },
  '044f:b69b': { name: 'Thrustmaster T818', rotation: 1080, ffb: 'pid' },
  // Fanatec (belt bases proprietary; DD bases PID on recent firmware)
  '0eb7:0e03': { name: 'Fanatec CSL Elite', rotation: 1080, ffb: 'unknown' },
  '0eb7:0005': { name: 'Fanatec CSL Elite', rotation: 1080, ffb: 'unknown' },
  '0eb7:0020': { name: 'Fanatec CSL DD / GT DD Pro', rotation: 1080, ffb: 'pid' },
  '0eb7:0006': { name: 'Fanatec Podium DD', rotation: 1080, ffb: 'pid' },
  '0eb7:0007': { name: 'Fanatec Podium DD', rotation: 1080, ffb: 'pid' },
};
/** Vendors whose devices are wheels / bases (direct drive: all HID PID). */
const WHEEL_VENDORS: Record<number, string> = {
  [LOGITECH]: 'Logitech', [THRUSTMASTER]: 'Thrustmaster', [FANATEC]: 'Fanatec',
  0x346e: 'Moza', 0x16d0: 'Simucube', 0x3670: 'Simagic', 0x2433: 'Asetek', 0x3416: 'Cammus', 0x1fc9: 'Simagic',
  0x0483: 'STM32 base (VRS / Simagic / OpenFFBoard)', 0x1209: 'OpenFFBoard', 0x11ff: 'PXN', 0x30b7: 'Heusinkveld',
};
/** HID PID by default for direct-drive vendors (Moza, Simucube, Simagic, Asetek, Cammus, VRS, OpenFFBoard). */
const PID_VENDORS = new Set([0x346e, 0x16d0, 0x3670, 0x2433, 0x3416, 0x1fc9, 0x0483, 0x1209]);

export function wheelModel(vendor: number, product: number): WheelModel | null {
  const key = `${vendor.toString(16).padStart(4, '0')}:${product.toString(16).padStart(4, '0')}`;
  if (WHEELS[key]) return WHEELS[key];
  if (vendor in WHEEL_VENDORS) return { name: `${WHEEL_VENDORS[vendor]} wheel (${key})`, rotation: 900, ffb: PID_VENDORS.has(vendor) ? 'pid' : 'unknown' };
  return null;
}
export const FFB_VENDOR_IDS = Object.keys(WHEEL_VENDORS).map(Number);

// ---- gamepads ----------------------------------------------------------------------------------------------------------
export function padFamily(pad: Gamepad): PadFamily {
  const id = pad.id.toLowerCase(), u = usbIds(pad.id);
  if (u?.vendor === 0x054c || /dualsense|dualshock|playstation|wireless controller \(standard gamepad vendor: 054c/.test(id)) return 'playstation';
  if (u?.vendor === 0x045e || /xbox|xinput|x-box/.test(id)) return 'xbox';
  if (u?.vendor === 0x057e || /pro controller|joy-con|nintendo/.test(id)) return 'switch';
  return 'generic';
}

/** What a connected Gamepad is. Wheels by USB ids (or "wheel" in the name); anything else is a pad. */
export function classify(pad: Gamepad): { kind: 'pad'; family: PadFamily } | { kind: 'wheel'; model: WheelModel; vendor: number; product: number } {
  const u = usbIds(pad.id);
  if (u) {
    const m = wheelModel(u.vendor, u.product);
    // some vendors make pads too (Logitech F310, Thrustmaster eSwap): a wheel has no standard mapping
    if (m && (pad.mapping !== 'standard' || /wheel|racing|g2[579]|g9[02]|t[0-9]{3}|dd/i.test(pad.id))) return { kind: 'wheel', model: m, vendor: u.vendor, product: u.product };
  }
  if (/wheel|racing wheel|steering/i.test(pad.id) && pad.mapping !== 'standard') return { kind: 'wheel', model: { name: pad.id.slice(0, 40), rotation: 900, ffb: 'unknown' }, vendor: u?.vendor ?? 0, product: u?.product ?? 0 };
  return { kind: 'pad', family: padFamily(pad) };
}

/** Button labels per family, standard-mapping indices. */
export const PAD_LABELS: Record<PadFamily, Record<string, string>> = {
  xbox: { a: 'A', b: 'B', x: 'X', y: 'Y', lb: 'LB', rb: 'RB', lt: 'LT', rt: 'RT', back: 'View', start: 'Menu', ls: 'LS', rs: 'RS' },
  playstation: { a: '✕', b: '○', x: '□', y: '△', lb: 'L1', rb: 'R1', lt: 'L2', rt: 'R2', back: 'Create', start: 'Options', ls: 'L3', rs: 'R3' },
  switch: { a: 'B', b: 'A', x: 'Y', y: 'X', lb: 'L', rb: 'R', lt: 'ZL', rt: 'ZR', back: '−', start: '+', ls: 'LS', rs: 'RS' },
  generic: { a: '1', b: '2', x: '3', y: '4', lb: 'L1', rb: 'R1', lt: 'L2', rt: 'R2', back: 'Select', start: 'Start', ls: 'L3', rs: 'R3' },
};
/** Standard-mapping button indices. */
export const BTN = { a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, lt: 6, rt: 7, back: 8, start: 9, ls: 10, rs: 11, up: 12, down: 13, left: 14, right: 15 } as const;

/** Game actions on a pad (standard layout; same physical positions on every family). */
export const PAD_BINDINGS: { action: string; key: keyof typeof BTN | 'lstick' }[] = [
  { action: 'Steer', key: 'lstick' }, { action: 'Throttle', key: 'rt' }, { action: 'Brake', key: 'lt' },
  { action: 'Shift up', key: 'rb' }, { action: 'Shift down', key: 'lb' }, { action: 'Handbrake', key: 'a' },
  { action: 'Recover / repair', key: 'b' }, { action: 'Camera', key: 'y' }, { action: 'Lights', key: 'x' },
  { action: 'Pause', key: 'start' }, { action: 'Hide HUD', key: 'back' },
];

// ---- wheel calibration + settings (per device, localStorage) -------------------------------------------------------------
export interface AxisMap { index: number; /** raw value with the pedal released / wheel centred */ rest: number; /** raw value at full press / full left */ full: number }
export interface WheelCalibration {
  steer: AxisMap;                 // full = full LEFT
  throttle: AxisMap | null; brake: AxisMap | null; clutch: AxisMap | null;
  /** buttons: shift up / down paddles, handbrake, recover, camera, pause; H-shifter gate buttons by gear index */
  buttons: Partial<Record<'up' | 'down' | 'handbrake' | 'recover' | 'camera' | 'pause', number>>;
  hShifter: Partial<Record<number, number>>;   // gear index (0 R, 2 1st ...) -> button index
}
export interface ControlsSettings {
  /** degrees of steering wheel rotation for full car lock (a road car: ~2.2-2.5 turns lock to lock) */
  wheelLockToLock: number;
  /** wheel rotation reported by the hardware (from the model, adjustable) */
  wheelRotation: Record<string, number>;
  calibration: Record<string, WheelCalibration>;
  ffbStrength: number;            // 0..1 overall gain
  ffbMax: number;                 // 0..1 cap (safety on strong direct-drive bases)
  ffbInvert: boolean;
  padVibration: boolean;
  touchSteering: 'touch' | 'tilt';
  haptics: boolean;
  hShifter: boolean;
}
const KEY = 'nr.controls.v1';
export function defaultSettings(): ControlsSettings {
  return { wheelLockToLock: 720, wheelRotation: {}, calibration: {}, ffbStrength: 0.6, ffbMax: 0.7, ffbInvert: false, padVibration: true,
    touchSteering: 'touch', haptics: true, hShifter: false };
}
export function loadSettings(): ControlsSettings {
  const d = defaultSettings();
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (s && typeof s === 'object') return { ...d, ...s, wheelRotation: { ...(s.wheelRotation ?? {}) }, calibration: { ...(s.calibration ?? {}) } };
  } catch { /* storage blocked */ }
  return d;
}
export function saveSettings(s: ControlsSettings) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* blocked */ } }

/** 0..1 from a calibrated axis (rest -> 0, full -> 1). */
export function axisValue(pad: Gamepad, m: AxisMap | null): number {
  if (!m) return 0;
  const v = pad.axes[m.index] ?? m.rest, span = m.full - m.rest;
  return Math.abs(span) < 1e-3 ? 0 : Math.min(1, Math.max(0, (v - m.rest) / span));
}

/**
 * A default guess for an uncalibrated wheel (Chrome on Windows / Linux, most bases): axis 0 steering (-1 left .. +1
 * right), pedals unknown until calibrated. Good enough to steer; the menu asks for a calibration.
 */
export function defaultCalibration(): WheelCalibration {
  return { steer: { index: 0, rest: 0, full: -1 }, throttle: null, brake: null, clutch: null, buttons: {}, hShifter: {} };
}

/** Stable key for per-device settings. */
export const deviceKey = (pad: Gamepad) => { const u = usbIds(pad.id); return u ? `${u.vendor.toString(16)}:${u.product.toString(16)}` : pad.id.slice(0, 60); };
