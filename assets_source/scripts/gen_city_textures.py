"""City textures composed from the CC0 downloads (hi-fi pass). Blender's Python is used for numpy.

Run:  tools/blender/blender -b --factory-startup --python assets_source/scripts/gen_city_textures.py
In:   assets_source/downloads/ (fetch_city_assets.py)
Out:  assets_source/build/textures/*.png  (gitignored; packed into city.glb by make_city.py)

Facade "window bay" maps: ONE bay = one window = 3.0 m wide x 3.2 m tall (one floor). Facades are
UV-mapped in bay units (u = bays along the wall, v = floors above the ground floor line), so the
texture repeats per window and every window lines up with the floors. The wall material under the
window is real Poly Haven PBR (brick / plaster / render), the window is drawn on top:
  glass  u 0.28-0.72, v 0.30-0.82   dark, glossy (reflects the lamps); its emissive mask is the
                                    "lit window" layer, coloured per window at runtime (city.ts)
  frame  aluminium/white frame + mullion + transom; reveal (wall depth) shaded + normal-tilted
  sill   stone sill under the window (the 3D sill instances sit on it near the camera)
v below 0.25 is plain wall: parapets / plinths reuse it.
Shopfront bay: 3.0 m x 4.0 m (ground floor of shop buildings): plinth, glazing with frames, blank
fascia board (deliberately no text: generic street, no brands), soft LED strip under the fascia.
Road: worn lane paint (alpha mask) and a decal atlas (manhole + asphalt patch, ambientCG).
"""
import os

import bpy
import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DL = os.path.join(ROOT, "assets_source", "downloads")
OUT = os.path.join(ROOT, "assets_source", "build", "textures")
rng = np.random.default_rng(5)


# ------------------------------------------------------------------ image io (Blender: bottom-up rows = v up)
def load(path):
    im = bpy.data.images.load(path)
    w, h = im.size
    a = np.array(im.pixels[:], dtype=np.float32).reshape(h, w, 4)
    bpy.data.images.remove(im)
    return a


def ph(tid, kind):
    d = os.path.join(DL, "polyhaven", tid)
    f = [n for n in os.listdir(d) if kind in n]
    return load(os.path.join(d, sorted(f)[0]))


def acg(aid, kind):
    d = os.path.join(DL, "ambientcg", aid)
    return load(os.path.join(d, f"{aid}_1K-PNG_{kind}.png"))


def save(name, a, colour=True):
    h, w = a.shape[:2]
    if a.shape[2] == 3:
        a = np.concatenate([a, np.ones((h, w, 1), np.float32)], axis=2)
    im = bpy.data.images.new(name, w, h, alpha=True, float_buffer=False)
    if not colour:
        im.colorspace_settings.name = "Non-Color"
    im.pixels[:] = np.clip(a, 0, 1).ravel()
    os.makedirs(OUT, exist_ok=True)
    im.filepath_raw = os.path.join(OUT, name + ".png")
    im.file_format = "PNG"
    im.save()
    bpy.data.images.remove(im)
    print("[tex]", name, w, "x", h)


def sample(src, u, v):
    """Bilinear, wrapping sample of src (H, W, C) at arrays u, v (texture repeats)."""
    h, w = src.shape[:2]
    x = (u % 1.0) * w - 0.5
    y = (v % 1.0) * h - 0.5
    x0 = np.floor(x).astype(int)
    y0 = np.floor(y).astype(int)
    fx = (x - x0)[..., None]
    fy = (y - y0)[..., None]
    x0 %= w
    y0 %= h
    x1 = (x0 + 1) % w
    y1 = (y0 + 1) % h
    return (src[y0, x0] * (1 - fx) * (1 - fy) + src[y0, x1] * fx * (1 - fy) + src[y1, x0] * (1 - fx) * fy + src[y1, x1] * fx * fy)


def grid(w, h):
    u, v = np.meshgrid((np.arange(w) + 0.5) / w, (np.arange(h) + 0.5) / h)
    return u, v


def noise(w, h, cells, octaves=4, seed=0):
    """Tileable value noise in [0, 1]."""
    r = np.random.default_rng(seed)
    u, v = grid(w, h)
    acc = np.zeros((h, w), np.float32)
    amp, tot = 1.0, 0.0
    for o in range(octaves):
        c = cells * (2 ** o)
        g = r.random((c, c, 1)).astype(np.float32)
        acc += amp * sample(g, u, v)[..., 0]
        tot += amp
        amp *= 0.5
    return acc / tot


def box(u, v, u0, u1, v0, v1):
    return (u >= u0) & (u < u1) & (v >= v0) & (v < v1)


def nrm_pack(n):
    n = n / np.linalg.norm(n, axis=2, keepdims=True)
    return n * 0.5 + 0.5


# ------------------------------------------------------------------ facade window bays
GLASS = (0.28, 0.72, 0.30, 0.82)


def facade(name, tid, size, tiles_u, tiles_v, frame_col, sill_col, lintel=False, tint=(1, 1, 1)):
    W = H = size
    u, v = grid(W, H)
    alb_src, nor_src, rgh_src = ph(tid, "diff")[..., :3], ph(tid, "nor_gl")[..., :3], ph(tid, "rough")[..., :1]
    su, sv = u * tiles_u, v * tiles_v
    alb = sample(alb_src, su, sv) * np.array(tint, np.float32)
    nor = sample(nor_src, su, sv) * 2 - 1
    rgh = sample(rgh_src, su, sv)[..., 0]
    emi = np.zeros((H, W), np.float32)
    g0, g1, h0, h1 = GLASS
    rv = 0.028                                              # reveal (wall depth) width in bay units
    opening = box(u, v, g0 - rv, g1 + rv, h0, h1 + rv)
    # soft ambient occlusion around the opening (the recess shades the wall next to it)
    du = np.maximum(np.maximum(g0 - rv - u, u - (g1 + rv)), 0)
    dv = np.maximum(np.maximum(h0 - v, v - (h1 + rv)), 0)
    d = np.sqrt(du ** 2 + dv ** 2)
    ao = 1 - 0.35 * np.exp(-d / 0.012)
    alb *= ao[..., None]
    # lintel: a darker soldier course / stone header above the window
    if lintel:
        lt = box(u, v, g0 - rv - 0.02, g1 + rv + 0.02, h1 + rv, h1 + rv + 0.055)
        stripes = (np.floor((u - g0) / 0.03) % 2) * 0.06
        alb[lt] = alb[lt] * (0.78 + stripes[lt, None])
        nor[lt] = nor[lt] * 0.5 + np.array([0, 0, 0.5])
    # reveals: left reveal faces +u (lit from the right), right faces -u, head faces down
    left = box(u, v, g0 - rv, g0, h0, h1 + rv)
    right = box(u, v, g1, g1 + rv, h0, h1 + rv)
    head = box(u, v, g0, g1, h1, h1 + rv)
    rev_col = alb_src.mean(axis=(0, 1)) * 0.55 * np.array(tint, np.float32)
    for m, n in ((left, (0.8, 0, 0.6)), (right, (-0.8, 0, 0.6)), (head, (0, -0.8, 0.6))):
        alb[m] = rev_col
        nor[m] = n
        rgh[m] = 0.85
    # glass
    glass = box(u, v, g0, g1, h0, h1)
    gv = (v - h0) / (h1 - h0)
    alb[glass] = (np.array([0.018, 0.021, 0.026]) * (0.8 + 0.4 * gv[glass, None]))
    nor[glass] = (0, 0, 1)
    rgh[glass] = 0.06
    # interior seen through the glass when lit: ceiling brighter, a curtain edge on some windows
    curtain = 0.55 + 0.45 * np.clip((u - g0) / (g1 - g0) * 3, 0, 1) * np.clip((g1 - u) / (g1 - g0) * 3, 0, 1)
    emi[glass] = (0.55 + 0.45 * gv[glass]) * curtain[glass]
    # frame: outer frame, mullion, transom
    f = 0.016
    frame = glass & (box(u, v, g0, g0 + f, 0, 1) | box(u, v, g1 - f, g1, 0, 1) | box(u, v, 0, 1, h0, h0 + f * 1.3)
                     | box(u, v, 0, 1, h1 - f, h1) | box(u, v, 0.5 - f / 2, 0.5 + f / 2, 0, 1) | box(u, v, 0, 1, 0.70, 0.70 + f))
    alb[frame] = frame_col
    nor[frame] = (0, 0, 1)
    rgh[frame] = 0.45
    emi[frame] = 0
    # sill: stone, slightly wider than the opening, top faces up
    sill = box(u, v, g0 - rv - 0.02, g1 + rv + 0.02, h0 - 0.03, h0)
    sn = noise(W, H, 16, 3, 9)
    alb[sill] = np.array(sill_col) * (0.85 + 0.3 * sn[sill, None])
    nor[sill] = (0, 0.55, 0.83)
    rgh[sill] = 0.7
    under = box(u, v, g0 - rv - 0.02, g1 + rv + 0.02, h0 - 0.045, h0 - 0.03)   # shadow line under the sill
    alb[under] *= 0.45
    save(f"{name}_albedo", alb)
    save(f"{name}_normal", nrm_pack(nor), colour=False)
    save(f"{name}_rough", np.repeat(rgh[..., None], 3, axis=2), colour=False)
    save(f"{name}_emit", np.repeat(emi[..., None], 3, axis=2))


def shopfront():
    W, H = 1024, 1024                       # 3.0 m x 4.0 m
    u, v = grid(W, H)
    gr_a, gr_n = ph("granite_tile", "diff")[..., :3], ph("granite_tile", "nor_gl")[..., :3]
    alb = np.zeros((H, W, 3), np.float32)
    nor = np.zeros((H, W, 3), np.float32)
    nor[..., 2] = 1
    rgh = np.full((H, W), 0.5, np.float32)
    emi = np.zeros((H, W), np.float32)
    plinth = v < 0.05
    alb[plinth] = sample(gr_a, u * 1.3, v * 1.7)[plinth] * 0.8
    nor[plinth] = (sample(gr_n, u * 1.3, v * 1.7) * 2 - 1)[plinth]
    rgh[plinth] = 0.6
    frame_c = np.array([0.09, 0.09, 0.095])
    sf = (v >= 0.05) & (v < 0.80)
    alb[sf] = frame_c
    rgh[sf] = 0.35
    # kick panel
    kick = box(u, v, 0.03, 0.97, 0.05, 0.12)
    alb[kick] = (0.05, 0.05, 0.055)
    # two panes
    pn = noise(W, H, 8, 3, 3)
    for a, b in ((0.035, 0.49), (0.51, 0.965)):
        p = box(u, v, a, b, 0.125, 0.765)
        gv = (v - 0.125) / 0.64
        alb[p] = np.array([0.02, 0.022, 0.026]) * (0.9 + 0.2 * gv[p, None])
        rgh[p] = 0.05
        # interior: ceiling light band, shelving rows, a darker floor; random per pane
        shelves = 0.75 + 0.25 * (np.floor(gv * 6) % 2)
        e = (0.35 + 0.65 * gv) * shelves * (0.85 + 0.3 * pn)
        emi[p] = e[p]
        # mullion bevel shading at pane edges
        edge = p & ~box(u, v, a + 0.006, b - 0.006, 0.131, 0.759)
        alb[edge] = frame_c * 1.6
        emi[edge] = 0
    # head + fascia board (blank: no lettering anywhere)
    fascia = box(u, v, 0, 1, 0.80, 0.965)
    fn = noise(W, H, 32, 3, 4)
    alb[fascia] = np.array([0.06, 0.065, 0.07]) * (0.85 + 0.3 * fn[fascia, None])
    rgh[fascia] = 0.55
    strip = box(u, v, 0.02, 0.98, 0.80, 0.807)               # LED strip under the board
    alb[strip] = (0.9, 0.9, 0.85)
    emi[strip] = 0.7
    trim = v >= 0.965
    alb[trim] = (0.32, 0.31, 0.29)
    nor[trim] = (0, 0.5, 0.86)
    rgh[trim] = 0.7
    save("shop_albedo", alb)
    save("shop_normal", nrm_pack(nor), colour=False)
    save("shop_rough", np.repeat(rgh[..., None], 3, axis=2), colour=False)
    save("shop_emit", np.repeat(emi[..., None], 3, axis=2))


# ------------------------------------------------------------------ road paint + decals
def paint():
    """Worn white lane paint: RGB = paint colour with grime, A = coverage (alpha-tested).
    u = across the line (0..1), v = along (1 texture = 4 m)."""
    W, H = 128, 1024
    u, v = grid(W, H)
    n1 = noise(W, H, 8, 5, 21)
    n2 = noise(W, H, 32, 3, 22)
    edge = np.minimum(u, 1 - u)                               # ragged edges
    cover = (n1 * 0.7 + n2 * 0.5 + np.clip(edge * 6, 0, 1) * 0.6) - 0.62
    a = np.clip(cover * 6 + 0.5, 0, 1)
    col = np.stack([0.80 + 0.1 * n2, 0.80 + 0.1 * n2, 0.76 + 0.1 * n2], axis=2) * (0.75 + 0.25 * n1[..., None])
    save("paint_albedo", np.concatenate([col, a[..., None]], axis=2))
    r = 0.55 + 0.25 * n2
    save("paint_rough", np.repeat(r[..., None], 3, axis=2), colour=False)


def decals():
    """Atlas 2048 x 1024: left = round manhole cover (ManholeCover009), right = asphalt patch
    (AsphaltDamage001). RGBA albedo (A = opacity), normal, roughness."""
    W, H = 2048, 1024
    alb = np.zeros((H, W, 4), np.float32)
    nor = np.zeros((H, W, 3), np.float32)
    rgh = np.zeros((H, W, 3), np.float32)
    for k, aid in enumerate(("ManholeCover009", "AsphaltDamage001")):
        c = acg(aid, "Color")[..., :3]
        o = acg(aid, "Opacity")[..., :1]
        n = acg(aid, "NormalGL")[..., :3]
        r = acg(aid, "Roughness")[..., :3]
        if aid.startswith("Manhole"):
            c = c * 0.55                                       # dark cast iron at night
        def fit(x):
            if x.shape[0] != H:
                yy, xx = np.meshgrid((np.arange(H) + 0.5) / H, (np.arange(H) + 0.5) / H)
                x = sample(x, yy, xx)
            return x
        sl = slice(k * H, (k + 1) * H)
        alb[:, sl, :3] = fit(c)
        alb[:, sl, 3:] = fit(o)
        nor[:, sl] = fit(n)
        rgh[:, sl] = fit(r)
    save("decal_albedo", alb)
    save("decal_normal", nor, colour=False)
    save("decal_rough", rgh, colour=False)


def main():
    facade("facade_brick", "brick_wall_001", 2048, 1.0, 1.0, (0.78, 0.77, 0.74), (0.55, 0.53, 0.5), lintel=True)
    facade("facade_plaster", "painted_plaster_wall", 1024, 1.0, 1.0, (0.12, 0.12, 0.13), (0.62, 0.6, 0.57), tint=(0.86, 0.84, 0.8))
    facade("facade_render", "concrete_wall_003", 1024, 1.0, 1.0, (0.2, 0.19, 0.18), (0.5, 0.49, 0.47))
    shopfront()
    paint()
    decals()


main()
