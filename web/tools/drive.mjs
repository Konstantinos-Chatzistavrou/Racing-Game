// Drives the game in the system Chrome with WebGPU enabled (Linux needs the flags) through the
// DevTools protocol: load, idle, full throttle, brake. Prints telemetry + fps, saves screenshots.
// Usage: node tools/drive.mjs [url] [outdir] [straight|crash|mobile]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:5173/';
const out = process.argv[3] ?? path.join(os.tmpdir(), 'drive');
const scenario = process.argv[4] ?? 'straight';
fs.mkdirSync(out, { recursive: true });
const port = Number(process.env.CDP_PORT ?? 9334);   // distinct ports let parallel runs coexist
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-webgpu-'));
const chrome = spawn('google-chrome', [
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--enable-unsafe-webgpu', '--enable-features=Vulkan', `--window-size=${process.env.WIN ?? '1280,800'}`,
  // other windows (e.g. a full-screen Chrome) must not throttle the test window's frame rate
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
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
  if (scenario === 'profile') {
    await key('keyDown', 'KeyW', 'w');
    await sleep(1500);
    await send('Profiler.enable');
    await send('Profiler.setSamplingInterval', { interval: 200 });
    await send('Profiler.start');
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
