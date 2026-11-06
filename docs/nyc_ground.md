# NYC ground stage (tools/nyc/ground.py, web/src/scene/nyc/groundMaterials.ts)

Output per tile (contract: docs/nyc_tiles.md): `{ix}_{iy}.ground.glb`, `{ix}_{iy}.graph.json` in `web/public/assets/nyc/tiles/`.

```
python3 tools/nyc/ground.py --box -3 4 -4 6          # Midtown test box (inclusive ix0 ix1 iy0 iy1)
python3 tools/nyc/ground.py --all --jobs 4 --meshopt  # whole island (~1000 tiles with land), meshopt via npx @gltf-transform/cli
python3 tools/nyc/test_ground.py                      # partition / seam / budget / graph checks
tools/blender/blender -b -P tools/nyc/render/render_ground.py -- out.png top 305 1130 450   # flat-colour preview (top|persp)
```

## How a tile is built
All geometry comes from shapely set operations on data within tile + 26 m, then clipped to the tile box, so tiles meet exactly (checked by test_ground.py).
1. Road surface = union of centrelines buffered by half the roadway width, then a closing (buffer +4.5 m / -4.5 m) which rounds every concave corner
   (kerb radius ~4.5 m) and merges intersections into one flat polygon, small holes (< 60 m2) filled, parking lots added, simplified 6 cm. No tunnels; bridges stay on the ground.
2. Widths: the extracted `width` is lane based and too narrow, so by class (`road_width`): avenues (name has Avenue/Broadway/Boulevard...) 21 m (18 oneway), primary 22/19,
   secondary 14, tertiary 13, residential 12/11, service 5, motorway carriageway >= 10.5. (Real Manhattan roadways: avenue ~ 18-24 m, street ~ 11-13 m.)
3. Land = Manhattan mask (+ piers) minus OSM water; water = tile minus land (Hudson/East River), plane at z = -0.5 with a vertical sea wall (`curb` material) at the edge.
4. plaza = pedestrian/plaza/fountain areas + highway=pedestrian lines (roads win over plazas: Broadway through Times Square stays drivable); park = park/grass/pitch/cemetery
   areas minus plaza; sidewalk = EVERYTHING else on land (so there are never holes, buildings simply stand on it; footprints are not subtracted: far fewer triangles, no gaps where the footprint data is incomplete).
5. Heights: road 0, sidewalk/plaza/grass +0.15, kerb face (`curb`, 0 -> 0.15) + 0.2 m kerb top band (`curb`), park paths +0.162, markings +0.025.
6. Vertex colour alpha = baked edge darkening: road and sidewalk are split into a 1 m band along the kerb (alpha from the distance to the kerb: 0.78 road / 0.62 sidewalk at the kerb, 1 inside) and the interior.
7. Markings (owned by the tile that contains their centre, so no duplicates): double yellow on two-way roads, dashed white lane lines (3 m dash / 9 m gap), trimmed back from intersections; at every
   intersection leg a crosswalk quad (2 tris, striped by the shader) and a stop line on the approaching side. Rails: surface rail ribbons (`rail`).
8. `graph.json`: `{tile, nodes:[[x,y]], gid:[global ids], edges:[{a,b,w,lanes,oneway,hw,name,len,bridge?,pts?}]}`; nodes = intersections and way ends, `pts` = interior polyline points, edges that touch the tile
   (also crossing the border) are in every tile they touch; `gid` = (round(x*10)+100000)*1e6 + round(y*10)+200000, identical in neighbouring tiles. Service roads and footways are not in the graph.

## Materials (groundMaterials.ts)
`createGroundMaterials()` -> shared singletons by glb material name (road, sidewalk, curb, marking, crosswalk, plaza, grass, water, rail). Procedural TSL, no textures: UV (metres) + vertex colour.
- Special UV: `crosswalk` quads use LOCAL metres (u across the road, v along it) so the zebra bars work at any angle. `marking` colour = vertex colour (yellow/white).
- road: dark asphalt, wet look (roughness ~0.3-0.5 so SSR, which keys on roughness < 0.5, reflects; puddles 0.03), 30 m wear blotches, aggregate grain + bump, repair patches, cracks (worley), puddles that favour the gutter.
- sidewalk: 1.52 m slabs laid out along Manhattan's 29 degree grid, joints, per-slab tint, damp slabs. plaza: running-bond pavers. grass: 3-scale noise + mud + blade bump. water: 3 animated noise octaves as a bump normal. curb: granite, grimy at the base. marking/crosswalk: alpha-tested paint with wear, polygonOffset.
- High frequency detail fades with distance (`near`), so the cost and the shimmer drop beyond ~90 m. Test page: web/nyc_ground_test.html (+ src/scene/nyc/groundTest.ts), screenshots with tools/nyc/shot.mjs.

## Known limits
- No tyre-polish lines (the road mesh has no direction); no bus lanes; no bridge decks / elevation; no tunnel mouths.
- The closing radius also fills medians narrower than ~9 m (Park Avenue islands, Times Square slivers).
- Service roads inside blocks are drawn as asphalt and get kerbs (mostly under buildings).
- Street furniture, trees, lamps are not ground: props.py.
