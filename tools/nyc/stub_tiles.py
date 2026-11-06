"""Stub tile generator for testing the streaming runtime (web/src/scene/nyc/streamer.ts) before the real content stages exist.

Writes, for the Midtown test box (ix -3..4, iy -4..6), into web/public/assets/nyc/tiles/ (gitignored):
  {ix}_{iy}.ground.glb  sidewalk quad + road ribbons from the real OSM roads        (materials: sidewalk, road)
  {ix}_{iy}.bld.glb     real footprints extruded to the real height (walls: facade, roof)  with _BLD + COLOR_0 + UV in metres
  {ix}_{iy}.far.glb     the same buildings as oriented-box prisms (12 tris each)
  {ix}_{iy}.col.json    oriented boxes {buildings:[{cx,cy,z0,z1,hx,hy,yaw}], ground}
  index.json            tiles + bboxes + `spawn` (on 7th Avenue near Times Square, heading along the one-way direction)
This is NOT the real content (ground.py / buildings.py / props.py): same file contract (docs/nyc_tiles.md), crude geometry.
Usage: python3 tools/nyc/stub_tiles.py [--box x0 y0 x1 y1]
"""
import json, math, os, sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tilelib as T
from tilelib import Mesh, TILE


def cat(parts):
    """Concatenate (pos, idx, uv, color, bld) arrays lists into one Mesh arrays tuple."""
    pos, idx, uv, col, bld, n = [], [], [], [], [], 0
    for p, i, u, c, b in parts:
        pos.append(p); idx.append(i + n); uv.append(u); col.append(c); bld.append(b); n += len(p)
    return np.concatenate(pos), np.concatenate(idx), np.concatenate(uv), np.concatenate(col), np.concatenate(bld)


def quad(p0, p1, p2, p3, uv, color, bld=None):
    pos = np.array([p0, p1, p2, p3], dtype=np.float64)
    idx = np.array([[0, 1, 2], [0, 2, 3]])
    return pos, idx, np.array(uv, dtype=np.float64), np.tile(color, (4, 1)), np.zeros((4, 4)) if bld is None else np.tile(bld, (4, 1))


def ring_ccw(pts):
    a = 0.0
    for i in range(len(pts)):
        x0, y0 = pts[i]; x1, y1 = pts[(i + 1) % len(pts)]
        a += x0 * y1 - x1 * y0
    return pts if a > 0 else pts[::-1]


def prism(ring, h, bld, tint, with_roof=True):
    """Walls (facade) + roof (roof) of one footprint. ring: [(x,y)] game frame. Returns (walls_parts, roof_parts)."""
    ring = ring_ccw([tuple(p) for p in ring])
    if ring[0] == ring[-1]:
        ring = ring[:-1]
    walls, roof, along = [], [], 0.0
    for i in range(len(ring)):
        (x0, y0), (x1, y1) = ring[i], ring[(i + 1) % len(ring)]
        L = math.hypot(x1 - x0, y1 - y0)
        if L < 0.05:
            continue
        # CCW ring seen from above: outward normal is to the right of the edge direction -> winding (p0, p1, p1_top, p0_top)
        walls.append(quad((x0, y0, 0), (x1, y1, 0), (x1, y1, h), (x0, y0, h), [(along, 0), (along + L, 0), (along + L, h), (along, h)],
                          np.array([*tint, 0.85]), bld))
        along += L
    if with_roof:
        try:
            from shapely.geometry import Polygon
            from shapely import constrained_delaunay_triangles
            poly = Polygon(ring)
            if not poly.is_valid:
                poly = poly.buffer(0)
            tris = [np.array(g.exterior.coords)[:3] for g in constrained_delaunay_triangles(poly).geoms] if not poly.is_empty else []
        except Exception:
            tris = [np.array([ring[0], ring[i], ring[i + 1]]) for i in range(1, len(ring) - 1)]
        for t in tris:
            p = np.array([[t[0][0], t[0][1], h], [t[1][0], t[1][1], h], [t[2][0], t[2][1], h]])
            if np.cross(p[1] - p[0], p[2] - p[0])[2] < 0:
                p = p[[0, 2, 1]]
            roof.append((p, np.array([[0, 1, 2]]), p[:, :2].copy(), np.tile(np.array([*tint, 0.9]), (3, 1)), np.tile(bld, (3, 1))))
    return walls, roof


def road_ribbons(roads, bounds):
    x0, y0, x1, y1 = bounds
    parts = []
    for r, g in roads:
        if r.get("tunnel") or r.get("hw") in ("footway", "path", "steps", "cycleway", "pedestrian"):
            continue
        w = float(r.get("width") or 8)
        pts = np.array(r["pts"], dtype=np.float64)
        for a, b in zip(pts[:-1], pts[1:]):
            if max(a[0], b[0]) < x0 - 20 or min(a[0], b[0]) > x1 + 20 or max(a[1], b[1]) < y0 - 20 or min(a[1], b[1]) > y1 + 20:
                continue
            d = b - a; L = np.linalg.norm(d)
            if L < 0.1:
                continue
            n = np.array([-d[1], d[0]]) / L * w / 2
            q = [a + n, a - n, b - n, b + n]
            parts.append(quad(*[(p[0], p[1], 0.02) for p in q], [(p[0], p[1]) for p in q], np.array([0.7, 0.7, 0.7, 1.0])))
    return parts


def main():
    box = (-3, -4, 4, 6)
    if "--box" in sys.argv:
        k = sys.argv.index("--box"); box = tuple(int(v) for v in sys.argv[k + 1:k + 5])
    ix0, iy0, ix1, iy1 = box
    print("loading world...")
    world = T.World(layers=("buildings", "roads"))
    out = T.OUT_TILES
    os.makedirs(out, exist_ok=True)
    index = {"tile": 256, "origin_latlon": [40.7580, -73.9855], "stub": True, "tiles": {}}
    rng = np.random.default_rng(7)
    nb = 0
    for ix in range(ix0, ix1 + 1):
        for iy in range(iy0, iy1 + 1):
            b = T.tile_bounds(ix, iy)
            key = T.tile_name(ix, iy)
            roads = world.query("roads", b, 20)
            blds = [(d, g) for d, g in world.query("buildings", b) if b[0] <= g.representative_point().x < b[2] and b[1] <= g.representative_point().y < b[3]]
            # ground
            sidewalk = quad((b[0], b[1], 0), (b[2], b[1], 0), (b[2], b[3], 0), (b[0], b[3], 0), [(b[0], b[1]), (b[2], b[1]), (b[2], b[3]), (b[0], b[3])], np.array([0.55, 0.55, 0.55, 1.0]))
            gm = [Mesh("sidewalk", *[sidewalk[0], sidewalk[1]], uv=sidewalk[2], color=sidewalk[3])]
            rib = road_ribbons(roads, b)
            if rib:
                p, i, u, c, _ = cat(rib)
                gm.append(Mesh("road", p, i, uv=u, color=c))
            T.write_glb(os.path.join(out, f"{key}.ground.glb"), gm, (ix, iy))
            # buildings
            wall_parts, roof_parts, far_walls, far_roofs, cols = [], [], [], [], []
            zmax = 0.0
            for d, g in blds:
                h = max(4.0, float(d.get("h") or 10))
                zmax = max(zmax, h)
                year = d.get("year") or 1950
                seed = rng.random()
                kind = 2 if h > 60 else 1 if h > 25 else 0
                bld = np.array([seed, max(1, round(h / 3.6)), kind, min(1, max(0, (year - 1900) / 110))])
                tint = rng.uniform(0.35, 0.6, 3) * np.array([1.0, 0.95, 0.9])
                w, r = prism(d["rings"][0], h, bld, tint)
                wall_parts += w; roof_parts += r
                mrr = g.minimum_rotated_rectangle
                if mrr.geom_type == "Polygon":
                    c = list(mrr.exterior.coords)[:4]
                    e0 = np.array(c[1]) - np.array(c[0]); e1 = np.array(c[2]) - np.array(c[1])
                    cx, cy = mrr.centroid.x, mrr.centroid.y
                    yaw = math.atan2(e0[1], e0[0])
                    hx, hy = np.linalg.norm(e0) / 2, np.linalg.norm(e1) / 2
                    cols.append({"cx": round(cx, 2), "cy": round(cy, 2), "z0": 0, "z1": round(h, 2), "hx": round(float(hx), 2), "hy": round(float(hy), 2), "yaw": round(yaw, 4)})
                    fw, fr = prism(c, h, bld, tint)
                    far_walls += fw; far_roofs += fr
            nb += len(blds)
            files = [f"{key}.ground.glb", f"{key}.col.json"]
            if wall_parts:
                bm = []
                for name, parts in (("facade", wall_parts), ("roof", roof_parts)):
                    if parts:
                        p, i, u, c, e = cat(parts)
                        bm.append(Mesh(name, p, i, uv=u, color=c, extra={"BLD": e}))
                T.write_glb(os.path.join(out, f"{key}.bld.glb"), bm, (ix, iy))
                fm = []
                for name, parts in (("facade", far_walls), ("roof", far_roofs)):
                    if parts:
                        p, i, u, c, e = cat(parts)
                        fm.append(Mesh(name, p, i, uv=u, color=c, extra={"BLD": e}))
                T.write_glb(os.path.join(out, f"{key}.far.glb"), fm, (ix, iy))
                files += [f"{key}.bld.glb", f"{key}.far.glb"]
            with open(os.path.join(out, f"{key}.col.json"), "w") as f:
                json.dump({"ground": 0.0, "buildings": cols}, f, separators=(",", ":"))
            index["tiles"][key] = {"files": files, "bytes": {fn: os.path.getsize(os.path.join(out, fn)) for fn in files}, "bbox": [b[0], b[1], b[2], b[3], round(zmax, 1)]}
        print("column", ix, "done")
    # spawn: the 7th Avenue road point nearest Times Square, heading along the (one-way) digitised direction
    best = None
    for r in world.items["roads"]:
        if (r.get("name") or "") in ("7th Avenue", "Seventh Avenue"):
            pts = np.array(r["pts"])
            for a, c in zip(pts[:-1], pts[1:]):
                d = c - a; L2 = float(d @ d)
                if L2 < 1e-6:
                    continue
                t = min(1, max(0, float(-a @ d) / L2)); p = a + t * d; dist = float(np.hypot(*p))
                if best is None or dist < best[0]:
                    best = (dist, p, math.atan2(d[1], d[0]))
    if best:
        index["spawn"] = {"x": round(float(best[1][0]), 2), "y": round(float(best[1][1]), 2), "heading": round(best[2], 4)}
    with open(os.path.join(out, "index.json"), "w") as f:
        json.dump(index, f, separators=(",", ":"))
    print(f"{len(index['tiles'])} tiles, {nb} buildings, spawn {index.get('spawn')}")


if __name__ == "__main__":
    main()
