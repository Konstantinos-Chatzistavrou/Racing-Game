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
R recover · G menu · C camera · 1 ABS · 2 TC · 3 ESC · 5 auto gearbox · H hide HUD. Controllers, steering wheels and
phones work too (next section).

## Controllers, wheels, phones

The device you last touched drives; mix freely. **Controls** (title screen or pause menu) shows every device and its
settings.

- **Controllers**: Xbox, PlayStation (DualShock 4, DualSense), Switch Pro and any pad with the browser's standard
  mapping. Left stick steer, right / left trigger throttle / brake, bumpers shift, A / ✕ handbrake, B / ○ recover,
  Y / △ camera, X / □ lights, Start / Options pause. Button names in the HUD and menus follow the pad. The D-pad / stick
  and A / B drive the menus. Vibration from the physics (front tyres scrubbing, rear sliding or spinning, ABS, crashes)
  in Chrome / Edge.
- **Steering wheels**: any HID wheel (Logitech, Thrustmaster, Fanatec, Moza, Simucube, Simagic, Asetek, Cammus, PXN,
  OpenFFBoard...). Calibrate once in Controls (centre, full left, each pedal, paddles, buttons, optional H-shifter
  gates); every step finishes by itself, so no mouse is needed. Wheel rotation and the car's lock-to-lock are set there;
  the wheel drives the steering 1:1 with no filtering.
- **Force feedback** (Chrome / Edge on a computer, WebHID): **Connect wheel for force feedback** in Controls, pick the
  wheel once; afterwards it reconnects by itself. The force comes from the physics: steering-rack torque from the front
  tyres' aligning moments (goes light when the fronts let go), speed-dependent damping, a soft lock at the car's steering
  lock, and crash jolts; strength, a safety cap and the direction are adjustable and there is a test pulse. Protocols:
  the USB HID PID force-feedback standard (most direct-drive bases: Moza, Simucube, Simagic, Asetek, Cammus, VRS,
  OpenFFBoard) and Logitech's classic protocol (Driving Force GT, G25, G27, G29, G923 PlayStation version). Thrustmaster
  and Fanatec belt wheels and the Xbox G920 / G923 use closed protocols: steering and pedals work, force feedback
  doesn't. **Untested on real hardware so far** (the byte formats are unit-tested: `node web/tools/test_ffb.mjs`); if
  you try a wheel, please report what happens.
  Linux: the browser needs read / write access to the wheel's `hidraw` device, for example
  `/etc/udev/rules.d/70-opengrid-wheels.rules`:
  ```
  # Logitech, Thrustmaster, Fanatec, Moza, Simagic, Cammus wheels: let the logged-in user open them (WebHID)
  KERNEL=="hidraw*", ATTRS{idVendor}=="046d|044f|0eb7|346e|3670|3416", TAG+="uaccess"
  ```
  then `sudo udevadm control --reload && sudo udevadm trigger` and re-plug the wheel.
- **Phones and tablets**: on-screen steering pad and pedals, or **tilt steering** (Controls → Phone: Tilt; "Set
  straight" / the STRAIGHT button recentres; 35° tilt is full lock). Vibration on crashes and slides on Android.

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
