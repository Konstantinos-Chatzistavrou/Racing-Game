"""Generate all tileable PBR textures for the street circuit and cars.

Source of truth: this script. Output: assets_source/textures/*.png (full resolution).
Run:  tools/blender/5.2/python/bin/python3.13 assets_source/scripts/gen_textures.py

Technique: "spectral synthesis". Random complex noise is shaped in the frequency domain by an
amplitude falloff  A(f) = f^(-beta/2)  (beta = 2 gives natural "brownian" textures, higher beta =
smoother). The inverse FFT of that spectrum is automatically TILEABLE because the FFT treats the
image as periodic, which is exactly what a repeating texture needs.
"""
import os
import sys
import zlib
import struct
import numpy as np

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "textures")
os.makedirs(OUT, exist_ok=True)


# ----------------------------------------------------------------------------- helpers
def save_png(name, img):
    """img: float array HxW (gray) or HxWx3/4 in [0,1]. Minimal PNG writer (no PIL needed)."""
    a = np.clip(img, 0.0, 1.0)
    if a.ndim == 2:
        a = a[..., None]
    h, w, c = a.shape
    color_type = {1: 0, 3: 2, 4: 6}[c]
    raw = (a * 255.0 + 0.5).astype(np.uint8)
    rows = b"".join(b"\x00" + raw[y].tobytes() for y in range(h))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, color_type, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(rows, 6)) + chunk(b"IEND", b"")
    with open(os.path.join(OUT, name + ".png"), "wb") as f:
        f.write(png)
    print("wrote", name, f"{w}x{h}")


def noise(n, beta, seed, fmin=0.0, fmax=1.0):
    """Tileable fractal noise in [0,1]. fmin/fmax (fractions of Nyquist) band-limit the spectrum."""
    rng = np.random.default_rng(seed)
    f = np.fft.fftfreq(n)
    fx, fy = np.meshgrid(f, f)
    r = np.sqrt(fx * fx + fy * fy)
    r[0, 0] = 1.0
    amp = r ** (-beta / 2.0)
    amp[(r < fmin * 0.5) | (r > fmax * 0.5)] = 0.0
    amp[0, 0] = 0.0
    spec = (rng.standard_normal((n, n)) + 1j * rng.standard_normal((n, n))) * amp
    img = np.real(np.fft.ifft2(spec))
    img -= img.min()
    return img / max(img.max(), 1e-9)


def normal_from_height(h, strength):
    """Tangent-space normal map (OpenGL / glTF convention, +Y up) from a height field.
    n = normalize(-dh/dx * s, +dh/dy * s, 1)  (image rows grow downward, so dy flips sign)."""
    dx = (np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)) * 0.5
    dy = (np.roll(h, -1, axis=0) - np.roll(h, 1, axis=0)) * 0.5
    nx, ny, nz = -dx * strength, dy * strength, np.ones_like(h)
    l = np.sqrt(nx * nx + ny * ny + nz * nz)
    return np.stack([nx / l, ny / l, nz / l], -1) * 0.5 + 0.5


def srgb(lin):
    """Linear -> sRGB transfer, so colour values below can be written in linear (physical) terms."""
    lin = np.clip(lin, 0, 1)
    return np.where(lin <= 0.0031308, lin * 12.92, 1.055 * np.power(lin, 1 / 2.4) - 0.055)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


# ----------------------------------------------------------------------------- asphalt (tile = 4 m)
def asphalt():
    n = 2048
    base = noise(n, 2.2, 1)                          # large blotches (patching, stains)
    grit = noise(n, 0.6, 2, fmin=0.25)               # aggregate stones: mostly high frequency
    stones = smoothstep(0.62, 0.75, grit)            # bright exposed stones
    pits = smoothstep(0.38, 0.30, grit)              # dark gaps between stones
    # Real asphalt albedo ~0.04-0.12 (linear). Wet darkens further; that's done in the shader.
    lin = 0.055 + 0.03 * (base - 0.5) + 0.06 * stones - 0.025 * pits
    tint = np.stack([lin * 1.0, lin * 1.0, lin * 1.04], -1)
    save_png("asphalt_albedo", srgb(tint))
    height = 0.6 * grit + 0.4 * stones - 0.5 * pits
    save_png("asphalt_normal", normal_from_height(height, 6.0))
    # Roughness: stones are polished by tyres (smoother) and pits hold water (smoother).
    rough = 0.62 + 0.12 * (base - 0.5) - 0.15 * stones - 0.2 * pits
    save_png("asphalt_rough", rough)


def puddles():
    """Large-scale wetness mask (tile = 64 m). 1 = standing water, 0 = damp."""
    n = 512
    m = noise(n, 3.2, 11)
    m = smoothstep(0.58, 0.70, m) * 0.9 + 0.1 * smoothstep(0.45, 0.6, m)
    save_png("puddle_mask", m)


# ----------------------------------------------------------------------------- kerb (tile = 2 m long, 1 m wide)
def kerb():
    w, h = 1024, 512   # u = along track (2 m), v = across kerb (1 m)
    u = np.linspace(0, 1, w, endpoint=False)[None, :].repeat(h, 0)
    wear = noise(1024, 1.8, 21)[:h, :w]
    chips = smoothstep(0.72, 0.8, noise(1024, 0.8, 22, fmin=0.15)[:h, :w])
    stripe = (u < 0.5).astype(float)                 # 1 m red, 1 m white
    red = np.array([0.55, 0.03, 0.02])
    white = np.array([0.72, 0.72, 0.70])
    col = stripe[..., None] * red + (1 - stripe[..., None]) * white
    col = col * (0.85 + 0.15 * wear[..., None])
    col = col * (1 - chips[..., None]) + chips[..., None] * np.array([0.06, 0.06, 0.06])   # worn to concrete
    col = col * (1 - 0.35 * smoothstep(0.6, 0.9, wear[..., None]))                         # rubber marks
    save_png("kerb_albedo", srgb(col))
    hgt = noise(1024, 1.2, 23)[:h, :w] * 0.3 - chips * 0.5
    save_png("kerb_normal", normal_from_height(hgt, 4.0))


# ----------------------------------------------------------------------------- concrete pavement (tile = 3 m, 2x2 slabs)
def concrete():
    n = 1024
    yy, xx = np.mgrid[0:n, 0:n] / n
    joint = np.minimum(np.abs((xx * 2) % 1 - 0.0), np.abs((xx * 2) % 1 - 1.0))
    joint = np.minimum(joint, np.minimum(np.abs((yy * 2) % 1), np.abs((yy * 2) % 1 - 1.0)))
    grooves = smoothstep(0.006, 0.0, joint)
    b = noise(n, 2.0, 31)
    g = noise(n, 0.7, 32, fmin=0.2)
    lin = 0.16 + 0.05 * (b - 0.5) + 0.03 * (g - 0.5) - 0.1 * grooves
    save_png("concrete_albedo", srgb(np.stack([lin, lin * 0.98, lin * 0.95], -1)))
    save_png("concrete_normal", normal_from_height(0.3 * g + 0.2 * b - 1.0 * grooves, 3.0))
    save_png("concrete_rough", 0.75 + 0.1 * (b - 0.5) - 0.25 * grooves)


# ----------------------------------------------------------------------------- building facade (tile = 24 m x 24 m, 8 x 8 windows)
def facade(variant, seed):
    """Albedo + emission (lit windows) + roughness. One texture tile is 8 bays x 8 floors (3 m each)."""
    n = 2048
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:n, 0:n] / n
    COLS = 16                                   # 1.5 m bays
    cell_x, cell_y = (xx * COLS) % 1, (yy * 8) % 1
    ix, iy = (xx * COLS).astype(int), (yy * 8).astype(int)
    if variant == 0:   # office: ribbon glazing with thin mullions and a solid spandrel per floor
        win = (cell_x > 0.04) & (cell_x < 0.96) & (cell_y > 0.28) & (cell_y < 0.92)
        wall_lin = np.array([0.20, 0.19, 0.18])
    else:              # brick apartments: narrow tall windows
        win = ((xx * 8) % 1 > 0.30) & ((xx * 8) % 1 < 0.70) & (cell_y > 0.18) & (cell_y < 0.80)
        ix = (xx * 8).astype(int)
        wall_lin = np.array([0.18, 0.07, 0.045])
    dirt = noise(n, 2.2, seed + 1)
    wall = wall_lin * (0.8 + 0.4 * dirt[..., None])
    if variant == 1:   # brick courses
        brick = ((yy * 8 * 40) % 1 < 0.12) | ((((xx * 8 * 12) + 0.5 * ((yy * 8 * 40).astype(int) % 2)) % 1) < 0.06)
        wall = np.where(brick[..., None], wall * 1.6 + 0.04, wall)
    # Per-window state: ~35% lit, random warm/cool colour temperature, some with blinds.
    lit = rng.random((8, COLS)) < 0.32
    lit = lit | np.roll(lit, 1, axis=1) & (rng.random((8, COLS)) < 0.5)   # lit rooms span 2-3 bays
    warm = rng.random((8, COLS)) < 0.7
    blind = rng.random((8, COLS))
    level_rnd = 0.25 + 0.75 * rng.random((8, COLS))
    lit_px = lit[iy, ix] & win
    warm_px = warm[iy, ix]
    blind_px = cell_y > (0.18 + 0.64 * blind[iy, ix])          # blind pulled down to a random height
    glass = np.array([0.02, 0.025, 0.03])
    albedo = np.where(win[..., None], glass, wall)
    save_png(f"facade{variant}_albedo", srgb(albedo))
    # Emission: interior glow with a soft vertical gradient (ceiling lights), dimmer behind blinds.
    warm_c = np.array([1.0, 0.62, 0.30])
    cool_c = np.array([0.65, 0.80, 1.0])
    c = np.where(warm_px[..., None], warm_c, cool_c)
    grad = 0.6 + 0.4 * (1 - cell_y)
    level = np.where(blind_px, 0.35, 1.0) * grad * level_rnd[iy, ix]
    emis = np.where(lit_px[..., None], c * level[..., None], 0.0)
    save_png(f"facade{variant}_emission", emis)
    rough = np.where(win, 0.05, 0.85 - 0.1 * dirt)
    save_png(f"facade{variant}_rough", rough)


def grass():
    n = 1024
    b = noise(n, 2.4, 41)
    g = noise(n, 0.5, 42, fmin=0.3)
    lin = np.stack([0.025 + 0.02 * b, 0.05 + 0.04 * b + 0.03 * g, 0.018 + 0.01 * b], -1)
    save_png("grass_albedo", srgb(lin))
    save_png("grass_normal", normal_from_height(g, 5.0))




def fence():
    """Chain-link catch fence, RGBA (alpha = wire). Tile = 1 m x 1 m, 50 mm diamond mesh."""
    n = 512
    yy, xx = np.mgrid[0:n, 0:n] / n * 20.0          # 20 diamonds per metre-tile
    a = np.abs(((xx + yy) % 1.0) - 0.5)
    b = np.abs(((xx - yy) % 1.0) - 0.5)
    wire = np.maximum(smoothstep(0.43, 0.48, a), smoothstep(0.43, 0.48, b))
    col = np.stack([np.full_like(wire, 0.55), np.full_like(wire, 0.57), np.full_like(wire, 0.6), wire], -1)
    save_png("fence_rgba", col)


def shopfront():
    """Ground-floor shop windows, tile = 12 m wide x 4 m tall (3 shops). Albedo + emission."""
    w, h = 1536, 512
    rng = np.random.default_rng(300)
    xx = np.linspace(0, 1, w, endpoint=False)[None, :].repeat(h, 0)
    yy = np.linspace(0, 1, h, endpoint=False)[:, None].repeat(w, 1)
    shop = (xx * 3).astype(int)
    cx = (xx * 3) % 1
    frame = (cx < 0.04) | (cx > 0.96) | (yy < 0.10) | (yy > 0.78)          # pillars, sign band, base
    mull = (((cx * 4) % 1) < 0.03) & (yy > 0.10) & (yy < 0.78)               # window mullions
    door = (cx > 0.42) & (cx < 0.58) & (yy > 0.10) & (yy < 0.70)
    glass = ~frame & ~mull
    lit = rng.random(3) < 0.75
    tint = np.array([[1.0, 0.75, 0.45], [0.75, 0.9, 1.0], [1.0, 0.55, 0.35]])[rng.integers(0, 3, 3)]
    wall = np.array([0.06, 0.055, 0.05])
    albedo = np.where(glass[..., None], np.array([0.02, 0.02, 0.025]), wall)
    albedo = np.where((yy > 0.80)[..., None], np.array([0.03, 0.03, 0.035]), albedo)   # sign fascia
    save_png("shopfront_albedo", srgb(albedo))
    # interior glow: brighter at the top (ceiling lights), shelves suggested by horizontal bands
    shelves = 0.75 + 0.25 * (np.sin(yy * 60) > 0.6)
    glow = (0.5 + 0.5 * (1 - yy)) * shelves
    emis = np.where((glass & lit[shop])[..., None], tint[shop] * glow[..., None], 0.0)
    emis = np.where(door[..., None], emis * 0.6, emis)
    save_png("shopfront_emission", emis)


if __name__ == "__main__":
    asphalt()
    puddles()
    kerb()
    concrete()
    facade(0, 100)
    facade(1, 200)
    grass()
    fence()
    shopfront()
