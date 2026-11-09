// Heat: the player's visible 0-5 wanted level (docs/design/heat-and-cops.md). Pure state with its own storage so the
// HUD, the economy and a future cop spawner can read one source of truth. Gained only from what the player does.
export const HEAT_MAX = 5;
const KEY = 'nr.heat.v1';

/** Quiet time before one level cools (ms). Shortest at the top so running hot is uncomfortable. */
const COOL_MS = [0, 90_000, 75_000, 60_000, 45_000, 30_000];

export class Heat {
  level = 0;
  /** ms timestamp of the last offence: cooling starts after it */
  lastGain = 0;

  constructor() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { level?: number; lastGain?: number } | null;
      if (s && Number.isFinite(s.level)) this.level = Math.max(0, Math.min(HEAT_MAX, Math.floor(s.level!)));
      if (s && Number.isFinite(s.lastGain)) this.lastGain = s.lastGain!;
    } catch { /* storage blocked */ }
  }

  get maxed() { return this.level >= HEAT_MAX; }

  /** A player action raised the heat (race finished, car wrecked, reckless in a cop zone). */
  add(n = 1, now = Date.now()) {
    this.level = Math.max(0, Math.min(HEAT_MAX, this.level + n));
    this.lastGain = now;
    this.save();
    return this.level;
  }

  /** One level cools after the quiet window for that level. Returns true when it changed. */
  tick(now = Date.now()) {
    if (this.level <= 0) return false;
    if (now - this.lastGain < COOL_MS[this.level]) return false;
    this.level--;
    this.lastGain = now;
    this.save();
    return true;
  }

  /** Banking: pay to lay low, or a safehouse. Clears the wanted level. */
  clear() { this.level = 0; this.lastGain = Date.now(); this.save(); }

  private save() {
    try { localStorage.setItem(KEY, JSON.stringify({ level: this.level, lastGain: this.lastGain })); } catch { /* blocked */ }
  }
}
