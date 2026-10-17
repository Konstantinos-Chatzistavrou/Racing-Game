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
Adaptive resolution keeps >= ~28 fps (steps of 10 % down to 50 %); `?scale=x` pins it.
Test: `drive.mjs <url> <out> mobile` emulates a 915x412 phone with multi-touch (gas + steer).
Real-phone frame rates are NOT measured yet (emulation runs on this laptop's GPU).
