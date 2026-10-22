"""De-brand + re-shape pipeline for the 'Dave Love SketchFab' DTM-style models (CC BY 4.0). One config dict per car,
see make_car4.py (Kestrel GT, from the 2019 Aston Martin Vantage DTM) and make_car5.py (Harrier GT, 2018 Mercedes C-Coupé DTM).

What it does, in order (details and the licence trail are in make_car4.py's docstring and docs/car_model_v4.md):
  1. delete brand carriers (numbers, plates, damage-glass duplicates), flat PBR materials everywhere, interior decimated;
  2. body / misc faces split into recolourable 'paint' and black trim from the BLURRED livery atlas (no decal survives);
  3. wheels split from the single tyre/rim/disc meshes into four corners, hubs measured;
  4. mirrors carved out; the signature parts (front splitter, grille mesh, diffuser, wing, lamp units) deleted;
  5. SHAPE(): smooth deformation + uniform scale to the game's 2.65 m wheelbase; recentre (length centre at 0, tyres on 0);
  6. our own splitter / grille / diffuser / wing / light bars; game node names; export + numbers for the visual config.
Game contract: web/src/scene/car.ts, damage.ts (wheel_XX / caliper_XX empties, bumper_*, mirror_*, drl_*, beam_*, taillight_bar).
"""
import json
import os
import sys

import bpy
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from carlib import *  # noqa: E402,F401,F403

WHEELBASE = 2.65   # the game's physics wheelbase (data/cars/vela_gt.json)

DEFAULT_SHAPE = dict(nose_len=0.22, nose_drop=0.075, nose_taper=0.07, cabin_back=0.26, roof_drop=0.075, roof_narrow=0.03,
                     haunch=0.045, tail_cut=0.16, hood_raise=0.0)


def build(cfg, src, out):
    os.makedirs(out, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=src)
    M = standard_materials()
    sh = {**DEFAULT_SHAPE, **cfg.get("shape", {})}

    for o in meshes():
        o["mkey"] = mat_key(o)   # the source material's name (suffix .007 etc. stripped): survives separate/copy, unlike the material itself

    def objs_of(*keys):
        return [o for o in meshes() if o.get("mkey") in keys]

    # ---- 1. brand carriers out, flat materials ------------------------------------------------------------
    for o in objs_of(*cfg["remove"]):
        remove(o)
    for key, v in cfg["flat"].items():
        for o in objs_of(key):
            o.data.materials.clear(); o.data.materials.append(M[v])
    for o in [o for o in meshes() if o.get("mkey", "").startswith(tuple(cfg["interior_prefixes"])) and o["mkey"] not in cfg["flat"]]:
        o.data.materials.clear(); o.data.materials.append(M["interior"])
    # interiors are dark and barely seen at night: keep their shape, drop the triangle count
    for o in [o for o in meshes() if o.data.materials and o.data.materials[0] in (M["interior"], M["carbon"]) and len(o.data.polygons) > cfg.get("interior_max_polys", 6000)]:
        select_only([o])
        mod = o.modifiers.new("dec", "DECIMATE")
        mod.ratio = cfg.get("interior_max_polys", 6000) / len(o.data.polygons)
        bpy.ops.object.modifier_apply(modifier="dec")

    # ---- 2. body + misc: paint / trim split from the blurred livery atlas ---------------------------------------
    def blurred(img_name, n=20):
        im = bpy.data.images[img_name]
        w, h = im.size
        px = np.empty(w * h * 4, dtype=np.float32)
        im.pixels.foreach_get(px)
        px = px.reshape(h, w, 4)[:, :, :3]
        k = w // n
        return px[: n * k, : n * k].reshape(n, k, n, k, 3).mean(axis=(1, 3)).mean(axis=2)

    def atlas_mapping(obj, atlas):
        """(sx, sy, ox, oy): the UV scale/offset the material applies before sampling `atlas` (KHR_texture_transform), default identity."""
        for m in obj.data.materials:
            if not (m and m.use_nodes):
                continue
            for n in m.node_tree.nodes:
                if n.type == "TEX_IMAGE" and n.image and n.image.name == atlas and n.inputs["Vector"].links:
                    src = n.inputs["Vector"].links[0].from_node
                    if src.type == "MAPPING":
                        sc, lc = src.inputs["Scale"].default_value, src.inputs["Location"].default_value
                        return sc[0], sc[1], lc[0], lc[1]
        return 1.0, 1.0, 0.0, 0.0

    def classify(obj, atlas, thresh):
        me = obj.data
        lum = blurred(atlas)
        n = lum.shape[0]
        sx, sy, ox, oy = atlas_mapping(obj, atlas)
        uv = me.uv_layers.active.data
        me.materials.clear(); me.materials.append(M["paint"]); me.materials.append(M["trim"])
        for p in me.polygons:
            u = (sum(uv[i].uv.x for i in p.loop_indices) / p.loop_total) * sx + ox
            v = (sum(uv[i].uv.y for i in p.loop_indices) / p.loop_total) * sy + oy
            u, v = u % 1.0, v % 1.0   # the atlas repeats
            p.material_index = 1 if lum[min(n - 1, max(0, int(v * n))), min(n - 1, max(0, int(u * n)))] < thresh else 0

    bkey, batlas, bthr = cfg["body"]
    body = objs_of(bkey)[0]
    classify(body, batlas, bthr)
    mkey, matlas, mthr = cfg["misc"]
    misc = objs_of(mkey)[0]
    classify(misc, matlas, mthr)

    # ---- 3. wheels ---------------------------------------------------------------------------------------------
    wk = cfg["wheel"]
    for k in wk["tyre"] + wk["rim"] + wk["disc"] + wk["caliper"]:
        for o in objs_of(k):
            separate_loose(o)
    wheel_parts = [o for o in meshes() if o.data.materials and o.data.materials[0] in (M["tyre"], M["rim"], M["disc"], M["caliper"])]
    corner = {"FL": [], "FR": [], "RL": [], "RR": []}
    for o in wheel_parts:
        lo, hi = bbox([o])
        c = (lo + hi) / 2
        corner[("F" if c[1] < 0 else "R") + ("L" if c[0] > 0 else "R")].append(o)
    hub0 = {}
    for k, lst in corner.items():
        tyre = max((o for o in lst if o.data.materials[0] == M["tyre"]), key=lambda o: o.dimensions.z)
        lo, hi = bbox([tyre])
        hub0[k] = (lo + hi) / 2
    YF, YR = hub0["FL"][1], hub0["RL"][1]
    print("source hubs", {k: np.round(v, 3).tolist() for k, v in hub0.items()}, "wheelbase", round(YR - YF, 3))
    S = WHEELBASE / (YR - YF)

    # ---- 4. carve out / delete the signature parts, BEFORE deforming ------------------------------------------------
    mr = cfg["mirror_box"]
    for side, sgn in (("L", 1), ("R", -1)):
        split_faces(misc, lambda c, s=sgn: (c[:, 0] * s > mr["x"]) & (c[:, 1] > mr["y0"]) & (c[:, 1] < mr["y1"]) & (c[:, 2] > mr["z"]), f"mirror_{side}")
    z = cfg["zones"]
    front_zone = lambda c: (c[:, 1] < z["front_y"]) & (c[:, 2] < z["front_z"])
    rear_zone = lambda c: (c[:, 1] > z["rear_y"]) & (c[:, 2] < z["rear_z"])
    wing_zone = lambda c: (c[:, 1] > z["wing_y"]) & (c[:, 2] > z["wing_z"])
    grille_old = objs_of(*cfg.get("grille", []))
    delete_faces(body, lambda c: (c[:, 1] > z["body_wing_y"]) & (c[:, 2] > z["body_wing_z"]))
    bc = cfg.get("body_cut")   # a brand grille moulded into the body shell: cut out, our slatted grille fills the hole
    if bc:
        delete_faces(body, lambda c: (np.abs(c[:, 0]) < bc["x"]) & (c[:, 1] < bc["y"]) & (c[:, 2] > bc["z0"]) & (c[:, 2] < bc["z1"]))   # old wing end plates live in the body shell
    for o in [o for o in meshes() if o is misc or o.get("mkey") in cfg.get("underbody", [])]:
        if o in grille_old:
            continue
        delete_faces(o, lambda c: front_zone(c) | rear_zone(c) | wing_zone(c))
    lamp_objs = objs_of(*cfg["lamps_glass"], *cfg["lamps_emit"])
    lamp_prefix = tuple(o.name for o in lamp_objs)   # separate_loose keeps these as the name prefix of the parts
    for o in lamp_objs:
        separate_loose(o)
    for o in objs_of(*cfg["lamps_glass"]):
        o.data.materials.clear(); o.data.materials.append(M["glass"])
    for o in objs_of(*cfg["lamps_emit"]):
        o.data.materials.clear(); o.data.materials.append(M["light"])
    lights_front, lights_rear = [], []
    lz = cfg["lamp_zones"]
    for o in [o for o in meshes() if o.data.materials and o.data.materials[0] in (M["glass"], M["light"]) and o.name.startswith(lamp_prefix)]:
        lo, hi = bbox([o])
        if hi[1] < 0 and lo[2] > lz["front_z"]:
            lights_front.append(o)
        elif lo[1] > lz["rear_y"] and lo[2] > lz["rear_z0"] and hi[2] < lz["rear_z1"]:
            lights_rear.append(o)

    print("lamps: front", len(lights_front), "rear", len(lights_rear), "(parts)")

    # ---- 5. deformation -----------------------------------------------------------------------------------------
    def SHAPE(p):
        x, y, zz = p[:, 0].copy(), p[:, 1].copy(), p[:, 2].copy()
        n = sstep(YF, YF - 1.0, y)                       # nose
        y -= sh["nose_len"] * n
        zz -= sh["nose_drop"] * n * np.clip((zz - 0.1) / 0.5, 0, 1)
        x *= 1 - sh["nose_taper"] * n
        t = np.clip((y - YF) / (YR - YF), 0, 1)          # cabin slides back between the axles, roof drops
        mid = np.sin(np.pi * t) ** 2
        y += sh["cabin_back"] * mid
        roof = sstep(0.75, 1.3, zz) * mid
        zz -= sh["roof_drop"] * roof * (zz - 0.6)
        x *= 1 - sh["roof_narrow"] * roof
        r = sstep(YR - 0.5, YR + 0.5, y)                 # rear haunches wider, tail shorter
        x *= 1 + sh["haunch"] * r * np.clip((1.0 - zz) / 0.9, 0, 1)
        y -= sh["tail_cut"] * sstep(YR, YR + 1.3, y)
        return np.stack([x, y, zz], 1)

    hub_new = {k: S * SHAPE(v[None, :])[0] for k, v in hub0.items()}
    for k, lst in corner.items():
        for o in lst:
            set_world_coords(o, S * (world_coords(o) + (SHAPE(hub0[k][None, :])[0] - hub0[k])))
    wheel_set = {id(o) for lst in corner.values() for o in lst}
    for o in meshes():
        if id(o) not in wheel_set:
            set_world_coords(o, S * SHAPE(world_coords(o)))
    lo, hi = bbox([body])
    tyre_lo = min(bbox([o])[0][2] for o in wheel_parts)
    T = np.array([0.0, -(lo[1] + hi[1]) / 2, -tyre_lo])
    for o in meshes():
        set_world_coords(o, world_coords(o) + T)
    hub = {k: v + T for k, v in hub_new.items()}
    lo, hi = bbox([body])
    bp = world_coords(body)
    fy = bp[bp[:, 2] < 0.5, 1].min()
    ry = bp[bp[:, 2] < 0.5, 1].max()
    ry_up = bp[(bp[:, 2] > 0.7) & (bp[:, 2] < 0.9), 1].max()
    print("body y", round(fy, 3), round(ry, 3), "width", round(hi[0] - lo[0], 3), "height", round(hi[2], 3))
    if grille_old:
        gl, gh = bbox(grille_old)
    else:
        gl, gh = np.array([-0.8, fy, 0.14]), np.array([0.8, fy + 0.1, 0.5])
    for o in grille_old:
        remove(o)
    gh = np.maximum(gh, np.array([0, 0, cfg.get("grille_top", 0)]))

    # ---- 6. our own parts ---------------------------------------------------------------------------------------
    P = cfg.get("parts", {})
    sp, bl = M["carbon"], M["trim"]
    hw = P.get("splitter_half_width", 1.01)
    front_parts = [
        add_box("splitter", sp, (0, fy + 0.26, 0.085), (hw * 2, 0.56, 0.025)),
        add_box("splitter_plate_L", sp, (hw - 0.01, fy + 0.28, 0.14), (0.02, 0.5, 0.11)),
        add_box("splitter_plate_R", sp, (-hw + 0.01, fy + 0.28, 0.14), (0.02, 0.5, 0.11)),
        add_box("canard_L", sp, (hw - 0.15, fy + 0.62, 0.26), (0.22, 0.2, 0.012), (0, 0, -18)),
        add_box("canard_R", sp, (-hw + 0.15, fy + 0.62, 0.26), (0.22, 0.2, 0.012), (0, 0, 18)),
        add_box("grille_back", bl, (0, fy + 0.13, (gl[2] + gh[2]) / 2), (P.get("grille_w", 1.62), 0.02, gh[2] - gl[2])),
    ]
    z0, z1 = gl[2] + 0.04, gh[2] - 0.04
    n_slats = P.get("slats", 6)
    for i in range(n_slats):
        front_parts.append(add_box(f"slat_{i}", sp, (0, fy + 0.10, z0 + (z1 - z0) * i / max(1, n_slats - 1)), (P.get("grille_w", 1.62) - 0.02, 0.025, 0.028), (-10, 0, 0)))
    bumper_front = empty("bumper_front")
    adopt(bumper_front, front_parts)

    rear_parts = [add_box("diffuser_panel", sp, (0, ry - 0.34, 0.17), (1.46, 0.62, 0.02), (-9, 0, 0))]
    for i, x in enumerate(P.get("diffuser_fins", (-0.52, -0.18, 0.18, 0.52))):
        rear_parts.append(add_box(f"diffuser_fin_{i}", sp, (x, ry - 0.34, 0.25), (0.02, 0.6, 0.2)))
    rear_parts.append(add_box("rear_lip", sp, (0, ry - 0.02, 0.36), (1.8, 0.04, 0.03)))
    bumper_rear = empty("bumper_rear")
    adopt(bumper_rear, rear_parts)

    ww = P.get("wing_half_width", 0.97)
    wing_y, wing_z = ry - P.get("wing_back", 0.5), P.get("wing_z", 1.2)
    wing_parts = [
        add_box("wing_plane", bl, (0, wing_y, wing_z), (ww * 2, P.get("wing_chord", 0.36), 0.028), (-7, 0, 0)),
        add_box("wing_flap", bl, (0, wing_y + 0.2, wing_z + 0.05), (ww * 2, 0.14, 0.02), (-24, 0, 0)),
        add_box("wing_plate_L", M["paint"], (ww + 0.01, wing_y + 0.03, wing_z + 0.01), (0.022, 0.5, 0.24)),
        add_box("wing_plate_R", M["paint"], (-ww - 0.01, wing_y + 0.03, wing_z + 0.01), (0.022, 0.5, 0.24)),
    ]
    for sgn, sn in ((1, "L"), (-1, "R")):
        wing_parts.append(add_box(f"wing_post_{sn}", bl, (sgn * P.get("wing_post_x", 0.3), wing_y - 0.05, wing_z - 0.17), (0.05, 0.16, 0.36)))
    wing = empty("wing")
    adopt(wing, wing_parts)

    tail_bar = add_box("tail_strip", M["tail"], (0, ry_up + 0.004, 0.80), (1.3, 0.03, 0.035))
    tail_blades = [add_box(f"tail_blade_{s}", M["tail"], (x, ry_up, 0.78), (0.035, 0.03, 0.14)) for s, x in (("L", 0.66), ("R", -0.66))]
    tail = empty("taillight_bar")
    adopt(tail, [tail_bar] + tail_blades)
    sides = {"L": [], "R": []}
    for o in lights_front:                       # sort BEFORE joining: join() consumes the objects
        lo_, hi_ = bbox([o])
        sides["L" if (lo_[0] + hi_[0]) > 0 else "R"].append(o)
    for side, sgn in (("L", 1), ("R", -1)):
        if sides[side]:
            a, b = bbox(sides[side])
            cx, w = (a[0] + b[0]) / 2, (b[0] - a[0])
            add_box(f"drl_{side}", M["light"], (cx, a[1] - 0.005, a[2] + 0.6 * (b[2] - a[2])), (w * 0.9, 0.012, 0.016), (0, 0, sgn * 8))
        else:
            add_box(f"drl_{side}", M["light"], (sgn * 0.7, fy + 0.6, 0.55), (0.4, 0.012, 0.016), (0, 0, sgn * 8))
    if lights_rear:
        join(lights_rear, "taillight_housing")
    for side, objs in sides.items():
        if objs:
            join(objs, f"beam_{side}")

    # ---- 7. names + wheels --------------------------------------------------------------------------------------
    body.name = "body"
    misc.name = "trim_misc"
    for o in meshes():
        if o.get("mkey") in cfg.get("underbody", []):
            o.name = "underbody_" + o.name[-3:]
        elif o.data.materials and o.data.materials[0] in (M["interior"],) or (o.data.materials and o.data.materials[0] is M["carbon"] and o.name.startswith("Object_")):
            o.name = "interior_" + o.name
        elif o.name.startswith("Object_") and o.get("mkey") == cfg["mirror_glass"]:
            o.name = "mirror_glass"
        elif o.name.startswith("Object_") and o.data.materials and o.data.materials[0] is M["glass"]:
            o.name = "glass_" + o.name[-3:]
    for k, lst in corner.items():
        e = empty(f"wheel_{k}", hub[k])
        c = empty(f"caliper_{k}", hub[k])
        bpy.context.view_layer.update()
        adopt(e, [o for o in lst if o.data.materials[0] is not M["caliper"]])
        adopt(c, [o for o in lst if o.data.materials[0] is M["caliper"]])
        for o in lst:
            o.name = f"wheel_{k}_{o.data.materials[0].name}"

    tyre_o = max((o for o in corner["FL"] if o.data.materials[0] is M["tyre"]), key=lambda o: o.dimensions.z)
    tl, th = bbox([tyre_o])
    info = {
        "hubs_blender": {k: [round(float(v), 4) for v in hub[k]] for k in hub},
        "body_y": [round(float(fy), 3), round(float(ry), 3)], "body_x": [round(float(lo[0]), 3), round(float(hi[0]), 3)],
        "body_z_max": round(float(hi[2]), 3), "scale": round(float(S), 4), "tyre_radius": round(float(th[2] - tl[2]) / 2, 3),
        "length": round(float(hi[1] - lo[1]), 3),
    }
    json.dump(info, open(os.path.join(out, cfg["name"] + ".json"), "w"), indent=1)
    print("INFO", json.dumps(info))
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out, cfg["name"] + "_preview.blend"))
    bpy.ops.export_scene.gltf(filepath=os.path.join(out, cfg["name"] + "_raw.glb"), export_format="GLB", export_apply=True)
    print("wrote", out)

