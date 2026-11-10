#!/usr/bin/env python3
"""Garage surface textures: fetch the CC0 PBR sets from Poly Haven, resize, and block-compress to KTX2.

    python3 tools/garage/build_textures.py

Output: web/public/assets/garage/tex/<set>_<map>.ktx2  (diff = sRGB colour, nor = OpenGL normal, arm = AO/rough/metal).
Normals are UASTC (RDO + zstd), colour and ARM are ETC1S: on desktop both transcode to BC7 (1 byte per pixel in VRAM).
Needs KTX-Software 4.4.2 in tools/ktx/ (gitignored, see docs/car_model_v3.md) and Pillow. Downloads are cached in
tools/garage/.cache/ (gitignored). All sets are CC0 (polyhaven.com/license).
"""
import json, os, subprocess, sys, urllib.request
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CACHE = os.path.join(ROOT, 'tools', 'garage', '.cache')
OUT = os.path.join(ROOT, 'web', 'public', 'assets', 'garage', 'tex')
KTX = os.path.join(ROOT, 'tools', 'ktx', 'KTX-Software-4.4.2-Linux-x86_64')
UA = {'User-Agent': 'asset-fetch/1.0'}

# set -> (source resolution, {map: output size})
SETS = {
    'painted_concrete_02': ('2k', {'diff': 1024, 'nor': 1024, 'arm': 1024}),     # floor
    'factory_brick': ('1k', {'diff': 1024, 'nor': 1024}),                        # lower walls
    'corrugated_iron_02': ('1k', {'diff': 512, 'nor': 1024, 'arm': 512}),        # upper walls, ceiling
    'painted_metal_shutter': ('1k', {'diff': 512, 'nor': 512, 'arm': 512}),      # roller doors
    'rubber_tiles': ('1k', {'diff': 512, 'nor': 512}),                           # turntable deck
    'concrete_wall_008': ('1k', {'diff': 512, 'nor': 512}),                      # pillars, plinths
}
PH = {'diff': 'Diffuse', 'nor': 'nor_gl', 'arm': 'arm'}


def fetch(url, dest):
    if os.path.exists(dest):
        return
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r, open(dest, 'wb') as f:
        f.write(r.read())


def main():
    os.makedirs(OUT, exist_ok=True)
    env = dict(os.environ, LD_LIBRARY_PATH=os.path.join(KTX, 'lib') + ':' + os.environ.get('LD_LIBRARY_PATH', ''))
    toktx = os.path.join(KTX, 'bin', 'toktx')
    total = 0
    for name, (res, maps) in SETS.items():
        with urllib.request.urlopen(urllib.request.Request(f'https://api.polyhaven.com/files/{name}', headers=UA), timeout=60) as r:
            files = json.load(r)
        for m, size in maps.items():
            src = os.path.join(CACHE, f'{name}_{m}_{res}.jpg')
            fetch(files[PH[m]][res]['jpg']['url'], src)
            png = os.path.join(CACHE, f'{name}_{m}_{size}.png')
            Image.open(src).convert('RGB').resize((size, size), Image.LANCZOS).save(png)
            out = os.path.join(OUT, f'{name}_{m}.ktx2')
            if m == 'nor':
                enc = ['--assign_oetf', 'linear', '--encode', 'uastc', '--uastc_quality', '2', '--uastc_rdo_l', '2', '--zcmp', '19']
            elif m == 'diff':
                enc = ['--assign_oetf', 'srgb', '--encode', 'etc1s', '--qlevel', '220', '--clevel', '4']
            else:
                enc = ['--assign_oetf', 'linear', '--encode', 'etc1s', '--qlevel', '200', '--clevel', '4']
            subprocess.run([toktx, '--t2', '--genmipmap', *enc, out, png], check=True, env=env)
            kb = os.path.getsize(out) // 1024
            total += kb
            print(f'{os.path.basename(out):40s} {size:5d}px {kb:6d} KB')
    print(f'total {total} KB')


if __name__ == '__main__':
    sys.exit(main())
