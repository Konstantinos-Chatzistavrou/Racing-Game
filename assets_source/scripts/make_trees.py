#!/usr/bin/env python3
"""Photoreal street-tree textures from CC0 scans (ambientCG, Lennart Demes; https://ambientcg.com/license, CC0 1.0).

    python3 assets_source/scripts/make_trees.py           # download (cached) + build web/public/assets/trees/

Leaves: each species' leaf set is cut into single leaves (connected components of the opacity scan), then composed
into a leaf-spray card (a twig with leaves along it, the way a branch tip looks), one 512 px cell per species in a
2048 x 1024 atlas (RGBA WebP; 3 spare cells). Bark: colour + normal (1K) per bark type, re-encoded.
Species -> leaf set / bark (web/src/scene/nyc/trees.ts reads the same table):
    plane   LeafSet010 (palmate, maple-like)   Bark009 (mottled, peeling: London planetree)
    locust  LeafSet002 (small compound sprigs) Bark001 (deep grey furrows)
    pear    LeafSet022 (glossy ovals)          Bark004 (grey ridges)
    oak     LeafSet016 (lobed oak)             Bark001
    linden  LeafSet004 (heart-shaped)          Bark004
"""
import io, json, math, os, random, sys, urllib.request, zipfile
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DL = os.path.join(ROOT, "assets_source", "downloads", "ambientcg")
OUT = os.path.join(ROOT, "web", "public", "assets", "trees")
SPECIES = [  # id, leaf set, leaves per spray, leaf size (fraction of the cell), darkening (night-adapted greens)
    ("plane", "LeafSet010", 16, 0.30, 0.62),
    ("locust", "LeafSet002", 30, 0.20, 0.70),
    ("pear", "LeafSet022", 24, 0.20, 0.62),
    ("oak", "LeafSet016", 18, 0.25, 0.60),
    ("linden", "LeafSet004", 20, 0.24, 0.62),
]
BARKS = {"plane": "Bark009", "furrowed": "Bark001", "ridged": "Bark004"}
CELL = 512


def fetch(asset, attr):
    os.makedirs(DL, exist_ok=True)
    z = os.path.join(DL, f"{asset}_{attr}.zip")
    if not os.path.exists(z):
        print("download", asset, attr, flush=True)
        req = urllib.request.Request(f"https://ambientcg.com/get?file={asset}_{attr}.zip", headers={"User-Agent": "OpenGrid asset build (CC0 textures)"})
        with urllib.request.urlopen(req, timeout=120) as r, open(z + ".part", "wb") as f:
            f.write(r.read())
        os.replace(z + ".part", z)
    return zipfile.ZipFile(z)


def member(zf, suffix):
    for n in zf.namelist():
        if n.endswith(suffix):
            return Image.open(io.BytesIO(zf.read(n)))
    raise FileNotFoundError(suffix)


def leaves_of(asset):
    """Single leaves (RGBA crops) from a leaf-set scan: connected components of the opacity map."""
    zf = fetch(asset, "2K-JPG")
    col = member(zf, "_Color.jpg").convert("RGB")
    opa = member(zf, "_Opacity.jpg").convert("L")
    a = np.array(opa) > 128
    h, w = a.shape
    lab = np.zeros((h, w), np.int32)
    out = []
    nid = 0
    # flood fill on a 1/4 grid (fast enough for 2K), then crop at full resolution
    sm = a[::4, ::4]
    seen = np.zeros_like(sm, bool)
    for y in range(sm.shape[0]):
        for x in range(sm.shape[1]):
            if not sm[y, x] or seen[y, x]:
                continue
            stack = [(y, x)]; seen[y, x] = True; ys = []; xs = []
            while stack:
                cy, cx = stack.pop(); ys.append(cy); xs.append(cx)
                for ny, nx in ((cy + 1, cx), (cy - 1, cx), (cy, cx + 1), (cy, cx - 1)):
                    if 0 <= ny < sm.shape[0] and 0 <= nx < sm.shape[1] and sm[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True; stack.append((ny, nx))
            if len(ys) < 60:
                continue
            y0, y1, x0, x1 = min(ys) * 4, (max(ys) + 1) * 4, min(xs) * 4, (max(xs) + 1) * 4
            crop = col.crop((x0, y0, x1, y1)).convert("RGBA")
            crop.putalpha(opa.crop((x0, y0, x1, y1)))
            out.append(crop)
            nid += 1
    print(f"  {asset}: {len(out)} leaves")
    return out


def spray(leaves, n, size, dark, seed):
    """One leaf-spray card: a gently curved twig from the bottom centre with leaves along it and on side shoots."""
    rnd = random.Random(seed)
    img = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pts = []
    x, y, ang = CELL * 0.5, CELL * 0.97, -math.pi / 2 + rnd.uniform(-0.12, 0.12)
    for i in range(15):   # main twig: ~60 % of the cell
        pts.append((x, y)); ang += rnd.uniform(-0.07, 0.07); x += math.cos(ang) * CELL * 0.04; y += math.sin(ang) * CELL * 0.04
    d.line(pts, fill=(48, 36, 26, 255), width=5)
    shoots = []
    for k in range(3, 15, 2):   # side shoots fan out, longest low down: the spray is broad, like a real branch tip
        bx, by = pts[k]; side = 1 if (k // 2) % 2 else -1; a2 = -math.pi / 2 + side * rnd.uniform(0.75, 1.25)
        q = [(bx, by)]
        for j in range(int(9 - k * 0.35)):
            bx += math.cos(a2) * CELL * 0.035; by += math.sin(a2) * CELL * 0.035; a2 -= side * 0.07; q.append((bx, by))
        d.line(q, fill=(52, 40, 28, 255), width=3)
        shoots.append(q)
    anchors = pts[4:] + [p for q in shoots for p in q[1:]]
    placed = 0
    for i in range(n * 4):
        if placed >= n:
            break
        lf = rnd.choice(leaves)
        ax, ay = rnd.choice(anchors)
        s = size * CELL * rnd.uniform(0.75, 1.15) / max(lf.size)
        l2 = lf.resize((max(1, int(lf.size[0] * s)), max(1, int(lf.size[1] * s))), Image.LANCZOS)
        l2 = l2.rotate(rnd.uniform(-80, 80), expand=True, resample=Image.BICUBIC)
        px, py = int(ax - l2.size[0] / 2), int(ay - l2.size[1] * 0.85)
        if px < 4 or py < 4 or px + l2.size[0] > CELL - 4 or py + l2.size[1] > CELL - 4:
            continue   # never crosses the cell edge (no cut-off leaves)
        # slight per-leaf tone variation (older / younger leaves, light angle)
        arr = np.array(l2).astype(np.float32)
        arr[..., :3] *= dark * rnd.uniform(0.8, 1.15)
        l2 = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
        img.alpha_composite(l2, (px, py))
        placed += 1
    # premultiplied-safe edge: bleed colour into transparent pixels so mipmaps do not halo
    rgb = img.convert("RGB").filter(ImageFilter.MaxFilter(5))
    bleed = Image.composite(img.convert("RGB"), rgb, img.getchannel("A"))
    out = bleed.convert("RGBA"); out.putalpha(img.getchannel("A"))
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    atlas = Image.new("RGBA", (CELL * 4, CELL * 2), (0, 0, 0, 0))
    for i, (sp, leafset, n, size, dark) in enumerate(SPECIES):
        lv = leaves_of(leafset)
        cell = spray(lv, n, size, dark, seed=1000 + i)
        atlas.alpha_composite(cell, ((i % 4) * CELL, (i // 4) * CELL))
    atlas.save(os.path.join(OUT, "leaves.webp"), "WEBP", quality=88, method=6)
    for name, asset in BARKS.items():
        zf = fetch(asset, "1K-JPG")
        member(zf, "_Color.jpg").convert("RGB").resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, f"bark_{name}.jpg"), quality=86)
        member(zf, "_NormalGL.jpg").convert("RGB").resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, f"bark_{name}_n.jpg"), quality=90)
    json.dump({"source": "ambientCG (CC0 1.0, https://ambientcg.com/license)", "leaves": {s[0]: s[1] for s in SPECIES}, "barks": BARKS},
              open(os.path.join(OUT, "sources.json"), "w"), indent=1)
    print("wrote", OUT)


if __name__ == "__main__":
    sys.exit(main())
