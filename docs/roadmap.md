# Next sessions: garage/cars roadmap (2026-11-10)

Written after the customisation push. Read `docs/garage.md` for what exists and
`docs/blender_pipeline.md` for the asset pipeline. Do the steps in order.

## 1. Fix part transforms + camera convention (in progress)

The audit probe (`web/tools/parts-probe.js`) is the acceptance test.

- **Camera convention is verified**: `cam(az, el, dist)` with **az = 0 = FRONT**, π/2 = left side, π = behind.
  Relabel any preset that disagrees; Front = `0,0.14,6.0`, Nose = `0,0.05,4.2`.
- **Hoods**: disabled because the skins float above/behind the car. The synthetic hood box in
  `custom.ts` does not match the real bonnet. Fix by measuring the actual `hood` node's bbox in model space and
  building against it, or by authoring a hood mesh in Blender. Re-enable only after the audit shows it seated.
- **Rear panels**: same treatment — verify the synthetic `pRear` box against the real `bumper_rear` bbox.
- **Bumper kits**: currently add-on pieces only (the generated shell is dropped). Two fitted shells
  (`front-shell-wide`, `front-shell-track`) are true replacements; do the same for the rear.
- Acceptance: each part screenshotted from Front/Side/Nose, no floating or clipping, no stock panel showing
  through.

## 2. Reference comparison with NFS Heat

- Page fetches return text-only; get screenshots via direct image URLs from public press kits (EA newsroom,
  publisher press sites) or drop files into `docs/reference/heat/`.
- Compare: framing (long lens, low angles), lighting (softbox key + rim), reflections (studio HDRI on the car
  only), material (clearcoat ribbons), UI density (garage panels at the edges, car centre stage).
- Keep a short checklist in `docs/reference/heat/compare.md` with what we match and what we do not.

## 3. Cars: two or three CC0/CC-BY models

- Source: start from `docs/free_assets.md` (Khronos CarConcept is CC BY 4.0 and web-ready). Verify the licence on
  the asset page the day it is downloaded; store the licence text/screenshot in `assets_source/licenses/`.
- For each car: physics JSON (`web/public/data/cars/<id>.json`) + visual config (`<id>.visual.json` with
  `wheel_nodes`, `paint_material`, `lod_model`, `collision_box`), catalog entry with stats and price, and the
  ladder/progression hooks.
- Run `scripts/decode-ktx2.cjs` if the model is KTX2; convert to the game's KTX2 pipeline with
  `assets_source/scripts/build_car3.sh` (see the skill) after authoring.
- Audit: garage screenshot per car (Front, 3/4, Side) + a drive test (`drive.mjs` straight/race).

## 4. Authored kits (after 1-3)

- Only once mounting is correct: model/kitbash bumpers, hoods and wide-body pieces in Blender on top of the
  decoded car, export, load via `setShells`-style hooks, audit each.
- Keep every part ≤ ~12 meshes; assign the game's paint/aero materials.

## Known bugs / open items

- Hood skins float (disabled), hood chips removed.
- Front/rear bumper kits are add-ons over the stock bumper.
- Procedural parts are placeholder quality; authored assets are the fix.
- Floating wing-shaped object seen earlier was the hood skin (root-caused; gone while hoods are disabled).
- NFS Heat screenshot comparison not started.
- Launch control and tire smoke are verified in motion; smoke tuned but can be retuned after seeing a full lap.

## Rules that keep this healthy

- **Screenshot every part and car** before shipping (parts-probe).
- Commit and push to `origin/main` after each piece; never leave the repo half-edited.
- No branded/copyrighted kits; CC0/CC-BY only, licences recorded.
- Performance: 30 fps locked on the i3/UHD laptop; the garage car is the hero asset, keep parts hidden until
  selected.
