// A persistent headless Chrome (WebGPU) for fast iteration: start it once, then evaluate / screenshot / reload from
// separate short commands instead of paying the game's load time on every test (drive.mjs starts a new browser each run).
//
//   node tools/cdp.mjs start "http://127.0.0.1:5173/?menu=1&touch=0" [1920x1080]   start + load (waits until ready)
//   node tools/cdp.mjs eval "window.__game.state"                                    evaluate an expression (promises awaited)
//   node tools/cdp.mjs file path/to/probe.js                                         evaluate a file
//   node tools/cdp.mjs shot out.png                                                  screenshot
//   node tools/cdp.mjs nav "<url>" | reload                                          navigate / reload, wait until ready
//   node tools/cdp.mjs stop                                                          close the browser
//
// One game at a time (CDP_PORT, default 9344). No window is shown. Stop it when done: it renders the whole time.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.env.CDP_PORT ?? 9344);
const [cmd, arg, arg2] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stateFile = path.join(os.tmpdir(), `cdp-game-${port}.json`);

async function connect() {
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch { /* not up yet */ }
    if (!target) await sleep(250);
  }
  if (!target) throw new Error(`no browser on port ${port}: run "start" first`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.method === 'Runtime.exceptionThrown') console.log('[page exception]', (d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text).slice(0, 800));
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') console.log('[page error]', d.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 500));
    if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result); }
  };
  const send = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => pending.set(id, { res, rej })); };
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval error');
    return r.result.value;
  };
  return { ws, send, evaluate };
}

async function waitReady(c, ms = 180000) {
  const t0 = Date.now();
  await sleep(1500);
  while (Date.now() - t0 < ms) {
    const s = await c.evaluate(`(() => { const l = document.getElementById('loading'); return !window.__game ? 'boot' : l ? 'loading' : 'ready'; })()`).catch(() => 'nav');
    if (s === 'ready') return true;
    await sleep(500);
  }
  return false;
}

if (cmd === 'start') {
  const [w, h] = (arg2 ?? '1920x1080').split('x').map(Number);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-webgpu-'));
  const chrome = spawn('google-chrome', [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--enable-unsafe-webgpu', '--enable-features=Vulkan', `--window-size=${w},${h}`,
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
    '--headless=new', '--use-angle=vulkan', '--ignore-gpu-blocklist', 'about:blank',
  ], { stdio: 'ignore', detached: true });
  chrome.unref();
  fs.writeFileSync(stateFile, JSON.stringify({ pid: chrome.pid, profile }));
  const c = await connect();
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await c.send('Page.navigate', { url: arg ?? 'http://127.0.0.1:5173/?menu=1&touch=0' });
  console.log((await waitReady(c)) ? 'ready' : 'TIMEOUT waiting for the game');
  c.ws.close();
} else if (cmd === 'stop') {
  try { const s = JSON.parse(fs.readFileSync(stateFile, 'utf8')); process.kill(-s.pid); } catch { /* already gone */ }
  spawnSync('pkill', ['-f', '--', `--remote-debugging-port=${port}`]);
  try { fs.unlinkSync(stateFile); } catch { /* none */ }
  console.log('stopped');
} else {
  const c = await connect();
  await c.send('Runtime.enable');
  try {
    if (cmd === 'eval') console.log(await c.evaluate(arg));
    else if (cmd === 'file') console.log(await c.evaluate(fs.readFileSync(arg, 'utf8')));
    else if (cmd === 'shot') { const r = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(arg, Buffer.from(r.data, 'base64')); console.log('saved', arg); }
    else if (cmd === 'nav') { await c.send('Page.enable'); await c.send('Page.navigate', { url: arg }); console.log((await waitReady(c)) ? 'ready' : 'TIMEOUT'); }
    else if (cmd === 'reload') { await c.send('Page.enable'); await c.send('Page.reload'); console.log((await waitReady(c)) ? 'ready' : 'TIMEOUT'); }
    else console.log('commands: start | eval | file | shot | nav | reload | stop');
  } finally { c.ws.close(); }
}
