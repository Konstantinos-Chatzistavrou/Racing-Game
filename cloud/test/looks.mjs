// Account car looks against a local `wrangler dev` (npm run dev; .dev.vars sets ALLOW_TEST_IP=1). A few seconds.
// Usage: node test/looks.mjs [http://127.0.0.1:8787]
const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';
let fails = 0, checks = 0;
const check = (name, ok, extra = '') => { checks++; if (!ok) fails++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); };
async function account() {
  const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const r = await fetch(`${BASE}/v1/account`, { method: 'POST', headers: { 'x-test-ip': ip, 'content-type': 'application/json' }, body: '{}' });
  const j = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j));
  return { ...j, auth: `${j.id}.${j.token}` };
}
const api = (a, method, path, body) => fetch(BASE + path, { method, headers: { ...(a ? { authorization: `Bearer ${a.auth}` } : {}), 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));

const A = await account(), B = await account();
console.log('looks');
check('a new account has none', JSON.stringify((await api(A, 'GET', '/v1/me')).body.looks) === '{}');
const look = { livery: 1, liveryColor: '#1d4ed8', wing: 'gt', aero: 'gloss', rimColor: '#15171c', rimFinish: 'satin', caliper: '#e8890a', headlights: 'ice', smokedTails: true, underglow: '#ff2d55', tint: 2, exhaust: 'titanium' };
let r = await api(A, 'POST', '/v1/look', { car: 'vela_gt', look });
check('saves a look', r.status === 200 && r.body.looks.vela_gt.wing === 'gt' && r.body.looks.vela_gt.underglow === '#ff2d55', JSON.stringify(r.body.error ?? ''));
r = await api(A, 'GET', '/v1/me');
check('it persists', r.body.looks.vela_gt.livery === 1 && r.body.looks.vela_gt.smokedTails === true);
check('the other account sees nothing', JSON.stringify((await api(B, 'GET', '/v1/me')).body.looks) === '{}');
r = await api(A, 'POST', '/v1/look', { car: 'kestrel_gt', look: { wing: 'spaceship', livery: 99, tint: 'x', liveryColor: 'red' } });
check('junk becomes defaults', r.status === 200 && r.body.looks.kestrel_gt.wing === 'stock' && r.body.looks.kestrel_gt.livery === 0 && r.body.looks.kestrel_gt.tint === 1 && r.body.looks.kestrel_gt.liveryColor === '#f4f4f6', JSON.stringify(r.body.looks?.kestrel_gt));
check('the first car is untouched', (await api(A, 'GET', '/v1/me')).body.looks.vela_gt.wing === 'gt');
r = await api(A, 'POST', '/v1/look', { car: 'no_such_car', look: {} });
check('unknown car refused', r.status === 400, r.body.error);
r = await api(A, 'POST', '/v1/look', { car: 'vela_gt' });
check('a missing look saves defaults', r.status === 200 && r.body.looks.vela_gt.wing === 'stock');
r = await fetch(`${BASE}/v1/look`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
check('no account refused', r.status === 401 || r.status === 400, String(r.status));

console.log(fails ? `\n${fails}/${checks} FAILED` : `\nall ${checks} checks passed`);
process.exit(fails ? 1 : 0);
