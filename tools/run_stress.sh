#!/usr/bin/env bash
# Stress variants on one renderer/scale. Usage: tools/run_stress.sh [renderer] [scale]
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; R="${1:-mobile}"; S="${2:-0.75}"
OUT="$ROOT/tools/results/stress_${R}_${S}"; mkdir -p "$OUT"
for cfg in "base:" "lod0:--lod0" "spots4:--spots=4" "lod0_spots4:--lod0 --spots=4" "nopost:--nopost"; do
  n=${cfg%%:*}; a=${cfg#*:}; echo "== $n"
  timeout 120 "$ROOT/tools/godot/godot" --path "$ROOT/game" --rendering-method "$R" --fullscreen -- \
    --scale="$S" --duration=30 --out="$OUT/$n.json" --shot="$OUT/$n.png" $a >"$OUT/$n.log" 2>&1
done
python3 "$ROOT/tools/summarize.py" "$OUT"
