# Performance: what is worth optimizing (measured 2026-10-17, i3-1315U)

Rule: optimize only what a measurement shows is slow AND what survives the move to Unreal.
Godot rendering work (lighting, shaders, draw calls, LODs) is redone in Unreal: not worth it now.

## Core (transfers to Unreal) - `core/build/rs_bench`
8 AI cars on the city route, 240 Hz:
| part | per car per tick |
|---|---|
| AI driver + controls | 12.1 us |
| vehicle physics | 3.0 us |
| race tracker | 1.4 us |
| total, 8 cars, one 60 fps frame (4 ticks) | 0.53 ms (~3 % of 16.7 ms) |
Verdict: nothing to optimize. Re-run after changing anything that runs every tick.

## Game (Godot, test bench only)
- Frame rate is GPU-bound (~11 ms GPU at 75 %, ~18.5 ms at 100 % + MSAA 2x).
- Per-frame GDScript must stay cheap: the car dent code costs time per vertex of each panel near an
  impact, so deformable panels stay small (see docs/car_model_v2.md: one 14k-triangle body halved fps).
