// City render benchmark: same spots every run, so before/after numbers and screenshots compare.
// Launches the system Chrome with WebGPU (same flags as drive.mjs), parks the player car on fixed
// route samples (start + 4 more along the loop), lets the camera settle, then per spot records
// 120 frames of: frame time (median/p95), draw calls and triangles PER FRAME (renderer.info with
// autoReset off, reset on each rAF, so post passes are summed into one frame), and saves a screenshot.
// Also prints GPU memory as three counts it (info.memory: textures/attributes/total bytes) and the
// bytes downloaded (Resource Timing; vite dev = uncompressed transfer).
// Usage: node tools/city_bench.mjs [url] [outdir] [tag]   e.g. url = http://127.0.0.1:5192/?scale=0.7&ai=0
// (CDP_PORT=9392 to change the DevTools port). fps is only comparable on an idle machine.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:5173/?scale=0.7';
const out = process.argv[3] ?? path.join(os.tmpdir(), 'city_bench');
const tag = process.argv[4] ?? 'run';
fs.mkdirSync(out, { recursive: true });
const port = Number(process.env.CDP_PORT ?? 9392);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-webgpu-'));
const chrome = spawn('google-chrome', [
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--enable-unsafe-webgpu', '--enable-features=Vulkan', `--window-size=${process.env.WIN ?? '1280,800'}`,
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, seq = 0;
const pending = new Map();
const seen = new Set();
const send = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => pending.set(id, { res, rej })); };
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval error');
  return r.result.value;
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(out, name), Buffer.from(r.data, 'base64'));
}

// Fractions of the route where the car is parked (0 = start line, the drive.mjs "straight" view).
const SPOTS = [0, 0.18, 0.37, 0.58, 0.81];

try {
  let target;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(250);
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch {}
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.method === 'Runtime.consoleAPICalled' && /error|warning/.test(d.params.type)) {
      const msg = d.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 400);
      if (!seen.has(msg)) { seen.add(msg); console.log(`[page ${d.params.type}]`, msg); }
    }
    if (d.method === 'Runtime.exceptionThrown') console.log('[page exception]', (d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text).slice(0, 600));
    if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result); }
  };
  await send('Page.enable');
  await send('Page.bringToFront');
  await send('Runtime.enable');
  const t0 = Date.now();
  await send('Page.navigate', { url });
  for (let i = 0; i < 360; i++) {
    await sleep(500);
    const s = await evaluate(`(() => { const l = document.getElementById('loading'); return l ? l.textContent : 'ready'; })()`).catch(() => '');
    if (s === 'ready') break;
    if (/WebGPU is not available|Error/.test(s)) { console.log('PAGE:', s.trim()); throw new Error('not started'); }
  }
  console.log(`[${tag}] ready after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await sleep(4000);
  console.log(`[${tag}] load`, await evaluate(`(() => { const r = performance.getEntriesByType('resource'); let all = 0, city = 0;
    for (const e of r) { const b = e.transferSize || e.encodedBodySize || 0; all += b; if (/city|props|basis/.test(e.name)) city += b; }
    return 'downloaded ' + (all / 1048576).toFixed(1) + ' MB, city files ' + (city / 1048576).toFixed(1) + ' MB'; })()`));
  for (const [k, f] of SPOTS.entries()) {
    await evaluate(`fetch('/data/tracks/city_route.json').then((r) => r.json()).then((route) => {
      const g = window.__game, S = route.samples, s = S[Math.floor(${f} * S.length) % S.length];
      g.input.hold = false;
      g.car.place({ x: s.x, y: s.z + g.core.info.cgHeight + 0.35, z: -s.y }, Math.atan2(Math.cos(s.heading), -Math.sin(s.heading)), 0);
      return 1; })`);
    await sleep(2500);
    const r = await evaluate(`new Promise((res) => { const info = window.__game.renderer.info; info.autoReset = false; info.reset();
      const ft = [], dc = [], tr = []; let p = performance.now();
      const f = (t) => { ft.push(t - p); p = t; dc.push(info.render.drawCalls); tr.push(info.render.triangles); info.reset();
        if (ft.length < 120) requestAnimationFrame(f); else { info.autoReset = true; res({ ft, dc, tr, mem: { ...info.memory } }); } };
      requestAnimationFrame(f); })`);
    const med = (a) => { const b = a.slice(5).sort((x, y) => x - y); return b[b.length >> 1]; };
    const p95 = (a) => { const b = a.slice(5).sort((x, y) => x - y); return b[Math.floor(b.length * 0.95)]; };
    const m = r.mem, MB = (x) => (x / 1048576).toFixed(0);
    console.log(`[${tag}] spot ${k} (route ${f}): ${med(r.ft).toFixed(1)} ms median (${(1000 / med(r.ft)).toFixed(0)} fps), p95 ${p95(r.ft).toFixed(1)} | draw calls ${med(r.dc)} | triangles ${(med(r.tr) / 1000).toFixed(0)}k`
      + ` | GPU mem ${MB(m.total)} MB (textures ${MB(m.texturesSize)}, vertex ${MB(m.attributesSize)}, index ${MB(m.indexAttributesSize)}, ${m.textures} tex, ${m.geometries} geo)`);
    await shot(`${tag}_spot${k}.png`);
  }
  console.log('screenshots in', out);
} finally {
  ws?.close();
  chrome.kill();
  await sleep(500);
  fs.rmSync(profile, { recursive: true, force: true });
}
