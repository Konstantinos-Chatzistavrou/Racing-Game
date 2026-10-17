#!/usr/bin/env python3
"""Print a markdown table of all benchmark JSON results in a directory."""
import json, sys, glob, os
rows = []
for f in sorted(glob.glob(os.path.join(sys.argv[1], "*.json"))):
    d = json.load(open(f))
    rows.append((os.path.basename(f)[:-5], d))
print("| run | avg fps | 1% low | worst ms | GPU ms avg/p99 | CPU ms | draws | tris avg/max | VRAM MB | RAM MB |")
print("|---|---|---|---|---|---|---|---|---|---|")
for n, d in rows:
    print(f"| {n} | {d['avg_fps']:.1f} | {d['p1_low_fps']:.1f} | {d['worst_ms']:.0f} | {d['gpu_ms_avg']:.1f}/{d['gpu_ms_p99']:.1f} | {d['cpu_ms_avg']:.1f} | {d['draws_avg']:.0f} | {d['tris_avg']/1000:.0f}k/{d['tris_max']/1000:.0f}k | {d['vram_mb']:.0f} | {d['rss_peak_mb']:.0f} |")
