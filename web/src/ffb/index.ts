// Steering wheel force feedback: WebHID connection (Chrome / Edge desktop; the browser asks the user to pick the wheel
// once, after that it reconnects by itself), driver by capability (drivers.ts), and the force the driver feels, made
// in software from the physics so every brand feels the same:
//
//   rack     the core's steering-rack torque (front tyres' aligning moments + lateral force on the caster trail,
//            buf[116]): heavier with cornering load, light as the front tyres pass their peak (understeer)
//   damping  - c(v) * wheel speed: heavy and slow when parked, light at speed (like a power-steering rack)
//   lock     a stiff spring past the car's steering lock (soft lock: the wheel stops where the car's wheels stop)
//   jolts    crash impacts: a short shake
//
// Safety: overall strength and a hard cap (settings), ramps to zero in the menus / when paused, stops on tab switch,
// page close and disconnect. Linux: the browser needs read/write on /dev/hidraw* (a udev rule, see docs).
import { FFB_VENDOR_IDS } from '../devices';
import { LogitechClassic, PidDriver, supportsPid, type FfbDriver } from './drivers';
import type { HIDDevice } from './report';

type HID = { getDevices(): Promise<HIDDevice[]>; requestDevice(o: { filters: { vendorId: number }[] }): Promise<HIDDevice[]>;
  addEventListener(t: 'disconnect', f: (e: { device: HIDDevice }) => void): void };
const hid = (): HID | null => ((navigator as unknown as { hid?: HID }).hid ?? null);

const LOGITECH_CLASSIC = [0xc294, 0xc295, 0xca03, 0xc298, 0xc29a, 0xc299, 0xc29b, 0xc24f, 0xc266];
const RACK_REF_NM = 450;     // rack torque that maps to full force (~1 g cornering on these cars)

export interface FfbFrame {
  driving: boolean;          // false: menus / paused / spectating -> ramp to zero
  rackTorque: number;        // N m, + = turns the wheels left
  speed: number;             // m/s
  wheel: number;             // steering wheel position, -1..1 of the car's lock (+ left), may exceed 1 (past the lock)
  wheelVel: number;          // d wheel / dt, 1/s
  impactKj: number;          // crash this frame (0 none)
}
export interface FfbSettings { ffbStrength: number; ffbMax: number; ffbInvert: boolean }

export class ForceFeedback {
  driver: FfbDriver | null = null;
  device: HIDDevice | null = null;
  status = hid() ? 'No force-feedback wheel connected' : 'This browser has no WebHID (use Chrome or Edge on a desktop for force feedback)';
  private out = 0;
  private jolt = 0;
  private joltPhase = 0;
  private test = 0;
  private sending = false;
  onChange: () => void = () => {};

  static get available() { return !!hid(); }

  constructor() {
    const h = hid();
    if (!h) return;
    h.addEventListener('disconnect', (e) => { if (e.device === this.device) { this.driver = null; this.device = null; this.status = 'Wheel disconnected'; this.onChange(); } });
    addEventListener('pagehide', () => void this.stop());
    document.addEventListener('visibilitychange', () => { if (document.hidden) void this.stop(); });
    void this.connect(false);   // a wheel the user picked before reconnects without asking
  }

  /** request = true: show the browser's device picker (needs a click). */
  async connect(request: boolean) {
    const h = hid();
    if (!h) return false;
    try {
      let list = await h.getDevices();
      if (request) list = await h.requestDevice({ filters: FFB_VENDOR_IDS.map((vendorId) => ({ vendorId })) });
      for (const d of list) if (await this.use(d)) return true;
      if (request && list.length) { this.status = `${list[0].productName}: no force-feedback protocol we can drive (steering and pedals still work)`; this.onChange(); }
    } catch (e) {
      this.status = `Force feedback: ${(e as Error).message}`;
      this.onChange();
    }
    return false;
  }

  private async use(d: HIDDevice) {
    let drv: FfbDriver | null = null;
    if (supportsPid(d)) drv = new PidDriver(d);
    else if (d.vendorId === 0x046d && LOGITECH_CLASSIC.includes(d.productId)) drv = new LogitechClassic(d, d.productId);
    if (!drv) return false;
    try {
      if (!d.opened) await d.open();
      await drv.init();
    } catch (e) {
      this.status = `${d.productName}: ${(e as Error).message}`;
      this.onChange();
      return false;
    }
    this.driver = drv; this.device = d;
    this.status = `${d.productName} · ${drv.name} force feedback`;
    this.onChange();
    return true;
  }

  async setRange(deg: number) { await this.driver?.setRange?.(deg).catch(() => {}); }

  /** A 0.6 s push to the LEFT at moderate force: the menu's "which way?" check. */
  testPulse() { this.test = 0.6; }

  async stop() { this.out = 0; await this.driver?.stop().catch(() => {}); }

  /** Every frame. */
  update(dt: number, f: FfbFrame, s: FfbSettings) {
    if (!this.driver) return;
    if (f.impactKj > 0) this.jolt = Math.max(this.jolt, Math.min(1, f.impactKj / 60));
    this.jolt *= Math.exp(-dt / 0.12);
    this.joltPhase += dt * 25 * 2 * Math.PI;
    let target = 0;
    if (this.test > 0) { this.test -= dt; target = s.ffbInvert ? -0.35 : 0.35; }
    else if (f.driving) {
      const rack = Math.tanh(f.rackTorque / RACK_REF_NM);
      const damping = -f.wheelVel * (0.06 + 0.25 / (1 + f.speed / 4));
      const beyond = Math.abs(f.wheel) - 1;
      const lock = beyond > 0 ? -Math.sign(f.wheel) * Math.min(1, beyond * 10) : 0;
      target = s.ffbStrength * (rack + damping + this.jolt * Math.sin(this.joltPhase)) + lock;
      target = Math.max(-s.ffbMax, Math.min(s.ffbMax, target));
      if (s.ffbInvert) target = -target;
    }
    // ramps: never a step change bigger than the cap per 30 ms (smooth, and gentle when the game pauses)
    const step = Math.max(0.02, s.ffbMax) * Math.min(1, dt / 0.03);
    this.out += Math.max(-step, Math.min(step, target - this.out));
    if (this.sending) return;          // one report in flight at a time: never queue stale forces
    this.sending = true;
    this.driver.setForce(this.out).catch(() => {}).finally(() => { this.sending = false; });
  }
}
