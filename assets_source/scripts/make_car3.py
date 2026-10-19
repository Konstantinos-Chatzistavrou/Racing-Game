"""Car generation 3 ("Vela GT"): a de-branded, re-styled derivative of the Khronos "Car Concept".

Run:  assets_source/scripts/build_car3.sh   (downloads nothing; expects the source GLB, see
      docs/car_model_v3.md), or directly:
      tools/blender/blender -b --factory-startup --python assets_source/scripts/make_car3.py -- \
          <CarConcept.glb> <out_dir>
Out:  <out_dir>/vela_gt_hero_raw.glb, <out_dir>/vela_gt_traffic_raw.glb (uncompressed, PNG
      textures); build_car3.sh then compresses them with gltf-transform (meshopt + KTX2).

SOURCE AND LICENCE: "Car Concept" by Eric Chadwick, (c) 2024 Darmstadt Graphics Group GmbH, Khronos
glTF Sample Assets, CC BY 4.0 (itself based on Unity Fan's CC0 "FREE Concept Car 004"). CC BY
requires saying what we changed: everything this script does is listed in docs/car_model_v3.md.
The Khronos and 3D Commerce marks are NOT covered by the CC BY licence ("This license excludes
logos and associated trademarks"), so every logo, badge and text is removed here, meshes AND
textures:
  - Khronos_C.png (the Khronos logo) was the emissive map of 7 materials (calipers, rims, mirror
    glass, gaskets, hardware...) and the licence plate's colour map: unlinked everywhere, plate
    replaced by our own (bitmap-font "VELA GT", drawn below);
  - Tireside_C.png / Tireside_N.png carry the Khronos and 3D Commerce logos and tyre lettering
    (DOT code, size, "OUTSIDE", ...): replaced by a flat colour and our own procedural sidewall;
  - Dash_E.png (dashboard with English labels): replaced by a procedural, text-free cluster;
  - the steering-wheel emblem mesh is deleted.

WHAT MAKES IT OURS (design changes, all procedural so the build is reproducible):
  - proportions: scaled 0.86 (width) x 0.946 (length, height) so the wheelbase is exactly the
    physics car's 2.65 m and the width a road car's 1.92 m (the concept is 2.24 m wide);
  - new front: a wide trapezoid lower intake with horizontal blades and a carbon splitter (the
    concept has a smooth nose), its old headlight slit turned into a smoked accent line, new
    three-bar ("tri-dash") LED daytime lights and separate projector lenses;
  - new rear: full-width light bar with C-shaped end blades (the concept: two short lamps on the
    deck edge), diffuser fins, our own plate, and a rear wing on two uprights;
  - side skirt blades; gloss-black roof/cladding (two-tone scheme), bronze calipers;
  - new wheels: our own 5-twin-spoke directional rim (the concept's rims are deleted).

GAME CONTRACT (web/src/scene/car.ts, damage.ts, ai.ts; data/cars/vela_gt.visual.json):
  model space X = car's left, Y up, Z forward (Blender: X left, -Y forward, Z up; the glTF export
  converts), origin on the ground at the body's length centre.
  wheel_FL/FR/RL/RR: empties at the hub (identity rotation, spin about X), holding tyre, rim, disc;
  caliper_FL...: empties at the hub holding the caliper (steers, never spins);
  bumper_front, bumper_rear, mirror_L, mirror_R: detachable parts; drl_L/R + beam_L/R (front
  lights), taillight_bar (rear lights); glass; interior_* (never dented); paint material 'paint'.
"""
import bpy
import bmesh
import math
import os
import sys

import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

args = sys.argv[sys.argv.index("--") + 1:]
SRC, OUT = args[0], args[1]
os.makedirs(OUT, exist_ok=True)

# Proportions (see docstring). Pivot = source body length centre on the ground.
SX, SY, SZ = 0.86, 0.946, 0.946
# Visual tyre radius. Physics: 0.327 m (data/cars/vela_gt.json). Shrinking the source tyre all the
# way left it lost in its arches; 0.345 m sinks ~2 cm into the road at the contact patch, which
# reads as tyre deflection.
TYRE_R = 0.345
PAINT = (0.55, 0.03, 0.02)

# ---------------------------------------------------------------------------------- helpers ----

def objs():
    return [o for o in bpy.data.objects if o.type == "MESH"]


def select(obs, active=None):
    bpy.ops.object.select_all(action="DESELECT")
    for o in obs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active or (obs[0] if obs else None)


def rename(ob, name):
    ob.name = name
    if ob.data:
        ob.data.name = name
    return ob


def delete(names):
    for n in names:
        ob = bpy.data.objects.get(n)
        if ob:
            bpy.data.objects.remove(ob, do_unlink=True)


def join(names, new_name):
    obs = [bpy.data.objects[n] for n in names if n in bpy.data.objects]
    select(obs, obs[0])
    bpy.ops.object.join()
    return rename(bpy.context.view_layer.objects.active, new_name)


def tris(ob):
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)


def principled(mat):
    return next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")


def unlink_input(mat, socket_name):
    """Remove whatever is plugged into a Principled input (and the image node feeding it)."""
    bsdf = principled(mat)
    for link in list(bsdf.inputs[socket_name].links):
        src = link.from_node
        mat.node_tree.links.remove(link)
        if src.type in ("TEX_IMAGE", "MIX", "MIX_RGB") and not any(o.links for o in src.outputs):
            mat.node_tree.nodes.remove(src)


def no_emission(mat):
    """The Khronos logo was wired in as an emissive texture: cut it, black emission."""
    unlink_input(mat, "Emission Color")
    bsdf = principled(mat)
    bsdf.inputs["Emission Color"].default_value = (0, 0, 0, 1)
    bsdf.inputs["Emission Strength"].default_value = 0.0


def new_mat(name, color=(0.5, 0.5, 0.5), metallic=0.0, rough=0.5, coat=0.0, coat_rough=0.03,
            emission=None, strength=1.0, alpha=1.0, double=False):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = principled(m)
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Metallic"].default_value = metallic
    b.inputs["Roughness"].default_value = rough
    b.inputs["Coat Weight"].default_value = coat
    b.inputs["Coat Roughness"].default_value = coat_rough
    if emission:
        b.inputs["Emission Color"].default_value = (*emission, 1)
        b.inputs["Emission Strength"].default_value = strength
    if alpha < 1:
        b.inputs["Alpha"].default_value = alpha
        m.surface_render_method = "BLENDED"
    m.use_backface_culling = not double
    return m


def image_from_array(name, rgb, non_color=False):
    """numpy (h, w, 3|4) float 0..1, row 0 = TOP -> saved PNG, loaded as a Blender image."""
    h, w = rgb.shape[:2]
    if rgb.shape[2] == 3:
        rgb = np.concatenate([rgb, np.ones((h, w, 1))], axis=2)
    img = bpy.data.images.new(name, w, h, alpha=False)
    img.pixels.foreach_set(np.ascontiguousarray(rgb[::-1]).astype(np.float32).ravel())
    path = os.path.join(OUT, name + ".png")
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)
    img = bpy.data.images.load(path)
    if non_color:
        img.colorspace_settings.name = "Non-Color"
    return img


def set_image(mat, socket_name, img, normal=False, uv_map=None):
    """Plug an image into a Principled input (through a Normal Map node for normals)."""
    nt = mat.node_tree
    bsdf = principled(mat)
    unlink_input(mat, socket_name)
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    if normal:
        nm = next((n for n in nt.nodes if n.type == "NORMAL_MAP"), None) or nt.nodes.new("ShaderNodeNormalMap")
        nt.links.new(tex.outputs["Color"], nm.inputs["Color"])
        if not nm.outputs["Normal"].links:
            nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    else:
        nt.links.new(tex.outputs["Color"], bsdf.inputs[socket_name])
    return tex


def smooth_by_angle(bm, angle=0.6):
    for f in bm.faces:
        f.smooth = True
    for e in bm.edges:
        if len(e.link_faces) != 2 or e.calc_face_angle(0) > angle:
            e.smooth = False


def bm_object(bm, name, mats):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    for m in mats:
        me.materials.append(m)
    return ob


# ----------------------------------------------------------------------- procedural textures ----

FONT = {   # 5x7 bitmap glyphs drawn for this project (our own "VELA GT" plate)
    "V": ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
    "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
    "L": ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
    "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
    "G": ["01110", "10001", "10000", "10111", "10001", "10001", "01111"],
    "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
    " ": ["00000"] * 7,
}


def plate_texture():
    w, h = 512, 128
    img = np.ones((h, w, 3)) * np.array([0.86, 0.87, 0.84])
    img[:5] = img[-5:] = img[:, :5] = img[:, -5:] = 0.05                 # border
    text, cell = "VELA GT", 11
    x = (w - len(text) * 6 * cell + cell) // 2
    y0 = (h - 7 * cell) // 2
    for ch in text:
        for r, row in enumerate(FONT[ch]):
            for c, bit in enumerate(row):
                if bit == "1":
                    img[y0 + r * cell:y0 + (r + 1) * cell - 1, x + c * cell:x + (c + 1) * cell - 1] = (0.03, 0.04, 0.08)
        x += 6 * cell
    return image_from_array("vela_plate", img)


def dash_texture():
    """Text-free instrument cluster (emissive mask): frame, three bar gauges, a tacho arc."""
    w, h = 1024, 256
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    m = np.zeros((h, w))
    # trapezoid frame outline
    def inside(x, y, inset):
        top, bot = 20 + inset, h - 20 - inset
        lx = 150 + inset - (y - top) / (bot - top) * 120
        rx = w - 150 - inset + (y - top) / (bot - top) * 120
        return (y > top) & (y < bot) & (x > lx) & (x < rx)
    m[inside(xx, yy, 0) & ~inside(xx, yy, 6)] = 1
    # bar gauges (fuel, revs, temperature): stacks of cells
    for gx, n in ((200, 9), (260, 12), (850, 9)):
        for i in range(n):
            y = h - 50 - i * 14
            m[(xx > gx) & (xx < gx + 40) & (yy > y - 10) & (yy < y)] = 0.35 + 0.65 * (i < n * 0.6)
    # tacho arc: 40 ticks on a 220 deg arc around the centre, the first 60 % lit
    cx, cy, r0, r1 = w / 2, h * 0.62, 70, 100
    a = np.degrees(np.arctan2(cy - yy, xx - cx))
    rr = np.hypot(xx - cx, yy - cy)
    t = (200 - a) / 220
    tick = (np.abs(((t * 40) % 1) - 0.5) > 0.3) & (t > 0) & (t < 1) & (rr > r0) & (rr < r1)
    m[tick] = np.where(t[tick] < 0.6, 1.0, 0.3)
    m[(np.abs(rr - 55) < 3)] = 0.6                                              # centre ring
    return image_from_array("vela_dash", np.repeat(m[..., None], 3, axis=2))


def sidewall_normal():
    """Our tyre sidewall: concentric bead rings + 72 short radial ribs, no lettering. The source
    UVs map the sidewall to the ring r = 0.76..0.99 (of the half-size) around the image centre."""
    n = 1024
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    u, v = (xx + 0.5) / n * 2 - 1, (yy + 0.5) / n * 2 - 1
    r = np.hypot(u, v)
    ang = np.arctan2(v, u)
    bump = lambda c, wdt: np.exp(-((r - c) / wdt) ** 2)
    hgt = 0.6 * bump(0.785, 0.008) + 0.6 * bump(0.80, 0.006) + 0.9 * bump(0.955, 0.012) + 0.4 * bump(0.975, 0.004)
    ribs = (np.cos(ang * 72) > 0.6) & (r > 0.84) & (r < 0.90)
    hgt += 0.5 * ribs * np.clip(1 - np.abs(r - 0.87) / 0.03, 0, 1)
    band = np.clip((r - 0.905) / 0.01, 0, 1) * np.clip((0.935 - r) / 0.01, 0, 1)   # raised band
    hgt += 0.35 * band
    gy, gx = np.gradient(hgt)
    k = 6.0
    nx, ny, nz = -gx * k, gy * k, np.ones_like(hgt)         # +Y up in the image (glTF convention)
    ln = np.sqrt(nx * nx + ny * ny + nz * nz)
    return image_from_array("vela_tyre_side_n", np.stack([nx / ln, ny / ln, nz / ln], axis=2) * 0.5 + 0.5, non_color=True)


# ---------------------------------------------------------------------- projected details ----

class Surface:
    """Ray-cast target made of several (transform-applied) mesh objects."""

    def __init__(self, names):
        dg = bpy.context.evaluated_depsgraph_get()
        self.trees = [BVHTree.FromObject(bpy.data.objects[n], dg) for n in names]

    def hit(self, origin, direction):
        best = None
        for t in self.trees:
            loc, nor, _, dist = t.ray_cast(Vector(origin), Vector(direction))
            if loc is not None and (best is None or dist < best[2]):
                best = (loc, nor, dist)
        return best

    def hit_uv(self, plane, u, v, direction):
        """Hit at plane(u, v); on a miss (a seam between two source meshes) nudge toward u = 0
        a few mm at a time: a detail edge landing exactly on a gap must not abort the build."""
        for k in range(12):
            h = self.hit(plane(u * (1 - 0.004 * k), v), direction)
            if h:
                return h
        return None


def projected_bar(surf, pts2d, width, plane, direction, off_top, off_base, name, mat, n=24):
    """A raised strip following the polyline pts2d (in the projection plane), ray-cast onto the
    body: top face at off_top above the surface, side walls down to off_base (below it), so it
    reads as a real part from any angle. plane maps (u, v) -> ray origin."""
    # resample the polyline evenly
    seg = [(Vector(a), Vector(b)) for a, b in zip(pts2d[:-1], pts2d[1:])]
    total = sum((b - a).length for a, b in seg)
    samples = []
    for i in range(n + 1):
        d = total * i / n
        for a, b in seg:
            L = (b - a).length
            if d <= L + 1e-9:
                p = a.lerp(b, d / L if L else 0)
                tdir = (b - a).normalized()
                break
            d -= L
        samples.append((p, Vector((-tdir.y, tdir.x))))
    bm = bmesh.new()
    rows = []
    for p, nrm in samples:
        row = []
        for s in (-0.5, 0.5):
            q = p + nrm * (s * width)
            h = surf.hit_uv(plane, q.x, q.y, direction)
            if h is None:
                return None
            loc, sn, _ = h
            row.append((bm.verts.new(loc + sn * off_top), bm.verts.new(loc + sn * off_base)))
        rows.append(row)
    for a, b in zip(rows[:-1], rows[1:]):
        bm.faces.new((a[0][0], a[1][0], b[1][0], b[0][0]))       # top
        bm.faces.new((a[0][1], a[0][0], b[0][0], b[0][1]))       # wall
        bm.faces.new((a[1][0], a[1][1], b[1][1], b[1][0]))       # wall
    for r in (rows[0], rows[-1]):                                # end caps
        bm.faces.new((r[0][1], r[1][1], r[1][0], r[0][0]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    smooth_by_angle(bm, 0.7)
    return bm_object(bm, name, [mat])


def projected_patch(surf, quad, nu, nv, plane, direction, off, name, mat):
    """Grid patch inside the bilinear quad (4 (u, v) corners), ray-cast onto the body."""
    bm = bmesh.new()
    grid = []
    for j in range(nv + 1):
        row = []
        for i in range(nu + 1):
            s, t = i / nu, j / nv
            a = Vector(quad[0]).lerp(Vector(quad[1]), s)
            b = Vector(quad[3]).lerp(Vector(quad[2]), s)
            q = a.lerp(b, t)
            h = surf.hit_uv(plane, q.x, q.y, direction)
            row.append(bm.verts.new(h[0] + h[1] * off))
        grid.append(row)
    for j in range(nv):
        for i in range(nu):
            bm.faces.new((grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for f in bm.faces:
        f.smooth = True
    return bm_object(bm, name, [mat])


def box(name, mat, corners_fn, smooth=False):
    """8-corner box from a function (i, j, k) -> Vector."""
    bm = bmesh.new()
    v = {(i, j, k): bm.verts.new(corners_fn(i, j, k)) for i in (0, 1) for j in (0, 1) for k in (0, 1)}
    for f in (((0, 0, 0), (0, 1, 0), (1, 1, 0), (1, 0, 0)), ((0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)),
              ((0, 0, 0), (1, 0, 0), (1, 0, 1), (0, 0, 1)), ((0, 1, 0), (0, 1, 1), (1, 1, 1), (1, 1, 0)),
              ((0, 0, 0), (0, 0, 1), (0, 1, 1), (0, 1, 0)), ((1, 0, 0), (1, 1, 0), (1, 1, 1), (1, 0, 1))):
        bm.faces.new([v[c] for c in f])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    smooth_by_angle(bm, 0.5 if smooth else 0.0)
    return bm_object(bm, name, [mat])


# --------------------------------------------------------------------------------- the rim ----

def build_rim(name, side, hub, r_seat, half_w, mats, seg=64, spoke_seg=6):
    """Our wheel: 5 twin spokes with a slight directional sweep, concave dish, machined lip,
    5 lug nuts and a plain centre cap. Axle along X; side = +1 (outer face toward +X) / -1."""
    rim, lip = 0, 1
    bm = bmesh.new()
    s = side

    def P(x, r, a):   # axial x (outward positive), radius, angle -> world
        return Vector((hub.x + s * x, hub.y + r * math.cos(a), hub.z + r * math.sin(a)))

    def revolve(profile, mat_idx, n):
        rings = [[bm.verts.new(P(x, r, 2 * math.pi * i / n)) for i in range(n)] for x, r in profile]
        for a, b in zip(rings[:-1], rings[1:]):
            for i in range(n):
                f = bm.faces.new((a[i], a[(i + 1) % n], b[(i + 1) % n], b[i]))
                f.material_index = mat_idx
    xo = half_w * 0.92
    # barrel (seen through the spokes) + lip, one revolved profile from the inboard edge outward
    revolve([(-half_w * 0.9, r_seat - 0.004), (xo - 0.03, r_seat - 0.004), (xo - 0.010, r_seat - 0.014)], rim, seg)
    revolve([(xo - 0.010, r_seat - 0.014), (xo, r_seat - 0.010), (xo + 0.002, r_seat + 0.004), (xo - 0.004, r_seat + 0.010)], lip, seg)
    # hub face + centre cap
    face_x0 = xo - 0.06
    revolve([(face_x0 - 0.01, 0.092), (face_x0, 0.088), (face_x0 + 0.004, 0.05), (face_x0 + 0.012, 0.036),
             (face_x0 + 0.016, 0.02), (face_x0 + 0.017, 0.0005)], rim, max(24, seg // 2))
    # spokes: 5 pairs, each spoke a 3-sided beam (top + 2 sides) from the hub to the lip
    for k in range(5):
        a0 = 2 * math.pi * k / 5
        for sgn in (-1, 1):
            rows = []
            for i in range(spoke_seg + 1):
                t = i / spoke_seg
                r = 0.08 + (r_seat - 0.016 - 0.08) * t
                ang = a0 + sgn * math.radians(4 + 9 * t) + math.radians(6) * t * t     # sweep
                wdt = (0.030 - 0.008 * t) / r                                          # half-width (rad)
                x_top = face_x0 + 0.004 + (xo - 0.016 - face_x0) * (1 - (1 - t) ** 2)  # concave dish
                x_bot = x_top - 0.032
                rows.append([bm.verts.new(P(x_bot, r, ang - wdt)), bm.verts.new(P(x_top, r * 0.995, ang - wdt * 0.8)),
                             bm.verts.new(P(x_top, r * 0.995, ang + wdt * 0.8)), bm.verts.new(P(x_bot, r, ang + wdt))])
            for a, b in zip(rows[:-1], rows[1:]):
                for j in range(3):
                    bm.faces.new((a[j], a[j + 1], b[j + 1], b[j])).material_index = rim
    # lug nuts (hexagonal, machined)
    for k in range(5):
        a = 2 * math.pi * (k + 0.5) / 5
        c_r = 0.062
        cy, cz = c_r * math.cos(a), c_r * math.sin(a)
        ring_in, ring_out = [], []
        for i in range(6):
            b = 2 * math.pi * i / 6
            dy, dz = 0.011 * math.cos(b), 0.011 * math.sin(b)
            ring_in.append(bm.verts.new((hub.x + s * (face_x0 + 0.002), hub.y + cy + dy, hub.z + cz + dz)))
            ring_out.append(bm.verts.new((hub.x + s * (face_x0 + 0.016), hub.y + cy + dy * 0.8, hub.z + cz + dz * 0.8)))
        for i in range(6):
            bm.faces.new((ring_in[i], ring_in[(i + 1) % 6], ring_out[(i + 1) % 6], ring_out[i])).material_index = lip
        bm.faces.new(ring_out).material_index = lip
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    smooth_by_angle(bm, 0.55)
    return bm_object(bm, name, mats)


# ===================================================================================== main ====

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)

HUBS = {tag: bpy.data.objects[src].matrix_world.translation.copy()
        for tag, src in (("FL", "WheelFrontL"), ("FR", "WheelFrontR"), ("RL", "WheelRearL"), ("RR", "WheelRearR"))}

# flatten: every mesh in world space, no parents, single-user data
select(objs())
bpy.ops.object.make_single_user(object=True, obdata=True)
bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
for o in [o for o in bpy.data.objects if o.type != "MESH"]:
    bpy.data.objects.remove(o, do_unlink=True)
# drop the source's KHR_materials_variants (Pearl/Graphite paints): one paint, recoloured in game
sc = bpy.context.scene
if hasattr(sc, "gltf2_KHR_materials_variants_variants"):
    sc.gltf2_KHR_materials_variants_variants.clear()
for me in bpy.data.meshes:
    if hasattr(me, "gltf2_variant_mesh_data"):
        me.gltf2_variant_mesh_data.clear()
    if hasattr(me, "gltf2_variant_default_materials"):
        me.gltf2_variant_default_materials.clear()
select(objs())
bpy.ops.object.material_slot_remove_unused()

# ---- de-brand + remove: wipers (24k triangles, and one less concept-car signature), the emblem,
# the logo licence plate, the concept's taillights and rims (replaced by ours below)
delete(["BodyWindshieldWipers", "BodyWindshieldWipersBase", "InteriorSteeringEmblem", "License Plate",
        "BodyTaillights", "WheelFrontLRim", "WheelFrontRRim", "WheelRearLRim", "WheelRearRRim"])

# ---- materials: rename to game names, cut every logo texture, our colour scheme
M = bpy.data.materials
for old, new in (("Paint 1 Carmine", "paint"), ("Paint 2 Carmine", "trim"), ("Glass", "glass"),
                 ("Material_2", "rubber"), ("Hardware", "hardware"), ("Mirror", "mirror_glass"),
                 ("Brake", "caliper"), ("Headlight", "light_smoked"), ("Signallight", "light_signal"),
                 ("Dashboard", "dash"), ("Tireside", "tyre_side"), ("Tiretread", "tyre_tread"),
                 ("Disc", "disc"), ("Mechanical", "mechanical"), ("Interior 1", "interior_dark"),
                 ("Interior 2", "interior_seat"), ("Interior 3 Carmine", "interior_accent"),
                 ("Floormat", "interior_mat"), ("Panel Sides", "interior_panel")):
    M[old].name = new
for m in list(M):                                        # variant paints, logo plate, old rims
    if m.users == 0:
        M.remove(m)
for name in ("rubber", "hardware", "mirror_glass", "caliper"):
    no_emission(M[name])
b = principled(M["paint"])
b.inputs["Base Color"].default_value = (*PAINT, 1)
b.inputs["Coat Weight"].default_value = 1.0
b.inputs["Roughness"].default_value = 0.3
for n in M["paint"].node_tree.nodes:                     # metal flakes: keep, but finer than the source
    if n.type == "NORMAL_MAP":
        n.inputs["Strength"].default_value = 0.12
b = principled(M["trim"])                                # two-tone: gloss black roof + cladding
b.inputs["Base Color"].default_value = (0.012, 0.012, 0.014, 1)
b.inputs["Roughness"].default_value = 0.22
b.inputs["Coat Weight"].default_value = 1.0
unlink_input(M["trim"], "Normal")
b = principled(M["glass"])                               # alpha glass: transmission is too costly on an iGPU
b.inputs["Transmission Weight"].default_value = 0.0
b.inputs["Base Color"].default_value = (0.02, 0.025, 0.03, 1)
b.inputs["Roughness"].default_value = 0.02
b.inputs["Alpha"].default_value = 0.35
M["glass"].surface_render_method = "BLENDED"
b = principled(M["caliper"])                             # bronze calipers (the concept: red)
b.inputs["Base Color"].default_value = (0.42, 0.24, 0.06, 1)
b.inputs["Metallic"].default_value = 0.7
b.inputs["Roughness"].default_value = 0.35
b = principled(M["light_smoked"])                        # old headlight slit: smoked accent, unlit
b.inputs["Emission Strength"].default_value = 0.0
b.inputs["Base Color"].default_value = (0.01, 0.01, 0.012, 1)
b.inputs["Roughness"].default_value = 0.08
b = principled(M["interior_accent"])                     # cognac leather instead of red
b.inputs["Base Color"].default_value = (0.20, 0.07, 0.025, 1)
set_image(M["dash"], "Emission Color", dash_texture())
unlink_input(M["tyre_side"], "Base Color")
principled(M["tyre_side"]).inputs["Base Color"].default_value = (0.018, 0.018, 0.018, 1)
set_image(M["tyre_side"], "Normal", sidewall_normal(), normal=True)

MAT_HEAD = new_mat("light_head", (0.02, 0.02, 0.02), rough=0.2, emission=(0.86, 0.93, 1.0), strength=10)
MAT_TAIL = new_mat("light_tail", (0.05, 0.0, 0.0), rough=0.2, emission=(1.0, 0.02, 0.01), strength=6)
MAT_RIM = new_mat("rim", (0.035, 0.037, 0.04), metallic=0.85, rough=0.32, double=True)
MAT_LIP = new_mat("rim_lip", (0.75, 0.76, 0.78), metallic=1.0, rough=0.18)
MAT_GRILLE = new_mat("grille", (0.006, 0.006, 0.006), rough=0.7)
# our added aero parts (splitter, blades, wing, fins, skirts): gloss black clear coat like the trim,
# but no AO map (they have no baked-AO UV set)
MAT_CARBON = new_mat("carbon", (0.01, 0.01, 0.012), metallic=0.2, rough=0.25, coat=1.0)
MAT_PLATE = new_mat("plate", rough=0.5)
set_image(MAT_PLATE, "Base Color", plate_texture())

# ---- names and part structure (still in source space: X left, -Y forward, Z up)
O = bpy.data.objects
for old, new in (("BodyHood", "hood"), ("BodyRearPanelsColor1", "trunk"), ("BodyPillars", "body_pillars"),
                 ("BodyRoofPanel", "roof"), ("BodyPanelsColor2", "body_lower"), ("BodyHoodInterior01", "hood_inner"),
                 ("BodyHoodTopgrill", "hood_vent"), ("BodyHeadlights", "headlight_slit"),
                 ("BodyTurnsignalsRear", "turn_rear"), ("BodyTaillightsPanels", "taillight_housing"),
                 ("BodyUnderside", "underbody"), ("Engine", "underbody_engine"), ("Axles", "underbody_axles")):
    rename(O[old], new)
join(["BodyDoorLColor1", "BodyDoorLColor2", "BodyDoorLHandle01", "BodyDoorLHandle02"], "door_L")
join(["BodyDoorRColor1", "BodyDoorRColor2", "BodyDoorRHandle01", "BodyDoorRHandle02"], "door_R")
join(["BodyDoorLMirror", "BodyDoorLMirrorColor1", "BodyDoorLMirrorColor2"], "mirror_L")
join(["BodyDoorRMirror", "BodyDoorRMirrorColor1", "BodyDoorRMirrorColor2"], "mirror_R")
join(["BodyWindshield", "BodyDoorLWindow", "BodyDoorRWindow", "BodyWindowsRearSides", "BodyRearwindow"], "glass")
join(["BodyWindshieldGasket", "BodyDoorLWindowGasket", "BodyDoorRWindowGasket", "BodyHoodInterior02", "BodyHoodUnder"], "trim_rubber")
interior = [o.name for o in objs() if o.name.startswith("Interior")]
join(interior, "interior")
for tag, src in (("FL", "WheelFrontL"), ("FR", "WheelFrontR"), ("RL", "WheelRearL"), ("RR", "WheelRearR")):
    rename(O[src + "BrakePad"], f"caliper_{tag}_body")
    rename(O[src + "BrakeDisc"], f"wheel_{tag}_disc")
for o in objs():                                          # the tyres are the unnamed Mesh_8x objects
    if o.name.startswith("Mesh_"):
        c = sum((o.matrix_world @ Vector(v) for v in o.bound_box), Vector()) / 8
        tag = ("F" if c.y < 0 else "R") + ("L" if c.x > 0 else "R")
        rename(o, f"wheel_{tag}_tyre")

# The source wheels are posed (front ones steered, all slightly cambered): find each tyre's real
# axle (smallest principal axis of its vertices) and rotate tyre, disc and caliper so the axle is
# exactly X, the way car.ts spins them. The hub becomes the tyre's vertex centroid.
for tag in HUBS:
    tyre_ob = O[f"wheel_{tag}_tyre"]
    pts = np.array([v.co[:] for v in tyre_ob.data.vertices])
    c = pts.mean(axis=0)
    axis = Vector(np.linalg.svd(pts - c)[2][2])
    side = 1 if c[0] > 0 else -1
    if axis.x * side < 0:
        axis.negate()
    rot = axis.rotation_difference(Vector((side, 0, 0))).to_matrix().to_4x4()
    fix = Matrix.Translation(Vector(c)) @ rot @ Matrix.Translation(-Vector(c))
    for part in (f"wheel_{tag}_tyre", f"wheel_{tag}_disc", f"caliper_{tag}_body"):
        O[part].data.transform(fix)
    HUBS[tag] = Vector(c)
    print(f"wheel {tag}: axle tilt {math.degrees(axis.angle(Vector((side, 0, 0)))):.2f} deg, hub {Vector(c)}")


def split(src, pred, new_name):
    """Move the faces of src whose centre satisfies pred into a new object."""
    ob = O[src]
    dup = ob.copy()
    dup.data = ob.data.copy()
    bpy.context.scene.collection.objects.link(dup)
    for target, keep in ((ob, False), (dup, True)):
        bm = bmesh.new()
        bm.from_mesh(target.data)
        kill = [f for f in bm.faces if pred(f.calc_center_median()) != keep]
        bmesh.ops.delete(bm, geom=kill, context="FACES")
        bm.to_mesh(target.data)
        bm.free()
    return rename(dup, new_name)


# bumpers: the lower nose/tail of the clams + the black cladding ends become detachable parts
split("hood", lambda c: c.y < -2.12 and c.z < 0.50, "bumper_front_skin")
split("body_lower", lambda c: c.y < -1.95, "bumper_front_lower")
split("trunk", lambda c: c.y > 1.78 and c.z < 0.72, "bumper_rear_skin")
split("body_lower", lambda c: c.y > 1.62, "bumper_rear_lower")

# ---- new front: lower intake + blades + splitter, light signature
front = Surface(["hood", "bumper_front_skin", "bumper_front_lower", "trim_rubber", "headlight_slit"])
fplane = lambda u, v: (u, -4.0, v)
FWD = (0, 1, 0)
if os.environ.get("CAR3_PROBE"):                  # debug: where the nose rays land (y, or '-' = miss)
    for z in (0.12, 0.16, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7):
        row = []
        for x in (-0.9, -0.7, -0.5, -0.3, 0.0, 0.3, 0.5, 0.7, 0.9):
            h = front.hit(fplane(x, z), FWD)
            row.append(f"{h[0].y:6.2f}" if h else "     -")
        print(f"z {z:.2f}", " ".join(row))
    sys.exit(0)
intake = projected_patch(front, [(-0.50, 0.19), (0.50, 0.19), (0.38, 0.39), (-0.38, 0.39)], 16, 5, fplane, FWD, 0.003, "grille", MAT_GRILLE)
parts_front = [intake]
for i, z in enumerate((0.25, 0.285, 0.32, 0.355)):
    half = 0.48 - (z - 0.215) / 0.175 * 0.12
    parts_front.append(projected_bar(front, [(-half, z), (half, z)], 0.008, fplane, FWD, 0.012, 0.0, f"grille_blade_{i}", MAT_CARBON))
frame = projected_bar(front, [(-0.52, 0.18), (-0.39, 0.40), (0.39, 0.40), (0.52, 0.18), (-0.52, 0.18)], 0.014, fplane, FWD, 0.007, -0.004, "grille_frame", MAT_CARBON, n=60)
parts_front.append(frame)
# splitter: flat carbon blade under the nose, following the bumper's plan shape
bm = bmesh.new()
edge = []
for i in range(25):
    x = -0.95 + 1.9 * i / 24
    h = front.hit((x, -4.0, 0.16), FWD)
    y = h[0].y if h else -2.2
    edge.append((x, y))
top, bot = [], []
for x, y in edge:
    for lst, z in ((top, 0.125), (bot, 0.112)):
        lst.append((bm.verts.new((x * 0.98, y - 0.05, z)), bm.verts.new((x * 0.98, y + 0.18, z))))
for a, b in zip(range(24), range(1, 25)):
    bm.faces.new((top[a][0], top[b][0], top[b][1], top[a][1]))
    bm.faces.new((bot[a][0], bot[a][1], bot[b][1], bot[b][0]))
    bm.faces.new((top[a][0], bot[a][0], bot[b][0], top[b][0]))
for r in (0, 24):
    bm.faces.new((top[r][0], top[r][1], bot[r][1], bot[r][0]))
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
smooth_by_angle(bm, 0.5)
parts_front.append(bm_object(bm, "splitter", [MAT_CARBON]))
parts_front.append(rename(O["bumper_front_lower"], "bumper_front_lower"))
skin = O["bumper_front_skin"]
for p in parts_front:
    p.parent = skin
rename(skin, "bumper_front")

# tri-dash DRL: three short stacked LED bars at the outer corners, a projector lens inboard
for side, tag in ((1, "L"), (-1, "R")):
    bars = []
    for i, z in enumerate((0.47, 0.505, 0.54)):
        x0, x1 = 0.60 + 0.02 * i, 0.76 + 0.012 * i
        bars.append(projected_bar(front, [(side * x0, z - 0.008 * i), (side * x1, z + 0.012)], 0.012, fplane, FWD, 0.005, -0.004, f"drl_{tag}_{i}", MAT_HEAD))
    join([b.name for b in bars], f"drl_{tag}")
    projected_bar(front, [(side * 0.42, 0.52), (side * 0.53, 0.53)], 0.03, fplane, FWD, 0.006, -0.004, f"beam_{tag}", MAT_HEAD, n=10)

# ---- new rear: light bar with C ends, diffuser fins, plate, wing
rear = Surface(["trunk", "bumper_rear_skin", "bumper_rear_lower"])
rplane = lambda u, v: (-u, 4.0, v)            # u = screen-right seen from behind = -X
BACK = (0, -1, 0)
bar_pts = [(-0.80, 0.68), (-0.82, 0.79), (0.82, 0.79), (0.80, 0.68)]
projected_bar(rear, bar_pts, 0.016, rplane, BACK, 0.006, -0.004, "taillight_bar", MAT_TAIL, n=80)
parts_rear = []
for i, x in enumerate((-0.45, -0.17, 0.17, 0.45)):
    yb = rear.hit((x, 4.0, 0.20), BACK)
    y1 = (yb[0].y if yb else 1.9) + 0.02
    parts_rear.append(box(f"diffuser_fin_{i}", MAT_CARBON, lambda a, b, c, x=x, y1=y1: Vector((x + (a - 0.5) * 0.012, 1.45 + b * (y1 - 1.45), 0.10 + c * (0.11 + 0.10 * b)))))
bm = bmesh.new()
pv = [bm.verts.new(p) for p in ((0.18, 1.925, 0.262), (-0.18, 1.925, 0.262), (-0.18, 1.925, 0.362), (0.18, 1.925, 0.362))]
face = bm.faces.new(pv)
uv = bm.loops.layers.uv.new("UVMap")
for loop, t in zip(face.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
    loop[uv].uv = t
parts_rear.append(bm_object(bm, "plate", [MAT_PLATE]))     # winding faces +Y (backward)
parts_rear.append(rename(O["bumper_rear_lower"], "bumper_rear_lower"))
rskin = O["bumper_rear_skin"]
for p in parts_rear:
    p.parent = rskin
rename(rskin, "bumper_rear")

# rear wing: cambered profile on two uprights, with end plates
deck = Surface(["trunk"])
yw0, yw1 = 1.63, 1.92
dz = deck.hit((0.42, (yw0 + yw1) / 2, 3.0), (0, 0, -1))
deck_z = dz[0].z if dz else 1.0
zw = deck_z + 0.13
prof = [(0.0, 0.0), (0.04, 0.016), (0.12, 0.026), (0.22, 0.022), (0.29, 0.012), (0.30, 0.004),
        (0.22, -0.002), (0.12, 0.0), (0.04, -0.006)]
bm = bmesh.new()
rings = []
for x in (-0.80, -0.40, 0.0, 0.40, 0.80):
    rings.append([bm.verts.new((x, yw0 + c / 0.30 * (yw1 - yw0), zw + h + 0.03 * (c / 0.30))) for c, h in prof])
for a, b in zip(rings[:-1], rings[1:]):
    for i in range(len(prof)):
        bm.faces.new((a[i], a[(i + 1) % len(prof)], b[(i + 1) % len(prof)], b[i]))
for r in (rings[0], rings[-1]):
    bm.faces.new(r)
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
smooth_by_angle(bm, 0.6)
wing = [bm_object(bm, "wing_blade", [MAT_CARBON]).name]
for i, x in enumerate((-0.42, 0.42)):
    wing.append(box(f"wing_post_{i}", MAT_CARBON, lambda a, b, c, x=x: Vector((x + (a - 0.5) * 0.014, yw0 + 0.10 + b * 0.10 - c * 0.03, deck_z - 0.02 + c * (zw - deck_z + 0.03)))).name)
    xe = 0.80 * (1 if x > 0 else -1)
    wing.append(box(f"wing_plate_{i}", MAT_CARBON, lambda a, b, c, xe=xe: Vector((xe + (a - 0.5) * 0.008, yw0 - 0.02 + b * (yw1 - yw0 + 0.04), zw - 0.045 + c * 0.095))).name)
join(wing, "wing")

# side skirt blades
side_surf = Surface(["body_lower", "door_L", "door_R"])
for side, tag in ((1, "L"), (-1, "R")):
    projected_bar(side_surf, [(-1.02, 0.17), (0.80, 0.17)], 0.03, lambda u, v, s=side: (s * 3.0, u, v), (-side, 0, 0), 0.028, -0.004, f"skirt_{tag}", MAT_CARBON, n=30)

# ---- global proportions: scale about the body length centre on the ground (source ground =
# tyre contact), then every wheel part shrinks about its hub to the physics tyre radius
tyre = O["wheel_FL_tyre"]
hub = HUBS["FL"]
rads = [math.hypot(v.co.y - hub.y, v.co.z - hub.z) for v in tyre.data.vertices]
R_SRC, R_SEAT_SRC = max(rads), min(rads)
xs = [v.co.x for v in tyre.data.vertices]
HALF_W_SRC = (max(xs) - min(xs)) / 2
GROUND = hub.z - R_SRC
ys = [(o.matrix_world @ Vector(c)).y for o in (O["hood"], O["trunk"], O["bumper_front"], O["bumper_rear"]) for c in o.bound_box]
YC = (min(ys) + max(ys)) / 2
print(f"source: tyre R {R_SRC:.4f} seat {R_SEAT_SRC:.4f} half width {HALF_W_SRC:.4f} ground {GROUND:.4f} body y centre {YC:.4f}")

# our rims, built at the source hubs before the global scale
for tag, h in HUBS.items():
    side = 1 if h.x > 0 else -1
    build_rim(f"wheel_{tag}_rim", side, h, R_SEAT_SRC, HALF_W_SRC, [MAT_RIM, MAT_LIP])

pivot = bpy.data.objects.new("pivot", None)
bpy.context.scene.collection.objects.link(pivot)
pivot.location = (0, YC, GROUND)
tops = [o for o in objs() if o.parent is None]
for o in tops:
    o.parent = pivot
    o.matrix_parent_inverse = pivot.matrix_world.inverted()
pivot.location = (0, 0, 0)
pivot.scale = (SX, SY, SZ)
bpy.context.view_layer.update()
select(objs())
bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
# re-parent the detachable sub-parts (parent_clear flattened them)
for parent, kids in (("bumper_front", ["grille", "grille_frame", "splitter", "bumper_front_lower"] + [f"grille_blade_{i}" for i in range(4)]),
                     ("bumper_rear", ["plate", "bumper_rear_lower"] + [f"diffuser_fin_{i}" for i in range(4)])):
    for k in kids:
        O[k].parent = O[parent]
bpy.data.objects.remove(pivot, do_unlink=True)

k_tyre = TYRE_R / (R_SRC * SY)
WHEELS = {}
for tag, h in HUBS.items():
    hub_new = Vector((h.x * SX, (h.y - YC) * SY, (h.z - GROUND) * SZ))
    WHEELS[tag] = hub_new
    shrink = Matrix.Translation(hub_new) @ Matrix.Scale(k_tyre, 4) @ Matrix.Translation(-hub_new)
    wheel = bpy.data.objects.new(f"wheel_{tag}", None)
    caliper = bpy.data.objects.new(f"caliper_{tag}", None)
    for e in (wheel, caliper):
        bpy.context.scene.collection.objects.link(e)
        e.location = hub_new
    bpy.context.view_layer.update()
    for part, parent in ((f"wheel_{tag}_tyre", wheel), (f"wheel_{tag}_rim", wheel), (f"wheel_{tag}_disc", wheel), (f"caliper_{tag}_body", caliper)):
        ob = O[part]
        ob.data.transform(shrink)
        ob.parent = parent
        ob.matrix_parent_inverse = parent.matrix_world.inverted()

# ---- report + export (hero)
def stats(label):
    total = 0
    rows = []
    for o in sorted(objs(), key=lambda o: -tris(o)):
        total += tris(o)
        rows.append(f"{o.name}:{tris(o)}")
    print(f"[{label}] triangles {total}  objects {len(objs())}")
    print("  " + "  ".join(rows[:30]))
    return total


def world_bbox(names):
    pts = [O[n].matrix_world @ Vector(c) for n in names for c in O[n].bound_box]
    return [min(p[i] for p in pts) for i in range(3)], [max(p[i] for p in pts) for i in range(3)]


def to_model(v):   # Blender -> game model space (x, z, -y)
    return [round(v[0], 3), round(v[2], 3), round(-v[1], 3)]


def decimate(ratios):
    """Collapse-decimate every object whose name starts with a key (longest key wins)."""
    for o in objs():
        r = next((v for k, v in sorted(ratios.items(), key=lambda kv: -len(kv[0])) if o.name.startswith(k)), None)
        if r and tris(o) > 200:
            mod = o.modifiers.new("dec", "DECIMATE")
            mod.ratio = r
            mod.use_collapse_triangulate = True
            select([o])
            bpy.ops.object.modifier_apply(modifier="dec")


# hero: the interior is seen only through tinted glass (40k triangles in the source): halve it
decimate({"interior": 0.45, "bumper_rear_lower": 0.6})
stats("hero")
for tag, h in WHEELS.items():
    print("hub", tag, to_model(h))
for n in ("beam_L", "beam_R", "drl_L", "drl_R", "taillight_bar"):
    mn, mx = world_bbox([n])
    print("light", n, to_model([(a + b) / 2 for a, b in zip(mn, mx)]))
mn, mx = world_bbox([o.name for o in objs() if not o.name.startswith(("wheel_", "caliper_", "mirror_"))])
print("body bbox model", to_model(mn), to_model(mx))
mn, mx = world_bbox(["underbody_engine"])
print("engine", to_model([(a + b) / 2 for a, b in zip(mn, mx)]), "top", round(mx[2], 3))


def export(path):
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", export_yup=True, export_apply=True,
                              export_tangents=False,
                              export_materials="EXPORT", export_cameras=False, export_lights=False,
                              export_extras=False, export_animations=False)


export(os.path.join(OUT, "vela_gt_hero_raw.glb"))

# ---- traffic version (<= ~30k triangles): drop small interior detail, decimate, cheaper rims
for tag, h in WHEELS.items():
    old = O[f"wheel_{tag}_rim"]
    bpy.data.objects.remove(old, do_unlink=True)
    side = 1 if h.x > 0 else -1
    lo = build_rim(f"wheel_{tag}_rim", side, h, R_SEAT_SRC * SY * k_tyre, HALF_W_SRC * SX * k_tyre, [MAT_RIM, MAT_LIP], seg=24, spoke_seg=2)
    lo.parent = O[f"wheel_{tag}"]
    lo.matrix_parent_inverse = O[f"wheel_{tag}"].matrix_world.inverted()
delete(["hood_inner", "underbody_axles", "underbody_engine"])
RATIO = {"interior": 0.12, "caliper_": 0.12, "hood": 0.16, "trunk": 0.16, "body_lower": 0.16, "body_pillars": 0.2,
         "bumper_front": 0.2, "bumper_rear": 0.2, "door_": 0.2, "mirror_": 0.3, "roof": 0.15, "trim_rubber": 0.2,
         "glass": 0.25, "taillight_housing": 0.3, "underbody": 0.5, "hood_vent": 0.2, "headlight_slit": 0.5,
         "grille": 0.5, "wing": 0.6, "skirt_": 0.6, "taillight_bar": 0.5, "drl_": 0.6}
decimate(RATIO)
stats("traffic")
export(os.path.join(OUT, "vela_gt_traffic_raw.glb"))
print("done")
