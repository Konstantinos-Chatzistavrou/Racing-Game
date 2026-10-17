// Typed wrapper over the WASM bridge (web/wasm/bridge.cpp). Buffer offsets mirror that file.
// Everything here is already in three.js world axes: the bridge does all axis conversion.
import createRsCore from './rs_core.js';
import wasmUrl from './rs_core.wasm?url';

interface RsModule {
  HEAPF64: Float64Array;
  stringToNewUTF8(s: string): number;
  UTF8ToString(p: number): string;
  _free(p: number): void;
  _rs_create(json: number): number;
  _rs_last_error(): number;
  _rs_buffer(id: number): number;
  _rs_info(id: number): void;
  _rs_reset_motion(id: number, speed: number, gear: number): void;
  _rs_rays(id: number): void;
  _rs_step(id: number, dt: number): void;
  _rs_contact(id: number, x: number, y: number, z: number, impulse: number, other: number): void;
  _rs_damage(id: number): void;
  _rs_repair(id: number): void;
}

let mod: RsModule | null = null;
export async function loadCore(): Promise<void> {
  mod = (await createRsCore({ locateFile: () => wasmUrl })) as RsModule;
}

export interface RawInput {
  steer: number; throttle: number; brake: number; clutch: number; handbrake: number;
  shiftUp: boolean; shiftDown: boolean; device: 0 | 1 | 2;
}
export interface AssistToggles { abs: boolean; tc: boolean; esc: boolean; autoGearbox: boolean }

export interface CarInfo {
  mass: number; inertia: [number, number, number]; cgHeight: number;
  redline: number; idle: number; surfaces: { asphalt: number; pavement: number; wall: number };
}

export class CoreCar {
  readonly id: number;
  readonly info: CarInfo;

  constructor(json: string) {
    if (!mod) throw new Error('loadCore() first');
    const p = mod.stringToNewUTF8(json);
    this.id = mod._rs_create(p);
    mod._free(p);
    if (this.id < 0) throw new Error('car config: ' + mod.UTF8ToString(mod._rs_last_error()));
    mod._rs_info(this.id);
    const b = this.buf;
    this.info = {
      mass: b[0], inertia: [b[1], b[2], b[3]], cgHeight: b[4], redline: b[7], idle: b[8],
      surfaces: { asphalt: b[9], pavement: b[10], wall: b[11] },
    };
  }

  // Re-created every access: memory growth detaches old views.
  get buf(): Float64Array {
    return new Float64Array(mod!.HEAPF64.buffer, mod!._rs_buffer(this.id), 256);
  }

  resetMotion(speed: number, gear = -1) { mod!._rs_reset_motion(this.id, speed, gear); }

  /** Crash input for the current tick: point in three world, impulse N s, other object id. */
  contact(p: { x: number; y: number; z: number }, impulse: number, other: number) {
    mod!._rs_contact(this.id, p.x, p.y, p.z, impulse, other);
  }

  repair() { mod!._rs_repair(this.id); }

  damage(): Damage {
    mod!._rs_damage(this.id);
    const b = this.buf;
    const a = (o: number) => [b[o], b[o + 1], b[o + 2], b[o + 3]];
    return {
      crush: a(200), zone: a(204), wheel: a(208), engine: b[212], lastKj: b[213],
      lastPoint: [b[214], b[215], b[216]], lastZone: b[217], impacts: b[218], totaled: b[219] > 0.5, totalKj: b[220],
    };
  }

  /** state: pos(3) quat xyzw(4) vel(3) angvel(3). Returns ray from/to per wheel (FL, FR, RL, RR). */
  rays(state: ArrayLike<number>): Float64Array {
    const b = this.buf;
    for (let i = 0; i < 13; i++) b[i] = state[i];
    mod!._rs_rays(this.id);
    return b.subarray(16, 40);
  }

  /** contacts: 4 x [hit, px, py, pz, nx, ny, nz, surface]. Returns the output view (see bridge). */
  step(contacts: ArrayLike<number>, raw: RawInput, assists: AssistToggles, dt: number): Float64Array {
    const b = this.buf;
    for (let i = 0; i < 32; i++) b[48 + i] = contacts[i];
    b[80] = raw.steer; b[81] = raw.throttle; b[82] = raw.brake; b[83] = raw.clutch; b[84] = raw.handbrake;
    b[85] = raw.shiftUp ? 1 : 0; b[86] = raw.shiftDown ? 1 : 0; b[87] = raw.device;
    b[88] = +assists.abs; b[89] = +assists.tc; b[90] = +assists.esc; b[91] = +assists.autoGearbox;
    mod!._rs_step(this.id, dt);
    return b;
  }
}

export interface Damage {
  crush: number[]; zone: number[]; wheel: number[]; engine: number; lastKj: number;
  lastPoint: [number, number, number]; lastZone: number; impacts: number; totaled: boolean; totalKj: number;
}

// Output offsets (bridge.cpp, rs_step)
export const OUT = {
  force: 96, torque: 99, speed: 102, rpm: 103, gear: 104, sideslip: 105, stalled: 106,
  throttle: 107, brake: 108, steer: 109, abs: 113, tc: 114, esc: 115,
  wheel: (i: number) => 120 + 12 * i,   // centre xyz, steer, spin, contact, load, slipRatio, slipAngle, compression, angVel, surface
} as const;
