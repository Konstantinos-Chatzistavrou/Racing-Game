// Force feedback drivers over WebHID. Both play ONE constant force that the game updates every frame (spring, damping,
// kerb and crash jolts are computed in software from the physics, see ffb/index.ts), which is the one effect every
// force-feedback wheel supports and keeps the behaviour identical across brands.
//
//  PidDriver        USB HID "Physical Interface Device" class (USB-IF, Device Class Definition for PID 1.0): the
//                   standard almost every direct-drive base implements (Moza, Simucube, Simagic, VRS, Asetek, Cammus,
//                   OpenFFBoard, Fanatec / Logitech / Thrustmaster DD on recent firmware). The reports are found by
//                   the usages they contain, then packed from the device's own descriptor (report.ts).
//  LogitechClassic  Logitech's classic force-feedback protocol (Logitech "Force Feedback Protocol" document; 7-byte
//                   output reports): Driving Force Pro / GT, G25, G27, G29, G923 in PlayStation mode.
//
// Written from the public specifications; no code from GPL-2.0-only drivers (see LICENSE / CREDITS).
import { allReports, hasUsage, packReport, rangeOf, unpackReport, usage, type HIDDevice, type HIDReportInfo } from './report';

export interface FfbDriver {
  readonly name: string;
  init(): Promise<void>;
  /** f: -1..1, + = turn the wheel LEFT (counter-clockwise from the driver's seat) */
  setForce(f: number): Promise<void>;
  /** hardware rotation range, if the device can set it (degrees) */
  setRange?(deg: number): Promise<void>;
  stop(): Promise<void>;
}

const PID = 0x0f, GD = 0x01;
const U = {
  setEffect: usage(PID, 0x21), blockIndex: usage(PID, 0x22), effectType: usage(PID, 0x25), constant: usage(PID, 0x26),
  duration: usage(PID, 0x50), samplePeriod: usage(PID, 0x51), gain: usage(PID, 0x52), triggerButton: usage(PID, 0x53),
  triggerRepeat: usage(PID, 0x54), axesEnable: usage(PID, 0x55), directionEnable: usage(PID, 0x56), direction: usage(PID, 0x57),
  startDelay: usage(PID, 0xa7), magnitude: usage(PID, 0x70), effectOp: usage(PID, 0x78), opStart: usage(PID, 0x79),
  opStartSolo: usage(PID, 0x7a), opStop: usage(PID, 0x7b), loopCount: usage(PID, 0x7c), deviceGain: usage(PID, 0x7e),
  dcEnable: usage(PID, 0x97), dcStopAll: usage(PID, 0x99), dcReset: usage(PID, 0x9a), dcContinue: usage(PID, 0x9c),
  blockLoadStatus: usage(PID, 0x8b), blockLoadSuccess: usage(PID, 0x8c), byteCount: usage(PID, 0xac),
  x: usage(GD, 0x30), ordinal1: usage(0x0a, 0x01),
  offset: usage(PID, 0x6f), period: usage(PID, 0x72), rampStart: usage(PID, 0x75),
};
// Note: "Effect Type" (0x25), "Direction" (0x57), "Axes Enable" (0x55) are logical COLLECTIONS in PID descriptors: the
// report items carry the usages inside them (ET Constant Force 0x26..., Ordinals, X / Y), which is what we look for.

/** Can this device do HID PID force feedback? (an output report carrying a PID constant-force magnitude) */
export function supportsPid(d: { collections: HIDDevice['collections'] }): boolean {
  const outs = allReports(d.collections, 'outputReports').map((x) => x.r);
  return outs.some((r) => hasUsage(r, U.magnitude)) && outs.some((r) => hasUsage(r, U.constant));
}

export class PidDriver implements FfbDriver {
  readonly name = 'USB HID PID';
  private rep: Record<'setEffect' | 'constant' | 'op' | 'control' | 'gain', HIDReportInfo | undefined> = { setEffect: undefined, constant: undefined, op: undefined, control: undefined, gain: undefined };
  private create?: HIDReportInfo;
  private blockLoad?: HIDReportInfo;
  private block = 1;
  private magRange = { min: -10000, max: 10000 };
  private last = NaN;

  constructor(private d: HIDDevice) {
    const outs = allReports(d.collections, 'outputReports').map((x) => x.r);
    const feats = allReports(d.collections, 'featureReports').map((x) => x.r);
    // Set Constant Force: block + magnitude only (Set Periodic also has a magnitude, with offset and period)
    this.rep.constant = outs.find((r) => hasUsage(r, U.magnitude) && !hasUsage(r, U.offset) && !hasUsage(r, U.period) && !hasUsage(r, U.duration));
    this.rep.setEffect = outs.find((r) => hasUsage(r, U.constant) && hasUsage(r, U.duration));
    this.rep.op = outs.find((r) => hasUsage(r, U.opStart));
    this.rep.control = outs.find((r) => hasUsage(r, U.dcEnable));
    this.rep.gain = outs.find((r) => hasUsage(r, U.deviceGain));
    this.create = feats.find((r) => hasUsage(r, U.constant) && hasUsage(r, U.byteCount) && !hasUsage(r, U.blockLoadSuccess));
    this.blockLoad = feats.find((r) => hasUsage(r, U.blockLoadSuccess));   // inside the Block Load Status collection
    if (this.rep.constant) this.magRange = rangeOf(this.rep.constant, U.magnitude) ?? this.magRange;
  }

  private send(r: HIDReportInfo | undefined, values: [number, number][], select: number[] = []) {
    if (!r) return Promise.resolve();
    return this.d.sendReport(r.reportId ?? 0, packReport(r, new Map(values), select) as BufferSource);
  }

  async init() {
    if (!this.rep.constant || !this.rep.setEffect || !this.rep.op) throw new Error('PID reports missing (constant force / set effect / effect operation)');
    await this.send(this.rep.control, [], [U.dcReset]).catch(() => {});
    await this.send(this.rep.control, [], [U.dcEnable]).catch(() => {});
    if (this.rep.gain) await this.send(this.rep.gain, [[U.deviceGain, rangeOf(this.rep.gain, U.deviceGain)?.max ?? 255]]);
    // allocate an effect block (devices with device-managed pools); fall back to block 1
    if (this.create && this.blockLoad) {
      await this.d.sendFeatureReport(this.create.reportId ?? 0, packReport(this.create, new Map([[U.byteCount, 0]]), [U.constant]) as BufferSource).catch(() => {});
      try {
        const v = await this.d.receiveFeatureReport(this.blockLoad.reportId ?? 0);
        const { values, selected } = unpackReport(this.blockLoad, v, this.blockLoad.reportId ? 1 : 0);
        if (selected.includes(U.blockLoadSuccess) && (values.get(U.blockIndex) ?? 0) > 0) this.block = values.get(U.blockIndex)!;
      } catch { /* report-id-less devices: block 1 */ }
    }
    const se = this.rep.setEffect;
    const dir = rangeOf(se, U.direction) ?? rangeOf(se, U.ordinal1);
    await this.send(se, [
      [U.blockIndex, this.block], [U.duration, rangeOf(se, U.duration)?.max ?? 0xffff], [U.samplePeriod, 0], [U.gain, rangeOf(se, U.gain)?.max ?? 255],
      [U.triggerButton, rangeOf(se, U.triggerButton)?.max ?? 0xff], [U.triggerRepeat, 0], [U.axesEnable, 1], [U.x, 1], [U.directionEnable, 1],
      // one steering axis: the force's sign is in its magnitude; direction = 90 deg of the logical circle (Windows
      // DirectInput convention for a wheel's X axis), on the "direction" or the first ordinal field
      [U.direction, dir ? dir.min + (dir.max - dir.min + 1) / 4 : 0], [U.ordinal1, dir ? dir.min + (dir.max - dir.min + 1) / 4 : 0], [U.startDelay, 0],
    ], [U.constant]);
    await this.send(this.rep.constant, [[U.blockIndex, this.block], [U.magnitude, 0]]);
    await this.send(this.rep.op, [[U.blockIndex, this.block], [U.loopCount, 1]], [U.opStart]);
  }

  async setForce(f: number) {
    const m = Math.round(Math.max(-1, Math.min(1, f)) * (f >= 0 ? this.magRange.max : -this.magRange.min));
    if (m === this.last) return;
    this.last = m;
    // DirectInput / PID: positive magnitude along +X pushes the wheel to the right; ours (+ = left) flips it
    await this.send(this.rep.constant, [[U.blockIndex, this.block], [U.magnitude, -m]]);
  }

  async stop() {
    this.last = NaN;
    await this.send(this.rep.constant, [[U.blockIndex, this.block], [U.magnitude, 0]]).catch(() => {});
    await this.send(this.rep.op, [[U.blockIndex, this.block], [U.loopCount, 1]], [U.opStop]).catch(() => {});
    await this.send(this.rep.control, [], [U.dcStopAll]).catch(() => {});
  }
}

/** Logitech classic protocol: 7-byte output reports, report id 0 (wheels that expose one output report). */
export class LogitechClassic implements FfbDriver {
  readonly name = 'Logitech classic';
  private last = -1;
  constructor(private d: HIDDevice, private product: number) {}

  /** The 7 command bytes (exported for the unit test). */
  static constantForce(f: number): Uint8Array {
    // slot 1, download & play (0x11), constant force (0x08), level 0x00..0xFF with 0x80 = no force; lower levels turn the
    // wheel to the left as seen by the driver
    const level = Math.max(0, Math.min(255, Math.round(0x80 - Math.max(-1, Math.min(1, f)) * 0x7f)));
    return new Uint8Array([0x11, 0x08, level, 0x80, 0x00, 0x00, 0x00]);
  }
  static autocenterOff(): Uint8Array { return new Uint8Array([0xf5, 0, 0, 0, 0, 0, 0]); }
  static stopAll(): Uint8Array { return new Uint8Array([0xf3, 0, 0, 0, 0, 0, 0]); }
  /** Rotation range (DFGT, G25, G27, G29, G923-PS): extended command 0xF8 0x81. */
  static range(deg: number): Uint8Array {
    const r = Math.max(40, Math.min(900, Math.round(deg)));
    return new Uint8Array([0xf8, 0x81, r & 0xff, r >> 8, 0, 0, 0]);
  }
  private send(b: Uint8Array) { return this.d.sendReport(0, b as BufferSource); }
  async init() {
    await this.send(LogitechClassic.autocenterOff());          // the game provides all centring
    await this.send(LogitechClassic.constantForce(0));
  }
  async setRange(deg: number) {
    if ([0xc29a, 0xc299, 0xc29b, 0xc24f, 0xc266].includes(this.product)) await this.send(LogitechClassic.range(deg));
  }
  async setForce(f: number) {
    const b = LogitechClassic.constantForce(f);
    if (b[2] === this.last) return;
    this.last = b[2];
    await this.send(b);
  }
  async stop() { this.last = -1; await this.send(LogitechClassic.constantForce(0)).catch(() => {}); await this.send(LogitechClassic.stopAll()).catch(() => {}); }
}
