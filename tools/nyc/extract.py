#!/usr/bin/env python3
"""Stage 1: raw data -> one clean, metric, game-frame dataset in assets_source/downloads/nyc/derived/ (gitignored, re-creatable).

Inputs  (tools/nyc/fetch_footprints.py and the BBBike OSM extract, see docs/nyc_tiles.md):
  assets_source/downloads/nyc/NewYork.osm.pbf              OpenStreetMap (ODbL), cut to the Manhattan bbox here
  assets_source/downloads/nyc/footprints_manhattan.json    NYC Open Data building footprints (public domain): roof height (ft), year, code
Outputs (NDJSON, one JSON object per line; coordinates in METRES in the game frame: origin Times Square, x east, y north, z up):
  buildings.ndjson  {id, h (roof height m, above ground), g (ground elevation m), year, code, rings: [[ [x,y],... ] outer first, then holes]}
  roads.ndjson      {id, hw (highway type), name, lanes, oneway, bridge, tunnel, layer, width (m, from tags or by type), pts}
  areas.ndjson      {id, kind (park|water|plaza|pedestrian|cemetery|pitch|parking|grass|island), name, rings}
  rails.ndjson      {id, kind (subway|rail|tram), tunnel, bridge, pts}
  nodes.ndjson      {kind (tree|signal|crossing|hydrant|bench|lamp|bus_stop|subway_entrance|bike|artwork|fountain|stop|waste), x, y, tags}
  meta.json         origin, bbox, counts
"""
import json, math, os, sys, time

import osmium
from pyproj import Transformer

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
D = os.path.join(ROOT, "assets_source/downloads/nyc")
OUT = os.path.join(D, "derived")
ORIGIN = (40.7580, -73.9855)   # Times Square (lat, lon)
BBOX = (40.6990, -74.0250, 40.8830, -73.9050)   # S W N E: Manhattan island with a little river around it
FT = 0.3048
TR = Transformer.from_crs("EPSG:4326", f"+proj=tmerc +lat_0={ORIGIN[0]} +lon_0={ORIGIN[1]} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m", always_xy=True)


def xy(lons, lats):
    X, Y = TR.transform(list(lons), list(lats))
    return [[round(a, 2), round(b, 2)] for a, b in zip(X, Y)]


def inside(lat, lon):
    return BBOX[0] <= lat <= BBOX[2] and BBOX[1] <= lon <= BBOX[3]


# default full road widths (m, kerb to kerb) by OSM highway type when no width/lanes tag: Manhattan avenues ~ 30 m, streets ~ 18 m
HW_WIDTH = {"motorway": 22, "motorway_link": 9, "trunk": 20, "trunk_link": 9, "primary": 24, "primary_link": 9, "secondary": 18, "secondary_link": 8,
            "tertiary": 14, "tertiary_link": 7, "residential": 12, "unclassified": 12, "living_street": 8, "service": 6, "pedestrian": 8, "footway": 2.5,
            "cycleway": 2.5, "path": 2, "steps": 2, "track": 4, "road": 12}
ROAD_KEEP = set(HW_WIDTH) - {"steps"}
AREA_KIND = [("leisure", {"park": "park", "garden": "park", "playground": "park", "pitch": "pitch", "recreation_ground": "park", "dog_park": "park", "common": "park"}),
             ("landuse", {"grass": "grass", "recreation_ground": "park", "cemetery": "cemetery", "village_green": "park"}),
             ("natural", {"water": "water", "wetland": "water", "grassland": "grass", "wood": "park"}),
             ("amenity", {"parking": "parking", "fountain": "fountain"}),
             ("place", {"square": "plaza"}), ("highway", {"pedestrian": "pedestrian", "footway": "pedestrian"}),
             ("man_made", {"pier": "pier"}), ("waterway", {"riverbank": "water", "dock": "water"})]
NODE_KIND = [("natural", {"tree": "tree"}), ("highway", {"traffic_signals": "signal", "crossing": "crossing", "street_lamp": "lamp", "bus_stop": "bus_stop", "stop": "stop"}),
             ("emergency", {"fire_hydrant": "hydrant"}), ("amenity", {"bench": "bench", "bicycle_parking": "bike", "waste_basket": "waste", "fountain": "fountain"}),
             ("railway", {"subway_entrance": "subway_entrance"}), ("tourism", {"artwork": "artwork"}), ("leisure", {"picnic_table": "bench"})]


class Handler(osmium.SimpleHandler):
    def __init__(self, files):
        super().__init__()
        self.f = files
        self.n = {k: 0 for k in ("roads", "areas", "rails", "nodes")}

    def node(self, n):
        if not n.tags or not n.location.valid() or not inside(n.location.lat, n.location.lon):
            return
        t = n.tags
        for key, m in NODE_KIND:
            v = t.get(key)
            if v in m:
                x, y = xy([n.location.lon], [n.location.lat])[0]
                self.f["nodes"].write(json.dumps({"kind": m[v], "x": x, "y": y, "tags": {k: t[k] for k in ("direction", "name", "genus", "height") if k in t}}) + "\n")
                self.n["nodes"] += 1
                return

    def way(self, w):
        t = w.tags
        if not t or len(w.nodes) < 2:
            return
        hw, rw = t.get("highway"), t.get("railway")
        if not (hw in ROAD_KEEP or rw in ("subway", "rail", "tram", "light_rail")):
            return
        try:
            pts = [(n.lon, n.lat) for n in w.nodes if n.location.valid()]
        except osmium.InvalidLocationError:
            return
        if len(pts) < 2 or not inside(pts[len(pts) // 2][1], pts[len(pts) // 2][0]):
            return
        P = xy([p[0] for p in pts], [p[1] for p in pts])
        tunnel, bridge = t.get("tunnel") in ("yes", "building_passage", "culvert") , t.get("bridge") in ("yes", "viaduct", "movable")
        if hw:
            if t.get("area") == "yes" and hw in ("pedestrian", "footway") and P[0] == P[-1]:
                return   # closed pedestrian areas come through the area handler
            lanes = int(t["lanes"]) if t.get("lanes", "").isdigit() else None
            try:
                width = float(t["width"].split()[0]) if "width" in t else None
            except ValueError:
                width = None
            if width is None:
                width = HW_WIDTH[hw] if lanes is None or hw in ("footway", "cycleway", "path", "pedestrian") else max(HW_WIDTH[hw] * 0.55, lanes * 3.4 + (3 if t.get("parking:lane:both") or t.get("parking:lane:right") else 0))
            self.f["roads"].write(json.dumps({"id": w.id, "hw": hw, "name": t.get("name", ""), "lanes": lanes, "oneway": t.get("oneway") in ("yes", "1", "true"),
                                              "bridge": bridge, "tunnel": tunnel, "layer": int(t["layer"]) if t.get("layer", "").lstrip("-").isdigit() else 0,
                                              "sidewalk": t.get("sidewalk", ""), "width": round(width, 1), "pts": P}) + "\n")
            self.n["roads"] += 1
        else:
            self.f["rails"].write(json.dumps({"id": w.id, "kind": "subway" if rw == "subway" else rw, "tunnel": tunnel or rw == "subway", "bridge": bridge, "pts": P}) + "\n")
            self.n["rails"] += 1

    def area(self, a):
        t = a.tags
        kind = None
        for key, m in AREA_KIND:
            v = t.get(key)
            if v in m:
                if key == "highway" and t.get("area") != "yes":
                    continue
                kind = m[v]
                break
        if not kind:
            return
        try:
            rings = []
            for o in a.outer_rings():
                oc = [(n.lon, n.lat) for n in o]
                if not inside(oc[len(oc) // 2][1], oc[len(oc) // 2][0]):
                    continue
                r = [xy([p[0] for p in oc], [p[1] for p in oc])]
                for i in a.inner_rings(o):
                    ic = [(n.lon, n.lat) for n in i]
                    r.append(xy([p[0] for p in ic], [p[1] for p in ic]))
                rings.append(r)
        except (osmium.InvalidLocationError, RuntimeError):
            return
        for r in rings:
            self.f["areas"].write(json.dumps({"id": a.orig_id(), "kind": kind, "name": t.get("name", ""), "rings": r}) + "\n")
            self.n["areas"] += 1


def footprints():
    rows = json.load(open(os.path.join(D, "footprints_manhattan.json")))
    n = 0
    with open(os.path.join(OUT, "buildings.ndjson"), "w") as f:
        for r in rows:
            g = r.get("the_geom")
            if not g or not r.get("height_roof"):
                continue
            polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]] if g["type"] == "Polygon" else []
            h = float(r["height_roof"]) * FT
            ge = float(r.get("ground_elevation") or 0) * FT
            for pi, poly in enumerate(polys):
                rings = [xy([p[0] for p in ring], [p[1] for p in ring]) for ring in poly]
                f.write(json.dumps({"id": f"{r['base_bbl']}_{pi}", "h": round(h, 1), "g": round(ge, 1), "year": int(r["construction_year"]) if r.get("construction_year", "").isdigit() else 0,
                                    "code": r.get("feature_code", ""), "rings": rings}) + "\n")
                n += 1
    return n


def main():
    os.makedirs(OUT, exist_ok=True)
    t0 = time.time()
    nb = footprints()
    print(f"buildings: {nb} ({time.time() - t0:.0f}s)", flush=True)
    files = {k: open(os.path.join(OUT, f"{k}.ndjson"), "w") for k in ("roads", "areas", "rails", "nodes")}
    h = Handler(files)
    h.apply_file(os.path.join(D, "NewYork.osm.pbf"), locations=True, idx="flex_mem")
    for f in files.values():
        f.close()
    meta = {"origin_latlon": ORIGIN, "bbox_latlon": BBOX, "frame": "metres, x east, y north, z up, origin Times Square", "buildings": nb, **h.n}
    json.dump(meta, open(os.path.join(OUT, "meta.json"), "w"), indent=1)
    print(meta, f"{time.time() - t0:.0f}s")


if __name__ == "__main__":
    sys.exit(main())
