// Built-in benchmark (title menu: Benchmark / Soak test, or window.__game.bench()). Drives the car along the city route at a fixed
// speed (placed each frame: same camera path, same streaming and LOD load every run, no physics noise) through each quality preset,
// uncapped (what the device CAN do: headroom) then at the frame cap (does the lock HOLD: late frames), and recommends the best preset.
// The soak mode repeats the capped run for minutes and reports fps per window: phones throttle after a few minutes, a 30 s test lies.
// Results show on screen (also copyable as JSON) so a phone needs no cable: open the deployed game, run it, send the numbers.
// The loop integration lives in main.ts (it owns the car, camera and renderer); this file is stats, the refresh-rate/cap choice and DOM.

/** Display refresh rate in Hz (median rAF interval over `ms`), snapped to common rates. */
export function measureRefresh(ms = 500): Promise<number> {
  return new Promise((resolve) => {
    const t: number[] = [];
    const f = (now: number) => {
      t.push(now);
      if (now - t[0] < ms || t.length < 8) return void requestAnimationFrame(f);
      const d = t.slice(1).map((x, i) => x - t[i]).sort((a, b) => a - b);
      const hz = 1000 / d[Math.floor(d.length / 2)];
      const common = [30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 240];
      resolve(common.reduce((b, c) => (Math.abs(c - hz) < Math.abs(b - hz) ? c : b)));
    };
    requestAnimationFrame(f);
  });
}

/**
 * The highest frame rate <= target that divides the refresh rate evenly (every Nth refresh): perfectly even frame pacing.
 * 60 Hz -> 30, 90 -> 45, 120 -> 40 (45 would alternate 33/50 ms: judder), 144 -> 28.8 (target 30).
 */
export function autoCap(hz: number, target: number): number {
  let best = hz;
  for (let n = 1; n <= 8; n++) if (hz / n <= target * 1.02) { best = hz / n; break; }
  return Math.round(best * 100) / 100;
}

export interface Stats { frames: number; fps: number; p50: number; p95: number; p99: number; worst: number; late: number; gpuMed: number; gpuP95: number; jsMs: number }
const pct = (a: number[], p: number) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0);

/** Frame intervals (ms between drawn frames), main-thread callback times and GPU times -> numbers. late = share of intervals > 1.5x the cap interval. */
export function stats(stamps: number[], cb: number[], gpu: number[], capMs: number): Stats {
  const iv = stamps.slice(1).map((x, i) => x - stamps[i]);
  const dur = stamps.length > 1 ? stamps[stamps.length - 1] - stamps[0] : 1;
  const s = iv.slice().sort((a, b) => a - b), g = gpu.slice().sort((a, b) => a - b);
  return {
    frames: stamps.length, fps: (iv.length * 1000) / dur,
    p50: pct(s, 0.5), p95: pct(s, 0.95), p99: pct(s, 0.99), worst: s[s.length - 1] ?? 0,
    late: capMs > 0 ? iv.filter((x) => x > capMs * 1.5).length / Math.max(1, iv.length) : 0,
    gpuMed: pct(g, 0.5), gpuP95: pct(g, 0.95), jsMs: cb.length ? cb.reduce((a, b) => a + b, 0) / cb.length : 0,
  };
}

export interface PhaseResult { preset: string; open: Stats; capped: Stats }
export interface SoakWindow { t: number; fps: number; late: number; p99: number }
export interface BenchReport {
  when: string; ua: string; screen: number[]; dpr: number; hz: number; cap: number; scale: number; gpu: string; timestamps: boolean;
  phases: PhaseResult[]; recommended: string; soak?: { preset: string; windows: SoakWindow[] };
}

/** Best preset (list is best -> cheapest) that has headroom uncapped AND holds the cap: <= 3 % late frames, p99 under 2.2 intervals. */
export function recommend(phases: PhaseResult[], cap: number): string {
  const capMs = 1000 / cap;
  for (const p of phases) if (p.open.fps >= cap * 1.1 && p.capped.late <= 0.03 && p.capped.p99 <= capMs * 2.2) return p.preset;
  return phases[phases.length - 1]?.preset ?? 'low';
}

// ---- DOM ---------------------------------------------------------------------------------------------------------------
const CSS = `#bench{position:fixed;inset:0;z-index:30;display:grid;place-items:center;pointer-events:none;font:13px/1.4 ui-monospace,monospace;color:#f4f1ea}
#bench .card{pointer-events:auto;background:#0b0f17ee;border:1px solid #ffffff2a;border-radius:12px;padding:14px 16px;max-width:min(94vw,640px);max-height:92vh;overflow:auto;backdrop-filter:blur(8px)}
#bench h3{margin:0 0 8px;font:600 14px system-ui,sans-serif;letter-spacing:.08em}#bench table{border-collapse:collapse;width:100%;margin:8px 0}
#bench td,#bench th{padding:3px 8px;text-align:right;border-bottom:1px solid #ffffff14}#bench td:first-child,#bench th:first-child{text-align:left}
#bench .ok{color:#7dffb0}#bench .bad{color:#ff6b81}#bench .row{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
#bench button{font:inherit;color:inherit;background:#ffffff14;border:1px solid #ffffff44;border-radius:8px;padding:8px 14px;cursor:pointer}
#bench button.primary{background:#ff3b5c;border-color:#ff3b5c;font-weight:700}#bench .dim{color:#9aa3ad}`;
let el: HTMLElement | null = null;
function root() {
  if (!el) {
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    el = document.createElement('div'); el.id = 'bench'; document.body.appendChild(el);
  }
  return el;
}
export function benchProgress(text: string) { root().innerHTML = `<div class="card"><h3>BENCHMARK</h3><div>${text}</div><div class="dim">keep this tab in front; the screen must stay on</div></div>`; }
export function benchClose() { if (el) el.innerHTML = ''; }

const f1 = (x: number) => x.toFixed(1);
const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);   // the GPU name comes from the device
export function benchResults(r: BenchReport, apply: (preset: string) => void) {
  const rows = r.phases.map((p) => {
    const holds = p.open.fps >= r.cap * 1.1 && p.capped.late <= 0.03;
    return `<tr><td>${p.preset}${p.preset === r.recommended ? ' ★' : ''}</td><td>${f1(p.open.fps)}</td><td>${f1(p.capped.fps)}</td><td class="${p.capped.late <= 0.03 ? 'ok' : 'bad'}">${(p.capped.late * 100).toFixed(1)}%</td>`
      + `<td>${f1(p.capped.p99)}</td><td>${p.open.gpuMed ? f1(p.open.gpuMed) : '-'}</td><td>${f1(p.open.jsMs)}</td><td class="${holds ? 'ok' : 'bad'}">${holds ? 'holds' : 'no'}</td></tr>`;
  }).join('');
  const soak = r.soak
    ? `<h3>SOAK (${r.soak.preset}, ${r.soak.windows.length} windows)</h3><div>fps per window: ${r.soak.windows.map((w) => f1(w.fps)).join(' ')}</div>`
      + `<div class="dim">late frames per window: ${r.soak.windows.map((w) => (w.late * 100).toFixed(0) + '%').join(' ')}</div>` : '';
  root().innerHTML = `<div class="card"><h3>BENCHMARK RESULT</h3>
    <div class="dim">${r.screen[0]}x${r.screen[1]} @${r.dpr}x · ${r.hz} Hz · cap ${r.cap} fps · scale ${r.scale} · ${esc(r.gpu)}${r.timestamps ? '' : ' · no GPU timestamps'}</div>
    <table><tr><th>preset</th><th>fps open</th><th>fps cap</th><th>late</th><th>p99 ms</th><th>GPU ms</th><th>JS ms</th><th></th></tr>${rows}</table>
    <div>Recommended: <b>${r.recommended}</b> <span class="dim">(best preset with headroom that holds the cap)</span></div>${soak}
    <div class="row"><button class="primary" data-b="apply">Use ${r.recommended}</button><button data-b="copy">Copy results</button><button data-b="close">Close</button></div></div>`;
  root().onclick = (e) => {
    const b = (e.target as HTMLElement).closest('[data-b]') as HTMLElement | null;
    if (!b) return;
    if (b.dataset.b === 'apply') { apply(r.recommended); benchClose(); }
    else if (b.dataset.b === 'close') benchClose();
    else if (b.dataset.b === 'copy') {
      const text = JSON.stringify(r);
      const done = () => { b.textContent = 'Copied'; };
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done)); else fallbackCopy(text, done);
    }
  };
}
function fallbackCopy(text: string, done: () => void) {
  const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select();
  try { document.execCommand('copy'); done(); } catch { /* manual select */ }
  t.remove();
}
