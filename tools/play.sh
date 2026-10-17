#!/usr/bin/env bash
# Launch the game (fullscreen). Used by the desktop shortcut. Esc quits.
ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
cd "$ROOT"
exec "$ROOT/tools/godot/godot" --path "$ROOT/game" --fullscreen "$@" > "$ROOT/tools/results/last_run.log" 2>&1
