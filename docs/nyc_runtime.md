# New York streaming runtime (web/src/scene/nyc/)

Data contract: docs/nyc_tiles.md. Switch: `?city=nyc` (default stays the old small city). `?nycdebug=1` shows the overlay (tiles per LOD, draws, tris,
geometries, textures, pipelines, colliders, ms spent streaming per frame). `?fog=0.003` (nyc fog density; the old city's 0.0085 hides everything past 250 m).

## Files
| file | role |
|---|---|
| `streamer.ts` | `NycStreamer` + content discovery (`loadNycMaterials`, props) |
| `index.ts` | re-exports + `nycCityShim()` (a `City`-shaped no-op so main.ts's loop, warm-up and bundle hooks run unchanged) |
| `placeholders.ts` | flat dark ground per material name, grey facade with a window grid from `uv()`/`_bld` (used until the real ones are merged) |
| `tools/nyc/stub_tiles.py` | stub tiles (real footprints extruded, road ribbons, boxes) into `web/public/assets/nyc/tiles/` (gitignored): `python3 tools/nyc/stub_tiles.py [--box ix0 iy0 ix1 iy1]` (default ix -3..4, iy -4..6) |
| `tools/nyc/drive_nyc.mjs` | the streaming test (see below) |

## Interfaces expected from the content stages (found with `import.meta.glob`, so a missing file is fine: placeholder)
```ts
// web/src/scene/nyc/groundMaterials.ts
export function createGroundMaterials(): Record<string, THREE.Material>   // road sidewalk curb marking crosswalk plaza grass water rail
// web/src/scene/nyc/facade.ts
export function createFacadeMaterial(): THREE.Material;  export function createRoofMaterial(): THREE.Material
// web/src/scene/nyc/props.ts
export class NycProps { constructor(scene: THREE.Scene, camera: THREE.Camera); setTile(key: string, data: unknown): void; removeTile(key: string): void; update(dt: number): void; dispose(): void }
```
Rules the streamer applies to the glTF: every mesh's material is replaced by the shared singleton of the same NAME (`facade`, `roof`, or the ground names; the
loader's own materials are disposed unused); `receiveShadow = true`, `castShadow = false`; matrices are frozen. Custom attribute `_BLD` arrives as `_bld`
(three lowercases custom attribute names). Materials must be created ONCE (the streamer calls each factory once) and need no per-tile state.
`index.json` may carry `spawn: {x, y, heading}` (game frame, heading = angle from east CCW, along the travel direction); else the nearest road segment of tile
0_0's `graph.json` is used; else Times Square facing south along the avenue grid. `props.json` is passed parsed to `setTile` when the tile's LOD0 is shown.

## How it streams
- Per tile three independent parts, each with its own radius (m, distance from the car to the tile footprint) and hysteresis: **near** (ground + bld + props) load 380 /
  drop 460; **far** (far.glb) load 1000 / drop 1150, hidden while the tile's near part is shown (so no overlap); **col** (colliders) load 260 / drop 330. Options on `NycOptions`.
- Selection at 10 Hz. Candidates sorted by distance with a forward bias (up to 150 m for tiles ahead of the car's motion), collider loads first, far last.
  At most 2 near + 2 far + 2 col loads in flight; one mesh-tile load started per selection pass. Failed loads are retried after 10 s.
- Fetch + decode: `gltfLoader().loadAsync` (shared meshopt decoder), NOT `loadGLTF` (that caches forever). Parsed tiles wait in a commit queue.
- Commit: `update()` drains the queue under a 2.5 ms budget (always at least one job): attach the tile group, reveal ONE mesh per job (its GPU upload happens at its first
  draw, which is forced once even when off-screen via `frustumCulled = false` until `onBeforeRender`), colliders in batches of 60. A frame longer than 50 ms pauses commits for 2 frames.
- Tile roots are static (`matrixAutoUpdate = false`); a tile-level frustum test toggles `group.visible` each frame.
- Unload: geometries `dispose()`d (materials never), colliders removed from Rapier, props removed, group detached.
- Colliders: one `cuboid(128, 2, 128)` ground per tile with its top at `col.json.ground`, one oriented cuboid per `buildings[]` entry (game frame -> three: centre `(cx, (z0+z1)/2, -cy)`,
  rotation about Y by `yaw`). They are created straight on `pw.world` and registered in `PhysicsWorld.surfaceOf` (private; cast) so they can be removed again (`addStaticBox` returns nothing).
  Surfaces: ground = asphalt, buildings = wall.
- Warm-up: after the first ring is in, one tiny mesh per shared material is created with the vertex layout of the real tile geometry and added to the scene, so
  main.ts's `compileAsync` + forced full draw + preset warm-up build every pipeline (water, rails... may not be in the first ring). `endWarm()` (called next to `city.props.warmup(false)`) removes them.
  `pipelines()` stays constant while driving (verified).

## main.ts hooks (all marked `nyc`)
import; `const nyc = ?city=nyc ? new NycStreamer(...)`, `await nyc.ready()`, fog density + camera far; `nycS0` (spawn) replaces `route.samples[0]` in the two `s0` definitions;
`city = nyc ? nycCityShim() : loadCity(...)`; AI traffic 0; `nyc?.endWarm()`; `nyc?.update(pos, frame)` in the loop; lap tracker skipped; `sel.mode = 'free'` in `beginRace`; `nyc` in `window.__game`.
Not done: race/lap tracker on an NYC route (free roam only), traffic on `graph.json`, the old city's `route` is still loaded (spawn only matters for the old city).

## Test
```
python3 tools/nyc/stub_tiles.py --box -9 -14 4 6          # ~300 tiles, 3.5 km down the avenue
cd web && npx vite --port 5208
CDP_PORT=9408 node ../tools/nyc/drive_nyc.mjs "http://127.0.0.1:5208/?city=nyc&nycdebug=1" /tmp/out 60      # real driving, steers to hold the spawn line
PLACE=45 CDP_PORT=9408 node ../tools/nyc/drive_nyc.mjs ...                                                   # car placed along the line at 45 m/s (streaming through buildings)
```
Wrap runs in `flock /tmp/racing-gpu.lock`. Output: frame interval percentiles, spikes > 40 ms with the streamer state, draws/tris per rendered frame (all passes of the frame),
pipelines at start/end, per-5 s table of tiles, colliders, geometries, textures, JS heap.
