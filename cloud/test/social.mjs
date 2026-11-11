// Usernames and friends against a local `wrangler dev` (npm run dev; .dev.vars sets ALLOW_TEST_IP=1). A few seconds.
// Usage: node test/social.mjs [http://127.0.0.1:8787]
const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';
const run = Math.floor(Math.random() * 1e6).toString(36);
let fails = 0, checks = 0;
const check = (name, ok, extra = '') => { checks++; if (!ok) fails++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); };
let ipn = 0;
async function account() {
  const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${++ipn}`;
  const r = await fetch(`${BASE}/v1/account`, { method: 'POST', headers: { 'x-test-ip': ip, 'content-type': 'application/json' }, body: '{}' });
  const j = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j));
  return { ...j, auth: `${j.id}.${j.token}` };
}
const api = (a, method, path, body) => fetch(BASE + path, { method, headers: { ...(a ? { authorization: `Bearer ${a.auth}` } : {}), 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));

const A = await account(), B = await account(), C = await account();
const ua = `Ann_${run}`.slice(0, 16), ub = `Ben.${run}`.slice(0, 16), uc = `Cat-${run}`.slice(0, 16);

console.log('usernames');
for (const [bad, why] of [['#Bot1', '#'], ['ab', 'short'], ['has space', 'space'], ['_lead', 'first char'], ['a__b', 'double'], ['admin', 'reserved'], ['Bot7', 'bot'], ['x'.repeat(17), 'long']]) {
  const r = await api(A, 'POST', '/v1/username', { username: bad });
  check(`rejects ${JSON.stringify(bad)} (${why})`, r.status === 400, r.body.error);
}
check('free before claim', (await api(null, 'GET', `/v1/username?u=${ua}`)).body.ok === true);
let r = await api(A, 'POST', '/v1/username', { username: ua });
check('A claims', r.status === 200 && r.body.username === ua && r.body.name === ua);
check('taken after claim (other capitals)', (await api(null, 'GET', `/v1/username?u=${ua.toUpperCase()}`)).body.ok === false);
r = await api(B, 'POST', '/v1/username', { username: ua.toLowerCase() });
check('B cannot take it in other capitals', r.status === 409, r.body.error);
check('B claims its own', (await api(B, 'POST', '/v1/username', { username: ub })).status === 200);
check('C claims its own', (await api(C, 'POST', '/v1/username', { username: uc })).status === 200);
r = await api(A, 'POST', '/v1/username', { username: ua.toUpperCase() });
check('A may change only the capitals', r.status === 200 && r.body.username === ua.toUpperCase());
r = await api(A, 'POST', '/v1/username', { username: `Zed_${run}`.slice(0, 16) });
check('A cannot rename within 30 days', r.status === 429, r.body.error);
check('/v1/me has the username', (await api(A, 'GET', '/v1/me')).body.username === ua.toUpperCase());

console.log('friends');
r = await api(A, 'POST', '/v1/friends', { username: ub, action: 'add' });
check('A asks B', r.body.state === 'pending');
let fa = (await api(A, 'GET', '/v1/friends')).body, fb = (await api(B, 'GET', '/v1/friends')).body;
check('A sees outgoing', fa.outgoing.includes(ub) && !fa.friends.length);
check('B sees incoming', fb.incoming.includes(ua.toUpperCase()));
r = await api(B, 'POST', '/v1/friends', { username: ua, action: 'accept' });
check('B accepts', r.body.state === 'friends');
await api(B, 'POST', '/v1/presence', { party: 'abcde' });
fa = (await api(A, 'GET', '/v1/friends')).body;
const fbEntry = fa.friends.find((f) => f.username === ub);
check('A has B as a friend, online, in party ABCDE', !!fbEntry && fbEntry.online && fbEntry.party === 'ABCDE', JSON.stringify(fbEntry));
check('B was last seen just now', typeof fbEntry?.seenAgo === 'number' && fbEntry.seenAgo >= 0 && fbEntry.seenAgo < 10_000, String(fbEntry?.seenAgo));
const abEntry = (await api(B, 'GET', '/v1/friends')).body.friends.find((f) => f.username.toLowerCase() === ua.toLowerCase());
check('A never sent a heartbeat: offline, never seen', !!abEntry && !abEntry.online && abEntry.seenAgo === null, JSON.stringify(abEntry));
r = await api(C, 'POST', '/v1/friends', { username: ua, action: 'add' });
r = await api(A, 'POST', '/v1/friends', { username: uc, action: 'add' });
check('mutual add = friends', r.body.state === 'friends');
r = await api(A, 'POST', '/v1/friends', { username: 'nobody_' + run, action: 'add' });
check('unknown username', r.status === 404);
r = await api(A, 'POST', '/v1/friends', { username: ua, action: 'add' });
check('cannot add yourself', r.status === 400);
r = await api(B, 'POST', '/v1/friends', { username: ua, action: 'remove' });
fa = (await api(A, 'GET', '/v1/friends')).body;
check('remove ends it both ways', !fa.friends.some((f) => f.username === ub) && fa.friends.some((f) => f.username === uc));

console.log(fails ? `FAILED ${fails} / ${checks}` : `OK ${checks} checks`);
process.exit(fails ? 1 : 0);
