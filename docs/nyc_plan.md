# New York (Midtown) — real-scale city plan

Goal (user, 2026-10-23): replace the narrow-streets night city with a real-scale (1:1) Midtown Manhattan built from real data: avenues, plazas
(Columbus Circle, Times Square), Broadway's diagonal, Bryant Park / Central Park South, skyscrapers; high fidelity, locked 30 fps on the
i3 laptop (45 fps target on the phone).

## Honest scope
- 1:1 means real street layout, widths, block sizes and building footprints/heights, from OpenStreetMap (ODbL, attribution in CREDITS.md) and
  NYC Open Data building footprints (public domain, official roof heights). Area: Columbus Circle .. Bryant Park, ~2.4 x 2.1 km (~5 km2).
- NOT a photogrammetry scan: facades are procedural (window grids, materials, setbacks, rooftop equipment) from the real height/year/type;
  landmarks (Columbus Circle, Times Square, Bryant Park, the Library, a few towers) get hand-built detail. All of Manhattan is out of reach for a
  browser at 30 fps in one go; the pipeline is tile-based so more districts can be added later.
- No Blender MCP in this environment; Blender 5.2 runs headless from the repo (tools/blender) and is used where it helps (landmarks, baking).

## Pipeline (tools/nyc/)
1. fetch_data.py: OSM in small cached boxes (public Overpass instances 502 on big queries) + NYC footprints -> assets_source/downloads/nyc/ (gitignored).
2. build_city.py (next): local metric frame (origin Times Square, x east, y north, z up); road network from OSM centrelines with real widths
   (avenues ~30 m, streets ~18 m, lanes, sidewalks, curbs, crosswalks at intersections, plaza polygons); buildings = footprints extruded to the
   official height with setbacks for towers; parks, water, trees, signals; 250 m tiles -> web/public/assets/nyc/tiles/*.glb (meshopt, quantised) + index.json.
3. Facades: ONE procedural TSL material (window grid, per-building seed/colour/era from vertex attributes, random lit windows at night) instead of
   textures: ~0 texture memory, one draw per tile, scales to thousands of buildings. Landmarks/signage (Times Square screens) as emissive instanced quads.
4. Game: tile streaming by camera distance with LOD (near: roof details + street furniture; far: simple extrusions; skyline: low-poly silhouettes),
   per-tile frustum culling, instanced props (lamps, hydrants, benches, trees, taxis), colliders only near the player (extruded footprint boxes),
   new route/laps along Broadway, 7th/8th Ave, Columbus Circle, Central Park South; AI traffic (yellow cabs) on the road graph.
5. Budget: measured with the built-in benchmark (bench.ts) after every step; 30 fps locked on the laptop, preset ladder unchanged.

## Phases
P1 data + projection + stats (this commit) -> P2 roads/sidewalks/intersections + extruded buildings with the facade shader, one tile in the game ->
P3 streaming + LOD + colliders over the whole district -> P4 parks/trees/props/signals/traffic -> P5 landmarks + Times Square -> P6 route, AI, polish, perf pass.
