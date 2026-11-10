// Part audit probe: selects a sample of body/aero/rim parts and screenshots each one.
// Run: HEADLESS=1 PROBE=web/tools/parts-probe.js node web/tools/drive.mjs "<url>?menu=1&touch=0" /tmp/parts menu
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 60000) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(400); } return null; };
  const btn = await waitFor(() => { const b = document.querySelector('[data-act="garage-open"]'); return b && !b.disabled ? b : null; });
  btn?.click(); await sleep(2000);
  const tab = async (t) => { const x = await waitFor(() => document.querySelector('[data-act="gtab"][data-v="' + t + '"]'), 15000); x?.click(); await sleep(700); };
  const cam = async (v) => { document.querySelector('[data-act="cam"][data-v="' + v + '"]')?.click(); await sleep(1100); };
  const shots = [];
  const shoot = async (name) => { window.__shotNow = name; await sleep(700); shots.push(name); };
  await tab('body');
  for (const v of ['front-shell-wide', 'front-gt', 'front-intake', 'rear-gt']) { const c = document.querySelector('[data-act="cu"][data-k="' + (v.startsWith('rear') ? 'rearB' : 'frontB') + '"][data-v="' + v + '"]'); c?.click(); await sleep(800); await cam(v.startsWith('rear') ? '3.14,0.15,6.0' : '0,0.14,6.0'); await shoot('body-' + v); }
  for (const v of ['hood-vented', 'hood-track']) { document.querySelector('[data-act="cu"][data-k="hood"][data-v="' + v + '"]')?.click(); await sleep(800); await cam('0.35,0.05,4.2'); await shoot('body-' + v); }
  await tab('aero');
  for (const v of ['splitter-deep-02', 'diffuser-strakes-15']) { document.querySelector('[data-act="cu"][data-k="' + (v.startsWith('diffuser') ? 'diffuser' : 'splitter') + '"][data-v="' + v + '"]')?.click(); await sleep(800); await cam('0.35,0.05,4.2'); await shoot('aero-' + v); }
  await tab('wheels');
  for (const v of ['five-split', 'mesh-16']) { document.querySelector('[data-act="cu"][data-k="rims"][data-v="' + v + '"]')?.click(); await sleep(800); await cam('1.57,0.08,6.4'); await shoot('rim-' + v); }
  return { shots };
})()