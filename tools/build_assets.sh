#!/usr/bin/env bash
# Rebuild every generated asset from source, in order. Usage: tools/build_assets.sh [--skip-bake]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
B="$ROOT/tools/blender/blender"; G="$ROOT/tools/godot/godot"; PY="$ROOT/tools/blender/5.2/python/bin/python3.13"
echo "== textures";  "$PY" "$ROOT/assets_source/scripts/gen_textures.py" > /dev/null
cp "$ROOT"/assets_source/textures/{asphalt_albedo,asphalt_normal,asphalt_rough,puddle_mask}.png "$ROOT/game/assets/textures/"
echo "== car";       "$B" -b --factory-startup --python "$ROOT/assets_source/scripts/make_car2.py" 2>&1 | grep -E "^\[car2?\]|Error" || true
echo "== city";      "$B" -b --factory-startup --python "$ROOT/assets_source/scripts/make_city.py" 2>&1 | grep -E "^\[city\]|Error" || true
echo "== import";    "$G" --path "$ROOT/game" --headless --import > /dev/null 2>&1
echo "== scene";     "$G" --path "$ROOT/game" --headless --script res://tools/build_city_scene.gd 2>&1 | grep -E "^\[build\]|ERROR" || true
if [[ "${1:-}" != "--skip-bake" ]]; then
  echo "== bake (opens the editor briefly)"
  rm -f "$ROOT"/game/scenes/city_night.lmbake "$ROOT"/game/scenes/city_night*.exr "$ROOT"/game/scenes/city_night*.exr.import
  "$G" --path "$ROOT/game" --editor -- --autobake=res://scenes/city_night.tscn 2>&1 | grep -E "^\[autobake\]" || true
fi
echo "== done"
