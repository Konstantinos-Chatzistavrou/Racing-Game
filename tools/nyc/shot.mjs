// Screenshots of web/nyc_ground_test.html views through headless Chrome + WebGPU (CDP). Usage:
//   CDP_PORT=9406 node tools/nyc/shot.mjs outdir name1="x=0&y=0&yaw=30" name2="x=300&y=1130&h=40&pitch=45" ...   (dev server: cd web && npx vite --port 5206)
// Wrap in: flock /tmp/racing-gpu.lock
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.env.BASE ?? 'http://127.0.0.1:5206/nyc_ground_test.html';
const out = process.argv[2];
const views = process.argv.slice(3).map((a) => { const i = a.indexOf('='); return [a.slice(0, i), a.slice(i + 1)]; });
fs.mkdirSync(out, { recursive: true });
const port = Number(process.env.CDP_PORT ?? 9406);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-ground-'));
const chrome = spawn('google-chrome', [
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--enable-unsafe-webgpu', '--enable-features=Vulkan', `--window-size=${process.env.WIN ?? '1280,800'}`,
  '--headless=new', '--use-angle=vulkan', '--ignore-gpu-blocklist', 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, seq = 0;
const pending = new Map();
const send = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => pending.set(id, { res, rej })); };
const evaluate = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); return r.result.value; };
try {
  let target;
  for (let i = 0; i < 40 && !target; i++) { await sleep(250); try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch {} }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.method === 'Runtime.consoleAPICalled' && /error|warning/.test(d.params.type)) console.log(`[page ${d.params.type}]`, d.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 500));
    if (d.method === 'Runtime.exceptionThrown') console.log('[page exception]', (d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text).slice(0, 600));
    if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result); }
  };
  await send('Page.enable'); await send('Runtime.enable');
  for (const [name, qs] of views) {
    await send('Page.navigate', { url: `${base}?${qs}` });
    let r = null;
    for (let i = 0; i < 120 && !r; i++) { await sleep(500); r = await evaluate('window.__ready ?? null').catch(() => null); }
    console.log(name, JSON.stringify(r), await evaluate("document.getElementById('msg').textContent").catch(() => ''));
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(s.data, 'base64'));
  }
} finally { try { ws?.close(); } catch {} chrome.kill(); }
process.exit(0);
