#!/usr/bin/env python3
"""Checks for tools/nyc/buildings.py: python3 tools/nyc/test_buildings.py  (or pytest). Uses the real derived data (Midtown tiles) when present."""
import json, math, os, sys, tempfile, unittest

import numpy as np
from shapely.geometry import Polygon, box

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import buildings as B
import tilelib as tl


def prism(poly, h, **kw):
    A = {"facade": B.Acc("facade"), "roof": B.Acc("roof")}
    B.build_building(A, poly, {"id": "t", "h": h, "year": kw.pop("year", 1925)}, 0, kw.pop("lm", None), kw.pop("detail", 2), kw.pop("far", False))
    return A


class Geometry(unittest.TestCase):
    def test_walls_face_outward(self):
        A = prism(B.orient(box(0, 0, 20, 12), 1.0), 30.0)
        m = A["facade"].mesh(True)
        centre = np.array([10.0, 6.0])
        tri = m.idx
        a, b, c = m.pos[tri[:, 0]], m.pos[tri[:, 1]], m.pos[tri[:, 2]]
        fn = np.cross(b - a, c - a)
        mid = (a + b + c) / 3
        out = (mid[:, :2] - centre) * fn[:, :2]
        self.assertTrue((out.sum(axis=1) > 0).all(), "a wall triangle faces the inside")
        # stored normals agree with the winding
        self.assertTrue((np.einsum("ij,ij->i", fn, m.normal[tri[:, 0]]) > 0).all())

    def test_uv_is_metres(self):
        A = prism(B.orient(box(0, 0, 20, 12), 1.0), 30.0)
        m = A["facade"].mesh(True)
        self.assertAlmostEqual(float(m.uv[:, 1].max()), 30.0, places=1)           # v = metres up
        self.assertAlmostEqual(float(m.uv[:, 0].max()), 64.0, delta=0.1)          # u = perimeter 2*(20+12)
        self.assertEqual(m.extra["BLD"].shape, (len(m.pos), 4))
        self.assertTrue(((m.color[:, 3] > 0) & (m.color[:, 3] <= 1)).all())

    def test_roof_is_up_and_flat_top_covers_footprint(self):
        poly = B.orient(box(0, 0, 20, 12), 1.0)
        A = prism(poly, 30.0, year=1990, detail=0)
        r = A["roof"].mesh(False)
        a, b, c = r.pos[r.idx[:, 0]], r.pos[r.idx[:, 1]], r.pos[r.idx[:, 2]]
        fn = np.cross(b - a, c - a)
        up = fn[:, 2] > 0
        area = (np.abs(fn[:, 2]) / 2)[up].sum()
        self.assertAlmostEqual(area, poly.area, delta=0.5)

    def test_setbacks_for_tall_old_tower(self):
        poly = B.orient(box(0, 0, 60, 40), 1.0)
        A = prism(poly, 200.0, year=1928)
        m = A["facade"].mesh(True)
        self.assertGreaterEqual(len(set(np.round(m.pos[:, 2], 1))), 4, "a 200 m pre-war tower has several tiers")
        # upper tiers are narrower than the base
        top = m.pos[m.pos[:, 2] > 150]
        self.assertLess(np.ptp(top[:, 0]), 60.0)

    def test_far_lod_small(self):
        A = prism(B.orient(box(0, 0, 20, 12), 1.0), 30.0, far=True)
        self.assertLessEqual(A["facade"].tris + A["roof"].tris, 12)
        self.assertEqual(prism(B.orient(box(0, 0, 3, 3), 1.0), 30.0, far=True)["facade"].tris, 0)   # tiny things are dropped in the far LOD

    def test_collider_l_shape_split(self):
        L = Polygon([(0, 0), (40, 0), (40, 10), (10, 10), (10, 40), (0, 40)])
        cols = B.colliders(B.orient(L, 1.0), 25.0)
        self.assertGreaterEqual(len(cols), 2)
        cover = sum(c["hx"] * c["hy"] * 4 for c in cols)
        self.assertLess(cover, L.area * 1.5)

    def test_clean_polygons_drops_slivers_and_fixes_bowties(self):
        self.assertEqual(B.clean_polygons(box(0, 0, 1.5, 1.5)), [])
        bow = Polygon([(0, 0), (10, 10), (10, 0), (0, 10)])
        out = B.clean_polygons(bow)
        self.assertTrue(all(p.is_valid and p.exterior.is_ccw for p in out))


@unittest.skipUnless(os.path.isdir(tl.DERIVED), "derived NYC data not available")
class RealTiles(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        B.init_world()

    def test_each_building_in_exactly_one_tile(self):
        seen = {}
        for (ix, iy), idxs in B._BUCKETS.items():
            for i in idxs:
                self.assertNotIn(i, seen)
                seen[i] = (ix, iy)
        for i, t in list(seen.items())[:2000]:
            c = B._W.geoms["buildings"][i].centroid
            self.assertEqual(t, tl.tile_of(c.x, c.y))

    def test_times_square_tile_outputs(self):
        with tempfile.TemporaryDirectory() as d:
            r = B.build_tile(0, 0, d, compress=False)
            self.assertLessEqual(r["tris"], B.TRI_BUDGET)
            for ext in ("bld.glb", "far.glb", "col.json"):
                self.assertTrue(os.path.getsize(os.path.join(d, f"0_0.{ext}")) > 100)
            col = json.load(open(os.path.join(d, "0_0.col.json")))
            self.assertEqual(col["ground"], 0)
            self.assertGreater(len(col["buildings"]), 10)
            for c in col["buildings"]:
                self.assertTrue(c["hx"] >= c["hy"] > 0 and c["z1"] > c["z0"] == 0)
                self.assertTrue(all(math.isfinite(v) for v in c.values()))
            self.assertLess(r["far_tris"], r["tris"])

    def test_empire_state_is_matched_with_its_real_height(self):
        ix, iy = tl.tile_of(-17, -1060)
        bl = B.tile_buildings(ix, iy)
        lms = B.match_landmarks([(k, p, float(it["h"]), it["id"], p.centroid.coords[0]) for k, (it, p, j) in enumerate(bl)])
        names = {v["name"]: k for k, v in lms.items()}
        self.assertIn("Empire State Building", names)
        self.assertAlmostEqual(float(bl[names["Empire State Building"]][0]["h"]), 377.6, places=1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
