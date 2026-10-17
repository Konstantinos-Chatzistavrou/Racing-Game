# Racing Game

Realistic-handling street racing sim: an illegal night race through a city, with crash damage and
AI rivals. The game runs in the browser on **WebGPU** (three.js r186). Its vehicle physics is an
engine-independent C++ core compiled to WebAssembly, the same code the earlier Godot build used.

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

## Layout

| Path | What |
|---|---|
| `core/` | C++17 physics + game logic (tyres, drivetrain, assists, damage, AI, race rules), no engine deps, with tests |
| `web/` | Browser game: three.js WebGPU renderer, Rapier rigid bodies, WASM bridge (`web/wasm/bridge.cpp`) |
| `data/` | Car and track data (JSON, engine-neutral) |
| `game/` | Godot 4.7 build (reference) and the exported glTF assets the web build uses |
| `godot_ext/` | GDExtension wrapper for the Godot build |
| `assets_source/` | Blender sources and full-resolution textures |
| `docs/` | Physics model, validation results, performance measurements, porting notes |
| `archive/` | Earlier circuit prototype |

## Native core tests

```bash
cmake -S core -B core/build && cmake --build core/build -j && ./core/build/rs_tests
```

## Godot build (optional)

Needs Godot 4.7.2 and [godot-cpp](https://github.com/godotengine/godot-cpp) checked out at
`godot_ext/godot-cpp` (plus `godot --dump-extension-api` into `godot_ext/api/`); then
`tools/build_ext.sh`. Neither is in the repo.

## Validation

Handling is matched to a Corvette C7 Z51: 60-0 mph 31.7 m (real 31.7-32.6 m), skidpad 1.04 g,
0-60 mph 3.92 s. The WebAssembly build reproduces the native results exactly. Details in
`docs/handling_reference.md` and `docs/web_port.md`.
