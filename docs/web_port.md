# Web build (WebGPU)

Decided 2026-10-17: the game moves from Godot to the browser. The C++ core is NOT rewritten: it is
compiled to WebAssembly, so handling, assists, damage, AI and race logic stay one source of truth.

## Stack (versions checked 2026-10-17)
| Layer | Choice | Why |
|---|---|---|
| Rendering | three.js r186 (0.186.1), `WebGPURenderer` + TSL | current WebGPU path; clustered (Forward+) lighting since r185, TSL post-processing |
| Physics (handling) | `core/` -> WebAssembly via Emscripten 6.0.12 (`web/wasm/build.sh`) | same code as native; 208 KB .wasm |
| Physics (rigid bodies, collisions, wheel raycasts) | Rapier 0.21 (`@dimforge/rapier3d-compat`) | replaces Godot's physics server in the same role |
| Build | Vite 8.3, TypeScript 5.9 | |
| Assets | the existing glTF exports (`game/assets/*.glb`) and `data/*.json`, symlinked into `web/public` | one source for both builds |

Babylon.js 9 was the alternative (also WebGPU, clustered lighting); three.js chosen for TSL, the
larger ecosystem and because the user already knows JS/Next.js.

**WebGPU is required.** Without an adapter the game shows instructions and stops (`?webgl=1` forces
WebGL 2 for debugging only; clustered lighting needs compute shaders, so WebGL 2 uses a 12-light pool).

## Enabling WebGPU on this laptop (Chrome 155, Linux X11, Intel UHD RPL-U)
Not on by default here. `chrome://flags` -> enable "Unsafe WebGPU Support" and "Vulkan", relaunch.
Verified adapter with the flags: vendor intel, architecture gen-12lp. Without flags: no adapter.

## Architecture (mirrors godot_ext)
- `web/wasm/bridge.cpp`: flat C API, ONE shared double buffer per car. The ONLY place axes are
  converted (three/glTF = Godot mapping: three = (x, z, -y)).
- `web/src/physics/world.ts`: Rapier world at 240 Hz; chassis = convex hull from `*.visual.json`,
  mass/inertia from the car config; wheel rays -> core -> force/torque applied at the CG.
- City collision = glTF nodes named `*-colonly` (Godot convention kept); surface from the name.
- Rapier gotcha: new colliders are invisible to ray queries until the first `world.step()`. Without
  that step the first spawn probe missed the road and the car dropped 3 m, landed on one wheel and
  started with a 3 deg yaw error (drove into the kerb at 110 km/h and rolled).

## Validation
- `node web/tools/check_core.mjs`: 60-0 mph with ABS through the bridge = **31.7 m**, identical to
  the native test (33.0 m only if the test skips the native procedure's brake pre-settle).
- `node web/tools/drive.mjs`: system Chrome with WebGPU flags via DevTools protocol; straight-line
  run 0-144 km/h in 7 s (keyboard, TC, auto gearbox), lateral drift < 0.05 m over 150 m.

## Performance (1236x613, scale 1, SMAA, bloom, 1 shadowed headlight)
| Backend | Lights | fps | worst frame |
|---|---|---|---|
| WebGPU | 192 (clustered) | 46-53 | 28-37 ms |
| WebGL 2 (debug) | 12 nearest | 54-61 | 23-30 ms |

## Crash damage (port of game/scripts/damage_visuals.gd)
The core's damage model decides everything (crush per zone from crash energy, engine, wheels,
totaled; bent toe up to 1.5 deg, weaker springs, power loss). The web side only feeds it and shows it:
- Crash input: J = m |v_now - (v_prev + (F_prev/m + g) dt)| per tick (same as Godot); contact point
  from Rapier's manifold LOCAL points (solver points are empty after the step).
- Visuals: dents at the impact point (one panel per frame), bumpers/mirrors break off as 6 kg Rapier
  debris (own collision group: never hits its car), lights die, smoke from engine damage 0.25,
  sparks above 2 kJ, synthesized crash audio (thud + metal clanks + glass). R repairs everything.
- Traps found: (1) hiding a light (visible = false) changes the scene's light set and recompiles
  EVERY lit material: 300 ms freeze on impact -> set intensity 0 instead; (2) a new material type
  mid-race compiles a pipeline -> clone the existing material; (3) camera wall pull-in divided by a
  distance it had just zeroed -> NaN camera, black screen after crashes.
- Test: `node web/tools/drive.mjs <url> <out> crash` (93 km/h into the buildings): 3-7 impacts,
  ~500 kJ, totaled, 3 parts off, worst frame 31.8 ms (was 383 ms).

### Damage pass 2 (2026-10-18)
- Dents moved to the VERTEX SHADER (`web/src/scene/dents.ts`): one TSL positionNode on every body
  material applies up to 16 accumulated dents (model-space point + depth, crash dir + radius;
  falloff (1-(r/R)^2)^2, push = -normal blended with the crash direction, analytic normal tilt
  written to normalLocal). Replaces the CPU vertex loop: zero CPU per hit, no geometry clones;
  when full a new dent merges into the nearest. Per-mesh rest matrices are per-object uniforms, so
  wheels sharing a material are never dented and broken-off parts keep their dents.
- Never immovable: "totaled" is only a report flag now; engine power floor 0.25 (limp home), the
  bridge no longer cuts the input. Native test: wrecked car reaches 55 km/h in 6 s.
- Fire + brakes in the core (`DamageModel::update`): severity = max(engine, structural kJ/t / 1200);
  from 0.5 the bay steams (builds over 20 s), from 0.9 it then burns (flames grow over 45 s; flickering
  orange point light created at start with intensity 0). Brake wear from a wreck (s > 0.9) and fire: fade
  to 30 %, then failure (all brakes incl. handbrake). HUD lamps: ENGINE OVERHEATING / ENGINE FIRE,
  BRAKES FADING / NO BRAKES, WHEEL LOST. Thresholds raised 2026-11-11 (were 900 kJ total, 0.6, 10 s):
  see docs/physics.md section 10.
- Wheels come off (2026-11-11): core wheel damage >= 0.95 -> `DamageVisuals.detachWheel`: an 18 kg Rapier
  cylinder on the axle, leaving with the car's speed; the caliper stays, the hub throws sparks while moving.
- Reverse by pedal (core Controls, auto and manual): brake > 0.8 held 0.4 s at < 0.5 m/s -> R, pedals
  swap; throttle held at a standstill -> 1st. The 0.5 spawn hold never reverses. Touch BRAKE too.
  Respawn resets to 1st (a pedal reverse used to survive R and drive the car backward).
- Headlights: a front hit (crush > 0.12 m or >= 15 kJ) makes the spots flicker 2 s, then die.
- Wheel/camera/spawn rays use the car's collision groups: a fallen bumper is no longer "road"
  (wheels used to land on it and slew the car sideways).
- Rapier: city = 42 parentless (fixed) trimesh colliders. world.step() 0.08-0.12 ms with the car
  awake, ~0.2 ms while debris tumbles, back to ~0.1 ms once it sleeps (default canSleep).
- Tests: `drive.mjs <url> <out> damage` (reverse, injected 90 km/h wreck, flicker, fire, brakes,
  repair); CDP_PORT env for parallel runs. Known (pre-existing): a car impaled on a thin pole can
  feed huge impulses (47 MJ "crash"); not addressed.

## Phones and tablets
Touch controls appear on coarse-pointer devices or on the first touch: analog steering pad (left,
relative drag, 90 px = full lock), GAS/BRAKE/handbrake (right), reset/camera/gearbox/fullscreen
(top; fullscreen also locks landscape on Android). Phones in portrait get a rotate prompt.
Adaptive resolution (main.ts): 2 s windows of average fps; < 40 for 2 windows -> scale -0.1 (min
0.5); > 55 with p90 frame < 22 ms for 2 windows -> +0.1, at most one step up per 10 s (doubling to
80 s if a step up is undone within 20 s), never above 1. The first 3 windows (car held at the start)
calibrate with no hysteresis. Each resize costs a 300-700 ms hitch, so the window after it is
skipped. The HUD shows the scale; `?scale=x` pins it.
Test: `drive.mjs <url> <out> mobile` emulates a 915x412 phone with multi-touch (gas + steer).
Real-phone frame rates are NOT measured yet (emulation runs on this laptop's GPU).
Weak phones (Mali-G57 class and below, or no WebGPU) start in **potato mode**: see docs/performance.md, "Potato".

## Presentation ("AAA feel")
- Camera (`web/src/camera.ts`): spring-damper on the camera's offset RELATIVE to the car
  (omega 5 rad/s, zeta 0.75, lag capped at 1.6 m), driven by the car's acceleration: pulls back
  under power, surges in under braking, swings wide in corners. A world-space spring would trail
  ~9 m behind at 144 km/h. The final car-relative offset is smoothed with
  `lerp(target, 1 - exp(-12 dt))` (eases out after a wall pull-in; pulling in stays instant).
  FOV +0..14 deg above 60 km/h, plus a throttle punch of up to +5 deg (~1 s in, ~1.5 s out,
  weighted by forward acceleration), total capped at +16. Redline shake: only within 3 % of the
  redline, rotation only, 3.5/6.5 Hz value noise, <= 0.15 deg (bumper cam 45 %). Measured on the
  limiter: <= 0.024 deg camera rotation per frame. (The earlier high-frequency suspension shake was
  removed: it aliased into judder at 30 fps.) Ideas from Threejs-Punk: docs/threejspunk_notes.md.
- Audio (`web/src/audio.ts`, all synthesized): engine pitch = rpm/60 * cylinders/2 (V8 assumed:
  the data has no cylinder count); filter opens with throttle; tyre squeal from the core's slip
  angle (> 6 deg) / slip ratio (> 12 %) weighted by load; wind ~ speed^2. No blow-off valve: the
  engine model is naturally aspirated. Verified: osc 383 Hz at 5720 rpm (expected 381).
- Post (`web/src/post.ts`): high = TRAA + motion blur (velocity MRT); low = SMAA. Both: bloom,
  AgX, teal/orange grade, edge-only chromatic aberration (0.12), vignette. Default high on desktop,
  low on touch; `?quality=`. No depth of field (blurs the lit city, expensive).
  Trap: `chromaticAberration(c, s, null)` -> null node -> TSL build error, black screen: pass vec2(0.5).
- HUD: SVG dial (needle eased toward true speed, rev ring red past 92 %), lap panel and a fading
  lap card from the core's RaceTracker (`Route::parse` added for JSON text).
- Cost on the laptop (1236x613): low 49-60 fps, high 44-48 fps; GPU-bound (CPU profile: 27 % idle,
  no hot spot in game code). Adaptive resolution covers full screen.

## Night lighting and AI traffic
- Floor of the picture: `HemisphereLight(0x0a0a14, 0x000000, 0.1)`; sky/fog 0x05060c (deep blue-black,
  not a void); moon 0.04. The city reflection capture is for reflections only: environmentIntensity
  0.5 (at 1 its diffuse part lit every wall like an overcast sky).
- Headlights are the main light (900 cd, decay 2, one shadowed). `L` switches them (intensity 0, never
  `visible = false`, see the damage traps). Street lamps 40 cd / 18 m, neon 15 / 8 m (were 260 / 26
  and 60 / 12: they floodlit the facades and headlights stopped mattering); lamp heads and neon tubes
  stay bright through their emissive materials.
- AI (`web/src/ai.ts`, `?ai=0..3`, default 3): kinematic Rapier bodies following the route lane
  (offset right, smoothed through narrow streets; ground from raycasts), speed from curvature ahead
  (5.5 m/s^2) and from whatever is in the lane ahead (player or AI: stop ~7 m behind). Own copy of
  the car glTF (the player's gets dented), shared by the AI cars; 1 unshadowed spot each.
  Collider 0.15-1.0 m high, restitution 0: at the player's hull height (1.2 m) the top edges met and
  a player pushing a side-on AI car climbed it and rolled over. Shader warm-up: the AI cars are drawn
  once in the headlight beam during loading.
- `?blackcar=1`: AI cars black (body: black albedo, reduced specular 0.2 + thin clear coat 0.15;
  rest MeshStandard black, roughness 0.6), lights off. Full F0 4 % (or clear coat 1) on the rear
  panel facing the headlights at 11 m blew out to a white slab; none at all = a hole in the picture.
- Test: `drive.mjs <url> <out> night` parks the AI cars in front (11 m behind-on, 20 m side-on,
  32 m facing), screenshots headlights on/off, then drives among them. Pin `?scale=` when measuring:
  the adaptive-resolution resize (300-700 ms) is what showed up as "hitches" in unpinned runs.

### Adaptive resolution after the merge (2026-10-18)
Measured on the laptop iGPU: the 40 fps rule stepped the scale down 4 times during a 7 s drive
(1.0 -> 0.6), each resize freezing the game 0.5-1 s. Now the car is locked on the brake while it
calibrates (1 s windows, HUD "calibrating…", 40 fps threshold) and stays locked until a window
without a resize. The settled scale is stored in localStorage per window size, so later sessions
start there with one check. While driving only < 30 fps for 3 windows steps down, and steps up only
happen while stopped. Result: all hitches before the start, no driving frame over 60 ms at scale 0.7.

## Hi-fi city (branch wip/hifi-city)
- Sources: CC0 Poly Haven / ambientCG (`assets_source/scripts/fetch_city_assets.py`, credits in `CREDITS.md`). Pipeline:
  `make_city.py` (static city, tiles merged per material) + `make_city_props.py` (prop library with 3 LODs, writes
  `data/city_props.json` placements) -> `build_city_assets.sh` (dedup/prune/resize, KTX2: UASTC normals, ETC1S colour+roughness,
  meshopt geometry with 16-bit quantization) -> `web/public/assets/city/city.glb` + `city_props.glb`.
- Runtime: `scene/instancing.ts` (one InstancedMesh per asset per LOD, 120 m cells, per-asset draw distance, frustum + LOD
  picked per frame, skipped when the camera is still); `city.update(camera)` is called from the main loop. Sidewalk props
  get static Rapier boxes (`PhysicsWorld.addStaticBox`).
- Measured (city_bench.mjs, 0.7 scale, 5 fixed spots, laptop shared): before = 36 MB city.glb + PNG textures, 34.7 MB city
  download, 281 MB texture memory, 130-230 draw calls, 90-130k tris. After = 26.8 MB (21.2 + 5.8 props), 91 MB GPU memory
  (54 MB textures), 180-275 draw calls, 150-204k tris; frame time unchanged (60 fps vsync, p95 33 ms).
- Draco was not used: meshopt decodes faster, keeps vertex-cache order and its decoder is ~20 KB.


## Front end: title, garage, modes (2026-10)

State machine in `web/src/main.ts` (`boot -> title -> garage -> busy -> countdown/race <-> paused -> results`),
screens in `web/src/menu.ts`, data in `web/src/garage.ts` + `data/cars/catalog.json`.

- **Graphics tuning** happens only on the title screen, behind an opaque cover: 1 s windows of the parked
  showroom view; < 40 fps lowers the post preset first, then the render scale (-0.1, min 0.5); > 55 fps raises the
  scale if nothing was lowered. The result is stored per window size, so later visits take one window.
  There is no adaptive change while driving or in the garage (the old in-race adaptation is gone: it was the visible
  quality transition). A drive costs more than the parked view, hence the 40 fps bar. Auto / High / Medium / Low
  in the title menu; `?scale=` / `?quality=` still pin for the test tools.
- **Cars**: Vela GT (v3 body, `data/cars/vela_gt.visual.json`), Kestrel GT and Harrier GT (own bodies). The Vela GT Touring and GT-R
  variants (same body, different numbers) were removed on 2026-11-08.
  Changing car or tuning rebuilds the core car and Rapier body at session start; paint and finish only touch the
  paint material.
- **Tuning** (`applyMods`): engine +5 % torque per stage, tyres +5 % grip, weight -3 % mass and inertia, aero
  +25 % downforce / +6 % drag per stage. Levels 0-3; stats bars read the patched JSON.
- **Flow**: title → Play → game modes (Race / Free Roam / Multiplayer). The garage (title → Garage) has no mode picker:
  Main Menu or Continue → game modes.
- **Race**: you + 5 AI rivals (`ai.ts`, `?ai=0..5`). Rivals are kinematic bodies on a smoothed 2 m driving line (route
  corners rounded); speed profile from the core AIDriver limits on the default car's physics (cornering skill·0.82·µg,
  braking skill·0.85·µg, power/drag-limited acceleration), skills 0.78-0.92, own preferred line, move over to pass a
  slower car or the player, ≤5 % catch-up. Always flat on the road (yaw only). All six cars are in the core RaceTracker
  (positions, finish times). 'off' parks them under the city with lights at 0 (the light set never changes).
- **Free Roam**: just you.
- **Multiplayer** (`party.ts`, `net.ts`): PeerJS star around the leader; messages hello / lobby / start / loaded / go /
  lobbyback / pose (20 Hz + 1 s heartbeat) / prog (4 Hz) / bye. Leader GO waits for every member's `loaded` (20 s cap).
  Grid slot by join order. `?party=CODE` invite banner, `?peer=` own broker.
  Other players are kinematic bodies with our hull (`carHull`), moved every physics tick to a prediction (last pose +
  sent velocity × (age + 50 ms), ≤ 300 ms; disagreements fade over 120 ms), so both sides of a contact get pushed.
  `gone` takes a player who left the session off the road.
- **Rules** (title: Full Realism / Respawns; a party uses the leader's): realism races have no R; out (DNF) when totaled,
  upside down 5 s or stuck 30 s (core check_out rules), then spectate (rig follows an AI / remote body) until the field
  is done or Results. Progress carries `dnf`; standings rank finished > racing > DNF.
- `?menu=0` skips the front end (free run at once) for `web/tools/drive.mjs`; scenarios `menu`, `race6`, `follow` walk the
  UI / race; `tools/party_test.mjs` and `tools/party_game_test.mjs` test parties.

## Street furniture physics (nyc/obstacles.ts, props.ts PROP_PHYS)

Poles, signals, hydrants, bins, shelters, kiosks and tree trunks within 40 m of the car are fixed Rapier colliders
(GROUP_PROP: the chase camera and AI ground rays ignore them). Trees never break. A breakable is sheared only if the car
can pay its breakaway energy after sharing momentum with the part of its mass it must accelerate:
v1 = m v / (m + effFrac M), v2 = sqrt(v1^2 - 2E/m). Lamp post 420 kg / 22 kJ (stays up below ~21 km/h and stops the car),
signal 650 kg / 35 kJ, hydrant 180 kg / 14 kJ, kiosk 650 kg / 25 kJ, bin 45 kg / 0.8 kJ. Damage = the energy the car lost.
Measured (headless drive.mjs `poles`): lamp at 72 km/h -> ~59 km/h, 48 kJ; lamp at 15 km/h -> stopped, pole stands; tree at
50 km/h -> stopped, 138 kJ; hydrant at 45 km/h -> 29 km/h. Sheared poles topple as rods about their foot under real gravity
(~1 s for a 9.5 m lamp; fast hits throw the top back toward the car), can land on the player's car (energy 0.5 I w^2,
~13 kJ for a lamp onto a roof) and rest on it until it drives out. A knocked-down pole falls for the whole party.

## Building walls (nyc/breach.ts)

Buildings are solid boxes; nothing breaks on proximity any more. After each physics step, a car-to-building contact is
judged by the energy along the wall normal: glazed storefront 110 kJ (~45 km/h for a 1450 kg car, buildings over 60 m and
2/3 of mid-rise ones), brick/masonry 360 kJ (~80 km/h, buildings under 22 m and the rest). Below that the wall holds (Rapier
stop + core damage). Above: v_n' = sqrt(vn^2 - 2E/m) * 0.6, sideways * 0.7, damage = energy lost (both measured breaches
totalled the car). Only a 3.4 x 3.3 m hole opens: the box collider becomes upper floors + solid ground floor around a room
(<= 7.5 x 10 m) + a front wall with the hole; the room is furnished by building type (corner shop, deli, apartment, office
lobby) with fixed shelving / counters and light loose furniture; 12 brick/concrete chunks and two 430 kg ceiling slabs come
down on and around the car (Rapier bodies, GROUP_RUBBLE): it ends up pinned. The room is built from the drawn facade plane
(ray-cast once per breach: footprint boxes overhang recessed facades by up to metres).

Drawing: the room (unlit, baked light), then a colour-less depth "portal" box in the hole (renderOrder -1) so the facade
fails the depth test there; cars, furniture and rubble draw first (renderOrder -4, drawEarly). A camera-only collider in the
hole (GROUP_CAMERA_ONLY, seen by GROUP_VIEW rays) keeps the chase camera in the room with the car. All loose pieces share one
instanced mesh created at startup. Measured (headless drive.mjs `walls` / `wallperf`): 0 pipelines compiled on any crash
(was 2 for the old breached facade + 4 for car parts that broke off: those now sit on DEBRIS_LAYER, which the reflection
probe doesn't render); frame time after a breach = before (the old breached facade material was double-sided with discard
on every facade within 28 m: median 33 -> 45 ms).

