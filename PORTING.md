# PORTING.md: what is engine-specific and must be rebuilt for Unreal

Keep this current as phases land.

## Portable as-is (no engine dependency)
- `core/`: vehicle physics, tires, drivetrain, assists, lap timing, race rules, AI, damage rules
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
| Benchmark HUD (`game/bench`) | Godot Performance monitors | Unreal stat commands |

## Rules that keep this table short
- No physics or game logic in GDScript.
- Core uses SI units, Z-up right-handed. Conversion happens in exactly one wrapper function.
- Never treat Godot-authored materials/lighting as the source of truth.
