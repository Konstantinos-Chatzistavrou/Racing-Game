# Project memory: Open Grid (handoff for a new session)

Facts below were read from the repo on 2026-11-10. Update this file when behaviour changes; it is the committed
memory a fresh session should read first. Deeper detail lives in the linked docs.

## 1. How to run and test

```sh
cd web && npm install
npm run dev -- --port 5173 --strictPort          # background
HEADLESS=1 node tools/drive.mjs "<url>" <outdir> <scenario>
```

- **Harness**: `web/tools/drive.mjs` drives system Chrome over CDP with WebGPU flags. `HEADLESS=1` = no window
  (a hidden window stops rAF). Env: `MOBILE=1`, `CPU_THROTTLE=N`, `WIN=1280,800`, `CDP_PORT=9334`,
  `USER_NAME=drive_test` (a name so the first-start card does not block the title), `SETTLE=ms`,
  `PROBE=file.js`.
- **Scenarios** (from the usage line and the code): `straight crash mobile bench profile night menu race6
  raceperf social follow dnf poles walls devices`, plus `garage2 stalls resize careers assists wallperf`.
  `menu` walks title → garage → modes → race and screenshots each step; `raceperf` measures race CPU.
- **PROBE**: page JS evaluated after load. Set `window.__shotNow = 'name'` to capture `<name>.png` in the outdir
  (the probe is polled every 150 ms); a final `probe.png` is always saved.
- **Page API**: `window.__game` = `{ car, core, scene, renderer, camera, post, ai, input, visual, nyc, damage,
  audio, rig, heat, cops, menu(), stats(), texStats(), setHeat(), THREE }`.
- **URL params** (in `web/src/main.ts`): `?menu=0` skips the front end; `?cap=N` frame cap (default 30 on touch,
  0 = uncapped on desktop); `?quality=max|ultra|high|medium|low|potato` (potato = boot mode for weak phones, docs/performance.md); `?scale=0..1`; `?touch=1|0` force the phone
  path; `?gate=1` forces the click-for-fullscreen gate (`0` skips it; automation skips it by default);
  `?look=natural|underground|heat` grade (fx/grade.ts); `?probe=N` car-reflection-probe face interval (0 off);
  `?far=N` far-ring metres (default 1000, phones 560); `?target=N` auto-tuner fps target (default 30);
  `?user=NAME` test username.
- Online service (separate): `cd cloud && npm run dev` (wrangler + local D1 on 8787); `npm test` (17 players,
  two real races, ~2 min), `npm run test:social`, `npm run test:looks`-equivalent `test/looks.mjs`.

## 2. Performance rules (all measured; tables in `docs/performance.md`)

- **Target: 30 fps locked** on the i3-1315U / Intel UHD / 8 GB laptop ≈ **33.3 ms** per frame. Phone default
  preset is `medium`; desktop runs uncapped but the tuner protects 30.
- **The frame is draw-call bound, not fill bound** (at 1280x657): ~206-267 draws, 1.0-1.9 M triangles. City
  batching took **261 → 208 draws, render CPU 17.9 → 13.5 ms, fps 48.6 → 55.2** at the pinned camera.
- **Auto-tuner**: protects the cap (median of the last 3 p50s AND the window mean fps), lowers resolution
  before effects, warms only when the city is settled. Fresh profile lands **ultra, 90 % resolution, p50
  30-31 ms, 29.7-32.9 fps**. `?target=` overrides the target; `?quality`/`?scale` pin.
- **Phones**: far ring stops at **560 m** (`farLoad: num('far', isTouch ? 560 : 1000)`) — 195 → 161 draws,
  CPU 37.8 → 26.1 ms, 24.8 → **30.2 fps** at low under a 4x CPU throttle. The car reflection probe is **off on
  phones** (`probeEvery = isTouch ? 0 : 4`), **128 px** faces on desktop.
- **Remote players cost ~30 draws / 29k tris / ~0.9 ms each**; a 6-player party is +73 % draws, so the party cap
  is 6 (P2P host topology too).
- HUD perf line: `30 fps (cap 30) · 33 ms · p95 41 · 267 calls · 35 MB tex`; `stats()`/`texStats()` expose it.
- `GFX_SCALE` = max/ultra/high 1.0, medium 0.85, low 0.7.

## 3. Garage and customisation

**Data** (`web/src/custom-data.ts`): `Custom` = livery, liveryColor, wing, aero (finish), rimColor, rimFinish,
caliper, headlights, smokedTails, underglow, tint, exhaust, splitter, diffuser, skirt, frontB, rearB, hood,
fenders, rims. `cleanCustom()` validates every field against its map; **the cloud worker imports this file**, so
it must not import three.js (display names live in `web/src/parts-names.ts`).

| map | contents |
|---|---|
| `WINGS` | stock, none + 30 generated (`wings.ts`) |
| `SPLITTERS`/`DIFFUSERS`/`SKIRTS` | stock + 10 each (`aero.ts`, ids `splitter-*`, `diffuser-*`, `skirt-*`) |
| `FRONT_BUMPERS` | stock, `front-shell-wide`, `front-shell-track` + 6 generated |
| `REAR_BUMPERS` | stock, `rear-shell-wide`, `rear-shell-deep` + 6 generated |
| `HOODS` | stock, `hood-fit-smooth/bulge/vent/carbon` + 6 generated |
| `FENDERS` | stock + 6 (arch lips) |
| `RIMS` | factory + 30 (`rims.ts`) |

`body.ts` exports 24 panel specs (6 front, 6 rear, 6 hood, 6 fender `BodySpec` ids); fender specs are not built
— flares are half-torus arch lips in custom.ts.

**How parts are built and swapped** (`web/src/scene/custom.ts`): every generated part is built once against the
car's model-space boxes at construction and hidden until selected. A selected part **hides the stock part**:
`stockWing`, the `splitter` node, `skirt_L/R`, `rimMeshes` (materials named `rim*`), `bumper_front`,
`bumper_rear`, `hood`. Rims are parented to `wheel_FL / FR / RL / RR` (wheel axle = x; the rim builder's axle =
z, rotated ±90°). Generated bumper specs keep only their add-on meshes (lip/fins/canards); the full shell is
dropped because it cannot follow the real contour. **Fitted parts** are clones of the stock panel deformed in
place: `front-shell-wide/track`, `rear-shell-wide/deep`, `hood-fit-*` (bulge, vent recess, carbon, smooth).
`setShells(wide, track)` swaps Blender-authored front GLBs over the derived ones (derived pair = fallback).

**Effects are measured, not guessed**: `web/scripts/metrics.mjs` builds every spec in Node, measures bbox
planform/frontal/volume and writes `web/src/parts-metrics.ts` (108 entries, 545 lines); `partEffect(id)` in
`garage.ts` is the only lookup used by chip tooltips and the live telemetry panel. Re-run the script after
changing geometry.

**Audit rule (non-negotiable)**: every part/car is screenshotted before shipping with
`web/tools/parts-probe.js`:
```sh
HEADLESS=1 PROBE=tools/parts-probe.js node tools/drive.mjs "http://127.0.0.1:5173/?menu=1&touch=0" /tmp/parts menu
```
It clicks Body/Aero/Wheels part chips, moves the camera and saves one PNG per part. Its hood sample ids
(`hood-vented`, `hood-track`) are stale — current hood ids are `hood-fit-*`/`hood-smooth` etc.; update the list
when auditing hoods.

**Blender pipeline** (`docs/blender_pipeline.md`): the car GLB is meshopt + KTX2/basisu and Blender rejects
`KHR_texture_basisu`. Decode first:
```sh
cd web && npm i basis_universal
node scripts/decode-ktx2.cjs public/assets/cars/v3/vela_gt_hero.glb /tmp/vela_png.glb
```
`web/scripts/decode-ktx2.cjs` extracts every image, runs `basisu -unpack` (it writes PNGs into its **cwd**, not
`-output_path`), takes mip 0, appends it to the BIN chunk, repoints image views and drops basisu (verified 12/12
textures, Blender 5.2 at `~/opt/blender-5.2.3-linux-x64` imports 60 meshes + 12 images).

Model space: **+x left, +y up, +z front** (headlights z≈+2.0); wheels `wheel_FL/FR` z=+1.18, `wheel_RL/RR`
z=-1.47. Mesh names available for authoring: `bumper_front(.001)`, `bumper_front_lower`, `bumper_rear(.001)`,
`bumper_rear_lower`, `hood`, `hood_inner`, `hood_vent`, `skirt_L/R`, `body_lower`, `diffuser_fin_*`.
Blender space is `x` width, `y` front/back (front = −y), `z` up; clear materials before export
(`o.data.materials.clear()`) so no textures are embedded, then `export_scene.gltf(..., use_selection=True,
export_apply=True)`. Authored assets in `web/public/assets/cars/v3/`: `vela_front_wide.glb`,
`vela_front_track.glb` (wired via `setShells`), `vela_hood_dome.glb`, `vela_hood_vent.glb` (**not wired**:
no `setHoods` exists; the fitted `hood-fit-*` clones are used instead).

## 4. Cameras

- **Driving** (`web/src/camera.ts`): `chase · far · cinematic · drift · hood · bumper · orbit`. `C` cycles;
  Settings → Camera; persisted in `localStorage 'nr.cam'`.
  - `drift`: heading follows the velocity direction above 3 m/s, so the car hangs its tail out.
  - `orbit`: showcase pan 0.18 rad/s with wall pull-in.
- **Garage** `cam(az, el, dist)` — **az = 0 is the FRONT** (verified by screenshot), π/2 = driver's (left) side,
  π = behind. Presets: 3/4 `0.8,0.17,6.5` · F 3/4 `-0.75,0.16,6.2` · Front `0,0.14,6.0` · Side
  `1.57,0.08,6.4` · R 3/4 `2.45,0.16,6.2` · Rear `3.14,0.15,6.0` · Low `1.57,0.03,5.0` · Nose
  `0,0.05,4.2` · Wheel `1.5,0.05,3.4` · Top `0.9,0.55,6.8` · **Orbit** (starts the turntable).
  Pointer drag orbits, wheel zooms; the turntable resumes after `orbit.holdUntil`.

## 5. Other systems already in place

- **Heat/cops** (`docs/design/heat-and-cops.md`): 0-5 heat dial in the HUD and title, +1 per finished race and
  per heavy impact (max one per 20 s), cools 90/75/60/45/30 s by level, persisted. Cops spawn only in a real race
  at 3+ heat (2 s in), hold a 6 m tail; escape by line of sight (3.5 s unseen) or a 140 m gap for 4 s; bust =
  fine -150 XP + heat reset; Lay low on the title costs 300 XP; finishing at 4/5 heat pays ×1.5/×1.8.
- **Multiplayer/anti-cheat** (`docs/design/multiplayer-anti-cheat.md`): party is PeerJS P2P, max 6, host relays;
  the Cloudflare Durable Object times ranked races from 4 Hz positions. Ranked needs 6+ accounts, max 2 per
  network. Pace floor: average > 1.25× top speed = impossible (violation), > 0.72× = review flag (top 3 only,
  no penalty). Cloudflare free tier: 100k DO req/day incl. WS (20:1), 13k GB-s/day; paid $5/mo ≈ 62 room-hours at
  15 Hz, ~$0.008/room-hour.
- **Visuals**: studio softbox PMREM for the car on menu screens (`scene/studio.ts`, applied by `showroomEnv()`),
  night-city probe while driving; clearcoat 1.0/0.018 + flake + orange peel in `scene/car.ts`; contact shadow and
  wheel animation already exist.
- **Launch control**: hold throttle on the grid → `LAUNCH READY`; at GO throttle ramps 0.55 → 1.0 over 1.1 s.
  **Tire smoke**: `Particles` at the rear contact patches on slip ratio > 0.32, grey, opacity 0.15, every 3rd tick.

## 6. Known bugs / next steps

- **Parts still look placeholder-grade**; procedural boxes cannot match authored bodywork. The asset track is the
  fix, and the parts audit (above) is the gate.
- **Hoods**: fitted `hood-fit-*` clones reshape the model's own hood (should seat); the generated hood specs and
  the authored `vela_hood_*.glb` are not audited yet and `setHoods` is not implemented. Earlier a floating hood
  slab appeared — verify each hood with the audit before enabling more.
- **Bumpers**: generated kits are add-on pieces over the stock bumper; true replacements are the fitted shells
  (front ×2 derived + 2 Blender GLBs, rear ×2 derived).
- **Title screen**: career cards were narrowed so the car sits beside the menu; framing still needs a design pass.
- **Reference comparison with NFS Heat is not done**: page fetches return text-only; use direct image URLs from
  public press kits or files dropped into the repo.
- **Cars**: only the existing catalog cars. Adding one needs a physics JSON (`web/public/data/cars/<id>.json`),
  a visual config (`<id>.visual.json`: `wheel_nodes`, `paint_material`, `lod_model`, `collision_box`), catalog
  stats/price and ladder hooks. Free sources: `docs/free_assets.md` (Khronos CarConcept is CC BY 4.0 and
  web-ready). No separable CC0 hood/bumper meshes were found; deriving from the car's own mesh is licence-clean.
- **Anti-cheat replay** re-simulation is blocked by determinism (same scripted drive diverges ~1.3 m in 15 s).
- Parts `parts-probe.js` hood sample ids are stale (see above).

## 7. Where things are

| path | what |
|---|---|
| `web/src/main.ts` | boot, state machine, frame loop, tuner, launch/smoke, showroom env, GLB loading |
| `web/src/camera.ts` | driving rig and its seven modes |
| `web/src/menu.ts` | DOM screens: title, garage tabs, shop, settings, lobby |
| `web/src/garage.ts` | catalog, mods, stats, part effects (`partEffect`), look presets |
| `web/src/custom-data.ts` | `Custom` type, option maps, defaults and validation (cloud-safe, no three) |
| `web/src/scene/custom.ts` | builds/attaches every part, swaps stock parts, fitted shells and hoods |
| `web/src/scene/parts/{wings,aero,rims,body}.ts` | generated part catalogs (30/30/30/24) |
| `web/src/parts-names.ts` / `parts-metrics.ts` | display names (cloud-safe) / measured effects |
| `web/src/scene/studio.ts` | softbox PMREM for the showroom |
| `web/src/post.ts`, `fx/grade.ts` | presets, bloom/SSR, `?look=` grades |
| `web/tools/drive.mjs` | headless harness (CDP, screenshots, scenarios) |
| `web/tools/parts-probe.js` | part audit (screenshot every part) |
| `web/scripts/decode-ktx2.cjs` / `metrics.mjs` | KTX2→PNG GLB rebuild / measured part effects |
| `cloud/` | Cloudflare Worker + D1 + Durable Object race room; `cloud/README.md` |
| `docs/` | performance.md, art_direction.md, garage.md, blender_pipeline.md, roadmap.md, design/ |
