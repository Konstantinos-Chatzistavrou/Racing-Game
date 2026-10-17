"""Procedural original night street circuit ("Harbour Loop", ~1.7 km, clockwise).

Run:  tools/blender/blender -b --factory-startup --python assets_source/scripts/make_track.py
Out:  assets_source/models/track_harbour.blend   (source of truth)
      game/assets/track/track_harbour.glb        (visual chunks + "-colonly" collision + lights)
      data/tracks/harbour_loop.json              (engine-neutral centreline for lap timing / AI)

Coordinates: Blender world = Z-up, right-handed, metres, which is ALSO the physics core convention,
so the JSON needs no conversion. The glTF exporter converts to Godot's Y-up on its own.

LAYOUT: a "turtle" path (straights + constant-radius arcs). Two straights have unknown lengths
that are solved so the loop closes exactly. The polyline is then Laplacian-smoothed, which
blends straight->arc joints (a crude stand-in for real clothoid transition curves).

CROSS-SECTION (left side; the right side mirrors it), lateral l from centreline:
  0..6.0 m   asphalt road (12 m wide, typical street-circuit width)
  6.0..7.2   kerb (in corners) or asphalt run-off strip
  7.2..7.8   concrete jersey barrier, 0.81 m tall, catch fence on top
  7.8..11.8  pavement (+0.15 m)
  11.8..30   urban lot (grass), buildings sit on it
ROAD SURFACE HEIGHT  z(l) = z_c + crown(l) * (1 - b) + bank * l * b
  crown: 2.5 % crossfall falling away from the centre (drainage);
  bank:  superelevation toward the inside of a corner, up to 5 %;
  b = min(1, |curvature| * 60): pure crown on straights, pure banking for R < 60 m.
"""
import bpy
import bmesh
import json
import math
import os
import random
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
TEX = os.path.join(ROOT, "assets_source", "textures")
BLEND_OUT = os.path.join(ROOT, "assets_source", "models", "track_harbour.blend")
GLB_OUT = os.path.join(ROOT, "game", "assets", "track", "track_harbour.glb")
JSON_OUT = os.path.join(ROOT, "data", "tracks", "harbour_loop.json")

STEP = 2.0            # centreline sample spacing (m)
ROAD_HALF = 6.0
EDGE = 7.2            # kerb / run-off outer edge
WALL_OUT = 7.8
PAVE_OUT = 11.8
LOT_OUT = 30.0
CHUNK = 80            # samples per chunk (160 m): unit of culling + draw calls
random.seed(7)


# ======================================================================== layout
def turtle(segs):
    """segs: ('S', length) or ('A', radius, degrees; + = left turn). Returns dense points (1 m)."""
    x, y, h = 0.0, 0.0, 0.0
    pts = [(x, y)]
    for sg in segs:
        if sg[0] == "S":
            n = max(1, int(sg[1]))
            for _ in range(n):
                x += math.cos(h) * sg[1] / n
                y += math.sin(h) * sg[1] / n
                pts.append((x, y))
        else:
            r, ang = sg[1], math.radians(sg[2])
            n = max(2, int(abs(ang) * r))
            for _ in range(n):
                h += ang / n
                x += math.cos(h) * abs(ang) * r / n
                y += math.sin(h) * abs(ang) * r / n
                pts.append((x, y))
    return pts, (x, y, h)


def layout():
    def segs(a, b):
        return [("S", 380), ("A", 28, -90), ("S", 120), ("A", 80, -40), ("A", 80, 40), ("S", 90),
                ("A", 22, -90), ("S", a), ("A", 16, 50), ("A", 16, -100), ("A", 16, 50), ("S", 60),
                ("A", 30, -90), ("S", b), ("A", 26, -90)]
    # The end point is linear in a (heading -X) and b (heading +Y): solve for closure.
    _, (x0, y0, _) = turtle(segs(0.0, 0.0))
    a, b = x0, -y0
    assert a > 20 and b > 20, f"layout does not close sensibly: a={a:.1f} b={b:.1f}"
    pts, (xe, ye, he) = turtle(segs(a, b))
    print(f"[track] solved straights a={a:.1f} m b={b:.1f} m, closure error {math.hypot(xe, ye):.3f} m")
    return pts[:-1]


def resample_closed(pts, step):
    """Uniform arc-length resampling of a closed polyline."""
    P = [Vector((p[0], p[1], 0)) for p in pts]
    seglen = [(P[(i + 1) % len(P)] - P[i]).length for i in range(len(P))]
    total = sum(seglen)
    n = int(total // step)
    step = total / n
    out, i, acc = [], 0, 0.0
    for k in range(n):
        target = k * step
        while acc + seglen[i] < target:
            acc += seglen[i]
            i += 1
        t = (target - acc) / seglen[i]
        out.append(P[i].lerp(P[(i + 1) % len(P)], t))
    return out, step


def smooth_closed(P, iters, k=0.5):
    for _ in range(iters):
        P = [P[i] * (1 - k) + (P[i - 1] + P[(i + 1) % len(P)]) * (k / 2) for i in range(len(P))]
    return P


def frames(P, step):
    """Per sample: tangent, left normal (horizontal), signed curvature (+ = turning left), z."""
    n = len(P)
    total = n * step
    out = []
    for i in range(n):
        a, b, c = P[i - 1], P[i], P[(i + 1) % n]
        t = (c - a).normalized()
        h0 = math.atan2(b.y - a.y, b.x - a.x)
        h1 = math.atan2(c.y - b.y, c.x - b.x)
        dh = (h1 - h0 + math.pi) % (2 * math.pi) - math.pi
        curv = dh / step
        d = i * step
        z = 4.5 * math.sin(2 * math.pi * d / total + 0.6) + 1.5 * math.sin(6 * math.pi * d / total + 1.0)
        out.append({"p": Vector((b.x, b.y, z)), "t": t, "n": Vector((-t.y, t.x, 0)), "k": curv, "d": d})
    # light smoothing of curvature (it drives banking + kerbs; raw values are noisy)
    ks = [f["k"] for f in out]
    for _ in range(6):
        ks = [(ks[i - 1] + 2 * ks[i] + ks[(i + 1) % n]) / 4 for i in range(n)]
    for f, kv in zip(out, ks):
        f["k"] = kv
    return out


def road_z(f, l):
    """Road surface height offset at lateral l (see module docstring)."""
    crown = -0.025 * abs(l)
    bank = max(-0.05, min(0.05, f["k"] * 4.0)) * l      # inside of the corner is lower
    b = min(1.0, abs(f["k"]) * 60.0)
    return crown * (1 - b) + bank * b


# ======================================================================== materials
def img(name):
    path = os.path.join(TEX, name + ".png")
    im = bpy.data.images.get(name + ".png") or bpy.data.images.load(path)
    return im


def tex_mat(name, albedo=None, normal=None, rough=None, rough_val=0.8, emission=None, emis_strength=0.0,
            color=(0.5, 0.5, 0.5), alpha_from_albedo=False, metallic=0.0):
    m = bpy.data.materials.new(name)
    nt = m.node_tree
    b = nt.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Roughness"].default_value = rough_val
    b.inputs["Metallic"].default_value = metallic
    if albedo:
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = img(albedo)
        nt.links.new(t.outputs["Color"], b.inputs["Base Color"])
        if alpha_from_albedo:
            nt.links.new(t.outputs["Alpha"], b.inputs["Alpha"])
    if normal:
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = img(normal)
        t.image.colorspace_settings.name = "Non-Color"
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nt.links.new(t.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], b.inputs["Normal"])
    if rough:
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = img(rough)
        t.image.colorspace_settings.name = "Non-Color"
        nt.links.new(t.outputs["Color"], b.inputs["Roughness"])
    if emission:
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = img(emission)
        nt.links.new(t.outputs["Color"], b.inputs["Emission Color"])
        b.inputs["Emission Strength"].default_value = emis_strength
    return m


def flat_mat(name, color, rough=0.6, metallic=0.0, emission=None, strength=0.0):
    m = bpy.data.materials.new(name)
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metallic
    if emission:
        b.inputs["Emission Color"].default_value = (*emission, 1)
        b.inputs["Emission Strength"].default_value = strength
    return m


M = {}


def make_materials():
    # NOTE: "road_asphalt" is replaced in Godot by a wet-road shader (puddles, edge lines); the
    # Blender material still carries the textures so the glTF stays self-describing.
    M["road"] = tex_mat("road_asphalt", "asphalt_albedo", "asphalt_normal", "asphalt_rough")
    M["kerb"] = tex_mat("kerb", "kerb_albedo", "kerb_normal", rough_val=0.55)
    M["concrete"] = tex_mat("concrete", "concrete_albedo", "concrete_normal", "concrete_rough")
    M["barrier"] = tex_mat("barrier_concrete", "concrete_albedo", "concrete_normal", "concrete_rough")
    M["grass"] = tex_mat("grass", "grass_albedo", "grass_normal", rough_val=0.95)
    M["fence"] = tex_mat("fence", "fence_rgba", rough_val=0.5, metallic=0.8, alpha_from_albedo=True)
    M["facade0"] = tex_mat("facade_office", "facade0_albedo", None, "facade0_rough", emission="facade0_emission", emis_strength=3.0)
    M["facade1"] = tex_mat("facade_brick", "facade1_albedo", None, "facade1_rough", emission="facade1_emission", emis_strength=3.0)
    M["roof"] = flat_mat("roof", (0.03, 0.03, 0.035), rough=0.9)
    M["steel"] = flat_mat("steel_dark", (0.08, 0.08, 0.09), rough=0.45, metallic=0.9)
    M["lamp"] = flat_mat("lamp_head", (1, 1, 1), emission=(1.0, 0.86, 0.68), strength=20.0)
    M["gantry_red"] = flat_mat("gantry_light", (0.3, 0, 0), emission=(1, 0.05, 0.02), strength=15.0)
    M["board"] = flat_mat("sign_board", (0.02, 0.02, 0.025), rough=0.7)
    for nm, c in (("neon_pink", (1.0, 0.1, 0.55)), ("neon_cyan", (0.1, 0.85, 1.0)),
                  ("neon_amber", (1.0, 0.55, 0.08)), ("neon_green", (0.3, 1.0, 0.35))):
        M[nm] = flat_mat(nm, c, emission=c, strength=3.0)


# ======================================================================== mesh helpers
def new_obj(name, bm, material, smooth=40):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(material)
    for p in me.polygons:
        p.use_smooth = True
    me.set_sharp_from_angle(angle=math.radians(smooth))
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def strip(F, i0, i1, profile_fn, uv_fn, side):
    """Sweep a cross-section along samples i0..i1 (inclusive, wraps around the loop).
    profile_fn(f) -> list of (l, dz) for the LEFT side, ordered so the visible side is on the
    left of travel in the (l, z) plane. side = -1 mirrors it to the right.
    uv_fn(f, l, z, cumulative_profile_len) -> (u, v)."""
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new("UVMap")
    rows, uvs, want = [], [], []
    n = len(F)
    for ii in range(i0, i1 + 1):
        f = F[ii % n]
        prof = profile_fn(f)
        if side < 0:
            prof = [(-l, dz) for (l, dz) in reversed(prof)]
        row, ruv, acc, prev = [], [], 0.0, None
        for (l, dz) in prof:
            co = f["p"] + f["n"] * l + Vector((0, 0, dz))
            if prev is not None:
                acc += (co - prev).length
            prev = co
            row.append(bm.verts.new(co))
            ruv.append(uv_fn(f, l, dz, acc, ii))
        rows.append(row)
        uvs.append(ruv)
        # visible normal per profile segment: rot90 of the (l, z) direction, mapped to world
        segw = []
        for (l0, z0), (l1, z1) in zip(prof, prof[1:]):
            dl, dzz = l1 - l0, z1 - z0
            segw.append((f["n"] * (-dzz) + Vector((0, 0, dl))))
        want.append(segw)
    for r in range(len(rows) - 1):
        for j in range(len(rows[r]) - 1):
            q = (rows[r][j], rows[r + 1][j], rows[r + 1][j + 1], rows[r][j + 1])
            try:
                face = bm.faces.new(q)
            except ValueError:
                continue
            face.normal_update()            # bmesh leaves new faces with a zero normal
            if face.normal.dot(want[r][j]) < 0:
                face.normal_flip()
            for loop in face.loops:
                ri = 0 if loop.vert in rows[r] else 1
                jj = rows[r + ri].index(loop.vert)
                loop[uvl].uv = uvs[r + ri][jj]
    return bm


# ======================================================================== track surfaces
def is_corner(f):
    return abs(f["k"]) > 1.0 / 140.0


def build_track(F):
    n = len(F)
    chunks = [(c, min(c + CHUNK, n)) for c in range(0, n, CHUNK)]
    for ci, (a, b) in enumerate(chunks):
        tag = f"c{ci:02d}"
        # --- road: UV u = distance (m), v = 0..1 across (used by the Godot road shader)
        road_prof = lambda f: [(l, road_z(f, l)) for l in [-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6]]
        bm = strip(F, a, b, lambda f: road_prof(f), lambda f, l, z, acc, i: (F[i % n]["d"] if i < n else i * STEP, (l + 6) / 12), 1)
        new_obj(f"road_{tag}", bm, M["road"])
        bm = strip(F, a, b, lambda f: road_prof(f), lambda f, l, z, acc, i: (0, 0), 1)
        new_obj(f"col_asphalt_{tag}-colonly", bm, M["road"])

        for side in (1, -1):
            sname = "L" if side > 0 else "R"

            def edge_z(f, side=side):
                return road_z(f, ROAD_HALF * side)

            # kerb where the corner turns toward this side's... both sides get kerbs in corners
            def kerb_prof(f, side=side, corner=False):
                e = edge_z(f)
                if corner:
                    return [(6.0, e), (6.35, e + 0.025), (6.9, e + 0.045), (EDGE, e + 0.045)]
                slope = road_z(f, 7.0 * side) - e
                return [(6.0, e), (EDGE, e + slope * 1.2)]
            # run-off/kerb split by material: build two strips over sub-ranges
            ranges, cur, start = [], None, a
            for i in range(a, b + 1):
                c = is_corner(F[i % n])
                if cur is None:
                    cur = c
                if c != cur:
                    ranges.append((start, i, cur))
                    start, cur = i, c
            ranges.append((start, b, cur))
            for (r0, r1, corner) in ranges:
                if r1 <= r0:
                    continue
                uvk = (lambda f, l, z, acc, i: (i * STEP / 2.0, acc / 1.2)) if corner else \
                      (lambda f, l, z, acc, i: (i * STEP, (abs(l) + 6) / 12))
                kp = lambda f, c=corner: kerb_prof(f, corner=c)
                bm = strip(F, r0, r1, kp, uvk, side)
                new_obj(f"{'kerb' if corner else 'runoff'}_{sname}_{tag}_{r0}", bm, M["kerb"] if corner else M["road"])
                bm = strip(F, r0, r1, kp, lambda *x: (0, 0), side)
                new_obj(f"col_{'kerb' if corner else 'asphalt'}_{sname}_{tag}_{r0}-colonly", bm, M["kerb"])

            def wall_prof(f, side=side):
                e = edge_z(f) + 0.04
                return [(EDGE, e), (7.32, e + 0.08), (7.42, e + 0.33), (7.50, e + 0.81), (7.72, e + 0.81), (WALL_OUT, e)]
            bm = strip(F, a, b, wall_prof, lambda f, l, z, acc, i: (i * STEP / 3.0, acc / 3.0), side)
            new_obj(f"barrier_{sname}_{tag}", bm, M["barrier"], smooth=30)
            bm = strip(F, a, b, wall_prof, lambda *x: (0, 0), side)
            new_obj(f"col_wall_{sname}_{tag}-colonly", bm, M["barrier"])

            def fence_prof(f, side=side):
                e = edge_z(f) + 0.85
                return [(7.62, e), (7.62, e + 3.0)]
            # fence must be visible from the road side: order so rot90 points toward the road
            bm = strip(F, a, b, lambda f, s=side: list(reversed(fence_prof(f, s))),
                       lambda f, l, z, acc, i: (i * STEP, acc), side)
            new_obj(f"fence_{sname}_{tag}", bm, M["fence"])

            def pave_prof(f, side=side):
                e = edge_z(f) + 0.04
                return [(WALL_OUT, e), (WALL_OUT, e + 0.15), (PAVE_OUT, e + 0.19)]
            bm = strip(F, a, b, pave_prof, lambda f, l, z, acc, i: (i * STEP / 3.0, (abs(l) - WALL_OUT) / 3.0), side)
            new_obj(f"pavement_{sname}_{tag}", bm, M["concrete"])
            bm = strip(F, a, b, pave_prof, lambda *x: (0, 0), side)
            new_obj(f"col_pavement_{sname}_{tag}-colonly", bm, M["concrete"])

            def lot_prof(f, side=side):
                e = edge_z(f) + 0.04
                out = LOT_OUT
                if f["k"] * side > 1e-4:          # inside of a corner: never reach the centre of curvature
                    out = min(LOT_OUT, max(PAVE_OUT + 0.5, 0.8 / abs(f["k"])))
                return [(PAVE_OUT, e + 0.19), (out, e - 0.25)]
            bm = strip(F, a, b, lot_prof, lambda f, l, z, acc, i: (i * STEP / 4.0, acc / 4.0), side)
            new_obj(f"lot_{sname}_{tag}", bm, M["grass"])
    return chunks


# ======================================================================== buildings
class Grid:
    """Spatial hash of centreline samples for 'is this point too close to the track' tests."""
    def __init__(self, F, cell=20.0):
        self.cell, self.g = cell, {}
        for f in F:
            self.g.setdefault(self.key(f["p"]), []).append(f["p"])

    def key(self, p):
        return (int(math.floor(p.x / self.cell)), int(math.floor(p.y / self.cell)))

    def min_dist(self, p):
        kx, ky = self.key(p)
        best = 1e9
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for q in self.g.get((kx + dx, ky + dy), []):
                    best = min(best, math.hypot(p.x - q.x, p.y - q.y))
        return best


def box_building(bm_by_mat, centre, t, n, w, d, h, zbase, variant, uoff):
    """Axis: t = along the street, n = away from the street. Facades UV'd in 24 m tiles."""
    corners = [centre + t * (-w / 2) + n * 0, centre + t * (w / 2) + n * 0,
               centre + t * (w / 2) + n * d, centre + t * (-w / 2) + n * d]
    zb, zt = zbase - 6.0, zbase + h
    fac = bm_by_mat[f"facade{variant}"]
    uvl = fac.loops.layers.uv.verify()
    u_acc = uoff
    for i in range(4):
        p0, p1 = corners[i], corners[(i + 1) % 4]
        seg = (p1 - p0).length
        v = [fac.verts.new((p0.x, p0.y, zb)), fac.verts.new((p1.x, p1.y, zb)),
             fac.verts.new((p1.x, p1.y, zt)), fac.verts.new((p0.x, p0.y, zt))]
        f = fac.faces.new(v)
        f.normal_update()
        out = ((p0 + p1) / 2 - (centre + n * d / 2)).normalized()
        if f.normal.dot(Vector((out.x, out.y, 0))) < 0:
            f.normal_flip()
        uvs = {v[0]: (u_acc / 24, (zb - zbase) / 24), v[1]: ((u_acc + seg) / 24, (zb - zbase) / 24),
               v[2]: ((u_acc + seg) / 24, h / 24), v[3]: (u_acc / 24, h / 24)}
        for lp in f.loops:
            lp[uvl].uv = uvs[lp.vert]
        u_acc += seg
    roof = bm_by_mat["roof"]
    rv = [roof.verts.new((c.x, c.y, zt)) for c in corners]
    rf = roof.faces.new(rv)
    rf.normal_update()
    if rf.normal.z < 0:
        rf.normal_flip()
    # parapet / rooftop box for silhouette variety
    if h > 18 and random.random() < 0.6:
        c2 = centre + n * (d * 0.5)
        s = min(w, d) * 0.3
        bmesh.ops.create_cube(roof, size=1.0)
        for vv in roof.verts[-8:]:
            vv.co = Vector((c2.x + vv.co.x * s, c2.y + vv.co.y * s, zt + 1.5 + vv.co.z * 3.0))
    return corners


def build_buildings(F, grid):
    n = len(F)
    placed = []          # (centre, radius) for overlap tests
    per_chunk = {}
    signs = []
    i = 0
    while i < n:
        for side in (1, -1):
            f = F[i]
            w, d = random.uniform(16, 28), random.uniform(14, 28)
            h = random.choice([random.uniform(9, 18), random.uniform(18, 32), random.uniform(30, 52)])
            setback = 12.6 + random.uniform(0, 2.5)
            t, nn = f["t"], f["n"] * side
            base = f["p"] + nn * setback
            c = base + nn * (d / 2)
            rad = 0.5 * math.hypot(w, d)
            corners = [base + t * (-w / 2), base + t * (w / 2), base + t * (w / 2) + nn * d, base + t * (-w / 2) + nn * d, c]
            if any(grid.min_dist(p) < 11.8 for p in corners):
                continue
            if any((c - pc).length < (rad + pr) * 0.85 for pc, pr in placed):
                continue
            placed.append((c, rad))
            ci = i // CHUNK
            mats = per_chunk.setdefault(ci, {k: bmesh.new() for k in ("facade0", "facade1", "roof")})
            variant = 0 if random.random() < 0.5 else 1
            box_building(mats, base, t, nn, w, d, h, f["p"].z + road_z(f, 6 * side), variant, random.uniform(0, 96))
            if random.random() < 0.45 and len(signs) < 16:
                signs.append((base + nn * (-0.15), t, nn, f["p"].z + random.uniform(4.5, 8.5), w))
        i += random.randint(11, 15)
    for ci, mats in per_chunk.items():
        for k, bm in mats.items():
            if len(bm.faces):
                new_obj(f"bld_{k}_c{ci:02d}", bm, M[k], smooth=20)
            else:
                bm.free()
    print(f"[track] buildings={len(placed)} signs={len(signs)}")
    return signs


# ======================================================================== props: lamps, signs, gantry
def add_light(name, kind, loc, color, energy, rot=None, size=None):
    ld = bpy.data.lights.new(name, kind)
    ld.color = color
    ld.energy = energy
    if kind == "SPOT":
        ld.spot_size = size or math.radians(110)
        ld.spot_blend = 0.6
    ob = bpy.data.objects.new(name, ld)
    ob.location = loc
    if rot:
        ob.rotation_euler = rot
    bpy.context.scene.collection.objects.link(ob)
    return ob


def build_lamps(F):
    n = len(F)
    poles, heads = {}, {}
    count = 0
    for i in range(0, n, 18):          # every 36 m, alternating sides
        f = F[i]
        side = 1 if (i // 18) % 2 == 0 else -1
        nn = f["n"] * side
        e = f["p"].z + road_z(f, 6 * side) + 0.2
        foot = f["p"] + nn * 9.0
        top = Vector((foot.x, foot.y, e + 8.0))
        head = f["p"] + nn * 6.6
        head.z = e + 7.9
        ci = i // CHUNK
        bm = poles.setdefault(ci, bmesh.new())
        cyl = bmesh.ops.create_cone(bm, cap_ends=False, segments=8, radius1=0.12, radius2=0.08, depth=8.0)
        for v in cyl["verts"]:
            v.co = Vector((v.co.x + foot.x, v.co.y + foot.y, v.co.z + e + 4.0))
        arm = bmesh.ops.create_cube(bm, size=1.0)
        mid = (top + head) / 2
        L = (top - head).length
        for v in arm["verts"]:
            local = Vector((v.co.x * 0.1, v.co.y * L, v.co.z * 0.1))
            ang = math.atan2(nn.y, nn.x) - math.pi / 2
            rx = local.x * math.cos(ang) - local.y * math.sin(ang)
            ry = local.x * math.sin(ang) + local.y * math.cos(ang)
            v.co = Vector((mid.x + rx, mid.y + ry, top.z - 0.05 + local.z))
        hb = heads.setdefault(ci, bmesh.new())
        hd = bmesh.ops.create_cube(hb, size=1.0)
        for v in hd["verts"]:
            v.co = Vector((head.x + v.co.x * 0.7, head.y + v.co.y * 0.7, head.z - 0.1 + v.co.z * 0.12))
        add_light(f"lamp_light_{count:03d}", "SPOT", (head.x, head.y, head.z - 0.25), (1.0, 0.86, 0.68), 1500.0,
                  rot=(0.0, 0.0, 0.0), size=math.radians(125))
        count += 1
    for ci, bm in poles.items():
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        new_obj(f"lamp_poles_c{ci:02d}", bm, M["steel"], smooth=50)
    for ci, bm in heads.items():
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        new_obj(f"lamp_heads_c{ci:02d}", bm, M["lamp"], smooth=10)
    print(f"[track] lamps={count}")


SIGN_WORDS = ["HOTEL", "RAMEN", "24H", "DINER", "KINO", "BAR", "NOODLES", "OPEN", "MOTEL", "CAFE",
              "ARCADE", "JAZZ", "TAXI", "PHARMACY", "BOWLING", "KARAOKE"]


def build_signs(signs):
    neon = ["neon_pink", "neon_cyan", "neon_amber", "neon_green"]
    for k, (pos, t, nn, z, w) in enumerate(signs):
        word = SIGN_WORDS[k % len(SIGN_WORDS)]
        cd = bpy.data.curves.new(f"sign_txt_{k}", "FONT")
        cd.body = word
        cd.size = 1.6
        cd.extrude = 0.04
        cd.align_x = "CENTER"
        ob = bpy.data.objects.new(f"neon_{k:02d}", cd)
        bpy.context.scene.collection.objects.link(ob)
        ang = math.atan2(-nn.y, -nn.x)         # face the street (text normal = local +Z)
        ob.rotation_euler = (math.pi / 2, 0, ang + math.pi / 2)
        loc = pos + t * random.uniform(-w * 0.25, w * 0.25) - nn * 0.3
        ob.location = (loc.x, loc.y, z)
        mat_name = neon[k % len(neon)]
        ob.data.materials.append(M[mat_name])
        bpy.context.view_layer.objects.active = ob
        for o in bpy.context.selected_objects:
            o.select_set(False)
        ob.select_set(True)
        bpy.ops.object.convert(target="MESH")
        # dark backing board slightly behind the letters
        dims = ob.dimensions
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1.0)
        for v in bm.verts:
            v.co = Vector((v.co.x * (dims.x + 0.6), v.co.y * (dims.y + 0.5), v.co.z * 0.08 - 0.08))
        bo = new_obj(f"neon_board_{k:02d}", bm, M["board"], smooth=10)
        bo.parent = ob
        col = M[mat_name].node_tree.nodes["Principled BSDF"].inputs["Emission Color"].default_value
        lo = Vector(loc) - nn * 1.2
        add_light(f"neon_light_{k:02d}", "POINT", (lo.x, lo.y, z), (col[0], col[1], col[2]), 300.0)


def build_gantry(F):
    f = F[30]                         # 60 m after the start line
    bm = bmesh.new()
    for side in (1, -1):
        p = f["p"] + f["n"] * (8.4 * side)
        c = bmesh.ops.create_cube(bm, size=1.0)
        for v in c["verts"]:
            v.co = Vector((p.x + v.co.x * 0.5, p.y + v.co.y * 0.5, f["p"].z + 3.5 + v.co.z * 9.0))
    beam = bmesh.ops.create_cube(bm, size=1.0)
    ang = math.atan2(f["n"].y, f["n"].x)
    for v in beam["verts"]:
        lx, ly, lz = v.co.x * 17.8, v.co.y * 1.2, v.co.z * 1.4
        v.co = Vector((f["p"].x + lx * math.cos(ang) - ly * math.sin(ang),
                       f["p"].y + lx * math.sin(ang) + ly * math.cos(ang), f["p"].z + 7.4 + lz))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    new_obj("gantry", bm, M["steel"], smooth=10)
    lb = bmesh.new()
    for k in range(5):
        lx = (k - 2) * 1.1
        s = bmesh.ops.create_uvsphere(lb, u_segments=10, v_segments=6, radius=0.22)
        for v in s["verts"]:
            v.co = Vector((f["p"].x + (lx + v.co.x) * math.cos(ang) - (v.co.y - 0.65) * math.sin(ang),
                           f["p"].y + (lx + v.co.x) * math.sin(ang) + (v.co.y - 0.65) * math.cos(ang),
                           f["p"].z + 7.4 + v.co.z))
    new_obj("gantry_lights", lb, M["gantry_red"], smooth=80)


def build_ground(F):
    zmin = min(f["p"].z for f in F) - 2.0
    bm = bmesh.new()
    s = 900
    vs = [bm.verts.new((x, y, zmin)) for x, y in ((-s, -s), (s, -s), (s, s), (-s, s))]
    fc = bm.faces.new(vs)
    fc.normal_update()
    if fc.normal.z < 0:
        fc.normal_flip()
    uvl = bm.loops.layers.uv.new("UVMap")
    for lp in fc.loops:
        lp[uvl].uv = (lp.vert.co.x / 4, lp.vert.co.y / 4)
    new_obj("ground_far", bm, M["grass"])


# ======================================================================== data export
def export_json(F, step):
    data = {
        "schema": "track/1",
        "name": "Harbour Loop",
        "units": "SI (m, rad); Z-up right-handed",
        "closed": True,
        "sample_spacing_m": step,
        "length_m": len(F) * step,
        "road_half_width_m": ROAD_HALF,
        "start_finish_index": 0,
        "samples": [{"s": round(f["d"], 3), "x": round(f["p"].x, 3), "y": round(f["p"].y, 3), "z": round(f["p"].z, 3),
                     "heading": round(math.atan2(f["t"].y, f["t"].x), 5), "curvature": round(f["k"], 6),
                     "bank": round(max(-0.05, min(0.05, f["k"] * 4.0)) * min(1.0, abs(f["k"]) * 60.0), 5)}
                    for f in F],
    }
    os.makedirs(os.path.dirname(JSON_OUT), exist_ok=True)
    with open(JSON_OUT, "w") as fh:
        json.dump(data, fh, indent=1)


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    make_materials()
    pts = layout()
    P, step = resample_closed(pts, STEP)
    P = smooth_closed(P, 5)
    F = frames(P, step)
    print(f"[track] length={len(F) * step:.0f} m samples={len(F)}")
    build_track(F)
    signs = build_buildings(F, Grid(F))
    build_signs(signs)
    build_lamps(F)
    build_gantry(F)
    build_ground(F)
    export_json(F, step)
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in bpy.data.objects
               if o.type == "MESH" and "colonly" not in o.name)
    print(f"[track] visual triangles={tris} objects={len(bpy.data.objects)}")
    os.makedirs(os.path.dirname(BLEND_OUT), exist_ok=True)
    os.makedirs(os.path.dirname(GLB_OUT), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=BLEND_OUT)
    bpy.ops.export_scene.gltf(filepath=GLB_OUT, export_format="GLB", export_apply=True, export_yup=True,
                              export_lights=True)
    print("[track] exported", GLB_OUT)


if __name__ == "__main__":
    main()
