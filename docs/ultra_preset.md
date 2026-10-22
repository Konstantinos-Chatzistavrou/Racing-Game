# Ultra preset and the look pass (2026-10-23)

Four parallel experiments (each measured with `web/tools/drive.mjs perf`, GPU timestamp queries, 1236x613, scale 1,
`?cap=0`), merged by hand. Frame cap is 30 fps by default (`?cap=N`, 0 = uncapped).

| Piece | Where | GPU cost | Verdict |
|---|---|---|---|
| Final grade (Khronos Neutral tone curve, contrast/lift/saturation/teal-orange split, dither, subtle grain, bloom 0.45/0.45/1.0/0.5) | `fx/grade.ts`, all presets | ~0 ms | on everywhere (AgX looked milky; ACES/Uchimura crushed the road). `?tm=`, `?grade=0`, `?grain=` for A/B |
| GTAO (half res) + TRAA (jitter, velocity MRT) | `fx/gtaoTraa.ts`, `ultra` | ~+3 ms | TRAA edges clearly cleaner; AO subtle at night. Motion shimmer/ghosting NOT checked |
| SSR on wet road (half res, roughness-gated) | `fx/ssr.ts`, shares the ultra MRT scene pass | ~+3 ms | clear gain (street mirrored in puddles); half-res blocky |
| Live car reflection probe | `fx/carProbe.ts`, `?probe=N` (off) | +0.1..2 ms | subtle at night: optional (`?probe=6`) |
| Perf: warm every prop/LOD/preset pipeline at load, merge AI-car meshes, car out of its own shadow | `scene/instancing.ts`, `scene/merge.ts`, `ai.ts`, `car.ts` | CPU/draws, not GPU | hitches of 0.1-4.6 s (lazy pipeline compiles) -> 0 pipelines/0 frames >100 ms after load |

Combined `ultra` (one MRT pass: output, velocity, normal, reflect weight): GPU median ~16-17 ms, p95 20-22 ms vs `high` ~10 / 16-17.
Uncapped it reaches only ~33 fps on the i3 laptop, so Auto (which wants >= 40 uncapped) steps down to `high`; pick Ultra manually.

## Not done (ranked, from the perf audit)
1. Render bundles / BatchedMesh for the static city (~150 draws): ~2-3 ms CPU, matters most on the phone. Risky.
2. Merge the player car's static parts (except dent-shader panels and wheels): ~60 draws.
3. Merge remote-car meshes in `net.ts` with `mergeStaticMeshes`.
4. `shadowEvery` 3 for `high` flattens the p95 spikes (shadow-update frames); 512-1024 shadow res available.
5. Hero car LOD (the 28k-tri model exists) for far camera views: ~1.4 ms.
Rejected: auto-exposure (pumping at night), anamorphic flare, 3D LUT (no gain over the analytic grade), anisotropy 4->1 (no change).
