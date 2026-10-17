#!/usr/bin/env bash
# Full Phase 0 run: matrix + stress, with a package-temperature log (thermal throttling check).
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RES="$ROOT/tools/results"; mkdir -p "$RES"
( while true; do for z in /sys/class/thermal/thermal_zone*; do [ "$(cat $z/type)" = x86_pkg_temp ] && echo "$(date +%T) $(( $(cat $z/temp)/1000 ))C"; done; sleep 10; done ) > "$RES/temps.log" &
TP=$!
"$ROOT/tools/run_bench.sh" > "$RES/matrix.md" 2>&1
"$ROOT/tools/run_stress.sh" mobile 0.75 > "$RES/stress.md" 2>&1
kill $TP
echo done > "$RES/ALL_DONE"
