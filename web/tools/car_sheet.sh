#!/usr/bin/env bash
# A contact sheet of one car in the garage: stock and three sets of parts, three views each. The check every car and
# every part design goes through (docs/adding_a_car.md): a part that floats or cuts into the body shows here at once.
#
#   web/tools/car_sheet.sh <car id> [base url] [out dir]
#     base url  a running game without login walls: the dev server (http://127.0.0.1:5173) or a production build
#               served from any static file server (default http://127.0.0.1:5180)
#     out dir   default /tmp/car_sheets
# Needs: google-chrome (headless, WebGPU), node, python3 with Pillow. Starts and stops its own browser (cdp.mjs).
set -euo pipefail
C="${1:?car id (see web/public/data/cars/catalog.json)}"; BASE="${2:-http://127.0.0.1:5180}"; OUT="${3:-/tmp/car_sheets}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cdp() { node "$HERE/cdp.mjs" "$@"; }   # a function, not a string: the repository path may contain spaces
mkdir -p "$OUT"
URL="$BASE/?menu=1&touch=0&quality=low&cap=0&user=sheet_test&car=$C"
cdp stop >/dev/null 2>&1 || true
cdp start "$URL" 1280x863 | tail -1
# every car owned (single-player career level), then load again with the car selected
cdp eval "localStorage.setItem('nr.sp.v1', JSON.stringify({ xp: 99999999 })); 'ok'" >/dev/null
cdp nav "$URL" | tail -1
cdp eval "(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), g = window.__game;
  if (document.querySelector('[data-act=uname-save]')) { const i = document.querySelector('#menu input'); i.focus(); i.value = 'sheet_test'; i.dispatchEvent(new Event('input', { bubbles: true })); await sleep(250); document.querySelector('[data-act=uname-save]').click(); await sleep(1500); }
  for (let i = 0; i < 60 && g.menu().tuning; i++) await sleep(500);
  if (g.menu().screen !== 'garage') { document.querySelector('[data-act=garage-open]')?.click(); await sleep(2500); }
  document.getElementById('menu').style.visibility = 'hidden';
  const shots = { f34: [0.8, 0.17, 6.5], r34: [2.45, 0.16, 6.4], side: [1.57, 0.08, 6.4], front: [0, 0.1, 6.0], rear: [3.14, 0.13, 6.0], top: [0.9, 0.6, 7.4], wheel: [1.25, 0.06, 3.7] };
  window.__view = async (n) => { const s = shots[n]; g.orbit.az = s[0]; g.orbit.el = s[1]; g.orbit.dist = s[2]; g.orbit.holdUntil = performance.now() + 120000; await sleep(600); return n; };
  window.__look = async (c) => { const cu = g.visual.custom; cu.apply({ ...cu.current, wing: 'stock', splitter: 'stock', diffuser: 'stock', skirt: 'stock', frontB: 'stock', rearB: 'stock', hood: 'stock', fenders: 'stock', rims: 'stock', underglow: '', ...c }); await sleep(250); return 'ok'; };
  return 'car ' + g.sel.car + ', in the garage: ' + g.inGarage;
})()" | tail -1
i=0
while IFS='|' read -r name views look; do
  cdp eval "__look($look)" >/dev/null
  j=0
  for v in $views; do cdp eval "__view('$v')" >/dev/null; cdp shot "$OUT/.${C}_${i}_${j}.png" >/dev/null; j=$((j+1)); done
  i=$((i+1))
done <<'LOOKS'
stock|f34 r34 side|{}
kit A: GT wing, deep splitter, quad-fin diffuser, blade skirt, wide flares, five-spoke rims|f34 rear side|{ wing: 'gt-01', splitter: 'splitter-deep-02', diffuser: 'diffuser-fins4-12', skirt: 'skirt-blade-21', fenders: 'fender-wide', rims: 'five-classic' }
kit B: swan wing, time-attack splitter, max diffuser, step skirt, extreme flares, GT bumpers, vented hood, mesh rims|front r34 wheel|{ wing: 'swan-02', splitter: 'splitter-aggr-10', diffuser: 'diffuser-max-17', skirt: 'skirt-step-22', fenders: 'fender-extreme', frontB: 'front-gt', rearB: 'rear-gt', hood: 'hood-vented', rims: 'mesh-16' }
panels: duck wing, wide front and rear bumpers, power-dome hood, dish rims|f34 r34 top|{ wing: 'duck-02', frontB: 'front-shell-wide', rearB: 'rear-shell-wide', hood: 'hood-power', rims: 'dish-deep' }
LOOKS
cdp stop >/dev/null
python3 - "$OUT" "$C" <<'PY'
import sys
from PIL import Image, ImageDraw
out, car = sys.argv[1], sys.argv[2]
names = ['stock', 'kit A', 'kit B', 'panels']
W, H = 640, 400
sheet = Image.new('RGB', (W * 3, H * 4), 'black'); d = ImageDraw.Draw(sheet)
for i in range(4):
    for j in range(3):
        im = Image.open(f'{out}/.{car}_{i}_{j}.png').convert('RGB')
        w, h = im.size
        sheet.paste(im.crop((int(w * 0.12), int(h * 0.2), int(w * 0.88), int(h * 0.2) + int(w * 0.76 * H / W))).resize((W, H)), (j * W, i * H))
    d.text((6, i * H + 4), names[i], fill=(255, 255, 0))
sheet.save(f'{out}/{car}.png')
print(f'{out}/{car}.png')
PY
rm -f "$OUT"/."${C}"_*.png
