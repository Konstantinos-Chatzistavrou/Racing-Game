# Art direction: Need for Speed Underground, at 30 fps

The target look is Underground, not a simulator: the car should read as *better than real life* - deeper
paint, harder highlights, neon in the reflections - while the frame still holds 30 fps on the laptop (the
auto-tuner spends resolution for that; docs/performance.md).

## Pillars

1. **Night is the set.** Near-black streets, wet asphalt, every light doubled by its reflection.
2. **Neon is the palette.** Saturated cyan / magenta / amber, with bloom doing the halo work.
3. **The car is the hero.** Paint deeper than reality, clearcoat and flake you can see, chrome that catches
   neon, underglow that pools on the road.
4. **Speed is felt** through camera, FOV, sparks, debris and grain.

## What already exists

- Paint (`scene/car.ts`, `garage.ts FINISHES`): gloss / satin / metallic / pearl / candy / matte; clearcoat 1
  at 0.024 roughness with an orange-peel normal; iridescence on pearl; procedural metal flake; envMapIntensity
  1.45; chrome / gloss / satin / matte rim finishes; caliper and headlight tints.
- Underglow (`scene/custom.ts`): an additive ground pool under the car, colour a uniform. It emits no light
  (a real light would recompile every material).
- City: neon signage, lamp pools, wet-road SSR (0.35 target), GTAO on max, bloom 0.45 strength / 0.45 radius /
  1.0 threshold, AgX tone map, grade (contrast, saturation, split, lift, exposure), film grain.
- Effects: sparks, debris, glass shards, steam.

## Gaps, cheapest first

1. **Grade is too naturalistic.** Underground is saturated with a purple/teal split and crushed blacks. The
   grade uniforms are URL-tunable (`?contrast= ?sat= ?split= ?lift= ?exposure=`) - try values on a screenshot
   before changing `fx/grade.ts` defaults.
2. **Underglow is too timid.** Widen and brighten the pool, let it tint the wheels and the car's underside,
   and give it a faster falloff (NFS pools are about a car width and vivid).
3. **Bloom should favour emitters.** Neon signs need bigger halos than the car body; raising strength washes
   the paint. Consider a threshold that only catches sign/neon luminance.
4. **Hero rim light on the street.** The showroom has kicker lights (`showRim` in main.ts); at night the car
   should still catch a coloured edge from the city - through the reflection probe rather than a new light.
5. **Camera.** Lower and wider at speed; the showroom orbit already reads Underground.

## Rules

- Every visual change is measured: fps at the pinned vantage (`window.__prof`, `drive.mjs profile`) plus a
  before/after screenshot at the same spot, and the tuner must still hold 30 fps.
- No quality changes while driving (front end only), as decided.
- Reflections stay screen-space (SSR); a planar mirror pass for the road is a later option if the budget allows.
