// A police pursuit (docs/design/heat-and-cops.md). One unmarked car that closes along the route spline, spawned only
// from a player action (a race finishing at 3+ heat). It is not a timer bar: the player escapes by breaking away
// (140 m of clear road for 4 s) or by losing it behind the city - the gap is the only clock. Bust needs the cop close
// AND the player slow, so a 30 s scramble ends with a fine and a reset heat, never a wiped car.
import * as THREE from 'three/webgpu';
import type { Lane } from './ai';

const CHASE_SPEED = 53;        // m/s the cop settles at (~190 km/h): faster than a stock car, catchable with upgrades
const ESCAPE_GAP = 140;        // m of clear road that counts as "lost him"
const ESCAPE_HOLD = 4;         // s to hold that gap
const BUST_GAP = 9;            // m
const BUST_SLOW = 18;          // km/h under which a close cop can pull you over
const BUST_HOLD = 1.5;         // s
const GIVE_UP = 35;            // s a pursuit lasts before the cop breaks off
const LOS_HOLD = 3.5;          // s out of sight before the cop loses you

export interface CopHooks {
  /** the cop got close while the player was slow: fine + impound + heat reset */
  bust(): void;
  /** the player broke away */
  escaped(): void;
}

export class Cops {
  active = false;
  /** arc length of the cop along the lane */
  s = 0;
  speed = 0;
  private gap = 0;
  private far = 0;
  private slow = 0;
  private t = 0;
  /** where the car actually is, for line-of-sight tests */
  readonly world = new THREE.Vector3();
  /** seconds the cop has been unable to see the player */
  private blind = 0;
  private playerS = 0;
  /** the visual car; null until the model loads, the logic runs either way */
  root: THREE.Object3D | null = null;

  constructor(private lane: Lane, private hooks: CopHooks) {}

  /** Nearest arc length to a world point, searched around a hint (2 m spacing, so +-120 m is enough for a frame). */
  nearest(pos: THREE.Vector3, hint: number) {
    let best = hint, bestD = Infinity;
    const n = this.lane.n;
    const h = this.lane.idx(hint);
    for (let k = -60; k <= 60; k++) {
      const i = (h + k + n) % n;
      const p = this.lane.pts[i];
      const d = (p.x - pos.x) ** 2 + (p.z - pos.z) ** 2;
      if (d < bestD) { bestD = d; best = i * (this.lane.length / n); }
    }
    return best;
  }

  spawn(playerS: number, playerPos: THREE.Vector3) {
    this.active = true;
    this.s = playerS - 35;          // behind the player, on the road
    this.speed = 0;
    this.playerS = playerS;
    this.gap = -35;
    this.far = 0; this.slow = 0; this.t = 0;
    if (this.root) { this.root.visible = true; this.place(playerPos); }
  }

  breakOff() { this.active = false; if (this.root) this.root.visible = false; }

  /** dt seconds, the player's arc length and world position, speed km/h. */
  update(dt: number, playerS: number, playerPos: THREE.Vector3, kmh: number) {
    if (!this.active) return;
    this.t += dt;
    this.playerS = playerS;
    // signed gap on the loop: positive = player ahead
    const half = this.lane.length / 2;
    const raw = ((playerS - this.s) % this.lane.length + this.lane.length) % this.lane.length;
    this.gap = raw > half ? raw - this.lane.length : raw;
    // Hold a 6 m tail: target arc = playerS - 6, approached proportionally so it settles instead of overshooting
    // (the first version flew past the player and parked 12 m ahead, where it could never pull anyone over).
    let d = ((playerS - 6 - this.s) % this.lane.length + this.lane.length) % this.lane.length;
    if (d > half) d -= this.lane.length;
    const want = Math.max(-6, Math.min(CHASE_SPEED, d * 1.4));
    this.speed += (want - this.speed) * Math.min(1, dt * 3);
    this.s += this.speed * dt;
    this.place(playerPos);

    if (Math.abs(this.gap) > ESCAPE_GAP) this.far += dt; else this.far = 0;
    if (Math.abs(this.gap) < BUST_GAP && kmh < BUST_SLOW) this.slow += dt; else this.slow = 0;
    if (this.slow >= BUST_HOLD) { this.breakOff(); this.hooks.bust(); return; }
    if (this.far >= ESCAPE_HOLD || this.t > GIVE_UP) { this.breakOff(); this.hooks.escaped(); }
  }

  /**
   * Line-of-sight escape: the cop loses you when a building blocks the line for LOS_HOLD seconds - alleys, corners and
   * structures break a chase, which is the skill the brief asks for instead of a timer bar.
   */
  see(blocked: boolean, dt: number) {
    if (!this.active) return;
    this.blind = blocked ? this.blind + dt : 0;
    if (this.blind >= LOS_HOLD) { this.breakOff(); this.hooks.escaped(); }
  }

  /** Where the player hears it: 0..1, closer is louder. */
  get proximity() { return this.active ? Math.max(0, 1 - Math.abs(this.gap) / 160) : 0; }
  get distance() { return Math.abs(this.gap); }

  private place(target: THREE.Vector3) {
    const p = this.lane.at(this.s, 0.7, this.world);
    const i = this.lane.idx(this.s);
    const r = this.lane.right[i];
    if (this.root) {
      this.root.position.set(p.x, p.y + 0.02, p.z);
      this.root.rotation.y = Math.atan2(r.z, -r.x);   // forward = right x up
      this.root.visible = true;
    }
    void target;
  }
}
