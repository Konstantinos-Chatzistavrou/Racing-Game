#!/usr/bin/env python3
"""Compress a built car and register it in the game: meshopt GLB -> web/public/assets/cars/v4/, data/cars/<id>.json (physics,
copied from a base car), data/cars/<id>.visual.json (from the build's numbers) and a catalog entry.
Usage: register_car.py <id> "<Display name>" "<tagline>" <#paint> <physics_base_id> <raw.glb> <info.json> "<source credit line>"
Needs npx (gltf-transform). Repo root = two levels above this file."""
import json, os, subprocess, sys, tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
cid, display, tag, paint, base, raw, info_path, credit = sys.argv[1:9]
info = json.load(open(info_path)); h = info["hubs_blender"]

# 1. GLB: dedup, prune, meshopt (no textures: flat materials)
out = os.path.join(ROOT, "web/public/assets/cars/v4"); os.makedirs(out, exist_ok=True)
tmp = tempfile.mkdtemp(); g = ["npx", "-y", "@gltf-transform/cli@4.5.1"]
subprocess.run(g + ["dedup", raw, tmp + "/a.glb"], check=True, capture_output=True)
subprocess.run(g + ["prune", tmp + "/a.glb", tmp + "/b.glb"], check=True, capture_output=True)
subprocess.run(g + ["meshopt", tmp + "/b.glb", f"{out}/{cid}_hero.glb", "--level", "high"], check=True, capture_output=True)

# 2. numbers (Blender: front = -Y; game model space: +Z forward)
zF = -(h["FL"][1] + h["FR"][1]) / 2; zR = -(h["RL"][1] + h["RR"][1]) / 2; wb = zF - zR
phys = json.load(open(f"{ROOT}/data/cars/{base}.json"))
phys["name"] = display
phys["notes"] = f"{display}: {base} numbers (mass, power, grip) with its own body ({credit}). Starting values: tune with feel."
phys["chassis"]["wheelbase_m"] = round(wb, 3)
json.dump(phys, open(f"{ROOT}/data/cars/{cid}.json", "w"), indent=2)
wf = phys["chassis"]["weight_front"]; cgz = zF - wb * (1 - wf)
L = info["length"]; half = abs(h["FL"][0])
vis = json.load(open(f"{ROOT}/data/cars/vela_gt.visual.json"))
vis.update({
    "name": display, "physics": f"cars/{cid}.json", "model": f"res://assets/cars/v4/{cid}_hero.glb",
    "notes": f"{credit}. Model space +X left, +Y up, +Z forward, origin on the ground at the body length centre. Front axle z {zF:.3f}, rear {zR:.3f} (wheelbase {wb:.3f}), hubs y {h['FL'][2]:.3f}, model track {2*half:.3f}.",
    "cg_in_model_m": [0.0, round(phys["chassis"]["cg_height_m"] + 0.04, 3), round(cgz, 3)],
    "wheel_visual_offset_m": round(-(half - phys["front_axle"]["track_m"] / 2), 3),
    "collision_box": {"size_m": [round(info["body_x"][1] - info["body_x"][0] - 0.05, 2), 0.72, round(L - 0.05, 2)], "centre_in_model_m": [0.0, 0.72, 0.0],
                      "end_lift_m": 0.13, "end_lift_start_m": round(L / 2 - 0.6, 2),
                      "note": f"body {info['body_x'][1]-info['body_x'][0]:.2f} x {info['body_z_max']:.2f} x {L:.2f} m; flat underside, rising to each end; wheels are raycasts"},
    "headlights": [[-0.62, 0.52, round(L / 2 - 0.3, 2)], [0.62, 0.52, round(L / 2 - 0.3, 2)]],
    "panels": {"front": ["bumper_front", "body", "drl_L", "drl_R", "beam_L", "beam_R"], "rear": ["bumper_rear", "taillight_bar", "taillight_housing", "wing"], "left": ["mirror_L"], "right": ["mirror_R"]},
    "detachable": {"bumper_front": ["front", 0.7], "bumper_rear": ["rear", 0.7], "mirror_L": ["left", 0.45], "mirror_R": ["right", 0.45]},
    "front_lights": ["drl_L", "drl_R", "beam_L", "beam_R"], "rear_lights": ["taillight_bar"],
    "engine_smoke_in_model_m": [0.0, 0.78, round(L / 2 - 0.6, 2)],
    "lod_model": "res://assets/cars/v3/vela_gt_traffic.glb", "lod_distance_m": 30.0,
})
json.dump(vis, open(f"{ROOT}/data/cars/{cid}.visual.json", "w"), indent=2)
cat = json.load(open(f"{ROOT}/data/cars/catalog.json"))
cat["cars"] = [c for c in cat["cars"] if c["id"] != cid] + [{"id": cid, "name": display, "tag": tag, "physics": f"cars/{cid}.json", "visual": f"cars/{cid}.visual.json", "paint": paint}]
json.dump(cat, open(f"{ROOT}/data/cars/catalog.json", "w"), indent=2)
print("registered", cid, "wheelbase", round(wb, 3), "cg", vis["cg_in_model_m"], "glb", os.path.getsize(f"{out}/{cid}_hero.glb") // 1024, "KB")
