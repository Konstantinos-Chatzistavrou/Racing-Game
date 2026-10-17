"""Procedural original GT coupe ("Vela GT"), built from separate parts for future damage/mods.

Run:  tools/blender/blender -b --factory-startup --python assets_source/scripts/make_car.py
Out:  assets_source/models/car_gt.blend      (source of truth)
      game/assets/cars/car_gt.glb            (hero: every panel a separate node)

Blender axes: X = car's left (+X is the driver's side, LHD), -Y = forward, Z = up.
The glTF exporter converts this to +Y up, +Z forward, which is Godot's "model front" convention.

HOW THE BODY IS BUILT (lofting)
The body is a sweep of cross-sections along the car's length s in [0, 1] (0 = nose, 1 = tail).
Every cross-section is a SUPERELLIPSE:  |x/w|^p + |(z - zm)/hh|^p = 1
  w  = half width,  zm = vertical centre,  hh = half height,  p = squareness (2 = ellipse, inf = box).
w(s), bottom height zb(s) and top height zt(s) come from monotone cubic splines (PCHIP) through a few
key values, so the shape is controlled by about 30 numbers. The cabin is added on top as a bump
hc(s) * g(x): g is 1 over the roof, ramps to 0 across the side glass (that ramp IS the
"tumblehome", the inward lean of the side windows) and is 0 outside the greenhouse.
"""
import bpy
import bmesh
import math
import os
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
BLEND_OUT = os.path.join(ROOT, "assets_source", "models", "car_gt.blend")
GLB_OUT = os.path.join(ROOT, "game", "assets", "cars", "car_gt.glb")

# ------------------------------------------------------------------ dimensions (metres)
L = 4.50            # overall length
W = 0.955           # max half width (body 1.91 m)
WHEEL_R = 0.327     # 245/35 R19: rim 0.2413 + sidewall 0.0858
TRACK_HALF = 0.805
Y0 = -L / 2         # nose
FRONT_OVERHANG = 0.95
WHEELBASE = 2.65
Y_FRONT_AXLE = Y0 + FRONT_OVERHANG
Y_REAR_AXLE = Y_FRONT_AXLE + WHEELBASE
ARCH_R = 0.365      # wheel arch radius (tyre + ~5 cm clearance)


def s_of_y(y):
    return (y - Y0) / L


# ------------------------------------------------------------------ PCHIP spline
def pchip(keys):
    """Monotone cubic Hermite interpolation (Fritsch-Carlson). Unlike a plain cubic spline it
    never overshoots between keys, so a body line never gets an unintended bump."""
    xs = [k[0] for k in keys]
    ys = [k[1] for k in keys]
    n = len(xs)
    h = [xs[i + 1] - xs[i] for i in range(n - 1)]
    d = [(ys[i + 1] - ys[i]) / h[i] for i in range(n - 1)]
    m = [0.0] * n
    m[0], m[-1] = d[0], d[-1]
    for i in range(1, n - 1):
        if d[i - 1] * d[i] <= 0:
            m[i] = 0.0
        else:
            w1, w2 = 2 * h[i] + h[i - 1], h[i] + 2 * h[i - 1]
            m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i])

    def f(x):
        if x <= xs[0]:
            return ys[0]
        if x >= xs[-1]:
            return ys[-1]
        i = 0
        while xs[i + 1] < x:
            i += 1
        t = (x - xs[i]) / h[i]
        h00, h10 = 2 * t**3 - 3 * t**2 + 1, t**3 - 2 * t**2 + t
        h01, h11 = -2 * t**3 + 3 * t**2, t**3 - t**2
        return h00 * ys[i] + h10 * h[i] * m[i] + h01 * ys[i + 1] + h11 * h[i] * m[i + 1]
    return f


# ------------------------------------------------------------------ body profile curves
S_FA, S_RA = s_of_y(Y_FRONT_AXLE), s_of_y(Y_REAR_AXLE)

zb_f = pchip([(0, 0.27), (0.03, 0.18), (0.08, 0.14), (0.2, 0.13), (0.85, 0.14), (0.94, 0.22), (1.0, 0.38)])
zt_f = pchip([(0, 0.43), (0.04, 0.58), (0.12, 0.69), (0.22, 0.765), (0.34, 0.81), (0.6, 0.88),
              (0.82, 0.92), (0.95, 0.935), (1.0, 0.80)])
hc_f = pchip([(0.335, 0.0), (0.40, 0.17), (0.47, 0.355), (0.56, 0.385), (0.62, 0.37), (0.72, 0.22), (0.83, 0.0)])
p_f = pchip([(0, 3.8), (0.2, 3.6), (0.5, 3.4), (0.8, 3.8), (1.0, 3.2)])


def half_width(s):
    """Plan view: superellipse ends (rounder nose than tail) + fender flares over each axle."""
    u = 2 * s - 1
    pp = 3.2 if u < 0 else 4.5
    base = (max(0.0, 1 - abs(u) ** pp)) ** (1 / pp)
    flare = 0.022 * math.exp(-((s - S_FA) / 0.07) ** 2) + 0.035 * math.exp(-((s - S_RA) / 0.08) ** 2)
    return W * base * (0.975 + 0.025 * s) + flare * base


# contour layout (half section, bottom centre -> top centre)
N_LO, N_UP, N_RAMP, N_ROOF = 14, 7, 6, 10
K_LAST = N_LO + N_UP + N_RAMP + N_ROOF - 1        # index of top-centre point
K_UP0 = N_LO                                       # first upper-shoulder point
K_RAMP0 = N_LO + N_UP                              # first greenhouse-ramp point
K_ROOF0 = K_RAMP0 + N_RAMP                         # first roof point
GB_RATIO = 0.80                                    # greenhouse base half width / body half width
TUMBLEHOME = 0.20                                  # roof half width = base half width - this


def section(s, inset=0.0):
    """Half cross-section at station s: list of (x, z), from bottom centre to top centre.
    inset > 0 shrinks it (used for the black interior shell)."""
    w = max(half_width(s) - inset * 1.6, 0.0)
    zb = zb_f(s) + inset * 0.6
    zt = zt_f(s) - inset * 0.5
    p = p_f(s)
    zm, hh = (zb + zt) / 2, max((zt - zb) / 2, 1e-4)
    hc = max(hc_f(s) - inset * 0.5, 0.0)
    gb = GB_RATIO * w
    gt = max(gb - TUMBLEHOME, 0.0) if w > 0 else 0.0

    def se(alpha):           # superellipse point for angle alpha
        c, sn = math.cos(alpha), math.sin(alpha)
        return (w * abs(c) ** (2 / p), zm + math.copysign(hh * abs(sn) ** (2 / p), sn))

    def top_z(x):            # superellipse upper surface height at |x|, plus the cabin bump
        x = abs(x)
        z = zm + hh * max(0.0, 1 - min(1.0, x / w) ** p) ** (1 / p) if w > 1e-6 else zt
        if gb - gt > 1e-6:
            g = min(1.0, max(0.0, (gb - x) / (gb - gt)))
        else:
            g = 1.0 if x <= gb else 0.0
        return z + hc * g

    pts = []
    for k in range(N_LO):                       # bottom centre -> widest point
        pts.append(se(-math.pi / 2 + (math.pi / 2) * k / (N_LO - 1)))
    a_b = math.acos(min(1.0, GB_RATIO ** (p / 2)))     # angle where x == greenhouse base
    for k in range(1, N_UP + 1):                # shoulder: widest point -> greenhouse base
        pts.append(se(a_b * k / N_UP))
    pts[-1] = (gb, top_z(gb))
    for k in range(1, N_RAMP + 1):              # side glass ramp
        x = gb + (gt - gb) * k / N_RAMP
        pts.append((x, top_z(x)))
    for k in range(1, N_ROOF + 1):              # roof / hood centre
        x = gt * (1 - k / N_ROOF)
        pts.append((x, top_z(x)))
    return pts


def stations(n):
    """Cosine spacing: dense at the nose and tail where curvature is highest."""
    return [0.5 - 0.5 * math.cos(math.pi * i / (n - 1)) for i in range(n)]


def build_loft(name, n_st, inset=0.0):
    """Closed body surface. Faces carry int layers 'st' (station) and 'k' (contour index on
    the half section) and 'side' (+1 / -1), used later to cut it into panels."""
    bm = bmesh.new()
    st_l = bm.faces.layers.int.new("st")
    k_l = bm.faces.layers.int.new("k")
    side_l = bm.faces.layers.int.new("side")
    ss = stations(n_st)
    rings = []
    for s in ss:
        half = section(s, inset)
        y = Y0 + s * L
        right = [bm.verts.new((x, y, z)) for (x, z) in half]                        # +X side
        left = [bm.verts.new((-x, y, z)) for (x, z) in reversed(half[1:-1])]         # -X side
        rings.append(right + left)
    m = len(rings[0])
    for i in range(n_st - 1):
        for j in range(m):
            a, b = rings[i][j], rings[i][(j + 1) % m]
            c, d = rings[i + 1][(j + 1) % m], rings[i + 1][j]
            try:
                f = bm.faces.new((a, b, c, d))
            except ValueError:
                continue
            f[st_l] = i
            if j < K_LAST:
                f[k_l], f[side_l] = j, 1
            else:
                f[k_l], f[side_l] = (2 * K_LAST - 1) - j, -1
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)       # weld collapsed nose/tail
    degenerate = [f for f in bm.faces if f.calc_area() < 1e-9]
    bmesh.ops.delete(bm, geom=degenerate, context="FACES")
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm, ss


# ------------------------------------------------------------------ materials
def mat(name, color, metallic=0.0, rough=0.5, emission=None, strength=0.0, alpha=1.0, coat=0.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = (*color, 1.0)
    b.inputs["Metallic"].default_value = metallic
    b.inputs["Roughness"].default_value = rough
    if coat > 0:
        b.inputs["Coat Weight"].default_value = coat
        b.inputs["Coat Roughness"].default_value = 0.03
    if emission:
        b.inputs["Emission Color"].default_value = (*emission, 1.0)
        b.inputs["Emission Strength"].default_value = strength
    if alpha < 1.0:
        b.inputs["Alpha"].default_value = alpha
        m.surface_render_method = "BLENDED"
    return m


MATS = {}


def make_materials():
    MATS["paint"] = mat("paint", (0.55, 0.03, 0.02), metallic=0.6, rough=0.28, coat=1.0)
    MATS["glass"] = mat("glass", (0.01, 0.012, 0.014), rough=0.02, alpha=0.72)
    MATS["trim"] = mat("trim_black", (0.012, 0.012, 0.012), rough=0.45)
    MATS["under"] = mat("underbody", (0.008, 0.008, 0.008), rough=0.9)
    MATS["interior"] = mat("interior", (0.015, 0.014, 0.013), rough=0.75)
    MATS["chrome"] = mat("chrome", (0.9, 0.9, 0.9), metallic=1.0, rough=0.08)
    MATS["lens"] = mat("headlight_lens", (0.7, 0.72, 0.75), metallic=1.0, rough=0.12)
    MATS["drl"] = mat("light_drl", (1, 1, 1), emission=(0.85, 0.92, 1.0), strength=12.0)
    MATS["beam"] = mat("light_beam", (1, 1, 1), emission=(1.0, 0.95, 0.85), strength=25.0)
    MATS["tail"] = mat("light_tail", (0.4, 0.0, 0.0), emission=(1.0, 0.02, 0.01), strength=8.0)
    MATS["rubber"] = mat("tyre_rubber", (0.022, 0.022, 0.022), rough=0.88)
    MATS["rim"] = mat("rim_alloy", (0.42, 0.43, 0.45), metallic=1.0, rough=0.28)
    MATS["rim_inner"] = mat("rim_inner", (0.03, 0.03, 0.032), metallic=0.8, rough=0.5)
    MATS["disc"] = mat("brake_disc", (0.45, 0.45, 0.45), metallic=1.0, rough=0.42)
    MATS["caliper"] = mat("brake_caliper", (0.85, 0.55, 0.02), rough=0.35)


# ------------------------------------------------------------------ object helpers
def bm_to_object(bm, name, material, smooth_angle=35.0, parent=None):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(material)
    for p in me.polygons:
        p.use_smooth = True
    me.set_sharp_from_angle(angle=math.radians(smooth_angle))
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    if parent:
        ob.parent = parent
    return ob


def sub_bmesh(src, faces):
    """Copy a subset of faces into a new bmesh (keeps layers)."""
    bm = bmesh.new()
    vmap = {}
    st_l = bm.faces.layers.int.new("st")
    for f in faces:
        vs = []
        for v in f.verts:
            if v not in vmap:
                vmap[v] = bm.verts.new(v.co)
            vs.append(vmap[v])
        try:
            bm.faces.new(vs)
        except ValueError:
            pass
    return bm


def shrink_boundary(bm, gap):
    """Panel gap: pull every open-edge vertex `gap` metres toward the panel interior.
    Two neighbouring panels each retreat by `gap`, giving a visible shut line of 2*gap."""
    moves = {}
    for v in bm.verts:
        if not any(e.is_boundary for e in v.link_edges):
            continue
        inner = [e.other_vert(v) for e in v.link_edges if not e.is_boundary]
        if not inner:
            continue
        c = sum((u.co for u in inner), Vector()) / len(inner)
        d = c - v.co
        if d.length > 1e-6:
            moves[v] = v.co + d.normalized() * min(gap, d.length * 0.45)
    for v, co in moves.items():
        v.co = co


# ------------------------------------------------------------------ body + panels
def wheel_centres():
    return [(TRACK_HALF, Y_FRONT_AXLE, "FL"), (-TRACK_HALF, Y_FRONT_AXLE, "FR"),
            (TRACK_HALF, Y_REAR_AXLE, "RL"), (-TRACK_HALF, Y_REAR_AXLE, "RR")]


def cut_arches(bm):
    """Delete body faces inside each wheel arch (side view circle) on the outer side, then snap
    the jagged hole edge exactly onto the circle so the arch is perfectly round."""
    for wx, wy, _ in wheel_centres():
        kill = []
        for f in bm.faces:
            c = f.calc_center_median()
            # only side-facing faces: the fender top (normal pointing up) is never cut
            if c.x * wx > 0 and (abs(f.normal.x) > 0.3 or f.normal.z < 0) and math.hypot(c.y - wy, c.z - WHEEL_R) < ARCH_R:
                kill.append(f)
        bmesh.ops.delete(bm, geom=kill, context="FACES")
        for v in bm.verts:
            if v.co.x * wx <= 0 or abs(v.co.x) < 0.42:
                continue
            if not any(e.is_boundary for e in v.link_edges):
                continue
            dy, dz = v.co.y - wy, v.co.z - WHEEL_R
            r = math.hypot(dy, dz)
            if r < ARCH_R + 0.07 and r > 1e-6:
                v.co.y, v.co.z = wy + dy / r * ARCH_R, WHEEL_R + dz / r * ARCH_R


def classify(st_s, k, side):
    """Which part a body face belongs to, from its station s and half-contour index k."""
    s = st_s
    top = k >= K_UP0 + 4            # upper surface (hood / roof / deck)
    if K_RAMP0 + 1 <= k < K_ROOF0 - 1 and 0.405 < s < 0.75 and hc_f(s) > 0.10:
        return "glass"                       # side windows
    if k >= K_RAMP0 + 3 and 0.345 < s < 0.468:
        return "glass"                       # windscreen (thin A-pillar = outer ramp faces)
    if k >= K_ROOF0 - 1 and 0.64 < s < 0.805:
        return "glass"                       # rear window (fastback)
    if k <= 1:
        return "underbody"
    if s < 0.075 or (s < 0.13 and k < K_UP0 - 2):
        return "bumper_front"
    if s > 0.965 or (s > 0.9 and k < K_UP0 - 3):
        return "bumper_rear"
    if top and 0.075 <= s <= 0.33:
        return "hood"
    if top and 0.83 <= s <= 0.965:
        return "trunk"
    if 2 <= k <= 4 and 0.27 < s < 0.74:
        return "skirt"
    if 0.355 < s < 0.625 and 5 <= k < K_RAMP0:
        return "door_L" if side > 0 else "door_R"
    return "body"


PART_MAT = {"glass": "glass", "underbody": "under", "skirt": "trim"}


def build_body(root):
    bm, ss = build_loft("body", 140)
    cut_arches(bm)
    st_l, k_l, side_l = bm.faces.layers.int["st"], bm.faces.layers.int["k"], bm.faces.layers.int["side"]
    groups = {}
    for f in bm.faces:
        s_mid = 0.5 * (ss[f[st_l]] + ss[min(f[st_l] + 1, len(ss) - 1)])
        groups.setdefault(classify(s_mid, f[k_l], f[side_l]), []).append(f)
    for part, faces in groups.items():
        sub = sub_bmesh(bm, faces)
        if part != "glass":
            shrink_boundary(sub, 0.0035)
        bmesh.ops.recalc_face_normals(sub, faces=sub.faces)
        _fix_outward(sub)
        bm_to_object(sub, part, MATS[PART_MAT.get(part, "paint")], parent=root)
    bm.free()


def _fix_outward(bm):
    """Open panels can't use the closed-mesh normal test reliably: make normals point away from
    the car's centre line (body is roughly convex around the axis x=0, z=0.6)."""
    score = 0.0
    for f in bm.faces:
        c = f.calc_center_median()
        score += f.normal.dot(Vector((c.x, 0.15 * c.y, c.z - 0.55)))
    if score < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces)


def build_interior_shell(root):
    """Low-poly black inner shell: what you see through windows and panel gaps. It is narrower
    than the wheels so it never pokes through the arches."""
    bm, _ = build_loft("shell", 34, inset=0.2)
    for f in bm.faces:
        f.material_index = 0
    bm_to_object(bm, "interior_shell", MATS["interior"], parent=root)


def build_wheel_wells(root):
    for wx, wy, name in wheel_centres():
        sgn = 1 if wx > 0 else -1
        bm = bmesh.new()
        x_in, x_out = 0.56 * sgn, (half_width(s_of_y(wy)) + 0.01) * sgn
        n = 24
        zb = zb_f(s_of_y(wy))
        a0 = math.asin(max(-1.0, min(1.0, (zb - WHEEL_R) / ARCH_R)))
        angs = [a0 + (math.pi - 2 * a0) * i / (n - 1) for i in range(n)]
        r = ARCH_R + 0.004
        outer = []
        for a in angs:
            py, pz = wy + r * math.cos(a), WHEEL_R + r * math.sin(a)
            xo = max(abs(x_in) + 0.02, _reach(s_of_y(py), pz) - 0.012) * sgn
            outer.append(bm.verts.new((xo, py, pz)))
        inner = [bm.verts.new((x_in, wy + r * math.cos(a), WHEEL_R + r * math.sin(a))) for a in angs]
        centre = bm.verts.new((x_in, wy, zb))
        for i in range(n - 1):
            bm.faces.new((outer[i], outer[i + 1], inner[i + 1], inner[i]))
            bm.faces.new((inner[i], inner[i + 1], centre))
        # normals must face the wheel (inward / outward-x for the inner wall)
        for f in bm.faces:
            f.normal_update()
            c = f.calc_center_median()
            want = Vector((wx - c.x, wy - c.y, WHEEL_R - c.z))
            if len(f.verts) == 3:
                want = Vector((sgn, 0, 0))
            if f.normal.dot(want) < 0:
                f.normal_flip()
        bm_to_object(bm, f"wheel_well_{name}", MATS["under"], parent=root)


# ------------------------------------------------------------------ surface-attached details
def front_face_y(x, z):
    """y of the body surface seen from the front at (x, z): smallest station whose section reaches
    beyond |x| at height z. Bisection on s in [0, 0.2]."""
    return _face_y(x, z, 0.0, 0.2, front=True)


def rear_face_y(x, z):
    return _face_y(x, z, 0.8, 1.0, front=False)


def _reach(s, z):
    """Half width of the section at station s at height z."""
    pts = section(s)
    best = 0.0
    for (x0, z0), (x1, z1) in zip(pts, pts[1:]):
        if (z0 - z) * (z1 - z) <= 0 and abs(z1 - z0) > 1e-9:
            best = max(best, x0 + (x1 - x0) * (z - z0) / (z1 - z0))
    return best


def _face_y(x, z, lo, hi, front):
    for _ in range(30):
        mid = 0.5 * (lo + hi)
        inside = _reach(mid, z) >= abs(x)
        if front:
            lo, hi = (lo, mid) if inside else (mid, hi)
        else:
            lo, hi = (mid, hi) if inside else (lo, mid)
    return Y0 + 0.5 * (lo + hi) * L


def surface_patch(name, material, xs, zs, front, offset, root, nx=10, nz=3):
    """Thin patch hugging the front or rear face over x in xs, z in zs (lights, grille)."""
    bm = bmesh.new()
    grid = []
    for j in range(nz + 1):
        z = zs[0] + (zs[1] - zs[0]) * j / nz
        row = []
        for i in range(nx + 1):
            x = xs[0] + (xs[1] - xs[0]) * i / nx
            y = front_face_y(x, z) if front else rear_face_y(x, z)
            y += -offset if front else offset
            row.append(bm.verts.new((x, y, z)))
        grid.append(row)
    for j in range(nz):
        for i in range(nx):
            bm.faces.new((grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]))
    want = Vector((0, -1 if front else 1, 0))
    for f in bm.faces:
        f.normal_update()               # bmesh leaves new faces with a zero normal
        if f.normal.dot(want) < 0:
            f.normal_flip()
    return bm_to_object(bm, name, material, smooth_angle=60, parent=root)


def build_lights(root):
    for sgn, tag in ((1, "L"), (-1, "R")):
        xa, xb = sorted((sgn * 0.50, sgn * 0.80))
        surface_patch(f"headlight_{tag}", MATS["lens"], (xa, xb), (0.495, 0.560), True, 0.006, root)
        surface_patch(f"drl_{tag}", MATS["drl"], (xa, xb), (0.546, 0.560), True, 0.010, root, nz=1)
        xc, xd = sorted((sgn * 0.58, sgn * 0.70))
        surface_patch(f"beam_{tag}", MATS["beam"], (xc, xd), (0.505, 0.535), True, 0.009, root, nx=4, nz=1)
    surface_patch("taillight_bar", MATS["tail"], (-0.84, 0.84), (0.72, 0.75), False, 0.006, root, nx=40, nz=2)
    surface_patch("grille", MATS["trim"], (-0.45, 0.45), (0.22, 0.37), True, 0.004, root, nx=12, nz=4)
    surface_patch("diffuser", MATS["trim"], (-0.72, 0.72), (0.24, 0.40), False, 0.004, root, nx=16, nz=3)


def build_mirrors(root):
    s = 0.40
    for sgn, tag in ((1, "L"), (-1, "R")):
        y = Y0 + s * L
        x = (half_width(s) * GB_RATIO + 0.10) * sgn
        z = zt_f(s) + 0.10
        bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, radius=1, location=(x + 0.04 * sgn, y, z))
        ob = bpy.context.active_object
        ob.scale = (0.11, 0.065, 0.06)
        ob.name = f"mirror_{tag}"
        ob.data.materials.append(MATS["paint"])
        ob.parent = root
        bpy.ops.object.shade_smooth()
        bpy.ops.mesh.primitive_cube_add(size=1, location=(x - 0.02 * sgn, y + 0.01, z - 0.045))
        st = bpy.context.active_object
        st.scale = (0.10, 0.03, 0.015)
        st.name = f"mirror_stalk_{tag}"
        st.data.materials.append(MATS["trim"])
        st.parent = root


def build_exhausts(root):
    yr = rear_face_y(0.4, 0.3)
    for sgn in (1, -1):
        bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=0.045, depth=0.16,
                                            location=(0.42 * sgn, yr - 0.05, 0.27), rotation=(math.pi / 2, 0, 0))
        ob = bpy.context.active_object
        ob.name = f"exhaust_{'L' if sgn > 0 else 'R'}"
        ob.data.materials.append(MATS["chrome"])
        ob.parent = root
        bpy.ops.object.shade_smooth()


def build_cabin(root):
    """Simple interior visible through the tinted glass: two seats, dash, steering wheel."""
    seat_y = Y0 + 0.585 * L
    for sgn in (1, -1):
        bpy.ops.mesh.primitive_cube_add(size=1, location=(0.37 * sgn, seat_y, 0.33))
        b = bpy.context.active_object
        b.scale = (0.48, 0.50, 0.14)
        b.name = f"seat_base_{sgn}"
        bpy.ops.mesh.primitive_cube_add(size=1, location=(0.37 * sgn, seat_y + 0.25, 0.68), rotation=(-0.25, 0, 0))
        bk = bpy.context.active_object
        bk.scale = (0.46, 0.12, 0.62)
        bk.name = f"seat_back_{sgn}"
        for o in (b, bk):
            o.data.materials.append(MATS["interior"])
            o.parent = root
            bev = o.modifiers.new("bevel", "BEVEL")
            bev.width, bev.segments = 0.04, 2
    dash_y = Y0 + 0.40 * L
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, dash_y, 0.80))
    d = bpy.context.active_object
    d.scale = (1.35, 0.35, 0.16)
    d.name = "dashboard"
    d.data.materials.append(MATS["interior"])
    d.parent = root
    bpy.ops.mesh.primitive_torus_add(major_radius=0.18, minor_radius=0.018, major_segments=24, minor_segments=6,
                                     location=(0.37, dash_y + 0.27, 0.86), rotation=(math.radians(70), 0, 0))
    sw = bpy.context.active_object
    sw.name = "steering_rim"   # NOT "..._wheel": Godot turns names ending in "wheel" into VehicleWheel3D
    sw.data.materials.append(MATS["interior"])
    sw.parent = root


# ------------------------------------------------------------------ wheels
def revolve(bm, profile, segs, side):
    """Lathe: rotate a (axial a, radius r) profile around the X axis. Returns rings of verts.
    a is mirrored by `side` so the wheel's outer face points away from the car."""
    rings = []
    for i in range(segs):
        th = 2 * math.pi * i / segs
        c, s = math.cos(th), math.sin(th)
        rings.append([bm.verts.new((a * side, r * c, r * s)) for (a, r) in profile])
    for i in range(segs):
        r0, r1 = rings[i], rings[(i + 1) % segs]
        for j in range(len(profile) - 1):
            bm.faces.new((r0[j], r0[j + 1], r1[j + 1], r1[j]))
    return rings


def orient(bm, centre_fn):
    """Point each face away from a reference point chosen per face (centre_fn(face_centre))."""
    for f in bm.faces:
        f.normal_update()
        c = f.calc_center_median()
        if f.normal.dot(c - centre_fn(c)) < 0:
            f.normal_flip()


def build_wheel(name, side, location, root):
    """One wheel: tyre + rim + brake disc in one object (all rotate together), origin = hub centre.
    side = +1 for wheels on +X, -1 on -X (outer face points away from the car)."""
    tyre = bmesh.new()
    rim_r, tw = 0.2413, 0.1225
    prof = [(-0.105, rim_r), (-0.118, 0.262), (-tw, 0.300), (-0.112, 0.320), (-0.095, WHEEL_R)]
    for g in (-0.055, -0.018, 0.018, 0.055):            # four circumferential tread grooves
        prof += [(g - 0.006, WHEEL_R), (g - 0.004, WHEEL_R - 0.007), (g + 0.004, WHEEL_R - 0.007), (g + 0.006, WHEEL_R)]
    prof += [(0.095, WHEEL_R), (0.112, 0.320), (tw, 0.300), (0.118, 0.262), (0.105, rim_r)]
    revolve(tyre, prof, 48, side)
    orient(tyre, lambda c: Vector((c.x * 0.2, 0, 0)))   # away from the axle

    barrel = bmesh.new()                                # inner barrel: dark, faces the axle
    revolve(barrel, [(-0.105, 0.236), (0.088, 0.236)], 40, side)
    orient(barrel, lambda c: Vector((c.x, c.y * 2, c.z * 2)))
    rim = bmesh.new()                                   # polished outer lip
    revolve(rim, [(0.088, 0.236), (0.100, 0.244), (0.114, 0.246), (0.116, 0.230), (0.106, 0.214)], 40, side)
    orient(rim, lambda c: Vector((0, 0, 0)))
    # 5 twin spokes, concave dish: hub sits further inboard than the lip.
    for i in range(10):
        th = 2 * math.pi * (i // 2) / 5 + (0.17 if i % 2 else -0.17) * 0.5
        _spoke(rim, th, side)
    # hub + centre cap
    hub = bmesh.ops.create_cone(rim, cap_ends=True, segments=16, radius1=0.07, radius2=0.055, depth=0.03)
    _place(hub["verts"], side, 0.088)
    nuts_r = 0.052
    for n in range(5):
        th = 2 * math.pi * n / 5
        nut = bmesh.ops.create_cone(rim, cap_ends=True, segments=6, radius1=0.011, radius2=0.011, depth=0.018)
        _place(nut["verts"], side, 0.105, (nuts_r * math.cos(th), nuts_r * math.sin(th)))

    disc = bmesh.new()
    dprof = [(-0.040, 0.105), (-0.040, 0.180), (-0.010, 0.180), (-0.010, 0.105), (0.03, 0.100), (0.03, 0.06)]
    revolve(disc, dprof, 36, side)
    orient(disc, lambda c: Vector((-0.025 * side, 0, 0)))

    ob = _merge_parts(name, [(tyre, MATS["rubber"]), (rim, MATS["rim"]), (disc, MATS["disc"]), (barrel, MATS["rim_inner"])])
    ob.location = location
    ob.parent = root
    return ob


def _place(verts, side, a, yz=(0.0, 0.0)):
    """create_cone builds along Z; rotate to the X axis, push out to axial position a."""
    for v in verts:
        x, y, z = v.co
        v.co = Vector((z + a, x + yz[0], y + yz[1]))
        v.co.x *= side


def _spoke(bm, th, side):
    """Tapered spoke from hub (r=0.06) to lip (r=0.215), with a concave (dished) face."""
    n = 4
    rows = []
    for i in range(n + 1):
        t = i / n
        r = 0.065 + (0.212 - 0.065) * t
        half_w = 0.020 - 0.008 * t
        a_face = 0.088 + 0.022 * t ** 1.5           # dish curve
        depth = 0.030
        c, s = math.cos(th), math.sin(th)
        tx, ty = -s, c                              # tangential direction
        pts = []
        for (wsg, dsg) in ((-1, 0), (1, 0), (1, 1), (-1, 1)):
            y = r * c + tx * half_w * wsg
            z = r * s + ty * half_w * wsg
            pts.append(bm.verts.new(((a_face - depth * dsg) * side, y, z)))
        rows.append(pts)
    for i in range(n):
        centre = sum((v.co for v in rows[i] + rows[i + 1]), Vector()) / 8
        for j in range(4):
            f = bm.faces.new((rows[i][j], rows[i][(j + 1) % 4], rows[i + 1][(j + 1) % 4], rows[i + 1][j]))
            f.normal_update()
            if f.normal.dot(f.calc_center_median() - centre) < 0:
                f.normal_flip()


def _merge_parts(name, parts):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    for idx, (src, m) in enumerate(parts):
        tmp = bpy.data.meshes.new("tmp")
        src.to_mesh(tmp)
        src.free()
        for p in tmp.polygons:
            p.material_index = idx
        bm.from_mesh(tmp)
        bpy.data.meshes.remove(tmp)
    bm.to_mesh(me)
    bm.free()
    for _, m in parts:
        me.materials.append(m)
    for p in me.polygons:
        p.use_smooth = True
    me.set_sharp_from_angle(angle=math.radians(40))
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def build_calipers(root):
    for wx, wy, name in wheel_centres():
        side = 1 if wx > 0 else -1
        bm = bmesh.new()
        prof = [(-0.055, 0.125), (-0.055, 0.198), (0.012, 0.198), (0.012, 0.125)]
        # an arc block: revolve the profile over ~50 degrees at the rear-top of the disc
        segs = 8
        rings = []
        for i in range(segs + 1):
            th = math.radians(20 + 50 * i / segs)
            c, s = math.cos(th), math.sin(th)
            rings.append([bm.verts.new((a * side, r * c, r * s)) for (a, r) in prof])
        for i in range(segs):
            for j in range(4):
                bm.faces.new((rings[i][j], rings[i][(j + 1) % 4], rings[i + 1][(j + 1) % 4], rings[i + 1][j]))
        bm.faces.new(rings[0])
        bm.faces.new(list(reversed(rings[-1])))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        ob = bm_to_object(bm, f"caliper_{name}", MATS["caliper"], smooth_angle=30, parent=root)
        ob.location = (wx, wy, WHEEL_R)


# ------------------------------------------------------------------ main
def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    make_materials()
    root = bpy.data.objects.new("car_gt", None)
    bpy.context.scene.collection.objects.link(root)
    build_body(root)
    build_interior_shell(root)
    build_wheel_wells(root)
    build_lights(root)
    build_mirrors(root)
    build_exhausts(root)
    build_cabin(root)
    for wx, wy, name in wheel_centres():
        build_wheel(f"wheel_{name}", 1 if wx > 0 else -1, (wx, wy, WHEEL_R), root)
    build_calipers(root)

    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in bpy.data.objects if o.type == "MESH")
    print(f"[car] objects={len([o for o in bpy.data.objects if o.type == 'MESH'])} triangles~{tris}")

    os.makedirs(os.path.dirname(BLEND_OUT), exist_ok=True)
    os.makedirs(os.path.dirname(GLB_OUT), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=BLEND_OUT)
    bpy.ops.export_scene.gltf(filepath=GLB_OUT, export_format="GLB", export_apply=True, export_yup=True)
    print("[car] exported", GLB_OUT)
    build_lod()


# Distance LOD: everything merged into ONE object with 6 materials, decimated to ~6k triangles.
# Used beyond ~30 m and for most parked cars: ~6 draw calls instead of ~50.
LOD_OUT = os.path.join(ROOT, "game", "assets", "cars", "car_gt_lod.glb")
LOD_MAP = {"paint": "paint", "glass": "glass", "light_drl": "light_front", "light_beam": "light_front",
           "light_tail": "light_tail", "rim_alloy": "metal", "brake_disc": "metal", "chrome": "metal",
           "headlight_lens": "metal", "brake_caliper": "metal"}     # everything else -> "dark"


def build_lod():
    lod_mats = {"paint": MATS["paint"], "glass": MATS["glass"],
                "light_front": mat("light_front", (1, 1, 1), emission=(0.9, 0.95, 1.0), strength=12.0),
                "light_tail": mat("light_tail_lod", (0.4, 0.0, 0.0), emission=(1.0, 0.02, 0.01), strength=8.0),
                "metal": mat("metal", (0.55, 0.55, 0.57), metallic=1.0, rough=0.25),
                "dark": mat("dark", (0.015, 0.015, 0.015), rough=0.6)}
    order = list(lod_mats)
    parts = []
    for ob in list(bpy.data.objects):
        if ob.type != "MESH" or ob.name in ("interior_shell",) or ob.name.startswith(("seat", "dashboard", "steering")):
            continue
        dup = ob.copy()
        dup.data = ob.data.copy()
        bpy.context.scene.collection.objects.link(dup)
        dup.matrix_world = ob.matrix_world.copy()
        dup.parent = None
        dup.matrix_world = ob.matrix_world
        for mod in list(dup.modifiers):
            bpy.context.view_layer.objects.active = dup
            bpy.ops.object.modifier_apply(modifier=mod.name)
        # remap material slots to the 6 LOD materials
        me = dup.data
        idx = []
        for slot in me.materials:
            idx.append(order.index(LOD_MAP.get(slot.name if slot else "", "dark")))
        for p in me.polygons:
            p.material_index = idx[p.material_index] if idx else order.index("dark")
        me.materials.clear()
        for k in order:
            me.materials.append(lod_mats[k])
        parts.append(dup)
    for o in bpy.context.selected_objects:
        o.select_set(False)
    for o in parts:
        o.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    bpy.ops.object.join()
    lod = bpy.context.active_object
    lod.name = "car_lod"
    tris = sum(len(p.vertices) - 2 for p in lod.data.polygons)
    dec = lod.modifiers.new("decimate", "DECIMATE")
    dec.ratio = min(1.0, 6000.0 / max(tris, 1))
    bpy.ops.object.modifier_apply(modifier="decimate")
    for o in list(bpy.data.objects):
        o.select_set(o == lod)
    bpy.ops.export_scene.gltf(filepath=LOD_OUT, export_format="GLB", export_apply=True, export_yup=True, use_selection=True)
    print(f"[car] LOD: {tris} -> {sum(len(p.vertices) - 2 for p in lod.data.polygons)} triangles, "
          f"{len(lod.data.materials)} materials -> {LOD_OUT}")


if __name__ == "__main__":
    main()
