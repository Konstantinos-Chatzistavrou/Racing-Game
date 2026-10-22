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
