#!/usr/bin/env python3
"""Ground stage of the New York build: {ix}_{iy}.ground.glb + {ix}_{iy}.graph.json per tile (contract: docs/nyc_tiles.md, notes: docs/nyc_ground.md).

    python3 tools/nyc/ground.py --box -3 4 -4 6          # Midtown test box (ix0 ix1 iy0 iy1, inclusive)
    python3 tools/nyc/ground.py --all [--jobs 4]          # whole island
    python3 tools/nyc/ground.py --tile 0 0

Each tile is built from all data within tile + MARGIN, as a planar partition (road / sidewalk / plaza / park / water) computed with shapely set
operations, then clipped to the tile box, so neighbouring tiles meet exactly. Markings are owned by the tile containing their centre.
Heights: road 0, kerb/sidewalk/plaza/park +0.15, markings +0.025, water -0.5 (all z=0 ground; Manhattan is flat enough for racing).
"""
import argparse, json, math, os, sys, time
from collections import defaultdict

import numpy as np
import shapely
from shapely.geometry import LineString, Point, Polygon, box
from shapely.geometry.polygon import orient
from shapely.ops import substring, unary_union
from shapely.strtree import STRtree
import mapbox_earcut as earcut

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tilelib
from tilelib import Mesh, TILE, write_glb, tile_bounds, tile_name

MARGIN = 26.0
KERB_H = 0.15
KERB_TOP_W = 0.2
Z_MARK = 0.025
Z_WATER = -0.5
CORNER_R = 4.5
DRIVE = {"motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link", "tertiary", "tertiary_link",
         "residential", "unclassified", "living_street", "service", "road"}
GRAPH_HW = DRIVE - {"service"}
XW_HW = {"primary", "secondary", "tertiary", "residential", "unclassified", "living_street"}   # legs that get crosswalks
MARK_HW = {"motorway", "trunk", "primary", "secondary", "tertiary", "residential", "unclassified"}
PARK_KINDS = {"park", "grass", "pitch", "cemetery"}
PLAZA_KINDS = {"plaza", "pedestrian", "fountain"}
YELLOW = (1.0, 0.78, 0.12, 1.0)
WHITE = (0.93, 0.93, 0.9, 1.0)


# ---------------------------------------------------------------- road classes
def road_width(r):
    """Kerb-to-kerb roadway width (m). The extracted `width` is lane based and far too narrow for Manhattan, so rule by class (data width wins when larger)."""
    hw, w, ow = r["hw"], r.get("width") or 0, r.get("oneway")
    if hw in ("motorway", "trunk"):
        return max(w, 10.5)
    if hw.endswith("_link"):
        return max(w, 6.5)
    nm = r.get("name") or ""
    if any(k in nm for k in ("Avenue", "Broadway", "Boulevard", "Bowery", "Expressway")) and hw in ("primary", "secondary", "tertiary", "living_street", "residential", "unclassified"):
        return min(max(18.0 if ow else 21.0, w), 30.0)
    rule = {"primary": 19.0 if ow else 22.0, "secondary": 14.0, "tertiary": 13.0, "residential": 11.0 if ow else 12.0, "unclassified": 11.0,
            "living_street": 8.0, "service": 5.0, "road": 10.0}.get(hw, 8.0)
    return min(max(rule, w), 30.0)


def lane_count(hw, w, tag, oneway):
    if tag:
        return int(tag)
    park = 5.0 if hw in ("primary", "secondary", "tertiary", "residential", "unclassified") else 0.0
    n = max(1, int(round((w - park) / 3.4)))
    return n if oneway else max(2, n + n % 2)


# ---------------------------------------------------------------- geometry helpers
def polys(g):
    if g is None or g.is_empty:
        return []
    if g.geom_type == "Polygon":
        return [g]
    if hasattr(g, "geoms"):
        return [p for x in g.geoms for p in polys(x)]
    return []


def linesof(g):
    if g is None or g.is_empty:
        return []
    if g.geom_type == "LineString":
        return [g]
    if g.geom_type == "LinearRing":
        return [LineString(g.coords)]
    if hasattr(g, "geoms"):
        return [l for x in g.geoms for l in linesof(x)]
    return []


SNAP = 0.002   # grid snap of every derived polygon (m); the retry path of write_tile makes it coarser on bad OSM geometry


def clean(g, snap=None):
    snap = SNAP if snap is None else snap
    if g is None or g.is_empty:
        return Polygon()
    if not g.is_valid:
        g = g.buffer(0)
    return shapely.set_precision(g, snap) if not g.is_empty else g


def polyonly(g):
    """Drop points/lines from a GeometryCollection result so later overlay ops never see mixed dimensions."""
    ps = polys(g)
    return unary_union(ps) if ps else Polygon()


def strip_small_holes(g, min_area):
    out = []
    for p in polys(g):
        out.append(Polygon(p.exterior, [r for r in p.interiors if Polygon(r).area >= min_area]))
    return unary_union(out) if out else Polygon()


def tri_geom(g, z, alpha_fn=None, color=(1, 1, 1), min_area=0.02):
    """Triangulate polygons with earcut. Returns Mesh arrays (pos, idx, uv, color) with up-facing winding, UV = world metres."""
    P, I, base = [], [], 0
    for p in polys(g):
        if p.area < min_area:
            continue
        rings = [np.asarray(p.exterior.coords)[:-1]] + [np.asarray(r.coords)[:-1] for r in p.interiors if len(r.coords) > 3]
        V = np.concatenate(rings).astype(np.float64)
        ends = np.cumsum([len(r) for r in rings]).astype(np.uint32)
        t = earcut.triangulate_float64(V, ends).reshape(-1, 3).astype(np.int64)
        if len(t) == 0:
            continue
        a, b, c = V[t[:, 0]], V[t[:, 1]], V[t[:, 2]]
        cr = (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (b[:, 1] - a[:, 1]) * (c[:, 0] - a[:, 0])
        neg = cr < 0
        t[neg] = t[neg][:, [0, 2, 1]]
        t = t[np.abs(cr) > 1e-9]
        P.append(V); I.append(t + base); base += len(V)
    if not P:
        return None
    V = np.concatenate(P); idx = np.concatenate(I)
    pos = np.column_stack([V, np.full(len(V), z)])
    col = np.tile(np.array([*color, 1.0], dtype=np.float32), (len(V), 1))
    if alpha_fn is not None:
        col[:, 3] = alpha_fn(V)
    return pos, idx, V.astype(np.float32), col


class Acc:
    """Collects triangle soup per material."""

    def __init__(self):
        self.d = defaultdict(lambda: [[], [], [], [], 0])

    def add(self, mat, pos, idx, uv, col, nrm=None):
        e = self.d[mat]
        e[0].append(pos); e[1].append(idx + e[4]); e[2].append(uv); e[3].append(col if nrm is None else (col, nrm)); e[4] += len(pos)

    def flat(self, mat, tri):
        if tri is not None:
            pos, idx, uv, col = tri
            self.add(mat, pos, idx, uv, col)

    def meshes(self):
        out = []
        for mat, (P, I, U, C, _) in self.d.items():
            pos = np.concatenate(P); idx = np.concatenate(I); uv = np.concatenate(U)
            cols, nrms = [], []
            for c in C:
                if isinstance(c, tuple):
                    cols.append(c[0]); nrms.append(c[1])
                else:
                    cols.append(c); nrms.append(np.tile(np.array([0, 0, 1.0], dtype=np.float32), (len(c), 1)))
            out.append(Mesh(mat, pos, idx, normal=np.concatenate(nrms), uv=uv, color=np.concatenate(cols)))
        return out


def wall_strip(line, z0, z1, face_left, color=(1, 1, 1, 1)):
    """Vertical quads along a polyline; the face points to the left of the travel direction when face_left else to the right."""
    c = np.asarray(line.coords)[:, :2]
    if len(c) < 2:
        return None
    a, b = c[:-1], c[1:]
    d = b - a
    ln = np.linalg.norm(d, axis=1)
    k = ln > 1e-4
    a, b, d, ln = a[k], b[k], d[k], ln[k]
    n = len(a)
    if n == 0:
        return None
    s = np.concatenate([[0], np.cumsum(ln)[:-1]])
    pos = np.zeros((n * 4, 3)); uv = np.zeros((n * 4, 2))
    pos[0::4, :2] = a; pos[0::4, 2] = z0     # a bottom
    pos[1::4, :2] = b; pos[1::4, 2] = z0     # b bottom
    pos[2::4, :2] = b; pos[2::4, 2] = z1     # b top
    pos[3::4, :2] = a; pos[3::4, 2] = z1     # a top
    uv[0::4] = np.column_stack([s, np.full(n, z0)]); uv[1::4] = np.column_stack([s + ln, np.full(n, z0)])
    uv[2::4] = np.column_stack([s + ln, np.full(n, z1)]); uv[3::4] = np.column_stack([s, np.full(n, z1)])
    i = np.arange(n) * 4
    if face_left:
        idx = np.concatenate([np.column_stack([i, i + 2, i + 1]), np.column_stack([i, i + 3, i + 2])])
        nl = np.column_stack([-d[:, 1], d[:, 0]]) / ln[:, None]
    else:
        idx = np.concatenate([np.column_stack([i, i + 1, i + 2]), np.column_stack([i, i + 2, i + 3])])
        nl = np.column_stack([d[:, 1], -d[:, 0]]) / ln[:, None]
    nrm = np.repeat(np.column_stack([nl, np.zeros(n)]), 4, axis=0).astype(np.float32)
    col = np.tile(np.array(color, dtype=np.float32), (n * 4, 1))
    return pos, idx, uv.astype(np.float32), col, nrm


def densify(c, step):
    """Original vertices plus extra points so no segment is longer than step. c: (N,2). Returns (M,2)."""
    out = [c[0]]
    for i in range(len(c) - 1):
        L = np.linalg.norm(c[i + 1] - c[i])
        n = max(1, int(math.ceil(L / step)))
        for k in range(1, n + 1):
            out.append(c[i] + (c[i + 1] - c[i]) * (k / n))
    return np.array(out)


def offset_pts(c, off):
    t = np.zeros_like(c)
    t[1:-1] = c[2:] - c[:-2]; t[0] = c[1] - c[0]; t[-1] = c[-1] - c[-2]
    ln = np.linalg.norm(t, axis=1, keepdims=True); ln[ln == 0] = 1
    t /= ln
    return c + np.column_stack([-t[:, 1], t[:, 0]]) * off


def ribbon(c, width, z, color, owns, acc, mat="marking"):
    """Flat ribbon along densified polyline c, quads owned when their midpoint satisfies owns(x, y)."""
    if len(c) < 2:
        return
    t = np.zeros_like(c)
    t[1:-1] = c[2:] - c[:-2]; t[0] = c[1] - c[0]; t[-1] = c[-1] - c[-2]
    ln = np.linalg.norm(t, axis=1, keepdims=True); ln[ln == 0] = 1
    n = np.column_stack([-t[:, 1], t[:, 0]]) / ln
    L = c + n * (width / 2); R = c - n * (width / 2)
    mid = (c[:-1] + c[1:]) / 2
    own = np.array([owns(m[0], m[1]) for m in mid])
    if not own.any():
        return
    k = np.nonzero(own)[0]
    m = len(k)
    pos = np.zeros((m * 4, 3)); pos[:, 2] = z
    pos[0::4, :2] = R[k]; pos[1::4, :2] = R[k + 1]; pos[2::4, :2] = L[k + 1]; pos[3::4, :2] = L[k]
    i = np.arange(m) * 4
    idx = np.concatenate([np.column_stack([i, i + 1, i + 2]), np.column_stack([i, i + 2, i + 3])])
    acc.add(mat, pos, idx, pos[:, :2].astype(np.float32), np.tile(np.array(color, dtype=np.float32), (m * 4, 1)))


def dashes(c, off, width, dash, gap, z, color, owns, acc):
    """Dashed line at lateral offset along polyline c (phase fixed to the polyline start so tiles agree)."""
    if len(c) < 2:
        return
    o = offset_pts(c, off)
    ls = LineString(o)
    L = ls.length
    s = 0.0
    while s + dash <= L + 1e-6:
        seg = substring(ls, s, min(s + dash, L))
        cc = np.asarray(seg.coords)[:, :2]
        mid = cc.mean(axis=0)
        if owns(mid[0], mid[1]) and len(cc) >= 2:
            ribbon(cc, width, z, color, lambda x, y: True, acc)
        s += dash + gap


# ---------------------------------------------------------------- road network (global)
class Network:
    """Drivable graph for the whole island: edges between intersection / way-end nodes, plus per-leg crosswalk setbacks."""

    def __init__(self, world):
        roads = [r for r in world.items["roads"] if r["hw"] in DRIVE and not r["tunnel"]]
        deg = defaultdict(int)
        ways = []
        for r in roads:
            pts = []
            for p in r["pts"]:
                t = (p[0], p[1])
                if not pts or pts[-1] != t:
                    pts.append(t)
            if len(pts) < 2:
                continue
            ways.append((r, pts))
            for i, p in enumerate(pts):
                deg[p] += 1 if i in (0, len(pts) - 1) else 2
        self.edges = []
        self.legs = defaultdict(list)       # node key -> [(edge, end)]
        for r, pts in ways:
            cut = [0] + [i for i in range(1, len(pts) - 1) if deg[pts[i]] >= 3] + [len(pts) - 1]
            w = road_width(r)
            for a, b in zip(cut[:-1], cut[1:]):
                p = pts[a:b + 1]
                ls = LineString(p)
                if ls.length < 0.5:
                    continue
                e = {"pts": np.array(p), "ls": ls, "L": ls.length, "w": w, "hw": r["hw"], "oneway": bool(r["oneway"]), "name": r.get("name", ""),
                     "bridge": bool(r["bridge"]), "lanes": lane_count(r["hw"], w, r.get("lanes"), r["oneway"]), "ta": 0.0, "tb": 0.0, "stop": [None, None]}
                ei = len(self.edges)
                self.edges.append(e)
                self.legs[p[0]].append((ei, 0))
                self.legs[p[-1]].append((ei, 1))
        self.tree = STRtree([e["ls"] for e in self.edges])
        # crosswalk / stop line / marking setbacks per leg at intersections (>= 3 legs)
        self.crossings = []     # (centre x, centre y, dx, dy, width, stop line spec)
        for key, legs in self.legs.items():
            if len(legs) < 3:
                continue
            info = []
            for ei, end in legs:
                e = self.edges[ei]
                P = e["pts"] if end == 0 else e["pts"][::-1]
                d = None
                for q in P[1:]:
                    v = np.array(q) - np.array(P[0])
                    if np.linalg.norm(v) > 1.5:
                        d = v / np.linalg.norm(v); break
                if d is None:
                    d = (np.array(P[1]) - np.array(P[0])); d /= max(np.linalg.norm(d), 1e-6)
                info.append((ei, end, d, e["w"]))
            elig = [i for i in info if self.edges[i[0]]["hw"] in XW_HW]
            for ei, end, d, w in info:
                s = 0.0
                for ej, endj, dj, wj in info:
                    if ej == ei and endj == end:
                        continue
                    sin = abs(d[0] * dj[1] - d[1] * dj[0]); cos = d[0] * dj[0] + d[1] * dj[1]
                    if sin < 0.3:
                        continue
                    s = max(s, (wj / 2) / sin + (w / 2) * abs(cos) / sin)
                e = self.edges[ei]
                s_cw = s + 2.7
                s_stop = s_cw + 2.3
                trim = s_stop + 0.6
                e["ta" if end == 0 else "tb"] = trim
                has_cw = len(elig) >= 3 and e["hw"] in XW_HW and s_stop + 6 < e["L"] * 0.6
                if has_cw:
                    P0 = np.array(key)
                    c = P0 + d * s_cw
                    self.crossings.append((c[0], c[1], d[0], d[1], w, "cw"))
                    arrives = (not e["oneway"]) or end == 1
                    if arrives:
                        c2 = P0 + d * s_stop
                        self.crossings.append((c2[0], c2[1], d[0], d[1], w, "stop1" if e["oneway"] else "stop2"))
        self.cross_pts = np.array([(c[0], c[1]) for c in self.crossings]) if self.crossings else np.zeros((0, 2))

    @staticmethod
    def gid(p):
        return (int(round(p[0] * 10)) + 100000) * 1_000_000 + int(round(p[1] * 10)) + 200000

    def edges_in(self, T):
        idx = self.tree.query(T, predicate="intersects")
        return sorted(int(i) for i in idx)

    def graph(self, T):
        ids, nodes, gids, out = {}, [], [], []
        for ei in self.edges_in(T):
            e = self.edges[ei]
            if e["hw"] not in GRAPH_HW:
                continue
            ends = []
            for p in (tuple(e["pts"][0]), tuple(e["pts"][-1])):
                g = self.gid(p)
                if g not in ids:
                    ids[g] = len(nodes); nodes.append([round(p[0], 2), round(p[1], 2)]); gids.append(g)
                ends.append(ids[g])
            d = {"a": ends[0], "b": ends[1], "w": round(e["w"], 1), "lanes": e["lanes"], "oneway": e["oneway"], "hw": e["hw"], "name": e["name"], "len": round(e["L"], 1)}
            if e["bridge"]:
                d["bridge"] = True
            if len(e["pts"]) > 2:
                d["pts"] = [[round(float(x), 1), round(float(y), 1)] for x, y in e["pts"][1:-1]]
            out.append(d)
        return {"tile": None, "nodes": nodes, "gid": gids, "edges": out}


# ---------------------------------------------------------------- context
class Context:
    def __init__(self):
        from tilelib import World
        t = time.time()
        self.world = World(layers=("roads", "areas", "rails"))
        mask = json.load(open(os.path.join(tilelib.DERIVED, "manhattan_mask.json")))
        self.land = unary_union([Polygon(p[0], p[1:]) for p in mask]).buffer(0)
        self.land_far = self.land.buffer(120)
        self.net = Network(self.world)
        self.load_s = time.time() - t


def distance_alpha(tree, lo=0.6, span=1.0):
    def f(V):
        if tree is None or len(V) == 0:
            return np.ones(len(V))
        pts = shapely.points(V)
        _, d = tree.query_nearest(pts, return_distance=True, all_matches=False)
        t = np.clip(d / span, 0, 1)
        return lo + (1 - lo) * t * t * (3 - 2 * t)
    return f


# ---------------------------------------------------------------- the tile
def build_tile(ctx, ix, iy, debug=False):
    x0, y0, x1, y1 = tile_bounds(ix, iy)
    T = box(x0, y0, x1, y1)
    B = box(x0 - MARGIN, y0 - MARGIN, x1 + MARGIN, y1 + MARGIN)
    world = ctx.world
    acc = Acc()
    info = {}

    def owns(x, y):
        return x0 <= x < x1 and y0 <= y < y1

    # --- inputs
    roads = world.query("roads", B.bounds, margin=40)
    areas = world.query("areas", B.bounds, margin=2)
    drive_polys, ped_polys, path_lines, park_p, plaza_p, water_p, pier_p, park_lot = [], [], [], [], [], [], [], []
    for r, g in roads:
        hw = r["hw"]
        if r["tunnel"]:
            continue
        if hw in DRIVE:
            drive_polys.append(g.buffer(road_width(r) / 2, quad_segs=3))
        elif hw == "pedestrian":
            ped_polys.append(g.buffer(max(r.get("width") or 6, 6) / 2, quad_segs=2, cap_style="flat"))
        elif hw in ("footway", "path", "cycleway"):
            path_lines.append((g, max(r.get("width") or 2.0, 2.0)))
    for a, g in areas:
        k = a["kind"]
        g = g.buffer(0) if not g.is_valid else g
        if k in PARK_KINDS: park_p.append(g)
        elif k in PLAZA_KINDS: plaza_p.append(g)
        elif k == "water": water_p.append(g)
        elif k == "pier": pier_p.append(g)
        elif k == "parking": park_lot.append(g)

    if SNAP > 0.002:
        drive_polys = [clean(p) for p in drive_polys]; ped_polys = [clean(p) for p in ped_polys]
        park_p = [clean(p) for p in park_p]; plaza_p = [clean(p) for p in plaza_p]; water_p = [clean(p) for p in water_p]
        pier_p = [clean(p) for p in pier_p]; park_lot = [clean(p) for p in park_lot]

    # --- road surface: union, round the concave corners (closing), fill pin holes, add parking lots
    road = unary_union(drive_polys) if drive_polys else Polygon()
    if not road.is_empty:
        road = road.buffer(CORNER_R, quad_segs=5).buffer(-CORNER_R, quad_segs=5)
        road = strip_small_holes(road, 60.0)
    if park_lot:
        road = unary_union([road] + [p.simplify(0.1) for p in park_lot])
    road = clean(polyonly(road.intersection(B)).simplify(0.06, preserve_topology=True))
    road = unary_union([orient(p, 1.0) for p in polys(road)]) if not road.is_empty else road

    # --- land / water
    land = clean(polyonly(unary_union([ctx.land.intersection(B)] + [p.intersection(B) for p in pier_p])))
    wat = polyonly(unary_union(water_p).intersection(B)) if water_p else Polygon()
    if pier_p:
        wat = polyonly(wat.difference(unary_union(pier_p)))
    land = clean(land.difference(wat)) if not wat.is_empty else land
    water = clean(polyonly(B.difference(land)))

    plaza = polyonly(unary_union(plaza_p + ped_polys).intersection(B)) if (plaza_p or ped_polys) else Polygon()
    plaza = clean(plaza.simplify(0.08).intersection(land).difference(road))
    park = polyonly(unary_union(park_p).intersection(B)) if park_p else Polygon()
    park = clean(park.simplify(0.1).intersection(land).difference(plaza).difference(road))
    sidewalk0 = clean(land.difference(road).difference(plaza).difference(park))
    ext = road.buffer(KERB_TOP_W, join_style="mitre", mitre_limit=2.0) if not road.is_empty else Polygon()
    ext = clean(ext)
    raised0 = unary_union([sidewalk0, plaza, park])
    curb_top = clean(ext.difference(road).intersection(raised0))
    sidewalk = clean(sidewalk0.difference(ext))
    plaza_r = clean(plaza.difference(ext))
    park_r = clean(park.difference(ext))

    # --- baked edge darkening (gutter / kerb AO): bands near the road boundary get alpha from the distance to it
    segs = []
    for l in linesof(road.boundary):
        c = np.asarray(l.coords)
        segs += [LineString(c[i:i + 2]) for i in range(len(c) - 1)]
    ctree = STRtree(segs) if segs else None
    afn = distance_alpha(ctree, 0.62, 1.0)
    afn_road = distance_alpha(ctree, 0.78, 0.9)
    BW = 1.0

    def banded(g, fn, mat, z, color=(1, 1, 1)):
        if g.is_empty:
            return
        inner = clean(g.buffer(-BW, quad_segs=2, join_style="mitre", mitre_limit=2.0))
        band = clean(g.difference(inner)) if not inner.is_empty else g
        acc.flat(mat, tri_geom(band.intersection(T), z, fn, color))
        if not inner.is_empty:
            acc.flat(mat, tri_geom(inner.intersection(T), z, None, color))

    banded(road, afn_road, "road", 0.0)
    banded(sidewalk, afn, "sidewalk", KERB_H)
    acc.flat("plaza", tri_geom(plaza_r.intersection(T), KERB_H, afn))
    acc.flat("grass", tri_geom(park_r.intersection(T), KERB_H))
    acc.flat("curb", tri_geom(curb_top.intersection(T), KERB_H, None, (0.78, 0.78, 0.76)))
    acc.flat("water", tri_geom(water.intersection(T), Z_WATER))

    # --- kerb faces: road boundary where it touches a raised surface (road is on the left of the oriented boundary)
    if not road.is_empty:
        zone = raised0.buffer(0.1)
        for l in linesof(road.boundary.intersection(zone).intersection(T)):
            w = wall_strip(l, 0.0, KERB_H, True, (0.82, 0.82, 0.8, 1.0))
            if w:
                acc.add("curb", w[0], w[1], w[2], w[3], w[4])
    # --- sea wall / pond banks: raised boundary facing water
    if not water.is_empty and not raised0.is_empty:
        rz = clean(unary_union([orient(p, 1.0) for p in polys(raised0)]))
        for l in linesof(rz.boundary.intersection(water.buffer(0.15)).intersection(T)):
            for ll in (l,):
                w = wall_strip(ll, Z_WATER - 0.1, KERB_H, False, (0.55, 0.55, 0.55, 1.0))   # raised surface is on the left, wall faces right (water)
                if w:
                    acc.add("curb", w[0], w[1], w[2], w[3], w[4])

    # --- park paths (footways inside parks)
    if path_lines and not park_r.is_empty:
        pp = unary_union([g.buffer(w / 2, quad_segs=2, cap_style="flat") for g, w in path_lines if g.intersects(park_r)])
        pp = clean(pp.intersection(park_r).simplify(0.05)) if not pp.is_empty else pp
        acc.flat("plaza", tri_geom(pp.intersection(T), KERB_H + 0.012, None, (0.92, 0.9, 0.86)))

    # --- surface rail
    rails = [(r, g) for r, g in world.query("rails", B.bounds, margin=2) if r["kind"] in ("rail", "tram", "light_rail") and not r["tunnel"]]
    if rails:
        rp = unary_union([g.buffer(1.3, quad_segs=1, cap_style="flat") for _, g in rails]).intersection(T)
        acc.flat("rail", tri_geom(rp, 0.03))

    # --- markings from the global network: lane lines trimmed at intersections, crosswalks, stop lines
    net = ctx.net
    for ei in net.edges_in(B):
        e = net.edges[ei]
        hw = e["hw"]
        if hw not in MARK_HW or e["L"] < 12:
            continue
        s0, s1 = e["ta"], e["L"] - e["tb"]
        if s1 - s0 < 8:
            continue
        sub = substring(e["ls"], s0, s1)
        c = densify(np.asarray(sub.coords)[:, :2], 4.0)
        w, n, ow = e["w"], e["lanes"], e["oneway"]
        park_w = 5.0 if hw in ("primary", "secondary", "tertiary", "residential", "unclassified") else 0.0
        tw = max(w - park_w, 3.0)
        lw = tw / n
        if not ow and n >= 2:
            for o in (-0.14, 0.14):
                ribbon(offset_pts(c, o), 0.12, Z_MARK, YELLOW, owns, acc)
            half = n // 2
            for k in range(1, half):
                for sgn in (-1, 1):
                    dashes(c, sgn * k * lw, 0.14, 3.0, 9.0, Z_MARK, WHITE, owns, acc)
        elif ow and n >= 2:
            for k in range(1, n):
                dashes(c, (k - n / 2) * lw, 0.14, 3.0, 9.0, Z_MARK, WHITE, owns, acc)
    for cx, cy, dx, dy, w, kind in net.crossings:
        if not owns(cx, cy):
            continue
        d = np.array([dx, dy]); nn = np.array([-dy, dx]); c0 = np.array([cx, cy])
        if kind == "cw":
            hw_, dep = w / 2 - 0.25, 1.6
            P = np.array([c0 - nn * hw_ - d * dep, c0 + nn * hw_ - d * dep, c0 + nn * hw_ + d * dep, c0 - nn * hw_ + d * dep])
            pos = np.column_stack([P, np.full(4, Z_MARK)])
            uv = np.array([[0, 0], [2 * hw_, 0], [2 * hw_, 2 * dep], [0, 2 * dep]], dtype=np.float32)   # local metres: u across, v along the road
            acc.add("crosswalk", pos, np.array([[0, 2, 1], [0, 3, 2]]), uv, np.tile(np.array([1, 1, 1, 1], dtype=np.float32), (4, 1)))
        else:
            right = np.array([-dy, dx])      # right of the approaching traffic (heading -d)
            if kind == "stop1":
                a, b = -(w / 2 - 0.3), (w / 2 - 0.3)
            else:
                a, b = 0.25, w / 2 - 0.3
            sgn = 1.0
            pa, pb = c0 + right * a * sgn, c0 + right * b * sgn
            P = np.array([pa - d * 0.25, pb - d * 0.25, pb + d * 0.25, pa + d * 0.25])
            pos = np.column_stack([P, np.full(4, Z_MARK)])
            acc.add("marking", pos, np.array([[0, 2, 1], [0, 3, 2]]), P.astype(np.float32), np.tile(np.array(WHITE, dtype=np.float32), (4, 1)))

    meshes = acc.meshes()
    graph = net.graph(T)
    graph["tile"] = [ix, iy]
    if debug:
        info["polys"] = {"curb": curb_top.intersection(T), "road": road.intersection(T), "sidewalk": sidewalk.intersection(T), "plaza": plaza_r.intersection(T), "park": park_r.intersection(T),
                         "water": water.intersection(T), "land": land.intersection(T), "T": T}
    return meshes, graph, info


def write_tile(ctx, ix, iy, outdir):
    t = time.time()
    global SNAP
    meshes = None
    for snap in (0.002, 0.02, 0.1):    # GEOS topology errors on bad OSM data: retry with all inputs snapped to a coarser grid
        SNAP = snap
        try:
            meshes, graph, _ = build_tile(ctx, ix, iy)
            break
        except Exception as ex:
            print(f"tile {ix},{iy} failed at snap {snap}: {ex!r}", flush=True)
    SNAP = 0.002
    if meshes is None:
        return None
    name = tile_name(ix, iy)
    size = 0
    tris = sum(len(m.idx) for m in meshes)
    if tris:
        size = write_glb(os.path.join(outdir, f"{name}.ground.glb"), meshes, (ix, iy), name)
    with open(os.path.join(outdir, f"{name}.graph.json"), "w") as f:
        json.dump(graph, f, separators=(",", ":"))
    return {"tile": (ix, iy), "tris": int(tris), "bytes": size, "secs": time.time() - t, "edges": len(graph["edges"])}


def all_tiles(ctx):
    x0, y0, x1, y1 = ctx.land_far.bounds
    out = []
    land20 = ctx.land.buffer(20)
    shapely.prepare(land20)
    for ix in range(int(math.floor(x0 / TILE)), int(math.floor(x1 / TILE)) + 1):
        for iy in range(int(math.floor(y0 / TILE)), int(math.floor(y1 / TILE)) + 1):
            if land20.intersects(box(*tile_bounds(ix, iy))):
                out.append((ix, iy))
    return out


_CTX = None


def _work(t):
    return write_tile(_CTX, t[0], t[1], _OUT)


_OUT = tilelib.OUT_TILES


def main():
    global _CTX, _OUT
    ap = argparse.ArgumentParser()
    ap.add_argument("--box", nargs=4, type=int, metavar=("IX0", "IX1", "IY0", "IY1"))
    ap.add_argument("--tile", nargs=2, type=int)
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--jobs", type=int, default=1)
    ap.add_argument("--out", default=tilelib.OUT_TILES)
    ap.add_argument("--meshopt", action="store_true", help="compress each ground.glb with gltf-transform meshopt (npx, if available)")
    a = ap.parse_args()
    _OUT = a.out
    os.makedirs(_OUT, exist_ok=True)
    _CTX = Context()
    print(f"data loaded in {_CTX.load_s:.1f}s, {len(_CTX.net.edges)} graph edges, {len(_CTX.net.crossings)} crossing marks", flush=True)
    if a.tile: tiles = [tuple(a.tile)]
    elif a.box: tiles = [(i, j) for i in range(a.box[0], a.box[1] + 1) for j in range(a.box[2], a.box[3] + 1)]
    elif a.all: tiles = all_tiles(_CTX)
    else:
        ap.error("give --box, --tile or --all")
    t0 = time.time()
    res = []
    if a.jobs > 1:
        import multiprocessing as mp
        with mp.get_context("fork").Pool(a.jobs) as p:
            for r in p.imap_unordered(_work, tiles, chunksize=2):
                if r: res.append(r)
    else:
        for t in tiles:
            r = write_tile(_CTX, *t, _OUT)
            if r: res.append(r)
            if r and len(tiles) <= 12:
                print(f"  tile {r['tile']}: {r['tris']} tris {r['bytes'] / 1024:.0f} KB {r['secs']:.1f}s", flush=True)
    dt = time.time() - t0
    if res:
        tr = [r["tris"] for r in res]; by = [r["bytes"] for r in res]
        print(f"{len(res)}/{len(tiles)} tiles in {dt:.0f}s ({len(res) / dt:.2f} tiles/s); tris mean {np.mean(tr):.0f} max {max(tr)}; raw KB mean {np.mean(by) / 1024:.0f} max {max(by) / 1024:.0f}; total {sum(by) / 1e6:.1f} MB")
    if a.meshopt:
        meshopt_all(_OUT, [r["tile"] for r in res])


def meshopt_all(outdir, tiles):
    import shutil, subprocess
    if not shutil.which("npx"):
        print("npx not found: skipping meshopt"); return
    tot0 = tot1 = 0
    for ix, iy in tiles:
        p = os.path.join(outdir, f"{ix}_{iy}.ground.glb")
        if not os.path.exists(p): continue
        tmp = p + ".tmp.glb"
        r = subprocess.run(["npx", "-y", "@gltf-transform/cli@4.5.1", "meshopt", p, tmp], capture_output=True, text=True)
        if r.returncode == 0 and os.path.exists(tmp):
            tot0 += os.path.getsize(p); tot1 += os.path.getsize(tmp); os.replace(tmp, p)
        else:
            print("meshopt failed for", p, r.stderr[-200:])
    print(f"meshopt: {tot0 / 1e6:.1f} MB -> {tot1 / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
