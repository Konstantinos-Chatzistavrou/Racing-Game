# PORTING.md: what is engine-specific and must be rebuilt for Unreal

Keep this current as phases land.

## Portable as-is (no engine dependency)
- `core/`: vehicle physics, tires, drivetrain, assists, lap timing, race rules, AI, damage rules
  (Phase 1 done: `rs_core` static lib + headless tests; build with CMake, no engine needed.
  Unreal: link `rs_core`, call `wheel_rays()` / `update()` from a component each physics tick.)
- `data/`: car and track JSON + schemas
- `assets_source/`: Blender files, full-res textures
- `docs/`: physics maths

## Engine-specific (rebuild per engine)
| Area | Godot implementation | Unreal equivalent to build |
|---|---|---|
| Wheel raycasts + force application | `godot_ext/` (GDExtension) | C++ actor component calling the core |
| Axis conversion (core Z-up RH <-> engine) | one function in `godot_ext/` | one function in the Unreal component |
| Scenes, camera, input mapping, UI, debug overlay | `game/` (GDScript) | Blueprints/UMG |
| Materials, lightmaps, reflection probes, post-process | Godot resources, regenerable | Re-author from `assets_source/` |
| Mesh LOD, visibility ranges, occlusion culling | Godot settings | Unreal LOD/HLOD/culling |
| Benchmark HUD (`game/bench`, `game/scripts/perf_hud.gd`) | Godot Performance monitors | Unreal stat commands |
| Import fix-ups (clearcoat, alpha fence, light energies, surface tags) | `game/import/*_import.gd` | Unreal import pipeline / material instances |
| Wet road material incl. analytic lamp reflections | `game/shaders/wet_road.gdshader` | Unreal material; maths is portable (aniso GGX + Schlick, see shader comments) |
| Night sky | `game/shaders/night_sky.gdshader` | Unreal sky material |
| Lightmap bake automation | `game/addons/autobake` (presses the editor button) | Unreal Lightmass build |
| Scene assembly (env, probes, LightmapGI) | `game/tools/build_harbour_scene.gd` | Unreal level setup |
| Attract-mode car driving (throwaway, pre-physics) | `game/scripts/showcase.gd` | Replaced by the C++ core in Phase 2 |

## Temporary rule exceptions (to fix in Phase 2)
- Axis conversion core->Godot `(x, y, z) -> (x, z, -y)` currently lives in TWO places:
  `build_harbour_scene.gd::core_to_godot` and `showcase.gd::_load_track`. Phase 2 moves it into
  the GDExtension wrapper as the single conversion point.
- The track JSON is read by GDScript for the attract mode. Phase 2: the core reads it.

## Asset pipeline (all regenerable)
`tools/build_assets.sh` = textures -> car -> track (Blender, headless) -> Godot import -> scene -> bake.

## Rules that keep this table short
- No physics or game logic in GDScript.
- Core uses SI units, Z-up right-handed. Conversion happens in exactly one wrapper function.
- Never treat Godot-authored materials/lighting as the source of truth.
