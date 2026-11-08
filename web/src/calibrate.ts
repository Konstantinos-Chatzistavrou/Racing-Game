// Steering wheel calibration: a short step-by-step capture. Wheels have no standard Gamepad mapping (axis order, pedal
// ranges and inversion differ by brand, OS and browser), so each step finds the axis / button that moved the most.
import { deviceKey, type AxisMap, type WheelCalibration } from './devices';

export interface CalStep { id: string; prompt: string; kind: 'rest' | 'axis' | 'button'; optional?: boolean; gear?: number }

export function calibrationSteps(hShifter: boolean, gears: number): CalStep[] {
  const steps: CalStep[] = [
    { id: 'rest', prompt: 'Centre the wheel, take your feet off all pedals, then tap any button', kind: 'rest' },
    { id: 'steer', prompt: 'Turn the wheel all the way to the LEFT and hold it', kind: 'axis' },
    { id: 'throttle', prompt: 'Press the THROTTLE all the way down', kind: 'axis' },
    { id: 'brake', prompt: 'Press the BRAKE all the way down', kind: 'axis' },
    { id: 'clutch', prompt: 'Press the CLUTCH all the way down (Skip if you have no clutch pedal)', kind: 'axis', optional: true },
    { id: 'up', prompt: 'Pull the RIGHT paddle (shift up)', kind: 'button', optional: true },
    { id: 'down', prompt: 'Pull the LEFT paddle (shift down)', kind: 'button', optional: true },
    { id: 'recover', prompt: 'Press the button you want for RECOVER / REPAIR (or Skip)', kind: 'button', optional: true },
    { id: 'camera', prompt: 'Press the button you want for CAMERA (or Skip)', kind: 'button', optional: true },
    { id: 'pause', prompt: 'Press the button you want for PAUSE (or Skip)', kind: 'button', optional: true },
    { id: 'handbrake', prompt: 'Press the HANDBRAKE button / lever (or Skip)', kind: 'button', optional: true },
  ];
  if (hShifter) {
    for (let g = 1; g <= gears; g++) steps.push({ id: `gear${g}`, prompt: `Put the shifter in ${g}${['st', 'nd', 'rd'][g - 1] ?? 'th'} gear`, kind: 'button', optional: true, gear: g + 1 });
    steps.push({ id: 'gearR', prompt: 'Put the shifter in REVERSE', kind: 'button', optional: true, gear: 0 });
  }
  return steps;
}

/** Runs the steps against one gamepad; the menu calls sample() every frame and next() / skip() on clicks. */
export class Calibration {
  step = 0;
  readonly steps: CalStep[];
  private rest: number[] = [];
  private restButtons: boolean[] = [];
  private peak = new Map<number, number>();     // axis -> value furthest from rest seen in this step
  private pressed = -1;
  private armed = false;
  readonly result: WheelCalibration = { steer: { index: 0, rest: 0, full: -1 }, throttle: null, brake: null, clutch: null, buttons: {}, hShifter: {} };
  /** human-readable feedback on what is being detected */
  live = '';

  constructor(readonly padIndex: number, readonly key: string, hShifter: boolean, gears: number) {
    this.steps = calibrationSteps(hShifter, gears);
  }
  static forPad(p: Gamepad, hShifter: boolean, gears: number) { return new Calibration(p.index, deviceKey(p), hShifter, gears); }

  get current(): CalStep | undefined { return this.steps[this.step]; }
  get done() { return this.step >= this.steps.length; }

  private pad() { return (navigator.getGamepads?.() ?? []).find((p) => p?.index === this.padIndex) ?? null; }

  /**
   * Every frame. Returns true when the step finished by itself (a wheel-only user never needs the mouse): an axis
   * step ends when the axis went most of the way and came back, a button step when the button is released.
   */
  sample(): boolean {
    const p = this.pad(), s = this.current;
    if (!p || !s) return false;
    if (s.kind === 'rest') {
      // still: record the rest pose; a button press + release (any paddle) confirms it
      const i = p.buttons.findIndex((b) => b.pressed);
      if (i < 0 && this.pressed < 0) { this.rest = p.axes.slice(); this.restButtons = p.buttons.map(() => false); }
      else if (i >= 0 && this.pressed < 0) this.pressed = i;
      else if (this.pressed >= 0 && !p.buttons[this.pressed]?.pressed) { this.advance(); return true; }
      this.live = `${p.axes.length} axes, ${p.buttons.length} buttons · press any button when ready`;
    } else if (s.kind === 'axis') {
      p.axes.forEach((v, i) => {
        const d = Math.abs(v - (this.rest[i] ?? 0)), prev = this.peak.get(i);
        if (prev === undefined || d > Math.abs(prev - (this.rest[i] ?? 0))) this.peak.set(i, v);
      });
      const best = this.bestAxis();
      this.live = best ? `axis ${best.index}: ${best.rest.toFixed(2)} → ${best.full.toFixed(2)}` : 'move it…';
      if (best && Math.abs(best.full - best.rest) >= 0.7) this.armed = true;
      if (best && this.armed && Math.abs((p.axes[best.index] ?? best.rest) - best.rest) < 0.12) return this.next();
    } else {
      const i = p.buttons.findIndex((b, k) => b.pressed && !this.restButtons[k]);
      if (i >= 0 && this.pressed < 0) this.pressed = i;
      this.live = this.pressed >= 0 ? `button ${this.pressed}` : 'waiting…';
      if (this.pressed >= 0 && !p.buttons[this.pressed]?.pressed) return this.next();
    }
    return false;
  }

  private bestAxis(): AxisMap | null {
    let best: AxisMap | null = null, bd = 0.25;   // must move at least an eighth of the range
    for (const [i, v] of this.peak) {
      const d = Math.abs(v - (this.rest[i] ?? 0));
      const used = [this.result.steer, this.result.throttle, this.result.brake, this.result.clutch].some((m) => m && m.index === i && this.step > 1);
      if (d > bd && !used) { bd = d; best = { index: i, rest: this.rest[i] ?? 0, full: v }; }
    }
    return best;
  }

  /** Accept the current step (returns false if nothing usable was detected and the step is not optional). */
  next(): boolean {
    const s = this.current;
    if (!s) return true;
    if (s.kind === 'axis') {
      const a = this.bestAxis();
      if (!a && !s.optional) return false;
      if (s.id === 'steer' && a) this.result.steer = a;
      if (s.id === 'throttle') this.result.throttle = a;
      if (s.id === 'brake') this.result.brake = a;
      if (s.id === 'clutch') this.result.clutch = a;
    } else if (s.kind === 'button') {
      if (this.pressed < 0 && !s.optional) return false;
      if (this.pressed >= 0) {
        if (s.gear !== undefined) this.result.hShifter[s.gear] = this.pressed;
        else this.result.buttons[s.id as 'up'] = this.pressed;
      }
    }
    this.advance();
    return true;
  }
  skip() { if (this.current?.optional) this.advance(); }
  private advance() { this.step++; this.peak.clear(); this.pressed = -1; this.armed = false; this.live = ''; }
}
