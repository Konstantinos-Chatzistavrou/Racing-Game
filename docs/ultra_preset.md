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

## Follow-up (same day): Max vs Ultra, measured
Ultra as first merged (TRAA + GTAO + SSR on one wide MRT scene pass, now called **Max**) could NOT hold 30 fps at full resolution on
the i3 laptop: even with SSR and GTAO switched off the extra attachments (velocity, normal, reflect weight) cost ~2-3 ms of
shared-memory bandwidth, and at the scale that did hold 30 (0.7) it looked softer than High at 1.0 (TRAA blur, ghosting on the car).
Measured at scale 1, GPU median: max ~16.6 ms; no SSR 13.3; no AO 15.2; neither 12.0; high ~10.

New **Ultra** (`fx/depthFx.ts`): the plain single-attachment scene pass + SMAA, with SSR whose normal comes from depth in one
half-res pass (`getNormalFromDepth`; inside an RTT pass the built-in camera nodes are the quad's camera, so the game camera's matrices
are bound as uniforms) and "wet" = every up-facing surface (roads, pavement, car roofs), intensity 0.55, roughness 0.16.
GPU median ~12 ms (p95 ~18-20), holds a locked 30 at scale 1 (HUD 30 fps, worst frame 35-50 ms). No per-material puddles, no AO, no TRAA.
Preset order: max > ultra > high > medium > low. Auto starts at max and steps down (FPS_LOW 33 uncapped, enough margin over the 30 cap):
on the laptop it settles on Ultra at 100 %. Max is for stronger GPUs (select it under Graphics).
Switches for A/B: `?quality=max|ultra|high`, `?ssr=0`, `?ao=0`, `?ssr=intensity:0.8,quality:0.5`, `?se=N` (shadow refresh every Nth frame).

## Render bundles (tried, default OFF)
`?bundle=1` records the static city (180 tile meshes, one BundleGroup per 160 m tile, tile-level frustum culling) into GPU render
bundles; the `max` preset (MRT scene pass) falls back automatically. Result on the i3 laptop: draw calls 327 -> 179, but
`post.render()` CPU only 0.2-0.6 ms better (interleaved on/off test: 0.24 ms), identical picture, no errors, no hitches.
Below the 0.5 ms bar, so it stays off. Worth re-testing on the phone (Mali: draw submission costs relatively more).
Not attempted (gated on this): merging the player car's static meshes (~60 draws).

## Built-in benchmark and refresh-rate-aware cap (2026-10-23)
Title menu: **Benchmark** (~75 s) and **Soak test** (benchmark + 5 min capped run, `?soak=SECONDS` to change; phones throttle after minutes,
so a 30 s test lies). `window.__game.bench(soak)` runs the same from the console / tools. `web/src/bench.ts`, loop hooks in `main.ts`.
- The car is placed on the city route each frame at 26 m/s (identical camera path, streaming and LOD load every run; no physics noise).
- Per preset (max, ultra, high, medium, low): 2 s warm-up, 5 s UNCAPPED (headroom: what the device can do), 8 s at the CAP (does the lock hold:
  late frames = intervals > 1.5x the cap interval). Reported: fps, p50/p95/p99/worst interval, late %, GPU ms (timestamp queries, if the
  browser has them), JS main-thread ms per frame, display Hz, GPU name, screen/DPR. Recommendation = best preset with uncapped fps >= 1.1 x cap,
  <= 3 % late frames and p99 < 2.2 intervals; "Use <preset>" applies it, "Copy results" puts the JSON on the clipboard.
- Cap: `?cap=N`, else the highest rate <= target (30 desktop, 45 touch) that DIVIDES the refresh rate (60 Hz -> 30, 90 -> 45, 120 -> 40,
  144 -> 28.8): every Nth refresh = perfectly even pacing; 45 on a 60/120 Hz panel would alternate frame times (judder). The Auto tuner's bar
  scales with the cap (1.1 x cap uncapped).
- Laptop (i3-1315U, 60 Hz, cap 30): ultra 40 fps uncapped / 29.1 capped / 1.3-1.7 % late; high 43 / 30.0 / 0 %; medium and low only ~46-47 uncapped:
  JS main thread ~9-11 ms per frame, so the LOW presets are CPU-bound here. Expect the same shape on a phone (CPU, not GPU, may be the limit).

### Running it on the phone (no cable)
Open the deployed game in Chrome on the Poco X8 Pro (needs a WebGPU-enabled Chrome), tap Benchmark, keep the screen on and the tab in front, then
Copy results (JSON). Run Soak test unplugged and cool for the throttling picture.
