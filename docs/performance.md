# Performance: what is worth optimizing (measured 2026-10-17, i3-1315U)

Rule: optimize only what a measurement shows is slow AND what survives the move to Unreal.
Godot rendering work (lighting, shaders, draw calls, LODs) is redone in Unreal: not worth it now.

## Core (transfers to Unreal) - `core/build/rs_bench`
8 AI cars on the city route, 240 Hz:
| part | per car per tick |
|---|---|
| AI driver + controls | 12.1 us |
| vehicle physics | 3.0 us |
| race tracker | 1.4 us |
| total, 8 cars, one 60 fps frame (4 ticks) | 0.53 ms (~3 % of 16.7 ms) |
Verdict: nothing to optimize. Re-run after changing anything that runs every tick.

## Game (Godot, test bench only)
- Frame rate is GPU-bound (~11 ms GPU at 75 %, ~18.5 ms at 100 % + MSAA 2x).
- Per-frame GDScript must stay cheap: the car dent code costs time per vertex of each panel near an
  impact, so deformable panels stay small (see docs/car_model_v2.md: one 14k-triangle body halved fps).

## Render pipeline: sharpening upscale, quality presets, scale-independent lighting (2026-10-22)

From docs/threejspunk_notes.md. Code: `web/src/post.ts`, adaptive logic in `web/src/main.ts`.

- **Canvas stays at full pixel ratio, only the scene + post passes render at `scale`.** The last pass is
  a single-shader upscale with RCAS-style contrast-adaptive sharpening (5 bilinear taps), replacing the
  browser's soft bilinear stretch of the canvas. Same GPU cost at the same scale, visibly crisper
  (lane markings, window edges).
- **Quality presets** `high` (SMAA + bloom) / `medium` (FXAA + bloom) / `low` (no AA, no bloom), each its
  own pre-compiled RenderPipeline sharing one scene pass. `?quality=high|medium|low` pins one. Headlight
  shadow map refreshes every 2nd/3rd frame. Adaptive order: lower the preset first (no hitch), then the
  scale (calibration/30 fps rules from 74779c3 unchanged); step up in reverse (scale first, only when stopped).
- **`ScaledClusteredLighting`**: tile lookup from `screenUV`, grid fixed at canvas size, so a scale change
  no longer rebuilds/recompiles every lit material (that was most of the old 0.5-1.9 s resize freeze).
- Motion blur, TRAA etc. stay removed. Bloom is 1/4 of render res, SMAA targets 8 bit.
- Warm-up: every preset is rendered once per real frame behind the loading screen
  (`Post.warmupFrames`); before that the first switch to `low` cost 400-600 ms.

Measured on the laptop iGPU (Chrome WebGPU, 1236x613 canvas, `drive.mjs perf`, GPU = timestamp queries,
frame medians are vsync-quantised to 16.7 ms so GPU time is the useful number):

| scale | main GPU median / p95 | branch (high) GPU median / p95 | max frame while driving |
|---|---|---|---|
| 0.7 | 5.6-5.9 / 7.0-7.9 ms | 5.7 / 6.4-7.5 ms | main 100-133 ms (one hitch ~1 s after start), branch 33-50 ms |
| 1.0 | 11.2-11.4 / 13.4-13.5 ms | 9.8-9.9 / 11.9-13.6 ms | main 100 ms, branch 50 ms |
| 0.7, `low` | - | 5.1-5.3 / 6.4-7.0 ms | 50 ms |

Preset switching while driving (`drive.mjs switch`): worst frame 50 ms over 6 switches; scale change
50-67 ms; 0 pipelines created after loading (68 at start).

## Race CPU cost: buffer uploads and draw calls (2026-11-08)

Measured with `HEADLESS=1 MOBILE=1 node web/tools/drive.mjs "<url>?menu=1&quality=high" <out> raceperf` (a 6-car, 3-lap race in
the phone viewport, the player's car on a pure-pursuit autopilot; CPU profile, GPU timestamps, frame intervals; RP_JS runs page
code at the end, e.g. a `writeBuffer` counter). Note: a DevTools screenshot stalls the page ~0.5 s, so `raceperf` takes none
unless RP_SHOTS=1.

- **three.js r186 re-uploads every `DynamicDrawUsage` attribute in full at every draw**, changed or not, and reads the
  matrices of an InstancedMesh with <= 1024 instances from a uniform array that is re-uploaded every frame. The NYC prop
  sets (19,000 trees, 6,000 lamps + pools, ...) were 3.2 MB and ~2,100 `writeBuffer` calls per frame. Now: static usage,
  uploads only after `needsUpdate` with the written slot range (`InstanceSet` tracks it), every instanced mesh at least
  1,025 slots (`instanceSlots()`, scene/instancing.ts). 0.3 MB per frame.
- **AI cars were 46 meshes each** (230 of 275 main-pass draws, and all of them in the headlight shadow pass). Now: only the
  shell and tyres cast (12 casters), small parts drawn within 30 m only, the four wheels merged per material and spun in
  the vertex shader (`mergeSpinningWheels`, scene/merge.ts). Main pass 275 -> ~160 draws, shadow pass 134 -> ~45 per frame.
- The near-tree swap scanned every loaded tree every 250 ms; now only the tiles in range, and nothing is uploaded unless a
  tree entered or left the range.

| phone viewport, laptop | before | after |
|---|---|---|
| main thread per frame | 20.2 ms | 15.0 ms |
| render() CPU median / p95 | 14.4 / 28.3 ms | 10.5 / 18.4 ms |
| GPU median (0.38 MP) | 20.1 ms | 20.0 ms (denser near trees included) |

Phones now render into a canvas at up to 2x CSS px with the tuned render scale (~0.72 MP to start, sharpened up to the panel)
instead of a 1x canvas stretched 2.6x by the browser; the tuner lowers that resolution (down to the old picture) before it
drops any effect. All presets are rendered for real during loading (a mid-race medium -> low fallback built pipelines: 6.5 s).
## Texture VRAM, draw calls and the frame readout (2026-11-09)

The perf line reports the frame as it is felt: `30 fps (cap 30) · 33 ms · p95 41 · 267 calls · 35 MB tex`.
`ms` is the median drawn-frame interval of the last second, `p95` the jitter; the maximum is kept in
`hud.lastMax` and logged, not shown, because one 128 ms hitch used to read as the game's frame time.
`calls` is `renderer.info.render.drawCalls` (per draw, reset every frame) - not `render.calls`, which
counts `renderer.render()` invocations for the shadow maps and the reflection probe. `MB tex` is the VRAM
of every texture reachable from the scene's materials, mip chains included; block-compressed (KTX2)
textures report their transcoded bytes. `window.__game.stats()` and `texStats()` return the same numbers
(`src/stats.ts`), and a console line every 10 s in dev logs them.

Measured on the laptop, phone viewport 1830x824, `?menu=0&cap=30` (no auto-tuning), ultra preset:

| | value |
|---|---|
| draw calls | 267 |
| triangles | 1.89 M |
| textures | 41 (28 block-compressed) |
| texture VRAM | 36.3 MB |
| textures without a mip chain | 0 |

Texture bandwidth is not this frame's problem: every sampled texture has mips and the VRAM is small. At
that size the limit is fill rate on the iGPU (~19 fps) plus the triangle count. The remaining KTX2 gap is
the v4 car models (`kestrel_gt`, `harrier_gt`), which still embed 3 PNGs each; v3 `vela_gt` and the city
props are KTX2. Converting them needs KTX-Software in `tools/ktx/` (see `build_car3.sh`) and a visual check.
## Street trees: the far crowns were half the frame's triangles (2026-11-09)

Measured with a probe that hides objects and re-measures uncapped (`?menu=0&cap=0&quality=ultra`, 1280x657):

| | triangles | fps |
|---|---|---|
| before (ico crowns at detail 1) | 1.885 M | 19.5 |
| all tree meshes hidden | 0.365 M | 26.2 |

The five instanced species crowns (1,239 trees x ~1.2 k triangles) were 1.5 M triangles. Beyond the photoreal
range (80 m on max/ultra, `NEAR_TREES`) a crown is a screen-space blob, so its 80-face ico blobs are now
20-face: **1.885 M -> 0.956 M triangles, 19.5 -> 25.0 fps** at the same camera, draw calls unchanged (~260).
Inside 80 m `trees.ts` still draws the scanned-leaf photoreal trees, untouched. Props are the next ~2 fps
(hiding all of `nyc_props` reaches 28.5).
## Why the v4 cars are not converted to KTX2 (2026-11-09)

Inspected the GLBs: `kestrel_gt_hero.glb` and `harrier_gt_hero.glb` embed three PNGs each (1, 75 and 45 KB),
all bound to **normal** slots; their paint and trim are flat material colours. `vela_gt_hero.glb` (v3) is the
one with 12 KTX2 maps (587 KB base colour, 286 KB, 224 KB...).

KTX2 pays off on large colour/normal maps that would otherwise sit in VRAM as RGBA8. These three maps are
small, and normals need UASTC (ETC1S smears them), which is 8 bits per pixel: converting 512^2 maps would
shrink VRAM by about 2 MB per car but add hundreds of KB to the download. Not worth it; the KTX2 money is
already spent where the megabytes were.

Current scene (phone viewport, ultra): 41 textures, 28 block-compressed, 36.3 MB, **0 without mips**.
## Where ultra's frame goes (2026-11-09)

Measured on one pinned vantage (7th Avenue, 1280x657, ultra, uncapped, car disabled) so every run renders
the same scene: 262 draw calls, 968 k triangles. FPS over 3 s.

| ultra setting | fps | vs baseline |
|---|---|---|
| baseline | 25.6 | - |
| SSR off | 27.9 | +9 % |
| SSR target 0.35 (was 0.5) | 27.4 | +7 % |
| bloom off | 27.1 | +6 % |

SSR's target resolution was almost its whole cost: the node now renders the reflection at **0.35** of the
canvas instead of 0.5. The reflection is a roughness-blurred mirror, so the pinned screenshots before/after
are indistinguishable, and the 7 % goes back to the frame. Bloom is the next 6 %; AA and headlight shadows
measured inside the noise.

With SSR at 0.35 the same vantage gives **31.0 fps at render scale 0.85** and **31.6 at 0.8**, against 27.4
at 1.0 - the 30 fps target. Render scale belongs to the auto-tuner, which lowers resolution before it drops
an effect: the cheaper SSR is headroom it spends on a sharper picture at the same 30 fps, not a preset change.
