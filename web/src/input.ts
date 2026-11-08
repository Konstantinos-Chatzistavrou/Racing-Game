// Every input device -> core RawInput (shaping happens in the core's Controls, not here). The last device touched
// drives: keyboard, gamepad (Xbox / PlayStation / Switch / generic, standard mapping), steering wheel (calibrated axes,
// paddles, H-shifter; force feedback in ffb/), touch or tilt on phones. See devices.ts.
import { OUT, type AssistToggles, type RawInput } from './physics/core';
import type { TouchControls } from './touch';
import { BTN, PAD_LABELS, axisValue, classify, defaultCalibration, deviceKey, loadSettings, saveSettings,
  type ControlsSettings, type DeviceKind, type PadFamily, type WheelModel } from './devices';

type RumblePad = Gamepad & { vibrationActuator?: { playEffect(t: string, o: object): Promise<unknown> } };

export class Input {
  readonly raw: RawInput = { steer: 0, throttle: 0, brake: 0, clutch: 0, handbrake: 0, shiftUp: false, shiftDown: false, device: 0, directGear: -99 };
  readonly assists: AssistToggles = { abs: true, tc: true, esc: false, autoGearbox: true };
  readonly settings: ControlsSettings = loadSettings();
  private keys = new Set<string>();
  private pending = { up: false, down: false };
  private padPrev = new Map<number, boolean[]>();
  /** After a spawn the car is held on the brake until the first throttle input (start on a hill). */
  hold = true;
  /** Keeps the hold on (throttle ignored) while the renderer calibrates its resolution. */
  locked = false;
  touch: TouchControls | null = null;
  private source: DeviceKind = 'keys';
  /** the pad / wheel that last moved (Gamepad API index) */
  activeIndex = -1;
  private activeId = '';
  private anchors = new Map<number, { id: string; axes: number[]; buttons: number[] }>();
  family: PadFamily = 'generic';
  wheel: { model: WheelModel; key: string } | null = null;
  /** steering wheel position as a fraction of the car's lock (+ left; beyond +-1 = past the lock) and its speed */
  wheelPos = 0;
  wheelVel = 0;
  onAnyInput = () => {};
  onReset = () => {};
  onCamera = () => {};
  onHud = () => {};
  onLights = () => {};
  onGarage = () => {};
  onPause = () => {};
  onMap = () => {};
  /** an assist quick key (1 2 3 5) changed input.assists */
  onAssistKey = () => {};
  /** the active device changed (HUD help line, menus) */
  onDevice = () => {};
  /** set by the controls menu while it calibrates: game actions from pads / wheels are off */
  suspended = false;

  constructor() {
    addEventListener('keydown', (e) => {
      if (e.repeat || (e.target as HTMLElement)?.tagName === 'INPUT') return;
      this.keys.add(e.code);
      this.setSource('keys');
      this.onAnyInput();
      switch (e.code) {
        case 'KeyE': this.pending.up = true; break;
        case 'KeyQ': this.pending.down = true; break;
        case 'KeyR': this.onReset(); break;
        case 'KeyC': this.onCamera(); break;
        case 'KeyH': this.onHud(); break;
        case 'KeyM': this.onMap(); break;
        case 'KeyL': this.onLights(); break;
        case 'KeyG': this.onGarage(); break;
        case 'Digit1': this.assists.abs = !this.assists.abs; this.onAssistKey(); break;
        case 'Digit2': this.assists.tc = !this.assists.tc; this.onAssistKey(); break;
        case 'Digit3': this.assists.esc = !this.assists.esc; this.onAssistKey(); break;
        case 'Digit5': this.assists.autoGearbox = !this.assists.autoGearbox; this.onAssistKey(); break;
      }
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    addEventListener('gamepadconnected', () => this.onDevice());
    addEventListener('gamepaddisconnected', (e) => { if ((e as GamepadEvent).gamepad.index === this.activeIndex) { this.activeIndex = -1; this.setSource('keys'); } });
  }

  get device(): DeviceKind { return this.source; }
  saveSettings() { saveSettings(this.settings); }
  private setSource(s: DeviceKind) {
    if (s === this.source) return;
    this.source = s;
    this.onDevice();
  }

  // ---- tilt steering (phones): gravity in screen coordinates, angle relative to where the phone was when enabled ----
  private tilt = { on: false, angle: 0, neutral: NaN, listening: false };
  /** Enable tilt steering (call from a click: iOS asks for motion permission). */
  async enableTilt(): Promise<boolean> {
    const DM = (globalThis as unknown as { DeviceMotionEvent?: { requestPermission?: () => Promise<string> } }).DeviceMotionEvent;
    try { if (DM?.requestPermission && (await DM.requestPermission()) !== 'granted') return false; } catch { return false; }
    if (!this.tilt.listening) {
      this.tilt.listening = true;
      addEventListener('devicemotion', (e) => {
        const g = (e as DeviceMotionEvent).accelerationIncludingGravity;
        if (!g || g.x === null || g.y === null) return;
        const a = ((screen.orientation?.angle ?? 0) * Math.PI) / 180;
        const sx = g.x * Math.cos(a) - g.y * Math.sin(a), sy = g.x * Math.sin(a) + g.y * Math.cos(a);
        this.tilt.angle = Math.atan2(sx, sy);   // clockwise from screen-up; a sign flip of g (iOS) turns it by pi only
        if (Number.isNaN(this.tilt.neutral)) this.tilt.neutral = this.tilt.angle;
      });
    }
    this.tilt.on = true;
    this.tilt.neutral = NaN;
    return true;
  }
  disableTilt() { this.tilt.on = false; }
  /** Hold the phone the way you want "straight" and call this. */
  recentreTilt() { this.tilt.neutral = this.tilt.angle; }

  /** Call once per physics tick. Edge events (shifts) are delivered exactly once. */
  poll(): RawInput {
    const k = (c: string) => this.keys.has(c);
    const r = this.raw;
    r.directGear = -99;
    const pads = (navigator.getGamepads?.() ?? []).filter((p): p is Gamepad => !!p && p.connected);
    // which pad / wheel was moved? (it becomes the driving device) "Moved" = changed since it last drove or was first
    // seen, so a wheel left turned, a pedal resting at full scale or a drifting stick never steals control back.
    for (const p of pads) {
      const c = this.kindOf(p);
      let a = this.anchors.get(p.index);
      if (!a || a.id !== p.id) { a = { id: p.id, axes: p.axes.map(() => 0), buttons: p.buttons.map(() => 0) }; this.anchors.set(p.index, a); }
      const anchor = a;
      const moved = p.axes.some((v, i) => Math.abs(v - (anchor.axes[i] ?? 0)) > (c.kind === 'wheel' ? 0.06 : 0.25)) || p.buttons.some((b, i) => b.value - (anchor.buttons[i] ?? 0) > 0.3);
      if (p.index === this.activeIndex && (this.source === 'pad' || this.source === 'wheel') || moved) { anchor.axes = p.axes.slice(); anchor.buttons = p.buttons.map((b) => b.value); }
      // a different device (index), or another device plugged into the same slot (id), or coming back from keys / touch
      if (moved && !this.suspended && (p.index !== this.activeIndex || p.id !== this.activeId || (this.source !== 'pad' && this.source !== 'wheel'))) {
        this.activeIndex = p.index;
        this.activeId = p.id;
        if (c.kind === 'wheel') { this.wheel = { model: c.model, key: deviceKey(p) }; this.setSource('wheel'); }
        else { this.family = c.family; this.wheel = null; this.setSource('pad'); }
        this.onDevice();
      }
    }
    const t = this.touch?.state;
    if (t?.active) { this.setSource('touch'); t.active = false; }   // a new touch: touch drives until keys/pad
    const pad = pads.find((p) => p.index === this.activeIndex);
    if (this.suspended) { r.steer = r.throttle = r.brake = r.clutch = r.handbrake = 0; r.shiftUp = r.shiftDown = false; return r; }

    if (this.source === 'touch' && this.touch) {
      // analog steering pad (or tilt) -> gamepad-style shaping in the core; pedals are full on/off
      const ts = this.touch.state;
      r.device = 1;
      this.touch.setTilt(this.tilt.on && this.settings.touchSteering === 'tilt');
      let steer = ts.steer;
      if (this.tilt.on && this.settings.touchSteering === 'tilt' && !Number.isNaN(this.tilt.neutral)) {
        let d = this.tilt.angle - this.tilt.neutral;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        steer = Math.max(-1, Math.min(1, d / (35 * Math.PI / 180)));   // 35 deg of tilt = full lock
      }
      r.steer = steer; r.throttle = ts.throttle; r.brake = ts.brake; r.handbrake = ts.handbrake; r.clutch = 0;
      const sh = this.touch.takeShifts();
      if (sh.up) this.pending.up = true;
      if (sh.down) this.pending.down = true;
    } else if (this.source === 'wheel' && pad) {
      this.readWheel(pad, r);
    } else if (this.source === 'pad' && pad) {
      r.device = 1;
      const dz = (x: number) => (Math.abs(x) < 0.06 ? 0 : x);
      r.steer = -dz(pad.axes[0] ?? 0);
      r.throttle = pad.buttons[BTN.rt]?.value ?? 0;
      r.brake = pad.buttons[BTN.lt]?.value ?? 0;
      r.handbrake = pad.buttons[BTN.a]?.pressed ? 1 : 0;
      r.clutch = 0;
      const edge = this.edges(pad);
      if (edge(BTN.rb)) this.pending.up = true;
      if (edge(BTN.lb)) this.pending.down = true;
      if (edge(BTN.b)) this.onReset();
      if (edge(BTN.y)) this.onCamera();
      if (edge(BTN.x)) this.onLights();
      if (edge(BTN.back)) this.onHud();
      if (edge(BTN.start)) this.onPause();
    } else {
      r.device = 0;
      r.steer = (k('KeyA') || k('ArrowLeft') ? 1 : 0) - (k('KeyD') || k('ArrowRight') ? 1 : 0);
      r.throttle = k('KeyW') || k('ArrowUp') ? 1 : 0;
      r.brake = k('KeyS') || k('ArrowDown') ? 1 : 0;
      r.handbrake = k('Space') ? 1 : 0;
      r.clutch = k('ShiftLeft') || k('ShiftRight') ? 1 : 0;
    }
    if (this.hold) {
      if (r.throttle > 0.05 && !this.locked) this.hold = false;
      else { r.throttle = 0; r.brake = Math.max(r.brake, 0.5); }
    }
    r.shiftUp = this.pending.up;
    r.shiftDown = this.pending.down;
    this.pending.up = this.pending.down = false;
    return r;
  }

  /** While a menu is up (every frame): a wheel's own Pause button closes the pause menu (pads use Start, menu-nav.ts). */
  menuPoll() {
    if (this.source !== 'wheel') return;
    const pad = (navigator.getGamepads?.() ?? []).find((p) => p?.index === this.activeIndex);
    if (!pad) return;
    const edge = this.edges(pad), i = this.cal(pad).buttons.pause;
    if (i !== undefined && edge(i)) this.onPause();
  }

  /** Forget buttons held right now (call when driving resumes: the button that closed a menu is not a game press). */
  syncPads() {
    for (const p of navigator.getGamepads?.() ?? []) if (p) this.padPrev.set(p.index, p.buttons.map((b) => b.pressed));
    this.pending.up = this.pending.down = false;
  }

  /** Pressed-this-poll test for buttons of one pad. */
  private edges(pad: Gamepad) {
    const prev = this.padPrev.get(pad.index) ?? [];
    const now = pad.buttons.map((b) => b.pressed);
    this.padPrev.set(pad.index, now);
    return (i: number) => !!now[i] && !prev[i];
  }

  private kinds = new Map<string, ReturnType<typeof classify>>();
  kindOf(p: Gamepad) {
    let c = this.kinds.get(p.id + p.mapping);
    if (!c) { c = classify(p); this.kinds.set(p.id + p.mapping, c); }
    return c;
  }

  cal(pad: Gamepad) { return this.settings.calibration[deviceKey(pad)] ?? defaultCalibration(); }
  rotation(pad: Gamepad) {
    const c = this.kindOf(pad);
    return this.settings.wheelRotation[deviceKey(pad)] ?? (c.kind === 'wheel' ? c.model.rotation : 900);
  }

  /**
   * Steering wheel: the calibrated axis gives the wheel angle (rotation / 2 at full lock of the HARDWARE); the car's
   * steering ratio maps that to the road wheels: full car lock at wheelLockToLock / 2 degrees of wheel. A wheel
   * turned past that point is past the car's lock (the force feedback pushes back there). Device = Wheel: the core
   * applies it 1:1, no filtering, no speed-sensitive scaling.
   */
  private lastWheel = 0;
  private readWheel(pad: Gamepad, r: RawInput) {
    const cal = this.cal(pad);
    r.device = 2;
    const raw = pad.axes[cal.steer.index] ?? cal.steer.rest, span = cal.steer.full - cal.steer.rest;
    const frac = Math.abs(span) < 1e-3 ? 0 : (raw - cal.steer.rest) / span;     // +1 = hardware full left
    const deg = frac * this.rotation(pad) / 2;
    const pos = deg / (this.settings.wheelLockToLock / 2);
    const now = performance.now();
    if (this.lastWheel) { const dt = Math.max(1e-3, (now - this.lastWheel) / 1000); this.wheelVel += ((pos - this.wheelPos) / dt - this.wheelVel) * Math.min(1, dt / 0.03); }
    this.lastWheel = now;
    this.wheelPos = pos;
    r.steer = Math.max(-1, Math.min(1, pos));
    r.throttle = axisValue(pad, cal.throttle);
    r.brake = axisValue(pad, cal.brake);
    r.clutch = axisValue(pad, cal.clutch);
    const b = (i?: number) => i !== undefined && !!pad.buttons[i]?.pressed;
    r.handbrake = b(cal.buttons.handbrake) ? 1 : 0;
    const edge = this.edges(pad);
    const e = (i?: number) => i !== undefined && edge(i);
    if (e(cal.buttons.up)) this.pending.up = true;
    if (e(cal.buttons.down)) this.pending.down = true;
    if (e(cal.buttons.recover)) this.onReset();
    if (e(cal.buttons.camera)) this.onCamera();
    if (e(cal.buttons.pause)) this.onPause();
    if (this.settings.hShifter && Object.keys(cal.hShifter).length) {
      r.directGear = 1;                                                    // no gate button held = neutral
      this.assists.autoGearbox = false;                                    // the lever is the gearbox
      for (const [gear, btn] of Object.entries(cal.hShifter)) if (b(btn)) r.directGear = Number(gear);
    }
  }

  /** Help line for the HUD, for the device in use. */
  helpHtml(): string {
    const kb = (k: string) => `<kbd>${k}</kbd>`;
    if (this.source === 'pad') {
      const L = PAD_LABELS[this.family];
      return `${kb('L stick')} Steer &nbsp; ${kb(L.rt)} Throttle &nbsp; ${kb(L.lt)} Brake &nbsp; ${kb(L.rb)}${kb(L.lb)} Shift &nbsp; ${kb(L.a)} Handbrake &nbsp; ${kb(L.b)} Recover &nbsp; ${kb(L.y)} Camera &nbsp; ${kb(L.x)} Lights &nbsp; ${kb(L.start)} Pause`;
    }
    if (this.source === 'wheel') return `${this.wheel?.model.name ?? 'Wheel'} &nbsp; · &nbsp; paddles shift &nbsp; · &nbsp; calibrate and set force feedback in <b>Controls</b> on the main menu`;
    if (this.source === 'touch') return '';
    return `${kb('W')}${kb('S')} Throttle / Brake &nbsp; ${kb('A')}${kb('D')} Steer &nbsp; ${kb('Q')}${kb('E')} Shift &nbsp; ${kb('Space')} Handbrake &nbsp; ${kb('R')} Recover / Repair &nbsp; ${kb('C')} Camera &nbsp; ${kb('L')} Lights &nbsp; ${kb('G')} Menu &nbsp; ${kb('M')} Map &nbsp; ${kb('1-3,5')} Assists &nbsp; ${kb('H')} Hide HUD`;
  }

  /**
   * Gamepad rumble from the physics (Chrome dual-rumble pads: Xbox / DualShock / DualSense), once per frame:
   *  - weak (high-frequency) motor: the front tyres scrubbing past their peak slip angle (understeer), ABS pulsing;
   *  - strong (low-frequency) motor: the rear sliding or spinning up (oversteer, wheelspin), and crash impacts.
   * Phones: the vibration motor for crashes and hard slides (Android; iOS has no web vibration).
   */
  private rumbleAt = 0;
  private absPhase = 0;
  rumble(now: number, out: Float64Array, impact = 0) {
    if (now - this.rumbleAt < 50) return;
    const PEAK = 0.19;   // rad: where the fitted tyre's lateral force peaks (data/tires)
    const sa = (i: number) => Math.abs(out[OUT.wheel(i) + 8]), sr = (i: number) => Math.abs(out[OUT.wheel(i) + 7]);
    const contact = (i: number) => out[OUT.wheel(i) + 5] > 0.5;
    const speed = Math.abs(out[OUT.speed]);
    let weak = 0, strong = 0;
    if (speed > 2) {
      const front = Math.max(contact(0) ? sa(0) : 0, contact(1) ? sa(1) : 0) / PEAK;
      const rearSlide = Math.max(contact(2) ? sa(2) : 0, contact(3) ? sa(3) : 0) / PEAK;
      const spin = Math.max(sr(2), sr(3));
      weak = Math.min(1, Math.max(0, (front - 0.75) * 1.6));
      strong = Math.min(1, Math.max(0, (rearSlide - 0.9) * 1.2) + Math.max(0, (spin - 0.18) * 2));
      if (out[OUT.abs] > 0.5) { this.absPhase = (this.absPhase + 1) % 2; weak = Math.max(weak, this.absPhase ? 0.7 : 0.15); }
    }
    if (impact > 0) strong = Math.max(strong, Math.min(1, 0.3 + impact / 120));
    if (this.source === 'touch') {
      if (this.settings.haptics && (impact > 0 || strong > 0.6)) { this.rumbleAt = now; navigator.vibrate?.(impact > 0 ? Math.min(250, 40 + impact * 2) : 25); }
      return;
    }
    if (this.source !== 'pad' || !this.settings.padVibration) return;
    const pad = (navigator.getGamepads?.() ?? []).find((p) => p?.index === this.activeIndex) as RumblePad | undefined;
    const act = pad?.vibrationActuator;
    if (!act) return;
    this.rumbleAt = now;
    if (weak < 0.02 && strong < 0.02) return;
    act.playEffect('dual-rumble', { startDelay: 0, duration: 70, weakMagnitude: weak, strongMagnitude: strong }).catch(() => {});
  }
}
