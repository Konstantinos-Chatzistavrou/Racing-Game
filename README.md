# Racing Game

Realistic-handling street racing sim: an illegal night race through a city, with crash damage and
AI rivals. The game runs in the browser on **WebGPU** (three.js r186). Its vehicle physics is an
engine-independent C++ core compiled to WebAssembly.

## Run the web build

Requirements: Node 20+, a browser with WebGPU. Chrome on Linux needs `chrome://flags` →
**Unsafe WebGPU Support** + **Vulkan** (check `chrome://gpu` → "WebGPU: Hardware accelerated").

```bash
cd web
npm install
npm run dev          # http://127.0.0.1:5173
```

URL options: `?scale=0.75` (render resolution), `?bloom=0`, `?aa=0`, `?shadows=0`.

Controls: W/S throttle and brake · A/D steer · Q/E shift · Space handbrake · Shift clutch ·
R reset · C camera · 1 ABS · 2 TC · 3 ESC · 5 auto gearbox · H hide HUD. Gamepads work too.

The compiled physics (`web/src/physics/rs_core.wasm`) is checked in. To rebuild it after changing
`core/`, install [Emscripten](https://emscripten.org/docs/getting_started/downloads.html) to `~/emsdk`
and run `npm run wasm`.

## Multiplayer (optional)

A minimal relay in `server/` (Express + ws) forwards each player's car pose to the others. No
authority or collisions between players yet: you see the other cars, they pass through you.

```bash
cd server
npm i
npm start            # ws://localhost:8787, health check at http://localhost:8787/health (PORT env to change)
npm test             # starts the server and checks welcome / state relay / validation / leave with two clients
```

Then open the game with `?mp=1` (relay on the page's host, port 8787) or `?mp=ws://host:port`.
Without `?mp` the game is single-player and opens no connection. The HUD's second line shows
`online · N players`.

Hosting: the Vercel deployment serves only the static game. The relay needs a long-lived process:
Vercel Functions can accept WebSockets through `ws` with Fluid Compute, or run `server/` on
Render or Fly.io. A page served over HTTPS must use `wss://`.

## Playing

The game opens on a title screen that tunes the graphics once for the device (resolution and effects
level, behind a cover; the result is remembered; Auto / High / Medium / Low can be set there). Quality never
changes while a car is on screen. **Start** opens the garage: pick a car (three trims of the Vela GT), paint
and finish, four tuning steps (engine, tyres, weight, aero; applied to the physics data), then a mode:
**Free run**, **Race** (1/3/5/10 laps, 3-2-1 start, results screen) or **Online** (enter a relay server address,
Check, Join). Esc pauses: resume, restart or back to the garage. Details in `docs/web_port.md`.

## Layout

| Path | What |
|---|---|
| `core/` | C++17 physics + game logic (tyres, drivetrain, assists, damage, AI, race rules), no engine deps, with tests |
| `server/` | Optional multiplayer relay (Node, Express + ws) |
| `web/` | Browser game: three.js WebGPU renderer, Rapier rigid bodies, WASM bridge (`web/wasm/bridge.cpp`) |
| `data/` | Car and track data (JSON, engine-neutral) |
| `assets_source/` | Blender sources and full-resolution textures |
| `docs/` | Physics model, validation results, performance measurements, porting notes |
| `archive/` | Earlier circuit prototype |

## Native core tests

```bash
cmake -S core -B core/build && cmake --build core/build -j && ./core/build/rs_tests
```

## Validation

Handling is matched to a Corvette C7 Z51: 60-0 mph 31.7 m (real 31.7-32.6 m), skidpad 1.04 g,
0-60 mph 3.92 s. The WebAssembly build reproduces the native results exactly. Details in
`docs/handling_reference.md` and `docs/web_port.md`.
