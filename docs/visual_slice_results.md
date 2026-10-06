# Visual slice (Phase 4 work done early, before physics)

Date 2026-10-06. Mobile renderer, 1920x1080 fullscreen, 3D scale 75% (FSR 1), vsync off.
Scene: original "Harbour Loop" street circuit (1526 m), 79 buildings, 43 baked street lamps,
16 neon signs, 6 original GT cars (38.7k tris each, separate panels) lapping in attract mode.

## Final measurements (after optimisation)
| camera | avg fps | 1% low | GPU ms avg/p99 | draws | tris max | VRAM | RAM peak |
|---|---|---|---|---|---|---|---|
| chase (gameplay view) | 80.4 | 59.2 | 8.3/10.1 | 136 | 56k | 181 MB | ~1.0 GB |
| trackside TV | 69.8 | 52.2 | 10.1 | ~350 | 119k | 182 MB | ~0.9 GB |
| orbit close-up (worst case) | 65.7 | 45.5 | 10.3/14.3 | 155 | 127k | 181 MB | ~1.1 GB |
Target 60 fps at 75%: met in every view. 45 fps floor: met (orbit is at the floor).
Each run has 2-5 frames > 100 ms (first-time shader pipeline compiles, e.g. when nearby car lights
switch on). Needs a pipeline warm-up pass before the race starts.

## Measured feature costs (chase, before optimisation; 30 s runs)
moon shadows 1.6 ms | reflection probes 1.0 ms + 280 MB VRAM | glow 0.8 ms | opponent headlights
0.5 ms | contact decals 0.3 ms | car-only lamp lights ~0.1 ms | FSR vs bilinear ~0.
Applied: moon shadows off, probe atlas 128 px / 8 slots and 6 probes, glow levels 2-4 only.
Base went 60.4 -> 80.4 fps, VRAM 509 -> 181 MB.

## Key techniques (why it looks wet and still runs)
- Lamps fully baked (LightmapGI, diffuse). Lightmaps can't hold view-dependent specular, so the
  wet-road shader adds analytic lamp reflections: anisotropic GGX + Schlick (F0 = 0.02, water),
  looking up only the ~4 nearest lamps by track distance (UV.x / 36 m). Cost: tiny vs 43 real lights
  (keeping them real-time cost ~12 ms).
- Cars: baked lamps re-enabled at runtime with cull mask = car layer only, within 70 m of camera.
- Wetness model: water fills pores -> albedo x0.5, roughness -> 0.12; puddles -> roughness 0.03,
  flattened normals.

## Gotchas found
- bmesh `faces.new()` leaves face normals at zero: call `normal_update()` before orientation tests.
- Godot turns any node name ending in "wheel" into VehicleWheel3D on glTF import.
- glTF from Blender drops clearcoat; light intensities arrive in unusable units: fixed in import scripts.
- LightmapGI has no bake API in 4.7: `game/addons/autobake` presses the editor button and answers
  the save-path dialog.
