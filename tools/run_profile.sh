#!/usr/bin/env bash
# Feature cost profile of the showcase: one 30 s chase-cam run per disabled feature.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; OUT="$ROOT/tools/results/profile"; mkdir -p "$OUT"
for cfg in "base:" "noprobes:--noprobes" "noglow:--noglow" "nofog:--nofog" "nodecal:--nodecal" \
           "bilinear:--bilinear" "nomoonshadow:--nomoonshadow" "nohead:--nohead" "nocarlights:--nocarlights"; do
  n=${cfg%%:*}; a=${cfg#*:}
  timeout 150 "$ROOT/tools/godot/godot" --path "$ROOT/game" --fullscreen res://scenes/showcase.tscn -- \
    --bench=30 --cam=0 "--out=$OUT/$n.json" $a > "$OUT/$n.log" 2>&1
done
python3 "$ROOT/tools/summarize.py" "$OUT" > "$OUT/summary.md"
echo done > "$OUT/DONE"
