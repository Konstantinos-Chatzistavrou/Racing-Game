# Licensing

This repository holds two kinds of work, under two licences.

| What | Licence | Full text |
|---|---|---|
| **Software**: all source code, shaders, build and processing scripts, HTML / CSS, configuration, JSON schemas | **GNU Affero General Public License v3.0 or later** (SPDX `AGPL-3.0-or-later`) | [`LICENSE`](LICENSE) |
| **Everything else we made**: 3D models, textures, materials, car and track data, rival / prop data, documentation, images, text | **Creative Commons Attribution-NonCommercial 4.0 International** (SPDX `CC-BY-NC-4.0`) | [`LICENSES/CC-BY-NC-4.0.txt`](LICENSES/CC-BY-NC-4.0.txt), https://creativecommons.org/licenses/by-nc/4.0/ |

Copyright © 2026 OpenGrid contributors.

## What the CC BY-NC 4.0 part means

You may copy, share and adapt the models, data and docs, **for non-commercial purposes only**, and you must **give
credit**: name "OpenGrid contributors", link to this repository
(https://github.com/Konstantinos-Chatzistavrou/Racing-Game) and to the licence, and say whether you changed anything.
Selling them, putting them in a paid or ad-funded product, or any other use primarily intended for commercial
advantage needs written permission from the copyright holder.

## Which files are which

**AGPL-3.0-or-later (software)**
- `core/` (C++ physics), `web/src/`, `web/wasm/`, `web/tools/`, `web/index.html`, `web/*.json`, `web/*.ts`
- `server/`, `tools/`, `assets_source/scripts/`, `godot_ext/` (our code; `godot-cpp` keeps its MIT licence),
  `game/` scripts and scenes, `archive/` code
- `data/schema/`, `vercel.json`, `.gitignore`

**CC BY-NC 4.0 (assets, data, documentation)**
- `web/public/assets/cars/`, `web/public/assets/city/`, `assets_source/models/`, `assets_source/textures/`
- `data/cars/`, `data/tracks/city.json`, `data/tracks/city_route.json`, `data/rivals.json`, `data/city_props.json`,
  `web/public/data/`
- `docs/`, `README.md`, `CREDITS.md`, `PLAN.md`, `PORTING.md`, this file
- the "OpenGrid" logo and title artwork

**Third-party material keeps its own licence** (details and attributions in [`CREDITS.md`](CREDITS.md)):
- New York map data, `web/public/assets/nyc/` and `data/tracks/nyc_route.json`: built from OpenStreetMap,
  © OpenStreetMap contributors, **Open Database Licence 1.0** (ODbL; the derived database stays ODbL) plus NYC Open Data
  (public domain).
- Fitted tyre file `data/tires/audi_245_40R18_pac2002.tir`: Project Chrono, **BSD-3-Clause**
  (`data/tires/LICENSE-projectchrono.txt`).
- Basis Universal transcoder, `web/public/libs/basis/`: **Apache-2.0**.
- Car models adapted from CC BY 4.0 originals (Vela GT, Kestrel GT, Harrier GT): our changes are CC BY-NC 4.0; the
  original authors' credit lines in `CREDITS.md` must be kept, and the unmodified originals remain available from their
  authors under CC BY 4.0.
- City models and textures adapted from CC0 originals (Poly Haven, ambientCG): our processed versions are CC BY-NC 4.0;
  the originals remain CC0 at their sources.
- Libraries loaded at run time (three.js MIT, Rapier Apache-2.0, meshoptimizer MIT, PeerJS MIT) keep their licences.

## Why two licences

The AGPL is a software licence and keeps the code free software: anyone may study, change and run it, also over a
network, as long as they publish their changes under the same terms. The AGPL forbids adding further restrictions to the
code (section 7), so the non-commercial condition applies to the assets, data and documentation only. A commercial game
would have to replace every CC BY-NC asset and all the data with its own.

New contributions are accepted under the same split: code under AGPL-3.0-or-later, everything else under CC BY-NC 4.0.
