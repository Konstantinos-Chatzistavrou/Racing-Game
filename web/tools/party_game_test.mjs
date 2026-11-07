// Two full game windows in one Chrome (WebGPU): A creates a party in the lobby UI, B opens the invite link and joins
// from the title banner, A starts a 1-lap race, both count down and drive; each must see the other's car and a 2-car
// running order. Screenshots of both. Heavy: the laptop runs two games at once. Usage: node tools/party_game_test.mjs [base] [outdir]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.argv[2] ?? 'http://127.0.0.1:5173';
const out = process.argv[3] ?? path.join(os.tmpdir(), 'party_game');
fs.mkdirSync(out, { recursive: true });
const port = Number(process.env.CDP_PORT ?? 9336);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-pg-'));
const chrome = spawn('google-chrome', [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--window-size=960,600',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(targetId) {
  const t = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.id === targetId);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let seq = 0; const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.method === 'Runtime.exceptionThrown') console.log('[exception]', (d.params.exceptionDetails.exception?.description ?? '').slice(0, 300));
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  };
  const send = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pending.set(id, r)); };
  await send('Runtime.enable');
  const ev = async (expr) => {
    const d = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (d.result?.exceptionDetails) throw new Error(d.result.exceptionDetails.exception?.description ?? 'eval error');
    return d.result.result.value;
  };
  const shot = async (name) => { const d = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name), Buffer.from(d.result.data, 'base64')); };
  return { ev, shot, send };
}
const waitFor = async (p, expr, ms = 120000) => { for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(500)) if (await p.ev(expr).catch(() => false)) return; throw new Error('timeout: ' + expr); };
const click = (p, q) => p.ev(`(() => { const e = document.querySelector('${q}'); if (!e) return 'MISSING ${q}'; e.click(); return 'ok'; })()`);
const st = (p) => p.ev(`JSON.stringify({ state: window.__game.state, screen: window.__game.menu().screen, remote: window.__game.remote?.count ?? null, board: [...document.querySelectorAll('#board .b')].map((e) => e.textContent), note: window.__game.menu().partyNote })`);

try {
  let browser;
  for (let i = 0; i < 40 && !browser; i++) { await sleep(250); try { browser = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl; } catch {} }
  const bws = new WebSocket(browser); await new Promise((r) => (bws.onopen = r));
  let bseq = 0; const bp = new Map(); bws.onmessage = (m) => { const d = JSON.parse(m.data); if (bp.has(d.id)) { bp.get(d.id)(d); bp.delete(d.id); } };
  const bsend = (method, params) => { const id = ++bseq; bws.send(JSON.stringify({ id, method, params })); return new Promise((r) => bp.set(id, r)); };
  const tA = (await bsend('Target.createTarget', { url: `${base}/?menu=1&fs=0&gfx=low`, newWindow: true })).result.targetId;
  const A = await connect(tA);
  await waitFor(A, `window.__game && !window.__game.menu().tuning && window.__game.state === 'title'`, 180000);
  console.log('A title', await st(A));
  await click(A, '[data-act=play]'); await sleep(300); await click(A, '[data-act=lobby]'); await sleep(300);
  await A.ev(`(() => { const i = document.getElementById('pname'); i.value = 'Alice'; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
  await click(A, '[data-act=pcreate]');
  await waitFor(A, `!!window.__game.party`, 30000);
  const code = await A.ev(`window.__game.party.code`), link = await A.ev(`window.__game.party.link`);
  console.log('A party', code, link);
  await click(A, '[data-act=plaps][data-v="1"]');
  await A.shot('a1_lobby.png');

  const tB = (await bsend('Target.createTarget', { url: `${link}&menu=1&fs=0&gfx=low`, newWindow: true })).result.targetId;
  const B = await connect(tB);
  await waitFor(B, `window.__game && !window.__game.menu().tuning && window.__game.state === 'title'`, 180000);
  await B.shot('b1_title_invite.png');
  console.log('B invite banner:', await click(B, '[data-act=invite]'));
  await waitFor(B, `window.__game.party && window.__game.party.members.length === 2`, 30000);
  await waitFor(A, `window.__game.party.members.length === 2`, 30000);
  await sleep(500); await A.shot('a2_lobby_two.png'); await B.shot('b2_lobby.png');
  console.log('A lobby', await st(A)); console.log('B lobby', await st(B));

  await click(A, '[data-act=pstart]');
  await waitFor(A, `window.__game.state === 'race' || window.__game.state === 'countdown'`, 120000);
  await waitFor(B, `window.__game.state === 'race' || window.__game.state === 'countdown'`, 120000);
  console.log('both on the grid');
  await waitFor(A, `window.__game.state === 'race'`, 20000);
  for (const p of [A, B]) await p.ev(`(window.__game.input.hold = false, 1)`);
  await sleep(4000);
  console.log('A race', await st(A)); console.log('B race', await st(B));
  await A.shot('a3_race.png'); await B.shot('b3_race.png');
  await waitFor(A, `window.__game.remote?.count === 1`, 10000);
  await waitFor(B, `window.__game.remote?.count === 1`, 10000);
  console.log('each sees the other car: ok');
  // leader ends the session from the pause menu: both back in the lobby
  await A.ev(`(window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' })), 1)`); await sleep(400);
  await click(A, '[data-act=plobby]');
  await waitFor(B, `window.__game.state === 'lobby'`, 15000);
  console.log('A after', await st(A)); console.log('B after', await st(B));
  await B.shot('b4_back_lobby.png');
  console.log('PASS');
} catch (e) {
  console.error('FAIL', e.message);
  process.exitCode = 1;
} finally {
  chrome.kill();
}
