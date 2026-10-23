#!/usr/bin/env python3
"""Manhattan outline (NYC Open Data borough boundaries, public domain, dataset gthc-hcne) in the game frame -> derived/manhattan_mask.json
(list of polygons, each a list of rings [[x,y],..]). Used to drop Brooklyn/Queens/New Jersey data that the bbox picks up, and as the world extent."""
import json, os, sys, urllib.parse, urllib.request
sys.path.insert(0, os.path.dirname(__file__))
from extract import D, OUT, xy
raw = os.path.join(D, "manhattan_boundary.json")
if not os.path.exists(raw):
    url = "https://data.cityofnewyork.us/resource/gthc-hcne.json?$where=" + urllib.parse.quote("borocode='1'")
    open(raw, "wb").write(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "NightRun/1.0"}), timeout=120).read())
g = json.load(open(raw))[0]["the_geom"]
polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
mask = [[xy([p[0] for p in r], [p[1] for p in r]) for r in poly] for poly in polys]
json.dump(mask, open(os.path.join(OUT, "manhattan_mask.json"), "w"))
xs = [p[0] for poly in mask for r in poly for p in r]; ys = [p[1] for poly in mask for r in poly for p in r]
print("polygons", len(mask), "extent x", round(min(xs)), round(max(xs)), "y", round(min(ys)), round(max(ys)), "(metres from Times Square)")
