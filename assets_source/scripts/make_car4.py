"""Car generation 4 ("Kestrel GT"): a de-branded, re-shaped derivative of "2019 Aston Martin Vantage DTM".

Run:  tools/blender/blender -b --factory-startup --python assets_source/scripts/make_car4.py -- \
          <2019_aston_martin_vantage_dtm.glb> <out_dir>
Out:  <out_dir>/kestrel_gt_raw.glb (flat materials, no textures), <out_dir>/kestrel_gt.json (numbers for the
      game's visual config), <out_dir>/kestrel_preview.blend

SOURCE AND LICENCE: "2019 Aston Martin Vantage DTM" by Dave Love SketchFab, CC BY 4.0
(https://sketchfab.com/3d-models/2019-aston-martin-vantage-dtm-266d89d6ca944f1baa7ff232a615cfbd;
evidence: assets_source/licenses/downloaded_cars_2026-10-18/). CC BY requires crediting the author and
stating what we changed (CREDITS.md). CC BY does NOT license the manufacturer's or sponsors' marks, so
everything that carries one is removed:
  - the livery atlases (Image_15/16/17: Hankook, Bosch, DEKRA, Baldessarini, DHL/Deutsche Post, Vynamic,
    numbers) are not used; body faces are split into our recolourable 'paint' and black trim from the
    atlas' blurred luminance only, so no decal survives;
  - tyre sidewall (Hankook), rim atlas, plate (Bosch / Aston wings), dash switch labels, cockpit atlas:
    replaced by flat PBR materials; race number and plate meshes deleted.
WHAT MAKES IT OURS (so it is no longer a recognisable copy of the real car):
  - SHAPE(): a smooth deformation (longer, lower nose; cabin pushed back; lower roof; wider rear haunches;
    shorter tail), wheelbase untouched, then a uniform scale to the game's 2.65 m wheelbase;
  - the source's front splitter fins, grille mesh, rear diffuser, wing and taillight units are deleted and
    replaced by our own designs (splitter with plates and canards, slatted grille, finned diffuser, a
    swan-neck wing, LED light bars);
  - flat materials with our paint/trim split; the game's part names (see game/web contract below).
GAME CONTRACT (web/src/scene/car.ts, damage.ts): model space +X left, +Y up, +Z forward (Blender: -Y forward),
  origin on the ground at the body's length centre; wheel_FL/FR/RL/RR empties at the hubs (spin about X),
  caliper_* empties at the hubs (steer only), bumper_front/bumper_rear/mirror_L/mirror_R detachable,
  drl_L/R + beam_L/R front lights, taillight_bar rear light, glass material named 'glass', paint 'paint'.
"""
import json
import os
import sys

import bpy
import numpy as np
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from carlib import *  # noqa: E402,F401,F403

args = sys.argv[sys.argv.index("--") + 1:]
SRC, OUT = args[0], args[1]
os.makedirs(OUT, exist_ok=True)
WHEELBASE = 2.65   # the game's physics wheelbase (data/cars/vela_gt.json)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
M = standard_materials()
bm_ = by_material()

# ---- 1. brand carriers and duplicates out -------------------------------------------------------------
for k in ("EXT_NUMBER", "INT_PLATE", "DAMAGE_GLASS", "AM_BRAKELIGHTS", "AM_RAINLIGHT"):
    for o in bm_.get(k, []):
        remove(o)
bm_ = by_material()

# ---- 2. flat materials ---------------------------------------------------------------------------------
flat = {"EXT_WINDOWS": "glass", "EXT_TIRE": "tyre", "EXT_RIMS": "rim", "EXT_DISC": "disc", "EXT_BRAKES": "caliper",
        "AM_HEADLIGHTS": "light", "EXT_LIGHTS": "glass", "EXT_MESH": "trim", "BLACK": "trim",
        "INT_CARBON": "carbon", "INT_Steer_Carbon": "carbon"}
for k, v in flat.items():
    for o in bm_.get(k, []):
        o.data.materials.clear(); o.data.materials.append(M[v])
INTERIOR = ("INT_CPIT", "INT_Cpit", "INT_Cpit_Extras", "INT_CPIT_EXTRAS", "INT_DASH", "INT_METAL", "INT_CAGE",
            "ASTON_INTERIOR", "T5_LCD", "T5_LED", "T5_DRS", "INT_CARBON", "INT_Steer_Carbon")
for k in INTERIOR:
    for o in bm_.get(k, []):
        o.data.materials.clear(); o.data.materials.append(M["interior"])


# ---- 3. body + misc: split faces into paint / trim by the blurred livery atlas -------------------------
def blurred(img_name, n=48):
    im = bpy.data.images[img_name]
    w, h = im.size
    px = np.empty(w * h * 4, dtype=np.float32)
    im.pixels.foreach_get(px)
    px = px.reshape(h, w, 4)[:, :, :3]
    k = w // n
    return px[: n * k, : n * k].reshape(n, k, n, k, 3).mean(axis=(1, 3)).mean(axis=2)


def classify(obj, atlas, thresh):
    me = obj.data
    lum = blurred(atlas)
    n = lum.shape[0]
    uv = me.uv_layers.active.data
    me.materials.clear(); me.materials.append(M["paint"]); me.materials.append(M["trim"])
    for p in me.polygons:
        u = sum(uv[i].uv.x for i in p.loop_indices) / p.loop_total
        v = sum(uv[i].uv.y for i in p.loop_indices) / p.loop_total
        p.material_index = 1 if lum[min(n - 1, max(0, int(v * n))), min(n - 1, max(0, int(u * n)))] < thresh else 0


body = bm_["EXT_CARPAINT"][0]
classify(body, "Image_15", 0.16)
misc = bm_["EXT_MISC"][0]
classify(misc, "Image_17", 0.16)

# ---- 4. wheels: loose parts, grouped by corner; hubs measured before any deformation --------------------
WHEEL_KINDS = ("EXT_TIRE", "EXT_RIMS", "EXT_DISC", "EXT_BRAKES")
for k in WHEEL_KINDS:
    for o in bm_[k]:
        separate_loose(o)
wheel_parts = [o for o in meshes() if o.data.materials[0] in (M["tyre"], M["rim"], M["disc"], M["caliper"])]
corner = {"FL": [], "FR": [], "RL": [], "RR": []}
for o in wheel_parts:
    lo, hi = bbox([o])
    c = (lo + hi) / 2
    corner[("F" if c[1] < 0 else "R") + ("L" if c[0] > 0 else "R")].append(o)
hub0 = {}
for k, lst in corner.items():
    tyre = max((o for o in lst if o.data.materials[0] == M["tyre"]), key=lambda o: o.dimensions.z)
    lo, hi = bbox([tyre])
    hub0[k] = (lo + hi) / 2
YF, YR = hub0["FL"][1], hub0["RL"][1]
print("source hubs", {k: np.round(v, 3).tolist() for k, v in hub0.items()}, "wheelbase", round(YR - YF, 3))
S = WHEELBASE / (YR - YF)

# ---- 5. carve out parts that need their own node / get replaced, BEFORE deforming -------------------------
mirror = {}
for side, sgn in (("L", 1), ("R", -1)):
    mirror[side] = split_faces(misc, lambda c, s=sgn: (c[:, 0] * s > 0.85) & (c[:, 1] > -1.1) & (c[:, 1] < 0.1) & (c[:, 2] > 0.5), f"mirror_{side}")
# signature parts: front lower fins/splitter, rear diffuser, wing, old grille mesh and tail lamps
front_zone = lambda c: (c[:, 1] < -1.74) & (c[:, 2] < 0.5)
rear_zone = lambda c: (c[:, 1] > 1.74) & (c[:, 2] < 0.42)
wing_zone = lambda c: (c[:, 1] > 1.3) & (c[:, 2] > 0.95)
grille_old = [o for o in meshes() if o.name.startswith("Object_25")]   # kept until the shaped opening is measured
delete_faces(body, lambda c: (c[:, 1] > 2.05) & (c[:, 2] > 0.88))   # the old wing's end plates are part of the body shell
for o in by_material().get("trim_black", []) + [misc]:
    if o.name.startswith("mirror") or o in grille_old:
        continue
    delete_faces(o, lambda c: front_zone(c) | rear_zone(c) | wing_zone(c))
for o in [o for o in meshes() if o.name in ("Object_27", "Object_29")]:   # EXT_LIGHTS (front + rear lamps in one mesh), AM_HEADLIGHTS
    separate_loose(o)
lights_front, lights_rear = [], []
for o in [o for o in meshes() if o.data.materials and o.data.materials[0] in (M["glass"], M["light"]) and o.name.startswith(("Object_27", "Object_29"))]:
    lo, hi = bbox([o])
    if hi[1] < 0 and lo[2] > 0.5:
        lights_front.append(o)
    elif lo[1] > 1.5 and lo[2] > 0.6 and hi[2] < 1.0:
        lights_rear.append(o)

# ---- 6. deformation ----------------------------------------------------------------------------------------
def SHAPE(p):
    """(N,3) Blender-axes points -> new points. Hub axles (y = YF, YR) do not move along y."""
    x, y, z = p[:, 0].copy(), p[:, 1].copy(), p[:, 2].copy()
    n = sstep(YF, YF - 1.0, y)                       # nose: longer, lower, narrower
    y -= 0.22 * n
    z -= 0.075 * n * np.clip((z - 0.1) / 0.5, 0, 1)
    x *= 1 - 0.07 * n
    t = np.clip((y - YF) / (YR - YF), 0, 1)          # cabin: slides back between the axles, roof drops
    mid = np.sin(np.pi * t) ** 2
    y += 0.26 * mid
    roof = sstep(0.75, 1.3, z) * mid
    z -= 0.075 * roof * (z - 0.6)
    x *= 1 - 0.03 * roof
    r = sstep(YR - 0.5, YR + 0.5, y)                 # rear: wider haunches, shorter tail
    x *= 1 + 0.045 * r * np.clip((1.0 - z) / 0.9, 0, 1)
    y -= 0.16 * sstep(YR, YR + 1.3, y)
    return np.stack([x, y, z], 1)


hub_new = {k: S * SHAPE(v[None, :])[0] for k, v in hub0.items()}
for k, lst in corner.items():
    for o in lst:
        wp = world_coords(o)
        set_world_coords(o, S * (wp + (SHAPE(hub0[k][None, :])[0] - hub0[k])))
wheel_set = {id(o) for lst in corner.values() for o in lst}
for o in meshes():
    if id(o) not in wheel_set:
        set_world_coords(o, S * SHAPE(world_coords(o)))
# recentre: length centre of the body at y=0, tyres on z=0
lo, hi = bbox([body])
tyre_lo = min(bbox([o])[0][2] for o in wheel_parts)
T = np.array([0.0, -(lo[1] + hi[1]) / 2, -tyre_lo])
for o in meshes():
    set_world_coords(o, world_coords(o) + T)
hub = {k: v + T for k, v in hub_new.items()}
lo, hi = bbox([body])
bp = world_coords(body)
fy = bp[bp[:, 2] < 0.5, 1].min()            # front / rear extremes of the lower body (splitter/diffuser level)
ry = bp[bp[:, 2] < 0.5, 1].max()
ry_up = bp[(bp[:, 2] > 0.7) & (bp[:, 2] < 0.9), 1].max()   # tail face at lamp height
print("body y", round(fy, 3), round(ry, 3), "width", round(hi[0] - lo[0], 3), "height", round(hi[2], 3))
gl, gh = bbox([o for o in meshes() if o.name.startswith("Object_25")] or [body])
grille_box = (gl, gh)

# ---- 7. our own parts ---------------------------------------------------------------------------------------
for o in grille_old:
    remove(o)
sp, bl = M["carbon"], M["trim"]
front_parts = [
    add_box("splitter", sp, (0, fy + 0.26, 0.085), (2.02, 0.56, 0.025)),
    add_box("splitter_plate_L", sp, (1.0, fy + 0.28, 0.14), (0.02, 0.5, 0.11)),
    add_box("splitter_plate_R", sp, (-1.0, fy + 0.28, 0.14), (0.02, 0.5, 0.11)),
    add_box("canard_L", sp, (0.86, fy + 0.62, 0.26), (0.22, 0.2, 0.012), (0, 0, -18)),
    add_box("canard_R", sp, (-0.86, fy + 0.62, 0.26), (0.22, 0.2, 0.012), (0, 0, 18)),
    add_box("grille_back", bl, (0, fy + 0.13, (grille_box[0][2] + grille_box[1][2]) / 2), (1.62, 0.02, grille_box[1][2] - grille_box[0][2])),
]
z0, z1 = grille_box[0][2] + 0.04, grille_box[1][2] - 0.04
for i in range(6):
    front_parts.append(add_box(f"slat_{i}", sp, (0, fy + 0.10, z0 + (z1 - z0) * i / 5), (1.6, 0.025, 0.028), (-10, 0, 0)))
bumper_front = empty("bumper_front")
adopt(bumper_front, front_parts)

rear_parts = [add_box("diffuser_panel", sp, (0, ry - 0.34, 0.17), (1.46, 0.62, 0.02), (-9, 0, 0))]
for i, x in enumerate((-0.52, -0.18, 0.18, 0.52)):
    rear_parts.append(add_box(f"diffuser_fin_{i}", sp, (x, ry - 0.34, 0.25), (0.02, 0.6, 0.2)))
rear_parts.append(add_box("rear_lip", sp, (0, ry - 0.02, 0.36), (1.8, 0.04, 0.03)))
bumper_rear = empty("bumper_rear")
adopt(bumper_rear, rear_parts)

wing_y, wing_z = ry - 0.5, 1.2
wing_parts = [
    add_box("wing_plane", bl, (0, wing_y, wing_z), (1.94, 0.36, 0.028), (-7, 0, 0)),
    add_box("wing_flap", bl, (0, wing_y + 0.2, wing_z + 0.05), (1.94, 0.14, 0.02), (-24, 0, 0)),
    add_box("wing_plate_L", M["paint"], (0.98, wing_y + 0.03, wing_z + 0.01), (0.022, 0.5, 0.24)),
    add_box("wing_plate_R", M["paint"], (-0.98, wing_y + 0.03, wing_z + 0.01), (0.022, 0.5, 0.24)),
    add_box("wing_post_L", bl, (0.3, wing_y - 0.05, wing_z - 0.17), (0.05, 0.16, 0.36), (0, 0, 0)),
    add_box("wing_post_R", bl, (-0.3, wing_y - 0.05, wing_z - 0.17), (0.05, 0.16, 0.36), (0, 0, 0)),
]
wing = empty("wing")
adopt(wing, wing_parts)

# light bars: emissive strips over the (dark glass) housings
fl_lo, fl_hi = bbox(lights_front) if lights_front else (np.array([0.5, fy, 0.55]), np.array([0.9, fy + 0.3, 0.7]))
tail_bar = add_box("tail_strip", M["tail"], (0, ry_up + 0.004, 0.80), (1.3, 0.03, 0.035))
tail_blades = [add_box(f"tail_blade_{s}", M["tail"], (x, ry_up, 0.78), (0.035, 0.03, 0.14)) for s, x in (("L", 0.66), ("R", -0.66))]
tail = empty("taillight_bar")
adopt(tail, [tail_bar] + tail_blades)
drl = {}
for side, sgn in (("L", 1), ("R", -1)):
    bar = add_box(f"drl_{side}_bar", M["light"], (sgn * (fl_lo[0] + fl_hi[0]) / 2 if False else sgn * 0.74, fl_lo[1] + 0.005, fl_hi[2] - 0.035), (0.42, 0.012, 0.016), (0, 0, sgn * 8))
    drl[side] = bar
# rename the existing light meshes into the contract's nodes
rear_housing = join(lights_rear, "taillight_housing") if lights_rear else None
beam = {}
sides = {"L": [], "R": []}
for o in lights_front:                       # sort BEFORE joining: join() consumes the objects
    lo_, hi_ = bbox([o])
    sides["L" if (lo_[0] + hi_[0]) > 0 else "R"].append(o)
for side, objs in sides.items():
    beam[side] = join(objs, f"beam_{side}") if objs else None
for side in ("L", "R"):
    drl[side].name = f"drl_{side}"

# ---- 8. naming + wheels ------------------------------------------------------------------------------------
body.name = "body"
misc.name = "trim_misc"
for o in by_material().get("trim_black", []):
    if o.name.startswith("Object_26"):
        o.name = "underbody_" + o.name[-3:]
for o in meshes():
    if o.data.materials and o.data.materials[0] is M["interior"] or o.data.materials and o.data.materials[0] is M["carbon"] and o.name.startswith("Object_"):
        o.name = "interior_" + o.name
for o in meshes():
    if o.name.startswith("Object_30"):
        o.name = "mirror_glass"
glass_objs = [o for o in meshes() if o.name == "Object_21"]
for o in glass_objs:
    o.name = "glass_windows"
for k, lst in corner.items():
    e = empty(f"wheel_{k}", hub[k])
    c = empty(f"caliper_{k}", hub[k])
    bpy.context.view_layer.update()
    adopt(e, [o for o in lst if o.data.materials[0] is not M["caliper"]])
    adopt(c, [o for o in lst if o.data.materials[0] is M["caliper"]])
    for o in lst:
        o.name = f"wheel_{k}_{o.data.materials[0].name}"

# ---- 9. numbers for data/cars/kestrel_gt.visual.json --------------------------------------------------------
info = {
    "hubs_blender": {k: [round(float(v), 4) for v in hub[k]] for k in hub},
    "body_y": [round(float(fy), 3), round(float(ry), 3)], "body_x": [round(float(lo[0]), 3), round(float(hi[0]), 3)],
    "body_z_max": round(float(hi[2]), 3), "scale": round(float(S), 4), "tyre_radius": round(float(bbox([corner["FL"][0]])[1][2] - bbox([corner["FL"][0]])[0][2]) / 2, 3),
    "front_light_bbox": [np.round(fl_lo, 3).tolist(), np.round(fl_hi, 3).tolist()],
}
json.dump(info, open(os.path.join(OUT, "kestrel_gt.json"), "w"), indent=1)
print("INFO", json.dumps(info))
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, "kestrel_preview.blend"))
bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, "kestrel_gt_raw.glb"), export_format="GLB", export_apply=True)
print("wrote", OUT)
