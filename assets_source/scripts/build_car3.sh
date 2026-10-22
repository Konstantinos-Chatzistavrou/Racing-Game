#!/usr/bin/env bash
# Builds the generation-3 car (docs/car_model_v3.md):
#   1. Blender: make_car3.py de-brands + restyles the Khronos CarConcept -> raw GLBs (PNG textures)
#   2. gltf-transform v4: dedup/prune, texture caps (hero 2048, traffic 1024), KTX2 (UASTC for
#      normal maps, ETC1S for colour/ORM/AO/emissive), meshopt geometry -> game/assets/cars/v3/
# Needs: assets_source/downloads/CarConcept/CarConcept.glb (fetch: docs/car_model_v3.md),
#        Blender 5.2 (BLENDER=..., default tools/blender/blender), KTX-Software 4.4 in tools/ktx/
#        (release tarball, gitignored), node + npx. Usage: assets_source/scripts/build_car3.sh [--draco]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$ROOT/assets_source/downloads/CarConcept/CarConcept.glb"
BLENDER="${BLENDER:-$ROOT/tools/blender/blender}"
KTX="$ROOT/tools/ktx/KTX-Software-4.4.2-Linux-x86_64"
TMP="${CAR3_TMP:-$ROOT/assets_source/downloads/build_car3}"
OUT="$ROOT/game/assets/cars/v3"
G=(npx -y @gltf-transform/cli@4.5.1)
[ -f "$SRC" ] || { echo "missing $SRC (see docs/car_model_v3.md)"; exit 1; }
[ -x "$KTX/bin/ktx" ] || { echo "missing KTX-Software in tools/ktx (see docs/car_model_v3.md)"; exit 1; }
export PATH="$KTX/bin:$PATH" LD_LIBRARY_PATH="$KTX/lib:${LD_LIBRARY_PATH:-}"
mkdir -p "$TMP" "$OUT"

"$BLENDER" -b --factory-startup --python "$ROOT/assets_source/scripts/make_car3.py" -- "$SRC" "$TMP"

for v in hero traffic; do
  size=2048; [ "$v" = traffic ] && size=1024
  in="$TMP/vela_gt_${v}_raw.glb"
  "${G[@]}" dedup "$in" "$TMP/$v.1.glb"
  "${G[@]}" prune "$TMP/$v.1.glb" "$TMP/$v.2.glb"
  "${G[@]}" resize "$TMP/$v.2.glb" "$TMP/$v.3.glb" --width "$size" --height "$size"
  # normal maps: UASTC (keeps the flake/tread/sidewall detail; ETC1S smears normals)
  "${G[@]}" uastc "$TMP/$v.3.glb" "$TMP/$v.4.glb" --slots "{normalTexture,clearcoatNormalTexture}" \
      --level 2 --rdo --rdo-lambda 2 --zstd 18
  # everything else (base colour, emissive, ORM, AO): ETC1S
  "${G[@]}" etc1s "$TMP/$v.4.glb" "$TMP/$v.5.glb" --quality 192
  if [ "${1:-}" = "--draco" ]; then
    "${G[@]}" draco "$TMP/$v.5.glb" "$TMP/vela_gt_${v}_draco.glb"
    ls -l "$TMP/vela_gt_${v}_draco.glb"
  fi
  "${G[@]}" meshopt "$TMP/$v.5.glb" "$OUT/vela_gt_${v}.glb" --level high
  rm -f "$TMP/$v".[1-5].glb
done
ls -l "$OUT"
