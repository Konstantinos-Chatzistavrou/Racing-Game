# NFS Heat vs Open Grid - reference comparison (2026-11-10)

Reference frames (real 1920x1080, Steam app 1222680):
- https://store.steampowered.com/api/appdetails?appids=1222680 -> data.screenshots[].path_full
- shot 1: rear close-up at an event start, daylight, sun backlight, dense crowd/banners/palms
- shot 2: rear chase at speed, daylight, car fills the lower third, HUD speedo arc + circular minimap

Use the Steam API (JSON) rather than scraping pages: page HTML is age-gated and the images in article pages are
often unrelated thumbnails (verified: two "Heat screenshots" from a news page were Yoshi and a FF poster).

## What the references show

1. **Directional sun with real shadows.** Cars are lit by one strong key from above/behind, giving long specular
   ribbons, grounded contact shadows and readable form. Our night scene has a 0.04 moon + two point lights in the
   showroom and no shadow from the key.
2. **Camera is low and close.** Heat's chase sits behind and slightly below the roofline; the car fills the bottom
   third, horizon high. Ours is higher/further (DIST/HEIGHT constants) and the car reads smaller.
3. **Post-processing carries a lot of the realism.** Bloom on chrome/paint highlights, filmic tone mapping, mild
   chromatic aberration, motion blur at speed and a shallow DOF at the garage camera. We have tone mapping + grade;
   no DOF, no motion blur, bloom only in driving presets.
4. **Surface detail**: panel gaps, badges, decals at high resolution, wheel/tyre detail. Our hero car is a clean
   model with no panel-gap normals and procedural flake.
5. **Environment density** (crowd, banners, palms, props) sells "real world" more than per-car polycount.

## Fix order for us

1. Showroom key light with a real directional and a shadow (or a fake contact shadow at higher contrast) + studio
   softboxes already in `scene/studio.ts`.
2. Garage camera: lower elevation (~0.06) and closer distance (~5.2) to fill the frame like the reference.
3. Post: enable bloom on the garage pass and add a subtle DOF/vignette; reuse the driving post chain.
4. Chase camera: lower HEIGHT and shorter DIST (compare constants in `camera.ts`).
5. Panel-gap/badge normal detail and higher-res decals on the hero car (asset track).

## Where our screenshots stand (2026-11-10)

- Garage: studio env now applied, but the car is lit mostly by softbox reflections; no key shadows; no DOF.
- Fitted hood/rear shells: seat correctly (cloned from the car), but the hood clone picks a **dark liner mesh**
  (renders black) - paint per-mesh by original material, or pick the outer skin node.
- Body-kit "bumpers" from `body.ts` are add-ons; only the shell-clone route produces replacements.
