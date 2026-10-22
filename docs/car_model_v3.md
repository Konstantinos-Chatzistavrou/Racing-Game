# Car model v3: Vela GT from the Khronos "Car Concept" (2026-10-18)

The procedural `make_car2` car looked low-poly next to the lit city. Generation 3 is a high-fidelity
car derived from a CC BY 4.0 source, fully de-branded and restyled, with the part structure the
game needs, compressed for the web. Used for the player (hero model), the AI traffic and remote
multiplayer cars (traffic model).

| | file | triangles | download | GPU memory (textures + geometry) |
|---|---|---|---|---|
| hero (player) | `game/assets/cars/v3/vela_gt_hero.glb` | 123.6k | HERO_SIZE | HERO_MEM |
| traffic (AI, remote) | `game/assets/cars/v3/vela_gt_traffic.glb` | 28.2k | TRAFFIC_SIZE | TRAFFIC_MEM |
| old `car_gt.glb` (make_car2) | `game/assets/cars/car_gt.glb` | OLD_TRIS | 1.40 MB | - |

Served as before through `web/public/assets/cars -> game/assets/cars`; the `v3/` folder has a
`.gdignore` (the legacy Godot build cannot import meshopt/KTX2, see "Godot" below).

## Licence trail

1. **"FREE Concept Car 004"** by Unity Fan, https://sketchfab.com/3d-models/4cba124633eb494eadc3bb0c4660ad7e,
   dedicated to the public domain (CC0) by the author (see docs/free_assets.md 2.1 on the
   Sketchfab "Free Standard" field).
2. **"Car Concept"** by Eric Chadwick, © 2024 Darmstadt Graphics Group GmbH, Khronos glTF Sample
   Assets, https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CarConcept,
   **CC BY 4.0** (verified 2026-10-18 in the repo's `Models/CarConcept/LICENSE.md` and
   `metadata.json`: "Model and textures", artist Eric Chadwick, owner Darmstadt Graphics Group
   GmbH, year 2024, CC-BY-4.0). The same files list two **Khronos trademark** entries (the Khronos
   logo and the 3D Commerce logo, `LicenseRef-LegalMark-Khronos`): "This license excludes logos
   and associated trademarks". They are removed (below), not licensed to us.
3. **Vela GT v3** (this repo): our modifications, listed below as CC BY §3(a)(1)(B) requires
   ("indicate if You modified the Material"). Attribution: `CREDITS.md` and the in-game credits
   line (top of the HUD, `web/index.html` `#credits`). No DRM or obfuscation is added (CC BY
   §2(a)(5)(B)); the GLBs are standard glTF.

Raw downloads go to `assets_source/downloads/` (gitignored, never committed). Fetch:

```
mkdir -p assets_source/downloads/CarConcept && cd assets_source/downloads/CarConcept
B=https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/CarConcept
curl -LO $B/glTF-Binary/CarConcept.glb -LO $B/LICENSE.md -LO $B/metadata.json -LO $B/README.md
```

A second CC0/CC-BY original-design car that downloads without a login was not found (the
candidates in docs/free_assets.md, C4-C7, are all on Sketchfab, which needs an account). Traffic
variety comes from paint (three colours, `ai.ts` PAINTS) on the shared traffic model.

## What was changed (all scripted: `assets_source/scripts/make_car3.py`, Blender 5.2, headless)

**De-branding (meshes and textures):**
- `Khronos_C.png` (Khronos logo) was the emissive map of the caliper, rim, mirror-glass, gasket
  and hardware materials, and the base colour of the licence plate: unlinked everywhere; the plate
  mesh is deleted and replaced by our own plate with a "VELA GT" texture drawn from a 5x7 bitmap
  font defined in the script.
- `Tireside_C.png` (Khronos + 3D Commerce logos) and `Tireside_N.png` (embossed logos and tyre
  lettering: DOT code, size, "OUTSIDE", treadwear...): replaced by a flat colour and our own
  procedural sidewall normal map (bead rings, ribs, no text).
- `Dash_E.png` (instrument cluster with English labels): replaced by a procedural, text-free
  cluster (bar gauges, tacho arc).
- Steering-wheel emblem mesh deleted. The source's material variants (Pearl / Graphite paints,
  iridescence) are dropped. Every texture of the result was checked: AO atlas, mechanical
  normal/ORM, tread, disc and fabric patterns carry no marks.

**Our design (what makes it distinct):**
- Proportions: 0.86 x width, 0.946 x length/height (2.24 m concept -> 1.92 m wide, 4.15 m long);
  wheelbase exactly the physics car's 2.65 m.
- Front: new wide trapezoid lower intake with four horizontal blades and a frame (the concept's
  nose is smooth), carbon splitter; the concept's headlight slit becomes an unlit smoked accent;
  new light signature: three stacked LED bars ("tri-dash") at each outer corner + separate
  projector lenses inboard.
- Rear: new full-width light bar with C-shaped end blades (replaces the concept's two deck lamps),
  four diffuser fins, our plate, a rear wing on two uprights with end plates.
- Sides: side-skirt blades.
- Wheels: our own 5-twin-spoke directional rim with concave dish, machined lip, 5 lug nuts and a
  plain centre cap (the concept's rims are deleted); bronze calipers.
- Colour scheme: single paint (game colour) with fine metal flake, gloss-black roof and lower
  cladding, cognac interior; wipers removed.

**Optimisation:** interior decimated to 45 % (seen only through tinted glass), traffic version
decimated per part (~28k triangles) with a 24-segment rim.

## Game contract

Model space = the game's: +X left, +Y up, +Z forward, origin on the ground at the body's length
centre (Blender: X left, -Y forward, Z up; the glTF exporter converts).

| node | role |
|---|---|
| `wheel_FL/FR/RL/RR` | empties at the hub (identity rotation, spin about X) holding `_tyre`, `_rim`, `_disc` |
| `caliper_FL...` | empties at the hub holding the caliper: steers, never spins |
| `bumper_front` (+ grille, blades, frame, splitter, lower lip), `bumper_rear` (+ fins, plate, lower) | detachable |
| `mirror_L`, `mirror_R` | detachable |
| `hood`, `trunk`, `door_L/R`, `roof`, `body_pillars`, `body_lower`, `skirt_L/R`, `wing` | dented body panels (3-11k triangles each; dents are in the vertex shader, dents.ts) |
| `drl_L/R`, `beam_L/R` / `taillight_bar` | `front_lights` / `rear_lights` (material `light_head` / `light_tail`) |
| `glass` | alpha-blended (no transmission: a second scene pass is too much for the iGPU) |
| `interior`, `underbody*`, `hood_inner` | never dented (damage.ts SKIP) |

`data/cars/vela_gt.visual.json` (measured from the build log and in the browser):
- axles at model z +1.18 / -1.467, hubs at y 0.368; CG = front axle - 1.378 m (core: CG sits
  `weight_front x wheelbase` ahead of the rear axle) -> `cg_in_model_m` [0, 0.51, -0.198]. The y
  was checked in the browser: the physics hub lands at model y 0.366 (model 0.368).
- model track 1.68 m vs physics 1.61 m -> `wheel_visual_offset_m` 0.04 (car.ts moves the wheel
  nodes out by that; 4 cm is invisible in the handling, wheels sitting inside the arches is not).
- visual tyre radius 0.345 m vs physics 0.327 m: the source tyre shrunk to 0.327 looked lost in
  its arches; 1.8 cm sinks into the road at the contact patch, which reads as tyre deflection.
- headlights (spot lights) at the projector lenses [±0.41, 0.50, 2.22]; engine smoke/fire point
  [0, 0.78, 1.70] (top of the engine bay under the hood); collision box 1.90 x 0.73 x 4.12 m
  centred at [0, 0.725, 0.24] (underside 0.32 m above the ground, as before).

## Compression (assets_source/scripts/build_car3.sh)

`gltf-transform` 4.5.1: dedup, prune, resize (hero 2048, traffic 1024), **KTX2**: UASTC (level 2,
RDO, zstd 18) for normal maps, ETC1S (quality 192) for colour/ORM/AO/emissive. KTX-Software 4.4.2
release binaries in `tools/ktx/` (gitignored). Then geometry compression:

| | meshopt (`--level high`) | Draco (defaults) |
|---|---|---|
| hero | 2.42 MB (gzip 2.03) | 1.90 MB (gzip 1.80) |
| traffic | 1.29 MB (gzip 1.11) | 1.14 MB (gzip 1.07) |
| decoder | inline-WASM module, main thread, no extra download | 300 KB WASM/JS in a worker pool |
| decode time (browser, hero) | not measured separately (inline WASM, no worker start-up) | not measured (worker pool start-up on top) |

**Chosen: meshopt.** About 0.5 MB more download for the hero (the KTX2 textures are ~1.25 MB of
either file), but no decoder download, no worker start-up and a much faster decode, which matters
more on the weak laptop than 0.5 MB once (the GLBs are cached immutably by Vercel). meshopt also
keeps the vertex data quantized in VRAM (`KHR_mesh_quantization`).

Loader: `web/src/scene/loaders.ts` (shared with the city work): GLTFLoader + MeshoptDecoder +
KTX2Loader.detectSupport(renderer); Basis transcoder copied to `web/public/libs/basis/`. It also
merges duplicate texture clones (GLTFLoader clones a texture per material for texCoord 1: the AO
atlas was uploaded 14 times, 39 MB of VRAM, see "GPU memory").

## Godot

The legacy Godot build reads the same `vela_gt.visual.json`; Godot 4 cannot import
`EXT_meshopt_compression`, so it would need the old `car_gt.glb` path back (or an uncompressed
export) to keep working. The web build is the game now (docs/web_port.md).

## Rebuild

```
assets_source/scripts/build_car3.sh            # BLENDER=/path/to/blender if not tools/blender
assets_source/scripts/build_car3.sh --draco    # also writes Draco variants for comparison
```

## Verification (in-game)

`node web/tools/drive.mjs <url> <out> crash` in system Chrome/WebGPU: the hero car loads, renders
(see the visible CC BY credit line in the HUD), a crash produces shader dents (`dents: 2`, crush
0.14) and damage state, no console errors. Measured 44-46 fps at adaptive scale 0.7 (1236x613 window)
with 192 clustered lights and AI traffic. De-branding check: no manufacturer names or logos in the
GLBs (strings scan), `web/src`, or `data/`; the only third-party name left is the CC BY attribution
to the source model's author and Khronos Sample Assets, which the licence requires. Download: hero
2.4 MB + traffic 1.3 MB.
