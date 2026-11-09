// Pace plausibility for a finished race: the average speed cannot exceed the car's real top speed, so a pace far
// above it is physics, not skill. This is deliberately conservative - a false accusation costs an honest player a
// strike, so "impossible" needs a 25 % margin over the top-speed table, and "review" is a flag with NO penalty at all
// (a note on the result; the room already records the top-3 replays).
export type Pace = 'ok' | 'review' | 'impossible';

/** above this multiple of the car's top speed the race is physically impossible (margin covers table/float slack) */
export const PACE_IMPOSSIBLE = 1.25;
/** above this multiple it is merely extraordinary: worth a human look, never a punishment */
export const PACE_REVIEW = 0.72;

export function paceOf(avgKmh: number, vmaxKmh: number): Pace {
  if (!Number.isFinite(avgKmh) || !Number.isFinite(vmaxKmh) || vmaxKmh <= 0 || avgKmh <= 0) return 'ok';
  if (avgKmh > vmaxKmh * PACE_IMPOSSIBLE) return 'impossible';
  if (avgKmh > vmaxKmh * PACE_REVIEW) return 'review';
  return 'ok';
}

/** Average speed of a finished race in km/h (0 when there is no usable time). */
export function raceAvgKmh(laps: number, routeLength: number, elapsedMs: number): number {
  if (!(elapsedMs > 0) || !(laps > 0) || !(routeLength > 0)) return 0;
  return ((laps * routeLength) / (elapsedMs / 1000)) * 3.6;
}
