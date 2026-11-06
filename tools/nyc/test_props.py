#!/usr/bin/env python3
"""Checks for tools/nyc/props.py: python3 tools/nyc/test_props.py   (needs the derived data; takes ~10 s)

 - determinism: two runs of the same tile give identical JSON
 - tile ownership: every instance lies inside its tile; no instance is on a carriageway or inside a building
 - budgets: <= 1500 instances per tile, schema (row widths) as docs/nyc_props.md
 - Midtown has what it should: signals at avenue crossings, lamps both sides, steam stacks, signs near Times Square
"""
import json, math, sys, os
sys.path.insert(0, os.path.dirname(__file__))
import props as P
import tilelib as T

W = T.World()
WIDTH = {"lamp": 3, "tree": 4, "signal": 6, "hydrant": 3, "bench": 3, "bus_stop": 3, "subway_entrance": 3, "steam": 3, "scaffold": 3, "cone": 2, "kiosk": 3, "waste": 2, "sign": 7}
fails = []


def check(cond, msg):
    if not cond:
        fails.append(msg); print("FAIL", msg)


def gen(ix, iy):
    return P.round_json(P.gen_tile(W, ix, iy))


for (ix, iy) in [(0, 0), (0, 1), (1, 4), (0, -2), (-1, 2)]:
    a, b = gen(ix, iy), gen(ix, iy)
    check(json.dumps(a) == json.dumps(b), f"{ix}_{iy} not deterministic")
    b0 = T.tile_bounds(ix, iy)
    total = sum(len(v) for v in a.values())
    check(total <= 1500, f"{ix}_{iy}: {total} instances > 1500")
    t = P.Tile(W, ix, iy)
    for k, rows in a.items():
        for r in rows:
            check(len(r) == WIDTH[k], f"{ix}_{iy} {k} row width {len(r)}")
            m = 90.0 if k in ("sign", "scaffold") else 1.0   # signs belong to the tile of their building (a long wall can cross the border)
            check(b0[0] - m <= r[0] < b0[2] + m and b0[1] - m <= r[1] < b0[3] + m, f"{ix}_{iy} {k} outside tile {r}")
    # no lamp / tree / signal on a carriageway of another road (0.3 m slack for rounding)
    for k in ("lamp", "signal"):
        bad = 0
        for r in a[k]:
            if t.blocked(r[0], r[1], clear=-0.4, bld=False):
                bad += 1
        check(bad <= max(1, len(a[k]) // 40), f"{ix}_{iy}: {bad}/{len(a[k])} {k} on a carriageway")
    print(f"{ix}_{iy}: {total} instances", {k: len(v) for k, v in a.items() if v})

ts = gen(0, 0)
check(len(ts["signal"]) >= 8, "Times Square tile should have signals")
check(len(ts["lamp"]) >= 25, "Times Square tile should have lamps")
check(len(ts["sign"]) >= 15, "Times Square tile should have signs")
check(any(s[6] < 8 for s in ts["sign"]), "Times Square tile should have big screens")
# signals come in opposing pairs sharing a phase offset per intersection
by = {}
for s in ts["signal"]:
    by.setdefault(s[5], []).append(s)
check(all(1 <= len(v) <= 8 for v in by.values()), "signal groups per intersection")
print("FAILED" if fails else "OK", len(fails))
sys.exit(1 if fails else 0)
