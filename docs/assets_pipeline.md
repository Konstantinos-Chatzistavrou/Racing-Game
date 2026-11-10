# Adding cars from free/CC0 marketplaces (validated pipeline)

This is the recipe the `cc0-cars` spike validated end-to-end on a real CC BY 4.0 model (Khronos
`CarConcept`, rendered in the garage with the game's paint pipeline). It also records why that model was
**not** shipped and what is required before a new car can be.

## 1. Source and licence check

- Allowed: **CC0**, **CC BY 4.0** (attribution), public domain. Record author, source URL, licence and any
  modifications in `CREDITS.md` — same style as the Vela GT entry.
- Not allowed: ripped game models, brand logos/trade dress, "free" models with unclear licences.
- **Trademark rule (learned the hard way):** a CC BY model can still carry brand logos. The Vela GT was
  de-branded before shipping (logos and text removed). Any car sourced with visible badges/emblems must go
  through the same de-branding in Blender first, otherwise do not ship it.

## 2. Technical requirements for a car model

- glTF/GLB, Y-up, **+X left, +Y up, +Z forward** (front axle at positive z), origin on the ground at the
  body's length centre.
- Wheels as separate nodes: `WheelFrontL/R`, `WheelRearL/R` (or any names you map in `wheel_nodes`), with the
  hub at the node origin.
- One paint material (the game recolours it): e.g. `Paint 2 Carmine`.
- Keep the draw cost near the existing hero car (~100 meshes is the same order; the Vela is ~109).

If the GLB is KTX2/basisu compressed, decode it first:

\`\`\`\
node web/scripts/decode-ktx2.cjs <in.glb> <out.glb>   # requires: npm i basis_universal
\`\`\`

Blender then imports the textured car for fitting/inspection.

## 3. Files a car needs

1. `web/public/assets/cars/v3/<id>.glb` — the model.
2. `web/public/data/cars/<id>.json` — physics: copy `vela_gt.json`, then set `name`, `chassis.mass_kg`,
   `wheelbase_m`, `cg_height_m`, axle `track_m`, and `aero.drag_area_m2` / `downforce_area_m2` for the body.
3. `web/public/data/cars/<id>.visual.json` — copy `kestrel_gt.visual.json` and set `name`, `physics`,
   `model`, `wheel_nodes`, `paint_material`, `collision_box` (measure world bounds), `cg_in_model_m`,
   `headlights`, `driver_seat_m`, `lod_model`.
4. `web/public/data/cars/catalog.json` — entry: id, price, name, tag, physics, visual, paint.
5. `web/src/progression.ts` — `CAR_REQ[id] = { spLevel, mpLevel, price }`. `owns()` is level-based: spLevel 1
   means it is in the garage immediately (useful for screenshots), higher levels gate it in the shop.
6. `CREDITS.md` — attribution and a `LICENSE-<id>.txt` next to the model.

## 4. Verify (mandatory, every part/car gets a screenshot)

\`\`\`\
HEADLESS=1 node web/tools/drive.mjs "http://127.0.0.1:5173/?menu=1&touch=0" /tmp/audit menu
# or the parts probe: PROBE=web/tools/parts-probe.js
\`\`\`

Check in the garage: wheels at the arch, paint recolours, no floating parts, headlights, ride height, and the
car list entry. Then drive one lap to confirm the physics config (mass/track/wheelbase) does not flip it.

## 5. Case study: the CarConcept spike

- Model: Khronos `CarConcept.glb` (CC BY 4.0, Darmstadt Graphics Group GmbH), 101 nodes, 97 meshes,
  wheels as `WheelFrontL/R`, `WheelRearL/R`, paint `Paint 2 Carmine`, 4.36 m long, 2.72 m wide with mirrors,
  front axle z 1.49, rear -1.31, hubs y 0.38.
- Result: configured as `k_concept` and it rendered correctly in the garage with the game's paint, wheel and
  camera systems — the pipeline is proven.
- Blocked: it carries Khronos / 3D Commerce logos in its textures (the Vela GT had these removed before
  shipping). Not shipped; de-brand it in Blender (remove logo meshes/textures, rename plate) and it can be.
