# Racing Sim MVP: Plan

Goal: realistic-handling PC racing sim prototype in Godot 4.7.x, built so the physics and game
logic can be ported to Unreal later. Handling realism is non-negotiable; visuals are the maximum
the hardware sustains, **measured, not guessed**.

## Hardware (hard limits)
Intel i3-1315U, Intel UHD (RPL-U, 64EU, shared memory), 8 GB RAM total (~2.8 GB used by the OS and
desktop at idle), Linux Mint. Game budget ~3 GB RAM. Vulkan 1.4 via Mesa 25.2 works (verified).

## Architecture (strict)
1. `core/`: standalone C++17 library, zero engine deps, SI units, Z-up right-handed. Physics AND
   game logic (lap timing, rules, assists, AI, damage rules).
2. `godot_ext/`: thin GDExtension wrapper: raycasts + applies forces. The only place that
   converts axes to Godot's.
3. `game/`: Godot scenes, camera, input, UI, debug overlay. No physics logic in scripts.
4. `data/`: engine-neutral JSON per car/track, versioned with a schema.
5. `assets_source/`: Blender files and full-res textures. Godot imports exported glTF only.

## Phases (stop after each for testing)
| Phase | Deliverable | Status |
|---|---|---|
| 0 | Benchmark scene + HUD, Mobile vs Compatibility decision with numbers | in progress |
| 1 | C++ physics core + CLI tests (cornering, braking distance, weight transfer) | |
| 2 | GDExtension wrapper, placeholder car on a flat test area | |
| 3 | Debug overlay, keyboard input smoothing, assists (TC/ABS/stability/steering) | |
| 4 | Original street circuit, baked lighting, hero car at budget, re-benchmark | |
| 5 | Handling tuning with real-car reference data (needs feel-testing) | |

## Budgets (starting values, adjust only from measured data)
Visible per frame 400-600k tris and <700 draw calls (**to be revised by Phase 0 data**).
Hero LOD0 ~50k (wheels ~3k each), LODs 20k/8k/2k. Opponents LOD0 ~20k down to 1.5k, max 8 cars at
LOD0/1. Track 100-150k visible. Textures 2K hero / 1-2K atlases, VRAM-compressed, <1.5 GB.

## Lighting rules
Baked LightmapGI, few reflection probes, PBR, tone mapping + glow. No SDFGI/VoxelGI/volumetric fog
unless a benchmark proves it affordable. One directional light with 2 cascades; dynamic shadow
casters limited to headlights (4-6 total).

## Decisions log
- 2026-10-06: Godot 4.7.2 (latest stable 4.x). Keyboard first for input. nlohmann/json vendored in
  core for JSON parsing (header-only, MIT).
- 2026-10-06: Git tracks planning and physics/maths docs only (see `.gitignore` whitelist).
