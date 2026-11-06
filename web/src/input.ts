// Keyboard + gamepad -> core RawInput (shaping happens in the core's Controls, not here).
import type { AssistToggles, RawInput } from './physics/core';
import type { TouchControls } from './touch';

export class Input {
  readonly raw: RawInput = { steer: 0, throttle: 0, brake: 0, clutch: 0, handbrake: 0, shiftUp: false, shiftDown: false, device: 0 };
  readonly assists: AssistToggles = { abs: true, tc: true, esc: false, autoGearbox: true };
  private keys = new Set<string>();
  private pending = { up: false, down: false };
  private padPrev: boolean[] = [];
  /** After a spawn the car is held on the brake until the first throttle input (start on a hill). */
  hold = true;
  /** Keeps the hold on (throttle ignored) while the renderer calibrates its resolution. */
  locked = false;
  touch: TouchControls | null = null;
  private source: 'keys' | 'pad' | 'touch' = 'keys';
  onAnyInput = () => {};
  onReset = () => {};
  onCamera = () => {};
  onHud = () => {};
  onLights = () => {};
  onGarage = () => {};

  constructor() {
    addEventListener('keydown', (e) => {
      if (e.repeat || (e.target as HTMLElement)?.tagName === 'INPUT') return;
      this.keys.add(e.code);
      this.source = 'keys';
      this.onAnyInput();
      switch (e.code) {
        case 'KeyE': this.pending.up = true; break;
        case 'KeyQ': this.pending.down = true; break;
        case 'KeyR': this.onReset(); break;
        case 'KeyC': this.onCamera(); break;
        case 'KeyH': this.onHud(); break;
        case 'KeyL': this.onLights(); break;
        case 'KeyG': this.onGarage(); break;
        case 'Digit1': this.assists.abs = !this.assists.abs; break;
        case 'Digit2': this.assists.tc = !this.assists.tc; break;
        case 'Digit3': this.assists.esc = !this.assists.esc; break;
        case 'Digit5': this.assists.autoGearbox = !this.assists.autoGearbox; break;
      }
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }

  /** Call once per physics tick. Edge events (shifts) are delivered exactly once. */
  poll(): RawInput {
    const k = (c: string) => this.keys.has(c);
    const r = this.raw;
    const pad = navigator.getGamepads?.().find((p) => p && p.connected);
    if (pad && (Math.abs(pad.axes[0]) > 0.08 || pad.buttons[7]?.value > 0.05 || pad.buttons[6]?.value > 0.05)) this.source = 'pad';
    const t = this.touch?.state;
    if (t?.active) { this.source = 'touch'; t.active = false; }   // a new touch: touch drives until keys/pad
    r.device = this.source === 'keys' ? 0 : 1;
    if (this.source === 'touch' && this.touch) {
      // analog steering pad -> gamepad-style shaping in the core; pedals are full on/off
      const ts = this.touch.state;
      r.steer = ts.steer; r.throttle = ts.throttle; r.brake = ts.brake; r.handbrake = ts.handbrake; r.clutch = 0;
      const sh = this.touch.takeShifts();
      if (sh.up) this.pending.up = true;
      if (sh.down) this.pending.down = true;
    } else if (this.source === 'pad' && pad) {
      const dz = (x: number) => (Math.abs(x) < 0.06 ? 0 : x);
      r.steer = -dz(pad.axes[0]);
      r.throttle = pad.buttons[7]?.value ?? 0;
      r.brake = pad.buttons[6]?.value ?? 0;
      r.handbrake = pad.buttons[1]?.pressed ? 1 : 0;
      r.clutch = 0;
      const up = !!pad.buttons[0]?.pressed, down = !!pad.buttons[2]?.pressed;
      if (up && !this.padPrev[0]) this.pending.up = true;
      if (down && !this.padPrev[2]) this.pending.down = true;
      this.padPrev[0] = up; this.padPrev[2] = down;
    } else {
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
}
