"""Shared Blender helpers for the car builds that start from downloaded (CC BY) models: make_car4.py ...

Not run on its own. A per-car script does `sys.path.insert(0, <this dir>); from carlib import *`.
Conventions (Blender axes): the source car faces -Y, +X is the car's LEFT, Z up, like the game's model space
(web/src/scene/car.ts: wheel_FL/FR/RL/RR empties at the hubs, caliper_* empties that steer but do not spin).
"""
import bpy
import bmesh
import math

import numpy as np
from mathutils import Matrix, Vector


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


def standard_materials():
    """The flat PBR set every derived car uses. 'paint' and 'glass' are names the game looks for."""
    return {
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


def sstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def meshes():
    return [o for o in bpy.data.objects if o.type == "MESH"]


def mat_key(o):
    return o.data.materials[0].name.split(".")[0] if o.data.materials and o.data.materials[0] else ""


def by_material():
    d = {}
    for o in meshes():
        d.setdefault(mat_key(o), []).append(o)
    return d


def remove(o):
    bpy.data.objects.remove(o, do_unlink=True)


def select_only(objs):
    for s in bpy.data.objects:
        s.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]


def separate_loose(o):
    select_only([o])
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.separate(type="LOOSE")
    bpy.ops.object.mode_set(mode="OBJECT")


def join(objs, name):
    select_only(objs)
    bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    o.name = name
    o.data.name = name
    return o


def world_coords(o):
    me = o.data
    n = len(me.vertices)
    co = np.empty(n * 3, dtype=np.float32)
    me.vertices.foreach_get("co", co)
    co = co.reshape(n, 3)
    w = np.array(o.matrix_world)
    return co @ w[:3, :3].T + w[:3, 3]


def set_world_coords(o, wp):
    w = np.array(o.matrix_world)
    local = (wp - w[:3, 3]) @ np.linalg.inv(w[:3, :3]).T
    o.data.vertices.foreach_set("co", local.astype(np.float32).ravel())
    o.data.update()


def bbox(objs):
    pts = np.concatenate([world_coords(o) for o in objs])
    return pts.min(axis=0), pts.max(axis=0)


def _face_centers(o):
    me = o.data
    n = len(me.polygons)
    c = np.empty(n * 3, dtype=np.float32)
    me.polygons.foreach_get("center", c)
    c = c.reshape(n, 3)
    w = np.array(o.matrix_world)
    return c @ w[:3, :3].T + w[:3, 3]


def delete_faces(o, pred):
    """Delete the faces whose world-space centre satisfies pred(c: (N,3) array) -> bool mask. Returns False if the object is empty after."""
    mask = pred(_face_centers(o))
    if not mask.any():
        return True
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bm.faces.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[bm.faces[i] for i in np.nonzero(mask)[0]], context="FACES")
    bm.to_mesh(o.data)
    bm.free()
    return len(o.data.polygons) > 0


def split_faces(o, pred, name):
    """Move the faces matching pred into a new object `name` (same materials). Returns it, or None if nothing matched."""
    mask = pred(_face_centers(o))
    if not mask.any():
        return None
    new = o.copy()
    new.data = o.data.copy()
    new.name = name
    bpy.context.scene.collection.objects.link(new)
    delete_faces(new, lambda c: ~pred(c))
    delete_faces(o, pred)
    return new


def add_box(name, material, center, size, rot_deg=(0, 0, 0)):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    o.scale = size
    o.rotation_euler = [math.radians(a) for a in rot_deg]
    o.location = center
    o.data.materials.append(material)
    bpy.context.scene.collection.objects.link(o)
    bpy.context.view_layer.update()
    # bake the transform into the vertices so the object sits at the origin with identity transform
    me.transform(o.matrix_world)
    o.matrix_world = Matrix.Identity(4)
    return o


def empty(name, loc=(0, 0, 0)):
    e = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(e)
    e.location = loc
    return e


def adopt(parent, objs):
    """Parent objs to `parent` keeping their world transform (both must have a current matrix_world)."""
    bpy.context.view_layer.update()
    inv = parent.matrix_world.inverted()
    for o in objs:
        mw = o.matrix_world.copy()
        o.parent = parent
        o.matrix_parent_inverse = inv
        o.matrix_world = mw
