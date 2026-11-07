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
R recover · G menu · C camera · 1 ABS · 2 TC · 3 ESC · 5 auto gearbox · H hide HUD. Gamepads work too.

The compiled physics (`web/src/physics/rs_core.wasm`) is checked in. To rebuild it after changing
`core/`, install [Emscripten](https://emscripten.org/docs/getting_started/downloads.html) to `~/emsdk`
and run `npm run wasm`.

## Multiplayer (parties)

Parties are peer to peer (WebRTC through [PeerJS](https://peerjs.com/)): no game server to run. In the game:
**Play → Multiplayer → Create Party**, then send friends the invite link (`…/?party=CODE`, opening it shows a
**Join Party** banner on the title) or the 5-letter code. Up to 6 drivers. The leader picks **Race** (1/3/5/10 laps,
synchronised 3-2-1 once everyone has loaded, live running order, results with everyone's times) or **Free Roam**
together, and can send everyone back to the lobby. The leader's browser forwards each player's car pose and race
progress to the others; other cars carry name tags and are solid: each player's car is a physics body in everyone
else's game, placed where it is now (predicted from its last position and velocity), so cars bump, push and dent each
other. The leader's **Full Realism / Respawns** rule applies to the whole party.

The public PeerJS broker (`0.peerjs.com`) introduces the players and PeerJS's STUN/TURN servers get them through home
routers. To use your own broker instead:

```bash
cd server
npm i
npm start            # PeerJS on http://localhost:9000/peerjs, health at /health (PORT env to change)
npm test             # starts it and checks /health + id issue
```

and open the game with `?peer=your-host:9000/peerjs` (`wss://` prefix when served over HTTPS). Protocol checks over a
real broker: `node web/tools/party_test.mjs` (two headless peers) and `node web/tools/party_game_test.mjs` (two full game
windows), both with the Vite dev server running.

## Playing

**Street furniture is solid**: trees never break; lamp posts, signals, hydrants, bins, shelters and kiosks stop you when
you're slow and shear when you're fast enough, taking real speed off the car and denting it; a sheared pole topples
slowly under its own weight and can land on your car.

**Buildings are solid**: a storefront only gives way to a straight hit at ~45 km/h or more, a brick wall at ~80; anything
less is a hard crash. Breaking through costs most of your speed, wrecks the car, opens a hole into a furnished shop, deli,
apartment or lobby, and brings the ceiling down on top of you.

**Driving** (title screen): **Full Realism** (default) or **Respawns**. In Full Realism there is no reset in a race
(AI or party): a wrecked car, 5 s on its roof, or 30 s stuck is a DNF, and you spectate the remaining cars (◀ ▶ or
A / D to switch, Results to end). Respawns: R puts you back on the road, repaired. Free roam always allows R.

The game opens on a title screen that tunes the graphics once for the device (resolution and effects
level, behind a cover; the result is remembered; Auto / Max / Ultra / High / Medium / Low can be set there). Quality never
changes while a car is on screen. **Play** opens the game modes:

- **Race**: a 6-car grid, you (P4) against 5 AI rivals, 1/3/5/10 laps, 3-2-1 start, live position and running order,
  results with everyone's finishing order and gaps.
- **Free Roam**: just you in the open city, lap timer running.
- **Multiplayer**: the party lobby (above).

**Garage** (from the title) is for the car only: pick a car, paint and finish, upgrades (engine, tyres, weight, aero;
applied to the physics data). From there go back to the **Main Menu** or **Continue** to the game modes. Esc pauses:
resume, restart or quit to the main menu. R (when allowed) puts you back on the road where you are (race, party) or at
the start (free roam). The results screen has **Spectate** while others are still racing. Details in `docs/web_port.md`.

## Layout

| Path | What |
|---|---|
| `core/` | C++17 physics + game logic (tyres, drivetrain, assists, damage, AI, race rules), no engine deps, with tests |
| `server/` | Optional self-hosted PeerJS matchmaking for parties (the game defaults to the public broker) |
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

## Licence

Two licences (details per folder in `LICENSING.md`):

- **Code** (C++ core, TypeScript, shaders, scripts, server): **GNU Affero General Public License v3.0 or later**
  (`LICENSE`, SPDX `AGPL-3.0-or-later`). The Affero licence covers the web: anyone who plays a modified version over a
  network must be offered its source (the title screen links to it). Code from GPL-3.0 / LGPL-3.0 / Apache-2.0 / MIT /
  BSD projects can be included; GPL-2.0-only code can't (not compatible with v3).
- **Everything else we made** (3D models, textures, car and track data, docs): **Creative Commons
  Attribution-NonCommercial 4.0** (`LICENSES/CC-BY-NC-4.0.txt`, SPDX `CC-BY-NC-4.0`): free to share and adapt with
  credit, no commercial use.
- **Third-party material** keeps its own licence, listed in `CREDITS.md`: map data ODbL (OpenStreetMap), the fitted tyre
  data BSD-3-Clause (Project Chrono), original car models CC BY 4.0, city models and textures CC0.
