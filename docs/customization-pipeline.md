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

## Generated parts (rebuilt 2026-11-11: fitted to the body, not to its box)

The first generation placed slabs relative to the car's bounding box (`aero.ts`, `body.ts`, deleted): a splitter was a
plate 0.22 m ahead of the box, a flare a torus at the Vela's wheelbase, a "vented hood" a board over the nose, rims as
big as the tyre. On every car they floated or cut through the body.

| module | what | contract |
|---|---|---|
| `scene/parts/fit.ts` | `BodyFit`: the car's outlines, sampled once from its vertices (model space) | `nose(x)`, `tail(x)` -> {z, y underside}; `sill(z, side)` -> {x, y}; `shoulder(z, side)`, `corner(z, side)`; `deckAt(x, z)`; `wingBase()`; `wheels` (hub, radius), `ground` |
| `scene/parts/fit.ts` | `fittedSplitter`, `fittedDiffuser`, `fittedSkirt`, `fittedFlares` | thin sections swept along those outlines (`ribbon`, `plate`); designs = parameter tables `SPLITTERS_FIT`, `DIFFUSERS_FIT`, `SKIRTS_FIT`, `FLARES_FIT`, keyed by the old ids |
| `scene/parts/fit.ts` | `reshaped(model, stockPanel, mat, move)` | a float, model-space copy of one of the car's own panels with its vertices moved |
| `scene/parts/wings.ts` | 30 wings | `WingSpec.build({box, wb, mat})`; `wb` is now `fit.wingBase()` (the tail deck), not the stock wing's box |
| `scene/parts/rims.ts` | 30 rims | `RimSpec.build({radius, width, mat})`, sized from the wheel's own rim meshes (else 70 % of the tyre) |

- A splitter is one flat blade touching the lowest point of the bumper's underside, following its outline; a diffuser
  the same at the tail, between the rear tyres, with strakes that stop 3.5 cm above the ground; a skirt runs between
  the arches along the sill; a flare is a lip around `wheel radius + 5.5 cm`, standing out from the body side there.
- Bumpers and hoods are ALWAYS the car's own panel, copied and reshaped (`custom.ts`, tables `FRONTS`, `REARS`,
  `HOODS_FIT`): the edge that meets the fenders does not move. Each mesh keeps its own material (a bumper's grille is
  not paint). A car without a `bumper_front` / `bumper_rear` / `hood` node has no such options: the garage lists only
  what `CarCustomizer.hasBody(id)` returns (`menu.fits`), and the stock panel is hidden only for a part that exists.
- The Vela's Blender-authored panels (`assets/cars/v3/vela_*.glb`) are fitted to a Vela only (`main.ts fitAuthored`),
  also after a car swap. They used to be put on whichever car the game started with.
- Traps met: the models are quantized (integer positions under a scaled node), so editing a cloned panel in place
  moved vertices in integer units and left normals no shader could light (the old shells rendered black); a bounding
  box pushed through a rotated matrix overstates a wheel (`exactBox` iterates vertices); a wheel node must hang
  directly under the model and sit at its hub (`car.ts recentreWheel`): the K-Concept's wheels hung under a node
  turned -90 deg and the car stood 1.8 m above the garage floor.
- Cost on the laptop: `BodyFit` 22 ms for a 313k-vertex car; 16-22 reshaped panels, ~22k triangles, hidden until chosen.
- `web/scripts/metrics.mjs` measures wings and rims only now; the fitted parts keep their entries in `parts-metrics.ts`.
- node names used: `bumper_front`, `bumper_rear`, `hood`, `wing` / `wing_assembly`; wheels come from the visual
  config's `wheel_nodes`. Model space: **+x left, +y up, +z front**.
- Check a car: scratch harness `cap.sh <car id>` pattern (garage, four looks x three views -> one contact sheet);
  all four cars were checked this way on 2026-11-11.
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
