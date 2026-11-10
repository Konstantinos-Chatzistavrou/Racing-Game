# Parts, panels and the garage camera (conventions that bite)

Everything here was learned the hard way; read it before touching `scene/parts/*` or `scene/custom.ts`.

## Model space

- `CarCustomizer.box` is the car's body box **in model space**, computed with the inverse of the model's world
  matrix. Everything a part builds is positioned in that same space.
- **+z is the FRONT.** Verified: wheel_FL/RL sit at z = +1.18 / -1.47; the bonnet box is z 0.89..2.05.
- Real panel boxes from the model (measured, metres):

| node | x | y | z |
|---|---|---|---|
| car | -1.01..1.01 | 0.03..1.09 | -2.05..2.10 |
| `hood` | -0.95..0.95 | 0.12..0.83 | 0.89..2.05 |
| `bumper_front` | -0.90..0.90 | 0.11..0.65 | 1.54..2.10 |
| `bumper_rear` | -0.93..0.93 | 0.09..0.68 | -2.05..-1.59 |
| `wing` (stock) | -0.69..0.69 | 0.82..1.01 | -2.05..-1.74 |

**Do not invent panel boxes.** The old synthetic hood box sat at y ~1.03-1.11, i.e. **above the roof**: hood parts
floated in the air. Use `boxOf(name)` on the real node (custom.ts) and fall back to a synthetic box only when the
node is missing.

## Part classes (what is a replacement vs an add-on)

- **wings / rims / shells**: replacement. Hide the stock node and attach the generated mesh at the same place.
- **splitters, skirts, diffusers**: add-ons. Keep the stock bumper; the part bolts under it.
- **front/rear bumpers**: generated full shells cannot follow the real bumper contour yet, so each design keeps its
  add-on pieces (lip, fins, canards, intake walls) and drops its largest mesh (the shell).
- **hoods**: crowned skin built from the real `hood` box (skin sits at `hood.max.y + 0.01`).
- **fenders**: half-torus arch lips over the wheels (front z +1.18, rear z -1.47, wheel centre y 0.34).

## Garage camera convention

`cam(az, el, dist)` in `main.ts`: `orbit.az = atan2(forward) + az`, and the camera sits at
`(sin az, el, cos az) * dist + target`. Therefore **az = 0 is the FRONT view**, `1.57` the driver's side,
`3.14` the rear. The labels in `menu.ts` (3/4, F 3/4, Front, Side, R 3/4, Rear, Low, Nose, Wheel, Top) follow that;
"Nose" is `0,0.05,4.2`.

The garage turntable keeps rotating after `orbit.holdUntil`; a preset sets it to now+15 s. For a deterministic
screenshot, set `__game.orbit.az/el/dist`, `holdUntil = now + 1e7` and `drag = true` (probes do this).

## Screenshot gate

Every part and car gets a screenshot before it ships:

```
HEADLESS=1 PROBE=web/tools/parts-probe.js node web/tools/drive.mjs "<url>?menu=1&touch=0" /tmp/parts menu
```

## Textured assets for Blender

The hero car GLB is meshopt + KTX2; Blender cannot read either. Decode meshopt with `gltf-transform`, then run
`node web/scripts/decode-ktx2.cjs in.glb out.glb` (needs `npm i basis_universal`) - it unpacks every KTX2 to PNG,
rebuilds the GLB and drops `KHR_texture_basisu`. Verified: 12/12 textures, Blender imports 60 meshes with 12 live
512x512 images.
