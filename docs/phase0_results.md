# Phase 0 results: renderer benchmark

Date 2026-10-06. Godot 4.7.2, Mesa 25.2.8 (ANV), Intel RPL-U iGPU, 1920x1080 fullscreen, vsync off.
Scene: procedural night ring road (942 m), 8 cars with 4 visibility-range LODs, 49 buildings
(~150k tris), MultiMesh lamps + foliage, 1 directional light (2 cascades, 120 m), glow + ACES,
2K road/hero textures (S3TC). Camera flies one 30 s lap after a 6 s warm-up.
Stand-in geometry only. Baked LightmapGI NOT included (needs an editor bake; see Open items).

## Renderer x 3D scale (30 s each, clean machine)
| run | avg fps | 1% low | GPU ms avg/p99 | CPU ms | draws | tris avg/max | VRAM MB | RAM MB |
|---|---|---|---|---|---|---|---|---|
| mobile 100% | 78.8 | 59.0 | 8.7/10.3 | 0.7 | 64 | 200k/333k | 470 | 381 |
| mobile 75% | 86.6 | 69.4 | 7.4/8.3 | 0.8 | 64 | 200k/333k | 452 | 382 |
| mobile 60% | 91.8 | 72.7 | 6.8/7.6 | 0.7 | 64 | 200k/333k | 442 | 382 |
| compat 100% | 67.7 | 57.8 | 12.2/14.6 | 1.6 | 72 | 200k/333k | 321 | 331 |
| compat 75% | 78.2 | 65.2 | 10.3/12.8 | 1.5 | 72 | 200k/333k | 313 | 331 |
| compat 60% | 87.3 | 69.1 | 8.9/11.9 | 1.8 | 72 | 200k/333k | 309 | 331 |

## Mobile @ 75% stress variants
| variant | avg fps | 1% low | GPU ms avg/p99 | tris avg/max |
|---|---|---|---|---|
| base | 85.8 | 69.1 | 7.5/8.4 | 200k/333k |
| all 8 cars forced LOD0 | 85.8 | 70.0 | 7.5/8.4 | 277k/391k |
| 4 shadow-casting headlights | 84.3 | 68.2 | 7.8/8.8 | 200k/333k |
| LOD0 + 4 headlights | 83.7 | 68.6 | 7.9/9.0 | 278k/391k |
| no glow/tonemap | 87.6 | 69.9 | 7.2/8.1 | 200k/333k |

## Findings
- Decision: Mobile renderer. ~30% less GPU time than Compatibility at every scale, and it has the
  features the plan needs (ReflectionProbe, decals, 8 lights/mesh and 256 per view).
- Target met: 60 fps at 75% scale (avg 86, 1% low 69). 45 fps floor met in every configuration.
- Triangles are cheap here: +77k tris (cars forced to LOD0) cost ~0.0 ms GPU. Scale 100%->60%
  only saves ~1.9 ms, so ~5 ms is fixed per-frame cost (shadow pass, post, geometry). Shadows and
  post, not triangle count, are what to watch.
- 4 shadow-casting headlights: +0.3 ms. Glow+tonemap: +0.3 ms.
- Each run has exactly one >100 ms frame (first-time pipeline/shader compile). Needs a
  pipeline-cache warm-up in the real game.
- Thermals: package temp reaches 96 C within ~1.5 minutes of load. Results held steady across the
  following runs, but this chip is at its thermal limit; keep plugged in, power profile
  "performance", and a hard surface.
- Memory: RAM ~382 MB, VRAM ~450-490 MB (VRAM comes out of the shared 8 GB).

## Open items
- Wall-clock frame time (~11.5 ms at 75%) is higher than GPU+CPU time (~8 ms). Cause not yet
  identified (present/compositor/shared-memory stalls are candidates).
- Triangle budget 400-600k is untested: scene peaks at 391k. Needs a triangle-ramp test.
- Baked LightmapGI cost not measured. Needs a manual editor bake.
- Draw calls peak at ~73 vs the 700 budget: the draw-call budget is untested.
