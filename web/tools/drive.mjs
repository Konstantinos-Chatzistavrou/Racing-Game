// Drives the game in the system Chrome with WebGPU enabled (Linux needs the flags) through the
// DevTools protocol: load, idle, full throttle, brake. Prints telemetry + fps, saves screenshots.
// Usage: node tools/drive.mjs [url] [outdir] [straight|crash|mobile|bench|profile|night|menu|online]   (CDP_PORT=9334 to change the DevTools port)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ?menu=0: straight into a free run (the title and garage are for people). ?menu=1 in the URL keeps them.
const url0 = process.argv[2] ?? 'http://127.0.0.1:5173/';
const url = /[?&]menu=/.test(url0) ? url0 : url0 + (url0.includes('?') ? '&' : '?') + 'menu=0';
const out = process.argv[3] ?? path.join(os.tmpdir(), 'drive');
const scenario = process.argv[4] ?? 'straight';
fs.mkdirSync(out, { recursive: true });
const port = Number(process.env.CDP_PORT ?? 9334);   // CDP_PORT: several tests side by side
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-webgpu-'));
const chrome = spawn('google-chrome', [
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--enable-unsafe-webgpu', '--enable-features=Vulkan', `--window-size=${process.env.WIN ?? '1280,800'}`,
  // other windows (e.g. a full-screen Chrome) must not throttle the test window's frame rate
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
  // HEADLESS=1: no window at all (a hidden/occluded test window stops requestAnimationFrame)
  ...(process.env.HEADLESS ? ['--headless=new', '--use-angle=vulkan', '--ignore-gpu-blocklist'] : []),
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, seq = 0;
const pending = new Map();
const seen = new Set();
function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval error');
  return r.result.value;
}
async function key(type, code, keyName) {
  await send('Input.dispatchKeyEvent', { type, code, key: keyName, windowsVirtualKeyCode: keyName.toUpperCase().charCodeAt(0) });
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(out, name), Buffer.from(r.data, 'base64'));
}

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
  await send('Page.navigate', { url });
  for (let i = 0; i < 240; i++) {
    await sleep(500);
    const s = await evaluate(`(() => { const l = document.getElementById('loading'); return l ? l.textContent : 'ready'; })()`).catch(() => '');
    if (s === 'ready') break;
    if (/WebGPU is not available|Error/.test(s)) { console.log('PAGE:', s.trim()); throw new Error('not started'); }
  }
  const info = `(() => { const g = window.__game, c = g.car, r = c.body.rotation(), t = c.body.translation(), o = c.out;
    return { kmh: Math.round(o[102] * 3.6), gear: o[104] - 1, yaw: +(Math.atan2(2*(r.w*r.y + r.x*r.z), 1 - 2*(r.y*r.y + r.x*r.x)) * 57.3).toFixed(2),
      x: +t.x.toFixed(1), z: +t.z.toFixed(2), perf: document.getElementById('perf').textContent.replace('\\n', ' | ') }; })()`;
  if (scenario === 'mobile') {
    // phone in landscape: 915x412 CSS px, DPR 2.6, touch input
    await send('Emulation.setDeviceMetricsOverride', { width: 915, height: 412, deviceScaleFactor: 2.6, mobile: true, screenOrientation: { type: 'landscapePrimary', angle: 90 } });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await send('Page.reload');
    for (let i = 0; i < 240; i++) {
      await sleep(500);
      if ((await evaluate(`document.getElementById('loading') ? 'no' : 'ready'`).catch(() => '')) === 'ready') break;
    }
  }
  await sleep(Number(process.env.SETTLE ?? 4000));
  console.log('idle  ', JSON.stringify(await evaluate(info)));
  if (process.env.PROBE) console.log('probe', await evaluate(fs.readFileSync(process.env.PROBE, 'utf8')));
  if (process.env.PROBE) await shot('probe.png');
  if (scenario === 'bench') {
    await sleep(2000);
    const r = await evaluate(`new Promise((res) => { const ft = []; let p = performance.now(); const f = (t) => { ft.push(t - p); p = t; if (ft.length < 240) requestAnimationFrame(f); else res(ft); }; requestAnimationFrame(f); })`);
    const a = r.slice(5).sort((x, y) => x - y), q = (p) => a[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(1);
    console.log(`bench median ${q(0.5)} ms  p95 ${q(0.95)}  p99 ${q(0.99)}  max ${a[a.length - 1].toFixed(1)}  >40ms: ${a.filter((x) => x > 40).length}/${a.length}  | ${(await evaluate(info)).perf}`);
  }
  if (scenario === 'menu') {
    // Front end walk-through (run with ?menu=1): title (graphics tuning), garage (car, paint, tuning, mode), race start, pause, back.
    const click = (q) => evaluate(`(() => { const e = document.querySelector('${q}'); if (!e) return 'MISSING ${q}'; e.click(); return 'ok'; })()`);
    const st = () => evaluate(`JSON.stringify({ state: window.__game.state, tuning: window.__game.menu().tuning, screen: window.__game.menu().screen, kmh: Math.round(window.__game.car.out[102] * 3.6) })`);
    for (let i = 0; i < 90 && (await evaluate(`window.__game.menu().tuning`)); i++) await sleep(500);
    console.log('title ', await st(), await evaluate(`document.querySelector('.note')?.textContent`));
    await shot('m1_title.png');
    await click('[data-act=start]'); await sleep(2500); await shot('m2_garage.png');
    await click(`[data-act=car][data-v=${process.env.MENU_CAR ?? 'vela_gtr'}]`); await sleep(500);
    await click('[data-act=paint][data-v="#1d4ed8"]'); await click('[data-act=finish][data-v=metallic]');
    if (!process.env.NOMODS) { await click('[data-act=mod][data-k=engine][data-v="2"]'); await click('[data-act=mod][data-k=tyres][data-v="1"]'); }
    await sleep(2500); await shot('m3_garage_gtr.png');
    await click('[data-act=mode][data-v=race]'); await click('[data-act=laps][data-v="1"]'); await sleep(800); await shot('m4_garage_race.png');
    await click('[data-act=go]'); await sleep(1500); console.log('count ', await st()); await shot('m5_countdown.png');
    await sleep(3500); console.log('race  ', await st());
    await evaluate(`(window.__game.input.hold = false, 1)`);
    await sleep(2500); await shot('m6_race.png');
    await evaluate(`(window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' })), 1)`); await sleep(600);
    if (process.env.DBG) console.log('dbg race ', await evaluate(fs.readFileSync(process.env.DBG, 'utf8')));
    console.log('pause ', await st()); await shot('m7_pause.png');
    await click('[data-act=garage]'); await sleep(1500); console.log('back  ', await st()); await shot('m8_garage_again.png');
    if (process.env.DBG) console.log('dbg back ', await evaluate(fs.readFileSync(process.env.DBG, 'utf8')));
    await click('[data-act=mode][data-v=online]'); await sleep(500); await shot('m9_online.png');
  }
  if (scenario === 'online') {
    // Online path: needs the relay running (cd server && npm start). Also draws the results screen.
    const click = (q) => evaluate(`(() => { const e = document.querySelector('${q}'); if (!e) return 'MISSING ${q}'; e.click(); return 'ok'; })()`);
    for (let i = 0; i < 90 && (await evaluate(`window.__game.menu().tuning`)); i++) await sleep(500);
    await click('[data-act=start]'); await sleep(800);
    await click('[data-act=paint][data-v="#1d9d55"]'); await click('[data-act=mode][data-v=online]'); await sleep(300);
    await click('[data-act=probe]'); await sleep(1500);
    console.log('probe ', await evaluate(`document.getElementById('servernote').textContent`));
    await shot('o1_online_probe.png');
    await click('[data-act=go]'); await sleep(4000);
    console.log('online', await evaluate(`JSON.stringify({ state: window.__game.state, perf: document.getElementById('perf').textContent })`));
    await shot('o2_online_drive.png');
    await evaluate(`(window.__game.menu().showResults({ total: 187.234, best: 61.5, laps: [64.2, 61.5, 61.534], laps_target: 3 }), 1)`); await sleep(500);
    await shot('o3_results.png');
  }
  if (scenario === 'perf') {
    // Render cost A/B: frame intervals AND GPU time per frame (WebGPU timestamp queries, enabled
    // here at runtime) plus GPU-independent counts (draw calls, triangles) from renderer.info.
    // Parked for 4 s, then full throttle for 6 s. Other GPU users contaminate the frame intervals;
    // the GPU time is the sum of this page's passes and moves much less. PERF_JS: page code run
    // before measuring (e.g. a switch to compare).
    if (process.env.PERF_JS) console.log('perf_js', await evaluate(process.env.PERF_JS));
    await evaluate(`(() => { const g = window.__game, r = g.renderer, be = r.backend;
      be.trackTimestamp = r.hasFeature('timestamp-query');
      const S = window.__perf = { ft: [], gpu: [], calls: [], tris: [], on: false, pending: false, n: 0 };
      let p = performance.now();
      const f = (t) => { if (S.on) { S.ft.push(t - p); S.calls.push(r.info.render.drawCalls); S.tris.push(r.info.render.triangles); S.n++;
          if (be.trackTimestamp && !S.pending) { S.pending = true;
            Promise.all([r.resolveTimestampsAsync('render'), r.resolveTimestampsAsync('compute')]).then(([a, c]) => { if (a) S.gpu.push(a + (c || 0)); S.pending = false; }); } }
        p = t; requestAnimationFrame(f); };
      requestAnimationFrame(f); return be.trackTimestamp; })()`).then((t) => console.log('gpu timestamps', t));
    const stats = `(() => { const S = window.__perf, q = (a, p) => a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(1) : '-';
      const ft = S.ft.slice(3).sort((x, y) => x - y), gp = S.gpu.slice(3).sort((x, y) => x - y), c = S.calls.slice().sort((x, y) => x - y), tr = S.tris.slice().sort((x, y) => x - y);
      const r = 'frames ' + ft.length + '  frame median ' + q(ft, 0.5) + ' p95 ' + q(ft, 0.95) + ' max ' + q(ft, 1) + ' ms | GPU median ' + q(gp, 0.5) + ' p95 ' + q(gp, 0.95) + ' ms (' + gp.length + ') | draws ' + q(c, 0.5) + ' tris ' + (+q(tr, 0.5) / 1000).toFixed(0) + 'k'
        + '  >100ms at s: ' + (() => { let t = 0; return S.ft.map((x) => { t += x; return x > 100 ? (t / 1000).toFixed(1) + '(' + Math.round(x) + ')' : ''; }).filter(Boolean).join(' '); })();
      S.ft.length = S.gpu.length = S.calls.length = S.tris.length = 0; return r; })()`;
    await evaluate(`(window.__perf.on = true, 1)`);
    await sleep(4000);
    console.log('parked', await evaluate(stats));
    await shot('perf_parked.png');
    await key('keyDown', 'KeyW', 'w');
    await sleep(6000);
    console.log('drive ', await evaluate(stats), '|', (await evaluate(info)).kmh, 'km/h');
    await shot('perf_drive.png');
    await key('keyUp', 'KeyW', 'w');
    console.log('hud   ', (await evaluate(info)).perf);
  }
  if (scenario === 'switch') {
    // Quality-preset switches must not hitch: while driving, cycle the presets every 0.7 s and record
    // the frame interval around each switch; then two render-scale changes for comparison (those
    // DO reallocate render targets). Also renders one screenshot per preset.
    const rec = `(() => { window.__ft = []; let p = performance.now(); const f = (t) => { window.__ft.push(t - p); p = t; if (window.__ft.length < 600) requestAnimationFrame(f); }; requestAnimationFrame(f); return 1; })()`;
    const worst = `(() => { const a = window.__ft.slice(2).sort((x, y) => x - y); window.__ft.length = 600; return 'median ' + a[a.length >> 1].toFixed(1) + ' p95 ' + a[Math.floor(a.length * 0.95)].toFixed(1) + ' max ' + a[a.length - 1].toFixed(1) + ' ms (' + a.length + ' frames)'; })()`;
    for (const p of ['high', 'medium', 'low']) { await evaluate(`(window.__game.setPreset('${p}'), 1)`); await sleep(700); await shot(`preset_${p}.png`); }
    await evaluate(`(window.__game.setPreset('high'), 1)`);
    await key('keyDown', 'KeyW', 'w');
    await sleep(1000);
    await evaluate(rec);
    await sleep(3000);
    console.log('no switch    ', await evaluate(worst));
    await evaluate(rec);
    for (const p of ['medium', 'low', 'medium', 'high', 'low', 'high']) { await evaluate(`(window.__game.setPreset('${p}'), 1)`); await sleep(500); }
    console.log('6 switches   ', await evaluate(worst));
    await key('keyUp', 'KeyW', 'w');
    const pipes = await evaluate(`JSON.stringify(window.__game.pipelines())`);
    console.log('pipelines', pipes);
    const s0 = await evaluate(`window.__game.post.scale`);
    for (const s of [s0 - 0.1, s0]) {
      await evaluate(rec); await evaluate(`(window.__game.setScale(${s}), 1)`); await sleep(5000);
      console.log(`scale -> ${s.toFixed(1)}`, await evaluate(worst));
    }
  }
  if (scenario === 'warm') {
    // First 30 s after the loading screen (run with SETTLE=0): drive, lights off/on, a heavy
    // injected crash front and rear (lights break -> dark material clones, parts fly off), engine
    // fire, repair. Reports the worst frames and how many GPU pipelines were created AFTER loading
    // (GPU-independent: each one is a compile that can freeze a frame).
    const pipes = `window.__game.renderer._pipelines.caches.size`;
    const p0 = await evaluate(pipes);
    await evaluate(`(() => { window.__ft = []; window.__t0 = performance.now(); let p = window.__t0; const f = (t) => { window.__ft.push([t - window.__t0, t - p]); p = t; if (t - window.__t0 < 31000) requestAnimationFrame(f); }; requestAnimationFrame(f); return 1; })()`);
    const tap = async (code, k) => { await key('keyDown', code, k); await key('keyUp', code, k); };
    await key('keyDown', 'KeyW', 'w'); await sleep(4000); await key('keyUp', 'KeyW', 'w');
    await tap('KeyL', 'l'); await sleep(800); await tap('KeyL', 'l'); await sleep(500);
    await evaluate(`(() => { const g = window.__game, t = g.car.body.translation(), r = g.car.body.rotation();
      const q = { x: r.x, y: r.y, z: r.z, w: r.w }, f = [2 * (q.x * q.z + q.w * q.y), 2 * (q.y * q.z - q.w * q.x), 1 - 2 * (q.x * q.x + q.y * q.y)];
      for (let i = 0; i < 3; i++) g.core.contact({ x: t.x + f[0] * 2.2, y: t.y + 0.1, z: t.z + f[2] * 2.2 }, g.core.info.mass * 25 / 3, 777);
      for (let i = 0; i < 3; i++) g.core.contact({ x: t.x - f[0] * 2.2, y: t.y + 0.1, z: t.z - f[2] * 2.2 }, g.core.info.mass * 25 / 3, 777);
      return 1; })()`);
    await sleep(14000);   // smoulder -> fire
    console.log('fire', await evaluate(`Math.round(window.__game.damage.fireLight.intensity)`));
    await tap('KeyR', 'r'); await sleep(1500);
    await key('keyDown', 'KeyW', 'w'); await sleep(3000); await key('keyUp', 'KeyW', 'w');
    while ((await evaluate(`performance.now() - window.__t0`)) < 31000) await sleep(250);
    console.log('warm  ', await evaluate(`(() => { const a = window.__ft.slice(1), s = a.map((x) => x[1]).sort((x, y) => x - y);
      const big = a.filter((x) => x[1] > 100).map((x) => (x[0] / 1000).toFixed(1) + 's:' + Math.round(x[1]) + 'ms');
      return 'frames ' + s.length + '  median ' + s[s.length >> 1].toFixed(1) + '  p99 ' + s[Math.floor(s.length * 0.99)].toFixed(1) + '  worst ' + s[s.length - 1].toFixed(1) + ' ms  >100ms: ' + big.length + ' [' + big.join(' ') + ']'; })()`));
    console.log('pipelines created after loading:', (await evaluate(pipes)) - p0, `(${p0} at start)`);
  }
  if (scenario === 'profile') {
    // PROFILE_EARLY=1: profile from the throttle press (the first second of driving)
    if (!process.env.PROFILE_EARLY) { await key('keyDown', 'KeyW', 'w'); await sleep(1500); }
    await send('Profiler.enable');
    await send('Profiler.setSamplingInterval', { interval: 200 });
    await send('Profiler.start');
    if (process.env.PROFILE_EARLY) await key('keyDown', 'KeyW', 'w');
    await sleep(4000);
    const { profile } = await send('Profiler.stop');
    await key('keyUp', 'KeyW', 'w');
    const self = new Map(), byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const dts = profile.timeDeltas; let total = 0;
    profile.samples.forEach((id, i) => {
      const n = byId.get(id), f = n.callFrame, k = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`;
      self.set(k, (self.get(k) ?? 0) + (dts[i] ?? 0)); total += dts[i] ?? 0;
    });
    console.log('main-thread total', (total / 1000).toFixed(0), 'ms over 4 s');
    [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 22).forEach(([k, v]) => console.log(((v / total) * 100).toFixed(1).padStart(5) + '%', k));
  }
  if (scenario === 'night') {
    // Night lighting test (use with ?blackcar=1): AI cars parked in front of the player (one from
    // behind at 11 m, one side-on at 20 m, one facing the player at 32 m), screenshots with the
    // player's headlights on and off, then a short drive among the moving AI cars for frame pacing.
    const fps = `new Promise((res) => { const ft = []; let p = performance.now(); const f = (t) => { ft.push(t - p); p = t; if (ft.length < 150) requestAnimationFrame(f); else { const a = ft.slice(5).sort((x, y) => x - y); res('median ' + a[a.length >> 1].toFixed(1) + ' ms (' + (1000 / a[a.length >> 1]).toFixed(0) + ' fps)  p95 ' + a[Math.floor(a.length * 0.95)].toFixed(1) + '  max ' + a[a.length - 1].toFixed(1)); } }; requestAnimationFrame(f); })`;
    await evaluate(`(() => { const g = window.__game, t = g.car.body.translation(), r = g.car.body.rotation();
      const yaw = Math.atan2(2 * (r.w * r.y + r.x * r.z), 1 - 2 * (r.y * r.y + r.x * r.x)), y = t.y - g.core.info.cgHeight - 0.05;
      const at = (d, side) => ({ x: t.x + Math.sin(yaw) * d - Math.cos(yaw) * side, y, z: t.z + Math.cos(yaw) * d + Math.sin(yaw) * side });
      g.ai.park(0, 0, { pos: at(11, 0), yaw });
      g.ai.park(1, 0, { pos: at(20, 2.5), yaw: yaw + Math.PI / 2 });
      g.ai.park(2, 0, { pos: at(32, -2.5), yaw: yaw + Math.PI });
      return 1; })()`);
    await sleep(1500);
    console.log('lights on ', await evaluate(fps));
    await shot('night_on.png');
    await key('keyDown', 'KeyL', 'l'); await key('keyUp', 'KeyL', 'l');
    await sleep(800);
    console.log('lights off', await evaluate(fps));
    await shot('night_off.png');
    await key('keyDown', 'KeyL', 'l'); await key('keyUp', 'KeyL', 'l');
    await evaluate(`(window.__game.ai.reset(), 1)`);
    await evaluate(`(() => { window.__ft = []; let p = performance.now(); const f = (t) => { window.__ft.push(t - p); p = t; if (window.__ft.length < 2000) requestAnimationFrame(f); }; requestAnimationFrame(f); return 1; })()`);
    await key('keyDown', 'KeyW', 'w');
    await sleep(3500);
    await key('keyUp', 'KeyW', 'w');
    await sleep(2500);
    await shot('night_drive.png');
    console.log('drive ', JSON.stringify(await evaluate(info)));
    console.log('ai    ', await evaluate(`JSON.stringify(window.__game.ai.cars.map((c) => ({ s: +c.s.toFixed(1), kmh: Math.round(c.v * 3.6) })))`));
    console.log('pacing', await evaluate(`(() => { const a = window.__ft.slice(5).sort((x, y) => x - y), q = (p) => a[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(1);
      return 'frames ' + a.length + '  median ' + q(0.5) + ' ms  p95 ' + q(0.95) + '  p99 ' + q(0.99) + '  max ' + a[a.length - 1].toFixed(1) + '  >50ms: ' + a.filter((x) => x > 50).length; })()`));
  }
  const dmg = `(() => { const d = window.__game.core.damage(); return { kj: +d.totalKj.toFixed(1), last: +d.lastKj.toFixed(1), crush: d.crush.map(x => +x.toFixed(2)), engine: +d.engine.toFixed(2), wheel: d.wheel.map(x => +x.toFixed(2)), impacts: d.impacts, totaled: d.totaled,
    smoulder: +d.smoulder.toFixed(2), fire: +d.fire.toFixed(3), brakes: +d.brakes.toFixed(2), noBrakes: d.brakesFailed, dents: window.__game.damage.dents.count,
    warn: document.getElementById('warn').textContent }; })()`;
  const phys = `JSON.stringify(window.__game.physics(), (k, v) => typeof v === 'number' ? +v.toFixed(3) : v)`;
  if (scenario === 'crash' || scenario === 'damage') console.log('physics idle', await evaluate(phys));
  if (scenario === 'damage') {
    // Brake test on the open start straight: relaunch at 72 km/h, stand on the brake for 1 s.
    await evaluate(`(() => { const g = window.__game, t = g.car.body.translation(), r = g.car.body.rotation();
      window.__sp = { p: { x: t.x, y: t.y, z: t.z }, yaw: Math.atan2(2 * (r.w * r.y + r.x * r.z), 1 - 2 * (r.y * r.y + r.x * r.x)) }; return 1; })()`);
    const brakeTest = async (what) => {
      await evaluate(`(() => { const g = window.__game; g.input.hold = false; g.car.place(window.__sp.p, window.__sp.yaw, 20); return 1; })()`);
      await sleep(300);
      const v0 = (await evaluate(info)).kmh;
      await key('keyDown', 'KeyS', 's'); await sleep(1000);
      const v1 = (await evaluate(info)).kmh;
      await key('keyUp', 'KeyS', 's');
      console.log(`brake test (${what}): ${v0} km/h -> ${v1} km/h after 1 s on the brake`);
      await sleep(3000);
    };
    // Reverse, then a wreck (still drives forward? headlights flicker? fire grows? brakes fade?), repair.
    const lights = `window.__game.scene.getObjectsByProperty('isSpotLight', true).map(s => Math.round(s.intensity)).join('/')`;
    await key('keyDown', 'KeyW', 'w'); await sleep(2500); await key('keyUp', 'KeyW', 'w');
    console.log('W 2.5 s', JSON.stringify(await evaluate(info)));
    await key('keyDown', 'KeyS', 's');
    await sleep(1500);
    console.log('S 1.5 s (stop)', JSON.stringify(await evaluate(info)));
    await sleep(1500);
    console.log('S 3 s (reverse)', JSON.stringify(await evaluate(info)));
    await key('keyUp', 'KeyS', 's');
    await key('keyDown', 'KeyW', 'w'); await sleep(2000);
    console.log('W 2 s (brake from reverse, then 1st)', JSON.stringify(await evaluate(info)));
    await key('keyUp', 'KeyW', 'w');
    await key('keyDown', 'KeyS', 's'); await sleep(300); await key('keyUp', 'KeyS', 's');   // short: stop, no reverse
    await sleep(1500);
    // Wreck it: inject a 90 km/h frontal crash impulse at the nose (reproducible, no city geometry
    // luck) -> engine wrecked, totaled, headlights flicker, smoulder -> fire -> brakes cook.
    console.log('inject 90 km/h frontal', await evaluate(`(() => { const g = window.__game, t = g.car.body.translation(), r = g.car.body.rotation();
      const q = { x: r.x, y: r.y, z: r.z, w: r.w }, f = [2 * (q.x * q.z + q.w * q.y), 2 * (q.y * q.z - q.w * q.x), 1 - 2 * (q.x * q.x + q.y * q.y)];
      for (let i = 0; i < 3; i++) g.core.contact({ x: t.x + f[0] * 2.2, y: t.y + 0.1, z: t.z + f[2] * 2.2 }, g.core.info.mass * 25 / 3, 777);
      const d = g.core.damage(); return JSON.stringify({ engine: d.engine, totaled: d.totaled, kj: Math.round(d.totalKj) }); })()`));
    const flick = [];
    for (let i = 0; i < 16; i++) { await sleep(150); flick.push(await evaluate(lights)); }
    console.log('headlights after the hit (every 150 ms):', flick.join('  '));
    await shot('dmg_0_wreck.png');
    await key('keyDown', 'KeyW', 'w');
    await sleep(4000);
    console.log('W 4 s (totaled wreck must still drive forward)', JSON.stringify(await evaluate(info)));
    await key('keyUp', 'KeyW', 'w');
    for (let i = 0; i < 11; i++) {
      await sleep(4000);
      console.log(`t+${(i + 1) * 4}s`, JSON.stringify(await evaluate(dmg)), '| fireLight', await evaluate(`Math.round(window.__game.damage.fireLight.intensity)`), '|', (await evaluate(info)).perf);
      if (i === 3) await shot('dmg_1_fire.png');
      if (i === 8) await brakeTest('cooked brakes');
    }
    await shot('dmg_2_fire_big.png');
    await key('keyDown', 'KeyR', 'r'); await key('keyUp', 'KeyR', 'r');
    await sleep(800);
    console.log('after R', JSON.stringify(await evaluate(dmg)), '| lights', await evaluate(lights), '| physics', await evaluate(phys));
    await brakeTest('repaired');
    await sleep(3000);
    console.log('physics after repair (debris asleep/removed?)', await evaluate(phys));
    if (process.env.PROBE) console.log('probe log', await evaluate('(window.__dlog || []).join(" || ")'));
  }
  if (scenario === 'crash') {
    await key('keyDown', 'KeyW', 'w');
    await sleep(4000);
    console.log('speed ', JSON.stringify(await evaluate(info)));
    await key('keyDown', 'KeyA', 'a');
    let hit = false;
    for (let i = 0; i < 40 && !hit; i++) { await sleep(100); hit = (await evaluate(`window.__game.core.damage().impacts`)) > 0; }
    await key('keyUp', 'KeyA', 'a');
    await key('keyUp', 'KeyW', 'w');
    await sleep(250);
    console.log('impact', JSON.stringify(await evaluate(info)));
    await shot('crash_0.png');
    await sleep(1500);
    console.log('crash ', JSON.stringify(await evaluate(info)));
    console.log('damage', JSON.stringify(await evaluate(dmg)));
    if (process.env.PROBE) console.log('probe', JSON.stringify(await evaluate('window.__probe')));
    console.log('state ', await evaluate(`(() => { const g = window.__game, c = g.camera.position, r = g.car.body.rotation(); return JSON.stringify({ cam: [c.x, c.y, c.z].map(v => +v.toFixed(2)), quat: [r.x, r.y, r.z, r.w].map(v => +v.toFixed(3)), rig: { pos: g.rig.pos, look: g.rig.look, flat: g.rig.lastFlat, fov: g.camera.fov }, out: [102, 103, 96, 97, 98].map(i => g.car.out[i]) }); })()`));
    console.log('debris', await evaluate(`window.__game.scene.children.filter(o => /bumper|mirror/.test(o.name)).map(o => o.name).join(',') || 'none'`));
    await shot('crash_1.png');
    await key('keyDown', 'KeyC', 'c'); await key('keyUp', 'KeyC', 'c');
    await key('keyDown', 'KeyC', 'c'); await key('keyUp', 'KeyC', 'c');
  }
  if (scenario === 'mobile') {
    const tap = async (sel, ms) => {
      const r = await evaluate(`(() => { const b = document.querySelector('${sel}').getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()`);
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r[0], y: r[1], id: 1 }] });
      await sleep(ms);
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    console.log('touch ui', await evaluate(`[document.body.classList.contains('touch'), !!document.getElementById('touch'), getComputedStyle(document.getElementById('help')).display].join(' ')`));
    await shot('mobile_0.png');
    await tap('#touch .gas', 3500);
    console.log('gas 3.5s', JSON.stringify(await evaluate(info)));
    // steer: drag on the pad while holding gas (two fingers)
    const g = await evaluate(`(() => { const b = document.querySelector('#touch .gas').getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()`);
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: g[0], y: g[1], id: 1 }] });
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: g[0], y: g[1], id: 1 }, { x: 200, y: 300, id: 2 }] });
    for (let dx = 0; dx <= 60; dx += 15) { await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: g[0], y: g[1], id: 1 }, { x: 200 - dx, y: 300, id: 2 }] }); await sleep(60); }
    await sleep(1200);
    console.log('steer L', JSON.stringify(await evaluate(info)), 'steer input', await evaluate(`window.__game.input.raw.steer.toFixed(2)`));
    await shot('mobile_1.png');
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await tap('#touch .brake', 2500);
    console.log('brake  ', JSON.stringify(await evaluate(info)));
  }
  if (scenario === 'straight') {
  await shot('1_start.png');
  // frame pacing: record every frame interval while driving
  await evaluate(`(() => { window.__ft = []; let p = performance.now(); const f = (t) => { window.__ft.push(t - p); p = t; if (window.__ft.length < 2000) requestAnimationFrame(f); }; requestAnimationFrame(f); return 1; })()`);
  await key('keyDown', 'KeyW', 'w');
  for (let s = 1; s <= 7; s++) { await sleep(1000); console.log(`t=${s}s `, JSON.stringify(await evaluate(info))); }
  console.log('pacing', await evaluate(`(() => { const a = window.__ft.slice(5).sort((x, y) => x - y), q = (p) => a[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(1);
    const hitches = window.__ft.slice(5).filter((x) => x > 50).length;
    return 'frames ' + a.length + '  median ' + q(0.5) + ' ms  p95 ' + q(0.95) + '  p99 ' + q(0.99) + '  max ' + a[a.length - 1].toFixed(1) + '  >50ms: ' + hitches; })()`));
  console.log('audio ', await evaluate(`(() => { const a = window.__game.audio, c = a.ctx, e = a.eng, o = window.__game.car.out;
    if (!c) return 'no context';
    return JSON.stringify({ state: c.state, rpm: Math.round(o[103]), expectedHz: Math.round(o[103] / 60 * 4), oscHz: Math.round(e.o1.frequency.value),
      engineGain: +e.g.gain.value.toFixed(3), windGain: +a.wind.g.gain.value.toFixed(3), tyreGain: +a.tyre.g.gain.value.toFixed(3) }); })()`));
  await shot('2_speed.png');
  await key('keyUp', 'KeyW', 'w');
  await key('keyDown', 'KeyS', 's');
  await sleep(3000);
  await key('keyUp', 'KeyS', 's');
  console.log('brake ', JSON.stringify(await evaluate(info)));
  await shot('3_stopped.png');
  }
  console.log('screenshots in', out);
} finally {
  ws?.close();
  chrome.kill();
  await sleep(500);
  fs.rmSync(profile, { recursive: true, force: true });
}
