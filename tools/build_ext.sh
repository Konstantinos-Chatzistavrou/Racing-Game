#!/usr/bin/env bash
# Build the physics core + Godot extension, then run the headless core tests.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cmake -S "$ROOT/core" -B "$ROOT/core/build" > /dev/null
cmake --build "$ROOT/core/build" -j4
"$ROOT/core/build/rs_tests" | tail -1
cmake -S "$ROOT/godot_ext" -B "$ROOT/godot_ext/build" > /dev/null
cmake --build "$ROOT/godot_ext/build" -j4
ls -la "$ROOT"/game/bin/*.so
