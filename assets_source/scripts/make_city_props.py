"""Props library for the instanced city: every asset as LOD0/LOD1/LOD2 meshes in one GLB.

Run:  tools/blender/blender -b --factory-startup --python assets_source/scripts/make_city_props.py
In:   assets_source/downloads/polyhaven/*  (fetch_city_assets.py; Poly Haven "hidden_alley", CC0)
Out:  assets_source/build/city_props_raw.glb   (compressed to web/public/assets/city/city_props.glb by
      build_city_assets.sh). Nodes are named "<asset>__lod<n>", all at the origin.

Conventions (the placements in data/city_props.json, written by make_city.py, rely on them):
  floor props  centred on x/y, base at z = 0                        (hydrant, bins, boxes)
  wall props   centred on x, BACK on the wall plane y = 0, front facing -Y, base at z = 0
               (shutters, aircon, fire escape, downpipe, lights); the window sill's TOP is at z = 0
  street_lamp  pole at the origin, the arm reaches 1.4 m along +X (toward the road)
Instances carry a width scale sx (local X only): shutters and sills are stretched to the bay width.
LODs: Blender's Decimate (collapse) to triangle targets (props budget <= 3k tris at LOD0, see
docs/free_assets.md). The street lamp is modelled here (Poly Haven has no 7 m pole lamp) with the
same pole/arm/head dimensions as the old procedural lamp, so the exported lamp lights still sit
under the head; its paint uses street_lamp_01's cast-iron textures.
"""
import math
import os

import bmesh
import bpy
from mathutils import Matrix, Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DL = os.path.join(ROOT, "assets_source", "downloads", "polyhaven")
OUT = os.path.join(ROOT, "assets_source", "build", "city_props_raw.glb")

# asset: (source id, object names to keep, kind, LOD triangle targets, extra transform)
SOURCES = {
    "hydrant": ("fire_hydrant", ["fire_hydrant", "fire_hydrant_cap_01", "fire_hydrant_cap_02", "fire_hydrant_cap_03", "fire_hydrant_chain"], "floor", (3000, 900, 250)),
    "trash_can": ("metal_trash_can", ["metal_trash_can", "metal_trash_can_lid", "metal_trash_can_handle_left", "metal_trash_can_handle_right"], "floor", (2000, 700, 200)),
    "trash_can_rust": ("metal_trash_can", ["metal_trash_can_rust", "metal_trash_can_rust_lid", "metal_trash_can_rust_handle_left", "metal_trash_can_rust_handle_right"], "floor", (2000, 700, 200)),
    "utility_box_a": ("utility_box_01", ["utility_box_01_box"], "wall", (1500, 500, 150)),
    "utility_box_b": ("utility_box_02", ["utility_box_02"], "wall", (1500, 500, 150)),
    "aircon": ("exterior_aircon_unit", ["exterior_aircon_unit"], "wall", (2500, 800, 200)),
    "shutter_bay": ("rollershutter_window_01", ["rollershutter_window_01"], "wall", (552, 200, 60)),
    "shutter_door": ("rollershutter_door", ["rollershutter_door"], "wall", (552, 200, 60)),
    "security_light": ("security_light", ["security_light", "security_light_glass"], "wall", (1500, 500, 150)),
    "wall_lantern": ("street_lamp_02", ["street_lamp_02"], "wall", (2500, 800, 200)),
}
# width x height the wall pieces are stretched to (m): shutters cover a whole shop bay / door
FIT = {"shutter_bay": (3.0, 2.9), "shutter_door": (1.2, 2.75)}


def tris(ob):
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)


def deselect():
    for o in bpy.context.selected_objects:
        o.select_set(False)


def join(objs, name):
    deselect()
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = name
    ob.data.name = name
    # apply transforms so the mesh is in world units
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return ob


def bbox(ob):
    vs = [ob.matrix_world @ v.co for v in ob.data.vertices]
    mn = Vector((min(v.x for v in vs), min(v.y for v in vs), min(v.z for v in vs)))
    mx = Vector((max(v.x for v in vs), max(v.y for v in vs), max(v.z for v in vs)))
    return mn, mx


def normalise(ob, kind, fit=None):
    mn, mx = bbox(ob)
    if fit:
        sx, sz = fit[0] / (mx.x - mn.x), fit[1] / (mx.z - mn.z)
        ob.data.transform(Matrix.Diagonal((sx, 1, sz, 1)))
        mn, mx = bbox(ob)
    if kind == "floor":
        off = Vector((-(mn.x + mx.x) / 2, -(mn.y + mx.y) / 2, -mn.z))
    else:
        off = Vector((-(mn.x + mx.x) / 2, -mx.y, -mn.z))
    ob.data.transform(Matrix.Translation(off))


def dedupe_materials(ob):
    """'x.001' copies (same textures) -> the original, so each asset has as few materials (= draw
    calls per instanced LOD) as possible."""
    for slot in ob.material_slots:
        if slot.material and "." in slot.material.name:
            base = bpy.data.materials.get(slot.material.name.split(".")[0])
            if base:
                slot.material = base


def lods(ob, asset, targets):
    out = []
    t0 = tris(ob)
    for k, target in enumerate(targets):
        c = ob.copy()
        c.data = ob.data.copy()
        bpy.context.scene.collection.objects.link(c)
        c.name = c.data.name = f"{asset}__lod{k}"
        if t0 > target:
            mod = c.modifiers.new("dec", "DECIMATE")
            mod.ratio = target / t0
            mod.use_collapse_triangulate = True
            deselect()
            bpy.context.view_layer.objects.active = c
            c.select_set(True)
            bpy.ops.object.modifier_apply(modifier="dec")
        out.append(c)
        print(f"[props] {asset} lod{k}: {tris(c)} tris")
    bpy.data.objects.remove(ob)
    return out


def import_source(sid):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(DL, sid, f"{sid}_1k.gltf"))
    return [o for o in bpy.data.objects if o not in before]


def build_imported(asset):
    sid, keep, kind, targets = SOURCES[asset]
    objs = import_source(sid)
    mine = [o for o in objs if o.name.split(".")[0] in keep and o.type == "MESH"]
    for o in objs:
        if o not in mine:
            bpy.data.objects.remove(o)
    ob = join(mine, asset)
    dedupe_materials(ob)
    normalise(ob, kind, FIT.get(asset))
    return lods(ob, asset, targets)


def build_fire_escape(bottom):
    """One storey of the Poly Haven modular fire escape, assembled: platform + railing at floor
    level (top of the platform at z = 0), stairs (scaled to a 3.2 m storey) down to the platform
    below; the bottom module hangs the drop ladder instead of stairs. Back on the wall (y = 0)."""
    objs = import_source("modular_fire_escape")
    by = {o.name.split(".")[0]: o for o in objs}
    plat = by["modular_fire_escape_platform_bottom" if bottom else "modular_fire_escape_platform_middle"]
    rail = by["modular_fire_escape_railing_bottom" if bottom else "modular_fire_escape_railing_middle"]
    extra = by["modular_fire_escape_ladder_bottom" if bottom else "modular_fire_escape_stairs"]
    for o in objs:
        if o not in (plat, rail, extra):
            bpy.data.objects.remove(o)
    for o in (plat, rail, extra):
        deselect()
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    pmn, pmx = bbox(plat)
    cx, back, top = (pmn.x + pmx.x) / 2, pmx.y, pmx.z
    plat.data.transform(Matrix.Translation((-cx, -back, -top)))
    rmn, rmx = bbox(rail)
    rail.data.transform(Matrix.Translation((-(rmn.x + rmx.x) / 2, -rmx.y + 0.0, -rmn.z)))
    emn, emx = bbox(extra)
    if bottom:
        # drop ladder: 2.3 m long, hanging from the platform's outer edge, at its right end
        s = 2.3 / (emx.z - emn.z)
        extra.data.transform(Matrix.Translation((-(emn.x + emx.x) / 2, -(emn.y + emx.y) / 2, -emx.z)))
        extra.data.transform(Matrix.Diagonal((1, 1, s, 1)))
        extra.data.transform(Matrix.Translation((1.9, pmn.y - pmx.y + 0.1, -0.05)))
    else:
        s = 3.2 / (emx.z - emn.z)
        extra.data.transform(Matrix.Translation((-(emn.x + emx.x) / 2, -emx.y, -emx.z)))
        extra.data.transform(Matrix.Diagonal((1, 1, s, 1)))
        extra.data.transform(Matrix.Translation((0.4, -0.05, 0)))
    name = "fire_escape_bottom" if bottom else "fire_escape"
    ob = join([plat, rail, extra], name)
    dedupe_materials(ob)
    return lods(ob, name, (4000, 1500, 500))


def build_downpipe():
    """Rain downpipe, one 3.2 m storey per instance: Poly Haven gutter section stretched + coupler."""
    objs = import_source("modular_metal_gutter")
    by = {o.name.split(".")[0]: o for o in objs}
    sec, cpl = by["modular_metal_gutter_section"], by["modular_metal_gutter_coupler"]
    for o in objs:
        if o not in (sec, cpl):
            bpy.data.objects.remove(o)
    for o in (sec, cpl):
        deselect()
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    mn, mx = bbox(sec)
    sec.data.transform(Matrix.Translation((-(mn.x + mx.x) / 2, -(mn.y + mx.y) / 2, -mn.z)))
    sec.data.transform(Matrix.Diagonal((1, 1, 3.2 / (mx.z - mn.z), 1)))
    mn, mx = bbox(cpl)
    cpl.data.transform(Matrix.Translation((-(mn.x + mx.x) / 2, -(mn.y + mx.y) / 2, -mn.z + 3.0)))
    ob = join([sec, cpl], "downpipe")
    dedupe_materials(ob)
    mn, mx = bbox(ob)
    ob.data.transform(Matrix.Translation((0, -mx.y - 0.03, 0)))     # 3 cm off the wall
    return lods(ob, "downpipe", (400, 120, 40))


def tex_material(name, sid, metal=0.0, rough=None):
    """Material from a Poly Haven model's textures (diff / nor_gl / arm or metal-rough)."""
    m = bpy.data.materials.new(name)
    nt = m.node_tree
    b = nt.nodes["Principled BSDF"]
    d = os.path.join(DL, sid, "textures")
    files = os.listdir(d)
    def img(key):
        f = [x for x in files if key in x and "aged" not in x]
        return bpy.data.images.load(os.path.join(d, sorted(f)[0])) if f else None
    for key, sock, nonc in (("_diff_", "Base Color", False), ("_rough_", "Roughness", True)):
        im = img(key)
        if im:
            t = nt.nodes.new("ShaderNodeTexImage")
            t.image = im
            if nonc:
                im.colorspace_settings.name = "Non-Color"
            nt.links.new(t.outputs["Color"], b.inputs[sock])
    im = img("_nor_gl_")
    if im:
        im.colorspace_settings.name = "Non-Color"
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = im
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nt.links.new(t.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], b.inputs["Normal"])
    b.inputs["Metallic"].default_value = metal
    if rough is not None and not b.inputs["Roughness"].is_linked:
        b.inputs["Roughness"].default_value = rough
    return m


def flat(name, col, rough=0.6, metal=0.0, emission=None, strength=0.0):
    m = bpy.data.materials.new(name)
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*col, 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if emission:
        b.inputs["Emission Color"].default_value = (*emission, 1)
        b.inputs["Emission Strength"].default_value = strength
    return m


def build_street_lamp():
    """7 m street lamp: tapered pole on a cast base, curved arm 1.4 m toward +X, flat LED head
    (emissive lens underneath). Same envelope as the old procedural lamp (pole 7 m, head at the
    arm's end), so the exported light positions still match. LODs by segment count."""
    metal = tex_material("lamp_iron", "street_lamp_01", metal=0.6)
    lens = flat("lamp_lens", (1, 1, 1), rough=0.3, emission=(1.0, 0.86, 0.68), strength=20.0)
    out = []
    for k, seg in enumerate((16, 8, 5)):
        bm = bmesh.new()
        uv = bm.loops.layers.uv.new("UVMap")
        def cyl(r0, r1, z0, z1, seg=seg, cx=0.0, cy=0.0, caps=False):
            res = bmesh.ops.create_cone(bm, cap_ends=caps, segments=seg, radius1=r0, radius2=r1, depth=z1 - z0, calc_uvs=True)
            for v in res["verts"]:
                v.co = Vector((v.co.x + cx, v.co.y + cy, v.co.z + (z0 + z1) / 2))
        cyl(0.2, 0.17, 0.0, 0.08, caps=True)            # base plate
        cyl(0.16, 0.12, 0.08, 0.7)                      # cast base sleeve
        cyl(0.11, 0.07, 0.7, 6.95)                      # tapered pole
        # curved arm: a tube along a quarter circle rising from the pole top and bending to +X
        steps = (10, 5, 3)[k]
        ring = (8, 6, 4)[k]
        R = 0.6
        prev = None
        for i in range(steps + 1):
            a = (math.pi / 2) * i / steps
            c = Vector((R - R * math.cos(a), 0, 6.6 + R * math.sin(a)))       # centreline
            if i == steps:
                c = Vector((R, 0, 6.6 + R))
            tang = Vector((math.sin(a), 0, math.cos(a)))
            side = Vector((0, 1, 0))
            nrm = tang.cross(side)
            vs = []
            for j in range(ring):
                t = 2 * math.pi * j / ring
                vs.append(bm.verts.new(c + (side * math.cos(t) + nrm * math.sin(t)) * 0.045))
            if prev:
                for j in range(ring):
                    bm.faces.new((prev[j], prev[(j + 1) % ring], vs[(j + 1) % ring], vs[j]))
            prev = vs
        # straight arm from the bend to the head
        x0, x1, z = R, 1.4, 6.6 + R
        res = bmesh.ops.create_cone(bm, cap_ends=False, segments=ring, radius1=0.045, radius2=0.04, depth=x1 - x0)
        rot = Matrix.Rotation(math.pi / 2, 4, "Y")
        for v in res["verts"]:
            v.co = rot @ v.co + Vector(((x0 + x1) / 2, 0, z))
        bm.normal_update()
        me = bpy.data.meshes.new(f"street_lamp__lod{k}")
        bm.to_mesh(me)
        bm.free()
        me.materials.append(metal)
        me.materials.append(lens)
        # head: a slim housing (metal) with the lens underneath (material 1)
        hb = bmesh.new()
        res = bmesh.ops.create_cube(hb, size=1.0)
        for v in res["verts"]:
            v.co = Vector((1.45 + v.co.x * 0.62, v.co.y * 0.26, 6.6 + R + 0.02 + v.co.z * 0.11))
        if k == 0:
            bmesh.ops.bevel(hb, geom=list(hb.edges), offset=0.03, segments=2, affect="EDGES")
        hb.normal_update()
        for f in hb.faces:
            if f.normal.z < -0.9:
                f.material_index = 1
        hme = bpy.data.meshes.new("head_tmp")
        hb.to_mesh(hme)
        hb.free()
        tmp = bpy.data.objects.new("head_tmp", hme)
        ob = bpy.data.objects.new(me.name, me)
        bpy.context.scene.collection.objects.link(ob)
        bpy.context.scene.collection.objects.link(tmp)
        hme.materials.append(metal)
        hme.materials.append(lens)
        deselect()
        ob.select_set(True)
        tmp.select_set(True)
        bpy.context.view_layer.objects.active = ob
        bpy.ops.object.join()
        ob.name = ob.data.name = f"street_lamp__lod{k}"
        for p in ob.data.polygons:
            p.use_smooth = True
        print(f"[props] street_lamp lod{k}: {tris(ob)} tris")
        out.append(ob)
    return out


def build_sill():
    """Stone window sill (TOP at z = 0, back on the wall): 1.5 m wide for a 3 m bay (stretched with
    the bay by the instance's sx). LOD0 has a chamfered nose and a drip lip; LOD1 is a box."""
    stone = flat("sill_stone", (0.5, 0.48, 0.45), rough=0.7)
    out = []
    for k in range(2):
        bm = bmesh.new()
        prof = [(0, 0), (-0.13, 0), (-0.15, -0.02), (-0.15, -0.06), (-0.12, -0.075), (0, -0.075)] if k == 0 else \
               [(0, 0), (-0.15, 0), (-0.15, -0.07), (0, -0.07)]
        L, R = [], []
        for y, z in prof:
            L.append(bm.verts.new((-0.75, y, z)))
            R.append(bm.verts.new((0.75, y, z)))
        n = len(prof)
        for i in range(n - 1):
            bm.faces.new((L[i], L[i + 1], R[i + 1], R[i]))
        bm.faces.new(list(reversed(L)))
        bm.faces.new(R)
        bm.normal_update()
        for f in bm.faces:
            if f.normal.y > 0.5:          # never visible (against the wall)
                bm.faces.remove(f)
        me = bpy.data.meshes.new(f"window_sill__lod{k}")
        bm.to_mesh(me)
        bm.free()
        me.materials.append(stone)
        ob = bpy.data.objects.new(me.name, me)
        bpy.context.scene.collection.objects.link(ob)
        print(f"[props] window_sill lod{k}: {tris(ob)} tris")
        out.append(ob)
    return out


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    built = {}
    built["street_lamp"] = build_street_lamp()
    built["window_sill"] = build_sill()
    for a in SOURCES:
        built[a] = build_imported(a)
    built["fire_escape"] = build_fire_escape(False)
    built["fire_escape_bottom"] = build_fire_escape(True)
    built["downpipe"] = build_downpipe()
    keep = {o for objs in built.values() for o in objs}
    for o in list(bpy.data.objects):
        if o not in keep:
            bpy.data.objects.remove(o)
    for o in keep:                       # all at the origin, nothing parented
        o.location = (0, 0, 0)
        o.rotation_euler = (0, 0, 0)
        o.scale = (1, 1, 1)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", export_apply=True, export_yup=True, export_lights=False)
    print("[props] exported", OUT, len(keep), "LOD meshes")


main()
