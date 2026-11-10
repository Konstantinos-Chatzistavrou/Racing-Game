# CC0 asset sources and the authored-part track (2026-11-10)

## What exists as CC0 (verified)

| source | URL | licence evidence | what it gives us |
|---|---|---|---|
| Kenney Car Kit | https://kenney.nl/assets/car-kit | page states **CC0** (checked) | low-poly cars (not part meshes) |
| Quaternius | https://quaternius.com/ | site states **CC0** (checked) | low-poly vehicles, props |
| Poly Haven | https://api.polyhaven.com/assets?type=models | API/models are **CC0** (checked) | HDRIs and props; HDRIs would improve reflections |

**No CC0 marketplace ships standalone hood/bumper meshes that fit an arbitrary car.** Free model sites that do have
such parts (Sketchfab, CGTrader, Free3D) are account-gated or CC-BY/NC and would need per-model attribution or a paid
licence, and the parts still would not fit without re-modelling.

## The workable route (used here)

1. Fit parts to **our own car mesh** in Blender (the car is already ours, so no licensing question on the shapes).
2. Source CC0 **full cars** for new vehicles from Kenney/Quaternius, then build their physics/visual configs.
3. Use Poly Haven CC0 HDRIs for studio/street reflections.

## Authored parts shipped

Produced from the decoded car GLB (`web/scripts/decode-ktx2.cjs`) in Blender 5.2.3, exported to
`web/public/assets/cars/v3/` and loaded by `main.ts` -> `CarCustomizer.setExtraParts`:

| file | option id | how it was made |
|---|---|---|
| `vela_hood_domed.glb` | `hood-blender` | duplicate the `hood` mesh, +2 % width, parabolic dome |
| `vela_rear_wide.glb` | `rear-blender` | duplicate `bumper_rear`, +5 % width, pushed 4 cm out |

Both are fitted by construction (cut from the car's own panels), painted with the body material in game, and listed in
the Body tab as "Domed (authored)" / "Wide (authored)". `vela_front_wide.glb` / `vela_front_track.glb` remain the
front pair.

## Verification status

- `vela_rear_wide` rendered and seats correctly (screenshot audit).
- `vela_hood_domed` compiled and wired, but the capture run produced no frame (harness flake), so it is **not yet
  screenshot-verified**. Re-run `web/tools/parts-probe.js` before shipping.
- Generated `body.ts` bumpers remain add-ons; the clone route is the only true replacement path.
