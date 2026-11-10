# Blender pipeline for car parts (2026-11-10)

The car GLB is **meshopt-compressed with KTX2 (basisu) textures**. Blender 5.2's glTF importer rejects
`KHR_texture_basisu` ("Extension KHR_texture_basisu is not available"), and `gltf-transform` only *emits* KTX2 — it
cannot decode it to PNG. The working decode path is below; it was verified on `vela_gt_hero.glb` (12/12 textures,
60 meshes in Blender).

## 1. Decode KTX2 → PNG and rebuild the GLB

```sh
cd web
npm i basis_universal          # once; ships the basisu CLI (v1.16.4)
node scripts/decode-ktx2.cjs public/assets/cars/v3/vela_gt_hero.glb /tmp/vela_png.glb
```

What the script does: extracts each image from the GLB, decodes it with `basisu -unpack`, takes the largest PNG
(mip 0), appends it to the binary chunk, repoints each image at a PNG buffer view, sets `image/png`, and removes
`KHR_texture_basisu` from the asset.

**Gotcha**: `basisu -unpack` writes PNGs into its **current working directory**, not `-output_path`; the script
spawns it with `cwd` set to a temp dir per image.

## 2. Open in Blender

`~/opt/blender-5.2.3-linux-x64/blender -b --python script.py` (Blender 5.2.3 LTS is installed there; the system
Blender 4.0.2 cannot import these assets either).

Model space: **+x left, +y up, +z front** (headlights at z ≈ +2.0). Wheel nodes: `wheel_FL/FR` at z = +1.18,
`wheel_RL/RR` at z = −1.47. Car is ~4.4 m long, ~1.9 m wide.

## 3. Author a replacement part

Example that produced the two shipped shells (`vela_front_wide.glb`, `vela_front_track.glb`):

```python
import bpy
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath='/tmp/vela_png.glb')
parts = [o for o in bpy.data.objects if o.type == 'MESH' and o.name.startswith('bumper_front')]
for o in parts:
    d = o.copy(); d.data = o.data.copy(); bpy.context.collection.objects.link(d)
    for v in d.data.vertices:
        v.co.x *= 1.06      # widen
        v.co.y -= 0.035     # push forward (glTF +z front maps to Blender -y)
        # v.co.z ... to change the lower edge
    d.select_set(True)
bpy.ops.export_scene.gltf(filepath='/path/out.glb', export_format='GLB', use_selection=True)
```

Rules that keep parts fitting:
- Build at the **car's own coordinates** (do not recentre): the game adds the GLB at the model origin.
- Cut from the stock panel where possible (`bumper_front`, `skirt_L/R`, `hood`) so the part follows the body.
- Export only the part; assign materials in-game (`setShells`/custom.ts use the car's paint material).
- Keep parts ≤ ~12 meshes.

## 4. Load in game

- `custom.ts` `setShells(wide, track)` replaces the runtime-derived shells and hides the stock bumper when the
  matching `frontB` id is selected.
- `main.ts` loads the GLBs with `loadGLTF(assetUrl(...))` and calls `visual.custom.setShells(...)`.
- If a GLB fails, the derived shells remain as fallback.

## 5. Audit (mandatory)

```sh
HEADLESS=1 PROBE=tools/parts-probe.js node tools/drive.mjs "http://127.0.0.1:5173/?menu=1&touch=0" /tmp/parts menu
```

Screenshot each new part from Front (`0,0.14,6.0`), Side (`1.57,0.08,6.4`) and Nose (`0,0.05,4.2`); a part that
floats or clips is not done.

## 6. Licensing

- Only **CC0 or CC-BY** sources; record the licence page in `assets_source/licenses/` and keep the attribution.
- No branded kits (Rocket Bunny etc.), no ripped game assets. Our procedural designs are original.
- `docs/free_assets.md` holds the licence research; extend it when adding a source.
