#!/usr/bin/env python3
"""All Manhattan building footprints (NYC Open Data, public domain, dataset 5zhs-2jue): official roof height, ground elevation, construction year.
Paged (10k rows per request) into assets_source/downloads/nyc/footprints_manhattan.json. Manhattan bbox with a margin."""
import json, os, urllib.parse, urllib.request
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "assets_source/downloads/nyc/footprints_manhattan.json")
S, N, W, E = 40.6990, 40.8830, -74.0250, -73.9050
UA = "NightRun-racing-game/1.0 (open-source)"
rows, off = [], 0
while True:
    where = urllib.parse.quote(f"within_box(the_geom,{S},{W},{N},{E}) AND substring(base_bbl,1,1)='1'")   # BBL borough 1 = Manhattan
    url = (f"https://data.cityofnewyork.us/resource/5zhs-2jue.json?$limit=10000&$offset={off}&$order=:id"
           f"&$select=base_bbl,height_roof,ground_elevation,construction_year,feature_code,the_geom&$where={where}")
    part = json.loads(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=180).read())
    rows += part; off += len(part); print(len(rows), flush=True)
    if len(part) < 10000: break
os.makedirs(os.path.dirname(OUT), exist_ok=True)
json.dump(rows, open(OUT, "w"))
print("saved", len(rows), "footprints")
