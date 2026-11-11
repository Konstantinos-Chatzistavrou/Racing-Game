#!/usr/bin/env python3
"""Building colliders that stand on the asphalt AS DRAWN (an invisible wall in the street), over the shipped tiles:

    python3 tools/nyc/check_colliders.py [tiles dir] [--list]      # default web/public/assets/nyc/tiles

Every box of {ix}_{iy}.col.json (cx, cy, hx, hy, yaw; game frame, metres) against the drawn road surface of its own
tile and the eight around it (ground.road_surface through props.Tile.drawn_road). Reports the boxes that reach more
than 0.5 m into the road, how deep and how much area. Exit 1 if any does.
"""
import glob, json, math, os, sys
from shapely.geometry import Polygon
from shapely.ops import unary_union

sys.path.insert(0, os.path.dirname(__file__))
import props as P
import tilelib as T

args = [a for a in sys.argv[1:] if not a.startswith("--")]
d = args[0] if args else T.OUT_TILES
W = T.World()
roads = {}


def road(ix, iy):
    if (ix, iy) not in roads:
        try:
            roads[(ix, iy)] = P.Tile(W, ix, iy).drawn_road()
        except Exception:
            roads[(ix, iy)] = Polygon()
    return roads[(ix, iy)]


def box(b):
    c, s = math.cos(b["yaw"]), math.sin(b["yaw"])
    pts = [(b["cx"] + x * c - y * s, b["cy"] + x * s + y * c) for x, y in ((-b["hx"], -b["hy"]), (b["hx"], -b["hy"]), (b["hx"], b["hy"]), (-b["hx"], b["hy"]))]
    return Polygon(pts)


bad, total = [], 0
have = set()
for f in glob.glob(os.path.join(d, "*.col.json")):
    have.add(tuple(map(int, os.path.basename(f).split(".")[0].split("_"))))
for f in sorted(glob.glob(os.path.join(d, "*.col.json"))):
    ix, iy = map(int, os.path.basename(f).split(".")[0].split("_"))
    R = unary_union([road(ix + dx, iy + dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1) if (ix + dx, iy + dy) in have])
    if R.is_empty:
        continue
    for i, b in enumerate(json.load(open(f)).get("buildings", [])):
        total += 1
        g = box(b)
        if not R.intersects(g):
            continue
        inter = R.intersection(g)
        if inter.area < 0.5:
            continue
        depth = max((R.boundary.distance(p) for p in [inter.representative_point(), inter.centroid] if R.contains(p)), default=0.0)
        if depth < 0.5:
            continue
        bad.append((inter.area, depth, f"{ix}_{iy}", i, b))
bad.sort(key=lambda r: -r[0])
print(f"{len(bad)} / {total} collider boxes reach more than 0.5 m into the drawn road")
for area, depth, key, i, b in bad[: 40 if "--list" in sys.argv else 12]:
    print(f"  tile {key} box {i}: {area:7.1f} m2 on the asphalt, {depth:4.1f} m deep, at ({b['cx']:.0f}, {b['cy']:.0f}), {2 * b['hx']:.0f} x {2 * b['hy']:.0f} m, height {b['z0']:.0f}-{b['z1']:.0f}")
sys.exit(1 if bad else 0)
