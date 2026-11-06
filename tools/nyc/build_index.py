#!/usr/bin/env python3
"""Build web/public/assets/nyc/tiles/index.json and web/public/data/tracks/nyc_route.json from the generated tiles."""
import glob
import json
import math
import os
from collections import defaultdict

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
TILES_DIR = os.path.join(ROOT, "web", "public", "assets", "nyc", "tiles")
ROUTE_OUT = os.path.join(ROOT, "web", "public", "data", "tracks", "nyc_route.json")
TILE = 256.0


def build_index():
    tiles = {}
    keys = set()
    for p in glob.glob(os.path.join(TILES_DIR, "*.*")):
        bn = os.path.basename(p)
        if bn == "index.json" or bn.startswith("_"):
            continue
        k = bn.split(".")[0]
        if "_" in k:
            try:
                ix, iy = map(int, k.split("_"))
                keys.add((ix, iy, k))
            except ValueError:
                pass

    total_blds = 0
    for ix, iy, k in sorted(keys):
        x0, y0, x1, y1 = ix * TILE, iy * TILE, (ix + 1) * TILE, (iy + 1) * TILE
        zmax = 30.0
        files = []
        bytes_map = {}
        for ext in ("ground.glb", "bld.glb", "far.glb", "col.json", "props.json", "graph.json"):
            fn = f"{k}.{ext}"
            fp = os.path.join(TILES_DIR, fn)
            if os.path.exists(fp):
                files.append(fn)
                bytes_map[fn] = os.path.getsize(fp)
        col_p = os.path.join(TILES_DIR, f"{k}.col.json")
        if os.path.exists(col_p):
            try:
                with open(col_p) as f:
                    cd = json.load(f)
                blds = cd.get("buildings", [])
                total_blds += len(blds)
                for b in blds:
                    r = math.hypot(b.get("hx", 0), b.get("hy", 0))
                    cx, cy = b.get("cx", 0), b.get("cy", 0)
                    x0 = min(x0, cx - r)
                    y0 = min(y0, cy - r)
                    x1 = max(x1, cx + r)
                    y1 = max(y1, cy + r)
                    zmax = max(zmax, float(b.get("z1", 0)))
            except Exception:
                pass
        if not files:
            continue
        tiles[k] = {
            "files": files,
            "bytes": bytes_map,
            "bbox": [round(x0, 1), round(y0, 1), round(x1, 1), round(y1, 1), round(zmax, 1)],
        }

    # Find best spawn on 7th Avenue looking south-southwest straight through the Times Square bowtie (tile 0_0)
    spawn = {"x": 86.4, "y": 156.2, "heading": -2.083}
    g0_path = os.path.join(TILES_DIR, "0_0.graph.json")
    if os.path.exists(g0_path):
        with open(g0_path) as f:
            g0 = json.load(f)
        best = None
        for e in g0.get("edges", []):
            name = (e.get("name") or "").lower()
            pts = e.get("pts") or [g0["nodes"][e["a"]], g0["nodes"][e["b"]]]
            for i in range(len(pts) - 1):
                ax, ay = pts[i]
                bx, by = pts[i + 1]
                dx, dy = bx - ax, by - ay
                L = math.hypot(dx, dy)
                if L < 5.0:
                    continue
                mx, my = 0.5 * (ax + bx), 0.5 * (ay + by)
                # Ensure heading points south-southwest down the avenue toward Times Square (0, 0)
                if dy > 0:
                    dx, dy = -dx, -dy
                hdg = math.atan2(dy, dx)
                dist = math.hypot(mx - 88.0, my - 158.0)
                bonus = -120.0 if ("7th" in name or "seventh" in name) else (-60.0 if "broadway" in name else 0.0)
                score = dist + bonus
                if best is None or score < best[0]:
                    best = (score, mx, my, hdg)
        if best:
            spawn = {"x": round(best[1], 2), "y": round(best[2], 2), "heading": round(best[3], 4)}

    index = {
        "tile": 256,
        "origin_latlon": [40.7580, -73.9855],
        "spawn": spawn,
        "tiles": tiles,
    }
    out_p = os.path.join(TILES_DIR, "index.json")
    with open(out_p, "w") as f:
        json.dump(index, f, separators=(",", ":"))
    print(f"Wrote {out_p}: {len(tiles)} tiles, {total_blds} building colliders, spawn={spawn}")
    return spawn


def build_route(spawn):
    """Build a closed Midtown Manhattan street-circuit route along real road graph edges."""
    # Collect all graph edges across the Midtown tiles
    adj = defaultdict(list)
    node_xy = {}
    for gp in glob.glob(os.path.join(TILES_DIR, "*.graph.json")):
        with open(gp) as f:
            g = json.load(f)
        nodes = g.get("nodes", [])
        gids = g.get("gid", list(range(len(nodes))))
        for gid, xy in zip(gids, nodes):
            node_xy[gid] = (float(xy[0]), float(xy[1]))
        for e in g.get("edges", []):
            u = gids[e["a"]]
            v = gids[e["b"]]
            pts = e.get("pts") or [nodes[e["a"]], nodes[e["b"]]]
            w = float(e.get("w", 14.0))
            length = float(e.get("len", math.hypot(pts[-1][0] - pts[0][0], pts[-1][1] - pts[0][1])))
            adj[u].append((v, pts, w, length))
            adj[v].append((u, list(reversed(pts)), w, length))

    def nearest_node(tx, ty):
        return min(node_xy.keys(), key=lambda k: math.hypot(node_xy[k][0] - tx, node_xy[k][1] - ty))

    def dijkstra(start, goal):
        import heapq
        pq = [(0.0, start, [])]
        seen = {}
        while pq:
            cost, u, path = heapq.heappop(pq)
            if u == goal:
                return path
            if u in seen and seen[u] <= cost:
                continue
            seen[u] = cost
            ux, uy = node_xy[u]
            for v, pts, w, length in adj[u]:
                # Strongly prefer wide avenues & cross streets
                w_pen = 1.0 if w >= 18 else (1.25 if w >= 13 else 2.2)
                nc = cost + length * w_pen
                if v not in seen or nc < seen[v]:
                    heapq.heappush(pq, (nc, v, path + [(u, v, pts)]))
        return []

    # Iconic Midtown loop waypoints (game frame metres around Times Square (0,0)):
    # 1. Start at Times Square (spawn)
    # 2. Down 7th Ave to W 34th St (-350, -680)
    # 3. East across W 34th St past Empire State Building to 5th Ave (260, -960)
    # 4. North up 5th Ave past Bryant Park & Rockefeller Center to W 49th St (720, -110)
    # 5. West across W 49th St back to 7th Ave / Times Square (180, 260)
    waypoints = [
        (spawn["x"], spawn["y"]),
        (-310.0, -620.0),
        (220.0, -900.0),
        (640.0, -140.0),
        (160.0, 240.0),
    ]
    wp_nodes = [nearest_node(x, y) for x, y in waypoints]
    raw_pts = []
    for i in range(len(wp_nodes)):
        u = wp_nodes[i]
        v = wp_nodes[(i + 1) % len(wp_nodes)]
        seg = dijkstra(u, v)
        for _, _, pts in seg:
            for p in pts[:-1]:
                if not raw_pts or math.hypot(p[0] - raw_pts[-1][0], p[1] - raw_pts[-1][1]) > 0.5:
                    raw_pts.append((float(p[0]), float(p[1])))

    if len(raw_pts) < 8:
        # Fallback clean avenue rectangle if graph disconnected
        raw_pts = waypoints

    # Resample closed loop every ~8 metres with smooth headings
    closed = raw_pts + [raw_pts[0]]
    cum = [0.0]
    for i in range(len(raw_pts)):
        dx = closed[i + 1][0] - closed[i][0]
        dy = closed[i + 1][1] - closed[i][1]
        cum.append(cum[-1] + math.hypot(dx, dy))
    total_len = cum[-1]
    step = 8.0
    n_samples = max(32, int(round(total_len / step)))
    samples = []
    idx = 0
    for k in range(n_samples):
        s = (k * total_len) / n_samples
        while idx + 1 < len(cum) - 1 and cum[idx + 1] < s:
            idx += 1
        seg_len = max(1e-6, cum[idx + 1] - cum[idx])
        t = (s - cum[idx]) / seg_len
        x = closed[idx][0] + t * (closed[idx + 1][0] - closed[idx][0])
        y = closed[idx][1] + t * (closed[idx + 1][1] - closed[idx][1])
        samples.append({
            "x": round(x, 2),
            "y": round(y, 2),
            "z": 0.0,
            "heading": 0.0,
            "curvature": 0.0,
            "width_left": 9.0,
            "width_right": 9.0,
        })

    for k in range(n_samples):
        nxt = samples[(k + 1) % n_samples]
        prv = samples[(k - 1) % n_samples]
        samples[k]["heading"] = round(math.atan2(nxt["y"] - prv["y"], nxt["x"] - prv["x"]), 4)

    route = {
        "schema": "route/1",
        "name": "Midtown Manhattan Circuit",
        "closed": True,
        "units": "SI (m, rad); Z-up right-handed",
        "length_m": round(total_len, 2),
        "samples": samples,
    }
    os.makedirs(os.path.dirname(ROUTE_OUT), exist_ok=True)
    with open(ROUTE_OUT, "w") as f:
        json.dump(route, f, separators=(",", ":"))
    print(f"Wrote {ROUTE_OUT}: length={total_len:.1f} m, {len(samples)} samples")


if __name__ == "__main__":
    sp = build_index()
    build_route(sp)
