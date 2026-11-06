#!/usr/bin/env python3
"""New York buildings: real NYC footprints -> per-tile LOD0 (`bld.glb`), LOD1 (`far.glb`) and colliders (`col.json`). Contract: docs/nyc_tiles.md,
details and numbers: docs/nyc_buildings.md.

    python3 tools/nyc/buildings.py --box -3 4 -4 6        # tiles ix -3..4, iy -4..6 (Midtown test box)
    python3 tools/nyc/buildings.py --all                  # every tile that owns a building
    python3 tools/nyc/buildings.py --tiles -1,-5 0,0      # explicit tiles

Every building is emitted ONLY in the tile that contains its footprint centroid, whole (it may stick out of the tile by its own extent).
Walls: material `facade`, UV = (metres along the wall, metres up), COLOR_0 = wall tint with alpha = baked AO, `_BLD` = (seed, floors, kind, era).
Roof tops, parapets, cornices, mechanical boxes, water tanks, spires: material `roof` (COLOR_0 tint, alpha = AO, UV metres).
"""
import argparse, json, math, os, subprocess, sys, time, zlib
from multiprocessing import Pool

import numpy as np
import mapbox_earcut
import shapely
from shapely.geometry import Polygon
from shapely.geometry.polygon import orient

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tilelib as tl
from tilelib import Mesh

TRI_BUDGET = 60000
FLOOR_H = [3.4, 3.6, 4.0, 4.1, 4.2, 4.0]          # metres per floor by kind (facade.ts uses the same table)
# landmarks: matched to the real footprint (by bbl or by the tallest footprint near a point). tiers: (fraction of roof height, inset as a fraction of
# the footprint's inscribed radius); spire = metres above the roof.
LANDMARKS = [
    dict(name="Empire State Building", bbl="1008350041", spire=65.0, tint=(0.50, 0.47, 0.40),
         tiers=[(0.069, 0.0), (0.162, 0.28), (0.215, 0.5), (0.85, 0.62), (0.90, 0.75), (0.94, 0.85), (0.97, 0.92), (1.0, 0.96)]),
    dict(name="Chrysler Building", at=(845, -711), r=60, hmin=150, spire=40.0, tint=(0.46, 0.48, 0.5),
         tiers=[(0.19, 0.0), (0.24, 0.3), (0.77, 0.45), (0.84, 0.6), (0.89, 0.72), (0.93, 0.82), (0.97, 0.9), (1.0, 0.95)]),
    dict(name="One World Trade Center", at=(-2358, -5030), r=200, hmin=300, spire=124.0, tint=(0.13, 0.19, 0.24), tiers=[(1.0, 0.0)]),
    dict(name="30 Rockefeller Plaza", at=(574, 78), r=70, hmin=150, spire=0.0, tint=(0.52, 0.48, 0.40),
         tiers=[(0.18, 0.0), (0.45, 0.35), (0.75, 0.5), (1.0, 0.62)]),
    dict(name="Flatiron Building", at=(-355, -1877), r=40, hmin=70, spire=0.0, tint=(0.55, 0.50, 0.42), tiers=[(1.0, 0.0)]),
    dict(name="Grand Central Terminal", at=(701, -589), r=60, hmin=30, hmax=120, spire=0.0, tint=(0.52, 0.46, 0.36), tiers=[(1.0, 0.0)]),
    dict(name="Penn Station / Madison Square Garden", at=(-676, -822), r=80, hmin=20, hmax=120, spire=0.0, tint=(0.38, 0.38, 0.40), tiers=[(1.0, 0.0)]),
]


# ----------------------------------------------------------------------------------------------------------------- geometry helpers
class Acc:
    """Vertex/index accumulator for one material."""
    def __init__(self, material):
        self.material = material
        self.p, self.n, self.uv, self.c, self.b, self.i = [], [], [], [], [], []
        self.nv = 0

    def add(self, pos, idx, nrm, uv, col, bld=None):
        k = len(pos)
        self.p.append(np.asarray(pos, np.float64)); self.n.append(np.asarray(nrm, np.float32)); self.uv.append(np.asarray(uv, np.float32))
        self.c.append(np.asarray(col, np.float32))
        if bld is not None:
            self.b.append(np.broadcast_to(np.asarray(bld, np.float32), (k, 4)))
        self.i.append(np.asarray(idx, np.int64).reshape(-1, 3) + self.nv)
        self.nv += k

    @property
    def tris(self):
        return sum(len(i) for i in self.i)

    def mesh(self, with_bld):
        if not self.i:
            return None
        uv = np.round(np.concatenate(self.uv) * 16.0) / 16.0     # 6 cm grid: float mantissas with trailing zeros compress ~2x better under meshopt
        return Mesh(self.material, np.concatenate(self.p), np.concatenate(self.i), np.concatenate(self.n), uv,
                    np.concatenate(self.c), {"BLD": np.concatenate(self.b)} if with_bld else {})


def rgba(rgb, a, k):
    c = np.empty((k, 4), np.float32)
    c[:, :3] = rgb; c[:, 3] = a
    return c


def ring_arr(ring):
    return np.asarray(ring.coords, np.float64)


def walls(acc, ring, levels, rgb, bld=None, min_edge=0.03):
    """Vertical quads along one ring (closed coordinate array; exterior CCW / holes CW so that the outward normal is (dy,-dx)).
    levels = [(z, ao), ...] ascending; one quad row per consecutive pair. UV = (cumulative metres along the ring, z)."""
    a, b = ring[:-1], ring[1:]
    d = b - a
    L = np.hypot(d[:, 0], d[:, 1])
    u0 = np.concatenate([[0.0], np.cumsum(L)])[:-1]
    k = L > min_edge
    a, b, d, L, u0 = a[k], b[k], d[k], L[k], u0[k]
    E = len(a)
    if E == 0:
        return
    nrm = np.zeros((E, 3), np.float32)
    nrm[:, 0] = d[:, 1] / L; nrm[:, 1] = -d[:, 0] / L
    base = np.arange(E) * 4
    idx = np.stack([base, base + 1, base + 2, base, base + 2, base + 3], axis=1).reshape(-1, 3)
    for (z0, a0), (z1, a1) in zip(levels[:-1], levels[1:]):
        if z1 - z0 < 1e-3:
            continue
        pos = np.zeros((E, 4, 3)); uv = np.zeros((E, 4, 2)); col = np.zeros((E, 4, 4), np.float32)
        pos[:, 0, :2] = a; pos[:, 1, :2] = b; pos[:, 2, :2] = b; pos[:, 3, :2] = a
        pos[:, :2, 2] = z0; pos[:, 2:, 2] = z1
        uv[:, 0, 0] = u0; uv[:, 1, 0] = u0 + L; uv[:, 2, 0] = u0 + L; uv[:, 3, 0] = u0
        uv[:, :2, 1] = z0; uv[:, 2:, 1] = z1
        col[..., :3] = rgb; col[:, :2, 3] = a0; col[:, 2:, 3] = a1
        acc.add(pos.reshape(-1, 3), idx, np.repeat(nrm, 4, axis=0), uv.reshape(-1, 2), col.reshape(-1, 4), bld)


def parts(g):
    if g is None or g.is_empty:
        return []
    if isinstance(g, Polygon):
        return [g]
    out = []
    for p in getattr(g, "geoms", []):
        out += parts(p)
    return out


def triangulate(poly):
    rings = [ring_arr(poly.exterior)] + [ring_arr(r) for r in poly.interiors]
    verts = np.vstack([r[:-1] for r in rings])
    ends = np.cumsum([len(r) - 1 for r in rings]).astype(np.uint32)
    tri = np.asarray(mapbox_earcut.triangulate_float64(verts, ends), np.int64).reshape(-1, 3)
    return verts, tri


def cap(acc, poly, z, rgb, ao=1.0, up=True):
    """Horizontal face of a polygon (with holes) at height z. UV = (x, y) metres."""
    for p in parts(poly):
        if p.area < 0.05:
            continue
        verts, tri = triangulate(p)
        if len(tri) == 0:
            continue
        a, b, c = verts[tri[:, 0]], verts[tri[:, 1]], verts[tri[:, 2]]
        sa = (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (b[:, 1] - a[:, 1]) * (c[:, 0] - a[:, 0])
        flip = (sa < 0) if up else (sa > 0)
        tri = tri.copy(); tri[flip] = tri[flip][:, [0, 2, 1]]
        pos = np.column_stack([verts, np.full(len(verts), z)])
        nrm = np.zeros((len(verts), 3), np.float32); nrm[:, 2] = 1.0 if up else -1.0
        acc.add(pos, tri, nrm, verts, rgba(rgb, ao, len(verts)))


def box(acc, cx, cy, z0, sx, sy, sz, yaw, rgb):
    """Box rotated by yaw about its centre: 4 sides + top."""
    c, s = math.cos(yaw), math.sin(yaw)
    hx, hy = sx / 2, sy / 2
    pts = [(cx + x * c - y * s, cy + x * s + y * c) for x, y in ((-hx, -hy), (hx, -hy), (hx, hy), (-hx, hy))]
    walls(acc, np.array(pts + [pts[0]]), [(z0, 0.85), (z0 + sz, 1.0)], rgb)
    cap(acc, Polygon(pts), z0 + sz, np.clip(rgb * 1.15, 0, 1), 1.0)


def cylinder(acc, cx, cy, z0, r, h, rgb, n=10, r_top=None, cone_to=None):
    """Smooth-shaded cylinder/frustum with a closed top, or a conical roof (cone_to = apex height above the rim)."""
    r_top = r if r_top is None else r_top
    ang = np.linspace(0, 2 * np.pi, n, endpoint=False)
    ca, sa = np.cos(ang), np.sin(ang)
    k = np.arange(n); k2 = (k + 1) % n
    p0 = np.column_stack([cx + r * ca, cy + r * sa, np.full(n, z0)])
    p1 = np.column_stack([cx + r_top * ca, cy + r_top * sa, np.full(n, z0 + h)])
    nrm = np.column_stack([np.concatenate([ca, ca]), np.concatenate([sa, sa]), np.zeros(2 * n)])
    uv = np.column_stack([np.concatenate([ang * r, ang * r]), np.concatenate([np.full(n, z0), np.full(n, z0 + h)])])
    col = np.vstack([rgba(rgb, 0.8, n), rgba(rgb, 1.0, n)])
    idx = np.concatenate([np.stack([k, k2, n + k2], 1), np.stack([k, n + k2, n + k], 1)])
    acc.add(np.vstack([p0, p1]), idx, nrm, uv, col)
    if cone_to is not None:
        base = np.column_stack([cx + r_top * 1.15 * ca, cy + r_top * 1.15 * sa, np.full(n, z0 + h)])
        pos = np.vstack([base, [[cx, cy, z0 + h + cone_to]]])
        nr = np.column_stack([ca, sa, np.full(n, r_top * 1.15 / max(cone_to, 0.1))]); nr /= np.linalg.norm(nr, axis=1, keepdims=True)
        acc.add(pos, np.stack([k, k2, np.full(n, n)], 1), np.vstack([nr, [[0, 0, 1]]]), pos[:, :2], rgba(rgb * 0.8, 1.0, n + 1))
    else:
        top = np.vstack([p1, [[cx, cy, z0 + h]]])
        nr = np.zeros((n + 1, 3)); nr[:, 2] = 1
        acc.add(top, np.stack([k, k2, np.full(n, n)], 1), nr, top[:, :2], rgba(rgb * 1.1, 1.0, n + 1))


# ----------------------------------------------------------------------------------------------------------------- classification
def hash01(s):
    return (zlib.crc32(s.encode()) & 0xFFFFFF) / float(0x1000000)


def classify(h, area, year, rng):
    """kind 0 walk-up, 1 mid-rise, 2 office, 3 glass tower, 4 industrial/loft (landmark = 5 is set by the landmark match)."""
    y = year if year > 1700 else 1930
    if h >= 100:
        return 3 if (y >= 1985 and rng.random() < 0.72) else 2
    if h >= 45:
        if y >= 1990 and rng.random() < 0.5:
            return 3
        if y >= 1950:
            return 2 if rng.random() < 0.7 else 1
        return 2 if (area > 500 and rng.random() < 0.6) else 1
    if h >= 22:
        if y < 1945:
            if area > 650:
                return 4
            if h < 27 and area < 320:
                return 0
            return 1
        return 2 if (area > 1800 and rng.random() < 0.5) else 1
    if area > 900 or (h < 10 and area > 450):
        return 4
    return 0


# wall tints (linear RGB) per kind
PALETTE = {
    0: [(0.42, 0.16, 0.11), (0.34, 0.14, 0.10), (0.30, 0.20, 0.14), (0.46, 0.34, 0.22), (0.27, 0.15, 0.12), (0.50, 0.48, 0.42), (0.38, 0.22, 0.15)],
    1: [(0.46, 0.34, 0.23), (0.40, 0.15, 0.11), (0.52, 0.47, 0.38), (0.50, 0.40, 0.20), (0.36, 0.28, 0.22), (0.44, 0.40, 0.36)],
    2: [(0.50, 0.47, 0.42), (0.38, 0.38, 0.39), (0.14, 0.17, 0.21), (0.46, 0.40, 0.32), (0.26, 0.27, 0.29), (0.55, 0.53, 0.48)],
    3: [(0.07, 0.15, 0.20), (0.06, 0.08, 0.11), (0.17, 0.21, 0.25), (0.12, 0.10, 0.08), (0.09, 0.18, 0.16), (0.10, 0.13, 0.20)],
    4: [(0.33, 0.13, 0.09), (0.30, 0.20, 0.14), (0.28, 0.29, 0.28), (0.42, 0.30, 0.18), (0.36, 0.34, 0.30)],
    5: [(0.50, 0.47, 0.40)],
}


def tint_for(kind, rng):
    pal = PALETTE[kind]
    t = np.array(pal[int(rng.integers(len(pal)))], np.float32)
    return np.clip(t * (0.85 + 0.3 * rng.random()), 0, 1)


# ----------------------------------------------------------------------------------------------------------------- footprints
def clean_polygons(g):
    """Shapely geometry (maybe invalid) -> clean simple polygons (CCW outer, CW holes): make_valid, simplify 0.15 m, drop slivers < 4 m2."""
    try:
        g = shapely.make_valid(g)
    except Exception:
        g = g.buffer(0)
    out = []
    for p in parts(g):
        p = p.simplify(0.15, preserve_topology=True)
        for q in parts(p):
            q = Polygon(q.exterior, [r for r in q.interiors if Polygon(r).area >= 12.0])
            if q.area >= 4.0 and q.is_valid:
                out.append(orient(q, 1.0))
    return out


def inscribed_radius(poly):
    try:
        return float(shapely.maximum_inscribed_circle(poly, 0.3).length)
    except Exception:
        _, w, l, _ = mrr_info(poly)
        return min(w, l) / 2


def mrr_info(poly):
    """(yaw of the long axis, long side, short side, centre) of the minimum rotated rectangle."""
    r = poly.minimum_rotated_rectangle
    xs = np.asarray(r.exterior.coords)
    e0, e1 = xs[1] - xs[0], xs[2] - xs[1]
    l0, l1 = float(np.hypot(*e0)), float(np.hypot(*e1))
    e = e0 if l0 >= l1 else e1
    return math.atan2(e[1], e[0]), max(l0, l1), min(l0, l1), r.centroid.coords[0]


def tier_polys(poly, tiers, inr):
    """[(z_top, polygon)] with each polygon inside the previous one; tiers that vanish are dropped (the previous one is extended)."""
    out, cur = [], poly
    for z, inset in tiers:
        if inset > 0:
            p = poly.buffer(-min(inset, inr * 0.92), join_style=2, mitre_limit=4.0).intersection(cur)
        else:
            p = cur
        if p.is_empty or p.area < 0.12 * poly.area or p.area < 9:
            break
        ps = orient(max(parts(p), key=lambda q: q.area), 1.0)
        out.append((z, ps))
        cur = ps
    return out or [(tiers[-1][0], poly)]


def profile_tiers(h, area, era, inr, kind, rng):
    """Zoning-style setbacks [(z_top, inset_m)], last z == h. Single tier for low buildings."""
    if not ((h >= 60 and area >= 300) or (h >= 45 and area >= 800)):
        return [(h, 0.0)]
    fh = FLOOR_H[kind]
    sw = max(fh * 5, round(rng.uniform(20, 35) / fh) * fh)
    if sw > h * 0.6:
        return [(h, 0.0)]
    step = min(6.5, inr * 0.24)
    if era < 0.45:            # pre-war: wedding cake, 2..4 setbacks
        n = 2 + (h > 120) + (h > 200) + (rng.random() < 0.3)
    elif era < 0.82:          # 1945-1990: street wall + plaza setback
        if rng.random() < 0.4:
            return [(h, 0.0)]
        n = 2 + (h > 140)
    else:                     # modern: slender tower on a podium sometimes
        if rng.random() < 0.55:
            return [(h, 0.0)]
        n = 2
    tiers = [(sw, 0.0)]
    cuts = np.sort(rng.uniform(0.3, 0.9, size=n - 2)) if n > 2 else np.array([])
    zs = [sw + (h - sw) * c for c in cuts] + [h]
    inset = 0.0
    for z in zs:
        inset += step * (rng.uniform(0.7, 1.3) if era < 0.82 else rng.uniform(1.0, 1.8))
        tiers.append((round(z / fh) * fh if z < h else h, inset))
    return tiers


# ----------------------------------------------------------------------------------------------------------------- one building
def match_landmarks(items):
    """items: [(index, polygon, h, id, centroid)] -> {index: landmark}. Real footprints (bbl) or the tallest one near a known point."""
    found = {}
    for lm in LANDMARKS:
        best, bh = None, -1
        for i, poly, h, bid, c in items:
            if "bbl" in lm:
                if bid.startswith(lm["bbl"]) and poly.area > 3000:
                    best = i
                    break
                continue
            if h < lm.get("hmin", 0) or h > lm.get("hmax", 1e9):
                continue
            if math.hypot(c[0] - lm["at"][0], c[1] - lm["at"][1]) <= lm["r"] and h + poly.area * 0.01 > bh:
                best, bh = i, h + poly.area * 0.01
        if best is not None:
            found[best] = lm
    return found


def build_building(A, poly, d, idx, lm, detail, far=False):
    """Emit one building into A = {'facade': Acc, 'roof': Acc}. detail: 2 full, 1 no small props, 0 bare. Returns triangles added."""
    h = float(d["h"])
    year = int(d.get("year") or 0)
    key = f"{d['id']}#{idx}"
    seed01 = hash01(key)
    rng = np.random.default_rng(zlib.crc32(key.encode()))
    area = poly.area
    kind = 5 if lm is not None else classify(h, area, year, rng)
    era = float(np.clip(((year if year > 1700 else 1930) - 1900) / 100.0, 0.0, 1.0))
    floors = max(1, int(round(h / FLOOR_H[kind])))
    tint = np.array(lm["tint"], np.float32) if lm else tint_for(kind, rng)
    bld = np.array([seed01, floors, kind, era], np.float32)
    stone = np.clip(tint * 1.18 + 0.04, 0, 1)
    roofc = np.array([0.075, 0.075, 0.08], np.float32) * (0.8 + 0.5 * rng.random())
    F, R = A["facade"], A["roof"]
    if far:
        poly = orient(poly.simplify(1.8, preserve_topology=True), 1.0)
        if poly.is_empty or poly.area < 30 or h < 7:      # beyond 500 m a shed is invisible
            return 0
        poly = Polygon(poly.exterior)
    inr = inscribed_radius(poly) if h >= 40 else 0.0
    if lm is not None:
        tiers = [(f * h, i * inr) for f, i in lm["tiers"]]
    elif far and not (h >= 70 and area >= 300):
        tiers = [(h, 0.0)]
    else:
        tiers = profile_tiers(h, area, era, inr, kind, rng)
    tp = tier_polys(poly, tiers, inr)
    tris0 = F.tris + R.tris
    zprev, prev = 0.0, None
    for ti, (z, p) in enumerate(tp):
        if ti == len(tp) - 1:
            z = h
        levels = [(zprev, 1.0 if ti == 0 else 0.9), (z, 1.0)]     # contact AO of the ground tier is done in the shader (from the height v)
        for q in parts(p):
            walls(F, ring_arr(q.exterior), levels, tint, bld)
            if not far:
                for hole in q.interiors:
                    walls(F, ring_arr(hole), levels, tint, bld)
        if prev is not None:
            cap(R, prev.difference(p), zprev, roofc if far else stone, 0.95)     # visible roof of the lower tier
        zprev, prev = z, p
    top_poly = prev
    if far:
        cap(R, top_poly, h, roofc, 1.0)
        return F.tris + R.tris - tris0
    old_flat = kind in (0, 1, 4) and era < 0.42 and h > 9
    z0 = h + 0.004 * seed01
    if old_flat and detail >= 1:       # cornice: a thin stone ledge sticking out of the top
        outer = Polygon(orient(top_poly.buffer(0.22, join_style=2, mitre_limit=3.0), 1.0).exterior)
        cap(R, outer, z0, roofc, 1.0)
        walls(R, ring_arr(outer.exterior), [(h - 0.7, 0.9), (z0, 1.0)], stone)
        cap(R, outer.difference(top_poly), h - 0.7, stone * 0.8, 0.8, up=False)
    else:
        cap(R, top_poly, z0, roofc, 1.0)
        if detail >= 2 and area >= 160 and h < 120 and rng.random() < 0.55:      # parapet
            inner = top_poly.buffer(-0.3, join_style=2, mitre_limit=3.0)
            if not inner.is_empty and inner.area > 10:
                walls(R, ring_arr(top_poly.exterior), [(z0, 1.0), (z0 + 0.9, 1.0)], tint * 0.9)
                for q in parts(inner):
                    walls(R, ring_arr(orient(q, -1.0).exterior), [(z0, 0.8), (z0 + 0.9, 1.0)], tint * 0.7)    # inner face looks into the roof
                cap(R, top_poly.difference(inner), z0 + 0.9, stone, 1.0)
    if detail >= 1:
        add_roof_stuff(R, top_poly, h, z0, kind, era, area, rng, tint, detail, lm)
    return F.tris + R.tris - tris0


def sample_in(poly, rng, m, tries=12):
    """Random point of poly at least m metres from its boundary (None if the roof is too narrow)."""
    x0, y0, x1, y1 = poly.bounds
    for _ in range(tries):
        x, y = x0 + (x1 - x0) * rng.random(), y0 + (y1 - y0) * rng.random()
        if shapely.contains_xy(poly, x, y) and poly.exterior.distance(shapely.Point(x, y)) >= m:
            return x, y
    return None


def add_roof_stuff(R, roof, h, z0, kind, era, area, rng, tint, detail, lm):
    yaw = mrr_info(roof)[0]
    metal = np.array([0.16, 0.16, 0.17], np.float32) * (0.8 + 0.4 * rng.random())
    conc = np.clip(tint * 0.5 + 0.1, 0, 1)
    tall = h >= 60
    n = min(7, 1 + int(roof.area / (350 if tall else 450)))
    for k in range(n):
        if tall and k == 0:      # mechanical penthouse + antenna on towers
            inner = roof.buffer(-max(1.5, 0.22 * math.sqrt(roof.area)), join_style=2, mitre_limit=3.0)
            if not inner.is_empty and inner.area > 25:
                ph = rng.uniform(5, 11) if lm is None else 14
                ip = orient(max(parts(inner), key=lambda q: q.area), 1.0)
                walls(R, ring_arr(ip.exterior), [(z0, 0.9), (z0 + ph, 1.0)], conc)
                cap(R, ip, z0 + ph, metal * 0.9, 1.0)
                sp = lm["spire"] if lm else (rng.uniform(12, 45) if (h > 150 and rng.random() < 0.7) else 0)
                if sp > 0:
                    c = ip.centroid
                    cylinder(R, c.x, c.y, z0 + ph, min(3.0, 0.008 * h) if lm else 0.7, sp, metal, n=6, r_top=0.12)
            continue
        pt = sample_in(roof, rng, 3.0 if tall else 2.2)
        if pt is None:
            continue
        if k:
            sx, sy, sz = rng.uniform(1.4, 4.6), rng.uniform(1.4, 3.2), rng.uniform(0.9, 2.0)
        else:                       # stair / elevator bulkhead
            sx, sy, sz = rng.uniform(3, 5), rng.uniform(3, 6), rng.uniform(2.6, 3.6)
        box(R, pt[0], pt[1], z0, sx, sy, sz, yaw, conc if k == 0 or rng.random() < 0.3 else metal)
    if detail >= 2 and kind in (0, 1, 4) and 14 <= h <= 70 and era < 0.62 and area > 80 and rng.random() < 0.3:    # wooden water tank on stilts
        pt = sample_in(roof, rng, 2.6)
        if pt is not None:
            r = rng.uniform(1.5, 2.1)
            wood = np.array([0.15, 0.085, 0.05], np.float32) * (0.8 + 0.5 * rng.random())
            for sx in (-1, 1):
                for sy in (-1, 1):
                    box(R, pt[0] + sx * r * 0.7, pt[1] + sy * r * 0.7, z0, 0.18, 0.18, 2.2, 0.0, metal * 0.6)
            cylinder(R, pt[0], pt[1], z0 + 2.2, r, 3.0, wood, n=9, cone_to=1.2)


def colliders(poly, h, depth=0):
    """Oriented boxes covering a footprint: one min-area rectangle if it fits well, else cut across the long axis and recurse."""
    yaw, L, W, c = mrr_info(poly)
    one = [dict(cx=round(c[0], 2), cy=round(c[1], 2), z0=0.0, z1=round(h, 2), hx=round(L / 2, 2), hy=round(W / 2, 2), yaw=round(yaw, 4))]
    if poly.area / max(L * W, 1e-6) >= 0.8 or poly.area < 60 or depth >= 3:
        return one
    ux, uy = math.cos(yaw), math.sin(yaw)
    out = []
    for sgn in (-1, 1):
        # half of the rectangle on one side of its centre, enlarged sideways so the cut is exact
        px, py = c[0] + sgn * L / 4 * ux, c[1] + sgn * L / 4 * uy
        corners = [(px + lx * ux - ly * uy, py + lx * uy + ly * ux)
                   for lx, ly in ((-L / 4 - 0.5, -W / 2 - 2), (L / 4 + 0.5, -W / 2 - 2), (L / 4 + 0.5, W / 2 + 2), (-L / 4 - 0.5, W / 2 + 2))]
        for q in parts(poly.intersection(Polygon(corners))):
            if q.area >= 8:
                out += colliders(q, h, depth + 1)
    return out or one


# ----------------------------------------------------------------------------------------------------------------- tiles
_W = None          # World (fork-inherited by the pool workers)
_BUCKETS = None    # {(ix,iy): [building index]}


def init_world():
    global _W, _BUCKETS
    if _W is not None:
        return
    _W = tl.World(layers=("buildings",))
    _BUCKETS = {}
    for i, g in enumerate(_W.geoms["buildings"]):
        c = g.centroid
        _BUCKETS.setdefault(tl.tile_of(c.x, c.y), []).append(i)


def tile_buildings(ix, iy):
    """[(item, polygon, part)] owned by this tile: centroid inside, whole footprint. Multi-part geometries become several buildings."""
    out = []
    for i in _BUCKETS.get((ix, iy), []):
        item = _W.items["buildings"][i]
        if item["h"] < 2.5:
            continue
        for j, p in enumerate(clean_polygons(_W.geoms["buildings"][i])):
            out.append((item, p, j))
    return out


def build_tile(ix, iy, outdir, compress=True):
    t0 = time.time()
    bl = tile_buildings(ix, iy)
    if not bl:
        return None
    lms = match_landmarks([(k, p, float(it["h"]), it["id"], p.centroid.coords[0]) for k, (it, p, j) in enumerate(bl)])
    name = tl.tile_name(ix, iy)
    res = {}
    for detail in (2, 1, 0):
        A = {"facade": Acc("facade"), "roof": Acc("roof")}
        for k, (it, p, j) in enumerate(bl):
            build_building(A, p, it, k, lms.get(k), detail)
        tris = A["facade"].tris + A["roof"].tris
        if tris <= TRI_BUDGET:
            break
    bld_path = os.path.join(outdir, f"{name}.bld.glb")
    res["bld_bytes"] = tl.write_glb(bld_path, [m for m in (A["facade"].mesh(True), A["roof"].mesh(False)) if m], (ix, iy), name)
    res["tris"], res["detail"] = int(tris), detail
    Fa = {"facade": Acc("facade"), "roof": Acc("roof")}
    for k, (it, p, j) in enumerate(bl):
        build_building(Fa, p, it, k, lms.get(k), 0, far=True)
    far_path = os.path.join(outdir, f"{name}.far.glb")
    res["far_tris"] = Fa["facade"].tris + Fa["roof"].tris
    res["far_bytes"] = tl.write_glb(far_path, [m for m in (Fa["facade"].mesh(True), Fa["roof"].mesh(False)) if m], (ix, iy), name + "_far")
    # colliders: tiny neighbours merged into one box when they touch
    cols = []
    small = [(p, float(it["h"])) for it, p, j in bl if p.area < 70]
    for it, p, j in bl:
        if p.area >= 70:
            cols += colliders(p, float(it["h"]))
    used = [False] * len(small)
    for a in range(len(small)):
        if used[a]:
            continue
        grp, used[a] = [a], True
        for b in range(a + 1, len(small)):
            if not used[b] and small[a][0].distance(small[b][0]) < 0.6 and abs(small[a][1] - small[b][1]) < 3:
                grp.append(b); used[b] = True
        u = shapely.union_all([small[g][0].buffer(0.3) for g in grp]).buffer(-0.3)
        for q in parts(u):
            cols += colliders(q, max(small[g][1] for g in grp))
    with open(os.path.join(outdir, f"{name}.col.json"), "w") as f:
        json.dump({"buildings": cols, "ground": 0}, f, separators=(",", ":"))
    res.update(colliders=len(cols), n=len(bl), landmarks=[lm["name"] for lm in lms.values()])
    if compress:
        for ext in ("bld", "far"):
            compress_glb(os.path.join(outdir, f"{name}.{ext}.glb"))
        res["bld_bytes"] = os.path.getsize(bld_path); res["far_bytes"] = os.path.getsize(far_path)
    res["sec"] = round(time.time() - t0, 2)
    return res


def compress_glb(path):
    """meshopt via gltf-transform (needs node + npx); keeps the plain file when it is unavailable."""
    tmp = path + ".tmp.glb"
    try:
        r = subprocess.run(["npx", "-y", "@gltf-transform/cli@4.5.1", "meshopt", path, tmp, "--level", "medium"], capture_output=True, text=True, timeout=300)
        if r.returncode == 0 and os.path.exists(tmp):
            os.replace(tmp, path)
        else:
            sys.stderr.write(f"meshopt failed for {path}: {r.stderr[-300:]}\n")
    except Exception as e:
        sys.stderr.write(f"meshopt unavailable: {e}\n")
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def export_test_streets(path, box):
    """Throwaway data for web/src/scene/nyc/buildingsTest.ts: road ribbons + lamp positions (every ~34 m, alternating sides) so the visual checks have a
    street to stand in. The real ground and props come from ground.py / props.py."""
    from shapely.geometry import LineString
    x0, x1, y0, y1 = box
    R = tl.World(layers=("roads",))
    roads, lamps = [], []
    keep = {"motorway", "trunk", "primary", "secondary", "tertiary", "residential", "unclassified", "service", "pedestrian", "living_street"}
    for it, g in R.query("roads", (x0 * 256, y0 * 256, (x1 + 1) * 256, (y1 + 1) * 256)):
        if it["hw"] not in keep or it.get("tunnel") or it.get("bridge"):
            continue
        w = float(it["width"])
        roads.append({"w": w, "pts": [[round(x, 1), round(y, 1)] for x, y in it["pts"]]})
        L = g.length
        s, side = 8.0, 1
        while s < L:
            p, q = g.interpolate(s), g.interpolate(min(s + 1, L))
            dx, dy = q.x - p.x, q.y - p.y
            n = math.hypot(dx, dy) or 1
            off = w / 2 + 1.6
            lamps.append([round(p.x - dy / n * off * side, 1), round(p.y + dx / n * off * side, 1)])
            s += 34.0; side = -side
    with open(path, "w") as f:
        json.dump({"roads": roads, "lamps": lamps}, f, separators=(",", ":"))
    print(f"test streets: {len(roads)} roads, {len(lamps)} lamps -> {path}")


def _job(args):
    ix, iy, outdir, compress = args
    try:
        return (ix, iy, build_tile(ix, iy, outdir, compress))
    except Exception:
        import traceback
        return (ix, iy, {"error": traceback.format_exc()})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--box", nargs=4, type=int, metavar=("IX0", "IX1", "IY0", "IY1"))
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--tiles", default="", help="semicolon separated ix,iy pairs, e.g. --tiles=-1,-5;0,0")
    ap.add_argument("--out", default=tl.OUT_TILES)
    ap.add_argument("--no-compress", action="store_true")
    ap.add_argument("--test-streets", action="store_true", help="also write _test_streets.json (roads + lamps for the --box) for buildingsTest.ts")
    ap.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    a = ap.parse_args()
    t0 = time.time()
    init_world()
    print(f"world: {len(_W.items['buildings'])} buildings, {len(_BUCKETS)} tiles ({time.time() - t0:.1f}s)")
    tiles = set()
    if a.all:
        tiles |= set(_BUCKETS)
    if a.box:
        x0, x1, y0, y1 = a.box
        tiles |= {(ix, iy) for ix in range(x0, x1 + 1) for iy in range(y0, y1 + 1) if (ix, iy) in _BUCKETS}
    for t in filter(None, a.tiles.split(";")):
        tiles.add(tuple(int(v) for v in t.split(",")))
    os.makedirs(a.out, exist_ok=True)
    if a.test_streets and a.box:
        export_test_streets(os.path.join(a.out, "_test_streets.json"), a.box)
    jobs = [(ix, iy, a.out, not a.no_compress) for ix, iy in sorted(tiles)]
    nb = nt = 0
    t1 = time.time()
    stats = []
    with Pool(a.jobs) as pool:
        for ix, iy, r in pool.imap_unordered(_job, jobs):
            if r is None:
                continue
            if "error" in r:
                print(f"tile {ix},{iy} FAILED\n{r['error']}")
                continue
            nb += r["n"]; nt += 1; stats.append(r)
            print(f"{ix:>3},{iy:>3}: {r['n']:4d} bld {r['tris']:6d} tris (detail {r['detail']}) bld {r['bld_bytes'] / 1024:6.0f} KB | far {r['far_tris']:5d} tris {r['far_bytes'] / 1024:5.1f} KB"
                  f" | col {r['colliders']:4d} | {r['sec']}s" + (f" {r['landmarks']}" if r["landmarks"] else ""), flush=True)
    dt = time.time() - t1
    if stats:
        print(f"{nt} tiles, {nb} buildings in {dt:.0f}s ({nb / dt:.0f} buildings/s); max tris {max(s['tris'] for s in stats)}, "
              f"max bld {max(s['bld_bytes'] for s in stats) / 1024:.0f} KB, max far {max(s['far_bytes'] for s in stats) / 1024:.1f} KB")


if __name__ == "__main__":
    main()
