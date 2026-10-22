"""Download the CC0 source assets for the city (no login needed) into assets_source/downloads/.

Run:  python3 -I assets_source/scripts/fetch_city_assets.py
Out:  assets_source/downloads/polyhaven/<id>/...      glTF models (1k textures) and texture maps
      assets_source/downloads/ambientcg/<id>/...      decals (unzipped)
      assets_source/downloads/manifest.json           what was fetched, from where, licence
The downloads folder is gitignored (raw third-party files are never committed); everything that
ships is rebuilt from it by make_city.py / build_city_assets.sh. Licences: Poly Haven and ambientCG
are CC0 1.0 (checked 2026-10-18 on https://polyhaven.com/license and https://ambientcg.com/license).
Credits are listed in CREDITS.md ("City" section).
"""
import json
import os
import sys
import urllib.request
import zipfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "assets_source", "downloads")
UA = {"User-Agent": "racing-game-asset-fetch/1.0 (CC0 assets, personal project)"}

# Poly Haven "hidden_alley" collection models (glTF + 1k textures; the .bin is full resolution and
# gets decimated into LODs by make_city.py).
PH_MODELS = ["street_lamp_01", "street_lamp_02", "fire_hydrant", "metal_trash_can", "utility_box_01", "utility_box_02",
             "concrete_road_barrier_02", "exterior_aircon_unit", "modular_fire_escape", "rollershutter_door",
             "rollershutter_window_01", "security_light", "modular_metal_gutter"]
# Poly Haven tiling PBR textures: id -> resolution
PH_TEXTURES = {"asphalt_02": "2k", "concrete_pavement": "1k", "granite_tile": "1k", "brick_wall_001": "1k",
               "painted_plaster_wall": "1k", "concrete_wall_003": "1k", "asphalt_04": "1k"}
PH_MAPS = ["Diffuse", "nor_gl", "Rough"]
# ambientCG decals (zip, 1K JPG/PNG)
ACG = {"RoadLines032C": "1K-PNG", "RoadLines035B": "1K-PNG", "ManholeCover004": "1K-PNG", "ManholeCover009": "1K-PNG",
       "AsphaltDamage001": "1K-PNG"}


def get(url, path):
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=120) as r, open(path + ".part", "wb") as f:
        while True:
            b = r.read(1 << 16)
            if not b:
                break
            f.write(b)
    os.replace(path + ".part", path)
    print("  got", os.path.relpath(path, ROOT), os.path.getsize(path) // 1024, "KB")
    return path


def api(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return json.load(r)


def safe_join(base, name):
    """Zip/API member path -> path inside base (refuses absolute paths and '..')."""
    p = os.path.normpath(os.path.join(base, name))
    if not p.startswith(os.path.abspath(base) + os.sep):
        raise ValueError("unsafe path in download: " + name)
    return p


def main():
    manifest = {"licence": "CC0 1.0", "assets": []}
    for mid in PH_MODELS:
        print("polyhaven model", mid)
        files = api(f"https://api.polyhaven.com/files/{mid}")
        g = files["gltf"]["1k"]["gltf"]
        base = os.path.join(OUT, "polyhaven", mid)
        get(g["url"], safe_join(base, os.path.basename(g["url"])))
        for rel, inc in g.get("include", {}).items():
            get(inc["url"], safe_join(base, rel))
        info = api(f"https://api.polyhaven.com/info/{mid}")
        manifest["assets"].append({"id": mid, "source": f"https://polyhaven.com/a/{mid}", "authors": list(info.get("authors", {})),
                                   "kind": "model", "licence": "CC0"})
    for tid, res in PH_TEXTURES.items():
        print("polyhaven texture", tid, res)
        files = api(f"https://api.polyhaven.com/files/{tid}")
        base = os.path.join(OUT, "polyhaven", tid)
        for m in PH_MAPS:
            u = files[m][res]["jpg"]["url"] if m != "nor_gl" else files[m][res]["png"]["url"] if "png" in files[m][res] else files[m][res]["jpg"]["url"]
            get(u, safe_join(base, os.path.basename(u)))
        info = api(f"https://api.polyhaven.com/info/{tid}")
        manifest["assets"].append({"id": tid, "source": f"https://polyhaven.com/a/{tid}", "authors": list(info.get("authors", {})),
                                   "kind": "texture", "licence": "CC0"})
    for aid, att in ACG.items():
        print("ambientcg", aid, att)
        z = get(f"https://ambientcg.com/get?file={aid}_{att}.zip", os.path.join(OUT, "ambientcg", f"{aid}_{att}.zip"))
        base = os.path.join(OUT, "ambientcg", aid)
        os.makedirs(base, exist_ok=True)
        with zipfile.ZipFile(z) as zf:
            for n in zf.namelist():
                if n.endswith("/") or not n.lower().endswith((".png", ".jpg")):
                    continue
                p = safe_join(base, os.path.basename(n))
                if not os.path.exists(p):
                    with zf.open(n) as src, open(p, "wb") as dst:
                        dst.write(src.read())
        manifest["assets"].append({"id": aid, "source": f"https://ambientcg.com/a/{aid}", "authors": ["ambientCG (Lennart Demes)"],
                                   "kind": "decal", "licence": "CC0"})
    with open(os.path.join(OUT, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    print("done:", len(manifest["assets"]), "assets")


if __name__ == "__main__":
    sys.exit(main())
