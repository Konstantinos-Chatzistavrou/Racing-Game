// Node check of the core RaceTracker through the bridge: move a point along the route centreline
// at 20 m/s for two laps; the tracker must count 2 laps of route length / 20 s each.
import fs from 'node:fs';
import createRsCore from '../src/physics/rs_core.js';
const M = await createRsCore({ wasmBinary: fs.readFileSync(new URL('../src/physics/rs_core.wasm', import.meta.url)) });
const route = JSON.parse(fs.readFileSync(new URL('../../data/tracks/city_route.json', import.meta.url), 'utf8'));
const p = M.stringToNewUTF8(JSON.stringify(route));
if (M._rs_race_create(p, 0) < 0) throw new Error(M.UTF8ToString(M._rs_last_error()));
const S = route.samples, three = (s) => [s.x, s.z, -s.y];          // core (Z-up) -> three
const car = M._rs_race_add(...three(S[0]));
const b = () => new Float64Array(M.HEAPF64.buffer, M._rs_race_buffer(), 16);
// cumulative distance along samples
const d = [0]; for (let i = 1; i < S.length; i++) d.push(d[i - 1] + Math.hypot(S[i].x - S[i - 1].x, S[i].y - S[i - 1].y, S[i].z - S[i - 1].z));
const L = route.length_m, v = 20, dt = 1 / 30;
for (let t = 0; t < (2 * L) / v + 1; t += dt) {
  const s = (v * t) % L;
  let i = d.findIndex((x) => x > s); if (i <= 0) i = S.length - 1 ? 1 : 1;
  const a = S[i - 1], c = S[i] ?? S[0], f = (s - d[i - 1]) / ((d[i] ?? L) - d[i - 1]);
  const pos = three({ x: a.x + (c.x - a.x) * f, y: a.y + (c.y - a.y) * f, z: a.z + (c.z - a.z) * f });
  M._rs_race_update(car, ...pos, t);
}
const r = b();
console.log(`laps ${r[0]}  last ${r[2].toFixed(2)} s  best ${r[3].toFixed(2)} s  (expected ${(L / v).toFixed(2)} s)  route ${r[7].toFixed(0)} m`);
