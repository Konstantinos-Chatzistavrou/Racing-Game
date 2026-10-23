# New York tiles: data contract (read this before touching tools/nyc or web/src/scene/nyc)

Goal: all of Manhattan at real scale, streamed in 256 m tiles, locked 30 fps on the i3 laptop (45 fps phone target). The pipeline is automatic
from open data (OpenStreetMap ODbL + NYC Open Data, public domain): adding area = generating more tiles. Plan and scope: docs/nyc_plan.md.

## Frame
Metres, x east, y north, z up, origin Times Square (lat 40.7580, lon -73.9855). three.js position = (x, z, -y) (same as the existing game: web/src/main.ts,
`new THREE.Vector3(s.x, s.z, -s.y)`). Grid: tile (ix, iy) = floor(x/256), floor(y/256). Times Square = tile (0,0); Columbus Circle ~ (1,4); Bryant Park ~ (0,-2).
Midtown test box: ix -3..4, iy -4..6. Manhattan extent: x -5260..6646, y -8337..13444 (~1300 non-empty tiles).

## Stage 1 data (done): `python3 tools/nyc/extract.py`, `tools/nyc/mask.py` -> assets_source/downloads/nyc/derived/ (gitignored)
buildings.ndjson (id, h = roof height m above ground, g = ground elevation m, year, code, rings), roads.ndjson (hw, name, lanes, oneway, bridge, tunnel, layer,
sidewalk tag, width m, pts), areas.ndjson (kind park|water|plaza|pedestrian|grass|pitch|parking|fountain|cemetery|pier, rings), rails.ndjson, nodes.ndjson
(tree, signal, crossing, hydrant, bench, lamp, bus_stop, subway_entrance, bike, artwork, fountain, stop, waste), manhattan_mask.json. All in the game frame.
Library: tools/nyc/tilelib.py (`World` with spatial index + mask, `Mesh`, `write_glb`, tile maths). If the derived files are missing, re-run extract.py + mask.py
(needs assets_source/downloads/nyc/NewYork.osm.pbf and footprints_manhattan.json: tools/nyc/fetch_footprints.py; the PBF is from download.bbbike.org/osm/bbbike/NewYork/).

## Output files per tile `web/public/assets/nyc/tiles/` (each owned by ONE stage; every file optional: the runtime loads what exists)
| file | owner | content |
|---|---|---|
| `{ix}_{iy}.ground.glb` | ground.py | roads, sidewalks, curbs, crosswalks, lane markings, plazas, parks, water, rails. Materials by NAME: `road`, `sidewalk`, `curb`, `marking`, `crosswalk`, `plaza`, `grass`, `water`, `rail`. UV in metres (u east, v north) so tiling textures/shaders need no per-tile scale. Vertex colour = tint, alpha = baked AO / edge darkening. |
| `{ix}_{iy}.graph.json` | ground.py | road graph for traffic: `{nodes:[[x,y]], edges:[{a,b,w,lanes,oneway,hw,name,pts?}]}` game-frame metres. |
| `{ix}_{iy}.bld.glb` | buildings.py | LOD0 buildings. Materials `facade` (walls) and `roof`. `facade`: COLOR_0 = wall tint (a = baked AO), UV = (metres along the wall, metres up from ground), custom attribute `_BLD` = (seed 0..1, floors, kind, era): kind 0 residential walk-up, 1 mid-rise, 2 office, 3 glass tower, 4 industrial/loft, 5 landmark; era 0 (pre-1900) .. 1 (after 2000) from `year`. The shader (web/src/scene/nyc/facade.ts) builds windows, floors, lit/unlit windows at night from these: NO textures. |
| `{ix}_{iy}.far.glb` | buildings.py | LOD1: the same buildings as plain prisms (no roof detail, ~12 tris each), same attributes. Used beyond ~500 m. |
| `{ix}_{iy}.col.json` | buildings.py | colliders for the physics: `{buildings:[{cx,cy,z0,z1,hx,hy,yaw}]}` oriented boxes (game frame) merged/simplified, plus ground height `{ground: z}` (flat tile ground; Manhattan is flat enough for racing). |
| `{ix}_{iy}.props.json` | props.py | instances: `{lamp:[[x,y,yaw]], tree:[[x,y,yaw,scale]], signal:[...], hydrant:[...], bench:[...], bus_stop:[...], subway_entrance:[...], sign:[[x,y,z,yaw,w,h,kind]]...}` game-frame metres. |
| `index.json` | build_tiles.py | `{tile:256, origin_latlon, tiles:{"ix_iy":{files:[...], bytes:{...}, bbox:[x0,y0,x1,y1,zmax]}}}` so the runtime knows what exists. |
Far-field skyline beyond ~1.5 km: `hlod_{jx}_{jy}.glb` (4x4 tiles merged, silhouettes only), owner buildings.py, later.

## Runtime rules (web/src/scene/nyc/)
- Stream by distance from the car: LOD0 ring ~ 2 tiles (ground + bld + props), LOD1 ring ~ 4-5 tiles, hlod beyond. Load/decode off the main frame budget (one tile per few frames), never stall a frame, unload with hysteresis, dispose GPU resources.
- No pipeline compiles while driving: all tile materials are shared singletons compiled at load (`warm`).
- Physics: colliders only for tiles within ~1 tile of the car; ground = one big cuboid/plane per tile.
- Lights: Manhattan has ~60k street lamps: real lights only from a small pool near the car (clustered lighting budget 192); everything else is emissive geometry + bloom.
## Budgets (30 fps on the i3 laptop; measure with web/src/bench.ts / tools/drive.mjs perf, wrap GPU runs in `flock /tmp/racing-gpu.lock`)
visible at any time: <= 400 draw calls, <= 500k triangles, ground+bld LOD0 per tile <= 60k tris / ~250 KB after meshopt, far.glb <= 40 KB, whole island <= ~300 MB
(hosted outside git: Cloudflare R2 / Vercel blob later; web/public/assets/nyc/ is gitignored except a small Midtown sample if needed).
Attribution: OpenStreetMap contributors (ODbL), NYC Open Data (public domain) in CREDITS.md and the in-game credits line.
