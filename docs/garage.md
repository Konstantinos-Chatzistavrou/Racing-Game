# Garage and customisation: current state (2026-11-10)

Everything here was built and screenshot-audited in this repo; treat it as the source of truth for the next session.

## Screens and layout

- **Tabs** (`web/src/menu.ts`, `GTABS`): `01 Paint · 02 Body · 03 Aero · 04 Fenders · 05 Wheels · 06 Lights · 07 Glass · 08 Driver · 09 Tune`.
  - Body: rear wing, front bumper, rear bumper. (Hoods are **disabled**, see Known bugs.)
  - Aero: front splitter, rear diffuser, side skirts, aero finish.
  - Fenders: fender flares (arch lips).
- **Heat-style frame**: header (brand, car name + class, kW/kg/µ, camera pills), left car list, right parts
  panel with sticky category title, far-right category rail, bottom action bar, live telemetry strip.
- **Phones**: compact layout keyed on `(pointer: coarse), (max-width: 1100px)`; telemetry strip hidden, columns
  76 / 1fr / 142 / 50 px, so the car keeps most of the screen.
- **Title screen**: career cards narrowed so the car sits fully visible beside the menu (studio env on it).
- **Live telemetry** (`liveStats()`): POWER kW+hp, WEIGHT, POWER/T, 0-100 estimate, DOWNFORCE m², TOP SPEED
  (drag-limited), DRAG CdA. Hovering a part previews its effect (green/red delta) without applying it.

## Data model

`web/src/custom-data.ts` → `Custom` fields: livery, liveryColor, wing, aero, rimColor, rimFinish, caliper,
headlights, smokedTails, underglow, tint, exhaust, splitter, diffuser, skirt, frontB, rearB, hood (disabled),
fenders, rims. `cleanCustom()` validates against the maps; the **cloud worker imports this file**, so it must not
import three.js — names live in `web/src/parts-names.ts` (generated).

## Part catalogs (all procedural, no external assets)

| file | count |
|---|---|
| `web/src/scene/parts/wings.ts` | 30 rear wings (10 families × 3) |
| `web/src/scene/parts/aero.ts` | 30 kits: 10 splitters, 10 diffusers, 10 skirts |
| `web/src/scene/parts/rims.ts` | 30 rim designs (axle +z, radius/width from context) |
| `web/src/scene/parts/body.ts` | 24 panels: 6 front, 6 rear, 6 hood (disabled), 6 fender ids |
| `web/public/assets/cars/v3/vela_front_wide.glb`, `vela_front_track.glb` | two Blender-authored replacement shells |

## How parts mount (`web/src/scene/custom.ts`)

- Built once against the car's model-space boxes at construction; hidden until selected.
- **Swaps hide the stock part**: wing (`stockWing`), splitter (`splitter` node), skirts (`skirt_L/R`),
  rims (`rimMeshes`), bumpers (`bumper_front`/`bumper_rear`).
- **Rims** are parented to `wheel_FL / FR / RL / RR` (wheel axle is x; the rim builder's axle is z, rotated ±90°).
- **Front/rear bumper kits** keep only their add-on meshes (lip, fins, canards); the full generated shell is
  dropped because it cannot follow the real bumper contour.
- **Fitted shells**: two designs derived from the stock bumper geometry at runtime, overridden by the Blender
  GLBs when they load (`setShells()`); the derived pair is the fallback.
- **Effects**: `web/src/parts-metrics.ts` is **measured** — `web/scripts/metrics.mjs` builds every spec in Node,
  measures bbox planform/frontal/volume and derives df/drag/kg. `partEffect(id)` (garage.ts) is the single
  lookup used by hints and the live panel. The two fitted shells have authored effects.

## Cameras

- **Driving** (`web/src/camera.ts`): `chase · far · cinematic · drift · hood · bumper · orbit`; `C` cycles;
  Settings → Camera persists the choice in `localStorage nr.cam`.
  - *drift*: heading follows velocity above 3 m/s, so the car hangs its tail out.
  - *orbit*: showcase pan (0.18 rad/s) with wall pull-in.
- **Garage camera convention (verified by screenshot)**: `cam(az, el, dist)`; **az = 0 is the FRONT**,
  az = π/2 the driver's (left) side, az = π behind. Presets in the garage header: 3/4, F 3/4, Front, Side,
  R 3/4, Rear, Low, Nose (`0,0.05,4.2`), Wheel, Top, Orbit (starts the turntable immediately).
- Pointer drag orbits, wheel zooms; the turntable resumes after `orbit.holdUntil`.

## Environment, launch and smoke

- **Studio env** (`web/src/scene/studio.ts`): softbox scene → PMREM; applied to the car's paint/glass/carbon on
  every non-driving screen (`showroomEnv()`), restored to the night-city probe when driving.
- **Launch control**: hold throttle during the countdown → `LAUNCH READY` (`#launch`); at GO the throttle is
  ramped 0.55 → 1.0 over 1.1 s (clamped in the tick) instead of instant full power.
- **Tire smoke**: `Particles` (from `scene/damage.ts`) at the rear contact patches, emitted when the core's
  slip ratio > 0.32, grey, opacity 0.15, every 3rd tick.
- Contact shadow and wheel animation (steer/spin/suspension from the core) already exist in `scene/car.ts`.

## Audit rule (non-negotiable)

Every part or car gets a screenshot before it ships: `web/tools/parts-probe.js` selects a sample of body/aero/rim
parts, moves the camera and saves a PNG each. Run:

```sh
cd web && npm run dev -- --port 5173 --strictPort
HEADLESS=1 PROBE=tools/parts-probe.js node tools/drive.mjs "http://127.0.0.1:5173/?menu=1&touch=0" /tmp/parts menu
```

## Known bugs / disabled features (2026-11-10)

- **Hoods are disabled**: the generated hood skins float above/behind the car (wrong seating). Geometry skipped in
  custom.ts and the Body tab section removed. Needs authored meshes or a correct panel transform.
- Bumpers are add-ons, not full shells; only the two fitted shells are true replacements.
- Parts quality is placeholder-grade: procedural boxes cannot match authored bodywork.
- NFS reference comparison not done yet: page fetches return text-only, need direct image URLs or files dropped
  into the repo.

## Performance constraints that shape this

- 30 fps locked on the i3/UHD laptop; frame is draw-bound (~206 draws baseline). Remote players cost ~30 draws
  each (traffic LOD), so parties stay at 6.
- The garage's 3D car is the hero asset (127k tris); extra parts are hidden objects, so their cost is only when
  selected.
