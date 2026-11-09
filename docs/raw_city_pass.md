# A batched city pass: spike results and plan (2026-11-09)

Goal: cut the city's draw calls, because render submission is ~15 of the frame's 19 ms of CPU
(`docs/performance.md`, "Where the CPU goes").

## What the city costs today

At one vantage (1280x657, ultra): 261 draw calls, of which ~200 are city tiles.

| what | count |
|---|---|
| tile roots streamed | 70 |
| tile meshes | 307 |
| roofs (`nyc-roof`) | 84 |
| far facades (`nyc-facade-far`) | 68 |
| near facades (`nyc-facade`) | 16 |
| ground: road / sidewalk / curb / marking / crosswalk | 16 each |
| grass | 11 |

At the measured ~56 us per draw, the city's ~200 draws are about 11 ms of the 15 ms submission cost.

## Spike 1: merge per tile by material

Implemented and measured: **no change** (261 draws before and after). A tile averages 4.4 meshes and is
already about one mesh per material, so merging *within* a tile has nothing to join. Reverted.

## Spike 2: three's BatchedMesh per material, built from the live tiles

Eleven materials batched (ground, grass, water, near facades). Two refused:

    THREE.BatchedMesh: All attributes must have a consistent itemSize and normalised flag

for `nyc-roof` (84 geometries) and `nyc-facade-far` (68) - the tile GLBs mix quantized and float
attributes across tiles (and the console already warns about a missing `uv1`). Draws did **not** fall
(261 -> 319 with the originals hidden), so the WebGPU backend is issuing per-instance draws rather than
one multi-draw. BatchedMesh is not the shortcut.

## Plan

1. **Normalise tile geometry at build time** (`assets_source/scripts/build_city_assets.sh`): every tile in
   one attribute layout - position, normal, uv, colour, `_bld` - dequantized, same itemSize and flags. That
   is the prerequisite both for batching and for a raw vertex format.
2. **CityBatch per material**: one growable vertex/index buffer per material plus a slot allocator per tile
   (append on load, free on unload, compact when holes pass a threshold). One draw per material - target
   ~10 draws for the whole city instead of ~200.
3. **Keep three's material/shading** for the first version: a single `Mesh` per material over the batch
   buffer, with three doing the node graph and the GPU doing one draw. This is "custom, narrowly": we own
   the city's buffers and draw list, three keeps everything else (cars, effects, post).
4. **Only then** consider a raw WGSL path for the city, and only if the profile still shows submission cost.

Expected: ~11 ms of CPU back at ~10 draws, which is the difference between the tuner's 0.6 and ~0.8
render scale at 30 fps. Measure with `window.__prof` and `drive.mjs profile` before/after.
