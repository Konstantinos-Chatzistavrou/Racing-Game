// Relay smoke test: starts server.js on a spare port, connects two clients and checks
// welcome / state relay / validation / rate limit / leave. Run: npm test
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const PORT = 18000 + Math.floor(Math.random() * 1000);
const url = `ws://127.0.0.1:${PORT}`;
const srv = spawn(process.execPath, [fileURLToPath(new URL('./server.js', import.meta.url))], {
  env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((res, rej) => {
  srv.stdout.on('data', (d) => d.toString().includes('listening') && res());
  srv.on('exit', (c) => rej(new Error(`server exited ${c}`)));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Client with an inbox; next(type) waits for the next message of that type. */
function client() {
  const ws = new WebSocket(url), inbox = [];
  ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
  const next = async (type, ms = 1000) => {
    for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(5)) {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) return inbox.splice(i, 1)[0];
    }
    throw new Error(`timeout waiting for ${type}`);
  };
  return { ws, inbox, next, open: new Promise((r) => ws.on('open', r)) };
}
const pose = (x) => ({ type: 'state', x, y: 1, z: -2, qx: 0, qy: 0, qz: 0, qw: 1 });
let ok = 0;
const check = async (name, fn) => { await fn(); console.log(`  ok  ${name}`); ok++; };

try {
  const a = client();
  await a.open;
  const wa = await a.next('welcome');
  await check('A welcome with id, no players', () => { assert.equal(typeof wa.id, 'number'); assert.deepEqual(wa.players, []); });
  a.ws.send(JSON.stringify(pose(5)));
  await sleep(50);

  const b = client();
  await b.open;
  const wb = await b.next('welcome');
  await check('B welcome lists A with last pose', () => {
    assert.notEqual(wb.id, wa.id);
    assert.equal(wb.players.length, 1);
    assert.equal(wb.players[0].id, wa.id);
    assert.equal(wb.players[0].x, 5);
  });
  await check('A told about B joining', async () => assert.equal((await a.next('join')).id, wb.id));

  a.ws.send(JSON.stringify(pose(7)));
  const sb = await b.next('state');
  await check('A state relayed to B', () => assert.deepEqual(sb, { type: 'state', id: wa.id, x: 7, y: 1, z: -2, qx: 0, qy: 0, qz: 0, qw: 1 }));
  await sleep(50);
  await check('A gets no echo of its own state', () => assert.equal(a.inbox.filter((m) => m.type === 'state').length, 0));

  for (const bad of ['not json', '{"type":"state","x":"1"}', JSON.stringify({ ...pose(1), y: null }),
    JSON.stringify({ ...pose(1), x: 1e9 }), JSON.stringify({ ...pose(1), qw: 0 }), JSON.stringify({ type: 'other' })]) a.ws.send(bad);
  await sleep(100);
  await check('invalid messages dropped', () => assert.equal(b.inbox.filter((m) => m.type === 'state').length, 0));

  a.ws.send(JSON.stringify({ ...pose(1), pad: 'x'.repeat(2000) }));   // over maxPayload: server closes A
  await new Promise((r) => a.ws.once('close', r));
  const lv = await b.next('leave');
  await check('oversized message closes sender, B gets leave', () => assert.equal(lv.id, wa.id));

  const c = client();
  await c.open;
  const wc = await c.next('welcome');
  b.inbox.length = 0;
  for (let i = 0; i < 200; i++) c.ws.send(JSON.stringify(pose(i)));
  await sleep(300);
  const relayed = b.inbox.filter((m) => m.type === 'state' && m.id === wc.id).length;
  await check(`rate limit: 200 burst -> ${relayed} relayed`, () => assert.ok(relayed >= 40 && relayed <= 60));

  c.ws.close();
  await check('C leave broadcast', async () => assert.equal((await b.next('leave')).id, wc.id));
  await sleep(100);
  const health = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json());
  await check('health route', () => { assert.equal(health.ok, true); assert.equal(health.players, 1); });
  b.ws.close();
  console.log(`PASS ${ok} checks`);
} catch (e) {
  console.error('FAIL', e);
  process.exitCode = 1;
} finally {
  srv.kill();
}
