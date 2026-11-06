#!/usr/bin/env python3
"""Checks for ground.py: python3 tools/nyc/test_ground.py  (needs the derived NYC data; ~10 s)."""
import os, sys
import numpy as np
from shapely.geometry import LineString, Polygon, box
from shapely.ops import unary_union

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ground

ok = True


def check(cond, msg):
    global ok
    print(("PASS " if cond else "FAIL ") + msg)
    ok &= bool(cond)


# triangulation: area conserved, up-facing, holes respected
sq = Polygon([(0, 0), (10, 0), (10, 10), (0, 10)], [[(2, 2), (2, 4), (4, 4), (4, 2)]])
pos, idx, uv, col = ground.tri_geom(sq, 0.0)
a, b, c = pos[idx[:, 0]], pos[idx[:, 1]], pos[idx[:, 2]]
cr = np.cross(b - a, c - a)
check(abs(cr[:, 2].sum() / 2 - sq.area) < 1e-6 and (cr[:, 2] > 0).all(), "tri_geom keeps area, holes and CCW winding")

ctx = ground.Context()
tiles = [(0, 0), (1, 0), (0, 1), (1, 4), (0, -2)]
res = {t: ground.build_tile(ctx, *t, debug=True) for t in tiles}

for t, (meshes, graph, info) in res.items():
    P = info["polys"]
    T = P["T"]
    parts = [P["curb"], P["road"], P["sidewalk"], P["plaza"], P["park"], P["water"]]
    cover = unary_union(parts)
    miss = T.difference(cover).area
    over = sum(p.area for p in parts) - cover.area
    check(miss < 0.5 and over < 0.5, f"tile {t}: partition covers the tile (hole {miss:.3f} m2, overlap {over:.3f} m2)")
    tris = sum(len(m.idx) for m in meshes)
    check(tris <= 25000, f"tile {t}: {tris} tris <= 25k")
    for m in meshes:
        check(np.isfinite(m.pos).all() and m.idx.max() < len(m.pos), f"tile {t}: mesh {m.material} finite and indexed")
    n = len(graph["nodes"])
    check(all(0 <= e["a"] < n and 0 <= e["b"] < n for e in graph["edges"]) and len(graph["gid"]) == n, f"tile {t}: graph indices valid ({len(graph['edges'])} edges)")

# seams: road coverage on shared border identical (both tiles clip the same margin-built polygon)
for (ta, tb, line) in [((0, 0), (1, 0), LineString([(256, 0), (256, 256)])), ((0, 0), (0, 1), LineString([(0, 256), (256, 256)]))]:
    la = res[ta][2]["polys"]["road"].buffer(0.01).intersection(line).length
    lb = res[tb][2]["polys"]["road"].buffer(0.01).intersection(line).length
    check(abs(la - lb) < 0.2, f"seam {ta}|{tb}: road length on the border {la:.2f} vs {lb:.2f} m")
# graph edges crossing a border are listed in both tiles with the same global node ids
ga = {(g) for g in res[(0, 0)][1]["gid"]}
gb = {(g) for g in res[(1, 0)][1]["gid"]}
check(len(ga & gb) > 0, f"graph: {len(ga & gb)} shared global node ids across the 0,0|1,0 border")
# widths: Manhattan avenues ~ 18-24 m, streets 11-15 m
ws = [e["w"] for e in res[(0, 0)][1]["edges"] if "Avenue" in e["name"]]
check(not ws or 17 <= np.median(ws) <= 24, f"avenue width median {np.median(ws) if ws else '-'}")
print("ALL OK" if ok else "FAILURES")
sys.exit(0 if ok else 1)
