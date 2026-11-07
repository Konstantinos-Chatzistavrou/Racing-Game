// Multiplayer party check over the real PeerJS broker + WebRTC: two pages in one Chrome (tools/party/harness.html,
// Vite dev server running). Leader creates, member joins by code, mode change, start -> both loaded -> GO,
// pose + progress relay both ways, a third join refused mid-session, back to lobby, member leaves, leader closes.
// Usage: node tools/party_test.mjs [http://127.0.0.1:5173]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const base = process.argv[2] ?? 'http://127.0.0.1:5173';
const port = Number(process.env.CDP_PORT ?? 9335);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-party-'));
const chrome = spawn('google-chrome', [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--headless=new', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function page() {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${base}/tools/party/harness.html${process.env.PEER ? "?peer=" + process.env.PEER : ""}`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let seq = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const ev = async (expr) => {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
    const d = await new Promise((r) => pending.set(id, r));
    if (d.result?.exceptionDetails) throw new Error(d.result.exceptionDetails.exception?.description ?? 'eval error');
    return d.result.result.value;
  };
  for (let i = 0; i < 60 && !(await ev('!!window.ready').catch(() => false)); i++) await sleep(250);
  return ev;
}
const waitFor = async (ev, expr, ms = 15000) => { for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(200)) if (await ev(expr)) return true; throw new Error('timeout: ' + expr); };
let ok = 0;
const check = (name, cond) => { assert.ok(cond, name); console.log('  ok  ' + name); ok++; };

try {
  for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(250); } }
  const A = await page(), B = await page(), C = await page();
  const code = await A(`P.create({ name: 'Alice', car: 'vela_gt', paint: 0xff0000 }).then((p) => { window.p = p; hooks(p, 'A'); return p.code; })`);
  check(`leader created party ${code}`, /^[A-Z2-9]{5}$/.test(code));
  await B(`P.join('${code.toLowerCase()}', { name: 'Bob<b>', car: 'harrier_gt', paint: 0x00ff00 }).then((p) => { window.p = p; hooks(p, 'B'); return 1; })`);
  await waitFor(A, 'p.members.length === 2');
  check('member joined by code (lower case ok), leader sees 2', true);
  check('member sees the lobby with names (markup stripped)', JSON.stringify(await B('p.members.map((m) => m.name)')) === '["Alice","Bobb"]');
  check('bad code is refused', /no party/i.test(await C(`P.join('ZZZZZ', { name: 'C', car: 'x', paint: 0 }).then(() => 'joined', (e) => e.message)`)));
  await A(`(p.setMode('race', 5), 1)`);
  await waitFor(B, `p.mode === 'race' && p.laps === 5`);
  check('mode + laps reach the member', true);
  await A(`(p.start(), setTimeout(() => p.ready(), 500), 1)`);
  await waitFor(B, `log.some((l) => l[1] === 'go')`);
  await waitFor(A, `log.some((l) => l[1] === 'go')`);
  check('start -> both loaded -> GO on both', true);
  check('third player refused mid-session', /mid-race/i.test(await C(`P.join('${code}', { name: 'C', car: 'x', paint: 0 }).then(() => 'joined', (e) => e.message)`)));
  await B(`(p.sendPose({ x: 12.5, y: 0, z: 1, qx: 0, qy: 0, qz: 0, qw: 1 }, 255), p.sendProgress({ d: 800, lap: 0, fin: -1, best: 0 }), 1)`);
  await A(`(p.sendPose({ x: -3, y: 0, z: 1, qx: 0, qy: 0, qz: 0, qw: 1 }, 7), p.sendProgress({ d: 950, lap: 1, fin: 61.2, best: 61.2 }), 1)`);
  await waitFor(A, `log.some((l) => l[1] === 'pose' && l[2] === 12.5 && l[3] === 255) && log.some((l) => l[1] === 'prog' && l[2] === 800)`);
  await waitFor(B, `log.some((l) => l[1] === 'pose' && l[2] === -3) && log.some((l) => l[1] === 'prog' && l[3] === 61.2)`);
  check('pose + progress relayed both ways', true);
  await A(`(p.backToLobby(), 1)`);
  await waitFor(B, `log.some((l) => l[1] === 'lobby') && p.phase === 'lobby'`);
  check('leader sends everyone back to the lobby', true);
  await B(`(p.leave(), 1)`);
  await waitFor(A, `p.members.length === 1 && log.some((l) => l[1] === 'left')`);
  check('member leaves, leader sees it', true);
  await C(`P.join('${code}', { name: 'Cleo', car: 'vela_gt', paint: 1 }).then((p) => { window.p = p; hooks(p, 'C'); return 1; })`);
  await waitFor(A, 'p.members.length === 2');
  await A(`(p.leave(), 1)`);
  await waitFor(C, `log.some((l) => l[1] === 'closed')`);
  check('late joiner gets in; leader closing ends the party for them: ' + (await C(`log.find((l) => l[1] === 'closed')[2]`)), true);
  console.log(`${ok} checks passed`);
} catch (e) {
  console.error('FAIL', e.message);
  process.exitCode = 1;
} finally {
  chrome.kill();
}
