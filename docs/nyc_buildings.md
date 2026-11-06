# New York buildings (tools/nyc/buildings.py, web/src/scene/nyc/facade.ts)

Real NYC footprints (Open Data, public domain: official roof height `h` and construction year) extruded into tiles, with procedural, texture-free facades.
Contract and tile frame: docs/nyc_tiles.md. Everything here regenerates from `assets_source/downloads/nyc/derived/buildings.ndjson`.

## Pipeline
`python3 tools/nyc/buildings.py --box -3 4 -4 6` (Midtown test box), `--all` (every tile that owns a building), `--tiles=-1,-5;0,0`, `--no-compress`
(skip the meshopt step), `--test-streets` (also writes `_test_streets.json`, roads + lamps for the visual harness). Tiles are built in parallel
(one process per core). Output per tile in `web/public/assets/nyc/tiles/`: `{ix}_{iy}.bld.glb` (LOD0), `.far.glb` (LOD1), `.col.json`.
`python3 tools/nyc/test_buildings.py` runs the checks (winding, UV in metres, setbacks, far LOD, colliders, one-tile-per-building, Empire State match).

### Footprint cleaning
shapely `make_valid`, multi-part geometries become several buildings, `simplify(0.15 m)` (this also drops collinear points), courtyards smaller than 12 m2
are filled, pieces < 4 m2 dropped, outer ring CCW. Buildings < 2.5 m tall are skipped. Ground elevation `g` is ignored (ground is z = 0).
A building is emitted ONLY in the tile containing its footprint centroid (`tile_of(centroid)`), whole: the runtime must not draw it twice, and a tile's
mesh can reach beyond its 256 m square by the building extent (so cull tiles by the real bounding box of the glb, not the tile square).

### Kind and era (`_BLD = (seed, floors, kind, era)`)
`seed` = crc32(id) in [0,1); `era` = clamp((year-1900)/100, 0, 1) (year 0 / missing = 1930); `floors` = round(h / floor height of the kind).
kind (from h, footprint area, year, a per-building RNG): 0 walk-up (< 22 m, small), 1 mid-rise, 2 office (tall / postwar), 3 glass tower (>= 1985,
tall), 4 loft / industrial (big footprint, prewar or low), 5 landmark. Floor heights per kind: 3.4, 3.6, 4.0, 4.1, 4.2, 4.0 m (same table in facade.ts).

### Shape
- Towers (h >= 60 m and area >= 300 m2, or h >= 45 and area >= 800) get zoning setbacks: a street wall of 20-35 m (snapped to floors), then tiers from
  `buffer(-inset)` of the footprint (mitre joins, clamped to the footprint's inscribed radius): prewar 2-4 tiers (wedding cake), 1945-1990 street wall + plaza
  setback, modern 1-2 tiers; the ledge between tiers is a roof-material polygon. Mechanical penthouse + antenna on towers, bulkheads and AC boxes on every
  roof (more on bigger roofs), water tanks on stilts on old 14-70 m buildings (30 %), parapets on 55 % of flat roofs, a thin stone cornice (outset 22 cm,
  underside included) on pre-1942 low/mid-rises.
- Landmarks (matched to the real footprint by bbl or to the tallest footprint near a point, `LANDMARKS`): Empire State Building (setbacks as fractions of
  the real 377.6 m + 65 m mast), Chrysler (stepped crown + 40 m spire), One WTC (spire), 30 Rockefeller, Flatiron (the real wedge), Grand Central, Penn
  Station / MSG: kind 5, hand-picked tint. Exact crowns/arches are not modelled.
- Walls (`facade`): one quad row per tier, UV = (cumulative metres along the ring, metres up from the ground), COLOR_0 = tint (palette per kind), alpha =
  AO (upper tiers start at 0.9; ground contact AO is done in the shader from the height). UVs are rounded to 6 cm: it halves the meshopt size.
- Roofs / trims (`roof`): COLOR_0 tint, alpha = AO, UV in metres.
- Colliders (`col.json`): minimum rotated rectangle per building (z 0..h, `yaw` of the long axis); L/U shaped footprints are cut along the long axis
  and recursed (<= 8 boxes) while the box covers < 80 % of the footprint; buildings < 70 m2 that touch are merged first.
- far.glb: prisms (footprint simplified at 1.8 m, courtyards removed, flat roof); towers keep their tiers; sheds < 30 m2 or < 7 m are dropped.
- If a tile exceeds 60k triangles, props are dropped in two steps (detail 2 -> 1 -> 0).

## Facade shader (facade.ts)
`createFacadeMaterial()` / `createRoofMaterial()`: `MeshStandardNodeMaterial` (so headlights and the clustered street lamps light them) with TSL node
graphs for colour, emissive and roughness; no textures, no branches (only `select`), derivative-filtered:
- floors from the metre UV and the kind table, bays and windows per kind/era (walk-up: narrow tall windows with sash rail, stone sills and lintels in brick;
  mid-rise: wider punched windows with muntin; prewar office: punched stone; postwar office: ribbon glass with mullions; glass tower: full-height glass
  panels over dark spandrels; loft: large multi-pane windows; landmark: narrow punched), floor slab lines on offices;
- storefront band (lower 4.6 m): piers, bright or shuttered shop windows, signage strip with coloured letter-like stripes, bulkhead;
- brick courses (running bond, per-brick noise) or stone joints depending on the tint, large-scale blotches, grime streaks under windows, soot near the ground;
- night: per window hash (seed, bay, floor): 25-45 % lit (offices less, plus ~10 % of floors fully lit), warm tungsten / white / cool / TV-blue light,
  brightness, curtains; emissive values reach ~2.4 so they feed the bloom (threshold 1.0). `facadeUniforms.night` (0 day .. 1 night) is a plain uniform;
- fake glass reflection (view dependent, lit-city colour) on windows, strong on glass towers;
- distance: `fwidth(uv)` fades windows, bricks and storefronts to their average colour when one pixel covers a large part of a period, so the same material
  serves far.glb without shimmer.
`createRoofMaterial()`: tar speckle on up faces, panel/louvre bands on vertical faces, vertex tint.

## Numbers
(see the end of this file, filled from measurements)
