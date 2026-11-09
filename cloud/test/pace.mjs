// Unit test for the pace floor (cloud/src/pace.ts). Fast: node test/pace.mjs
import { PACE_IMPOSSIBLE, PACE_REVIEW, paceOf, raceAvgKmh } from '../src/pace.ts';

let fails = 0, checks = 0;
const eq = (name, got, want) => { checks++; const ok = got === want; if (!ok) fails++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  got ${got}, want ${want}`}`); };

const VMAX = 300;   // km/h, the room's worst case: the fastest car
console.log('pace');

// a normal race must never be touched
eq('a 130 km/h average is ok', paceOf(130, VMAX), 'ok');
eq('a quick 200 km/h average is ok', paceOf(200, VMAX), 'ok');
eq('exactly at the review line is still ok', paceOf(VMAX * PACE_REVIEW, VMAX), 'ok');
eq('just over the review line is review', paceOf(VMAX * PACE_REVIEW + 0.1, VMAX), 'review');
eq('exactly at the impossible line is review (not a penalty)', paceOf(VMAX * PACE_IMPOSSIBLE, VMAX), 'review');
eq('just over the impossible line is impossible', paceOf(VMAX * PACE_IMPOSSIBLE + 0.1, VMAX), 'impossible');
eq('a 2x speed cheat is impossible', paceOf(600, VMAX), 'impossible');

// slow cars: the same average against a slower car is still judged by its own top speed
eq('100 km/h in a 160 km/h car is ok', paceOf(100, 160), 'ok');
eq('130 km/h in a 160 km/h car is review (81 % of top speed)', paceOf(130, 160), 'review');
eq('130 in a 120 km/h car is review', paceOf(130, 120), 'review');

// junk input never punishes anyone
eq('zero average is ok', paceOf(0, VMAX), 'ok');
eq('NaN average is ok', paceOf(NaN, VMAX), 'ok');
eq('missing top speed is ok', paceOf(200, 0), 'ok');
eq('negative top speed is ok', paceOf(200, -5), 'ok');

// the average helper
eq('3 laps of 4000 m in 100 s', Math.round(raceAvgKmh(3, 4000, 100_000)), 432);
eq('no time', raceAvgKmh(3, 4000, 0), 0);
eq('no laps', raceAvgKmh(0, 4000, 100_000), 0);

console.log(fails ? `\n${fails}/${checks} FAILED` : `\nall ${checks} checks passed`);
process.exit(fails ? 1 : 0);
