#!/usr/bin/env python3
"""Downloads the raw real-world data for the Midtown Manhattan district into assets_source/downloads/nyc/ (gitignored).

 - OpenStreetMap via the Overpass API (ODbL: attribution "(c) OpenStreetMap contributors" is in CREDITS.md): streets, sidewalks, crossings,
   parks, water, trees, traffic signals, building outlines. The area is cut into SMALL boxes (the public instances 502 on big queries)
   and every box is retried with backoff and on several mirrors; finished boxes are cached, so the script can simply be re-run.
 - NYC Open Data "Building Footprints" (public domain, dataset 5zhs-2jue): official roof heights, ground elevation, construction year.
Area: S 40.7500 N 40.7720 W -73.9990 E -73.9740 (Columbus Circle .. Bryant Park, 8th/9th Ave .. 5th Ave), about 2.4 x 2.1 km.
Usage: tools/nyc/fetch_data.py [--cols 5 --rows 5]
"""
import argparse, json, os, sys, time, urllib.parse, urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "assets_source/downloads/nyc")
UA = "NightRun-racing-game/1.0 (open-source; contact via https://github.com/Konstantinos-Chatzistavrou/Racing-Game/issues)"
MIRRORS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter"]
S, N, W, E = 40.7500, 40.7720, -73.9990, -73.9740


def post(url, data, timeout):
    req = urllib.request.Request(url, data=urllib.parse.urlencode({"data": data}).encode(), headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def query(s, w, n, e):
    b = f"({s},{w},{n},{e})"
    return (f'[out:json][timeout:120];(way["building"]{b};way["highway"]{b};way["leisure"~"park|garden|playground|pitch"]{b};'
            f'way["landuse"~"grass|recreation_ground|retail|commercial"]{b};way["natural"~"water|wood|grassland"]{b};way["waterway"]{b};way["railway"]{b};'
            f'way["amenity"~"parking|fountain"]{b};way["man_made"~"pier|bridge"]{b};way["bridge"="yes"]{b};way["barrier"~"wall|fence"]{b};'
            f'node["natural"="tree"]{b};node["highway"~"traffic_signals|crossing|stop"]{b};node["amenity"~"bench|fountain|waste_basket|bicycle_parking"]{b};'
            f'node["emergency"="fire_hydrant"]{b};node["tourism"="artwork"]{b};node["man_made"~"street_lamp|surveillance"]{b};);out tags geom;')


def fetch_box(i, j, s, w, n, e, tries=8):
    path = os.path.join(OUT, "osm", f"box_{i}_{j}.json")
    if os.path.exists(path) and os.path.getsize(path) > 100:
        return json.load(open(path))
    q = query(s, w, n, e)
    for k in range(tries):
        url = MIRRORS[k % len(MIRRORS)]
        try:
            raw = post(url, q, 150)
            d = json.loads(raw)
            if "elements" in d:
                os.makedirs(os.path.dirname(path), exist_ok=True)
                open(path, "wb").write(raw)
                return d
        except Exception as ex:
            print(f"  box {i},{j} try {k + 1} on {url.split('/')[2]}: {str(ex)[:60]}", flush=True)
        time.sleep(min(60, 4 * (k + 1)))
    return None


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--cols", type=int, default=5); ap.add_argument("--rows", type=int, default=5)
    a = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    dlat, dlon = (N - S) / a.rows, (E - W) / a.cols
    pad = 0.0004   # overlap: ways crossing a box edge are returned by both boxes (merged by id later)
    done = 0
    for i in range(a.rows):
        for j in range(a.cols):
            d = fetch_box(i, j, S + i * dlat - pad, W + j * dlon - pad, S + (i + 1) * dlat + pad, W + (j + 1) * dlon + pad)
            done += d is not None
            print(f"box {i},{j}: {'ok ' + str(len(d['elements'])) if d else 'FAILED'}", flush=True)
    # official building footprints with heights (paged)
    fp = os.path.join(OUT, "footprints.json")
    if not os.path.exists(fp):
        rows, off = [], 0
        while True:
            url = ("https://data.cityofnewyork.us/resource/5zhs-2jue.json?$limit=10000&$offset=%d&$select=base_bbl,height_roof,ground_elevation,construction_year,the_geom"
                   "&$where=%s&$order=base_bbl" % (off, urllib.parse.quote(f"within_box(the_geom,{S},{W},{N},{E})")))
            part = json.loads(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=120).read())
            rows += part; off += len(part)
            if len(part) < 10000: break
        json.dump(rows, open(fp, "w")); print("footprints", len(rows))
    print(f"done: {done}/{a.rows * a.cols} OSM boxes")
    return 0 if done == a.rows * a.cols else 1


if __name__ == "__main__":
    sys.exit(main())
