# Garage, parts and asset pipeline (living memory)

Written 2026-11-10 so any later session can continue without rediscovering it. Code references are exact paths.

## Data model

- `web/src/custom-data.ts` - `Custom` (livery, liveryColor, wing, splitter, diffuser, skirt, frontB, rearB, hood,
  fenders, rims, aero finish, rimColor/rimFinish, caliper, headlights, smokedTails, underglow, tint, exhaust),
  option maps (`WINGS`, `SPLITTERS`, `DIFFUSERS`, `SKIRTS`, `FRONT_BUMPERS`, `REAR_BUMPERS`, `HOODS`, `FENDERS`,
  `RIMS`), `cleanCustom` (validates anything from storage/network) and `parts-names.ts` (ids/names only, no three.js,
  because the Cloudflare worker imports `cleanCustom`).
- `web/src/scene/custom.ts` (`CarCustomizer`) builds geometry once against the car, hides options until chosen, and
  applies choices as uniforms/visibility. `showOptional()` is the single place that decides what is visible.
- Garage UI: `web/src/menu.ts` (tabs `GTABS`: Paint, Body, Aero, Fenders, Wheels, Lights, Glass, Driver, Tune), live
  telemetry strip, hover previews (`hoverPart`), part hints; CSS tail of `web/src/style.css` holds the garage shell
  (Heat-style frame, compact breakpoint at `(pointer: coarse), (max-width: 1100px)`).

## Generated parts

| module | count | contract |
|---|---|---|
| `scene/parts/wings.ts` | 30 | `WingSpec.build({box, wb, mat})` |
| `scene/parts/aero.ts` | 30 | `AeroSpec.build({box, mat})`, kind splitter/diffuser/skirt |
| `scene/parts/rims.ts` | 30 | `RimSpec.build({radius, width, mat})`, axle +z |
| `scene/parts/body.ts` | 24 | `BodySpec.build({box, panel, mat})`, kind front/rear/hood/fender (fenders unused) |

- `web/scripts/metrics.mjs` builds every spec in Node and writes `web/src/parts-metrics.ts`
  (downforce/drag/mass from bbox areas/volumes). Re-run after changing any design: `cd web && node scripts/metrics.mjs`.
  `garage.ts` `partEffect(id)` reads it; fitted shells/hoods have authored values in `partEffect`.
- Visibility: wings/kits/body/rims each registered into maps on the customizer; stock part hidden when a non-stock
  option is picked (`stockWing`, `rimMeshes`, `stockPanels.splitter/skirt`, `bodyStock.front/rear/hood`).

## Fitting trick (the reliable one)

Generated boxes do not follow the car, so real panels are **cloned from the model's own nodes and reshaped**:
- node names in the GLB: `bumper_front`, `bumper_rear`, `hood`, `splitter`, `skirt_L/R`, `wheel_FL/FR/RL/RR`.
- `shellOf` / `fitOf` in `custom.ts`: `stock.clone(true)`, clone each mesh geometry, displace positions
  (widen x, push z), `computeVertexNormals()`, paint material, add to model, hide stock when selected.
- model space: **+x left, +y up, +z front**; rear = `min.z`; hood vent around `z ~ 1.2`.
- rims: parented to the wheel nodes, rim builder axle is +z so rotate `y = ±90°`, radius 0.34, width 0.22.
- fitted ids: `front-shell-wide/track`, `rear-shell-wide/deep`, `hood-fit-smooth/bulge/vent/carbon` (these are
  values in `FRONT_BUMPERS`/`REAR_BUMPERS`/`HOODS`). Blender-authored replacements `vela_front_wide/track.glb` are
  loaded in `main.ts` and swapped in via `CarCustomizer.setShells`; the derived clones stay as fallback.

## Cameras

- Garage: `orbit` object in `main.ts` (az, el, dist, drag, shift, holdUntil); presets are data-act="cam" chips.
  **az = 0 is the FRONT**, π is the rear; pointer drag orbits, wheel zooms; turntable resumes after `holdUntil`;
  the `Orbit` chip sets `holdUntil = 0`. Picking a preset parks the turntable for 15 s.
- Driving: `camera.ts` `CamMode` = chase | far | cinematic | drift | hood | bumper | orbit; `drift` follows the
  velocity direction, `orbit` is the showcase pan; Settings row writes localStorage `nr.cam`.
- Title/showroom uses the garage orbit; studio environment (`scene/studio.ts`, PMREM softboxes) is applied to the
  car materials on every screen except driving (`showroomEnv` in `main.ts`).

## Screenshot rule (non-negotiable)

Every part and car gets a screenshot before shipping. `web/tools/parts-probe.js` selects a sample and saves
`window.__shotNow` frames:

```sh
cd web && npm run dev -- --port 5173   # background
HEADLESS=1 PROBE=tools/parts-probe.js node tools/drive.mjs "http://127.0.0.1:5173/?menu=1&touch=0" /tmp/parts menu
```

## Asset pipeline (Blender)

- Car GLBs are **meshopt + KTX2 (basisu)**. Blender 5.2.3 (at `~/opt/blender-5.2.3-linux-x64`) cannot import KTX2.
- `web/scripts/decode-ktx2.cjs` (needs `npm i basis_universal` for the `basisu` binary) extracts each image, runs
  `basisu -unpack` **with cwd set to the output dir** (it ignores `-output_path`), rebuilds the GLB with PNG images and
  no `KHR_texture_basisu`. Verified: 12/12 textures, Blender shows 60 meshes + 12 images.
- Stripping textures instead of decoding also works for pure-geometry edits (keeps materials flat).
- Authored parts are exported as GLB at the car's own coordinates, so they load at the right place.

## Known issues / next

- Hood fitted clones pick a **dark liner mesh** (the cloned hood renders black) - select the outer skin (paint material
  children) or paint per-mesh by original material. Verified seated, wrong shade.
- Rear shells mounted but not yet screenshot-verified; bumper "kits" from `body.ts` are add-on lips/fins over the
  stock bumper (full shells do not follow the nose).
- Parts are placeholder-grade; real quality needs authored/CC0 meshes fitted in Blender.
- References: page fetches return text-only; direct image URLs (press kits) or images dropped in the repo are needed.
- New cars need: physics JSON in `data/cars`, visual JSON (wheel nodes/paint/cg/collision), catalog entry and stats;
  source only CC0/CC-BY models, license-check each, screenshot in the garage.
