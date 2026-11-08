// End-to-end test of the online service against a local `wrangler dev` (npm run dev; .dev.vars sets ALLOW_TEST_IP=1).
// Simulated players drive the real NYC route in real time over WebSockets (positions at 4 Hz, the game's rate):
//   ranked race:   6 honest drivers on 6 networks + 2 more on the first network (only one of them counts: 2 per network)
//                  + one who never moves (inactive) + one who teleports (flagged, strike)  -> ranked, paid
//   unranked race: 5 drivers                                                                -> no rewards
// then the shop: level gates and credits are enforced by the server.
// Usage: node test/sim.mjs [http://127.0.0.1:8787]   (takes ~2 minutes: one real lap at ~130 km/h)
import fs from 'node:fs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';
const route = JSON.parse(fs.readFileSync(new URL('../../data/tracks/nyc_route.json', import.meta.url))).samples;
const run = Math.floor(Math.random() * 200) + 20;          // fresh networks every run (sign-up limits are per day)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, checks = 0;
const check = (name, ok, extra = '') => { checks++; if (!ok) fails++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); };

async function account(ip) {
  const r = await fetch(`${BASE}/v1/account`, { method: 'POST', headers: { 'x-test-ip': ip, 'content-type': 'application/json' }, body: '{}' });
  const j = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j));
  return { ...j, ip, auth: `${j.id}.${j.token}` };
}
const api = (a, method, path, body) => fetch(BASE + path, { method, headers: { authorization: `Bearer ${a.auth}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

// position along the route at arc length s, lane metres to the right (three.js coordinates: x, y up, z = -y_core)
const seg = []; let L = 0;
for (let i = 0; i < route.length; i++) { const a = route[i], b = route[(i + 1) % route.length]; const d = Math.hypot(b.x - a.x, b.y - a.y); seg.push({ a, b, d, s: L }); L += d; }
function at(s, lane) {
  s = ((s % L) + L) % L;
  const k = seg.findIndex((g) => s >= g.s && s < g.s + g.d), g = seg[Math.max(0, k)], t = (s - g.s) / g.d;
  const x = g.a.x + (g.b.x - g.a.x) * t, y = g.a.y + (g.b.y - g.a.y) * t, nx = (g.b.y - g.a.y) / g.d, ny = -(g.b.x - g.a.x) / g.d;
  return { x: x + nx * lane, y: 0.5, z: -(y + ny * lane) };
}

/** One simulated player: joins, (host) starts, drives `laps` laps at v m/s from grid offset s0 in a lane. */
function driver(acct, party, { host = false, v = 33, s0 = -10, lane = 0, laps = 1, idle = false, teleportAt = -1, startDelay = 0 }) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/v1/room/${party}?auth=${encodeURIComponent(acct.auth)}&testip=${acct.ip}`);
    let s = s0, timer = 0, raceId = '', t0 = 0;
    ws.addEventListener('open', async () => {
      ws.send(JSON.stringify({ t: 'join', car: 'vela_gt', assistsOff: 1, manual: false, host }));
      await sleep(startDelay);
      if (host) ws.send(JSON.stringify({ t: 'start', laps, route: 'nyc', realism: true }));
    });
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.t === 'race' && !timer) {
        raceId = m.id; t0 = Date.now();
        let last = Date.now(), teleported = false;
        timer = setInterval(() => {
          const now = Date.now(), dt = (now - last) / 1000; last = now;
          if (!idle) s += v * dt;
          if (teleportAt >= 0 && !teleported && now - t0 > teleportAt) { s += 400; teleported = true; }
          const p = at(s, lane);
          ws.send(JSON.stringify({ t: 'pos', ...p, v: idle ? 0 : v }));
          if (s > laps * L + 30) { clearInterval(timer); timer = -1; }
        }, 250);
      }
      if (m.t === 'result') { if (timer > 0) clearInterval(timer); ws.close(); resolve({ ...m, raceId, acct }); }
    });
    ws.addEventListener('error', (e) => resolve({ error: String(e.message ?? e), acct }));
  });
}

console.log(`online service ${BASE}, route ${L.toFixed(0)} m`);
check('service answers', (await fetch(BASE + '/').then((r) => r.json())).ok === true);

// ---- accounts on networks ----
const net = (i) => `10.${run}.${i}.7`;
const honest = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => account(net(i))));
const roommates = await Promise.all([account(net(0)), account(net(0))]);   // the first network again: 3 accounts there
const idle = await account(net(6)), cheat = await account(net(7));
const small = await Promise.all([10, 11, 12, 13, 14].map((i) => account(net(i))));
// sign-up limit: 5 per network per day
const extra = [];
for (let k = 0; k < 3; k++) extra.push(await fetch(`${BASE}/v1/account`, { method: 'POST', headers: { 'x-test-ip': net(0) }, body: '{}' }).then((r) => r.status));
check('sign-ups limited to 5 per network per day', extra.includes(429), `(statuses ${extra.join(',')})`);
check('a new account starts at 0 XP / 0 Cr with the starter car', JSON.stringify(await api(honest[0], 'GET', '/v1/me').then((r) => [r.body.xp, r.body.credits])) === '[0,0]');
check('bad tokens are refused', (await fetch(BASE + '/v1/me', { headers: { authorization: `Bearer ${honest[0].id}.wrongtokenwrongtokenwrong` } })).status === 401);

// ---- two races at once ----
console.log('racing (one real lap, ~100 s)…');
const speeds = [36, 35, 34, 33, 32, 31];
const ranked = Promise.all([
  ...honest.map((a, i) => driver(a, `R${run}A`, { host: i === 0, v: speeds[i], s0: -8 - i * 6, lane: (i % 3) * 3.5 - 3.5, startDelay: 600 })),
  ...roommates.map((a, i) => driver(a, `R${run}A`, { v: 30 - i, s0: -50 - i * 6, lane: i ? 3.5 : -3.5 })),
  driver(idle, `R${run}A`, { idle: true, s0: -70 }),
  driver(cheat, `R${run}A`, { v: 30, s0: -76, lane: 0, teleportAt: 8000 }),
]);
const unranked = Promise.all(small.map((a, i) => driver(a, `U${run}B`, { host: i === 0, v: 34 - i, s0: -8 - i * 6, lane: (i % 3) * 3.5 - 3.5, startDelay: 600 })));
const [R, U] = await Promise.all([ranked, unranked]);

const byId = (res, a) => res.find((x) => x.acct.id === a.id);
const roles = new Map([...honest.map((a, i) => [a.id, `honest${i}`]), ...roommates.map((a, i) => [a.id, `room${i}`]), [idle.id, 'idle'], [cheat.id, 'cheat']]);
if (process.env.DEBUG) for (const t of R[0].table) console.log('   ', roles.get(t.id), t.finished ? (t.timeMs / 1000).toFixed(1) : 'DNF', t.why, t.flagged ? 'FLAGGED' : '');
const r0 = R[0];
console.log('  result table:', r0.table.map((t) => `${t.pos}.${t.name.slice(-4)}${t.finished ? ` ${(t.timeMs / 1000).toFixed(1)}s` : ' DNF'}${t.flagged ? ' FLAGGED' : ''}`).join('  '));
check('ranked race: ranked', r0.ranked === true, `(counted ${r0.counted})`);
check('counted 7: 6 networks + 1 extra on the shared network (2 per network), idle and cheat not counted', r0.counted === 7);
check('finishing order follows the speeds (server-timed)', r0.table[0].id === honest[0].id && r0.table[1].id === honest[1].id);
const winner = byId(R, honest[0]).you;
check('winner paid XP and credits (new account: x0.5)', winner.xp > 0 && winner.cr > 0, `(${winner.xp} XP, ${winner.cr} Cr; ${winner.notes.join(' ')})`);
check('winner asked for a replay', winner.replay === true);
const ch = byId(R, cheat);
check('teleporter flagged, no reward', ch.you.xp === 0 && ch.table.find((t) => t.id === cheat.id).flagged === true, `(${ch.you.notes.join(' ')})`);
check('teleporter got a strike', (await api(cheat, 'GET', '/v1/me')).body.strikes === 1);
const id = byId(R, idle);
check('idle player: no reward', id.you.xp === 0 && id.you.cr === 0);
const me = (await api(honest[0], 'GET', '/v1/me')).body;
check('winner profile updated on the server', me.xp === winner.xp && me.credits === winner.cr, `(${me.xp} XP, ${me.credits} Cr)`);
check('unranked race (5 players): no rewards', U.every((x) => !x.ranked && x.you.xp === 0 && x.you.cr === 0), `(${U[0].you.notes.join(' ')})`);

// ---- shop rules on the server ----
const k = await api(honest[0], 'POST', '/v1/buy', { kind: 'car', id: 'kestrel_gt' });
check('Kestrel GT refused below online level 5', k.status === 403, `(${k.body.error})`);
const poor = await api(small[0], 'POST', '/v1/buy', { kind: 'skin', id: 'midnight' });
check('gear refused without the level / credits', poor.status === 403 || poor.status === 402, `(${poor.body.error})`);
const forged = await api(honest[0], 'POST', '/v1/buy', { kind: 'car', id: 'rocket_car' });
check('unknown items refused', forged.status === 400);

console.log(`${checks - fails}/${checks} online checks passed`);
process.exit(fails ? 1 : 0);
