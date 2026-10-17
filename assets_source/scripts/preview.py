"""Quick turntable-style preview renders of a .blend (Eevee), for checking shapes without Godot.
Run: tools/blender/blender -b <file.blend> --python assets_source/scripts/preview.py -- <out_prefix> [views]
"""
import bpy
import math
import sys
from mathutils import Vector

args = sys.argv[sys.argv.index("--") + 1:]
prefix = args[0]
views = args[1].split(",") if len(args) > 1 else ["front34", "side", "rear34", "top"]

sc = bpy.context.scene
sc.render.engine = "BLENDER_EEVEE"
sc.render.resolution_x, sc.render.resolution_y = 960, 540
sc.render.film_transparent = False
w = bpy.data.worlds.new("w")
w.use_nodes = True
w.node_tree.nodes["Background"].inputs[0].default_value = (0.35, 0.38, 0.42, 1)
w.node_tree.nodes["Background"].inputs[1].default_value = 1.0
sc.world = w
bpy.ops.mesh.primitive_plane_add(size=40)
bpy.context.active_object.data.materials.append(bpy.data.materials.get("underbody"))
sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
sun.data.energy = 3.0
sun.rotation_euler = (math.radians(50), 0, math.radians(30))
sc.collection.objects.link(sun)
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
cam.data.lens = 50
sc.collection.objects.link(cam)
sc.camera = cam
target = Vector((0, 0, 0.55))
spots = {
    "front34": (4.6, -5.6, 1.6), "side": (7.5, 0.0, 0.9), "rear34": (-4.6, 5.6, 1.9),
    "top": (0.01, 0.0, 9.5), "front": (0.0, -8.0, 0.8), "wheel": (2.6, -2.6, 0.6),
}
for v in views:
    cam.location = Vector(spots[v])
    t = target if v != "wheel" else Vector((0.8, -1.3, 0.33))
    cam.rotation_euler = (t - cam.location).to_track_quat("-Z", "Y").to_euler()
    if v == "wheel":
        cam.data.lens = 70
    sc.render.filepath = f"{prefix}_{v}.png"
    bpy.ops.render.render(write_still=True)
