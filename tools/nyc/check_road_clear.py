#!/usr/bin/env python3
"""How far street furniture reaches onto the asphalt AS DRAWN, over the shipped tiles:

    python3 tools/nyc/check_road_clear.py [tiles dir]      # default web/public/assets/nyc/tiles

For every prop row in {ix}_{iy}.props.json: its ground footprint (props.FOOT, rotated and scaled like the game draws it)
against ground.road_surface (the ways buffered to their drawn width, the rounded kerb fillets at the corners, parking lots).
Reports per kind the props whose footprint touches the asphalt and how deep the deepest reaches in. Exit 1 if any does.
"""
import glob, json, math, os, sys
import shapely
from shapely.geometry import Point

sys.path.insert(0, os.path.dirname(__file__))
import props as P
import tilelib as T

d = sys.argv[1] if len(sys.argv) > 1 else T.OUT_TILES
W = T.World()
hits, worst, total = {}, {}, {}
for f in sorted(glob.glob(os.path.join(d, "*.props.json"))):
    ix, iy = map(int, os.path.basename(f).split(".")[0].split("_"))
    t = P.Tile(W, ix, iy)
    R = t.drawn_road()
    if R.is_empty:
        continue
    edge = R.boundary
    O = json.load(open(f))
    for k, rows in O.items():
        if k not in P.FOOT:
            continue
        for r in rows:
            total[k] = total.get(k, 0) + 1
            fp = P.footprint(k, r)
            if not R.intersects(fp):
                continue
            depth = max((edge.distance(Point(c)) for c in fp.exterior.coords if R.contains(Point(c))), default=0.0)
            if depth < 0.05:
                continue
            hits[k] = hits.get(k, 0) + 1
            if depth > worst.get(k, (0,))[0]:
                worst[k] = (round(depth, 2), f"{ix}_{iy}", r[:2])
for k in sorted(total):
    print(f"{k:16s} {hits.get(k, 0):5d} / {total[k]:6d} on the asphalt" + (f"   deepest {worst[k][0]} m at tile {worst[k][1]} {worst[k][2]}" if k in worst else ""))
print("OK" if not hits else f"{sum(hits.values())} props reach onto the road")
sys.exit(1 if hits else 0)
