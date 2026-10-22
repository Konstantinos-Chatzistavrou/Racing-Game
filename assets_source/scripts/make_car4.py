"""Car generation 4 ("Kestrel GT"): a de-branded, re-shaped derivative of "2019 Aston Martin Vantage DTM".

Run:  tools/blender/blender -b --factory-startup --python assets_source/scripts/make_car4.py -- \
          <2019_aston_martin_vantage_dtm.glb> <out_dir>
Out:  <out_dir>/kestrel_gt_raw.glb (uncompressed) + <out_dir>/kestrel_preview.blend

SOURCE AND LICENCE: "2019 Aston Martin Vantage DTM" by Dave Love SketchFab, CC BY 4.0
(https://sketchfab.com/3d-models/2019-aston-martin-vantage-dtm-266d89d6ca944f1baa7ff232a615cfbd;
evidence: assets_source/licenses/downloaded_cars_2026-10-18/). CC BY requires crediting the author and
stating what we changed (CREDITS.md). CC BY does NOT license the manufacturer's or sponsors' marks, so
everything that carries one is removed here:
  - the livery atlases (Image_15/16/17: Hankook, Bosch, DEKRA, Baldessarini, DHL/Deutsche Post, Vynamic,
    numbers) are not used; body faces are split into our 'paint' (recolourable) and black trim from the
    atlas' blurred luminance only, so no decal survives;
  - tyre sidewall (Hankook) and rim atlas, plate (Bosch/Aston wings), dash switch labels (Image_3),
    cockpit atlas: replaced by flat PBR materials;
  - the race number mesh and plate mesh are deleted.
WHAT MAKES IT OURS: the body vertices go through a smooth shape function (SHAPE below) that lengthens and
lowers the nose, pushes the cabin back and lowers the roof, widens the rear haunches and shortens the tail;
wheels stay round and move with the new axle positions.
"""
import bpy
import math
import os
import sys

import numpy as np
from mathutils import Vector

args = sys.argv[sys.argv.index("--") + 1:]
SRC, OUT = args[0], args[1]
os.makedirs(OUT, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)


def mat(name, rgb, metal=0.0, rough=0.5, emit=None, alpha=None, coat=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1)
    b.inputs["Metallic"].default_value = metal
    b.inputs["Roughness"].default_value = rough
    if coat:
        b.inputs["Coat Weight"].default_value = coat
        b.inputs["Coat Roughness"].default_value = 0.04
    if emit:
        b.inputs["Emission Color"].default_value = (*emit, 1)
        b.inputs["Emission Strength"].default_value = 3.0
    if alpha is not None:
        b.inputs["Alpha"].default_value = alpha
        m.surface_render_method = "BLENDED"
    return m


M = {
    "paint": mat("paint", (0.62, 0.64, 0.68), 0.35, 0.32, coat=1.0),
    "trim": mat("trim_black", (0.015, 0.015, 0.017), 0.0, 0.55),
    "glass": mat("glass", (0.02, 0.025, 0.03), 0.0, 0.03, alpha=0.3),
    "tyre": mat("tyre", (0.012, 0.012, 0.012), 0.0, 0.85),
    "rim": mat("rim", (0.08, 0.08, 0.09), 0.9, 0.35),
    "disc": mat("disc", (0.35, 0.35, 0.37), 0.9, 0.45),
    "caliper": mat("caliper", (0.55, 0.32, 0.08), 0.6, 0.35),
    "carbon": mat("carbon", (0.025, 0.025, 0.028), 0.2, 0.4),
    "interior": mat("interior_dark", (0.03, 0.03, 0.032), 0.0, 0.7),
    "light": mat("headlight_lens", (0.9, 0.92, 1.0), 0.0, 0.05, emit=(1, 1, 1)),
    "tail": mat("taillight", (0.5, 0.0, 0.0), 0.0, 0.1, emit=(1, 0, 0)),
}

objs = {o.name: o for o in bpy.data.objects if o.type == "MESH"}
by_mat = {}
for o in objs.values():
    by_mat.setdefault(o.data.materials[0].name.split(".")[0], []).append(o)


def only(name):
    return by_mat.get(name, [])


# ---- 1. delete everything that is a brand carrier we do not need ----------------------------------
for n in ("EXT_NUMBER", "INT_PLATE"):
    for o in only(n):
        bpy.data.objects.remove(o, do_unlink=True)

# ---- 2. flat materials for the non-body parts ---------------------------------------------------
flat = {
    "EXT_WINDOWS": "glass", "DAMAGE_GLASS": "glass", "EXT_TIRE": "tyre", "EXT_RIMS": "rim", "EXT_DISC": "disc",
    "EXT_BRAKES": "caliper", "AM_HEADLIGHTS": "light", "AM_BRAKELIGHTS": "tail", "AM_RAINLIGHT": "tail",
    "EXT_LIGHTS": "glass", "EXT_MESH": "trim", "BLACK": "trim", "INT_CARBON": "carbon", "INT_Steer_Carbon": "carbon",
}
for k, v in flat.items():
    for o in only(k):
        o.data.materials.clear(); o.data.materials.append(M[v])
for k in ("INT_CPIT", "INT_Cpit", "INT_Cpit_Extras", "INT_CPIT_EXTRAS", "INT_DASH", "INT_METAL", "INT_CAGE",
          "ASTON_INTERIOR", "T5_LCD", "T5_LED", "T5_DRS"):
    for o in only(k):
        o.data.materials.clear(); o.data.materials.append(M["interior"])
only_tris = bpy.data.objects
# remove the 'damage glass' duplicate shell (the game has its own damage system)
for o in only("DAMAGE_GLASS"):
    bpy.data.objects.remove(o, do_unlink=True)

# ---- 3. body + misc: split faces into paint / trim by the blurred livery atlas -------------------
def blurred(img_name, n=48):
    im = bpy.data.images[img_name]
    w, h = im.size
    px = np.empty(w * h * 4, dtype=np.float32)
    im.pixels.foreach_get(px)
    px = px.reshape(h, w, 4)[:, :, :3]
    k = w // n
    px = px[: n * k, : n * k].reshape(n, k, n, k, 3).mean(axis=(1, 3))
    return px.mean(axis=2)  # luminance-ish, n x n, row 0 = bottom (Blender UV v=0)


def classify(obj, atlas, thresh):
    me = obj.data
    lum = blurred(atlas)
    n = lum.shape[0]
    uv = me.uv_layers.active.data
    obj.data.materials.clear(); obj.data.materials.append(M["paint"]); obj.data.materials.append(M["trim"])
    for p in me.polygons:
        u = sum(uv[i].uv.x for i in p.loop_indices) / p.loop_total
        v = sum(uv[i].uv.y for i in p.loop_indices) / p.loop_total
        l = lum[min(n - 1, max(0, int(v * n))), min(n - 1, max(0, int(u * n)))]
        p.material_index = 1 if l < thresh else 0


for o in only("EXT_CARPAINT"):
    classify(o, "Image_15", 0.16)
for o in only("EXT_MISC"):
    classify(o, "Image_17", 0.16)

# ---- 4. shape function ---------------------------------------------------------------------------
def sstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def SHAPE(p):
    """p: (N,3) array in Blender axes: x right, y = length (front at -y), z up. Returns the new positions."""
    x, y, z = p[:, 0].copy(), p[:, 1].copy(), p[:, 2].copy()
    # nose: longer, lower, narrower
    nose = sstep(-1.0, -2.4, y)
    y -= 0.22 * nose
    z = z - 0.075 * nose * np.clip((z - 0.1) / 0.5, 0, 1)
    x *= 1 - 0.07 * nose
    # cabin: the greenhouse slides back 0.28 m (hood grows) and the roof drops
    cab = sstep(-1.2, 0.2, y) * (1 - sstep(1.2, 2.0, y))
    y += 0.28 * cab
    roof = sstep(0.75, 1.3, z) * cab
    z -= 0.075 * roof * (z - 0.6)
    x *= 1 - 0.03 * roof
    # rear: wider haunches, shorter tail
    tail = sstep(0.6, 1.9, y)
    x *= 1 + 0.045 * tail * np.clip((1.0 - z) / 0.9, 0, 1)
    y -= 0.16 * sstep(1.6, 2.7, y)
    return np.stack([x, y, z], 1)


def shape_object(o):
    me = o.data
    n = len(me.vertices)
    co = np.empty(n * 3, dtype=np.float32)
    me.vertices.foreach_get("co", co)
    co = co.reshape(n, 3)
    w = np.array(o.matrix_world)
    wp = co @ w[:3, :3].T + w[:3, 3]
    new = SHAPE(wp)
    local = (new - w[:3, 3]) @ np.linalg.inv(w[:3, :3]).T
    me.vertices.foreach_set("co", local.astype(np.float32).ravel())
    me.update()


WHEEL_KINDS = ("EXT_TIRE", "EXT_RIMS", "EXT_DISC", "EXT_BRAKES")
wheel_objs = [o for k in WHEEL_KINDS for o in only(k) if o.name in bpy.data.objects]
for o in list(bpy.data.objects):
    if o.type == "MESH" and o not in wheel_objs:
        shape_object(o)

# ---- 5. split the four wheels, parent them to hub empties at the new axle positions ---------------
bpy.context.view_layer.update()
for o in wheel_objs:
    bpy.context.view_layer.objects.active = o
    for s in bpy.data.objects:
        s.select_set(False)
    o.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.separate(type="LOOSE")
    bpy.ops.object.mode_set(mode="OBJECT")

hubs = {}
parts = [o for o in bpy.data.objects if o.type == "MESH" and any(o.data.materials and o.data.materials[0] in (M["tyre"], M["rim"], M["disc"], M["caliper"]) for _ in [0])]
groups = {"FL": [], "FR": [], "RL": [], "RR": []}
for o in parts:
    bb = [o.matrix_world @ Vector(c) for c in o.bound_box]
    c = sum(bb, Vector()) / 8
    side = "R" if c.x > 0 else "L"
    axle = "F" if c.y < 0 else "R"
    groups[axle + side].append(o)
for key, lst in groups.items():
    pts = [o.matrix_world @ Vector(c) for o in lst for c in o.bound_box]
    ctr = sum(pts, Vector()) / len(pts)
    # the tyre dominates the bounding box; hub = centre of the largest object
    big = max(lst, key=lambda o: o.dimensions.z)
    bb = [big.matrix_world @ Vector(c) for c in big.bound_box]
    hub = sum(bb, Vector()) / 8
    new_hub = Vector(SHAPE(np.array([[hub.x, hub.y, hub.z]]))[0])
    e = bpy.data.objects.new(f"wheel_{key}", None)
    bpy.context.scene.collection.objects.link(e)
    e.location = new_hub
    bpy.context.view_layer.update()   # matrix_world must be current before the parent inverse is taken
    for o in lst:
        mw = o.matrix_world.copy()
        o.parent = e
        o.matrix_parent_inverse = e.matrix_world.inverted()
        o.matrix_world = mw
        o.location += new_hub - hub
        o.name = f"{key}_{o.data.materials[0].name}"
    hubs[key] = tuple(round(v, 3) for v in new_hub)
print("HUBS", hubs)

bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, "kestrel_preview.blend"))
bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, "kestrel_gt_raw.glb"), export_format="GLB", export_apply=True)
print("wrote", OUT)
