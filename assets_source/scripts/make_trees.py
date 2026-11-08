#!/usr/bin/env python3
"""Photoreal street-tree textures from CC0 scans (ambientCG, Lennart Demes; https://ambientcg.com/license, CC0 1.0).

    python3 assets_source/scripts/make_trees.py           # download (cached) + build web/public/assets/trees/

Leaves: each species' leaf set is cut into single leaves (connected components of the opacity scan), then composed
into a leaf-cluster card (a branchlet: twigs fanning from the base, leaves filling the cell, the lower layers darker), one
1024 px cell per species in a 3072 x 2048 atlas (RGBA WebP; 1 spare cell). Colour is flooded into every transparent pixel
(push-pull), so mipmaps never pull dark fringes into the leaves. Bark: colour + normal (1K) per bark type, re-encoded.
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
SPECIES = [  # id, leaf set, leaves per card, leaf size (fraction of the ~1.1 m card), darkening (night-adapted greens)
    ("plane", "LeafSet010", 58, 0.21, 0.62),     # palmate 20-25 cm
    ("locust", "LeafSet002", 170, 0.13, 0.70),   # fine compound sprigs
    ("pear", "LeafSet022", 280, 0.085, 0.62),    # 6-9 cm glossy ovals
    ("oak", "LeafSet016", 150, 0.12, 0.60),       # 10-15 cm lobed
    ("linden", "LeafSet004", 250, 0.09, 0.62),   # 5-8 cm hearts
]
BARKS = {"plane": "Bark009", "furrowed": "Bark001", "ridged": "Bark004"}
CELL = 1024
COLS = 3


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
    """One leaf-cluster card: a branchlet seen side-on. 3-5 twigs fan up from the bottom centre, each with side shoots; leaves
    hang along all of them until ~70 % of the cell is covered. Leaves are drawn back to front: the first (lower) layers are
    darker (self-shadowed), the last ones lit. No leaf crosses the cell edge."""
    rnd = random.Random(seed)
    img = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    anchors = []
    tw = rnd.randint(3, 5)
    for t in range(tw):
        x, y = CELL * 0.5 + rnd.uniform(-0.03, 0.03) * CELL, CELL * 0.99
        ang = -math.pi / 2 + (t - (tw - 1) / 2) * rnd.uniform(0.32, 0.42)
        pts = [(x, y)]
        for i in range(16):
            ang += rnd.uniform(-0.08, 0.08) - (ang + math.pi / 2) * 0.04
            x += math.cos(ang) * CELL * 0.05; y += math.sin(ang) * CELL * 0.05
            pts.append((x, y))
        d.line(pts, fill=(46, 35, 25, 255), width=max(3, int(CELL * 0.008)))
        anchors += pts[3:]
        for k in range(4, 16, 3):
            bx, by = pts[k]; side = 1 if (k + t) % 2 else -1; a2 = ang + side * rnd.uniform(0.6, 1.1)
            q = [(bx, by)]
            for j in range(rnd.randint(4, 7)):
                bx += math.cos(a2) * CELL * 0.035; by += math.sin(a2) * CELL * 0.035; a2 -= side * 0.06; q.append((bx, by))
            d.line(q, fill=(50, 38, 27, 255), width=max(2, int(CELL * 0.004)))
            anchors += q[1:]
    anchors = [(ax, ay) for ax, ay in anchors if 0.04 * CELL < ax < 0.96 * CELL and 0.03 * CELL < ay < 0.97 * CELL]
    placed = 0
    for i in range(n * 6):
        if placed >= n:
            break
        lf = rnd.choice(leaves)
        ax, ay = rnd.choice(anchors)
        s = size * CELL * rnd.uniform(0.75, 1.2) / max(lf.size)
        l2 = lf.resize((max(1, int(lf.size[0] * s)), max(1, int(lf.size[1] * s))), Image.LANCZOS)
        l2 = l2.rotate(rnd.uniform(-110, 110), expand=True, resample=Image.BICUBIC)
        px, py = int(ax - l2.size[0] / 2 + rnd.uniform(-0.02, 0.02) * CELL), int(ay - l2.size[1] * 0.5 + rnd.uniform(-0.02, 0.02) * CELL)
        if px < 3 or py < 3 or px + l2.size[0] > CELL - 3 or py + l2.size[1] > CELL - 3:
            continue
        depth = placed / max(1, n - 1)                       # 0 = first drawn (behind), 1 = front
        arr = np.array(l2).astype(np.float32)
        arr[..., :3] *= dark * (0.62 + 0.5 * depth) * rnd.uniform(0.85, 1.12)
        l2 = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
        img.alpha_composite(l2, (px, py))
        placed += 1
    print(f"    {placed} leaves")
    return img


def flood(img):
    """Push-pull colour fill of the transparent pixels (alpha unchanged): every mip level sees leaf colour, never black."""
    a = np.array(img).astype(np.float32) / 255.0
    rgb, al = a[..., :3], (a[..., 3:] > 0.02).astype(np.float32)
    levels = [(rgb * al, al)]
    while levels[-1][1].shape[0] > 1 and levels[-1][1].shape[1] > 1:
        c, w = levels[-1]
        h2, w2 = c.shape[0] // 2, c.shape[1] // 2
        c = c[:h2 * 2, :w2 * 2].reshape(h2, 2, w2, 2, 3).sum((1, 3)); w = w[:h2 * 2, :w2 * 2].reshape(h2, 2, w2, 2, 1).sum((1, 3))
        levels.append((c, w))
    fill = levels[-1][0] / np.maximum(levels[-1][1], 1e-6)
    for c, w in reversed(levels[:-1]):
        up = np.repeat(np.repeat(fill, 2, 0), 2, 1)
        up = np.pad(up, ((0, c.shape[0] - up.shape[0]), (0, c.shape[1] - up.shape[1]), (0, 0)), mode="edge")
        fill = np.where(w > 0, c / np.maximum(w, 1e-6), up)
    out = np.concatenate([fill, a[..., 3:]], -1)
    return Image.fromarray(np.clip(out * 255 + 0.5, 0, 255).astype(np.uint8), "RGBA")


def main():
    os.makedirs(OUT, exist_ok=True)
    atlas = Image.new("RGBA", (CELL * COLS, CELL * 2), (0, 0, 0, 0))
    for i, (sp, leafset, n, size, dark) in enumerate(SPECIES):
        lv = leaves_of(leafset)
        cell = flood(spray(lv, n, size, dark, seed=1000 + i))   # per cell: no colour from the neighbour species at coarse mips
        atlas.paste(cell, ((i % COLS) * CELL, (i // COLS) * CELL))
    flood(atlas).save(os.path.join(OUT, "leaves.webp"), "WEBP", quality=90, method=6, exact=True)
    for name, asset in BARKS.items():
        zf = fetch(asset, "1K-JPG")
        member(zf, "_Color.jpg").convert("RGB").resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, f"bark_{name}.jpg"), quality=86)
        member(zf, "_NormalGL.jpg").convert("RGB").resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, f"bark_{name}_n.jpg"), quality=90)
    json.dump({"source": "ambientCG (CC0 1.0, https://ambientcg.com/license)", "leaves": {s[0]: s[1] for s in SPECIES}, "barks": BARKS},
              open(os.path.join(OUT, "sources.json"), "w"), indent=1)
    print("wrote", OUT)


if __name__ == "__main__":
    sys.exit(main())
