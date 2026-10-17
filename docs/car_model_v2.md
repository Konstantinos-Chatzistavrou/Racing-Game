# Car model, generation 2 (2026-10-17)

The generation-1 car (`make_car.py`, superellipse loft) read as a blob in game. No usable CC0
car exists: Sketchfab's CC0 "cars & vehicles" results are museum scans, Poly Haven has only a
covered car, and the free low-poly packs are toy-like. Free realistic cars mostly copy real brands,
which is a trade-dress problem. So the car is an original design, generated in Blender:
`assets_source/scripts/make_car2.py` (reuses materials/wheels/LOD helpers from `make_car.py`).

## Method
- Control cage: 22 stations x 16-point rings (sill, widest point, shoulder crease, hood/deck),
  hand-built nose/tail faces. Subdivision level 3, shoulder edge creased (0.75).
- Greenhouse: separate 7-station sheet (windshield, roof, fastback) sitting on the body.
- Every cage face carries a part tag (material index). Subdivision and the arch booleans keep it,
  so panel/window boundaries are smooth curves. Tags survive EXACT booleans only through material
  slots (no slots = everything becomes index 0).
- Panels are split by tag; each edge is pulled in 2.8 mm -> real shut lines.
- Lights, grille, intakes, splitter, diffuser, door handles: 2D outlines ray-cast onto the body
  (BVHTree), so they follow the surface; rays that miss leave holes rather than stray strips.
- Same package as gen 1 (L 4.50, wheelbase 2.65, track 1.61, 245/35 R19 at the same axles):
  physics data, collision hull and visual JSON stay valid. New detail parts were added to the
  `panels` lists in the three `*.visual.json` files.

## Budget and benchmark
63k triangles in 62 parts (bumpers 4.4k each after decimation, wheels 3.8k each, interior shell
4.4k, every other panel <= 2.6k). LOD 6k triangles / 6 materials (unchanged pipeline).

The shell is deliberately split into small panels (fenders, quarters, rockers, cowl, deck): the
dent code in `damage_visuals.gd` walks every vertex and triangle of each panel near an impact in
GDScript. With one 14k-triangle `body` mesh, AI bumps in the race halved the frame rate.

Race benchmark, 6 cars, chase cam, 30 s, 1080p fullscreen, same machine and settings (A/B):
| car | avg fps | 1% low | frames > 33 ms | GPU ms | draws avg |
|---|---|---|---|---|---|
| gen 1 | 66.2 | 40.8 | 5 | 10.5 | 358 |
| gen 2, one-piece body | 33.7 | 24.3 | 219 | 10.9 | 428 |
| gen 2, split panels (shipped) | 64.7 | 41.0 | 2 | 10.8 | 477 |

## Verified
- Crash test (car B into parked car A): 55 km/h -> 0.26 m crush, dented panels, dead headlights;
  90 km/h -> 0.44 m crush, front bumper detaches, hood folds, engine smoke (35 % engine damage).

## Bug fixed on the way
Wheels vanished on frozen cars (menu, garage, countdown): `RSVehicle::_process` placed wheel
visuals from physics output that did not exist yet (all zeros -> world origin). It now skips
until the first physics step (`has_output_`).

## Anti-aliasing (2026-10-17)
The "visible pixels" were not the model: 3D rendered at 75 % with bilinear upscaling and no
anti-aliasing. Added Settings -> Display -> Anti-aliasing (Off / MSAA 2x / MSAA 4x, viewport
`msaa_3d`). User accepts ~30 fps for image quality. Race benchmark, chase cam, 30 s:
| setting | avg fps | 1% low | GPU ms avg/p99 | VRAM |
|---|---|---|---|---|
| 75 %, no AA | 63.4 | 41.0 | 10.8 / 13.2 | 231 MB |
| 75 %, MSAA 2x | 57.1 | 33.9 | 11.9 / 14.7 | 253 MB |
| 100 %, MSAA 2x (user's setting) | 42.1 | 28.5 | 18.5 / 22.7 | 288 MB |
