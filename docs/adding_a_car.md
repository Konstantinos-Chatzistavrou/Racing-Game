# Adding a car (the recipe)

Written 2026-11-11. What a model must be for the game to take it, and the checks it goes through. The parts system
needs nothing per car any more: splitters, diffusers, skirts, flares, wings, rims and reshaped panels are fitted to
whatever body the model has (`web/src/scene/parts/fit.ts`, docs/customization-pipeline.md).

## 1. The source model

- Licence: CC0, CC BY (credit in CREDITS.md and the HUD credits line), or the project's own. Not CC BY-NC / ND,
  not "royalty free" marketplace licences. Keep the evidence (page capture) in `assets_source/licenses/`.
- A real make is only a DONOR: CC BY covers the artist's mesh, not the manufacturer's marks or design. Remove every
  badge, plate, sponsor and tyre lettering (meshes AND textures) and reshape it until the silhouette is not the
  donor's (docs/car_model_v3.md, docs/car_model_v4.md list what was changed for the cars we have).
- Budget for a hero car: up to ~130k triangles, ~35 materials, textures 2048 (KTX2). The player's car is already
  106 of ~160 draw calls: merge meshes that share a material before export.

## 2. What the GLB must contain

Model space: **+X left, +Y up, +Z forward**, origin on the ground under the middle of the car, metres.

| node / material | needed for | notes |
|---|---|---|
| four wheel nodes, named in the visual config (`wheel_nodes`) | steering, spin, suspension, wheels torn off | any name; the game re-parents them under the model and re-pivots them to their hubs (`car.ts recentreWheel`), so a Z-up export or an off-centre origin is tolerated. Tyre, rim and disc under the node; rim meshes use a material called `rim*` or sit under a node called `*rim*` |
| `caliper_FL` ... (optional) | calipers that steer but do not spin | else leave them out of the wheel node |
| `bumper_front`, `bumper_rear`, `hood` (optional) | bumper / hood options in the garage, parts breaking off | without them the car simply has no such options |
| `mirror_L`, `mirror_R` (optional) | fold and break off in a crash | |
| `wing` or `wing_assembly` (optional) | the stock wing ("Stock" / "No wing") | generated wings stand on the tail deck either way |
| material `paint` (or `paint_material` in the config) | body colour, finish, liveries | one material for everything that takes the colour |
| glass material | window tint | |
| lamps: names listed in the config (`front_lights`, `rear_lights`) | headlight tint, brake lights, breaking in a crash | |

## 3. Files

1. `web/public/assets/cars/<gen>/<id>_hero.glb` (meshopt + KTX2: `assets_source/scripts/register_car.py` or the
   `gltf-transform` lines in `assets_source/scripts/build_car3.sh`).
2. `web/public/data/cars/<id>.visual.json`: `model`, `cg_in_model_m`, `wheel_nodes`, `collision_box`,
   `paint_material`, `default_paint`, lamps, `engine_smoke_in_model_m`, `detachable`. Copy the nearest existing car's.
3. `web/public/data/cars/<id>.json`: physics. Start from a car of the same layout and change mass, wheelbase, track,
   power curve and tyres to the new car's; the wheelbase and track must match the model's hubs.
4. An entry in `web/public/data/cars/catalog.json` (id, name, physics, visual, price) and its level in
   `web/src/progression.ts` (`CAR_REQ`).

## 4. Checks (all of them, every time)

1. `web/tools/car_sheet.sh <id>`: the contact sheet (stock, two kits, the panels; three views each). Look for: the car
   standing on the turntable, wheels in their arches, the splitter touching the bumper, flares round the arches, the
   wing's mounts on the deck, rims inside the tyres, nothing black or inside-out.
2. Drive it: `?menu=0&car=<id>`; wheels turn about their axles, the body does not sit in the road, the contact shadow
   is under the tyres.
3. Crash it: dents appear, bumpers hang then fall, a heavy crash tears a wheel off.
4. `cd core/build && ./rs_tests` if the physics file is new; `npm run build` in `web/`.

## 5. Where new cars can come from

There is no unused donor model in the repository (2026-11-11): the Vela GT and the K-Concept are both the Khronos
"Car Concept" (CC BY 4.0), the Kestrel and the Harrier come from two CC BY DTM models. A search for CC0 / CC BY
sports cars that download without an account found nothing verifiable. Sketchfab's "downloadable" filter with the
CC BY or CC0 licence is where the existing donors came from; it needs a signed-in download.
