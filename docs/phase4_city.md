# Phase 4: night city street race

Racing-circuit features were removed on request (kerbs, catch fences, barriers, gantry, racing
lines); the circuit sources are kept in `archive/racing_circuit/` (not deleted: code is not in git).

## City (assets_source/scripts/make_city.py, regenerable)
- 7 x 5 irregular street grid on gentle hills (<= ~8 % grades), "Old Harbour District".
- alley 4.6 m (one lane, one-way), street 7 m (one lane each way, most common), boulevard 17 m
  (2+2 lanes + parking lanes). Raised 15 cm kerbs, sidewalks 1.5/2.5/4.5 m, lane markings,
  zebra crossings at boulevard junctions, traffic lights, 164 street lamps, shopfronts + neon.
- Race route: 1197 m loop (boulevard straight, 7 m streets, an alley chicane, tight 90-degree
  junctions). Corner radius `(w_in + w_out) / 2 + 1 m` (needs ~21 deg steering in alleys).
- 24 parked cars (physics bodies, asleep until hit) along the boulevard.
- Collision: road / pavement / walls tagged per surface; lamp and traffic-light poles collide.

## Rendering budget changes
- Wet-road lamp reflections now use a 2D lamp grid texture (14 m cells, 3x3 lookup): works for any
  street layout. Cost 0.4 ms.
- Car distance LOD: merged 6k-triangle / 6-material car beyond 30 m (from 34k / ~44 parts).
  Draw calls 491 -> 250.
- Rival headlights: only the 2 nearest rivals get real lights (5 spots cost 2.5 ms GPU).
- Car collision hull with bumper approach angle (underside rises 13 cm to each bumper) so noses
  clear kerbs on slopes; wheels are raycasts.

## Benchmark (6 racing cars + 24 parked, 1080p, 75 %, Mobile)
| camera | avg fps | 1% low | GPU ms avg/p99 | draws | tris max | VRAM | RAM |
|---|---|---|---|---|---|---|---|
| chase | 69.6 | 51.4 | 10.1/12.7 | 251 | 573k | 230 MB | 1.1 GB |
| bumper | 73.1 | 54.0 | 9.5/11.7 | 216 | 551k | 230 MB | 1.1 GB |
| street cam | 69.4 | 48.7 | 10.2/14.9 | 162 | 454k | 230 MB | 1.1 GB |
| orbit | 67.2 | 46.9 | 10.7/16.0 | 156 | 221k | 230 MB | 1.1 GB |
All above the 60 fps target (average) and the 45 fps floor (1% low). One-off shader-compile
hitches (150-600 ms) remain at first sight of new effects: a pipeline warm-up is still missing.

## Bugs found by the automated race and fixed
- A boulevard lamp post generated in the middle of a cross street (offset row not checked).
- AI treated parked cars on another street as "ahead" (route-space projection without an
  on-road check) and waited forever.
- Sustained pushing counted as one ever-growing crash (17,000 kJ): fixed with the 3 g force rule.
- Body box scraped kerbs on slopes: replaced by a hull with approach/departure angles.
- First-corner pile-up of the whole pack into a one-lane alley: route reordered; AI yields where
  lanes merge.

## Final automated race (6 AI cars, 2 laps, no human input)
5 of 6 finished both laps (best laps 75-85 s; a solo AI lap is 69 s). One aggressive rival wrecked
itself (423 kJ of crashes, engine destroyed) and was still limping round at the end. All cars
upright at the finish (respawn rule recovered the rest). Crashes seen: rear-end shunts between
tailgaters in the alley chicane, corner clips in the tightest alley junction.
