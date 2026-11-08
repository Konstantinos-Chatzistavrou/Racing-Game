#!/usr/bin/env python3
"""Street furniture for the New York tiles: writes {ix}_{iy}.props.json (see docs/nyc_props.md and docs/nyc_tiles.md).

    python3 tools/nyc/props.py --box -3 4 -4 6      # Midtown test box (ix0 ix1 iy0 iy1, inclusive)
    python3 tools/nyc/props.py --all                # every tile with content
    python3 tools/nyc/props.py --box -1 1 -1 1 --debug   # also _dbg_{ix}_{iy}.json (roads + buildings for the test page)

Everything is deterministic: positions come from the OSM data, or are synthesised from the road geometry with hash-based choices
(tile independent, so a street crossing a tile border gets the same lamps whichever tile asks).
Frame: game frame metres (x east, y north), yaw in radians counter-clockwise from +x. z values are heights above the tile ground.
"""
import argparse, json, math, os, sys, zlib
import numpy as np
import shapely
from shapely.geometry import LineString, Point, Polygon, box as sbox
from shapely.ops import nearest_points, unary_union
from shapely.strtree import STRtree

sys.path.insert(0, os.path.dirname(__file__))
import tilelib as T
from ground import DRIVE, road_poly, road_surface, road_width

# Ground-level footprint of each kind in its own frame (three.js local x, z = the mesh extents in web/src/scene/nyc/props.ts;
# overhead parts like lamp and signal arms, tree crowns, are meant to reach over the road and are not part of it). Trees scale
# by their row's scale. Every footprint keeps KERB_CLEAR from the asphalt AS DRAWN (ground.road_surface: the union of the
# ways plus the rounded kerb fillets at the corners, up to ~1.9 m beyond the buffered ways, plus parking lots).
FOOT = {"lamp": (-0.17, 0.17, -0.17, 0.17), "signal": (-0.15, 0.15, -0.15, 0.15), "tree": (-0.78, 0.78, -0.78, 0.78),
        "hydrant": (-0.16, 0.22, -0.16, 0.16), "bench": (-0.26, 0.25, -0.9, 0.9), "bus_stop": (-0.8, 0.81, -1.85, 1.85),
        "subway_entrance": (-1.99, 1.99, -0.99, 1.19), "steam": (-0.3, 0.3, -0.3, 0.3), "cone": (-0.21, 0.21, -0.21, 0.21),
        "kiosk": (-0.65, 0.65, -0.9, 0.9), "waste": (-0.28, 0.28, -0.28, 0.28), "scaffold": (-2.0, 2.0, -1.75, 1.78)}
NO_YAW = ("steam", "cone", "waste")
KERB_CLEAR = 0.35     # footprint to asphalt edge (the 0.2 m kerb top + rounding of the written positions)
MAX_PUSH = 3.0        # moved farther than this back onto the sidewalk: dropped instead


def footprint(k, row):
    """Ground footprint polygon (game frame) of a prop row: local (lx, lz) -> (x + c lx + s lz, y + s lx - c lz) (signage.ts writeMatrix)."""
    x0, x1, z0, z1 = FOOT[k]
    sc = row[3] if k == "tree" and len(row) > 3 else 1.0
    yaw = 0.0 if k in NO_YAW else row[2]
    c, s = math.cos(yaw), math.sin(yaw)
    return Polygon([(row[0] + (c * lx + s * lz) * sc, row[1] + (s * lx - c * lz) * sc) for lx, lz in ((x0, z0), (x1, z0), (x1, z1), (x0, z1))])

MASK = (1 << 64) - 1


def hf(*vals):
    """Deterministic hash of integers -> float in [0, 1)."""
    h = 0x9E3779B97F4A7C15
    for v in vals:
        h ^= (int(v) + 0x9E3779B97F4A7C15 + ((h << 6) & MASK) + (h >> 2)) & MASK
        h = (h * 0xBF58476D1CE4E5B9) & MASK
        h ^= h >> 29
    h = (h * 0x94D049BB133111EB) & MASK
    h ^= h >> 32
    return (h >> 11) / float(1 << 53)


# --- road classes -------------------------------------------------------------------------------------------------------------------
RANK = {"trunk": 0, "primary": 1, "secondary": 2, "tertiary": 3, "residential": 4, "unclassified": 4, "living_street": 5}
HOST = set(RANK)                                      # roads that carry lamps / trees (not motorways, service lanes, ramps)
BLOCK = set(RANK) | {"service", "motorway", "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link"}
# OSM carriageway widths in the data are small (6.6 m for a street that is 18 m kerb to kerb with parking lanes): the kerb line is at least this wide.
MIN_WIDTH = {"trunk": 18.0, "primary": 16.0, "secondary": 14.0, "tertiary": 12.0, "residential": 11.0, "unclassified": 10.0, "living_street": 8.0, "service": 5.0}
SIDEWALK_GAP = 0.9      # lamp pole distance behind the kerb line
TREE_GAP = 1.7


def eff_width(d):
    """Kerb-to-kerb width: exactly the ground generator's (ground.road_width), so props stand where the drawn kerb is.
    (MIN_WIDTH was narrower than what ground.py draws for avenues and primaries, 14-16 m vs 18-22 m: lamps, trees,
    hydrants, shelters and steam stacks "0.9 m behind the kerb" stood ~1 m inside the rendered road.)"""
    return road_width(d)


def point_at(pts, dist):
    """(x, y, tx, ty) at arclength `dist` along a polyline (pts: list of [x,y])."""
    acc = 0.0
    for a, b in zip(pts[:-1], pts[1:]):
        dx, dy = b[0] - a[0], b[1] - a[1]
        l = math.hypot(dx, dy)
        if l > 0 and acc + l >= dist:
            t = (dist - acc) / l
            return a[0] + dx * t, a[1] + dy * t, dx / l, dy / l
        acc += l
    a, b = pts[-2], pts[-1]
    l = math.hypot(b[0] - a[0], b[1] - a[1]) or 1.0
    return b[0], b[1], (b[0] - a[0]) / l, (b[1] - a[1]) / l


def tangent_at(line, x, y):
    d = line.project(Point(x, y))
    L = line.length
    a = line.interpolate(max(0.0, d - 1.5)); b = line.interpolate(min(L, d + 1.5))
    dx, dy = b.x - a.x, b.y - a.y
    l = math.hypot(dx, dy) or 1.0
    return dx / l, dy / l


class Tile:
    def __init__(self, world, ix, iy):
        self.w, self.ix, self.iy = world, ix, iy
        self.b = T.tile_bounds(ix, iy)
        self.M = 90.0   # margin to look beyond the tile
        self.out = {k: [] for k in ("lamp", "tree", "signal", "hydrant", "bench", "bus_stop", "subway_entrance", "steam", "scaffold",
                                    "cone", "kiosk", "waste", "sign")}
        x0, y0, x1, y1 = self.b
        self.inside = lambda x, y: x0 <= x < x1 and y0 <= y < y1
        roads = [(d, g) for d, g in world.query("roads", self.b, self.M) if d["hw"] in BLOCK and not d["tunnel"]]
        self.roads = [d for d, _ in roads]
        self.rlines = [g for _, g in roads]
        self.rtree = STRtree(self.rlines) if roads else None
        self.rw = [eff_width(d) / 2 for d in self.roads]
        self.blds = world.query("buildings", self.b, 40.0)
        self.bgeoms = [g for _, g in self.blds]
        self.btree = STRtree(self.bgeoms) if self.bgeoms else None
        self.areas = world.query("areas", self.b, 60.0)
        self._road = None
        water = [g for d, g in self.areas if d["kind"] in ("water", "pier") and d["kind"] == "water"]
        self.water = unary_union(water) if water else None
        self.nodes = [d for d, g in world.query("nodes", self.b, 6.0)]
        self.lamp_xy = []          # for tree clearance

    # ---- predicates --------------------------------------------------------------------------------------------------------------
    def near_roads(self, x, y, r):
        if self.rtree is None:
            return []
        return list(self.rtree.query(Point(x, y), predicate="dwithin", distance=r))

    def blocked(self, x, y, self_idx=None, name=None, clear=0.2, bld=True):
        """True if (x, y) is on a carriageway (+clear), in a building, or in water."""
        p = Point(x, y)
        for i in self.near_roads(x, y, 40.0):
            if i == self_idx:
                continue
            d = self.roads[i]
            c = clear if (name and d.get("name") == name) else clear + 0.0
            if d["hw"] == "service":
                c = 0.0
            if self.rlines[i].distance(p) < self.rw[i] + c - (0.0 if d["hw"] != "motorway" else 0.0):
                return True
        if bld and self.btree is not None:
            for i in self.btree.query(p.buffer(0.6)):
                if self.bgeoms[i].distance(p) < 0.6:
                    return True
        if self.water is not None and self.water.contains(p):
            return True
        return False

    def drawn_road(self):
        """The asphalt exactly as ground.py draws it around this tile (prepared for fast distance tests)."""
        if self._road is None:
            x0, y0, x1, y1 = self.b
            B = sbox(x0 - 30, y0 - 30, x1 + 30, y1 + 30)
            dp = [road_poly(r, g) for r, g in self.w.query("roads", B.bounds, 40) if r["hw"] in DRIVE and not r["tunnel"]]
            pl = [(g.buffer(0) if not g.is_valid else g) for a, g in self.w.query("areas", B.bounds, 2) if a["kind"] == "parking"]
            self._road = road_surface(dp, pl, B)
            shapely.prepare(self._road)
        return self._road

    def off_road(self, k, row):
        """The row with its footprint >= KERB_CLEAR from the drawn asphalt: unchanged, pushed back onto the sidewalk (away from
        the nearest asphalt edge), or None (would move more than MAX_PUSH, or into a building)."""
        R = self.drawn_road()
        if R.is_empty:
            return row
        fp = footprint(k, row)
        if not shapely.dwithin(R, fp, KERB_CLEAR):
            return row
        x, y = row[0], row[1]
        edge = R.boundary
        for _ in range(16):
            p = Point(x, y)
            q = nearest_points(edge, p)[0]
            dx, dy = x - q.x, y - q.y
            d = math.hypot(dx, dy)
            if d < 1e-6:
                return None
            ux, uy = dx / d, dy / d
            if R.contains(p):
                ux, uy = -ux, -uy
            gap = R.distance(fp)
            x += ux * max(0.12, KERB_CLEAR - gap + 0.05)
            y += uy * max(0.12, KERB_CLEAR - gap + 0.05)
            fp = footprint(k, [x, y] + list(row[2:]))
            if math.hypot(x - row[0], y - row[1]) > MAX_PUSH:
                return None
            if not shapely.dwithin(R, fp, KERB_CLEAR):
                break
        else:
            return None
        if k != "scaffold" and self.btree is not None and any(self.bgeoms[i].intersects(fp) for i in self.btree.query(fp)):
            return None
        return [x, y] + list(row[2:])

    def nearest_road(self, x, y, maxd=45.0, host_only=True):
        best = None
        for i in self.near_roads(x, y, maxd):
            d = self.roads[i]
            if host_only and d["hw"] not in HOST:
                continue
            dist = self.rlines[i].distance(Point(x, y))
            if best is None or dist - self.rw[i] < best[0]:
                best = (dist - self.rw[i], i)
        return best[1] if best else None

    def snap_kerb(self, x, y, gap, maxd=45.0):
        """Move a point that lies on/near a road to the sidewalk (gap m behind the kerb line). Returns (x, y, road_dir_x, road_dir_y, road_idx) or None."""
        i = self.nearest_road(x, y, maxd)
        if i is None:
            return None
        line = self.rlines[i]
        p = Point(x, y)
        q = line.interpolate(line.project(p))
        tx, ty = tangent_at(line, q.x, q.y)
        nx, ny = -ty, tx
        side = 1.0 if (x - q.x) * nx + (y - q.y) * ny >= 0 else -1.0
        off = self.rw[i] + gap
        if line.distance(p) > off:                      # already on the sidewalk
            return x, y, tx, ty, i
        return q.x + nx * side * off, q.y + ny * side * off, tx, ty, i

    def facing_road(self, x, y, i):
        """yaw from (x, y) towards the nearest point of road i."""
        q = self.rlines[i].interpolate(self.rlines[i].project(Point(x, y)))
        return math.atan2(q.y - y, q.x - x)

    # ---- intersections -----------------------------------------------------------------------------------------------------------
    def intersections(self):
        res = []
        idx = [i for i, d in enumerate(self.roads) if d["hw"] in RANK and not d["bridge"]]
        if not idx:
            return res
        lines = [self.rlines[i] for i in idx]
        tr = STRtree(lines)
        for a, ga in enumerate(lines):
            for b in tr.query(ga):
                if b <= a:
                    continue
                da, db = self.roads[idx[a]], self.roads[idx[b]]
                if da.get("name") and da.get("name") == db.get("name"):
                    continue
                inter = ga.intersection(lines[b])
                geoms = [inter] if inter.geom_type == "Point" else list(getattr(inter, "geoms", []))
                for g in geoms:
                    if g.geom_type != "Point":
                        continue
                    if not self.inside(g.x, g.y):
                        continue
                    ta, tb = tangent_at(ga, g.x, g.y), tangent_at(lines[b], g.x, g.y)
                    if abs(ta[0] * tb[1] - ta[1] * tb[0]) < 0.3:
                        continue
                    res.append((g.x, g.y, idx[a], idx[b], ta, tb))
        # one per cluster (twin carriageways, split ways): strongest class first
        res.sort(key=lambda r: (min(RANK[self.roads[r[2]]["hw"]], RANK[self.roads[r[3]]["hw"]]), r[0], r[1]))
        keep = []
        for r in res:
            if all(math.hypot(r[0] - k[0], r[1] - k[1]) > 14.0 for k in keep):
                keep.append(r)
        return keep


def jitter_cells(poly, cell, seed):
    """Jittered grid sample points inside the bounds of poly: yields (x, y, h) with h a hash for thinning."""
    x0, y0, x1, y1 = poly.bounds
    gx0, gy0 = int(math.floor(x0 / cell)), int(math.floor(y0 / cell))
    gx1, gy1 = int(math.floor(x1 / cell)), int(math.floor(y1 / cell))
    for gx in range(gx0, gx1 + 1):
        for gy in range(gy0, gy1 + 1):
            yield (gx + 0.15 + 0.7 * hf(seed, gx, gy, 1)) * cell, (gy + 0.15 + 0.7 * hf(seed, gx, gy, 2)) * cell, hf(seed, gx, gy, 3), gx, gy


def vnoise(x, y, scale, seed):
    """Smooth value noise 0..1."""
    fx, fy = x / scale, y / scale
    ix, iy = math.floor(fx), math.floor(fy)
    tx, ty = fx - ix, fy - iy
    tx, ty = tx * tx * (3 - 2 * tx), ty * ty * (3 - 2 * ty)
    a, b, c, d = hf(seed, ix, iy), hf(seed, ix + 1, iy), hf(seed, ix, iy + 1), hf(seed, ix + 1, iy + 1)
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty


# --- the generator ------------------------------------------------------------------------------------------------------------------
def gen_tile(world, ix, iy, debug=False):
    t = Tile(world, ix, iy)
    O = t.out
    seed0 = ix * 7919 + iy * 104729
    mid_zone = abs(ix * 256 + 128) < 1500 and -1200 < iy * 256 + 128 < 2200       # Midtown: steam stacks, scaffolds, shop signs

    # lamps + street trees along host roads ----------------------------------------------------------------------------------------
    lamps = []
    for ri, d in enumerate(t.roads):
        if d["hw"] not in HOST or d["bridge"]:
            continue
        pts = d["pts"]
        line = t.rlines[ri]
        L = line.length
        if L < 24:
            continue
        hw = t.rw[ri]
        if d.get("sidewalk") == "no":
            continue
        rid = int(d["id"]) % 1000003
        # lamps: cobra heads every ~30 m, both sides, staggered (avenues 26 m: wider)
        sp = 26.0 if RANK[d["hw"]] <= 2 else 32.0
        n = max(1, int(round((L - 16.0) / sp)))
        step = (L - 16.0) / n
        for side in (1, -1):
            for k in range(n):
                s = 8.0 + step * (k + (0.5 if side > 0 else 0.0) + (0.5 if n > 1 else 0.5 * (1 if side > 0 else 0)))
                s = min(max(s, 8.0), L - 8.0)
                x, y, tx, ty = point_at(pts, s)
                nx, ny = -ty, tx
                lx, ly = x + nx * side * (hw + SIDEWALK_GAP), y + ny * side * (hw + SIDEWALK_GAP)
                if not t.inside(lx, ly) or t.blocked(lx, ly, ri, d.get("name"), clear=3.0):
                    continue
                lamps.append((lx, ly, math.atan2(-ny * side, -nx * side)))
    for lx, ly, yw in lamps:
        O["lamp"].append([lx, ly, yw])
    t.lamp_xy = [(a, b) for a, b, _ in lamps]

    # street trees (residential-class streets mostly; avenues get a few)
    for ri, d in enumerate(t.roads):
        if d["hw"] not in HOST or d["bridge"] or d.get("sidewalk") == "no":
            continue
        rank = RANK[d["hw"]]
        if rank <= 1:
            continue
        pts = d["pts"]; line = t.rlines[ri]; L = line.length
        if L < 30:
            continue
        hw = t.rw[ri]
        rid = int(d["id"]) % 1000003
        sp = 11.0 if rank >= 4 else 16.0
        n = int((L - 20.0) / sp)
        for side in (1, -1):
            for k in range(n + 1):
                if hf(rid, k, side, 5) > (0.72 if rank >= 4 else 0.45):
                    continue
                s = 10.0 + k * sp + (hf(rid, k, side, 6) - 0.5) * 2.0 + (sp * 0.5 if side < 0 else 0.0)
                if s > L - 9.0:
                    continue
                x, y, tx, ty = point_at(pts, s)
                nx, ny = -ty, tx
                px, py = x + nx * side * (hw + TREE_GAP), y + ny * side * (hw + TREE_GAP)
                if math.hypot(px, py) < 220.0:
                    continue
                if not t.inside(px, py) or t.blocked(px, py, ri, d.get("name"), clear=5.5):
                    continue
                if any((px - a) ** 2 + (py - b) ** 2 < 9.0 for a, b in t.lamp_xy):
                    continue
                O["tree"].append([px, py, hf(rid, k, side, 7) * 6.283, 0.8 + 0.5 * hf(rid, k, side, 8)])

    # OSM nodes ----------------------------------------------------------------------------------------------------------------------
    osm_trees = []
    osm_signals = []
    for n in t.nodes:
        x, y, k = n["x"], n["y"], n["kind"]
        if not t.inside(x, y):
            if k == "signal":
                osm_signals.append((x, y))
            continue
        nid = int(abs(x * 10) * 7 + abs(y * 10) * 13)
        if k == "tree":
            osm_trees.append((x, y))
            if math.hypot(x, y) >= 220.0 and not t.blocked(x, y, clear=-0.5, bld=True):
                O["tree"].append([x, y, hf(nid, 1) * 6.283, 0.8 + 0.5 * hf(nid, 2)])
        elif k == "signal":
            osm_signals.append((x, y))
        elif k in ("hydrant", "bench", "bus_stop", "subway_entrance", "waste"):
            sn = t.snap_kerb(x, y, 1.2) if k in ("bus_stop", "hydrant", "waste") else None
            if sn:
                px, py, tx, ty, ri = sn
            else:
                px, py = x, y
                ri = t.nearest_road(x, y, 40.0)
                tx, ty = tangent_at(t.rlines[ri], x, y) if ri is not None else (1.0, 0.0)
            if not t.inside(px, py):
                continue
            fy = t.facing_road(px, py, ri) if ri is not None else 0.0
            if k == "waste":
                O["waste"].append([px, py])
            elif k == "hydrant":
                O["hydrant"].append([px, py, fy])
            elif k == "bench":
                if not t.blocked(px, py, clear=0.0, bld=False):
                    O["bench"].append([px, py, fy])
            elif k == "bus_stop":
                O["bus_stop"].append([px, py, fy])
            else:
                O["subway_entrance"].append([px, py, math.atan2(ty, tx)])

    # intersections: signals, hydrants, steam stacks, cones ----------------------------------------------------------------------
    ints = t.intersections()
    osm_sig_pts = [(x, y) for x, y in osm_signals]
    steam_cand = []
    for (px, py, a, b, ta, tb) in ints:
        da, db = t.roads[a], t.roads[b]
        ra, rb = RANK[da["hw"]], RANK[db["hw"]]
        if ra > rb:
            a, b, ta, tb, ra, rb = b, a, tb, ta, rb, ra
            da, db = db, da
        near_osm = any((px - sx) ** 2 + (py - sy) ** 2 < 35.0 ** 2 for sx, sy in osm_sig_pts)
        signalised = (ra <= 2 and rb <= 4) or near_osm
        wa, wb = t.rw[a], t.rw[b]
        iid = int(abs(px) * 10 + abs(py) * 1000) % 99991
        phase = round(hf(iid, 11) * 60.0, 1)
        if signalised:
            for sa, sb in ((1, 1), (-1, -1), (1, -1), (-1, 1)):
                ox, oy = sa * (wb + 1.2) * ta[0] + sb * (wa + 1.2) * tb[0], sa * (wb + 1.2) * ta[1] + sb * (wa + 1.2) * tb[1]
                cx, cy = px + ox, py + oy
                if not t.inside(cx, cy) or t.blocked(cx, cy, clear=0.3):
                    continue
                if sa * sb > 0:     # serves road A traffic coming from -sa*dA: arm across road A towards -sb*dB, heads face -sa*dA
                    arm = (-sb * tb[0], -sb * tb[1]); face = (-sa * ta[0], -sa * ta[1]); group = 0
                else:               # serves road B traffic coming from -sb*dB: arm across road B towards -sa*dA
                    arm = (-sa * ta[0], -sa * ta[1]); face = (-sb * tb[0], -sb * tb[1]); group = 1
                cross = arm[0] * face[1] - arm[1] * face[0]
                O["signal"].append([cx, cy, math.atan2(arm[1], arm[0]), 1 if cross > 0 else -1, group, phase])
        # hydrants at some corners
        for sa, sb in ((1, 1), (-1, -1), (1, -1), (-1, 1)):
            if hf(iid, sa, sb, 21) < 0.28:
                hx, hy = px + sa * (wb + 3.0) * ta[0] + sb * (wa + 0.9) * tb[0], py + sa * (wb + 3.0) * ta[1] + sb * (wa + 0.9) * tb[1]
                if t.inside(hx, hy) and not t.blocked(hx, hy, clear=0.2):
                    O["hydrant"].append([hx, hy, hf(iid, sa, sb, 22) * 6.283])
        if rb <= 4 and ra >= 2:
            steam_cand.append((hf(iid, 31), px, py, ta, tb, wa, wb))
        # (no cone rows across the lanes at intersections: a racing map keeps the carriageways clear; cones stand by
        # construction sheds on the sidewalk instead, gen_buildings)
    # steam stacks: at most one per Midtown tile, on the kerb edge just outside the carriageway (never in a lane)
    steam_cand.sort()
    nsteam = (1 if hf(seed0, 51) < 0.6 else 0) if mid_zone else 0
    for h, px, py, ta, tb, wa, wb in steam_cand[:nsteam]:
        sa, sb = (1 if hf(seed0, 53) > 0.5 else -1), (1 if hf(seed0, 54) > 0.5 else -1)
        sx, sy = px + sa * (wb + 9.0) * ta[0] + sb * (wa + 0.7) * tb[0], py + sa * (wb + 9.0) * ta[1] + sb * (wa + 0.7) * tb[1]
        if t.inside(sx, sy) and not t.blocked(sx, sy, clear=0.3, bld=True):
            O["steam"].append([sx, sy, 3.2 + hf(seed0, 55) * 1.2])

    # parks, plazas ------------------------------------------------------------------------------------------------------------------
    park_trees = 0
    x0, y0, x1, y1 = t.b
    tile_box = sbox(x0, y0, x1, y1)
    for d, g in t.areas:
        kind = d["kind"]
        if kind not in ("park", "plaza", "pedestrian", "grass"):
            continue
        if not g.intersects(tile_box):
            continue
        part = g.intersection(tile_box)
        if part.is_empty or part.area < 300:
            continue
        aid = zlib.crc32(str(d["id"]).encode()) % 1000003
        name = (d.get("name") or "").lower()
        if kind in ("park", "grass") and part.area >= 600:
            geom = part
            if "bryant" in name:
                # rows of plane trees along the inset perimeter paths
                for inset in (5.0, 11.0):
                    ring = g.buffer(-inset)
                    for poly in getattr(ring, "geoms", [ring]):
                        if poly.is_empty:
                            continue
                        ext = poly.exterior
                        n = int(ext.length / 7.0)
                        for k in range(n):
                            q = ext.interpolate(k * ext.length / max(n, 1))
                            if tile_box.contains(q) and not t.blocked(q.x, q.y, clear=1.0):
                                O["tree"].append([q.x, q.y, hf(aid, k, int(inset), 1) * 6.283, 1.0 + 0.3 * hf(aid, k, int(inset), 2)])
                inner = g.buffer(-3.0)
                for poly in getattr(inner, "geoms", [inner]):
                    if poly.is_empty:
                        continue
                    ext = poly.exterior
                    n = int(ext.length / 22.0)
                    for k in range(n):
                        q = ext.interpolate(k * ext.length / max(n, 1))
                        if tile_box.contains(q):
                            O["lamp"].append([q.x, q.y, hf(aid, k, 3) * 6.283])
                            if k % 2 == 0:
                                O["bench"].append([q.x + 1.2, q.y, hf(aid, k, 4) * 6.283])
                continue
            # dense, clumpy trees (Central Park): jittered grid thinned by smooth noise
            cell = 8.5
            for sx, sy, h, gx, gy in jitter_cells(part, cell, aid):
                if not (x0 <= sx < x1 and y0 <= sy < y1):
                    continue
                dens = vnoise(sx, sy, 55.0, aid) * 0.9 + vnoise(sx, sy, 17.0, aid + 1) * 0.35
                p = max(0.0, min(0.85, (dens - 0.28) * 1.5)) * (1.0 if kind == "park" else 0.5)
                if h > p:
                    continue
                if not part.contains(Point(sx, sy)):
                    continue
                if t.blocked(sx, sy, clear=2.0):
                    continue
                if any((sx - a) ** 2 + (sy - b) ** 2 < 12.0 for a, b in osm_trees):
                    continue
                O["tree"].append([sx, sy, hf(aid, gx, gy, 4) * 6.283, 0.9 + 0.7 * hf(aid, gx, gy, 5)])
            # path lamps + benches along the boundary
            ext = part.exterior if part.geom_type == "Polygon" else None
            if ext is not None and part.area > 4000:
                inner = part.buffer(-2.5)
                for poly in getattr(inner, "geoms", [inner]):
                    if poly.is_empty:
                        continue
                    e = poly.exterior
                    n = int(e.length / 36.0)
                    for k in range(n):
                        q = e.interpolate(k * e.length / max(n, 1))
                        if tile_box.contains(q) and not t.blocked(q.x, q.y, clear=2.0):
                            O["lamp"].append([q.x, q.y, hf(aid, k, 8) * 6.283])
                            if k % 3 == 0:
                                O["bench"].append([q.x + 1.0, q.y, hf(aid, k, 9) * 6.283])
        elif kind in ("plaza", "pedestrian") and part.area > 600:
            geom = part
            # lamps along the boundary, benches and trees inside, kiosks
            inner = part.buffer(-1.5)
            for poly in getattr(inner, "geoms", [inner]):
                if poly.is_empty:
                    continue
                e = poly.exterior
                n = int(e.length / 24.0)
                for k in range(n):
                    q = e.interpolate(k * e.length / max(n, 1))
                    if tile_box.contains(q) and not t.blocked(q.x, q.y, clear=1.0):
                        O["lamp"].append([q.x, q.y, hf(aid, k, 12) * 6.283])
            count = int(min(8, part.area / 700))
            for k in range(count):
                q = part.representative_point() if k == 0 else Point(*[v for v in _pt_in(part, aid, k)])
                if not tile_box.contains(q) or t.blocked(q.x, q.y, clear=1.0, bld=True):
                    continue
                r = hf(aid, k, 13)
                if r < 0.35:
                    O["bench"].append([q.x, q.y, hf(aid, k, 14) * 6.283])
                elif r < 0.6 or math.hypot(q.x, q.y) < 220.0:
                    O["kiosk"].append([q.x, q.y, hf(aid, k, 15) * 6.283])
                else:
                    O["tree"].append([q.x, q.y, hf(aid, k, 16) * 6.283, 0.9 + 0.4 * hf(aid, k, 17)])

    # buildings: scaffolding sheds, signs ---------------------------------------------------------------------------------------------
    gen_buildings(t, tile_box, mid_zone)

    # final sweep: nothing free-standing on a carriageway (OSM trees / hydrants / shelters are mapped where the source put
    # them, which is sometimes on the road we draw; signal poles at odd crossings). Lamps were placed against the kerb
    # already; building-attached kinds (scaffold, sign, kiosk) stay.
    for k, clear in (("tree", 0.4), ("hydrant", 0.3), ("bench", 0.3), ("bus_stop", 0.3), ("waste", 0.3),
                     ("subway_entrance", 0.3), ("signal", 0.0), ("steam", 0.3), ("cone", 0.3)):
        O[k] = [v for v in O[k] if not t.blocked(v[0], v[1], clear=clear, bld=False)]
    # ... and no footprint on the asphalt as drawn (corner fillets, parking lots, wide props): pushed back or dropped
    for k in FOOT:
        O[k] = [r for r in (t.off_road(k, v) for v in O[k]) if r is not None]

    # caps (budget ~1500 per tile)
    caps = {"lamp": 420, "tree": 900, "signal": 64, "hydrant": 48, "bench": 70, "bus_stop": 14, "subway_entrance": 14, "steam": 6,
            "scaffold": 70, "cone": 24, "kiosk": 8, "waste": 50, "sign": 360}
    for k, cap in caps.items():
        if len(O[k]) > cap:
            O[k] = sorted(O[k], key=lambda v: hf(seed0, int(abs(v[0]) * 10), int(abs(v[1]) * 10), 77))[:cap]
    total = sum(len(v) for v in O.values())
    if total > 1500 and len(O["tree"]) > total - 1500:
        O["tree"] = O["tree"][: len(O["tree"]) - (total - 1500)]
    return O


def _pt_in(poly, seed, k):
    x0, y0, x1, y1 = poly.bounds
    for j in range(20):
        x, y = x0 + (x1 - x0) * hf(seed, k, j, 91), y0 + (y1 - y0) * hf(seed, k, j, 92)
        if poly.contains(Point(x, y)):
            return x, y
    p = poly.representative_point()
    return p.x, p.y


def ring_edges(rings):
    r = rings[0]
    for a, b in zip(r, r[1:] + r[:1]):
        l = math.hypot(b[0] - a[0], b[1] - a[1])
        if l > 0.5:
            yield a, b, l


def gen_buildings(t, tile_box, mid_zone):
    O = t.out
    x0, y0, x1, y1 = t.b
    scaf = 0
    for (d, g) in t.blds:
        c = g.representative_point()
        if not (x0 <= c.x < x1 and y0 <= c.y < y1):
            continue
        h = float(d.get("h") or 0)
        bid = zlib.crc32(str(d["id"]).encode()) % 1000003
        r = math.hypot(c.x, c.y)
        # probability profile of big screens: dense around Times Square
        p_big = 0.98 if r < 360 else 0.58 if r < 540 else 0.14 if r < 950 else 0.0
        max_big = 12 if r < 360 else 3
        p_shop = 0.18 if r < 1400 else 0.05 if r < 3500 else 0.0
        p_scaf = 0.035 if mid_zone else 0.01
        if p_big == 0 and p_shop == 0 and p_scaf == 0:
            continue
        best = None
        did_big = 0
        shops = 0
        for ei, (a, b, l) in enumerate(ring_edges(d["rings"])):
            if l < 6.0:
                continue
            mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
            ex, ey = (b[0] - a[0]) / l, (b[1] - a[1]) / l
            nx, ny = ey, -ex
            if g.contains(Point(mx + nx * 0.4, my + ny * 0.4)):
                nx, ny = -nx, -ny
            # which road does this wall face? must be a host road within 54 m in Times Square (wide bowtie plazas) or 32 m elsewhere
            ri = t.nearest_road(mx, my, 54.0 if r < 400 else 32.0, host_only=True)
            if ri is None:
                continue
            q = t.rlines[ri].interpolate(t.rlines[ri].project(Point(mx, my)))
            dist = math.hypot(q.x - mx, q.y - my)
            if dist < t.rw[ri] - 0.5 or (q.x - mx) * nx + (q.y - my) * ny <= 0:
                continue
            yaw = math.atan2(ny, nx)
            if best is None or l > best[0]:
                best = (l, mx, my, ex, ey, nx, ny, yaw, ri)
            if h >= 14 and l >= 8.0 and did_big < max_big and hf(bid, ei, 61) < p_big and RANK.get(t.roads[ri]["hw"], 9) <= 4:
                zmax = min(h - 1.5, 52.0)
                n_cols = min(3, max(1, int(l // 19.0))) if r < 360 else 1
                col_w = (l - 1.6) / n_cols
                for ci in range(n_cols):
                    if did_big >= max_big:
                        break
                    s_seed = ei * 17 + ci * 31
                    hs = min(13.5, max(5.0, zmax * 0.38)) * (0.78 + 0.42 * hf(bid, s_seed, 62))
                    ws = min(col_w - 0.8, 6.5 + 18.0 * hf(bid, s_seed, 63))
                    if zmax > hs + 5.0 and ws > 4.0:
                        z0 = 5.0 + hf(bid, s_seed, 64) * max(0.0, min(6.5 if r < 360 else 12.0, zmax - hs - 5.0))
                        c_center = ((ci + 0.5) / n_cols - 0.5) * (l - 1.6)
                        O["sign"].append([mx + ex * c_center + nx * 0.36, my + ey * c_center + ny * 0.36, z0 + hs / 2, yaw, ws, hs, int(hf(bid, s_seed, 66) * 8)])
                        did_big += 1
                        # Stacked upper LED megascreen in Times Square
                        if r < 360 and zmax > z0 + hs + 9.0 and did_big < max_big:
                            hs2 = min(13.5, zmax - (z0 + hs + 2.0))
                            ws2 = min(col_w - 0.8, ws * (0.88 + 0.22 * hf(bid, s_seed, 73)))
                            z1 = z0 + hs + 1.4
                            O["sign"].append([mx + ex * c_center + nx * 0.39, my + ey * c_center + ny * 0.39, z1 + hs2 / 2, yaw, ws2, hs2, int(hf(bid, s_seed, 74) * 8)])
                            did_big += 1
            elif h >= 4 and l >= 5 and shops < 3 and hf(bid, ei, 67) < p_shop and RANK.get(t.roads[ri]["hw"], 9) <= 5:
                ws = min(l * 0.7, 2.2 + 4.5 * hf(bid, ei, 68))
                off = (hf(bid, ei, 69) - 0.5) * max(0.0, l - ws - 1.0)
                O["sign"].append([mx + ex * off + nx * 0.25, my + ey * off + ny * 0.25, 3.2 + 1.2 * hf(bid, ei, 70), yaw, ws, 0.55 + 0.5 * hf(bid, ei, 71),
                                  10 + int(hf(bid, ei, 72) * 6)])
                shops += 1
        # scaffolding sheds on the longest street wall
        if best and h > 14 and hf(bid, 80) < p_scaf and best[0] >= 12:
            l, mx, my, ex, ey, nx, ny, yaw, ri = best
            n = int(min(6, l // 4))
            for k in range(n):
                s = (k + 0.5) * 4.0 - n * 2.0
                px, py = mx + ex * s + nx * 1.9, my + ey * s + ny * 1.9
                if t.inside(px, py) and not t.blocked(px, py, clear=0.0, bld=False):
                    O["scaffold"].append([px, py, math.atan2(ey, ex)])
            # a couple of cones at one end of some sheds, on the sidewalk
            if n and hf(bid, 81) < 0.25:
                for j in range(2):
                    s = n * 2.0 + 0.8 + j * 0.9
                    qx, qy = mx + ex * s + nx * (1.6 + 0.2 * j), my + ey * s + ny * (1.6 + 0.2 * j)
                    if t.inside(qx, qy) and not t.blocked(qx, qy, clear=0.4, bld=True):
                        O["cone"].append([qx, qy])


def round_json(O):
    r1 = lambda v: round(float(v), 1)
    r2 = lambda v: round(float(v), 2)
    out = {}
    for k, v in O.items():
        rows = []
        for e in v:
            if k == "signal":
                rows.append([r1(e[0]), r1(e[1]), r2(e[2]), int(e[3]), int(e[4]), r1(e[5])])
            elif k == "sign":
                rows.append([r1(e[0]), r1(e[1]), r1(e[2]), r2(e[3]), r1(e[4]), r1(e[5]), int(e[6])])
            elif k == "tree":
                rows.append([r1(e[0]), r1(e[1]), r2(e[2]), r2(e[3])])
            elif k in ("waste", "cone"):
                rows.append([r1(e[0]), r1(e[1])])
            elif k == "steam":
                rows.append([r1(e[0]), r1(e[1]), r1(e[2])])
            else:
                rows.append([r1(e[0]), r1(e[1]), r2(e[2])])
        out[k] = rows
    return out


def write_debug(world, ix, iy, outdir):
    b = T.tile_bounds(ix, iy)
    roads = [{"hw": d["hw"], "w": eff_width(d), "pts": d["pts"]} for d, g in world.query("roads", b, 20) if d["hw"] in BLOCK and not d["tunnel"]]
    blds = [{"h": d["h"], "r": d["rings"][0]} for d, g in world.query("buildings", b, 0) if b[0] <= g.centroid.x < b[2] and b[1] <= g.centroid.y < b[3]]
    with open(os.path.join(outdir, f"_dbg_{ix}_{iy}.json"), "w") as f:
        json.dump({"roads": roads, "blds": blds}, f, separators=(",", ":"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--box", nargs=4, type=int, metavar=("IX0", "IX1", "IY0", "IY1"))
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--out", default=T.OUT_TILES)
    ap.add_argument("--debug", action="store_true", help="also write _dbg_{ix}_{iy}.json (road + building outlines) for the test page")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    world = T.World()
    if a.all:
        tiles = sorted(world.tiles_with_content())
    elif a.box:
        i0, i1, j0, j1 = a.box
        tiles = [(i, j) for i in range(i0, i1 + 1) for j in range(j0, j1 + 1)]
    else:
        ap.error("--box or --all")
    tot = {}
    nfiles = 0
    for (ix, iy) in tiles:
        O = round_json(gen_tile(world, ix, iy))
        n = sum(len(v) for v in O.values())
        if n == 0:
            continue
        with open(os.path.join(a.out, f"{ix}_{iy}.props.json"), "w") as f:
            json.dump(O, f, separators=(",", ":"))
        if a.debug:
            write_debug(world, ix, iy, a.out)
        nfiles += 1
        for k, v in O.items():
            tot[k] = tot.get(k, 0) + len(v)
        print(f"{ix}_{iy}: {n} instances " + " ".join(f"{k}={len(v)}" for k, v in O.items() if v))
    print(f"{nfiles} tiles", tot)


if __name__ == "__main__":
    main()
