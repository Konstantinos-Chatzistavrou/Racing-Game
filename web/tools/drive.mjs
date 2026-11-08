// Drives the game in the system Chrome with WebGPU enabled (Linux needs the flags) through the
// DevTools protocol: load, idle, full throttle, brake. Prints telemetry + fps, saves screenshots.
// Usage: node tools/drive.mjs [url] [outdir] [straight|crash|mobile|bench|profile|night|menu|race6|follow|dnf|poles|walls|devices]   (parties: tools/party_test.mjs, tools/party_game_test.mjs)   (CDP_PORT=9334 to change the DevTools port)
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
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });   // userGesture: element.click() counts as a user activation (fullscreen)
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
  if (scenario === 'menu' || scenario === 'race6') {
    // Front end walk-through (run with ?menu=1): title -> Garage (car, paint, upgrades) -> Continue -> game modes -> race (6 cars),
    // pause, quit to the main menu, Play -> modes -> Multiplayer lobby. race6: the race only, with the AI field reported over time.
    const click = (q) => evaluate(`(() => { const e = document.querySelector('${q}'); if (!e) return 'MISSING ${q}'; e.click(); return 'ok'; })()`);
    const st = () => evaluate(`JSON.stringify({ state: window.__game.state, tuning: window.__game.menu().tuning, screen: window.__game.menu().screen, kmh: Math.round(window.__game.car.out[102] * 3.6) })`);
    const field = () => evaluate(`JSON.stringify({ ai: window.__game.ai.cars.map((c) => c.name.split(' ')[0] + ':' + Math.round(c.v * 3.6) + 'kmh@' + Math.round(c.s) + ' lat ' + c.lat.toFixed(1)),
      board: [...document.querySelectorAll('#board .b')].map((e) => e.textContent), pos: document.getElementById('lappos')?.textContent })`);
    for (let i = 0; i < 90 && (await evaluate(`window.__game.menu().tuning`)); i++) await sleep(500);
    console.log('title ', await st(), await evaluate(`document.querySelector('.note')?.textContent`));
    await shot('m1_title.png');
    if (scenario === 'menu') {
      console.log('garage', await click('[data-act=garage-open]')); await sleep(2500); await shot('m2_garage.png');
      console.log('no mode picker in garage:', await evaluate(`!document.querySelector('[data-act=mode]') && !document.querySelector('#server')`));
      await click(`[data-act=car][data-v=${process.env.MENU_CAR ?? 'vela_gtr'}]`); await sleep(500);
      await click('[data-act=paint][data-v="#1d4ed8"]'); await click('[data-act=finish][data-v=metallic]');
      if (!process.env.NOMODS) { await click('[data-act=mod][data-k=engine][data-v="2"]'); await click('[data-act=mod][data-k=tyres][data-v="1"]'); }
      await sleep(2500); await shot('m3_garage_gtr.png');
      console.log('continue', await click('[data-act=play]')); await sleep(800); console.log('modes ', await st()); await shot('m4_modes.png');
    } else { console.log('play', await click('[data-act=play]')); await sleep(800); }
    await click('[data-act=laps][data-v="1"]'); await sleep(200);
    await click('[data-act=start-race]'); await sleep(1500); console.log('count ', await st()); await shot('m5_countdown.png');
    console.log('grid  ', await field());
    await sleep(3500); console.log('race  ', await st());
    await evaluate(`(window.__game.input.hold = false, 1)`);
    for (let i = 0; i < (scenario === 'race6' ? 6 : 1); i++) {
      await sleep(scenario === 'race6' ? 5000 : 2500);
      console.log(`t+${(i + 1) * 5}s`, await field());
      await shot(`m6_race_${i}.png`);
    }
    await evaluate(`(window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' })), 1)`); await sleep(600);
    console.log('pause ', await st()); await shot('m7_pause.png');
    await click('[data-act=quit]'); await sleep(1500); console.log('quit  ', await st()); await shot('m8_title_again.png');
    if (scenario === 'menu') {
      await click('[data-act=play]'); await sleep(500); await click('[data-act=lobby]'); await sleep(500); await shot('m9_lobby.png');
      console.log('lobby ', await st());
      await click('[data-act=modes]'); await sleep(300); await click('[data-act=start-free]'); await sleep(4000);
      console.log('free roam (expect no rivals, no board):', await evaluate(`JSON.stringify({ state: window.__game.state, ai: window.__game.ai.mode, board: !document.getElementById('board').hidden })`));
    }
  }
  if (scenario === 'devices') {
    // Every input device without hardware (run with ?menu=1): fake Gamepad API objects for an Xbox pad, a DualSense and a
    // Logitech G29 wheel (non-standard mapping, pedals resting at +1). Menu navigation with the pad, driving with each
    // device, Start pauses / resumes, the wheel calibration wizard driven by the wheel alone, the Controls screen.
    await evaluate(`(() => { window.__pads = []; window.__rumble = [];
      Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => window.__pads });
      window.__mk = (id, mapping, nAxes, nButtons, index = 0) => ({ id, index, mapping, connected: true, timestamp: 0,
        axes: new Array(nAxes).fill(0), buttons: Array.from({ length: nButtons }, () => ({ pressed: false, touched: false, value: 0 })),
        vibrationActuator: { type: 'dual-rumble', playEffect: (t, o) => { window.__rumble.push(o); return Promise.resolve('complete'); } } });
      window.__btn = (i, on, pad = 0) => { const b = window.__pads[pad].buttons[i]; b.pressed = on; b.value = on ? 1 : 0; };
      return 1; })()`);
    const press = async (i, pad = 0) => { await evaluate(`(__btn(${i}, true, ${pad}), 1)`); await sleep(250); await evaluate(`(__btn(${i}, false, ${pad}), 1)`); await sleep(250); };
    const st = () => evaluate(`JSON.stringify({ state: window.__game.state, screen: window.__game.menu().screen, focus: document.querySelector('.nav-focus')?.dataset.act ?? null,
      device: window.__game.input.device, family: window.__game.input.family, raw: Object.fromEntries(Object.entries(window.__game.input.raw).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(2) : v])),
      kmh: Math.round(window.__game.car.out[102] * 3.6), help: document.getElementById('help').textContent.slice(0, 70) })`);
    for (let i = 0; i < 90 && (await evaluate(`window.__game.menu().tuning`)); i++) await sleep(500);
    // Xbox pad: navigate the title with the D-pad, A opens Controls
    await evaluate(`(window.__pads = [__mk('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', 'standard', 4, 17)], dispatchEvent(new Event('gamepadconnected')), 1)`);
    await press(13); console.log('dpad down  ', await st());
    let guard = 0;
    const foc = () => evaluate(`document.querySelector('.nav-focus')?.dataset.act ?? null`);
    while (!['bench', 'soak', 'controls-open'].includes(await foc()) && guard++ < 12) await press(13);   // down to the utility row
    while ((await foc()) !== 'controls-open' && guard++ < 16) await press(15);                            // then right
    console.log('focus      ', await evaluate(`document.querySelector('.nav-focus')?.dataset.act`));
    await press(0); await sleep(300); console.log('A          ', await st()); await shot('d1_controls_xbox.png');
    await press(1); await sleep(300); console.log('B (back)   ', await st());
    // drive with the pad
    await evaluate(`(document.querySelector('[data-act=play]').click(), 1)`); await sleep(400);
    await evaluate(`(document.querySelector('[data-act=start-free]').click(), 1)`); await sleep(4000);
    await evaluate(`(() => { const p = __pads[0]; p.axes[0] = -0.5; p.buttons[7].value = 1; p.buttons[7].pressed = true; return 1; })()`);
    for (let i = 0; i < 40 && (await evaluate(`window.__game.input.device`)) !== 'pad'; i++) await sleep(500);   // first frames of a session are slow headless
    await sleep(2500); console.log('xbox drive ', await st());
    await evaluate(`(() => { const p = __pads[0]; p.axes[0] = 1; return 1; })()`); await sleep(1500);
    console.log('rumble calls', await evaluate(`window.__rumble.length`), JSON.stringify(await evaluate(`window.__rumble.slice(-1)[0] ?? null`)));
    await evaluate(`(() => { const p = __pads[0]; p.axes[0] = 0; p.buttons[7].value = 0; p.buttons[7].pressed = false; return 1; })()`);
    await press(9); await sleep(300); console.log('Start      ', await st()); await shot('d2_pause_pad.png');
    await press(9); await sleep(300); console.log('Start again', await st());
    // DualSense: labels follow the family
    await evaluate(`(window.__pads = [__mk('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)', 'standard', 4, 18)], 1)`);
    await evaluate(`(() => { const p = __pads[0]; p.buttons[7].value = 0.6; p.buttons[7].pressed = true; return 1; })()`); await sleep(1200);
    console.log('dualsense  ', await st());
    await evaluate(`(() => { const p = __pads[0]; p.buttons[7].value = 0; p.buttons[7].pressed = false; return 1; })()`);
    // G29 wheel: axis 0 steering, 1 clutch?, 2 throttle, 3 brake, all pedals rest at +1 and go to -1 pressed (Linux / Chrome)
    await evaluate(`(() => { const w = __mk('G29 Driving Force Racing Wheel (Vendor: 046d Product: c24f)', '', 6, 25, 0); w.axes[1] = 1; w.axes[2] = 1; w.axes[3] = 1; window.__pads = [w]; return 1; })()`);
    await evaluate(`(__pads[0].axes[0] = -0.2, 1)`); await sleep(800);
    console.log('g29 uncal  ', await st(), 'wheelPos', await evaluate(`window.__game.input.wheelPos.toFixed(3)`));
    // calibrate with the wheel only: pause (no button mapped yet: Escape), Controls, Calibrate, then every step by the wheel
    await evaluate(`(window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' })), 1)`); await sleep(400);
    await evaluate(`(document.querySelector('[data-act=controls-open]').click(), 1)`); await sleep(400);
    await evaluate(`(__pads[0].axes[0] = 0, 1)`); await sleep(200);
    await evaluate(`(document.querySelector('[data-act=c-cal]').click(), 1)`); await sleep(300);
    const step = () => evaluate(`document.querySelector('.cal-prompt')?.textContent ?? '(done) ' + (document.querySelector('.pnote')?.textContent ?? '')`);
    const sweep = async (axis, from, to) => { await evaluate(`(__pads[0].axes[${axis}] = ${to}, 1)`); await sleep(350); await evaluate(`(__pads[0].axes[${axis}] = ${from}, 1)`); await sleep(350); };
    console.log('cal 1', await step()); await shot('d3_calibrate.png'); await press(3);
    console.log('cal 2', await step()); await sweep(0, 0, -1);
    console.log('cal 3', await step()); await sweep(2, 1, -1);
    console.log('cal 4', await step()); await sweep(3, 1, -1);
    console.log('cal 5', await step()); await sweep(1, 1, -1);
    console.log('cal 6', await step()); await press(4);
    console.log('cal 7', await step()); await press(5);
    console.log('cal 8', await step()); await press(23);
    console.log('cal 9', await step()); await press(24);
    console.log('cal 10', await step()); await press(9);
    console.log('cal 11', await step()); await press(10);
    console.log('cal end', await step());
    console.log('saved', await evaluate(`JSON.stringify(window.__game.input.settings.calibration)`));
    await shot('d4_calibrated.png');
    await evaluate(`(document.querySelector('[data-act=c-back]').click(), 1)`); await sleep(300);
    await evaluate(`(document.querySelector('[data-act=resume]').click(), 1)`); await sleep(300);
    await evaluate(`(() => { const p = __pads[0]; p.axes[0] = -0.25; p.axes[2] = -1; return 1; })()`); await sleep(2500);
    console.log('g29 drive  ', await st(), 'wheelPos', await evaluate(`window.__game.input.wheelPos.toFixed(3)`));
    await evaluate(`(() => { const p = __pads[0]; p.axes[2] = 1; p.axes[3] = -1; return 1; })()`); await sleep(1500);
    console.log('g29 brake  ', await st());
    await press(9); await sleep(300); console.log('wheel pause', await st());
    await press(9); await sleep(300);
    // keyboard takes over the moment a key is pressed
    await key('keyDown', 'KeyW', 'w'); await sleep(600); console.log('keyboard   ', await st()); await key('keyUp', 'KeyW', 'w');
    console.log('ffb status ', await evaluate(`window.__game.ffb.status`));
  }
  if (scenario === 'assists') {
    // Settings / assists / shop / credits (run with ?menu=1, a fresh profile = a new player): title has 4 buttons,
    // Beginner preset reaches the core (b[93..95]), the driving line shows in a race, a race pays credits, the shop
    // sells a car and an upgrade, the garage lists only owned cars.
    const click = (q) => evaluate(`(() => { const e = document.querySelector('${q}'); if (!e) return 'MISSING ${q}'; e.click(); return 'ok'; })()`);
    const g = (e) => evaluate(`JSON.stringify(${e})`);
    for (let i = 0; i < 90 && (await evaluate(`window.__game.menu().tuning`)); i++) await sleep(500);
    console.log('title buttons', await g(`[...document.querySelectorAll('.title-btns button')].map((b) => b.dataset.act)`), await g(`document.querySelector('.credits')?.textContent`));
    await shot('a1_title.png');
    await click('[data-act=settings-open]'); await sleep(300);
    console.log('preset', await click('[data-act=as-preset][data-v=beginner]')); await sleep(200); await shot('a2_settings.png');
    console.log('toggles', await g(`window.__game.input.assists`));
    await click('[data-act=as-tc][data-v="2"]'); console.log('tc2 -> preset', await g(`window.__game.menu().assists.preset`), await g(`window.__game.input.assists.tcSlip`));
    await click('[data-act=as-preset][data-v=beginner]'); await click('[data-act=settings-back]');
    await click('[data-act=shop-open]'); await sleep(300); await shot('a3_shop.png');
    console.log('shop', await g(`[...document.querySelectorAll('.scard')].map((c) => c.querySelector('b').textContent + ': ' + c.querySelector('button').textContent)`));
    console.log('buy touring', await click('[data-act=buy-car][data-v=vela_touring]'), await g(`document.querySelector('.pnote')?.textContent`), await g(`document.querySelector('.wallet-pill')?.textContent`));
    console.log('buy tyres S1', await click('[data-act=buy-mod][data-k=tyres][data-v="1"]'), await g(`document.querySelector('.pnote')?.textContent`), await g(`document.querySelector('.wallet-pill')?.textContent`));
    await click('[data-act=garage-open]'); await sleep(1500);
    console.log('garage cars', await g(`[...document.querySelectorAll('.car b')].map((e) => e.textContent)`), 'locked pips', await g(`document.querySelectorAll('.pip.locked').length`));
    await shot('a4_garage.png');
    await click('[data-act=play]'); await sleep(400); await click('[data-act=laps][data-v="1"]'); await click('[data-act=start-race]');
    await sleep(6000); await evaluate(`(window.__game.input.hold = false, 1)`);
    await key('keyDown', 'KeyW', 'w'); await sleep(4000); await key('keyUp', 'KeyW', 'w');
    await shot('a5_line.png');
    console.log('race', await g(`{ state: window.__game.state, kmh: Math.round(window.__game.car.out[102] * 3.6) }`));
    // jump to the results: finish by DNF (realism default) is slow; quit through the pause menu pays nothing, so use the results path
    await evaluate(`(window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' })), 1)`); await sleep(400);
    console.log('pause has settings', await g(`!!document.querySelector('[data-act=settings-open]')`));
    await click('[data-act=settings-open]'); await sleep(200); console.log('in-session settings hides graphics', await g(`!document.querySelector('[data-act=gfx]')`));
    await click('[data-act=settings-back]'); await sleep(200);
    await click('[data-act=quit]'); await sleep(1500);
    await click('[data-act=play]'); await sleep(300); await click('[data-act=start-free]'); await sleep(5000);
    await evaluate(`(window.__game.input.hold = false, 1)`);
    await key('keyDown', 'KeyW', 'w'); await sleep(8000); await key('keyUp', 'KeyW', 'w');
    await evaluate(`(window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' })), 1)`); await sleep(400);
    await click('[data-act=quit]'); await sleep(1500);
    console.log('free roam pay', await g(`document.querySelector('.earned')?.textContent`), await g(`document.querySelector('.credits')?.textContent`));
    await shot('a6_title_earned.png');
  }
  if (scenario === 'dnf') {
    // Full realism (title setting) race: flip the car -> 'ROLLED OVER · OUT IN n s' -> DNF after 5 s -> spectating the rivals
    // (switch car), Results -> 'Did not finish'. Then Respawns: R works in a race.
    const click = (q) => evaluate(`(() => { const e = document.querySelector('${q}'); if (!e) return 'MISSING ${q}'; e.click(); return 'ok'; })()`);
    const st = () => evaluate(`JSON.stringify({ state: window.__game.state, warn: document.getElementById('warn').textContent, spec: document.getElementById('spectate').hidden ? null : document.getElementById('spectate').textContent.replace(/\s+/g, ' '),
      resetBtn: getComputedStyle(document.getElementById('hud-reset')).display })`);
    for (let i = 0; i < 90 && (await evaluate(`window.__game.menu().tuning`)); i++) await sleep(500);
    await click('[data-act=settings-open]'); console.log('realism chip', await click('[data-act=realism][data-v="1"]')); await click('[data-act=settings-back]');
    await click('[data-act=play]'); await sleep(400); await click('[data-act=laps][data-v="1"]'); await click('[data-act=start-race]');
    await sleep(6000); console.log('racing', await st());
    await evaluate(`(() => { const b = window.__game.car.body, t = b.translation(); b.setTranslation({ x: t.x, y: t.y + 1.5, z: t.z }, true); b.setRotation({ x: 0, y: 0, z: 1, w: 0 }, true); return 1; })()`);
    await sleep(2500); console.log('flipped', await st()); await shot('d1_rolled.png');
    await sleep(4500); console.log('out', await st()); await shot('d2_spectate.png');
    await click('#spectate [data-sp="1"]'); await sleep(1500); console.log('next', await st()); await shot('d3_spectate_next.png');
    await click('#spectate [data-sp="res"]'); await sleep(800);
    console.log('results', await evaluate(`JSON.stringify({ state: window.__game.state, h2: document.querySelector('#menu h2')?.textContent, earned: document.querySelector('.earned')?.textContent, rows: [...document.querySelectorAll('.srow')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()) })`));
    await shot('d4_results.png');
    await click('[data-act=quit]'); await sleep(1000);
    await click('[data-act=settings-open]'); await click('[data-act=realism][data-v="0"]'); await click('[data-act=settings-back]'); await click('[data-act=play]'); await sleep(400); await click('[data-act=start-race]');
    await sleep(6000);
    const before = await evaluate(`JSON.stringify(window.__game.car.body.translation())`);
    await evaluate(`(() => { const b = window.__game.car.body, t = b.translation(); b.setTranslation({ x: t.x + 6, y: t.y + 1.5, z: t.z }, true); b.setRotation({ x: 0, y: 0, z: 1, w: 0 }, true); return 1; })()`);
    await sleep(1500);
    await evaluate(`(window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', key: 'r' })), 1)`); await sleep(1500);
    console.log('respawns: R after a flip', await st(), before, await evaluate(`JSON.stringify({ upY: (() => { const r = window.__game.car.body.rotation(); return +(1 - 2 * (r.x * r.x + r.z * r.z)).toFixed(2); })() })`));
  }
  if (scenario === 'walls') {
    // Building walls (run headless: HEADLESS=1): square-on hits at 25 / 50 / 90 km/h on the nearest buildings with a clear run-up.
    // Prints whether the wall broke, speed left, damage, then 3 s later (full throttle) whether the car got out; frame times
    // before / after the first breach; screenshots outside and in.
    const spawn = await evaluate(`JSON.stringify(window.__game.car.body.translation())`);
    const used = [];
    const setup = (kmh, minH = 0, maxH = 1e9) => evaluate(`(() => {
      const g = window.__game, s0 = ${spawn}, V = g.camera.position.constructor, nyc = g.nyc;
      g.car.place(new V(s0.x, s0.y, s0.z), 0, 0); g.core.repair(); g.damage.repair();
      const boxes = []; for (const t of nyc.tiles.values()) for (const bc of t.buildingCols ?? []) if (!bc.breached) boxes.push(bc.box);
      const inside = (x, z, m) => boxes.some((b) => { const dx = x - b.cx, dy = -z - b.cy, c = Math.cos(-b.yaw), s = Math.sin(-b.yaw);
        return Math.abs(dx * c - dy * s) < b.hx + m && Math.abs(dx * s + dy * c) < b.hy + m; });
      const poles = [], trees = []; g.streetProps.near(s0.x, -s0.z, 200, poles, trees); const obs = [...poles, ...trees];
      const cands = boxes.filter((b) => b.z1 - b.z0 >= ${minH} && b.z1 - b.z0 <= ${maxH} && !${JSON.stringify(used)}.includes(b.cx + ',' + b.cy))
        .sort((a, b) => Math.hypot(a.cx - s0.x, a.cy + s0.z) - Math.hypot(b.cx - s0.x, b.cy + s0.z));
      for (const b of cands.slice(0, 40)) {
        const X = [Math.cos(b.yaw), -Math.sin(b.yaw)], Z = [Math.sin(b.yaw), Math.cos(b.yaw)];
        for (const [n, h, uh] of [[X, b.hx, b.hy], [[-X[0], -X[1]], b.hx, b.hy], [Z, b.hy, b.hx], [[-Z[0], -Z[1]], b.hy, b.hx]]) {
          if (uh < 3 || h < 3) continue;
          const fx = b.cx + n[0] * h, fz = -b.cy + n[1] * h;          // face centre (three x, z)
          let ok = true;
          for (let d = 1.5; d <= 20 && ok; d += 1) { const x = fx + n[0] * d, z = fz + n[1] * d; if (inside(x, z, 1.4)) ok = false;
            if (obs.some((o) => Math.hypot(o.x - x, -o.y - z) < 2.2)) ok = false; }
          if (!ok) continue;
          g.car.place(new V(fx + n[0] * 16, b.z0 + 0.6, fz + n[1] * 16), Math.atan2(-n[0], -n[1]), ${kmh} / 3.6); g.input.hold = false;
          window.__wall = b;
          return JSON.stringify({ key: b.cx + ',' + b.cy, height: Math.round(b.z1 - b.z0), size: [Math.round(2 * b.hx), Math.round(2 * b.hy)] });
        }
      }
      return 'none';
    })()`);
    const state = () => evaluate(`(() => { const g = window.__game, b = window.__wall, d = g.damage.last;
      return JSON.stringify({ kmh: Math.round(Math.abs(g.car.out[102]) * 3.6), breaches: g.nyc.breaches.count, kj: d ? +d.totalKj.toFixed(0) : 0, totaled: d?.totaled ?? false }); })()`);
    const frames = (ms) => evaluate(`new Promise((res) => { const ft = []; let p = performance.now(); const t0 = p;
      const f = (t) => { ft.push(+(t - p).toFixed(1)); p = t; if (t - t0 < ${ms}) requestAnimationFrame(f); else res(ft); }; requestAnimationFrame(f); })`);
    const st = (a) => { const s = a.slice().sort((x, y) => x - y); return `median ${s[Math.floor(s.length / 2)]} p95 ${s[Math.floor(s.length * 0.95)]} max ${s[s.length - 1]}`; };
    await sleep(3000);
    // log every pipeline compiled from here on: material | object
    await evaluate(`(() => { const P = window.__game.renderer._pipelines, seen = new Set(P.caches.keys()), orig = P.getForRender.bind(P); window.__newPipes = [];
      P.getForRender = (ro, pr) => { const r = orig(ro, pr); if (P.caches.size > seen.size) for (const k of P.caches.keys()) if (!seen.has(k)) { seen.add(k);
        window.__newPipes.push((ro.material.name || ro.material.type) + ' | ' + (ro.object.name || ro.object.type) + (ro.object.isInstancedMesh ? ' (inst)' : '')); } return r; }; return 1; })()`);
    for (const [kmh, minH, maxH, name] of (process.env.WALLS ? JSON.parse(process.env.WALLS) : [[25, 0, 1e9, 'w25'], [50, 61, 1e9, 'w50_glass'], [75, 61, 1e9, 'w75_glass'], [50, 0, 21, 'w50_brick'], [90, 0, 21, 'w90_brick']])) {
      const r = await setup(kmh, minH, maxH);
      if (r === 'none') { console.log(name, 'no clear wall'); continue; }
      used.push(JSON.parse(r).key);
      const p0 = await evaluate(`window.__game.pipelines().now`);
      const pre = evaluate(`new Promise((res) => setTimeout(() => res(Math.round(Math.abs(window.__game.car.out[102]) * 3.6)), 750))`);
      const before = await frames(900);
      console.log(name, 'speed 0.75 s in (just before the wall):', await pre);
      console.log(name, 'setup', r, '| before', st(before));
      const after = await frames(1600);
      console.log(name, 'hit', await state(), '| after', st(after), '| new pipelines', (await evaluate(`window.__game.pipelines().now`)) - p0);
      console.log(name, 'pipelines compiled:', await evaluate(`JSON.stringify(window.__newPipes.splice(0))`));
      console.log(name, 'where', await evaluate(`(() => { const g = window.__game, b = window.__wall, c = Math.cos(b.yaw), s = Math.sin(b.yaw);
        const loc = (p) => { const dx = p.x - b.cx, dz = p.z + b.cy; return [+(dx * c - dz * s).toFixed(1), +(p.y - b.z0).toFixed(1), +(dx * s + dz * c).toFixed(1)]; };
        // what the chase camera's wall check hits: ray from 1 m above the car toward where the camera wants to be (behind, up)
        const t = g.car.body.translation(), r = g.car.body.rotation(), V = g.camera.position.constructor, Q = g.camera.quaternion.constructor;
        const fwd = new V(0, 0, 1).applyQuaternion(new Q(r.x, r.y, r.z, r.w)); fwd.y = 0; fwd.normalize();
        const head = new V(t.x, t.y + 1, t.z), want = head.clone().addScaledVector(fwd, -5).add(new V(0, 1.2, 0));
        return JSON.stringify({ half: [+b.hx.toFixed(1), +b.hy.toFixed(1)], car: loc(t), cam: loc(g.camera.position), want: loc(want) }); })()`));
      console.log(name, 'camera ray', await evaluate(`(() => { const g = window.__game, pw = g.nyc.pw, t = g.car.body.translation(), r = g.car.body.rotation();
        const V = g.camera.position.constructor, Q = g.camera.quaternion.constructor;
        const fwd = new V(0, 0, 1).applyQuaternion(new Q(r.x, r.y, r.z, r.w)); fwd.y = 0; fwd.normalize();
        const head = new V(t.x, t.y + 1, t.z), want = head.clone().addScaledVector(fwd, -5).add(new V(0, 1.2, 0));
        const hit = pw.raycast(head, want, g.car.body, true, ((1 << 16) | (0xfffd & ~0x4 & ~0x8)));
        if (!hit) return 'clear';
        const c = hit.collider, s = c.shape, tr = c.translation();
        return JSON.stringify({ toi: +hit.toi.toFixed(2), type: s.type, half: s.halfExtents ? [s.halfExtents.x, s.halfExtents.y, s.halfExtents.z].map((x) => +x.toFixed(2)) : s.radius, at: [tr.x, tr.y, tr.z].map((x) => +x.toFixed(1)),
          groups: (c.collisionGroups() >>> 0).toString(16), body: c.parent() ? (c.parent().isKinematic() ? 'kin' : c.parent().isDynamic() ? 'dyn' : 'fixed') : 'static' }); })()`));
      await shot(`${name}_a.png`);
      await evaluate(`(window.__game.input.hold = false, window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w' })), 1)`);
      await sleep(3000);
      await evaluate(`(window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'w' })), 1)`);
      console.log(name, '+3s throttle', await state(), await evaluate(`JSON.stringify(window.__game.car.body.translation())`));
      await shot(`${name}_b.png`);
    }
  }
  if (scenario === 'wallperf') {
    // Frame times around a forced storefront breach (nyc.breakNearestShop), then a profile of the worst frames' cause:
    // per-frame ms for 1 s before and 3 s after, plus pipelines compiled.
    await sleep(4000);
    const frames = (ms) => evaluate(`new Promise((res) => { const ft = []; let p = performance.now(); const t0 = p;
      const f = (t) => { ft.push(+(t - p).toFixed(1)); p = t; if (t - t0 < ${ms}) requestAnimationFrame(f); else res(ft); }; requestAnimationFrame(f); })`);
    const pipes = () => evaluate(`window.__game.pipelines().now`);
    const before = await frames(1000), p0 = await pipes();
    const t0 = Date.now();
    const r = await evaluate(`(() => { const g = window.__game, t0 = performance.now(); const ok = g.nyc.breakNearestShop(g.car.body.translation(), { x: 0, y: 0, z: -12 }); return JSON.stringify({ ok, syncMs: +(performance.now() - t0).toFixed(1) }); })()`);
    const after = await frames(3000), p1 = await pipes();
    const st = (a) => { const s = a.slice().sort((x, y) => x - y); return `median ${s[Math.floor(s.length / 2)]} max ${s[s.length - 1]} >50ms ${a.filter((x) => x > 50).length}`; };
    console.log('breach call', r, 'pipelines', p0, '->', p1);
    console.log('before', st(before)); console.log('after ', st(after)); console.log('after first 30 frames', JSON.stringify(after.slice(0, 30)));
    await shot('w_breach.png');
  }
  if (scenario === 'poles') {
    // Solid street furniture (run headless: HEADLESS=1): a lamp post at 72 km/h (shears, car keeps ~64 km/h, pole topples),
    // the same at 15 km/h (too slow to shear: stops the car, pole stays), a tree at 50 km/h (never breaks).
    // Each case: back to the spawn, pick the nearest object of the kind whose approach is clear, start 6 m out in the
    // street (lamp yaw = the mast arm, pointing into the street) and 13 m along the kerb, aimed at it.
    const spawn = await evaluate(`JSON.stringify(window.__game.car.body.translation())`);
    const setup = (kind, kmh) => evaluate(`(() => {
      const g = window.__game, sp = g.streetProps, s0 = ${spawn}, V = g.camera.position.constructor;
      g.car.place(new V(s0.x, s0.y, s0.z), 0, 0);
      const poles = [], trees = [];
      sp.near(s0.x, -s0.z, 160, poles, trees);
      const lamps = poles.filter((p) => p.kind === 'lamp');
      const list = ('${kind}' === 'tree' ? trees : poles.filter((p) => p.kind === '${kind}'))
        .sort((a, b) => Math.hypot(a.x - s0.x, a.y + s0.z) - Math.hypot(b.x - s0.x, b.y + s0.z));
      const all = [...poles, ...trees];
      for (const o of list) {
        const ref = o.yaw !== undefined && o.kind !== 'hydrant' ? o : lamps.reduce((m, l) => (!m || Math.hypot(l.x - o.x, l.y - o.y) < Math.hypot(m.x - o.x, m.y - o.y) ? l : m), null);
        if (!ref) continue;
        const ix = Math.cos(ref.yaw), iz = -Math.sin(ref.yaw), kx = -Math.sin(ref.yaw), kz = -Math.cos(ref.yaw);   // into street, along kerb (three)
        for (const side of [1, -1]) {
          const sx = o.x + ix * 6 + kx * 13 * side, sz = -o.y + iz * 6 + kz * 13 * side;
          let dx = o.x - sx, dz = -o.y - sz; const d = Math.hypot(dx, dz); dx /= d; dz /= d;
          const clear = all.every((q) => { if (q === o) return true;
            const px = q.x - sx, pz = -q.y - sz, along = px * dx + pz * dz, side2 = Math.abs(px * dz - pz * dx);
            return along < -2 || along > d + 6 || side2 > 1.8; });
          if (!clear) continue;
          g.car.place(new V(sx, o.z + 0.6, sz), Math.atan2(dx, dz), ${kmh} / 3.6); g.input.hold = false;
          window.__target = o;
          return JSON.stringify({ target: [o.x.toFixed(1), o.y.toFixed(1)], dist: d.toFixed(1) });
        }
      }
      return 'no clear ${kind}';
    })()`);
    const after = (ms) => sleep(ms).then(() => evaluate(`(() => { const g = window.__game, o = window.__target, d = g.damage.last;
      return JSON.stringify({ kmh: Math.round(Math.abs(g.car.out[102]) * 3.6), broken: o.broken ?? 'tree', kj: d ? +d.totalKj.toFixed(1) : 0, colliders: g.obstacles?.count,
        dist: +Math.hypot(g.car.body.translation().x - o.x, g.car.body.translation().z + o.y).toFixed(1) }); })()`));
    await sleep(3000);
    if (process.env.FALL) {
      // the fall itself: a lamp clipped with the right corner along the kerb at 72 km/h (the car stays on the road), then a
      // lamp knocked down backward onto a parked car (does it land, dent the roof and lie on it?)
      const r = await evaluate(`(() => { const g = window.__game, sp = g.streetProps, s0 = ${spawn}, V = g.camera.position.constructor;
        const poles = []; sp.near(s0.x, -s0.z, 160, poles, []);
        const l = poles.filter((p) => p.kind === 'lamp').sort((a, b) => Math.hypot(a.x - s0.x, a.y + s0.z) - Math.hypot(b.x - s0.x, b.y + s0.z))[0];
        const ix = Math.cos(l.yaw), iz = -Math.sin(l.yaw), kx = -Math.sin(l.yaw), kz = -Math.cos(l.yaw);
        g.car.place(new V(l.x + ix * 0.6 + kx * 14, l.z + 0.6, -l.y + iz * 0.6 + kz * 14), Math.atan2(-kx, -kz), 20); g.input.hold = false;
        window.__target = l; return JSON.stringify({ lamp: [l.x, l.y] }); })()`);
      console.log('fall: kerb hit', r);
      for (let i = 0; i < 6; i++) { await sleep(400); console.log(`  +${(i + 1) * 0.4}s`, await after(0)); await shot(`f_kerb_${i}.png`); }
      const r2 = await evaluate(`(() => { const g = window.__game, sp = g.streetProps, s0 = ${spawn}, V = g.camera.position.constructor;
        g.core.repair(); g.damage.repair();
        const poles = []; sp.near(s0.x, -s0.z, 200, poles, []);
        const l = poles.filter((p) => p.kind === 'lamp' && !p.broken).sort((a, b) => Math.hypot(a.x - s0.x, a.y + s0.z) - Math.hypot(b.x - s0.x, b.y + s0.z))[0];
        const ix = Math.cos(l.yaw), iz = -Math.sin(l.yaw);
        // park the car in the street 4 m out from the lamp, side-on; knock the lamp down toward it
        g.car.place(new V(l.x + ix * 4.2, l.z + 0.6, -l.y + iz * 4.2), Math.atan2(-Math.sin(l.yaw), -Math.cos(l.yaw)), 0); g.input.hold = true;
        window.__target = l; window.__kj0 = g.damage.last?.totalKj ?? 0;
        setTimeout(() => sp.knockDown(l, -ix * 12, -iz * 12), 400);
        return JSON.stringify({ lamp: [l.x, l.y] }); })()`);
      console.log('fall: onto a parked car', r2);
      for (let i = 0; i < 6; i++) { await sleep(400); console.log(`  +${(i + 1) * 0.4}s`, await after(0)); await shot(`f_onto_${i}.png`); }
    }
    for (const [kind, kmh, name] of (process.env.FALL ? [] : [['lamp', 72, 'lamp_72'], ['lamp', 15, 'lamp_15'], ['tree', 50, 'tree_50'], ['hydrant', 45, 'hydrant_45'], ['signalR', 72, 'signal_72']])) {
      await evaluate(`(window.__game.core.repair(), window.__game.damage.repair(), 1)`);
      console.log(name, 'setup', await setup(kind, kmh));
      await sleep(250); await evaluate(`(window.__game.obstacles?.sync(0, window.__game.car.body.translation(), true), 1)`);
      console.log(name, '+0.6s', await after(600)); await shot(`p_${name}_a.png`);
      console.log(name, '+1.2s', await after(600)); await shot(`p_${name}_b.png`);
      console.log(name, '+2.5s', await after(1300)); await shot(`p_${name}_c.png`);
    }
  }
  if (scenario === 'follow') {
    // Ride along behind a rival (FOLLOW=<index>, default 0) for a race: the player car is placed 13 m behind it every frame,
    // so the camera and the city streaming follow the AI line through the corners. Screenshots every 2.5 s.
    const click = (q) => evaluate(`(() => { const e = document.querySelector('${q}'); if (!e) return 'MISSING ${q}'; e.click(); return 'ok'; })()`);
    for (let i = 0; i < 90 && (await evaluate(`window.__game.menu().tuning`)); i++) await sleep(500);
    await click('[data-act=play]'); await sleep(500); await click('[data-act=laps][data-v="1"]'); await click('[data-act=start-race]');
    await sleep(5500);
    await evaluate(`(() => { const g = window.__game, c = g.ai.cars[${Number(process.env.FOLLOW ?? 0)}];
      g.car.body.setEnabled(false);   // no physics: the body is just a camera anchor riding behind the rival
      const step = () => { if (g.state !== 'race') return; const f = c.pos.clone().set(0, 0, 1).applyQuaternion(c.quat); const p = c.pos.clone().addScaledVector(f, -13); p.y += 0.55;
        g.car.body.setTranslation(p, true); g.car.body.setRotation(c.quat, true); requestAnimationFrame(step); };
      requestAnimationFrame(step); return 1; })()`);
    for (let i = 0; i < Number(process.env.SHOTS ?? 16); i++) {
      await sleep(2500);
      console.log(`t+${((i + 1) * 2.5).toFixed(1)}s`, await evaluate(`JSON.stringify(window.__game.ai.cars.map((c) => Math.round(c.v * 3.6) + '@' + Math.round(c.s)))`),
        await evaluate(`(() => { const g = window.__game, c = g.ai.cars[${Number(process.env.FOLLOW ?? 0)}], t = g.car.body.translation();
          return JSON.stringify({ aiY: +c.pos.y.toFixed(2), rootY: +c.root.position.y.toFixed(2), groundTall: g.ai.ground(c.pos.x, c.pos.z, c.pos.y + 50, 100)?.toFixed(2), playerY: +t.y.toFixed(2),
            groundAtPlayer: g.ai.ground(t.x, t.z, t.y + 50, 100)?.toFixed(2) }); })()`));
      await shot(`f_${String(i).padStart(2, '0')}.png`);
    }
  }
  if (scenario === 'highspeed') {
    // Drive at high speed (full throttle + steering wiggle), then Esc -> Back to garage: do the wheels/lights survive? (MENU_CAR=<id>)
    const click = (q) => evaluate(`(() => { const e = document.querySelector('${q}'); if (!e) return 'MISSING ${q}'; e.click(); return 'ok'; })()`);
    const wheels = `(() => { const g = window.__game, m = g.visual.model, r = (o) => o ? [o.position.x, o.position.y, o.position.z, o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w].map((v) => +v.toFixed(3)) : null;
      return JSON.stringify({ car: g.sel.car, root: [g.visual.root.position.x, g.visual.root.position.y, g.visual.root.position.z].map((v) => +v.toFixed(2)), lightsOn: g.visual.lightsOn, broken: g.visual.lightsBroken,
        spots: g.visual.headlights.map((s) => [+s.intensity.toFixed(0), +s.position.x.toFixed(2), +s.position.y.toFixed(2), +s.position.z.toFixed(2)]),
        wheels: ['FL', 'FR', 'RL', 'RR'].map((k) => r(m.getObjectByName('wheel_' + k))), calipers: ['FL', 'RL'].map((k) => r(m.getObjectByName('caliper_' + k))) }); })()`;
    for (let i = 0; i < 90 && (await evaluate(`window.__game.menu().tuning`)); i++) await sleep(500);
    await click('[data-act=start]'); await sleep(1500);
    await click(`[data-act=car][data-v=${process.env.MENU_CAR ?? 'vela_gt'}]`); await sleep(2500);
    console.log('garage1', await evaluate(wheels)); await shot('h1_garage_before.png');
    await click('[data-act=go]'); await sleep(2500);
    await evaluate(`(window.__game.input.hold = false, 1)`);
    await key('keyDown', 'KeyW', 'w');
    if (process.env.STEER === '0') await sleep(9000);   // straight: no crash
    else for (let i = 0; i < 9; i++) { await key('keyDown', i % 2 ? 'KeyA' : 'KeyD', i % 2 ? 'a' : 'd'); await sleep(500); await key('keyUp', i % 2 ? 'KeyA' : 'KeyD', i % 2 ? 'a' : 'd'); await sleep(500); }
    console.log('speed ', JSON.stringify(await evaluate(info)));
    await shot('h2_driving.png');
    await evaluate(`(window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' })), 1)`); await sleep(600);
    await key('keyUp', 'KeyW', 'w');
    console.log('during', await evaluate(wheels));
    await click('[data-act=garage]'); await sleep(2500);
    console.log('garage2', await evaluate(wheels)); await shot('h3_garage_after.png');
    for (const [n, az, el, d] of [['side', 1.57, 0.1, 6], ['front', 3.14, 0.15, 6], ['rear', 0, 0.2, 6]]) {
      await evaluate(`(Object.assign(window.__game.orbit, { az: ${az}, el: ${el}, dist: ${d}, drag: true }), 1)`); await sleep(1200); await shot(`h4_${n}.png`);
    }
  }
  if (scenario === 'wheelmotion') {
    // Straight at speed: per-frame wheel node motion (hop = y range, swing = z range, steer = yaw) for each car (CAR=<id> via ?car=).
    await key('keyDown', 'KeyW', 'w');
    await sleep(Number(process.env.RUNUP ?? 8000));
    console.log('speed ', JSON.stringify(await evaluate(info)));
    const r = await evaluate(`new Promise((res) => { const g = window.__game, m = g.visual.model, names = ['FL', 'FR', 'RL', 'RR'], S = names.map(() => ({ y: [], z: [], x: [], spin: [] })); let n = 0;
      const f = () => { names.forEach((k, i) => { const o = m.getObjectByName('wheel_' + k); S[i].y.push(o.position.y); S[i].z.push(o.position.z); S[i].x.push(o.position.x);
        const e = new (o.quaternion.constructor)().copy(o.quaternion); S[i].spin.push(2 * Math.atan2(e.x, e.w)); });
        if (++n < 90) requestAnimationFrame(f); else res(JSON.stringify({ kmh: Math.round(Math.abs(g.car.out[102]) * 3.6), wheels: S.map((s, i) => ({ w: names[i],
          y: [Math.min(...s.y), Math.max(...s.y)].map((v) => +v.toFixed(3)), z: [Math.min(...s.z), Math.max(...s.z)].map((v) => +v.toFixed(3)), x: [Math.min(...s.x), Math.max(...s.x)].map((v) => +v.toFixed(3)),
          spinStep: +(s.spin.slice(1).map((v, j) => { let d = v - s.spin[j]; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; }).reduce((a, b) => a + b, 0) / (s.spin.length - 1)).toFixed(3) })) })); };
      requestAnimationFrame(f); })`);
    console.log('wheels', r);
    await key('keyUp', 'KeyW', 'w');
  }
  if (scenario === 'wheels') {
    // Garage views from the front, rear and side (run with ?menu=1): wheel / fender fit.
    const click = (q) => evaluate(`(() => { const e = document.querySelector('${q}'); if (e) e.click(); return 1; })()`);
    for (let i = 0; i < 90 && (await evaluate(`window.__game.menu().tuning`)); i++) await sleep(500);
    await click('[data-act=start]'); await sleep(800);
    await evaluate(`(document.getElementById('menu').style.display = 'none', 1)`);
    const views = [['front', Math.PI, 0.12, 5.5], ['rear', 0, 0.12, 5.5], ['side', Math.PI / 2, 0.05, 6.5], ['front34', 2.4, 0.18, 5.5]];
    for (const off of (process.env.OFFSETS ?? '').split(',').filter(Boolean)) {
      await evaluate(`(window.__game.visual.cfg.wheel_visual_offset_m = ${off}, 1)`);
      for (const [n, az, el, d] of views.slice(3)) { await evaluate(`(Object.assign(window.__game.orbit, { az: ${az}, el: ${el}, dist: ${d}, drag: true }), 1)`); await sleep(1200); await shot(`w_${n}_off${off}.png`); }
    }
    if (!process.env.OFFSETS) for (const [n, az, el, d] of views) {
      await evaluate(`(Object.assign(window.__game.orbit, { az: ${az}, el: ${el}, dist: ${d}, drag: true }), 1)`); await sleep(1500); await shot(`w_${n}.png`);
    }
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
      const S = window.__perf = { ft: [], gpu: [], cmp: [], calls: [], tris: [], cpu: [], on: false, pending: false, n: 0 };
      // CPU time of post.render() (JS: scene traversal + draw submission + uniform/buffer writes), per drawn frame
      const pr = g.post.render.bind(g.post); g.post.render = () => { const t0 = performance.now(); pr(); if (S.on) S.cpu.push(performance.now() - t0); };
      let p = performance.now();
      const f = (t) => { if (S.on) { S.ft.push(t - p); S.calls.push(r.info.render.drawCalls); S.tris.push(r.info.render.triangles); S.n++;
          if (be.trackTimestamp && !S.pending) { S.pending = true;
            Promise.all([r.resolveTimestampsAsync('render'), r.resolveTimestampsAsync('compute')]).then(([a, c]) => { if (a) { S.gpu.push(a + (c || 0)); S.cmp.push(c || 0); } S.pending = false; }); } }
        p = t; requestAnimationFrame(f); };
      requestAnimationFrame(f); return be.trackTimestamp; })()`).then((t) => console.log('gpu timestamps', t));
    const stats = `(() => { const S = window.__perf, q = (a, p) => a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(1) : '-';
      const ft = S.ft.slice(3).sort((x, y) => x - y), gp = S.gpu.slice(3).sort((x, y) => x - y), cm = S.cmp.slice(3).sort((x, y) => x - y), c = S.calls.slice().sort((x, y) => x - y), tr = S.tris.slice().sort((x, y) => x - y);
      const cp = S.cpu.slice(3).sort((x, y) => x - y);
      const r = 'CPU render() median ' + q(cp, 0.5) + ' p95 ' + q(cp, 0.95) + ' mean ' + (cp.reduce((a, b) => a + b, 0) / Math.max(1, cp.length)).toFixed(2) + ' ms (' + cp.length + ') | frames ' + ft.length + '  frame median ' + q(ft, 0.5) + ' p95 ' + q(ft, 0.95) + ' max ' + q(ft, 1) + ' ms | GPU median ' + q(gp, 0.5) + ' p95 ' + q(gp, 0.95) + ' ms (' + gp.length + ', compute ' + q(cm, 0.5) + ') | draws ' + q(c, 0.5) + ' tris ' + (+q(tr, 0.5) / 1000).toFixed(0) + 'k'
        + '  >100ms at s: ' + (() => { let t = 0; return S.ft.map((x) => { t += x; return x > 100 ? (t / 1000).toFixed(1) + '(' + Math.round(x) + ')' : ''; }).filter(Boolean).join(' '); })();
      S.cpu.length = S.ft.length = S.gpu.length = S.cmp.length = S.calls.length = S.tris.length = 0; return r; })()`;
    // main-thread cost from the DevTools Performance domain: ScriptDuration = JS, TaskDuration = all main-thread work (s)
    await send('Performance.enable');
    const pm = async () => Object.fromEntries((await send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
    const mainThread = async (m0, label) => { const m1 = await pm(); const n = await evaluate(`window.__perf.n`);
      console.log(label, 'main thread: script', ((m1.ScriptDuration - m0.ScriptDuration) * 1000).toFixed(0), 'ms, tasks', ((m1.TaskDuration - m0.TaskDuration) * 1000).toFixed(0), 'ms over', n, 'rAF frames'); };
    await evaluate(`(window.__perf.on = true, window.__perf.n = 0, 1)`);
    let m0 = await pm();
    await sleep(4000);
    console.log('parked', await evaluate(stats));
    await mainThread(m0, 'parked');
    await shot('perf_parked.png');
    await key('keyDown', 'KeyW', 'w');
    await evaluate(`(window.__perf.n = 0, 1)`); m0 = await pm();
    await sleep(6000);
    await mainThread(m0, 'drive ');
    console.log('drive ', await evaluate(stats), '|', (await evaluate(info)).kmh, 'km/h');
    await shot('perf_drive.png');
    await key('keyUp', 'KeyW', 'w');
    console.log('hud   ', (await evaluate(info)).perf);
    if (process.env.PERF_AFTER) console.log('perf_after', await evaluate(process.env.PERF_AFTER));
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
    // front three-quarter views of the wreck: crumpled nose, hanging bumper, flames and smoke (chase rig frozen)
    for (const [i, az] of [[3, 0.75], [4, -0.9], [5, 2.6]]) {
      await evaluate(`(() => { const g = window.__game; g.__rigUpdate ??= g.rig.update.bind(g.rig); g.rig.update = () => {};
        g.input.hold = true; g.car.body.setLinvel({ x: 0, y: 0, z: 0 }, true); g.car.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        const t = g.car.body.translation(), r = g.car.body.rotation(), V = g.camera.position.constructor, Q = g.camera.quaternion.constructor;
        const f = new V(0, 0, 1).applyQuaternion(new Q(r.x, r.y, r.z, r.w)); f.y = 0; f.normalize();
        const side = new V(-f.z, 0, f.x), d = f.clone().multiplyScalar(Math.cos(${az})).add(side.multiplyScalar(Math.sin(${az})));
        g.camera.position.set(t.x + d.x * 5.2, t.y + 1.3, t.z + d.z * 5.2); g.camera.lookAt(t.x + f.x * 0.8, t.y + 0.5, t.z + f.z * 0.8); return 1; })()`);
      await sleep(700); await shot(`dmg_${i}_view.png`);
    }
    await evaluate(`(() => { const g = window.__game; if (g.__rigUpdate) g.rig.update = g.__rigUpdate; return 1; })()`);
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
