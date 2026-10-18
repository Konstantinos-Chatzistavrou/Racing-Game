# Free assets for the night street-racing game (research 2026-10-18)

Scope: free assets with licences that allow **commercial** use and **modification** for a web game
(three.js r186 WebGPU, served from Vercel). Every licence statement below was checked on the
licence page itself or through the site's API on 2026-10-18. Anything not checked is marked
**UNVERIFIED**. This is research notes, not legal advice. Check the licence on each asset page again
on the day you download it, and keep a screenshot or PDF of that page in `assets_source/licenses/`.

**Headline result.** The old note "No usable CC0 realistic car exists" is **partly overturned**:

* **Khronos glTF Sample Assets, "CarConcept"**: a web-optimised glTF concept car (about 114k
  unique triangles, PBR, clearcoat, transmission glass, iridescent paint variant, interior, opening
  doors) under **CC BY 4.0**. It is derived from a **CC0** source car by "Unity Fan". The design is
  original, so there is no car-brand trade dress to worry about. The only branding is Khronos logos,
  which have to be removed.
* **Unity Fan's "FREE Concept Car 0xx" series on Sketchfab**: original human-made concept cars,
  140k to 1M faces. Each description says "This is public domain (CC0) … can be used by anybody for
  anything. No attribution required." Caveat: Sketchfab's own licence field for these models now
  says **"Free Standard"**, not CC0 (see section 2.1).
* Still true: no **CC0 realistic street car** (sedan or tuner style, not a concept car) of hero
  quality exists. The realistic CC-BY cars on Sketchfab are almost all copies of real brands.

---

## 1. Licence cheat-sheet

| Licence (where seen) | Commercial | Attribution | Modify | Notes for a web game |
|---|---|---|---|---|
| **CC0 1.0** (Poly Haven, ambientCG, Kenney, Quaternius, 3dtextures.me, Freesound CC0, Khronos ToyCar) | Yes | No (credit appreciated) | Yes | Best case. No extraction clause, so raw .glb/.ktx2 files on Vercel are fine. Trademarks are *not* waived (CC0 §4a). |
| **CC BY 4.0** (Sketchfab "CC Attribution", Khronos CarConcept, Freesound CC-BY) | Yes | **Yes**: creator, copyright notice, licence link, link to source, and **state that you modified it** | Yes | Credits must be reachable in the game (credits screen + CREDITS.md). Do not add DRM that stops others using the CC-BY material ("no technological measures", §2a5B). |
| CC BY 3.0 (some OpenGameArt items) | Yes | Yes (also the title) | Yes | Same as 4.0, and the **title** is also required. |
| CC BY-SA 4.0 | Yes | Yes | Yes, but **derivatives must be BY-SA** | Avoid for core art. A modified BY-SA mesh has to be shared alike. |
| CC BY-NC / NC-SA / NC-ND | **No** | n/a | n/a | **Excluded.** |
| CC BY-ND | Yes | Yes | **No distributed modifications** | **Excluded** (we have to de-brand, LOD and compress). |
| **Sketchfab "Free Standard" / "Standard"** | Yes | Not generally | Ambiguous (verified: the page never clearly grants modification) | Single-seat. Must not make the asset available "as a stand-alone file" or in a way that invites extraction (§2.2b/h). §12 asks for a firewall. **Raw GLBs on a public web server are a poor fit.** Use only when the author also gave a CC0 dedication (Unity Fan case). |
| Sketchfab "Editorial" | **No** | – | Technical edits only | **Excluded.** |
| **Fab Standard License** (fab.com/eula, checked in a real browser) | Yes | No ("You are not required to give credit") | Yes | Explicitly "not limited to Unreal Engine". **But** §3: when you distribute a Project "you must restrict end users from extracting or otherwise using Content outside of the Project". Also no stand-alone resale, and **NoAI** content cannot be used for generative-AI training. Personal tier is only for teams under $100k revenue, with the same scope of rights. Web risk: **medium**. Ship only behind an EULA plus a packed or obfuscated asset format, or prefer CC0. |
| Fab CC-BY items | Yes | Yes | Yes | Governed by CC BY, not by the Fab Standard License (EULA §2c). |
| **BlenderKit (now branded "Blendkit") Royalty Free** | Yes ("Everything you download is available for commercial use") | No | Yes | Forbids "re-sale of the asset in the same form … even if modified". A raw GLB inside a web game is a grey zone, and the page says nothing about games, web or extraction. Many free assets are CC0 instead, so prefer those. |
| BlenderKit CC0 | Yes | No | Yes | Fine. |
| **TurboSquid Royalty Free** (incl. free models) | Yes | No | Yes | Games: models "must be contained in proprietary formats" and "cannot be opened or imported in a publicly available software application". Only WebGL **exports from Unity/Unreal/Lumberyard/Stingray** are allowed, and "other WebGL methods generally need approval". three.js + GLB = **not allowed without approval.** Editorial products: news only. |
| **CGTrader Royalty Free** (free items carry whatever licence the seller chose) | Yes | No | Yes | Games: "must take all commercially reasonable measures to prevent the end user from gaining access to the Product". Free downloads may not be used for ML training. Raw GLB on the web = risky. |
| **Sonniss GDC Game Audio Bundle** | Yes, "royalty free and commercially usable" | No | Yes ("Layer them, stretch them, pitch them, mangle them") | **No AI/ML training.** Cannot be redistributed as sound effects, even edited. Fine inside a game. The full licence PDF was not fetched (**summary verified, PDF UNVERIFIED**). |
| **Freesound** | CC0 and CC BY 4.0: yes. CC BY-NC: **no** | CC BY: name the sound, author, link and licence | Yes | Filter searches by licence. Each pick below was checked on its own page. |
| **ShareTextures** "custom CC0" | Yes | No | Yes | Not pure CC0: "No asset redistribution on other websites, in plugins, or as part of collections". Inside a game is fine. |
| **cgbookcase** | Yes. Home page: "100% free, no restrictions" | No | Yes | The formal licence page returned 404, so **PARTLY VERIFIED** (historically CC0). |
| **Textures.com free tier** | Yes | – | Yes | Redistribution "as competing products … even when modified or if you give them away for free" is forbidden. Raw textures in a web build are a grey zone. Only a search snippet was readable (JS page), so **PARTLY VERIFIED. Avoid; CC0 sources cover everything.** |
| **Poly Pizza** | Per model (CC0 or CC-BY) | Per model | Yes | ToS: "adhere to the terms of the Creative Commons license that applies at the time of download". |
| **Kenney** | Yes (CC0) | No ("Do not use our logo") | Yes | Verified on kenney.nl/support. |
| **Quaternius** | Yes (CC0) | No | Yes | Verified in the FAQ. |
| **Smithsonian Open Access** | CC0 (as labelled on their Sketchfab models via API) | No | Yes | si.edu FAQ returned 403, so **PARTLY VERIFIED**. Little use here. |
| **NASA** | Generally no US copyright | Credit NASA | Yes | Insignia and logos are protected, and nothing may imply endorsement. Not relevant to this game. |
| **Free3D** | Per item; many free items carry a "Personal Use" licence | – | – | free3d.com/terms-of-use returned 403 (also in a real browser): **UNVERIFIED → avoid.** Third-party sources say TurboSquid runs it. |

**Trademark rule (applies to every licence above).** A copyright licence on a mesh never clears car
makers' **trademarks and trade dress**: names, badges, grilles (for example a kidney grille), light
signatures, iconic body shapes (911, AE86, Countach). CC0 §4a says so explicitly. Treat any
real-brand car as needing the de-branding in section 4. For iconic shapes that is effectively a
re-model.

---

## 2. Shortlist by category

Specs come from the Sketchfab API (`faceCount` = triangles as shown by Sketchfab), the Poly Haven
API (`polycount`), or `gltf-transform inspect` (CarConcept only, downloaded to the scratchpad and
not into the repo). Sketchfab models with **CC-BY or Free Standard** can be downloaded as glTF
(auto-converted) plus the original upload format. Texture resolution is visible only after login,
so check it on download.

### 2.1 Cars: hero / player and rivals

| # | Asset | Author | Licence (verified how) | Specs | Trademark risk |
|---|---|---|---|---|---|
| **C1** | **CarConcept**: https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CarConcept | Eric Chadwick; © 2024 Darmstadt Graphics Group GmbH; based on Unity Fan's CC0 Concept Car 004 | **CC BY 4.0** (repo `metadata.json`) | GLB 11.8 MB. 44 meshes, **~114k unique triangles** (~213k rendered: the wheels are instanced). Materials: 29, including clearcoat car paint (3 variants: Carmine Candy, Pearly Swirly with iridescence, Torched Graphite), transmission glass and emissive lights. Textures: one 2048² AO (2nd UV set), the rest 32² to 1024² (normals, tread 512×128). Also shipped as `glTF-KTX-BasisU-Draco` (10.3 MB download, 14.9 MB VRAM vs 48.8 MB). Doors and hood are separate with pivots. Interior included. Extensions: clearcoat, emissive_strength, iridescence, transmission, variants, texture_transform. | **Low for car brands** (original concept design). **Must remove** the Khronos and 3D Commerce logos (Khronos "LegalMark" licence; check the `License` plate material and the `Dashboard`/hardware emissive textures). Futuristic styling, so it reads as "concept supercar", not as a street tuner. |
| **C2** | **FREE Concept Car 004**: https://sketchfab.com/3d-models/4cba124633eb494eadc3bb0c4660ad7e (the source of C1, unoptimised) | Unity Fan (unityfan777) | Description: "This is public domain (CC0) … No attribution required". Sketchfab field: **Free Standard** (API) | 406k faces, 6 animations, FBX/glTF/USDZ | Low (original). |
| **C3** | **Unity Fan concept cars**, more designs: 001 `af71d64a89c04f5fb62a06bdd92c045b` (143k), 003 `77664fc474c444f4947e9834ed0d30ad` (762k), 006 `a4e19bb6e6394c4a95d4319ef7d265ba` (544k), 007 `7b85bf60f7274802aaf32d27ed67fc59` (1.04M), 011 `099f72bca4494ef9af317e8d76cd99af` (320k), 033 `58f9d30f8e734de8ba05fa64e0e6584a` (219k), 037 `646a3a31b0224379b6e767abc34d58dd` (198k), 038 `0b4ca2a15ba7478db2a42ac9f0e687bf` (293k), 040 `9363e93183274ea1bad403ea6fe3ee79` (292k). URL = `https://sketchfab.com/3d-models/<id>` | Unity Fan | Same as C2 (CC0 statement in the description; Free Standard field) | Heavy source meshes with making-of videos linked (human-made). Need retopo/decimation to ≤150k. | Low. **Skip "Ai based ConceptCar 050/051"**: AI-generated, so authorship and copyright provenance are uncertain. |
| **C4** | **Fictional supercar – V12 Goblin**: https://sketchfab.com/3d-models/0a20e49ad5774d778567cb5c3f345786 | Olli Teittinen (ollitei) | **CC BY 4.0** (API) | 86.6k faces, exterior only (**no interior**), 2012 design project (covered by seriouswheels.com) | **Low**: original design. Rename the car in game anyway. Best "realistic supercar" look among the free originals. |
| C5 | **Gourami – Luxury Saloon**: https://sketchfab.com/3d-models/bf29aca039c447ab913608e3f6818875 | ministephen (Fishboe) | **CC BY 4.0** (API) | 108k faces | Low: self-designed. Has a chrome-heavy luxury grille; make sure it is not close to a Rolls-Royce or Bentley grille. |
| C6 | **Tokii Abyss GT.7 V12**: https://sketchfab.com/3d-models/c399568541104e0e903cf138b1e24908 | fiendishfarlander76 (Glas'kavin) | **CC BY 4.0** (API) | 158k faces, rigged, **no UVs** ("excluding UVs") | **Medium**: author says "inspired by the McLaren Sabre". Reshape the nose, lights and side intakes. Needs UV unwrap. |
| C7 | **Cyberpunk car**: https://sketchfab.com/3d-models/b4301ff99d214d16a7a43708a5866bf0 | 3d_Bob (4d_Bob) | **CC BY 4.0** (API) | 11.4k faces (school project, <12k tris) | Low to medium: "inspired by cyberpunk 2077". Good as a cheap AI rival. |

**Recommendation.** Keep the in-house `make_car2` car as the main player car (its trade dress is
clean and it is built for the dent system). Add **C1 (CarConcept)** as the first "exotic" unlock and
benchmark material reference (its paint, clearcoat and glass setup is a model to copy). Add **C4
(V12 Goblin)** after building an interior shell and splitting panels for damage. The Unity Fan cars
(C3) supply more original shapes for rivals after heavy decimation.

**Free Standard vs. CC0 on Unity Fan models.** The author's written dedication is a public CC0
waiver, and Khronos accepted it ("started from a public domain 3D model created by Unity Fan").
Sketchfab's licence field, however, says Free Standard. To be safe: (a) archive the model page
showing the CC0 text, (b) prefer **C1**, which comes through Khronos under clean CC-BY, and (c) if
in doubt, ask the author on Sketchfab or YouTube for written confirmation.

### 2.2 Cars: traffic, police, taxis (≤30k triangles)

| # | Asset | Author | Licence | Specs | Trademark risk |
|---|---|---|---|---|---|
| **T1** | **Generic passenger car pack**: https://sketchfab.com/3d-models/20f9af9b8a404d5cb022ac6fe87f21f5 | Comrade1280 | **CC BY 4.0** (API) | 10 cars, 69k faces total: sedan 7.1k, wagon 7.0k, hatch 6.8k, compact 7.3k, coupe 6.0k, minivan 7.5k, sport 6.3k, pickup 6.9k, SUV 8.0k, offroad 6.5k tris. 6 colour textures each, plus metallic/gloss/opacity maps | **Low**: the author states "minimum to none similarities to real life cars and completly trademark clame proof". |
| **T2** | **Generic civil service vehicles pack**: https://sketchfab.com/3d-models/8ff2a13f30914932a70c7950cfa58465 | Comrade1280 | **CC BY 4.0** (API) | 92.7k faces total: ambulance 9.4k, city bus 9.1k, fire truck 12.1k, police, taxi and more | Low (same statement). Police livery: don't copy a real force's livery or crest. |
| **T3** | **Daniel Zhabotinsky low-poly fictional cars** (1970s–90s US/JP style): Fairheaven LT '80 `e2678da920cc4be68dbc193727919ffb` (19.7k), Fairheaven LT '80 Cop Cruiser `61766c1e6e1e4b2b803c174f33433a74` (19.5k), Fairheaven LT '80 Taxi `7da68ec2677f4abd8e31e9998b497a67`, Fairheaven SW '84 `aa0becb6e854422596cac6b21bf79787`, Kiri '86 `5c17c582ef9549798f694b660feea42a` (20.3k), Illinois '90 `d604871eee5b4181bb298163b0b675b7` (19.4k), Canyon '75 Taxi `9e8f92a215784f3d8aaaaeab1bef54c4`, Negotiator '80 `892b2684fb37442299bfad9222cf331c`, LCT 3000 '95 box truck `663a0953c038434a918cb85725c88ffa` (18.9k), Lightbody Lifted '85 `67beae18c3d24be68f9c8f0ec382d8e3` | DanielZhabotinsky | **CC BY 4.0** (API). Descriptions add: "I unconditionally give you permission to use this model … modify it or implement it into a digital product" | ~19–20k faces each, game-ready | **Low to medium**: fictional names, "generic" period designs (for example "generic CAFE downsized American sedans"). Some echo real models (Phoenix 455 '71 ≈ a Firebird, so skip that one). Compare each against its era's real cars and tweak the grille and tail lights. |

Kenney **Car Kit** (https://kenney.nl/assets/car-kit, CC0, 45 files) and Quaternius **Cars**
(https://quaternius.com/packs/cars.html, CC0, 8 cars, FBX/OBJ/Blend) are **stylised low-poly**.
They are useful only as far-distance impostor sources or blockout placeholders, not for the target
look.

### 2.3 Wheels and tyres

| Asset | Author / licence | Specs | Notes |
|---|---|---|---|
| CarConcept wheels (inside C1) | CC BY 4.0 | 324 verts per wheel after cleanup; tread is a 512×128 normal-map strip; tyre-side and brake-disc textures | Best web-ready reference: low geometry plus normal-mapped tread. Reuse with attribution. |
| **Rims_N_Tyres_kit_1.0**: https://sketchfab.com/3d-models/97c7a90210974cb089f15ee7682e4d65 | britdawgmasterfunk. Description says "CC0 (Public Domain) Free to use in any capacity". Sketchfab field: **CC BY 4.0** (credit to be safe) | 3.28M faces in total (a kitbash library), **no textures** | Generic rims and tyres to decimate or bake. Check single designs against famous rims (BBS, Work, Rays) and alter the spoke counts. |
| Tuner Car Wheel: https://sketchfab.com/3d-models/68f53cc291724ccda5d0659824bb273f | TinoD2, CC BY 4.0 | 5.9k faces, game-ready | Generic. **Avoid** TinoD2's "BBS RS16" and "Mugen M7" wheels and all "Lamborghini SDC" wheel packs: real trademarks and designs in the names. |
| Poly Haven **old_tyre** / **rusted_wheel_rim_01/02** (CC0) | Poly Haven | 2.9k / 16k / 15k polys; 1k–4k(8k) textures | Alley junk props, not drivable wheels. |

Recommendation: build the player wheel procedurally in Blender (already done in `make_car.py`),
then add a CC0 tyre-sidewall/tread normal map (bake from the kit above, or from ambientCG `Rubber`
materials).

### 2.4 City buildings and street kits (night, narrow streets and alleys)

Poly Haven's **"hidden_alley" collection** (all CC0, glTF/FBX/Blend/USD, 1k–8k textures,
https://polyhaven.com/models) is the best realistic, game-compatible street kit found:

| Asset (polyhaven.com/a/&lt;id&gt;) | Polycount | Use |
|---|---|---|
| `modular_urban_apartments_facade` | 118k | Building facades (decimate; use for street-level hero blocks) |
| `modular_factory_facade` | 175k | Industrial district |
| `modular_fire_escape` | 11k | Alley dressing |
| `modular_metal_gutter`, `modular_airduct_circular_01`, `modular_airduct_rectangular_01`, `exterior_aircon_unit` | 16k / 14k / 45k / 19k | Wall clutter |
| `rollershutter_door`, `rollershutter_window_01..03` | ~1.1k each | Shop fronts at night (closed shutters) |
| `modular_electricity_poles`, `modular_electric_cables` | 200k / 42k | Overhead wires (decimate heavily) |
| `modular_chainlink_fence` | 89k | Lots and alleys |
| `concrete_road_barrier`, `concrete_road_barrier_02` | 81k / 43k | Track limits / crash props (decimate to ~2k) |
| `fire_hydrant`, `metal_trash_can`, `utility_box_01/02`, `water_manhole_cover`, `security_camera_01/02`, `pull_chain_light_socket`, `modular_street_seating` | 86k / 14k / 4–6k / 6k / 13k / 11k / 25k | Street props |
| `covered_car` | 12.6k | Parked background car (no trademark) |
| `street_lamp_01`, `street_lamp_02`, `security_light` | 31k / 20k / 4.7k | Lights (see 2.5) |

Sketchfab CC-BY extras (licence verified via API):
- **Old Residential Building [4k]**, Andrej Grave: https://sketchfab.com/3d-models/dd400ed693cf416e940c5b8e3107205e (277k faces, 4k textures, "realistic worn residential building"). Hero backdrop building. Decimate and rebake to 2k.
- **Procedural Hong Kong building**, uday (udayjeet): https://sketchfab.com/3d-models/528a732e84c44fd49c4726f341014a23 (197k faces). Blender geometry-nodes source ("everything … created by me"). Great for generating many unique tall buildings, then baking each to a low-poly shell.
- **Brooklyn Street Row Buildings Low Poly**, B0rn2D13: https://sketchfab.com/3d-models/370ca970f4cd4c638f95fe17617d0bc1 (5.4k tris, BaseColor/Roughness/Metal). Cheap mid-distance row. **Check shop signage for real brand names.**
- **Modular Urban Fence Pack (graffiti)**, TampaJoey: https://sketchfab.com/3d-models/1cf3690327bd449881ba6857d8fe7caf (39k faces, 10 graffiti textures). **NoAI** clause in the description (fine for game use).
- **Asian Themed Low Poly Night City Buildings**, 99.Miles: https://sketchfab.com/3d-models/9f0343aff4814b758dc6e905aba5b5e0 (6.4k faces). Stylised; far-distance skyline only.

Kenney **City Kit Roads** (90 files), **City Kit Commercial** (50), **Suburban** (40),
**Industrial** (40), **Racing Kit** (110): all CC0 (checked on each kenney.nl page). They are
stylised, so use them only for layout blockout.

### 2.5 Streetlights, signs, neon (lights matter most at night)

- Poly Haven `street_lamp_01` (30.6k), `street_lamp_02` (20.3k), `security_light` (4.7k), `industrial_wall_lamp`, `hanging_industrial_lamp`, `caged_hanging_light`: CC0, glTF, up to 8k. Decimate to ≤3k tris and instance them.
- **Abandoned street lights pack**, sergeilihandristov: https://sketchfab.com/3d-models/c853eca300e8435d8fe9206bcb524eda (CC BY 4.0; 22k faces in total, 8 modular variants, 2048² textures).
- **Street light Lamp spotlight**, ahmagh2e: https://sketchfab.com/3d-models/b3534b9033a24f0aad2e1f9527bd4ca8 (CC BY 4.0, 14k).
- **Neon Signs**, nashalanandas: https://sketchfab.com/3d-models/307e887d740649f88fbc77b061f3a742 (CC BY 4.0, 355k: decimate). **Game Ready Japanese Small Vertical Neon Sign**, alexbescg: https://sketchfab.com/3d-models/5849c107ecb7472bb1eef028f5b97f0d (CC BY 4.0, 7k). **Japanese Neon Street Sign**, mcmanusmedia: https://sketchfab.com/3d-models/c91524e74c8c463ca3ddf71bc73911db (CC BY 4.0, 8.6k). Read every sign's text: replace any real shop or brand names.
- **Japanese Traffic Assets**, erikkinc: https://sketchfab.com/3d-models/1a4833770ace4df6aecfdabb76e36d60 (CC BY 4.0, 29k). **Road Traffic Sign**, jacky15621419: https://sketchfab.com/3d-models/13eeb2da01c046a1a0fc8ce8a7e262ab (CC BY 4.0, 7k).

### 2.6 Roads, asphalt, PBR materials, decals (all CC0)

| Asset | Source | Notes |
|---|---|---|
| `asphalt_02` (most downloaded), `asphalt_04` (16k), `clean_asphalt`, `worn_asphalt` (16k), `asphalt_track`, `asphalt_pit_lane`, `road_damaged`, `aerial_asphalt_01` | polyhaven.com/a/&lt;id&gt; | 1k–16k, full PBR (diff/nor/rough/disp/AO). Use 1k–2k tiling plus detail normal. |
| `concrete_pavement`, `pavement_01..06`, `brick_pavement_02`, `cobblestone_floor_04/08`, `cobblestone_embedded_asphalt` | Poly Haven | Sidewalks, old-town alleys |
| `brick_wall_001/006`, `factory_wall`, `cracked_concrete_wall`, `plastered_wall`, `corrugated_iron(_02)`, `rusty_metal_02`, `metal_plate` | Poly Haven | Facades and trim sheets |
| `Road007` (most popular), `Asphalt031`, `Asphalt025C`, `Asphalt019`, `Road012A–015C` | ambientcg.com/a/&lt;id&gt; | Road surfaces with markings baked in |
| **Decals**: `RoadLines006–022C` (72 assets), `ManholeCover003–011` | ambientCG (type "Decal") | Lane markings and manholes as alpha decals |
| Facades: `Facade001`, `Facade005/006/009/013/017/018A` | ambientCG | Flat building faces for far blocks (window grids for emissive night masks) |
| Photoscanned **manhole cover decals** | cgbookcase.com (partly verified, see section 1) | Alternative decals |
| 3dtextures.me | CC0 (verified on /about) | Extra stylised-real materials |
| ShareTextures | custom CC0 (see section 1) | Extra materials, fine in game |

### 2.7 Night HDRIs (Poly Haven, CC0, up to 16k–24k; ship 1k–2k for IBL)

Urban night, highest download counts first: `shanghai_bund`, `preller_drive`, `hansaplatz`,
`rooftop_night`, `solitude_night`, `neuer_zollhof`, `vignaioli_night`, `cobblestone_street_night`,
`golden_bay`, `blue_lagoon_night`, `blaubeuren_night`, `st_peters_square_night`,
`modern_buildings_night`, `winter_evening`, `viale_giuseppe_garibaldi`, `street_lamp`,
`courtyard_night`, `night_bridge`. Night sky only: `moonless_golf`, `kloppenheim_02(_puresky)`,
`satara_night_no_lamps`. URL: `https://polyhaven.com/a/<id>`.
Web plan: download the 1k or 2k .hdr, PMREM it at runtime, or prebake to a small RGBE/KTX2 cubemap.

### 2.8 Audio (each Freesound page checked for its licence link on 2026-10-18; all **CC0**)

| Use | Sound (https://freesound.org/people/…) |
|---|---|
| Engine (rev, idle, turbo) | `editboy23/sounds/496171` "Import car revs on Chassis Dyno with Turbo"; `NHumphrey/sounds/200973` "Car Engine Start, Idle, and Revving"; `TheLittleCrow/sounds/669623` "Car Engine Contact Recording – Mini Cooper S" (contact mic, good granular source, rename the file); `AndrewAlexander/sounds/369054` "car_idle_ext_loop"; `timothyd4y/sounds/472610` vintage racer ignition + rev; `EwanPenman11/sounds/659544` "Turbo Spooling and Blow Off" |
| Pass-bys / ambient traffic | `kyles/sounds/455663` "throaty car drive out of alley pass by"; `kyles/sounds/413906` muscle-car pass; `martian/sounds/180324` "car pass fast 4 times" |
| Tyres | `audible-edge/sounds/71736..71739` "tire squeal 01–04" (the same recordings are re-uploaded on OpenGameArt as CC-BY 3.0: use the **CC0 Freesound originals**); `johnnydekk/sounds/614627` "screeching tyres" |
| Crash / damage | `magnuswaker/sounds/592388` "Car Crash (with Glass)"; `squareal/sounds/237375` "Car Crash"; `LPA134/sounds/329516` "Hood Impact"; `qubodup/sounds/332058` "Collision"; `kyles/sounds/451665` "school bus truck destroy crush smash window break"; `unfa/sounds/221528` "Glass Break" |
| Fire / explosion | `magnuswaker/sounds/581078` "Flame Loop"; `bevibeldesign/sounds/366091` "Huge Explosion Part 1 – Shockwave" |
| City night ambience / police | `Nimlos/sounds/454822` "Ambience city night DPA semibinaural"; `kyles/sounds/451080` "traffic heavy dense … police siren woop" |

Bulk source: **Sonniss GDC Game Audio Bundles** (https://sonniss.com/gameaudiogdc). 2015–2024 are
available (9–48 GB each), and there was no 2025 bundle. Royalty free with no attribution required,
but **no AI/ML training and no redistribution as SFX**. The bundles include many vehicle libraries.
Download locally outside the repo and import only the trimmed files you use.
OpenGameArt "racing car engine sound loops" by domasx2 (CC0) exists, but it is six pitch-shifted
copies of one quiet loop, so low quality. The current synthesized engine is better; use recordings
only for layers (intake, turbo whistle, pops).

### 2.9 Particles (smoke, fire, sparks)

- **Kenney Particle Pack**: https://kenney.nl/assets/particle-pack (CC0, 80 files, 512² tiles). **Kenney Smoke Particles**: https://kenney.nl/assets/smoke-particles (CC0, 70 files). Use them as sprite and flipbook sources for tyre smoke, sparks and fire.
- No licence-verified free photoreal flipbook pack was found. JangaFX had no free pack with a findable licence. Recommendation: render your own flipbooks (Blender Mantaflow, or EmberGen if licensed), which keeps you 100% clear.

---

## 3. Sites and items to AVOID, and why

| Avoid | Why (verified) |
|---|---|
| **TurboSquid** (paid and free) | Games need proprietary formats; three.js/GLB WebGL needs approval. "Editorial" brand cars are news-only. |
| **Free3D** | Licence page blocked (403). Many items are "Personal Use". TurboSquid-operated. **UNVERIFIED → avoid.** |
| **CGTrader free** | Seller-chosen licence. Royalty Free requires preventing end-user access, which raw web files cannot satisfy. Editorial = news only. |
| **Sketchfab Editorial, NC, ND, SA** | Not commercial, or not modifiable. SA is viral for modified meshes. |
| **Sketchfab "Free Standard"/"Standard" without a CC0 dedication** | Single seat, no stand-alone or extractable distribution, firewall clause. Web-hostile. |
| **heynic "www.vecarz.com" uploads** (Ferrari, Porsche, BMW "Assetto", Nissan GT-R … all labelled CC-BY) | Real brands (trade dress). Titles like "BMW X6M Competition Assetto" suggest **ripped game/mod assets** = licence laundering: the uploader likely had no right to grant CC-BY. |
| **Rips from games**: "Nissan GTRs (NFS Most Wanted Razor Version)", Swiss_Fox "Jester Butane / Italia Velocita Reworked" (GTA vehicle names), "Speed Racer's Mach 6", "F&F 8 Dodge Charger", "Fifth Element taxi" | Third-party game and film IP. CC labels on them are not trustworthy. |
| **Spam uploads** ("Download Need for Speed Rivals For PC", "Midnight Club 3 ROM" …) listed as CC-BY | Piracy and malware bait. Never download. |
| **Real-brand CC-BY cars** (lionsharp "1975 Porsche 911 Turbo", TinoD2 AE86 / BMW E30 / Datsun 280Z, BlackSnow02 "Porsche GT3 RS", mpgs.studio BMW/Maybach, Lambo_SC04 Lamborghini cars and wheels) | The copyright licence may be fine, but **trade dress risk is high**. Iconic silhouettes cannot be de-branded without re-modelling. Usable at most as *proportion references*. |
| **AI-generated "CC0" models** (for example Unity Fan "Ai based ConceptCar 050/051") | Copyright status of AI output is unsettled and training provenance is unknown. Prefer the human-made models in the same series. |
| **Textures.com** | Anti-redistribution clause vs. raw web textures, and no need since CC0 alternatives exist. |
| **Fab content** (incl. Megascans) | Only with care. Standard License requires restricting extraction. Epic's own Unreal-only content (e.g. City Sample) is outside the Fab Standard grant. Megascans claimed during the free 2024 window are reported to fall under the Fab Standard License (Fab transition FAQ not loadable, so **UNVERIFIED**). |
| **BlenderKit Royalty Free** | Grey zone for raw GLBs. Use only its CC0 items. |
| **OpenGameArt re-uploads** | Check the original source: the audible-edge tyre loop is CC0 at the source but CC-BY 3.0 on OGA. Licences on OGA are per item (CC0, CC-BY, CC-BY-SA, GPL, OGA-BY). |
| **Mixamo** | Not applicable (humanoid animation only). |

---

## 4. Blender de-branding checklist (for any asset resembling a real product)

1. **Identify** every real-world mark: badges, emblems, script names, wheel-centre caps, tyre sidewall text (Pirelli, Michelin), brake-caliper logos (Brembo), licence-plate frames, windshield stickers, dashboard and steering-wheel logos, seat embroidery, engine covers, shop signs, neon text, posters, graffiti tags.
2. **Delete the geometry** of badges and scripts. Fill the holes (grid fill or patch) and re-flow the topology so no badge-shaped indentation remains.
3. **Clean the textures**: clone-stamp or regenerate any baked logo in baseColor, normal, AO and emissive maps (logos often survive in the *normal* and *AO* bakes). Search UV islands for small high-detail areas.
4. **Grille**: change the shape (outline), the pattern (mesh vs. slats vs. honeycomb) and the proportion. Never keep a signature grille (kidney, shield, spindle, "tiger nose").
5. **Head and tail lights**: change the outline and the internal light signature (DRL shape, number of elements, LED strip geometry). These are among the strongest trade-dress cues.
6. **Body lines**: move or remove the signature character lines (shoulder crease, side scoop, Hofmeister kink, roofline drop), and change the window graphic (DLO shape) and the C-pillar.
7. **Proportions**: change overhangs, wheelbase-to-length ratio, greenhouse height and wheel-arch shape. For iconic silhouettes (911, Countach, AE86) this is **a re-model, not an edit**: do not use those assets.
8. **Wheels**: change spoke count and spoke shape, and remove centre-cap logos and sidewall brand text.
9. **Interior**: steering-wheel hub, gauge cluster typography, infotainment UI.
10. **Rename**: object, mesh, material and file names, and any in-game name. No real model codes ("GT3", "M3", "AMG") or pseudo-names that evoke them ("Porshe", "Lambo").
11. **Livery**: no real sponsor logos and no police crests.
12. **Review**: put a silhouette render and a front/rear render next to the real car. If a car enthusiast would name the brand from the silhouette alone, keep reshaping or drop the asset.

**What is realistic.** On a mid-poly car (≤150k), steps 2–5, 8, 10 and 11 take about 1–2 days. A
deep body-line and proportion change (steps 6–7) is close to re-modelling. Fictional or concept
designs (C1–C5, T1–T3) need only steps 1–3 and 10, which makes them the cheapest path.

---

## 5. Web compression pipeline (gltf-transform CLI 4.5.x, checked with `--help`)

Prerequisites: Node (installed), `npx @gltf-transform/cli@4`, and **KTX-Software `toktx` ≥ 4.3 on
PATH** (needed by `uastc`, `etc1s` and `optimize --texture-compress ktx2`; **not installed on this
machine yet**). Work in `assets_source/` and copy only the final files to `web/public/assets/`.

Triangle and texture budgets for an Intel UHD iGPU at 30–60 fps:

| Asset class | LOD0 tris | LOD1 | LOD2 | LOD3 / impostor | Textures |
|---|---|---|---|---|---|
| Player car (camera-close) | ≤ 120k (hard cap 150k) | 50% | 20% | ~5k proxy | One 2048² body atlas (ORM + normal) + 1k interior + paint as material colour + clearcoat |
| AI rival cars (x3–7) | ≤ 60k | 25k | 10k | 3k | 1024² |
| Traffic cars | ≤ 15k (≤ 30k max) | 6k | 2k | – | 512²–1024², shared atlas |
| Building block (hero) | ≤ 30k | 10k | 3k | box + facade texture | 2048² trim sheet, tiling |
| Props (lamp, hydrant, barrier) | ≤ 3k | 1k | – | – | 512² (KTX2), instanced |

Keep **deformable car panels under ~3k triangles each**, because dent cost scales per panel (see
`car_model_traps`).

```bash
G="npx -y @gltf-transform/cli@4"
IN=src.glb

# 0) Look before you cut
$G inspect $IN

# 1) Clean-up: merge duplicates, drop unused data, weld (needed before simplify)
$G dedup  $IN      s1.glb
$G prune  s1.glb   s2.glb
$G weld   s2.glb   s3.glb

# 2) Texture size caps (power of two). Hero car 2048, rivals 1024, props 512
$G resize s3.glb   s4.glb --width 2048 --height 2048

# 3) GPU texture compression (stays compressed in VRAM: 48.8 MB -> 14.9 MB on CarConcept)
#    UASTC for data maps (normal / ORM / clearcoat normal), ETC1S for colour maps
$G uastc  s4.glb   s5.glb --slots "{normalTexture,occlusionTexture,metallicRoughnessTexture,clearcoatNormalTexture}" \
          --level 2 --rdo --rdo-lambda 2 --zstd 18
$G etc1s  s5.glb   s6.glb --slots "{baseColorTexture,emissiveTexture,iridescenceThicknessTexture}" --quality 192

# 4) LODs (ratio = fraction of vertices kept; error = fraction of mesh radius)
$G simplify s6.glb lod1.glb --ratio 0.5  --error 0.001
$G simplify s6.glb lod2.glb --ratio 0.2  --error 0.005
$G simplify s6.glb lod3.glb --ratio 0.05 --error 0.02
#    Modular kit pieces (facades, fences): add --lock-border true so seams stay closed

# 5) Geometry compression: prefer meshopt (tiny JS decoder, fast decode) over Draco
for f in s6 lod1 lod2 lod3; do $G meshopt $f.glb ${f}_final.glb --level high; done

# One-liner alternative for props (does weld/dedup/prune/simplify/resize/ktx2/meshopt):
$G optimize prop.glb prop_final.glb --compress meshopt --texture-compress ktx2 --texture-size 512 \
   --simplify true --simplify-error 0.001 --instance true
```

Loader side (three r186, WebGPU). Copy `node_modules/three/examples/jsm/libs/basis/*` to
`web/public/basis/`:

```ts
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

await renderer.init();                                   // WebGPU device must exist first
const ktx2 = new KTX2Loader().setTranscoderPath('/basis/').detectSupport(renderer);
const loader = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
// LODs: load lod0..lod3 as separate GLBs into a THREE.LOD (three has no MSFT_lod support)
```

More notes:
- Car paint: don't texture it. Use a material colour plus `clearcoat` plus a tiny tiling flake normal (the CarConcept approach: a 128² noise normal with KHR_texture_transform tiling).
- Glass: `transmission` is expensive on an iGPU. Fall back to alpha-blended glass with an env-map reflection.
- HDRI: ship 1k for IBL. Fake the background with a dark gradient or a skyline card.
- Vercel: check that `.glb` and `.ktx2` are served with long cache headers. KTX2 + zstd and meshopt are already compressed, so gzip/brotli adds little.

---

## 6. CREDITS.md template

```markdown
# Credits

## 3D models
- "Car Concept" by Eric Chadwick, © 2024 Darmstadt Graphics Group GmbH, from the Khronos glTF
  Sample Assets (https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CarConcept),
  licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).
  Based on "FREE Concept Car 004" by Unity Fan (https://sketchfab.com/3d-models/4cba124633eb494eadc3bb0c4660ad7e), CC0.
  Changes: Khronos logos removed, renamed, decimated, LODs, textures re-encoded to KTX2.
- "Fictional supercar - V12 Goblin" by Olli Teittinen (ollitei)
  (https://sketchfab.com/3d-models/0a20e49ad5774d778567cb5c3f345786), licensed under CC BY 4.0
  (https://creativecommons.org/licenses/by/4.0/). Changes: <list>.
- "Generic passenger car pack" by Comrade1280
  (https://sketchfab.com/3d-models/20f9af9b8a404d5cb022ac6fe87f21f5), licensed under CC BY 4.0. Changes: <list>.
- "<Title>" by <Author> (<URL>), licensed under CC BY 4.0. Changes: <list>.

## Public-domain (CC0) assets (credit not required, given with thanks)
- Poly Haven (https://polyhaven.com): <asset ids>, CC0.
- ambientCG (https://ambientcg.com): <asset ids>. "Created using <asset name> from ambientCG.com,
  licensed under the Creative Commons CC0 1.0 Universal License."
- Kenney (https://kenney.nl): Particle Pack, Smoke Particles, CC0.
- Unity Fan (Sketchfab): <Concept Car ids>, dedicated to the public domain (CC0) by the author.

## Sound
- Freesound (https://freesound.org), CC0: "Car Crash (with Glass)" by magnuswaker
  (https://freesound.org/people/magnuswaker/sounds/592388/); <...>
- Freesound, CC BY 4.0: "<sound name>" by <user> (<sound URL>), licensed under CC BY 4.0. Changes: <list>.
- Sonniss GDC Game Audio Bundle <year> (https://sonniss.com/gameaudiogdc), royalty-free licence.

## Software
- three.js (MIT), Rapier (Apache-2.0), meshoptimizer (MIT), Basis Universal (Apache-2.0).

Trademarks mentioned in source asset names belong to their owners. No vehicle in this game
represents or is endorsed by any real manufacturer.
```

Keep a per-asset row in `assets_source/licenses/ledger.csv`
(`file, source_url, author, licence, licence_url, date_checked, page_snapshot, modifications`).
The in-game credits screen should render the same list.
