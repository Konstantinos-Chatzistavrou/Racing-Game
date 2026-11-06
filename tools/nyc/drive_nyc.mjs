// NYC streaming test: drives the car down the avenue from the spawn at full throttle with a bang-bang steering controller that holds the
// spawn line, records frame intervals, streamer stats, draw calls/triangles (per rendered frame, summed over the passes of the frame), GPU
// memory counters and pipelines, and prints a summary. Needs the dev server (cd web && npx vite --port 5208) and tiles
// (python3 tools/nyc/stub_tiles.py --box -3 -14 4 6 for a 3.5 km run). Run from web/:
//   CDP_PORT=9408 node ../tools/nyc/drive_nyc.mjs "http://127.0.0.1:5208/?city=nyc&nycdebug=1" /tmp/out [seconds=60]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url0 = process.argv[2] ?? 'http://127.0.0.1:5208/?city=nyc';
const url = /[?&]menu=/.test(url0) ? url0 : url0 + (url0.includes('?') ? '&' : '?') + 'menu=0';
const out = process.argv[3] ?? path.join(os.tmpdir(), 'nyc_drive');
const seconds = Number(process.argv[4] ?? 60);
fs.mkdirSync(out, { recursive: true });
const port = Number(process.env.CDP_PORT ?? 9408);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-webgpu-'));
const chrome = spawn('google-chrome', [
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--enable-unsafe-webgpu', '--enable-features=Vulkan',
  `--window-size=${process.env.WIN ?? '1280,800'}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
  ...(process.env.HEADLESS ? ['--headless=new', '--use-angle=vulkan', '--ignore-gpu-blocklist'] : []), 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, seq = 0;
const pending = new Map();
const send = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => pending.set(id, { res, rej })); };
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval error');
  return r.result.value;
};
const key = (type, code, k) => send('Input.dispatchKeyEvent', { type, code, key: k, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) });
const shot = async (name) => fs.writeFileSync(path.join(out, name), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
const seen = new Set();

try {
  let target;
  for (let i = 0; i < 40 && !target; i++) { await sleep(250); try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch {} }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.method === 'Runtime.consoleAPICalled' && /error|warning|info/.test(d.params.type)) {
      const msg = d.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300);
      if (/nyc|error|warn/i.test(msg) && !seen.has(msg)) { seen.add(msg); console.log(`[page ${d.params.type}]`, msg); }
    }
    if (d.method === 'Runtime.exceptionThrown') console.log('[page exception]', (d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text).slice(0, 600));
    if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result); }
  };
  await send('Page.enable'); await send('Page.bringToFront'); await send('Runtime.enable');
  await send('Page.navigate', { url });
  for (let i = 0; i < 240; i++) {
    await sleep(500);
    const s = await evaluate(`(() => { const l = document.getElementById('loading'); return l ? l.textContent : 'ready'; })()`).catch(() => '');
    if (s === 'ready') break;
    if (/WebGPU is not available|Error/.test(s)) { console.log('PAGE:', s.trim()); throw new Error('not started'); }
  }
  await sleep(3000);
  // in-page recorder: frame intervals, per-frame draw/tri sums, 1 Hz samples
  await evaluate(`(() => {
    const g = window.__game, info = g.renderer.info; info.autoReset = false; info.reset();
    const R = window.__rec = { ft: [], draws: [], tris: [], samples: [], spikes: [], t0: performance.now(), crashes: 0, place: null };
    let lastLoaded = 0;
    let p = performance.now(), last = p;
    const f = (t) => {
      R.ft.push(t - p);
      if (t - p > 40 && R.ft.length > 20) { const s = g.nyc.stats(); R.spikes.push({ t: +((t - R.t0) / 1000).toFixed(2), ms: +(t - p).toFixed(1), loadedNow: s.tilesLoaded - lastLoaded, q: s.queued, loading: s.loading, streamMax: +s.streamMax.toFixed(1) }); }
      lastLoaded = g.nyc.stats().tilesLoaded; p = t;
      if (R.place) { const P = R.place, el = (t - P.t) / 1000, c = g.car.body.translation(); g.car.place({ x: P.x + P.dx * P.v * el, y: c.y, z: P.z + P.dz * P.v * el }, P.yaw, P.v); }
      const d = info.render.drawCalls ?? info.render.calls, tr = info.render.triangles;
      if (d > 0) { R.draws.push(d); R.tris.push(tr); }
      info.reset();
      if (t - last >= 1000) {
        last = t;
        const s = g.nyc.stats(), c = g.car.body.translation();
        R.samples.push({ t: Math.round((t - R.t0) / 1000), near: s.near, far: s.far, col: s.col, colliders: s.colliders, geoms: s.geometries, tex: s.textures, pipes: s.pipelines,
          streamMs: +s.streamMs.toFixed(3), streamMax: +s.streamMax.toFixed(2), loaded: s.tilesLoaded, loadMs: Math.round(s.loadMsAvg), q: s.queued, loading: s.loading,
          kmh: Math.round(g.car.out[102] * 3.6), x: +c.x.toFixed(0), z: +c.z.toFixed(0), heapMB: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1e6) });
        g.nyc.resetMax();
      }
      requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
    R.pipes0 = g.pipelines().atStart;
    return 1; })()`);
  console.log('start', JSON.stringify(await evaluate(`window.__game.nyc.stats()`)));
  await shot('d0_start.png');
  const h0 = await evaluate(`window.__game.nyc.spawnPoint().heading`);
  const p0 = await evaluate(`(() => { const c = window.__game.car.body.translation(); return [c.x, -c.z]; })()`);
  await evaluate(`(window.__game.input.hold = false, 1)`);
  if (process.env.PLACE) {   // PLACE=<m/s>: the car is placed along the spawn line at that speed (streaming test through buildings; colliders still stream)
    await evaluate(`(() => { const g = window.__game, c = g.car.body.translation(), h = ${h0}, v = ${Number(process.env.PLACE)};
      window.__rec.place = { t: performance.now(), x: c.x, z: c.z, dx: Math.cos(h), dz: -Math.sin(h), v, yaw: Math.atan2(Math.cos(h), -Math.sin(h)) }; return 1; })()`);
  }
  await key('keyDown', 'KeyW', 'w');
  const t0 = Date.now();
  let steer = '', shots = 0, lowAfterFast = 0, maxKmh = 0;
  const dx = Math.cos(h0), dy = Math.sin(h0);
  while (Date.now() - t0 < seconds * 1000) {
    const s = await evaluate(`(() => { const c = window.__game.car, t = c.body.translation(), r = c.body.rotation();
      return [t.x, -t.z, Math.atan2(2 * (r.w * r.y + r.x * r.z), 1 - 2 * (r.y * r.y + r.x * r.x)), c.out[102] * 3.6]; })()`);
    const [x, y, phi, kmh] = s;
    maxKmh = Math.max(maxKmh, kmh);
    if (maxKmh > 100 && kmh < 40) lowAfterFast++;
    const e = dx * (y - p0[1]) - dy * (x - p0[0]);               // left of the line > 0
    const hDes = h0 - Math.max(-0.12, Math.min(0.12, 0.012 * e));
    const h = Math.atan2(-Math.cos(phi), Math.sin(phi));
    let err = hDes - h; while (err > Math.PI) err -= 2 * Math.PI; while (err < -Math.PI) err += 2 * Math.PI;
    const want = err > 0.025 ? 'KeyA' : err < -0.025 ? 'KeyD' : '';
    if (want !== steer) { if (steer) await key('keyUp', steer, steer === 'KeyA' ? 'a' : 'd'); if (want) await key('keyDown', want, want === 'KeyA' ? 'a' : 'd'); steer = want; }
    if ((Date.now() - t0) / 1000 > (shots + 1) * 15 && shots < 3) { shots++; await shot(`d${shots}_drive.png`); }
    await sleep(60);
  }
  await key('keyUp', 'KeyW', 'w');
  if (steer) await key('keyUp', steer, steer === 'KeyA' ? 'a' : 'd');
  await sleep(300);
  await shot('d9_end.png');
  const R = await evaluate(`JSON.stringify({ ft: window.__rec.ft.slice(10), draws: window.__rec.draws, tris: window.__rec.tris, samples: window.__rec.samples, spikes: window.__rec.spikes, pipes0: window.__rec.pipes0, pipesNow: window.__game.pipelines().now, last: window.__game.nyc.stats() })`).then(JSON.parse);
  fs.writeFileSync(path.join(out, 'rec.json'), JSON.stringify(R));
  const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  console.log(`frames ${R.ft.length}  median ${q(R.ft, 0.5).toFixed(1)}  p95 ${q(R.ft, 0.95).toFixed(1)}  p99 ${q(R.ft, 0.99).toFixed(1)}  max ${Math.max(...R.ft).toFixed(1)}  >60ms: ${R.ft.filter((x) => x > 60).length}  >50ms: ${R.ft.filter((x) => x > 50).length}`);
  console.log(`draw calls/frame (all passes, rendered frames): median ${q(R.draws, 0.5)}  p95 ${q(R.draws, 0.95)}  max ${Math.max(...R.draws)} | triangles k: median ${(q(R.tris, 0.5) / 1000).toFixed(0)}  p95 ${(q(R.tris, 0.95) / 1000).toFixed(0)}  max ${(Math.max(...R.tris) / 1000).toFixed(0)}`);
  console.log(`pipelines at start ${R.pipes0}, now ${R.pipesNow}   max km/h ${Math.round(maxKmh)}   crash-like slowdowns ${lowAfterFast}`);
  console.log('spikes >40 ms', JSON.stringify(R.spikes));
  const S = R.samples;
  console.log('t   km/h  x      z       near far col coll  geoms tex pipes  stream(ms) max  loaded loadMs q  heapMB');
  for (const s of S.filter((_, i) => i % 5 === 0 || i === S.length - 1)) console.log(`${String(s.t).padStart(3)} ${String(s.kmh).padStart(5)} ${String(s.x).padStart(6)} ${String(s.z).padStart(7)}  ${String(s.near).padStart(3)} ${String(s.far).padStart(3)} ${String(s.col).padStart(3)} ${String(s.colliders).padStart(4)}  ${String(s.geoms).padStart(5)} ${String(s.tex).padStart(3)} ${String(s.pipes).padStart(4)}  ${String(s.streamMs).padStart(8)} ${String(s.streamMax).padStart(5)}  ${String(s.loaded).padStart(5)} ${String(s.loadMs).padStart(5)} ${String(s.q).padStart(3)} ${String(s.heapMB).padStart(5)}`);
} finally {
  ws?.close(); chrome.kill(); await sleep(500); fs.rmSync(profile, { recursive: true, force: true });
}
