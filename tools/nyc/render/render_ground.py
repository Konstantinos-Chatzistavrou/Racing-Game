"""Blender headless preview of ground tiles (Workbench, flat colour per material name).
blender -b -P render_ground.py -- OUT.png mode cx cy size [tiles_dir] [yaw pitch]
mode: top (orthographic, size = view width in m) or persp (look-at cx cy, size = distance, yaw/pitch degrees)."""
import bpy, sys, os, glob, math
from mathutils import Vector
a = sys.argv[sys.argv.index("--") + 1:]
out, mode, cx, cy, size = a[0], a[1], float(a[2]), float(a[3]), float(a[4])
d = a[5] if len(a) > 5 else "web/public/assets/nyc/tiles"
yaw, pitch = (float(a[6]), float(a[7])) if len(a) > 7 else (0.0, 35.0)
bpy.ops.wm.read_factory_settings(use_empty=True)
COL = {"road": (0.16, 0.16, 0.17), "sidewalk": (0.55, 0.55, 0.52), "curb": (0.9, 0.9, 0.85), "marking": (1, 0.85, 0.2), "crosswalk": (1, 1, 1),
       "plaza": (0.7, 0.5, 0.4), "grass": (0.2, 0.5, 0.2), "water": (0.1, 0.25, 0.6), "rail": (0.4, 0.2, 0.1)}
half = size / 2 if mode == "top" else size
for f in glob.glob(os.path.join(d, "*.ground.glb")):
    ix, iy = [int(v) for v in os.path.basename(f).split(".")[0].split("_")]
    if abs((ix + .5) * 256 - cx) < half + 300 and abs((iy + .5) * 256 - cy) < half + 300:
        bpy.ops.import_scene.gltf(filepath=f)
for m in bpy.data.materials:
    c = COL.get(m.name.split(".")[0], (1, 0, 1))
    m.diffuse_color = (*c, 1)
cam = bpy.data.cameras.new("c"); co = bpy.data.objects.new("c", cam)
bpy.context.scene.collection.objects.link(co); bpy.context.scene.camera = co
if mode == "top":
    cam.type = "ORTHO"; cam.ortho_scale = size; co.location = (cx, cy, 500); co.rotation_euler = (0, 0, 0)
else:
    cam.type = "PERSP"; cam.lens = 28
    yr, pr = math.radians(yaw), math.radians(pitch)
    off = Vector((math.sin(yr) * math.cos(pr), -math.cos(yr) * math.cos(pr), math.sin(pr))) * size
    co.location = Vector((cx, cy, 0)) + off
    co.rotation_euler = (Vector((cx, cy, 0)) - co.location).to_track_quat("-Z", "Y").to_euler()
cam.clip_end = 5000
sc = bpy.context.scene
sc.render.engine = "BLENDER_WORKBENCH"
sc.display.shading.light = "STUDIO"; sc.display.shading.color_type = "MATERIAL"
sc.render.resolution_x = 1400; sc.render.resolution_y = 1000; sc.render.filepath = out
sc.view_settings.view_transform = "Standard"
sc.world = bpy.data.worlds.new("w"); sc.world.color = (0.5, 0.6, 0.8)
bpy.ops.render.render(write_still=True)
