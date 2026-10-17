#!/usr/bin/env bash
# Phase 0 benchmark matrix. Usage: tools/run_bench.sh [extra bench args...]
# Runs Mobile and Compatibility at 100/75/60% 3D scale, fullscreen 1920x1080, writes tools/results/*.json
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GODOT="$ROOT/tools/godot/godot"
RES="$ROOT/tools/results"
mkdir -p "$RES"
for r in mobile gl_compatibility; do
  for s in 1.0 0.75 0.6; do
    name="${r}_s${s}"
    echo "=== $name"
    "$GODOT" --path "$ROOT/game" --rendering-method "$r" --fullscreen -- \
      --scale="$s" --duration=30 --out="$RES/$name.json" --shot="$RES/$name.png" "$@" >"$RES/$name.log" 2>&1
  done
done
python3 "$ROOT/tools/summarize.py" "$RES"
