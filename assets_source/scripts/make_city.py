"""Procedural night city for illegal street racing ("Old Harbour District").

Run:  tools/blender/blender -b --factory-startup --python assets_source/scripts/gen_city_textures.py   (once)
      tools/blender/blender -b --factory-startup --python assets_source/scripts/make_city_props.py     (once)
      tools/blender/blender -b --factory-startup --python assets_source/scripts/make_city.py
      bash assets_source/scripts/build_city_assets.sh          (compress -> web/public/assets/city/)
Out:  assets_source/models/city.blend         (source of truth)
      assets_source/build/city_raw.glb        (visual tiles, "-colonly" collision, lamp lights; gitignored)
      data/city_props.json                    (city_props/1: instance transforms for the props library)
      data/tracks/city_route.json             (route/1: race loop for AI + lap timing)
      data/tracks/city.json                   (city/1: streets, lamps, parked-car spots, grid)
(game/assets/city/city.glb is the old uncompressed export, kept for the legacy Godot build.)

No racing infrastructure: ordinary streets. Street types (kerb to kerb):
  alley      4.6 m  one lane, one-way           sidewalk 1.5 m   buildings 3-5 floors
  street     7.0 m  one lane each way           sidewalk 2.5 m   buildings 4-7 floors
  boulevard 17.0 m  2 lanes each way + parking  sidewalk 4.5 m   buildings 6-11 floors
Blender axes: Z up, metres. Terrain: gentle hills, grades up to ~8 %.

Hi-fi pass (2026-10): the LAYOUT (streets, blocks, building footprints and heights, collision,
lamps, route) is unchanged and still drawn from random.seed(11) in the same order; everything new
(materials, decals, facade detail, props) uses its own generator DRNG, so the physics and the race
route match the previous build exactly. Facades are PBR "window bays" (gen_city_textures.py);
street furniture and wall clutter are INSTANCES of the props library (make_city_props.py), placed
here into data/city_props.json and drawn by web/src/scene/instancing.ts (InstancedMesh per asset per
LOD, cell culling). Every prop position is checked against the street network (assert_off_road):
nothing may stand in a carriageway (a lamp once spawned mid-street and wrecked the AI cars).
"""
import bmesh
import bpy
import json
import math
import os
import random
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
TEX = os.path.join(ROOT, "assets_source", "textures")
BLEND_OUT = os.path.join(ROOT, "assets_source", "models", "city.blend")
GLB_OUT = os.path.join(ROOT, "assets_source", "build", "city_raw.glb")
PROPS_OUT = os.path.join(ROOT, "data", "city_props.json")
DL = os.path.join(ROOT, "assets_source", "downloads")
GEN = os.path.join(ROOT, "assets_source", "build", "textures")
ROUTE_OUT = os.path.join(ROOT, "data", "tracks", "city_route.json")
CITY_OUT = os.path.join(ROOT, "data", "tracks", "city.json")
random.seed(11)
DRNG = random.Random(2026)          # decoration only: never touches the layout's random sequence

TYPES = {
    "alley": {"width": 4.6, "walk": 1.5, "floors": (3, 5)},
    "street": {"width": 7.0, "walk": 2.5, "floors": (4, 7)},
    "boulevard": {"width": 17.0, "walk": 4.5, "floors": (6, 11)},
}
# Streets running north-south (along +Y) at x positions, and east-west (along +X) at y positions.
V_TYPES = ["street", "alley", "boulevard", "street", "street", "alley", "street"]
V_BLOCKS = [72, 58, 80, 64, 70, 56]            # block widths between consecutive V streets
H_TYPES = ["street", "boulevard", "street", "alley", "street"]
H_BLOCKS = [66, 74, 60, 70]
OUTER = 34.0                                    # depth of the building ring outside the grid
CURB = 0.15                                     # kerb height
TILE = 160.0                                    # merge geometry into ~160 m tiles (culling + draw calls)
ROUTE_NODES = [(0, 1), (4, 1), (4, 3), (5, 3), (5, 4), (1, 4), (1, 2), (0, 2)]   # grid (i, j) loop


def positions(types, blocks):
    """Centre-line coordinate of each street, given block sizes between kerbs."""
    pos = [0.0]
    for k, b in enumerate(blocks):
        pos.append(pos[-1] + 0.5 * TYPES[types[k]]["width"] + b + 0.5 * TYPES[types[k + 1]]["width"])
    return pos


VX = positions(V_TYPES, V_BLOCKS)
HY = positions(H_TYPES, H_BLOCKS)


def terrain(x, y):
    return 4.0 * math.sin(x / 130 + 0.3) + 2.5 * math.cos(y / 95) + 1.0 * math.sin((x + y) / 60)


def crown(across, half_width, along_from_end):
    """Road crossfall: 1.5 % falling from the centre to the gutters (drainage), max 8 cm, blended
    to zero within 5 m of a junction so pieces meet flat at intersections."""
    c = -min(0.015 * abs(across), 0.08)
    return c * min(1.0, along_from_end / 5.0)


# ============================================================================ materials
def img(name):
    """Image by name: a full path (downloads / generated maps) or a legacy assets_source/textures name."""
    path = name if os.path.isabs(name) else os.path.join(TEX, name + ".png")
    key = os.path.basename(path)
    return bpy.data.images.get(key) or bpy.data.images.load(path)


def ph(tid, kind):
    """Poly Haven texture map from the downloads (kind: diff / nor_gl / rough)."""
    d = os.path.join(DL, "polyhaven", tid)
    return os.path.join(d, sorted(f for f in os.listdir(d) if f"_{kind}" in f)[0])


def gen(name):
    return os.path.join(GEN, name + ".png")


def tex_mat(name, albedo=None, normal=None, rough=None, rough_val=0.8, emission=None, emis_strength=0.0,
            color=(0.5, 0.5, 0.5), metallic=0.0, alpha=False):
    m = bpy.data.materials.new(name)
    nt = m.node_tree
    b = nt.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Roughness"].default_value = rough_val
    b.inputs["Metallic"].default_value = metallic
    for tex, sock, nonc in ((albedo, "Base Color", False), (rough, "Roughness", True)):
        if tex:
            t = nt.nodes.new("ShaderNodeTexImage")
            t.image = img(tex)
            if nonc:
                t.image.colorspace_settings.name = "Non-Color"
            nt.links.new(t.outputs["Color"], b.inputs[sock])
            if alpha and sock == "Base Color":           # decals: albedo alpha = coverage (alpha-tested in city.ts)
                nt.links.new(t.outputs["Alpha"], b.inputs["Alpha"])
    if normal:
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = img(normal)
        t.image.colorspace_settings.name = "Non-Color"
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nt.links.new(t.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], b.inputs["Normal"])
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
    # Road: Poly Haven asphalt_02 (3 m tile, 2k) - its own roughness map; city.ts adds large-scale
    # puddles (roughness mask) and colour variation in the shader so the tiling doesn't show.
    M["road"] = tex_mat("road_asphalt", ph("asphalt_02", "diff"), ph("asphalt_02", "nor_gl"), ph("asphalt_02", "rough"))
    M["paint"] = tex_mat("road_paint", gen("paint_albedo"), None, gen("paint_rough"), alpha=True)
    M["decal"] = tex_mat("road_decal", gen("decal_albedo"), gen("decal_normal"), gen("decal_rough"), alpha=True)
    M["walk"] = tex_mat("sidewalk", ph("concrete_pavement", "diff"), ph("concrete_pavement", "nor_gl"), ph("concrete_pavement", "rough"))
    M["curb"] = tex_mat("curb_granite", ph("granite_tile", "diff"), ph("granite_tile", "nor_gl"), ph("granite_tile", "rough"))
    for v in ("brick", "plaster", "render"):
        M[f"facade_{v}"] = tex_mat(f"facade_{v}", gen(f"facade_{v}_albedo"), gen(f"facade_{v}_normal"), gen(f"facade_{v}_rough"),
                                   emission=gen(f"facade_{v}_emit"), emis_strength=1.0)
    M["shop"] = tex_mat("shopfront", gen("shop_albedo"), gen("shop_normal"), gen("shop_rough"), emission=gen("shop_emit"), emis_strength=1.0)
    M["roof"] = flat_mat("roof", (0.03, 0.03, 0.035), rough=0.9)
    M["steel"] = flat_mat("steel_dark", (0.08, 0.08, 0.09), rough=0.45, metallic=0.9)
    M["tl_red"] = flat_mat("traffic_red", (0.3, 0, 0), emission=(1, 0.05, 0.02), strength=10.0)
    M["tl_green"] = flat_mat("traffic_green", (0, 0.3, 0.1), emission=(0.1, 1, 0.4), strength=10.0)
    for nm, c in (("neon_pink", (1.0, 0.1, 0.55)), ("neon_cyan", (0.1, 0.85, 1.0)),
                  ("neon_amber", (1.0, 0.55, 0.08)), ("neon_green", (0.3, 1.0, 0.35))):
        M[nm] = flat_mat(nm, c, emission=c, strength=3.0)


# ============================================================================ tiled mesh buckets
class Buckets:
    """Collects geometry per (tile, material) so the city exports as a few dozen merged objects."""
    def __init__(self):
        self.b = {}

    def get(self, key, x, y):
        tile = (int(math.floor(x / TILE)), int(math.floor(y / TILE)))
        k = (key, tile)
        if k not in self.b:
            bm = bmesh.new()
            bm.loops.layers.uv.new("UVMap")
            self.b[k] = bm
        return self.b[k]

    def flush(self, mat_for_key):
        for (key, tile), bm in self.b.items():
            if not bm.faces:
                bm.free()
                continue
            name = f"{key}_t{tile[0]}_{tile[1]}"
            me = bpy.data.meshes.new(name)
            bm.normal_update()
            bm.to_mesh(me)
            bm.free()
            mat = mat_for_key(key)
            if mat:
                me.materials.append(mat)
            for p in me.polygons:
                p.use_smooth = True
            me.set_sharp_from_angle(angle=math.radians(35))
            ob = bpy.data.objects.new(name, me)
            bpy.context.scene.collection.objects.link(ob)


VIS = Buckets()     # visual meshes
COL = Buckets()     # collision meshes ("-colonly")


def quad(bm, pts, uvs=None, up=None):
    """Add a quad (4 Vectors). Orientation is fixed so the normal faces `up` (default +Z)."""
    vs = [bm.verts.new(p) for p in pts]
    f = bm.faces.new(vs)
    f.normal_update()
    want = up if up is not None else Vector((0, 0, 1))
    if f.normal.dot(want) < 0:
        f.normal_flip()
    if uvs:
        uvl = bm.loops.layers.uv.verify()
        for lp in f.loops:
            lp[uvl].uv = uvs[vs.index(lp.vert)]
    return f


def grid(key, x0, x1, y0, y1, nx, ny, zfun, uv_scale, collide=None, up=None):
    """Subdivided rectangle following z = zfun(x, y). UV = world position / uv_scale."""
    for bucket, k in ((VIS, key), (COL, collide)):
        if k is None:
            continue
        bm = bucket.get(k, 0.5 * (x0 + x1), 0.5 * (y0 + y1))
        P = [[None] * (nx + 1) for _ in range(ny + 1)]
        for j in range(ny + 1):
            for i in range(nx + 1):
                x = x0 + (x1 - x0) * i / nx
                y = y0 + (y1 - y0) * j / ny
                P[j][i] = Vector((x, y, zfun(x, y)))
        for j in range(ny):
            for i in range(nx):
                pts = [P[j][i], P[j][i + 1], P[j + 1][i + 1], P[j + 1][i]]
                quad(bm, pts, [(p.x / uv_scale, p.y / uv_scale) for p in pts] if bucket is VIS else None, up)


# ============================================================================ streets
def street_w(kind):
    return TYPES[kind]["width"]


def build_roads():
    """Road surface = intersections + segments between them. Across-width subdivisions are the
    same for a segment and the intersections it meets, so edges line up without cracks."""
    across = {k: max(2, int(math.ceil(t["width"] / 2.5))) for k, t in TYPES.items()}
    # intersections (flat crown)
    for i, x in enumerate(VX):
        for j, y in enumerate(HY):
            wv, wh = street_w(V_TYPES[i]), street_w(H_TYPES[j])
            grid("road", x - wv / 2, x + wv / 2, y - wh / 2, y + wh / 2, across[V_TYPES[i]], across[H_TYPES[j]],
                 lambda X, Y: terrain(X, Y), 3.0, collide="col_asphalt")
    # N-S segments
    for i, x in enumerate(VX):
        w = street_w(V_TYPES[i])
        for j in range(len(HY) - 1):
            ya, yb = HY[j] + street_w(H_TYPES[j]) / 2, HY[j + 1] - street_w(H_TYPES[j + 1]) / 2
            n = max(2, int((yb - ya) / 3.0))
            z = lambda X, Y, x=x, w=w, ya=ya, yb=yb: terrain(X, Y) + crown(X - x, w / 2, min(Y - ya, yb - Y))
            grid("road", x - w / 2, x + w / 2, ya, yb, across[V_TYPES[i]], n, z, 3.0, collide="col_asphalt")
            build_markings(V_TYPES[i], (x, ya), (x, yb), z, j)
    # E-W segments
    for j, y in enumerate(HY):
        w = street_w(H_TYPES[j])
        for i in range(len(VX) - 1):
            xa, xb = VX[i] + street_w(V_TYPES[i]) / 2, VX[i + 1] - street_w(V_TYPES[i + 1]) / 2
            n = max(2, int((xb - xa) / 3.0))
            z = lambda X, Y, y=y, w=w, xa=xa, xb=xb: terrain(X, Y) + crown(Y - y, w / 2, min(X - xa, xb - X))
            grid("road", xa, xb, y - w / 2, y + w / 2, n, across[H_TYPES[j]], z, 3.0, collide="col_asphalt")
            build_markings(H_TYPES[j], (xa, y), (xb, y), z, i)


def line_strip(a, b, offset, width, zfun, dash=None, gap=None):
    """Painted line parallel to segment a->b at lateral `offset`, following the road surface."""
    a, b = Vector((a[0], a[1], 0)), Vector((b[0], b[1], 0))
    d = (b - a)
    L = d.length
    t = d / L
    n = Vector((-t.y, t.x, 0))
    phase = DRNG.uniform(0, 4)
    s = 1.0
    while s < L - 1.0:
        e = min(L - 1.0, s + (dash if dash else 4.0))
        p0 = a + t * s + n * offset
        p1 = a + t * e + n * offset
        pts = [p0 - n * width / 2, p1 - n * width / 2, p1 + n * width / 2, p0 + n * width / 2]
        pts = [Vector((p.x, p.y, zfun(p.x, p.y) + 0.012)) for p in pts]
        v0, v1 = (s + phase) / 4.0, (e + phase) / 4.0         # worn-paint mask: u across, v along (4 m)
        quad(VIS.get("paint", p0.x, p0.y), pts, [(0, v0), (0, v1), (1, v1), (1, v0)])
        s = e + (gap if dash else 0.0)


def build_markings(kind, a, b, zfun, idx):
    if kind == "street":                                  # one lane each way: dashed centre line
        line_strip(a, b, 0.0, 0.12, zfun, dash=3.0, gap=5.0)
    elif kind == "boulevard":                             # 2+2 lanes + parking lanes
        line_strip(a, b, 0.15, 0.12, zfun)
        line_strip(a, b, -0.15, 0.12, zfun)
        for side in (1, -1):
            line_strip(a, b, side * 3.35, 0.12, zfun, dash=3.0, gap=6.0)
            line_strip(a, b, side * 6.4, 0.12, zfun)
        # zebra crossings at both ends
        A, B = Vector((a[0], a[1], 0)), Vector((b[0], b[1], 0))
        t = (B - A).normalized()
        n = Vector((-t.y, t.x, 0))
        for end, sgn in ((A, 1), (B, -1)):
            c = end + t * sgn * 2.5
            for k in range(-7, 8):
                p = c + n * (k * 1.0)
                pts = [p - n * 0.25 - t * 1.5, p + n * 0.25 - t * 1.5, p + n * 0.25 + t * 1.5, p - n * 0.25 + t * 1.5]
                pts = [Vector((q.x, q.y, zfun(q.x, q.y) + 0.012)) for q in pts]
                v0 = DRNG.uniform(0, 1)
                quad(VIS.get("paint", p.x, p.y), pts, [(0, v0), (1, v0), (1, v0 + 0.75), (0, v0 + 0.75)])
    road_decals(kind, a, b, zfun)


def decal(cx, cy, size_a, size_b, ang, rect, zfun, n=1):
    """Flat decal (alpha-tested atlas region rect = (u0, v0, u1, v1)) lying on the road surface,
    split n x n so it follows the crown; 8 mm above the asphalt (paint is at 12 mm)."""
    ca, sa = math.cos(ang), math.sin(ang)
    bm = VIS.get("decal", cx, cy)
    for i in range(n):
        for j in range(n):
            pts, uvs = [], []
            for di, dj in ((0, 0), (1, 0), (1, 1), (0, 1)):
                fa, fb = (i + di) / n - 0.5, (j + dj) / n - 0.5
                x = cx + ca * fa * size_a - sa * fb * size_b
                y = cy + sa * fa * size_a + ca * fb * size_b
                pts.append(Vector((x, y, zfun(x, y) + 0.008)))
                uvs.append((rect[0] + (rect[2] - rect[0]) * (fa + 0.5), rect[1] + (rect[3] - rect[1]) * (fb + 0.5)))
            quad(bm, pts, uvs)


def road_decals(kind, a, b, zfun):
    """Manhole covers in the lanes (ambientCG ManholeCover009) and patched asphalt
    (AsphaltDamage001): flush decals, no collision, so they may lie in the carriageway."""
    A, B = Vector((a[0], a[1], 0)), Vector((b[0], b[1], 0))
    L = (B - A).length
    t = (B - A) / L
    n = Vector((-t.y, t.x, 0))
    lanes = {"alley": [0.0], "street": [-1.75, 1.75], "boulevard": [-5.0, -1.7, 1.7, 5.0]}[kind]
    s = DRNG.uniform(8, 25)
    while s < L - 8:
        p = A + t * s + n * DRNG.choice(lanes)
        decal(p.x, p.y, 0.8, 0.8, DRNG.uniform(0, math.tau), (0.0, 0.0, 0.5, 1.0), zfun)
        s += DRNG.uniform(30, 60)
    s = DRNG.uniform(5, 30)
    while s < L - 6:
        half = TYPES[kind]["width"] / 2 - 1.2
        p = A + t * s + n * DRNG.uniform(-half, half)
        w = DRNG.uniform(1.5, 3.5)
        decal(p.x, p.y, w, w * DRNG.uniform(0.6, 1.0), math.atan2(t.y, t.x) + DRNG.uniform(-0.3, 0.3), (0.5, 0.0, 1.0, 1.0), zfun, n=3)
        s += DRNG.uniform(25, 70)


# ============================================================================ blocks, buildings
def side_types(i, j):
    """Street kinds around block (i, j): west, east, south, north."""
    return V_TYPES[i], V_TYPES[i + 1], H_TYPES[j], H_TYPES[j + 1]


def walk_z(x, y):
    return terrain(x, y) + CURB


def build_block(x0, x1, y0, y1, kinds, outer=False):
    """Raised sidewalk + kerb face + buildings. kinds = (west, east, south, north) street kinds
    or None where the block has no street (outer ring)."""
    nx, ny = max(2, int((x1 - x0) / 5)), max(2, int((y1 - y0) / 5))
    grid("walk", x0, x1, y0, y1, nx, ny, walk_z, 1.8, collide="col_pavement")
    # kerb faces (vertical) along sides that face a street
    sides = [((x0, y0), (x0, y1), Vector((-1, 0, 0)), kinds[0]), ((x1, y1), (x1, y0), Vector((1, 0, 0)), kinds[1]),
             ((x1, y0), (x0, y0), Vector((0, -1, 0)), kinds[2]), ((x0, y1), (x1, y1), Vector((0, 1, 0)), kinds[3])]
    for a, b, out, kind in sides:
        if kind is None:
            continue
        A, B = Vector((a[0], a[1], 0)), Vector((b[0], b[1], 0))
        L = (B - A).length
        n = max(1, int(L / 3))
        for k in range(n):
            p = A + (B - A) * (k / n)
            q = A + (B - A) * ((k + 1) / n)
            pts = [Vector((p.x, p.y, terrain(p.x, p.y) - 0.12)), Vector((q.x, q.y, terrain(q.x, q.y) - 0.12)),
                   Vector((q.x, q.y, walk_z(q.x, q.y))), Vector((p.x, p.y, walk_z(p.x, p.y)))]
            curb_stone(p, q, out, k * (L / n), (k + 1) * (L / n))
            quad(COL.get("col_pavement", p.x, p.y), pts, None, out)       # collision: unchanged flat kerb face
        BLOCK_SIDES.append((A, B, out, kind))
    # buildings: set back by the sidewalk width of each side's street
    sb = [TYPES[k]["walk"] if k else 0.0 for k in kinds]
    bx0, bx1, by0, by1 = x0 + sb[0], x1 - sb[1], y0 + sb[2], y1 - sb[3]
    floors_by_side = [TYPES[k]["floors"] if k else (5, 9) for k in kinds]
    depth = min(18.0, 0.45 * (by1 - by0), 0.45 * (bx1 - bx0))
    # south and north rows span the full width; west and east rows fill between them
    rows = [((bx0, by0), (bx1, by0), Vector((0, 1, 0)), 2), ((bx1, by1), (bx0, by1), Vector((0, -1, 0)), 3),
            ((bx0, by1 - depth), (bx0, by0 + depth), Vector((1, 0, 0)), 0), ((bx1, by0 + depth), (bx1, by1 - depth), Vector((-1, 0, 0)), 1)]
    shops = []
    for a, b, inward, side in rows:
        A, B = Vector((a[0], a[1], 0)), Vector((b[0], b[1], 0))
        L = (B - A).length
        t = (B - A) / max(L, 1e-6)
        s = 0.0
        while s < L - 4.0:
            w = min(L - s, random.uniform(12, 26))
            if L - s - w < 6:
                w = L - s
            fl = random.randint(*floors_by_side[side])
            p0 = A + t * s
            p1 = A + t * (s + w)
            shop = kinds[side] is not None and kinds[side] != "alley" and random.random() < 0.55
            building(p0, p1, inward, depth, fl * 3.2, shop, kinds[side])
            if shop:
                shops.append((p0, p1, inward))
            s += w
    return shops


BLOCK_SIDES = []      # (A, B, out, street kind): kerb lines, for placing sidewalk props
FACES = []            # facade faces (dicts), for placing wall clutter after the lamps exist
BAY_W, FLOOR = 3.0, 3.2


def curb_stone(p, q, out, s0, s1):
    """Granite kerb stone between p and q (on the kerb line, `out` = toward the road): vertical
    face, 2 cm chamfer, 16 cm top strip. Visual only (collision keeps the flat kerb face)."""
    inn = -out
    bm = VIS.get("curb", p.x, p.y)
    zp, zq = terrain(p.x, p.y), terrain(q.x, q.y)
    wp, wq = walk_z(p.x, p.y), walk_z(q.x, q.y)
    c = 0.025
    u0, u1 = s0 / 2.3, s1 / 2.3
    P = lambda pt, d, z: Vector((pt.x + inn.x * d, pt.y + inn.y * d, z))
    quad(bm, [P(p, 0, zp - 0.12), P(q, 0, zq - 0.12), P(q, 0, wq - c), P(p, 0, wp - c)], [(u0, 0), (u1, 0), (u1, 0.06), (u0, 0.06)], out)
    quad(bm, [P(p, 0, wp - c), P(q, 0, wq - c), P(q, c, wq + 0.003), P(p, c, wp + 0.003)], [(u0, 0.06), (u1, 0.06), (u1, 0.07), (u0, 0.07)], out + Vector((0, 0, 1)))
    quad(bm, [P(p, c, wp + 0.003), P(q, c, wq + 0.003), P(q, 0.18, wq + 0.003), P(p, 0.18, wp + 0.003)], [(u0, 0.07), (u1, 0.07), (u1, 0.14), (u0, 0.14)])


def building(p0, p1, inward, depth, height, shop, front_kind=None):
    """Building shell. The random calls (facade variant, texture offset) are the same as before so
    the city layout is unchanged; the facade itself is now PBR window bays:
      u = bays along the wall (whole bays per face, ~3 m), v = storeys above the ground line zg
      shop front: plinth + shopfront bays (4 m) below the first floor
      other faces: granite plinth up to 0.45 m; parapet above the top floor; cornice on street faces."""
    corners = [p0, p1, p1 + inward * depth, p0 + inward * depth]
    zmin = min(terrain(c.x, c.y) for c in corners) - 1.0
    zmax = max(terrain(c.x, c.y) for c in corners) + CURB + height
    variant = "facade_brick" if random.random() < 0.5 else ("facade_plaster" if DRNG.random() < 0.5 else "facade_render")
    cx, cy = (p0.x + p1.x) / 2, (p0.y + p1.y) / 2
    u_off = int(random.uniform(0, 96))
    fl = int(round(height / FLOOR))
    zg = terrain((p0.x + p1.x) / 2, (p0.y + p1.y) / 2) + CURB          # ground-floor line (front)
    ztop = zg + fl * FLOOR
    zwall = max(zmax, ztop) + 0.8                                       # parapet
    centre = sum(corners, Vector()) / 4
    for k in range(4):
        a, b = corners[k], corners[(k + 1) % 4]
        out = ((a + b) / 2 - centre).normalized()
        seg = (b - a).length
        nb = max(1, int(round(seg / BAY_W)))
        bw = seg / nb
        u0 = u_off + 7 * k
        front_shop = k == 0 and shop
        bm = VIS.get(variant, cx, cy)

        def face(bmk, z0, z1, v0, v1, uscale=1.0, uo=u0):
            quad(bmk, [Vector((a.x, a.y, z0)), Vector((b.x, b.y, z0)), Vector((b.x, b.y, z1)), Vector((a.x, a.y, z1))],
                 [(uo, v0), (uo + nb * uscale, v0), (uo + nb * uscale, v1), (uo, v1)], out)

        if front_shop:
            sh = VIS.get("shop", cx, cy)
            face(sh, zmin, zg + 0.15, 0.005, 0.035)                       # plinth part of the shop texture
            face(sh, zg + 0.15, zg + 4.0, 0.15 / 4.0, 1.0)
            zbase = zg + 4.0
        else:
            cb = VIS.get("curb", cx, cy)
            quad(cb, [Vector((a.x, a.y, zmin)), Vector((b.x, b.y, zmin)), Vector((b.x, b.y, zg + 0.45)), Vector((a.x, a.y, zg + 0.45))],
                 [(0, zmin / 2.3), (seg / 2.3, zmin / 2.3), (seg / 2.3, (zg + 0.45) / 2.3), (0, (zg + 0.45) / 2.3)], out)
            zbase = zg + 0.45
        face(bm, zbase, ztop, (zbase - zg) / FLOOR, fl)                    # window bays
        face(bm, ztop, zwall, 0.03, 0.22)                                  # parapet: plain wall band of the bay
        q = (a + b) / 2 + out * 2.0
        exposed = k == 0 and front_kind is not None or street_at(q.x, q.y, 1.0) is not None
        if exposed:
            cornice(bm, a, b, out, ztop - 0.05, ztop + 0.3, 0.22, u0, nb)
        FACES.append({"a": a.copy(), "b": b.copy(), "out": out.copy(), "zg": zg, "fl": fl, "nb": nb, "bw": bw, "shop": front_shop,
                      "exposed": exposed, "kind": front_kind if k == 0 else (street_at(q.x, q.y, 1.0) or [None])[0]})
        # collision: one wall quad per face (unchanged)
        quad(COL.get("col_wall", cx, cy), [Vector((a.x, a.y, zmin)), Vector((b.x, b.y, zmin)), Vector((b.x, b.y, zmax)), Vector((a.x, a.y, zmax))], None, out)
    quad(VIS.get("roof", cx, cy), [Vector((c.x, c.y, zmax)) for c in corners])


def cornice(bm, a, b, out, z0, z1, d, u0, nb):
    """Projecting cornice band under the parapet (underside, face, top, end caps)."""
    A, B = a + out * d, b + out * d
    V = lambda p, z: Vector((p.x, p.y, z))
    uv = lambda v0, v1: [(u0, v0), (u0 + nb, v0), (u0 + nb, v1), (u0, v1)]
    quad(bm, [V(a, z0), V(b, z0), V(B, z0), V(A, z0)], uv(0.05, 0.07), Vector((0, 0, -1)))
    quad(bm, [V(A, z0), V(B, z0), V(B, z1), V(A, z1)], uv(0.07, 0.17), out)
    quad(bm, [V(A, z1), V(B, z1), V(b, z1), V(a, z1)], uv(0.17, 0.2), Vector((0, 0, 1)))
    t = (b - a).normalized()
    for p, P, s in ((a, A, -1), (b, B, 1)):
        quad(bm, [V(p, z0), V(P, z0), V(P, z1), V(p, z1)], [(0, 0.07), (0.07, 0.07), (0.07, 0.17), (0, 0.17)], t * s)


def street_at(x, y, pad=0.0):
    """(kind, axis, centre, width) of a street whose carriageway + sidewalk (+ pad) contains (x, y),
    or None. Streets run between the first and last cross street (the ring blocks close them)."""
    for i, vx in enumerate(VX):
        k = V_TYPES[i]
        if abs(x - vx) <= street_w(k) / 2 + TYPES[k]["walk"] + pad and HY[0] - street_w(H_TYPES[0]) / 2 <= y <= HY[-1] + street_w(H_TYPES[-1]) / 2:
            return (k, "y", vx, street_w(k))
    for j, hy in enumerate(HY):
        k = H_TYPES[j]
        if abs(y - hy) <= street_w(k) / 2 + TYPES[k]["walk"] + pad and VX[0] - street_w(V_TYPES[0]) / 2 <= x <= VX[-1] + street_w(V_TYPES[-1]) / 2:
            return (k, "x", hy, street_w(k))
    return None


def in_carriageway(x, y, pad=0.0):
    """True if (x, y) is on (or within `pad` of) any road surface: kerb-to-kerb of any street."""
    for i, vx in enumerate(VX):
        if abs(x - vx) < street_w(V_TYPES[i]) / 2 + pad and HY[0] - street_w(H_TYPES[0]) / 2 - pad <= y <= HY[-1] + street_w(H_TYPES[-1]) / 2 + pad:
            return True
    for j, hy in enumerate(HY):
        if abs(y - hy) < street_w(H_TYPES[j]) / 2 + pad and VX[0] - street_w(V_TYPES[0]) / 2 - pad <= x <= VX[-1] + street_w(V_TYPES[-1]) / 2 + pad:
            return True
    return False


def build_city_blocks():
    shops = []
    for i in range(len(VX) - 1):
        for j in range(len(HY) - 1):
            x0, x1 = VX[i] + street_w(V_TYPES[i]) / 2, VX[i + 1] - street_w(V_TYPES[i + 1]) / 2
            y0, y1 = HY[j] + street_w(H_TYPES[j]) / 2, HY[j + 1] - street_w(H_TYPES[j + 1]) / 2
            shops += build_block(x0, x1, y0, y1, side_types(i, j))
    # outer ring: blocks outside the edge streets (only their street-facing side has a kerb)
    xa, xb = VX[0] - street_w(V_TYPES[0]) / 2, VX[-1] + street_w(V_TYPES[-1]) / 2
    ya, yb = HY[0] - street_w(H_TYPES[0]) / 2, HY[-1] + street_w(H_TYPES[-1]) / 2
    shops += build_block(xa - OUTER, xa, ya - OUTER, yb + OUTER, (None, V_TYPES[0], None, None))
    shops += build_block(xb, xb + OUTER, ya - OUTER, yb + OUTER, (V_TYPES[-1], None, None, None))
    shops += build_block(xa, xb, ya - OUTER, ya, (None, None, None, H_TYPES[0]))
    shops += build_block(xa, xb, yb, yb + OUTER, (None, None, H_TYPES[-1], None))
    # the ends of the edge streets are closed by the ring blocks; add the street ends' road pieces
    return shops


# ============================================================================ street furniture
LAMPS = []


def add_light(name, kind, loc, color, energy, size=None):
    ld = bpy.data.lights.new(name, kind)
    ld.color = color
    ld.energy = energy
    if kind == "SPOT":
        ld.spot_size = size or math.radians(115)
        ld.spot_blend = 0.6
    ob = bpy.data.objects.new(name, ld)
    ob.location = loc
    bpy.context.scene.collection.objects.link(ob)


def lamp(x, y, toward):
    """Pole on the sidewalk at (x, y); the head overhangs 1.4 m toward the road."""
    z0 = walk_z(x, y)
    h = 7.0
    head = Vector((x, y, 0)) + toward * 1.4
    # the lamp itself is an instance of the props library (pole, curved arm, LED head toward +X)
    add_prop("street_lamp", x, y, z0, math.atan2(toward.y, toward.x))
    POLES.append((x, y))
    col = COL.get("col_wall", x, y)                         # you can hit lamp posts
    cc = bmesh.ops.create_cube(col, size=1.0)
    for v in cc["verts"]:
        v.co = Vector((x + v.co.x * 0.25, y + v.co.y * 0.25, z0 + h / 2 + v.co.z * h))
    name = f"lamp_light_{len(LAMPS):03d}"
    add_light(name, "SPOT", (head.x, head.y, z0 + h - 0.3), (1.0, 0.86, 0.68), 1500.0)
    LAMPS.append([round(head.x, 2), round(head.y, 2), round(z0 + h - 0.3, 2)])


def clear_of_v(x, margin=3.0):
    return all(abs(x - vx) > street_w(V_TYPES[i]) / 2 + margin for i, vx in enumerate(VX))


def clear_of_h(y, margin=3.0):
    return all(abs(y - hy) > street_w(H_TYPES[j]) / 2 + margin for j, hy in enumerate(HY))


def build_lamps():
    # Every lamp (including the boulevards' offset second row) must stand clear of cross streets.
    for i, x in enumerate(VX):
        w = street_w(V_TYPES[i])
        walk = TYPES[V_TYPES[i]]["walk"]
        spacing = 24.0 if V_TYPES[i] == "alley" else 28.0
        y = HY[0] + 12.0
        side = 1
        while y < HY[-1] - 8:
            if clear_of_h(y):
                lamp(x + side * (w / 2 + min(0.6, walk / 2)), y, Vector((-side, 0, 0)))
            if V_TYPES[i] == "boulevard" and clear_of_h(y + spacing / 2) and y + spacing / 2 < HY[-1] - 8:
                lamp(x - side * (w / 2 + 0.6), y + spacing / 2, Vector((side, 0, 0)))
            y += spacing
            side = -side
    for j, y in enumerate(HY):
        w = street_w(H_TYPES[j])
        walk = TYPES[H_TYPES[j]]["walk"]
        spacing = 24.0 if H_TYPES[j] == "alley" else 28.0
        x = VX[0] + 14.0
        side = 1
        while x < VX[-1] - 8:
            if clear_of_v(x):
                lamp(x, y + side * (w / 2 + min(0.6, walk / 2)), Vector((0, -side, 0)))
            if H_TYPES[j] == "boulevard" and clear_of_v(x + spacing / 2) and x + spacing / 2 < VX[-1] - 8:
                lamp(x + spacing / 2, y - side * (w / 2 + 0.6), Vector((0, side, 0)))
            x += spacing
            side = -side


def build_traffic_lights():
    """Poles with red/green heads at every corner of boulevard intersections."""
    for i, x in enumerate(VX):
        for j, y in enumerate(HY):
            if "boulevard" not in (V_TYPES[i], H_TYPES[j]):
                continue
            wv, wh = street_w(V_TYPES[i]) / 2 + 0.7, street_w(H_TYPES[j]) / 2 + 0.7
            for k, (sx, sy) in enumerate(((1, 1), (-1, 1), (-1, -1), (1, -1))):
                px, py = x + sx * wv, y + sy * wh
                z0 = walk_z(px, py)
                POLES.append((px, py))
                bm = VIS.get("steel", px, py)
                r = bmesh.ops.create_cone(bm, cap_ends=False, segments=8, radius1=0.08, radius2=0.08, depth=3.4)
                for v in r["verts"]:
                    v.co = Vector((v.co.x + px, v.co.y + py, v.co.z + z0 + 1.7))
                b = bmesh.ops.create_cube(bm, size=1.0)
                for v in b["verts"]:
                    v.co = Vector((px + v.co.x * 0.3, py + v.co.y * 0.3, z0 + 3.4 + v.co.z * 0.9))
                lb = VIS.get("tl_red" if k % 2 == 0 else "tl_green", px, py)
                s = bmesh.ops.create_uvsphere(lb, u_segments=8, v_segments=5, radius=0.12)
                zz = z0 + 3.6 if k % 2 == 0 else z0 + 3.15
                for v in s["verts"]:
                    v.co = Vector((px + v.co.x - sx * 0.16, py + v.co.y - sy * 0.16, zz + v.co.z))
                col = COL.get("col_wall", px, py)
                cc = bmesh.ops.create_cube(col, size=1.0)
                for v in cc["verts"]:
                    v.co = Vector((px + v.co.x * 0.2, py + v.co.y * 0.2, z0 + 1.7 + v.co.z * 3.4))


SIGN_WORDS = ["RAMEN", "HOTEL", "24H", "DINER", "KINO", "BAR", "NOODLES", "OPEN", "CAFE", "ARCADE", "JAZZ",
              "TAXI", "PHARMACY", "KARAOKE", "PIZZA", "LAUNDRY", "BOOKS", "TATTOO", "SUSHI", "LIQUOR"]


def build_neon(shops):
    random.shuffle(shops)
    neon = ["neon_pink", "neon_cyan", "neon_amber", "neon_green"]
    for k, (p0, p1, inward) in enumerate(shops[:28]):
        word = SIGN_WORDS[k % len(SIGN_WORDS)]
        mid = (p0 + p1) / 2
        out = -inward
        z = terrain(mid.x, mid.y) + CURB + 4.6
        cd = bpy.data.curves.new(f"sign_txt_{k}", "FONT")
        cd.body = word
        cd.size = 0.9
        cd.extrude = 0.03
        cd.align_x = "CENTER"
        ob = bpy.data.objects.new(f"neon_{k:02d}", cd)
        bpy.context.scene.collection.objects.link(ob)
        ob.rotation_euler = (math.pi / 2, 0, math.atan2(out.y, out.x) - math.pi / 2)
        ob.location = (mid.x + out.x * 0.15, mid.y + out.y * 0.15, z)
        mat = neon[k % len(neon)]
        ob.data.materials.append(M[mat])
        for o in bpy.context.selected_objects:
            o.select_set(False)
        bpy.context.view_layer.objects.active = ob
        ob.select_set(True)
        bpy.ops.object.convert(target="MESH")
        # merge the sign into its tile's neon bucket (one draw call per colour per tile, not 28 objects)
        me = ob.data
        me.transform(ob.matrix_world)
        VIS.get(mat, mid.x, mid.y).from_mesh(me)
        bpy.data.objects.remove(ob)
        bpy.data.meshes.remove(me)
        col = M[mat].node_tree.nodes["Principled BSDF"].inputs["Emission Color"].default_value
        add_light(f"neon_light_{k:02d}", "POINT", (mid.x + out.x * 1.2, mid.y + out.y * 1.2, z), (col[0], col[1], col[2]), 200.0)


PARKING = []


def parking_spots():
    """Parallel-parking spots along boulevards (cars spawned by the game, not baked)."""
    for j, y in enumerate(HY):
        if H_TYPES[j] != "boulevard":
            continue
        for i in range(len(VX) - 1):
            xa, xb = VX[i] + street_w(V_TYPES[i]) / 2 + 8, VX[i + 1] - street_w(V_TYPES[i + 1]) / 2 - 8
            x = xa
            while x < xb:
                for side in (1, -1):
                    if random.random() < 0.3:
                        px, py = x, y + side * 7.5
                        PARKING.append({"x": round(px, 2), "y": round(py, 2), "z": round(terrain(px, py), 2),
                                        "heading": 0.0 if side < 0 else math.pi})
                x += 6.2


# ============================================================================ props (instances)
PROPS = {}            # asset -> [[x, y, z, yaw, sx], ...] in Blender coordinates
POLES = []            # lamp + traffic-light poles (x, y): sidewalk props keep clear of them
FLOOR_PTS = []        # placed floor props (x, y, radius)
# Runtime metadata per asset (web/src/scene/instancing.ts): LOD switch distances (m), draw distance,
# bounding radius for culling, optional box collider (half extents + centre, Blender local axes).
ASSET_META = {
    "street_lamp": {"lod": [30, 80], "draw": 230, "radius": 4.0},
    "window_sill": {"lod": [28, 70], "draw": 70, "radius": 1.0},
    "hydrant": {"lod": [18, 45], "draw": 110, "radius": 0.5, "box": [[0.16, 0.16, 0.4], [0, 0, 0.4]]},
    "trash_can": {"lod": [18, 45], "draw": 110, "radius": 0.6, "box": [[0.3, 0.28, 0.46], [0, 0, 0.46]]},
    "trash_can_rust": {"lod": [18, 45], "draw": 110, "radius": 0.6, "box": [[0.3, 0.28, 0.46], [0, 0, 0.46]]},
    "utility_box_a": {"lod": [20, 50], "draw": 120, "radius": 0.8, "box": [[0.26, 0.215, 0.56], [0, -0.215, 0.56]]},
    "utility_box_b": {"lod": [20, 50], "draw": 120, "radius": 0.9, "box": [[0.46, 0.215, 0.56], [0, -0.215, 0.56]]},
    "aircon": {"lod": [20, 50], "draw": 120, "radius": 0.7},
    "shutter_bay": {"lod": [25, 60], "draw": 150, "radius": 2.2},
    "shutter_door": {"lod": [25, 60], "draw": 140, "radius": 1.6},
    "security_light": {"lod": [15, 40], "draw": 90, "radius": 0.5},
    "wall_lantern": {"lod": [15, 40], "draw": 100, "radius": 1.0},
    "fire_escape": {"lod": [30, 70], "draw": 170, "radius": 3.2},
    "fire_escape_bottom": {"lod": [30, 70], "draw": 170, "radius": 3.0},
    "downpipe": {"lod": [20, 50], "draw": 100, "radius": 1.8},
}


def add_prop(asset, x, y, z, yaw, sx=1.0):
    PROPS.setdefault(asset, []).append([x, y, z, yaw, sx])


def wall_yaw(out):
    """Yaw that turns a wall prop's front (-Y) to face `out`."""
    return math.atan2(out.x, -out.y)


def floor_clear(x, y, r):
    """Sidewalk prop at (x, y) with radius r: on a sidewalk, clear of every carriageway by 0.3 m
    (cross streets: 2.5 m, so corners and crossings stay free), of poles and of other props."""
    if in_carriageway(x, y, r + 0.3):
        return False
    if street_at(x, y) is None:
        return False
    if any(math.hypot(x - px, y - py) < r + 1.2 for px, py in POLES):
        return False
    if any(math.hypot(x - px, y - py) < r + pr + 0.8 for px, py, pr in FLOOR_PTS):
        return False
    return True


def decorate_sidewalks():
    """Hydrants and bins near the kerb, utility boxes against the walls (streets/boulevards); bins
    against the wall in alleys (1.5 m sidewalks)."""
    for A, B, out, kind in BLOCK_SIDES:
        L = (B - A).length
        t = (B - A) / L
        inn = -out
        walk = TYPES[kind]["walk"]
        corner = lambda s: min(s, L - s) > 6.0 + walk         # keep the corners and crossings free

        def place(asset, s, d, r, yaw):
            p = A + t * s + inn * d
            if not corner(s) or not floor_clear(p.x, p.y, r):
                return
            add_prop(asset, p.x, p.y, walk_z(p.x, p.y), yaw)
            FLOOR_PTS.append((p.x, p.y, r))

        if kind != "alley":
            s = DRNG.uniform(10, 40)
            while s < L:
                place("hydrant", s, 0.55, 0.25, DRNG.uniform(0, math.tau))
                s += DRNG.uniform(55, 95)
            s = DRNG.uniform(20, 60)
            while s < L:
                a = DRNG.choice(["utility_box_a", "utility_box_b"])
                place(a, s, walk - 0.02, 0.55, wall_yaw(out))
                s += DRNG.uniform(60, 120)
        s = DRNG.uniform(5, 30)
        while s < L:
            d = 0.5 if kind != "alley" else walk - 0.4
            place(DRNG.choice(["trash_can", "trash_can", "trash_can_rust"]), s, d, 0.4, DRNG.uniform(0, math.tau))
            s += DRNG.uniform(22, 50)


def decorate_facades():
    """Wall clutter on the faces that can be seen from a street: stone sills under every window,
    downpipes, aircon units, fire escapes (alleys and side streets), shutters on closed shops,
    garage shutters and security lights in alleys, wall lanterns on street faces."""
    for f in FACES:
        if not f["exposed"]:
            continue
        a, b, out, zg, fl, nb, bw = f["a"], f["b"], f["out"], f["zg"], f["fl"], f["nb"], f["bw"]
        t = (b - a).normalized()
        seg = (b - a).length
        yaw = wall_yaw(out)
        kind = f["kind"]
        at = lambda s: a + t * s
        # fire escape: alleys / side streets, wide enough faces, no lamp pole in front of it
        escape = None
        if kind in ("alley", "street") and not f["shop"] and fl >= 4 and seg >= 7.0 and DRNG.random() < (0.45 if kind == "alley" else 0.2):
            sc = seg / 2
            mid = at(sc)
            if all(math.hypot(mid.x - px, mid.y - py) > 4.5 for px, py in POLES):
                escape = sc
                add_prop("fire_escape_bottom", mid.x, mid.y, zg + FLOOR, yaw)
                for k in range(2, fl):
                    add_prop("fire_escape", mid.x, mid.y, zg + k * FLOOR, yaw)
        # windows: sills (and the odd aircon) on every bay of every storey with windows
        f0 = 1 if f["shop"] else 0
        for i in range(nb):
            s = (i + 0.5) * bw
            p = at(s)
            for k in range(f0, fl):
                add_prop("window_sill", p.x, p.y, zg + (k + 0.30) * FLOOR, yaw, bw / BAY_W)
                if k >= 1 and escape is None and DRNG.random() < 0.06:
                    q = at(s + DRNG.choice((-0.35, 0.35)) * bw)
                    add_prop("aircon", q.x, q.y, zg + (k + 0.30) * FLOOR - 1.05, yaw)
        # downpipe at one end of the face (one 3.2 m piece per storey)
        if seg > 4 and DRNG.random() < 0.7:
            p = at(0.25 if DRNG.random() < 0.5 else seg - 0.25)
            for k in range(fl):
                add_prop("downpipe", p.x, p.y, zg + k * FLOOR, yaw)
        # ground floor
        if f["shop"]:
            for i in range(nb):
                if DRNG.random() < 0.35:                          # closed shop: rolled-down shutter
                    p = at((i + 0.5) * bw)
                    add_prop("shutter_bay", p.x, p.y, zg + 0.35, yaw, bw * 0.93 / 3.0)
        elif kind == "alley":
            for i in range(nb):
                if DRNG.random() < 0.3:
                    p = at((i + 0.5) * bw)
                    add_prop("shutter_door", p.x, p.y, zg, yaw)
            if DRNG.random() < 0.5 and nb >= 2:
                p = at(DRNG.randint(1, nb - 1) * bw)
                add_prop("security_light", p.x, p.y, zg + 3.0, yaw)
        elif kind in ("street", "boulevard") and nb >= 2 and DRNG.random() < 0.3:
            p = at(DRNG.randint(1, nb - 1) * bw)
            add_prop("wall_lantern", p.x, p.y, zg + 2.0, yaw)


def assert_off_road():
    """Every instance (and its footprint radius, for floor props) must be off the carriageway."""
    bad = []
    for asset, rows in PROPS.items():
        r = 0.0 if asset in ("street_lamp",) else 0.1
        for x, y, z, yaw, sx in rows:
            if in_carriageway(x, y, r):
                bad.append((asset, round(x, 2), round(y, 2)))
    if bad:
        raise RuntimeError(f"[city] {len(bad)} props on the road, e.g. {bad[:5]}")


def export_props():
    """data/city_props.json in three.js coordinates (x, y up, z = -y_blender); yaw is the same angle
    (a rotation about Blender +Z is a rotation about three +Y). Flat rows of 5: x, y, z, yaw, sx."""
    assets = {}
    for asset, rows in sorted(PROPS.items()):
        meta = dict(ASSET_META[asset])
        if "box" in meta:
            (hx, hy, hz), (ox, oy, oz) = meta.pop("box")
            meta["collider"] = {"half": [hx, hz, hy], "centre": [ox, oz, -oy]}
        flat = []
        for x, y, z, yaw, sx in rows:
            flat += [round(x, 2), round(z, 2), round(-y, 2), round(yaw, 3), round(sx, 3)]
        meta["count"] = len(rows)
        meta["data"] = flat
        assets[asset] = meta
    with open(PROPS_OUT, "w") as f:
        json.dump({"schema": "city_props/1", "units": "three.js: Y up, m, rad; rows of [x, y, z, yaw, sx]",
                   "library": "/assets/city/city_props.glb", "cell": 120, "assets": assets}, f, separators=(",", ":"))
    print("[city] props:", ", ".join(f"{a}={len(r)}" for a, r in sorted(PROPS.items())))


# ============================================================================ route
def build_route():
    """Race loop through the grid nodes; corners are arcs that fit inside the intersection."""
    pts = [Vector((VX[i], HY[j], 0)) for i, j in ROUTE_NODES]
    kinds = []
    for k in range(len(ROUTE_NODES)):
        (i0, j0), (i1, j1) = ROUTE_NODES[k], ROUTE_NODES[(k + 1) % len(ROUTE_NODES)]
        kinds.append(V_TYPES[i0] if i0 == i1 else H_TYPES[j0])       # street kind of leg k
    n = len(pts)
    samples = []

    def add(p, heading, curv, half):
        samples.append({"p": p, "heading": heading, "curvature": curv, "half": half})

    for k in range(n):
        a, b, c = pts[k], pts[(k + 1) % n], pts[(k + 2) % n]
        half_ab = street_w(kinds[k]) / 2
        half_bc = street_w(kinds[(k + 1) % n]) / 2
        # Corner radius: a driver uses the whole junction (wide in, clip the inside kerb, wide out).
        # R = (w_in + w_out) / 2 + 1 m keeps the car's centreline > 1.2 m from the inner kerb corner
        # and needs ~21 deg of steering even street->alley (minimum turning radius is ~4.2 m).
        r_in = min(15.0, 0.5 * (street_w(kinds[(k - 1) % n]) + street_w(kinds[k])) + 1.0)     # corner at a
        r_out = min(15.0, 0.5 * (street_w(kinds[k]) + street_w(kinds[(k + 1) % n])) + 1.0)    # corner at b
        d = (b - a).normalized()
        L = (b - a).length
        hd = math.atan2(d.y, d.x)
        s = r_in
        while s < L - r_out:
            add(a + d * s, hd, 0.0, half_ab)
            s += 2.0
        # arc at b from direction d to direction e
        e = (c - b).normalized()
        turn = math.atan2(d.x * e.y - d.y * e.x, d.dot(e))         # + = left
        start = b - d * r_out
        left = Vector((-d.y, d.x, 0)) * (1 if turn > 0 else -1)
        centre = start + left * r_out
        steps = max(2, int(abs(turn) * r_out / 2.0))
        for m in range(steps):
            ang = turn * m / steps
            rel = start - centre
            rot = Vector((rel.x * math.cos(ang) - rel.y * math.sin(ang), rel.x * math.sin(ang) + rel.y * math.cos(ang), 0))
            add(centre + rot, hd + ang, (1 if turn > 0 else -1) / r_out, min(half_ab, half_bc))
    out = []
    for smp in samples:
        p = smp["p"]
        out.append({"x": round(p.x, 3), "y": round(p.y, 3), "z": round(terrain(p.x, p.y), 3),
                    "heading": round(smp["heading"], 5), "curvature": round(smp["curvature"], 6),
                    "width_left": smp["half"], "width_right": smp["half"]})
    total = sum((Vector((out[k]["x"], out[k]["y"], 0)) - Vector((out[k - 1]["x"], out[k - 1]["y"], 0))).length for k in range(len(out)))
    os.makedirs(os.path.dirname(ROUTE_OUT), exist_ok=True)
    with open(ROUTE_OUT, "w") as f:
        json.dump({"schema": "route/1", "name": "Old Harbour District loop", "closed": True,
                   "units": "SI (m, rad); Z-up right-handed", "length_m": round(total, 1), "samples": out}, f, indent=1)
    print(f"[city] route {total:.0f} m, {len(out)} samples")
    return out


def export_city_json():
    streets = []
    for i, x in enumerate(VX):
        streets.append({"kind": V_TYPES[i], "axis": "y", "x": x, "from": HY[0], "to": HY[-1], "width": street_w(V_TYPES[i])})
    for j, y in enumerate(HY):
        streets.append({"kind": H_TYPES[j], "axis": "x", "y": y, "from": VX[0], "to": VX[-1], "width": street_w(H_TYPES[j])})
    with open(CITY_OUT, "w") as f:
        json.dump({"schema": "city/1", "name": "Old Harbour District", "streets": streets, "lamps": LAMPS,
                   "parking": PARKING, "terrain": "4 sin(x/130+0.3) + 2.5 cos(y/95) + sin((x+y)/60)"}, f, indent=1)


def build_ground():
    s = 1200
    cx, cy = (VX[0] + VX[-1]) / 2, (HY[0] + HY[-1]) / 2
    bm = VIS.get("walk", cx, cy)
    quad(bm, [Vector((cx - s, cy - s, -8)), Vector((cx + s, cy - s, -8)), Vector((cx + s, cy + s, -8)), Vector((cx - s, cy + s, -8))],
         [(0, 0), (s / 3, 0), (s / 3, s / 3), (0, s / 3)])


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    make_materials()
    build_roads()
    shops = build_city_blocks()
    build_lamps()
    build_traffic_lights()
    build_neon(shops)
    parking_spots()
    decorate_sidewalks()
    decorate_facades()
    assert_off_road()
    build_ground()
    VIS.flush(lambda k: M[k])
    COL.flush(lambda k: M["walk"])
    for ob in list(bpy.data.objects):          # collision objects get the Godot "-colonly" suffix
        if ob.name.startswith("col_"):
            ob.name = ob.name + "-colonly"
    build_route()
    export_city_json()
    export_props()
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in bpy.data.objects
               if o.type == "MESH" and "colonly" not in o.name)
    print(f"[city] {len(VX)}x{len(HY)} streets, lamps={len(LAMPS)}, parking={len(PARKING)}, "
          f"visual triangles={tris}, objects={len(bpy.data.objects)}")
    os.makedirs(os.path.dirname(BLEND_OUT), exist_ok=True)
    os.makedirs(os.path.dirname(GLB_OUT), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=BLEND_OUT)
    bpy.ops.export_scene.gltf(filepath=GLB_OUT, export_format="GLB", export_apply=True, export_yup=True, export_lights=True)
    print("[city] exported", GLB_OUT)


if __name__ == "__main__":
    import sys
    if "--route-only" in sys.argv:          # regenerate the race route without touching the city mesh
        build_route()
    else:
        main()
