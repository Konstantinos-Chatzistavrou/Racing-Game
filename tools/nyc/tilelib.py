"""Shared tile library for the New York build (see docs/nyc_tiles.md). Used by ground.py, buildings.py, props.py and build_tiles.py.

Frame: metres, x east, y north, z up, origin Times Square (extract.py). Tile grid 256 m: tile (ix, iy) covers [ix*256, (ix+1)*256) x [iy*256, ...).
glTF is Y-up: a game-frame point (x, y, z) is written as (x, z, -y) (the same mapping the game uses: three.js position = (x, z, -y)), relative to the
tile origin (ix*256, iy*256) so float32/quantised positions stay precise anywhere on the island.
"""
import json, math, os, struct
from dataclasses import dataclass, field

import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
D = os.environ.get("NYC_DATA") or os.path.join(ROOT, "assets_source/downloads/nyc")
if not os.path.isdir(os.path.join(D, "derived")):   # git worktrees do not have the (gitignored) data: use the main checkout's
    D = "/home/user/Downloads/Racing Game/assets_source/downloads/nyc"
DERIVED = os.path.join(D, "derived")
OUT_TILES = os.path.join(ROOT, "web/public/assets/nyc/tiles")
TILE = 256.0


def tile_of(x, y):
    return int(math.floor(x / TILE)), int(math.floor(y / TILE))


def tile_bounds(ix, iy):
    return ix * TILE, iy * TILE, (ix + 1) * TILE, (iy + 1) * TILE


def tile_name(ix, iy):
    return f"{ix}_{iy}"


def read_ndjson(name):
    with open(os.path.join(DERIVED, name)) as f:
        for line in f:
            yield json.loads(line)


def manhattan_polygon(buffer_m=60.0):
    """Shapely polygon of Manhattan (+ buffer) in the game frame (derived/manhattan_mask.json, from mask.py)."""
    from shapely.geometry import Polygon
    from shapely.ops import unary_union
    mask = json.load(open(os.path.join(DERIVED, "manhattan_mask.json")))
    return unary_union([Polygon(p[0], p[1:]) for p in mask]).buffer(buffer_m)


class World:
    """All derived data inside the Manhattan mask, with a spatial index per layer. Query by tile: world.buildings_in(bounds, margin)."""

    def __init__(self, layers=("buildings", "roads", "areas", "nodes", "rails")):
        from shapely.geometry import LineString, Point, Polygon
        from shapely.prepared import prep
        from shapely.strtree import STRtree
        self.mask = manhattan_polygon()
        pm = prep(self.mask)
        self.items = {}
        self.geoms = {}
        self.trees = {}

        def polygon(rings):
            p = Polygon(rings[0], rings[1:])
            return p if p.is_valid else p.buffer(0)

        for layer in layers:
            items, geoms = [], []
            for d in read_ndjson(layer + ".ndjson"):
                if layer == "buildings" or layer == "areas":
                    g = polygon(d["rings"])
                    if g.is_empty:
                        continue
                    c = g.representative_point()
                elif layer == "nodes":
                    g = Point(d["x"], d["y"]); c = g
                else:
                    g = LineString(d["pts"]); c = g.interpolate(0.5, normalized=True)
                if not pm.contains(c):
                    continue
                items.append(d); geoms.append(g)
            self.items[layer], self.geoms[layer] = items, geoms
            self.trees[layer] = STRtree(geoms)

    def query(self, layer, bounds, margin=0.0):
        """[(item, shapely_geom)] whose bbox touches the tile bounds expanded by margin metres."""
        from shapely.geometry import box
        x0, y0, x1, y1 = bounds
        idx = self.trees[layer].query(box(x0 - margin, y0 - margin, x1 + margin, y1 + margin))
        return [(self.items[layer][i], self.geoms[layer][i]) for i in idx]

    def tiles_with_content(self):
        """Set of (ix, iy) that contain any building centroid, road or area (what build_tiles generates)."""
        t = set()
        for layer in ("buildings", "areas"):
            for g in self.geoms[layer]:
                x0, y0, x1, y1 = g.bounds
                for ix in range(int(math.floor(x0 / TILE)), int(math.floor(x1 / TILE)) + 1):
                    for iy in range(int(math.floor(y0 / TILE)), int(math.floor(y1 / TILE)) + 1):
                        t.add((ix, iy))
        for g in self.geoms["roads"]:
            if g is None:
                continue
            x0, y0, x1, y1 = g.bounds
            for ix in range(int(math.floor(x0 / TILE)), int(math.floor(x1 / TILE)) + 1):
                for iy in range(int(math.floor(y0 / TILE)), int(math.floor(y1 / TILE)) + 1):
                    t.add((ix, iy))
        return t


@dataclass
class Mesh:
    """One draw primitive. Arrays are in the GAME frame (z up), world metres; write_glb converts and makes them tile-local."""
    material: str
    pos: np.ndarray                      # (N,3) float
    idx: np.ndarray                      # (M,3) int triangles (CCW seen from outside)
    normal: np.ndarray | None = None     # (N,3) float; computed from triangles when None
    uv: np.ndarray | None = None         # (N,2) float
    color: np.ndarray | None = None      # (N,4) float 0..1 (vertex colour: baked AO, tint, ...)
    extra: dict = field(default_factory=dict)   # custom attributes, name -> (N,k) float32, written as _NAME (e.g. "BLD")


def compute_normals(pos, idx):
    n = np.zeros_like(pos, dtype=np.float64)
    a, b, c = pos[idx[:, 0]], pos[idx[:, 1]], pos[idx[:, 2]]
    fn = np.cross(b - a, c - a)
    for k in range(3):
        np.add.at(n, idx[:, k], fn)
    ln = np.linalg.norm(n, axis=1, keepdims=True)
    ln[ln == 0] = 1
    return (n / ln).astype(np.float32)


def _pad4(b):
    return b + b"\x00" * (-len(b) % 4)


def write_glb(path, meshes, tile, name="tile"):
    """Minimal GLB: one node at the tile origin, one mesh, one primitive per Mesh (material by NAME: the game maps names to its materials)."""
    ox, oy = tile[0] * TILE, tile[1] * TILE
    bin_chunks, views, accs, prims, mats, matidx = [], [], [], [], [], {}
    off = 0

    def add(arr, target, ctype, ncomp, norm=False, minmax=False):
        nonlocal off
        raw = _pad4(np.ascontiguousarray(arr).tobytes())
        views.append({"buffer": 0, "byteOffset": off, "byteLength": arr.nbytes, **({"target": target} if target else {})})
        bin_chunks.append(raw); off += len(raw)
        acc = {"bufferView": len(views) - 1, "componentType": ctype, "count": int(arr.shape[0]), "type": {1: "SCALAR", 2: "VEC2", 3: "VEC3", 4: "VEC4"}[ncomp]}
        if norm:
            acc["normalized"] = True
        if minmax:
            acc["min"] = [float(v) for v in arr.min(axis=0)]; acc["max"] = [float(v) for v in arr.max(axis=0)]
        accs.append(acc)
        return len(accs) - 1

    for m in meshes:
        if len(m.idx) == 0:
            continue
        p = np.asarray(m.pos, dtype=np.float64)
        g = np.stack([p[:, 0] - ox, p[:, 2], -(p[:, 1] - oy)], axis=1).astype(np.float32)   # game (x,y,z) -> glTF (x, z, -y), tile-local
        nrm = m.normal if m.normal is not None else compute_normals(np.asarray(m.pos, dtype=np.float64), m.idx)
        nrm = np.stack([nrm[:, 0], nrm[:, 2], -nrm[:, 1]], axis=1).astype(np.float32)
        idx = np.asarray(m.idx, dtype=np.uint32).reshape(-1)
        # the (x,y,z)->(x,z,-y) mapping is a proper rotation (det +1): triangle winding is preserved
        attrs = {"POSITION": add(g, 34962, 5126, 3, minmax=True), "NORMAL": add(nrm, 34962, 5126, 3)}
        if m.uv is not None:
            attrs["TEXCOORD_0"] = add(np.asarray(m.uv, dtype=np.float32), 34962, 5126, 2)
        if m.color is not None:
            attrs["COLOR_0"] = add((np.clip(m.color, 0, 1) * 255 + 0.5).astype(np.uint8), 34962, 5121, 4, norm=True)
        for k, v in m.extra.items():
            v = np.asarray(v, dtype=np.float32)
            attrs["_" + k.upper()] = add(v, 34962, 5126, v.shape[1])
        # indices accessor (SCALAR): built by hand because add() assumes 2-D arrays
        raw = _pad4(idx.tobytes())
        views.append({"buffer": 0, "byteOffset": off, "byteLength": idx.nbytes, "target": 34963}); bin_chunks.append(raw); off += len(raw)
        accs.append({"bufferView": len(views) - 1, "componentType": 5125, "count": int(idx.size), "type": "SCALAR"})
        if m.material not in matidx:
            matidx[m.material] = len(mats); mats.append({"name": m.material})
        prims.append({"attributes": attrs, "indices": len(accs) - 1, "material": matidx[m.material]})
    gltf = {"asset": {"version": "2.0", "generator": "NightRun tools/nyc/tilelib.py", "extras": {"tile": list(tile), "origin_m": [ox, oy]}},
            "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"name": name, "mesh": 0, "translation": [ox, 0.0, -oy]}],
            "meshes": [{"name": name, "primitives": prims}], "materials": mats, "accessors": accs, "bufferViews": views, "buffers": [{"byteLength": off}]}
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    bn = b"".join(bin_chunks)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(js) + 8 + len(bn)))
        f.write(struct.pack("<II", len(js), 0x4E4F534A)); f.write(js)
        f.write(struct.pack("<II", len(bn), 0x004E4942)); f.write(bn)
    return os.path.getsize(path)
