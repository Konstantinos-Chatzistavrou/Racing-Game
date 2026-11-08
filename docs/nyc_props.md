# New York props, signage and atmosphere (tools/nyc/props.py, web/src/scene/nyc/{props,signage,atmosphere}.ts)

Street furniture for the Manhattan tiles (data contract: docs/nyc_tiles.md). Generated from OpenStreetMap nodes where they exist and synthesised from the
road/building geometry where OSM is sparse. Everything is deterministic (hash of ids and positions, never `random`), tile independent (a street that crosses a
tile border gets the same lamps whichever tile asks).

```
python3 tools/nyc/props.py --box -3 4 -4 6          # Midtown test box (ix0 ix1 iy0 iy1)
python3 tools/nyc/props.py --all                    # every tile with content (about 1 min)
python3 tools/nyc/props.py --box -1 1 -1 1 --debug  # + _dbg_{ix}_{iy}.json (road and building outlines, only for web/nyc_props_test.html)
python3 tools/nyc/test_props.py                     # determinism, ownership, budget, schema, sanity checks
```

## `{ix}_{iy}.props.json`
Game frame metres. `yaw` = radians counter-clockwise from +x (east) towards +y (north). `z` values are heights above the tile ground (the runtime adds the
optional top level `"z"` = ground height of the tile if the tile ground is not at 0; the generator does not write it).

| key | row | meaning |
|---|---|---|
| `lamp` | `[x, y, yaw]` | cobra-head street lamp; yaw = direction the arm points (towards the road) |
| `tree` | `[x, y, yaw, scale]` | street, plaza and park trees (OSM trees kept; synthetic ones never within 4 m of an OSM tree) |
| `signal` | `[x, y, armYaw, faceSign, group, phase]` | corner pole with a mast arm along `armYaw`; heads face `armYaw + faceSign*90 deg`; `group` 0/1 = the two roads of the crossing (opposing poles share a group), `phase` = cycle offset in s (0..60, per intersection) |
| `hydrant` `bench` `bus_stop` | `[x, y, yaw]` | yaw = facing direction (towards the road for a shelter's open side / the bench's front) |
| `subway_entrance` | `[x, y, yaw]` | yaw along the road; green globe lamps |
| `steam` | `[x, y, height]` | orange/white striped steam stack (a few per Midtown tile, at the kerb inside the carriageway edge); the runtime adds the puffs |
| `scaffold` | `[x, y, yaw]` | one 4 m module of green sidewalk shed along a building front (yaw along the wall); a shed is up to 6 modules |
| `cone` | `[x, y]` | construction cones (short rows at some Midtown intersections) |
| `kiosk` | `[x, y, yaw]` | newsstand on plazas / pedestrian areas |
| `waste` | `[x, y]` | OSM waste baskets |
| `sign` | `[x, y, z, yaw, w, h, kind]` | quad centre (z above ground), yaw = outward wall normal, size in m; kind 0..7 big LED screens, 10..15 neon shop signs. The tile owning the sign is the tile of its **building** (the wall may cross the tile border by up to ~90 m) |

OSM sources: trees, signals (only used to decide which crossings are signalised), hydrants, benches, bus stops, subway entrances, waste. Bike racks and
crossings are ignored. Synthesised:
- lamps every ~26 m (primary/secondary) or ~32 m on both sides of every host road (trunk .. living street, not bridges/tunnels/`sidewalk=no`), offset 0.9 m behind the
  kerb line, staggered, never inside a carriageway of another road, within 3 m + half width of a crossing road (crosswalk), or in a building; plus lamps along park
  paths and plaza edges;
- street trees every ~11 m (70 % kept) on residential-class streets, 16 m (45 %) on tertiary/secondary, none on primary; Bryant Park gets two rows of plane trees
  along the inset perimeter, other parks a jittered grid thinned by smooth noise (clumps and clearings), skipping water and roads;
- traffic signals at every crossing of an avenue-class road (secondary or better) with a road up to residential, and at any crossing within 35 m of an OSM signal:
  4 corner poles; hydrants at ~28 % of corners; steam stacks, cones, kiosks, scaffold sheds (3.5 % of Midtown buildings, 1 % elsewhere);
- signs: big screens on walls facing a host road (building >= 18 m, wall >= 10 m, between z 7 m and min(h-2, 44) m so they hang on the base of a setback tower),
  probability 0.9 within 260 m of Times Square, 0.5 within 450 m, 0.1 within 900 m, none beyond; neon shop signs at z 3.2-4.4 m (14 % within 1.4 km, 5 % within 3.5 km).

**Kerb line**: the OSM `width` values are carriageway widths (6.6 m for a street), the real kerb-to-kerb width is ~11-18 m. `props.py` uses `max(width, MIN_WIDTH[hw])`
(trunk 18, primary 16, secondary 14, tertiary 12, residential 11). If ground.py puts the kerb elsewhere, change `MIN_WIDTH` (one table) and re-run.

Budgets per tile (hard caps in `gen_tile`): <= 1500 instances in total (trees are cut first), lamp 420, tree 900, signal 64, sign 130. Midtown box (88 tiles):
see "Measured" below.

## Runtime
```ts
const props = new NycProps(scene, camera, { lights: 28 });   // pre-allocates everything, adds ~16 meshes (draws) + the light pool to the scene
await props.warm(renderer);                                    // compile every pipeline now (each mesh always draws >= 1 degenerate instance)
props.setTile('0_0', json);  props.removeTile('0_0');          // from the tile streamer (any number per frame; ~0.5 ms per 1000 instances)
props.update(dt);                                              // every frame: advances nycTime, uploads dirty buffers, fades the light pool
props.dispose();
```
- One pre-allocated `InstancedMesh` per kind (`InstanceSet`, signage.ts): slots are leased per tile, zeroed and reused on removal, `count` = high-water mark,
  buffer uploads at most once per frame. Capacities: lamp 6000, tree 14000, signals 2 x 900, hydrant 1500, bench 2200, bus 400, subway 400, steam 200,
  scaffold 1500, cone 600, kiosk 300, waste 1500, sign 3200, steam puffs 1200 (a full tile ring of Midtown uses well under half). A full pool drops extra instances (one console warning).
- Every kind is one merged geometry with vertex colour + a `glow` attribute (emissive weight): lamp = base + pole + arm + head + lit lens in one draw.
- No per-instance work per frame: signal phases, steam puffs and sign screens are vertex/fragment shader functions of one uniform (`nycTime`, advanced in `update`).
- Traffic signal cycle (60 s): group g is green for 26 s, yellow 3 s, red 31 s, offset `31*g + phase`; the same function drives the pooled lights in JS.
- Lamp light pools: an additive decal quad per lamp that shares the lamp's instance matrices (no extra data), faded out beyond ~120-260 m.
- **Lights**: no THREE light per prop. A pool of `lights` (default 28) PointLights is re-assigned every 200 ms to the best candidates around the camera
  (score = distance x bias, x2.2 behind the camera: lamps 1.0, signals 1.9 (range 55 m), big screens 0.7 (range 150 m)); each light fades (~0.15 s) out, takes the new
  position while dark, then fades in, so nothing pops. The pool size is fixed, so the clustered-lighting shaders never recompile. Count it in the 192-light budget.
- Not done: tree LOD/impostors (a tree is ~30 triangles; all trees of the loaded ring are drawn, no frustum culling per instance), colliders (props have none:
  lamps/trees/hydrants can be driven through; add boxes near the car if wanted), per-tile ground height (`"z"` optional).

## Signage (signage.ts)
One quad `InstancedMesh`, one `MeshBasicNodeMaterial`: instance matrix = placement and size, an instance vec4 = (kind, seed, width m, height m). The TSL colour is built
from the kind: LED pitch 0.4 m (dot mask), kinds 0..7 = scrolling colour fields, flashing bars, glyph-like text (hashed 5x7 pixel cells, no letters), pulsing rings,
sweeping stripes, LED video noise, ticker band + big shape, slow flash; 10..15 neon tubes (frame + glyph pattern, random flicker). Emissive gain 1.55-1.9 and a hard
cap of 2.4 per channel. No trademarks, brand names or real logos: everything is procedural and generic.

## Atmosphere (atmosphere.ts)
`const atm = applyNycAtmosphere(scene, renderer, { fogDensity })`: `scene.backgroundNode` sky (orange-pink light-pollution band, magenta-grey mid sky, indigo zenith,
a brighter patch toward Midtown), `FogExp2` 0.0026 (5 % contrast at 700 m) coloured like the horizon glow so far buildings melt into it, the existing hemisphere light
set to a warm sky-lit fill (or a new one). `atm.dispose()` restores what it replaced. Zero per-frame cost.

## Test page (throwaway)
`web/nyc_props_test.html` + `web/src/scene/nyc/propsTest.ts` (flat ground, debug roads/buildings, the game's Post pipeline) and `web/tools/nyc_props_shots.mjs`:
```
cd web && npx vite --port 5209
CDP_PORT=9409 flock /tmp/racing-gpu.lock node tools/nyc_props_shots.mjs http://127.0.0.1:5209/nyc_props_test.html /tmp/out shots @shots.json
CDP_PORT=9409 flock /tmp/racing-gpu.lock node tools/nyc_props_shots.mjs http://127.0.0.1:5209/nyc_props_test.html /tmp/out perf
```

## Clear of the asphalt as drawn (2026-11-08)

Every prop's ground footprint (`props.FOOT`: the mesh extents at ground level, rotated by its yaw, trees scaled) keeps 0.35 m from
`ground.road_surface`, the asphalt exactly as ground.py draws it: the ways buffered to their width PLUS the 4.5 m kerb fillets at
inside corners (up to ~1.9 m beyond the buffered ways), closed medians and parking lots. Props closer are pushed back onto the
sidewalk (away from the nearest asphalt edge, at most 3 m) or dropped (would land in a building, or stand on a closed median).
Before: 942 of 1,040 signal poles, 130 trees, 83 scaffolds, 55 lamps and others reached onto the drawn road. Check any time with
`python3 tools/nyc/check_road_clear.py` (exit 1 if anything does).
