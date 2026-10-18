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
