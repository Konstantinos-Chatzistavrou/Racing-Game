"""Original GT coupe, generation 2 ("Vela GT"): subdivision-surface body instead of a loft.

Run:  tools/blender/blender -b --factory-startup --python assets_source/scripts/make_car2.py
Out:  assets_source/models/car_gt.blend, game/assets/cars/car_gt.glb (+ car_gt_lod.glb)

Original design, no reference to any real car: free of copyright/trade-dress issues.
Same package as generation 1 (length, wheelbase, track, wheel size, axle positions), so the physics
data, collision hull and visual JSON stay valid. Part names are the ones the damage system and
car_factory.gd expect (bumper_front, hood, door_L, mirror_L, wheel_FL, ...).

HOW IT IS BUILT
1. A coarse control cage, the way car modellers work: rings of 16 points at ~20 stations along the
   car. Each ring is the body's cross-section (sill, widest point, shoulder crease, hood/deck).
   Every cage face is tagged with the panel it belongs to (material index = part id).
2. Subdivision surface (level 3) smooths the cage; the shoulder line is creased so it stays crisp.
   Child faces inherit the part tag, so panel and window edges are smooth curves (not jagged).
3. Wheel arches are boolean-cut; the mesh is split into panels; each panel's edge is pulled in a
   few mm, which leaves real shut lines.
4. Lights, grille, intakes and badges-free details are drawn as 2D outlines and ray-cast onto the
   finished body, so they follow its curvature exactly.

Blender axes: X = car's left, -Y = forward, Z = up (glTF export turns this into Godot's +Z forward).
"""
import bpy
import bmesh
import math
import os
import sys
from mathutils import Vector
from mathutils.bvhtree import BVHTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import make_car as mc  # noqa: E402  (shared: materials, wheels, calipers, cabin, LOD, helpers)

ROOT = mc.ROOT
Y_FA, Y_RA = mc.Y_FRONT_AXLE, mc.Y_REAR_AXLE      # -1.30, +1.35
WHEEL_R = mc.WHEEL_R
ARCH_R = 0.372
P = mc.pchip

# ------------------------------------------------------------------ design curves (y -> value)
# nose y = -2.25, tail y = +2.25
TOP = P([(-2.25, 0.50), (-2.17, 0.60), (-1.95, 0.655), (-1.3, 0.735), (-0.9, 0.80), (0.0, 0.86),
         (1.2, 0.915), (1.9, 0.935), (2.13, 0.94), (2.25, 0.79)])                 # centreline top
SH_Z = P([(-2.25, 0.50), (-2.15, 0.62), (-1.75, 0.735), (-1.3, 0.80), (-0.8, 0.80), (-0.2, 0.805),
          (0.6, 0.84), (1.35, 0.905), (1.9, 0.925), (2.13, 0.93), (2.25, 0.79)])  # shoulder crease
ZB = P([(-2.25, 0.17), (-2.15, 0.135), (-1.8, 0.13), (1.8, 0.14), (2.1, 0.22), (2.25, 0.31)])   # sill
WB = P([(-2.25, 0.62), (-2.18, 0.80), (-2.0, 0.89), (-1.30, 0.955), (-0.85, 0.93), (-0.2, 0.915),
        (0.5, 0.925), (1.35, 0.975), (1.9, 0.95), (2.15, 0.88), (2.25, 0.76)])   # widest half width
ZMID = P([(-2.25, 0.36), (-1.3, 0.47), (0.0, 0.46), (1.35, 0.52), (2.25, 0.55)])  # z of widest point
SH_IN = P([(-2.25, 0.09), (-1.3, 0.035), (-0.4, 0.075), (0.4, 0.08), (1.35, 0.03), (2.25, 0.10)])
# SH_IN: how far the shoulder sits inside the widest point -> small over the wheels = muscular hips

STATIONS = [-2.25, -2.22, -2.15, -2.04, -1.85, -1.58, -1.30, -1.02, -0.76, -0.62, -0.22, 0.22,
            0.62, 0.80, 1.08, 1.35, 1.62, 1.88, 2.06, 2.17, 2.22, 2.25]


def half_ring(y):
    """Right half of the cross-section: bottom centre -> sill -> widest -> shoulder -> top centre."""
    zb, top, w, zm, sz = ZB(y), TOP(y), WB(y), ZMID(y), SH_Z(y)
    ws = w - SH_IN(y)
    return [
        (0.0, zb),                     # 0 bottom centre
        (w - 0.16, zb),                # 1 floor edge
        (w - 0.05, zb + 0.07),         # 2 sill
        (w, zm),                       # 3 widest
        (w - 0.012, sz - 0.085),       # 4 upper side
        (ws, sz),                      # 5 shoulder crease
        (ws - 0.09, sz + 0.012),       # 6 fender top inner
        (ws * 0.45, top - 0.004),      # 7 hood/deck
        (0.0, top),                    # 8 top centre
    ]


def ring(y):
    h = half_ring(y)
    right = [(x, z) for x, z in h]
    left = [(-x, z) for x, z in h[-2:0:-1]]
    return right + left                 # 16 points, k=0 bottom centre, k=8 top centre


def band_of(k):
    """Ring face k (between point k and k+1) -> (half band 0..7, side +1/-1)."""
    hk = k if k <= 8 else 16 - k
    hk1 = (k + 1) if (k + 1) <= 8 else 16 - (k + 1)
    return min(hk, hk1), (1 if k < 8 else -1)


PARTS = ["body", "fender_L", "fender_R", "quarter_L", "quarter_R", "rocker_L", "rocker_R", "cowl", "deck",
         "underbody", "skirt", "bumper_front", "bumper_rear", "hood", "trunk", "door_L", "door_R",
         "roof", "glass", "trim_window", "pillar"]
PI = {p: i for i, p in enumerate(PARTS)}


def classify_body(y, b, side):
    if b == 0:
        return "underbody"
    if y < -2.04 or (y < -1.85 and b <= 3):
        return "bumper_front"
    if y > 2.06 or (y > 1.88 and b <= 3):
        return "bumper_rear"
    if b >= 6 and -2.04 < y < -0.76:
        return "hood"
    if b >= 6 and 1.62 < y < 2.06:
        return "trunk"
    if b == 1 and -1.02 < y < 1.08:
        return "skirt"
    if 2 <= b <= 4 and -0.62 < y < 0.80:
        return "door_L" if side > 0 else "door_R"
    # The rest of the shell is split into small panels too: real cars are built that way, and the
    # dent code (GDScript, per-vertex) only touches panels near the impact -> cheap dents.
    lr = "_L" if side > 0 else "_R"
    if b >= 7:
        return "cowl" if y < 0.0 else "deck"
    if y < -0.62:
        return "fender" + lr
    if y > 0.80:
        return "quarter" + lr
    return "rocker" + lr


def build_body_cage():
    bm = bmesh.new()
    rings = []
    for y in STATIONS:
        rings.append([bm.verts.new((x, y, z)) for x, z in ring(y)])
    crease = bm.edges.layers.float.new("crease_edge")
    for i in range(len(rings) - 1):
        ym = 0.5 * (STATIONS[i] + STATIONS[i + 1])
        for k in range(16):
            a, b_ = rings[i][k], rings[i][(k + 1) % 16]
            c, d = rings[i + 1][(k + 1) % 16], rings[i + 1][k]
            f = bm.faces.new((a, b_, c, d))
            band, side = band_of(k)
            f.material_index = PI[classify_body(ym, band, side)]
        for k in (5, 11):             # shoulder crease runs along the whole car
            e = bm.edges.get((rings[i][k], rings[i + 1][k]))
            e[crease] = 0.75
    for r, part, out in ((rings[0], "bumper_front", -1), (rings[-1], "bumper_rear", 1)):
        # Nose / tail face: rows of quads joining left and right ring points, split by a centre
        # column that bulges slightly outward (a flat cap would read as a hole after subdivision).
        mid = {}
        for i in range(1, 8):
            a, b_ = r[i], r[16 - i]
            mid[i] = bm.verts.new((0.0, a.co.y + out * 0.035, a.co.z))
        mid[0], mid[8] = r[0], r[8]
        for i in range(8):
            for side_pts in ((r[i], r[i + 1], mid[i + 1], mid[i]), (mid[i], mid[i + 1], r[(16 - i - 1) % 16], r[(16 - i) % 16])):
                q = []
                for v in side_pts:
                    if v not in q:
                        q.append(v)
                f = bm.faces.new(q)
                f.material_index = PI[part]
        for k in range(16):
            bm.edges.get((r[k], r[(k + 1) % 16]))[crease] = 0.45   # crisp-ish edge around the face
    for f in bm.faces:                # outward: caps along +-Y, everything else away from the axis
        f.normal_update()
        c = f.calc_center_median()
        if f.material_index in (PI["bumper_front"], PI["bumper_rear"]) and abs(c.y) > 2.2:
            want = Vector((0, 1 if c.y > 0 else -1, 0))
        else:
            want = Vector((c.x, 0, c.z - 0.5))
        if f.normal.dot(want) < 0:
            f.normal_flip()
    return bm


# ------------------------------------------------------------------ greenhouse (cabin sheet)
# stations: windshield base, A-pillar top, roof peak, rear-window top, fastback end on the deck
CAB_Y = [-1.02, -0.64, -0.16, 0.26, 0.70, 1.18, 1.74]
CAB_ROOF = [None, 0.985, 1.19, 1.215, 1.185, 1.05, None]
CAB_ROOF_W = [None, 0.62, 0.60, 0.60, 0.59, 0.56, None]


def cabin_half(i):
    """Right-half columns of the cabin sheet at station i (outer base -> top centre)."""
    y = CAB_Y[i]
    sz = SH_Z(y)
    wb = WB(y) - SH_IN(y) - 0.075          # belt sits just inside the shoulder
    if CAB_ROOF[i] is None:                # squashed station lying on the hood / deck
        top = TOP(y) + 0.004
        return [(wb + 0.01, sz - 0.04), (wb, sz + 0.02), (wb - 0.03, sz + 0.035),
                (wb - 0.12, top + 0.004), (wb - 0.22, top + 0.004), (0.35, top + 0.006), (0.0, top + 0.007)]
    roof, rw = CAB_ROOF[i], CAB_ROOF_W[i]
    return [
        (wb + 0.01, sz - 0.04),            # 0 base (inside the body)
        (wb, sz + 0.03),                   # 1 belt
        (wb - 0.025, sz + 0.075),          # 2 window bottom
        (rw + 0.07, roof - 0.075),         # 3 window top (tumblehome = the inward lean 2->3)
        (rw, roof - 0.03),                 # 4 roof rail
        (rw * 0.5, roof),                  # 5 roof
        (0.0, roof + 0.004),               # 6 centre
    ]


def classify_cabin(i, b):
    """Row i (between stations i and i+1); b = half column band: 0 base->belt (paint), 1 window
    surround (black trim), 2 side glass, 3 drip rail, 4-5 roof."""
    if b == 0:
        return "body"
    if b == 1:                             # black window surround only where there is side glass
        return "trim_window" if 1 <= i <= 4 else "body"
    if i <= 1:                             # windshield rows: glass between the A-pillars
        return "glass" if b >= 3 else "pillar"
    if i <= 3:                             # roof rows: side windows, black drip rail, roof
        return "glass" if b == 2 else "roof"
    if i == 4:                             # rear quarter glass + rear window
        return "glass" if b != 3 else "pillar"
    return "glass" if b >= 4 else "pillar" # fastback end: C-pillar in body colour


def build_cabin_cage():
    bm = bmesh.new()
    rings = []
    for i in range(len(CAB_Y)):
        h = cabin_half(i)
        pts = h + [(-x, z) for x, z in h[-2::-1]]        # 13 points, open sheet left<->right
        rings.append([bm.verts.new((x, CAB_Y[i], z)) for x, z in pts])
    crease = bm.edges.layers.float.new("crease_edge")
    n = len(rings[0])
    for i in range(len(rings) - 1):
        for k in range(n - 1):
            f = bm.faces.new((rings[i][k], rings[i][k + 1], rings[i + 1][k + 1], rings[i + 1][k]))
            hk, hk1 = (k if k <= 6 else 12 - k), ((k + 1) if k + 1 <= 6 else 12 - (k + 1))
            f.material_index = PI[classify_cabin(i, min(hk, hk1))]
        for k in (4, 8):
            e = bm.edges.get((rings[i][k], rings[i + 1][k]))
            e[crease] = 0.35
    for f in bm.faces:
        f.normal_update()
        c = f.calc_center_median()
        if f.normal.dot(Vector((c.x, 0.0, c.z - 0.5))) < 0:
            f.normal_flip()
    return bm


# ------------------------------------------------------------------ mesh pipeline helpers
def subdivide(bm, name, levels):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for part in PARTS:                # one slot per part: booleans keep tags only through slots
        me.materials.append(bpy.data.materials.get("tag_" + part) or bpy.data.materials.new("tag_" + part))
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    sub = ob.modifiers.new("subd", "SUBSURF")
    sub.levels = sub.render_levels = levels
    sub.boundary_smooth = "PRESERVE_CORNERS"
    apply_mods(ob)
    return ob


def apply_mods(ob):
    for o in bpy.context.selected_objects:
        o.select_set(False)
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    for m in list(ob.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)


def cut_arches(body):
    for wx, wy, name in mc.wheel_centres():
        sgn = 1 if wx > 0 else -1
        bpy.ops.mesh.primitive_cylinder_add(vertices=64, radius=ARCH_R, depth=0.8,
                                            location=(sgn * 0.95, wy, WHEEL_R + 0.012), rotation=(0, math.pi / 2, 0))
        cyl = bpy.context.active_object
        cyl.data.materials.append(bpy.data.materials["tag_underbody"])    # cut walls: black liner
        mod = body.modifiers.new("arch_" + name, "BOOLEAN")
        mod.operation = "DIFFERENCE"
        mod.solver = "EXACT"
        mod.object = cyl
        apply_mods(body)
        bpy.data.objects.remove(cyl, do_unlink=True)


PART_MAT = {"underbody": "under", "skirt": "trim", "glass": "glass", "trim_window": "trim"}
NO_GAP = ("glass", "underbody")


def split_parts(ob, root, rename=None, merge_into=None):
    """Split a subdivided object by part tag into separate panel objects with shut lines."""
    src = bmesh.new()
    src.from_mesh(ob.data)
    groups = {}
    for f in src.faces:
        groups.setdefault(PARTS[f.material_index], []).append(f)
    made = {}
    for part, faces in groups.items():
        name = (rename or {}).get(part, part)
        sub = mc.sub_bmesh(src, faces)
        if part not in NO_GAP:
            mc.shrink_boundary(sub, 0.0028)
        made[name] = (sub, part)
    src.free()
    bpy.data.objects.remove(ob, do_unlink=True)
    out = {}
    for name, (sub, part) in made.items():
        out[name] = mc.bm_to_object(sub, name, mc.MATS[PART_MAT.get(part, "paint")], smooth_angle=50, parent=root)
    return out


# ------------------------------------------------------------------ projected details
class Surface:
    """Ray-cast helper against the finished body + cabin."""

    def __init__(self, objs):
        bm = bmesh.new()
        for o in objs:
            tmp = o.data.copy()
            tmp.transform(o.matrix_world)
            bm.from_mesh(tmp)
            bpy.data.meshes.remove(tmp)
        self.tree = BVHTree.FromBMesh(bm)
        bm.free()

    def hit(self, origin, direction):
        loc, nor, _, _ = self.tree.ray_cast(Vector(origin), Vector(direction).normalized(), 10.0)
        return loc, nor


def projected_patch(surf, name, material, outline_fn, nu, nv, direction, offset, root, smooth=60, bulge=0.0):
    """Grid (u,v in [0,1]) -> 3D start points from outline_fn(u, v) -> cast along `direction` onto
    the body, lifted `offset` along the surface normal (+ `bulge` in the middle: lens dome)."""
    bm = bmesh.new()
    grid = []
    d = Vector(direction).normalized()
    for j in range(nv + 1):
        row = []
        for i in range(nu + 1):
            u, v = i / nu, j / nv
            p = Vector(outline_fn(u, v))
            loc, nor = surf.hit(p - d * 1.5, d)
            if loc is None:                  # ray missed the body: leave a hole in the patch
                row.append(None)
                continue
            lift = offset + bulge * math.sin(math.pi * u) * math.sin(math.pi * v)
            row.append(bm.verts.new(loc + nor * lift))
        grid.append(row)
    for j in range(nv):
        for i in range(nu):
            q = (grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i])
            if None not in q:
                bm.faces.new(q)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    for f in bm.faces:
        f.normal_update()
        if f.normal.dot(-d) < 0:
            f.normal_flip()
    return mc.bm_to_object(bm, name, material, smooth_angle=smooth, parent=root)


def lerp(a, b, t):
    return a + (b - a) * t


def build_front_details(surf, root):
    fwd = (0, 1, 0)     # rays travel from the front (-Y) toward +Y
    for sgn, tag in ((1, "L"), (-1, "R")):
        # Headlight: a swept, slim trapezoid that wraps toward the fender (inner end lower).
        def head(u, v, s=sgn):
            x = lerp(0.47, 0.86, u)
            z_lo = lerp(0.515, 0.585, u ** 1.4)
            z_hi = lerp(0.565, 0.635, u ** 1.2)
            return (s * x, -3.0, lerp(z_lo, z_hi, v))
        projected_patch(surf, f"headlight_{tag}", mc.MATS["lens"], head, 14, 4, fwd, 0.004, root, bulge=0.004)

        def drl(u, v, s=sgn):           # thin LED blade along the top of the headlight
            x = lerp(0.49, 0.85, u)
            z = lerp(0.552, 0.622, u ** 1.2) + v * 0.009
            return (s * x, -3.0, z)
        projected_patch(surf, f"drl_{tag}", mc.MATS["drl"], drl, 14, 1, fwd, 0.0075, root)

        def beam(u, v, s=sgn):          # projector lens area
            x = lerp(0.60, 0.74, u)
            return (s * x, -3.0, lerp(0.535, 0.565, v) + 0.03 * (x - 0.6))
        projected_patch(surf, f"beam_{tag}", mc.MATS["beam"], beam, 4, 1, fwd, 0.0068, root)

        def intake(u, v, s=sgn):        # side intakes in the bumper corners
            x = lerp(0.55, 0.80, u)
            return (s * x, -3.0, lerp(0.22, 0.37 - 0.08 * u, v))
        projected_patch(surf, f"intake_{tag}", mc.MATS["trim"], intake, 6, 3, fwd, 0.002, root)

    def grille(u, v):                   # wide lower grille, trapezoid
        half = lerp(0.40, 0.48, v)
        return ((u * 2 - 1) * half, -3.0, lerp(0.19, 0.39, v))
    projected_patch(surf, "grille", mc.MATS["trim"], grille, 16, 4, fwd, 0.002, root)

    def splitter(u, v):
        return ((u * 2 - 1) * 0.86, -3.0, lerp(0.145, 0.175, v))
    projected_patch(surf, "splitter", mc.MATS["trim"], splitter, 20, 1, fwd, 0.003, root)


def build_rear_details(surf, root):
    back = (0, -1, 0)

    def tail(u, v):                     # full-width light bar on the ducktail
        x = (u * 2 - 1) * 0.86
        return (x, 3.0, lerp(0.745, 0.775, v) - 0.03 * abs(u * 2 - 1) ** 3)
    projected_patch(surf, "taillight_bar", mc.MATS["tail"], tail, 40, 2, back, 0.004, root)

    def diffuser(u, v):
        return ((u * 2 - 1) * 0.74, 3.0, lerp(0.30, 0.43, v))
    projected_patch(surf, "diffuser", mc.MATS["trim"], diffuser, 18, 3, back, 0.002, root)
    for sgn, tag in ((1, "L"), (-1, "R")):
        loc, _ = surf.hit((sgn * 0.48, 3.0, 0.355), back)
        y = loc.y if loc else 2.2
        bpy.ops.mesh.primitive_cylinder_add(vertices=20, radius=0.048, depth=0.16,
                                            location=(sgn * 0.48, y - 0.06, 0.355), rotation=(math.pi / 2, 0, 0))
        ob = bpy.context.active_object
        ob.name = f"exhaust_{tag}"
        ob.data.materials.append(mc.MATS["chrome"])
        ob.parent = root
        bpy.ops.object.shade_smooth()


def build_side_details(surf, root):
    for sgn, tag in ((1, "L"), (-1, "R")):
        side = (-sgn, 0, 0)

        def handle(u, v, s=sgn):        # flush door handle
            return (s * 1.5, lerp(0.30, 0.45, u), lerp(0.735, 0.755, v))
        projected_patch(surf, f"handle_{tag}", mc.MATS["trim"], handle, 4, 1, side, 0.0035, root)


def _subd_object(bm, name, material, levels, root, location=(0, 0, 0)):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = location
    m = ob.modifiers.new("subd", "SUBSURF")
    m.levels = m.render_levels = levels
    apply_mods(ob)
    ob.data.materials.append(material)
    for p in ob.data.polygons:
        p.use_smooth = True
    ob.parent = root
    return ob


def build_mirrors(root):
    """Wing mirror: a subdivided box cage (rounded front, flat rear face with the glass) on a slim
    stalk from the window base. Mirror glass faces backwards (+Y)."""
    for sgn, tag in ((1, "L"), (-1, "R")):
        y0 = CAB_Y[0] + 0.34
        xw = WB(y0) - SH_IN(y0) - 0.075
        x0 = sgn * (xw + 0.16)
        z0 = SH_Z(y0) + 0.13
        bm = bmesh.new()
        res = bmesh.ops.create_cube(bm, size=1.0)
        for v in res["verts"]:
            x, y, z = v.co
            v.co = Vector((x * 0.30, y * (0.19 if y < 0 else 0.10), z * 0.15))   # longer nose in front
        ob = _subd_object(bm, f"mirror_{tag}", mc.MATS["paint"], 2, root, (x0, y0, z0))
        bpy.ops.object.select_all(action="DESELECT")
        g = bmesh.new()
        q = [g.verts.new((dx, 0.074, dz)) for dx, dz in ((-0.075, -0.032), (0.075, -0.032), (0.075, 0.032), (-0.075, 0.032))]
        f = g.faces.new(q)
        f.normal_update()
        if f.normal.y < 0:
            f.normal_flip()
        mc.bm_to_object(g, f"mirror_glass_{tag}", mc.MATS["chrome"], parent=ob)     # local to the housing
        st = bmesh.new()
        res = bmesh.ops.create_cube(st, size=1.0)
        for v in res["verts"]:
            x, y, z = v.co
            v.co = Vector((x * 0.13, y * 0.045, z * 0.02))
        stalk = _subd_object(st, f"mirror_stalk_{tag}", mc.MATS["trim"], 1, root,
                             (x0 - sgn * 0.10, y0 + 0.01, z0 - 0.055))
        stalk.rotation_euler = (0, -sgn * 0.45, 0)


def build_wheel(name, side, location, root):
    """Wheel: shared tyre/barrel/disc from generation 1, new 10-spoke concave rim."""
    ob = mc.build_wheel(name, side, location, root)
    # replace the rim (material slot 1) with a new spoke set: rebuild the whole wheel mesh
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    kill = [f for f in bm.faces if f.material_index == 1]
    bmesh.ops.delete(bm, geom=kill, context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    rim = bmesh.new()
    mc.revolve(rim, [(0.088, 0.236), (0.100, 0.245), (0.116, 0.247), (0.118, 0.232), (0.108, 0.214)], 48, side)
    mc.orient(rim, lambda c: Vector((0, 0, 0)))
    for i in range(10):
        _spoke10(rim, 2 * math.pi * i / 10, side)
    hub = bmesh.ops.create_cone(rim, cap_ends=True, segments=20, radius1=0.072, radius2=0.058, depth=0.032)
    mc._place(hub["verts"], side, 0.080)
    for n in range(5):
        th = 2 * math.pi * n / 5 + 0.31
        nut = bmesh.ops.create_cone(rim, cap_ends=True, segments=6, radius1=0.010, radius2=0.010, depth=0.02)
        mc._place(nut["verts"], side, 0.095, (0.050 * math.cos(th), 0.050 * math.sin(th)))
    tmp = bpy.data.meshes.new("rimtmp")
    rim.to_mesh(tmp)
    rim.free()
    for p in tmp.polygons:
        p.material_index = 1
    bm.from_mesh(tmp)
    bpy.data.meshes.remove(tmp)
    bm.to_mesh(ob.data)
    bm.free()
    for p in ob.data.polygons:
        p.use_smooth = True
    ob.data.set_sharp_from_angle(angle=math.radians(40))
    return ob


def _spoke10(bm, th, side):
    """Slim spoke, wider at the hub, curving outward (concave face) to the lip."""
    n = 5
    rows = []
    for i in range(n + 1):
        t = i / n
        r = 0.066 + (0.215 - 0.066) * t
        half_w = 0.0145 - 0.0055 * t
        a_face = 0.078 + 0.032 * t ** 1.6
        depth = 0.024
        c, s_ = math.cos(th + 0.06 * t), math.sin(th + 0.06 * t)      # slight sweep
        tx, ty = -s_, c
        pts = []
        for (wsg, dsg) in ((-1, 0), (1, 0), (1, 1), (-1, 1)):
            y = r * c + tx * half_w * wsg
            z = r * s_ + ty * half_w * wsg
            pts.append(bm.verts.new(((a_face - depth * dsg) * side, y, z)))
        rows.append(pts)
    for i in range(n):
        centre = sum((v.co for v in rows[i] + rows[i + 1]), Vector()) / 8
        for j in range(4):
            f = bm.faces.new((rows[i][j], rows[i][(j + 1) % 4], rows[i + 1][(j + 1) % 4], rows[i + 1][j]))
            f.normal_update()
            if f.normal.dot(f.calc_center_median() - centre) < 0:
                f.normal_flip()


def build_wheel_wells(root):
    for wx, wy, name in mc.wheel_centres():
        sgn = 1 if wx > 0 else -1
        bm = bmesh.new()
        x_in, x_out = 0.50 * sgn, (WB(wy) + 0.004) * sgn
        n = 28
        r = ARCH_R + 0.006
        a0 = -0.42
        angs = [a0 + (math.pi - 2 * a0) * i / (n - 1) for i in range(n)]
        outer = [bm.verts.new((x_out, wy + r * math.cos(a), WHEEL_R + 0.012 + r * math.sin(a))) for a in angs]
        inner = [bm.verts.new((x_in, wy + r * math.cos(a), WHEEL_R + 0.012 + r * math.sin(a))) for a in angs]
        centre = bm.verts.new((x_in, wy, 0.16))
        for i in range(n - 1):
            bm.faces.new((outer[i], outer[i + 1], inner[i + 1], inner[i]))
            bm.faces.new((inner[i], inner[i + 1], centre))
        for f in bm.faces:
            f.normal_update()
            c = f.calc_center_median()
            want = Vector((wx - c.x, wy - c.y, WHEEL_R - c.z)) if len(f.verts) == 4 else Vector((sgn, 0, 0))
            if f.normal.dot(want) < 0:
                f.normal_flip()
        mc.bm_to_object(bm, f"wheel_well_{name}", mc.MATS["under"], parent=root)


# ------------------------------------------------------------------ main
def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    mc.make_materials()
    mc.MATS["paint"].node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.25
    bsdf = mc.MATS["disc"].node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (0.16, 0.16, 0.165, 1)      # dark cast-iron disc
    mc.MATS["rim"].node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.55, 0.56, 0.58, 1)
    root = bpy.data.objects.new("car_gt", None)
    bpy.context.scene.collection.objects.link(root)

    body = subdivide(build_body_cage(), "body_src", 3)
    cut_arches(body)
    cabin = subdivide(build_cabin_cage(), "cabin_src", 3)
    surf = Surface([body, cabin])
    body_parts = split_parts(body, root)
    cab_parts = split_parts(cabin, root, rename={"body": "cabin_base", "glass": "glass", "roof": "roof",
                                                 "trim_window": "window_trim", "pillar": "pillars"})
    # Triangle budget: the underbody is never seen up close, the bumper faces are over-dense.
    for name, ratio in (("underbody", 0.12), ("bumper_front", 0.55), ("bumper_rear", 0.55)):
        dec = body_parts[name].modifiers.new("dec", "DECIMATE")
        dec.ratio = ratio
        apply_mods(body_parts[name])
    print("[car2] body parts:", sorted(body_parts), "cabin parts:", sorted(cab_parts))

    build_front_details(surf, root)
    build_rear_details(surf, root)
    build_side_details(surf, root)
    build_mirrors(root)
    build_wheel_wells(root)
    mc.build_interior_shell(root)
    mc.build_cabin(root)
    for wx, wy, name in mc.wheel_centres():
        build_wheel(f"wheel_{name}", 1 if wx > 0 else -1, (wx, wy, WHEEL_R), root)
    mc.build_calipers(root)

    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in meshes)
    print(f"[car2] objects={len(meshes)} triangles~{tris}")
    for o in sorted(meshes, key=lambda o: -len(o.data.polygons))[:12]:
        print(f"   {o.name:22s} {sum(len(p.vertices) - 2 for p in o.data.polygons)}")
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if args and args[0] == "--preview":       # iterate on the design without touching the game files
        bpy.ops.wm.save_as_mainfile(filepath=args[1])
        return
    bpy.ops.wm.save_as_mainfile(filepath=mc.BLEND_OUT)
    bpy.ops.export_scene.gltf(filepath=mc.GLB_OUT, export_format="GLB", export_apply=True, export_yup=True)
    print("[car2] exported", mc.GLB_OUT)
    mc.build_lod()


if __name__ == "__main__":
    main()
