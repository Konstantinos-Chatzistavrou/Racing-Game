#!/usr/bin/env python3
"""Garage props: fetch CC0 models from Poly Haven and pack them for the web (KTX2 textures, meshopt geometry).

    python3 tools/garage/build_props.py [name ...]

Output: web/public/assets/garage/props/<name>.glb. Needs node + npx (gltf-transform 4.5.1), KTX-Software 4.4.2 in
tools/ktx/ (gitignored). Downloads are cached in tools/garage/.cache/. All models are CC0 (polyhaven.com/license).
"""
import json, os, shutil, subprocess, sys, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CACHE = os.path.join(ROOT, 'tools', 'garage', '.cache', 'models')
OUT = os.path.join(ROOT, 'web', 'public', 'assets', 'garage', 'props')
KTX = os.path.join(ROOT, 'tools', 'ktx', 'KTX-Software-4.4.2-Linux-x86_64')
UA = {'User-Agent': 'asset-fetch/1.0'}
G = ['npx', '-y', '@gltf-transform/cli@4.5.1']

# name -> (texture size, simplify ratio or None)
PROPS = {
    'metal_tool_chest': (1024, None),
    'steel_frame_shelves_01': (1024, None),
    'covered_car': (1024, None),
    'metal_office_desk': (512, None),
    'sofa_02': (512, None),
    'old_tyre': (512, None),
    'Barrel_01': (512, None),
    'korean_fire_extinguisher_01': (512, 0.6),
    'metal_jerrycan_green': (512, 0.6),
    'plastic_crate_02': (512, None),
    'metal_stool_01': (512, 0.6),
    'hanging_industrial_lamp': (512, 0.6),
    'boombox': (512, 0.6),
    'WetFloorSign_01': (512, None),
    'utility_box_01': (512, None),
    'portable_generator': (1024, 0.4),
    'tool_cart': (1024, 0.4),
    'cardboard_box_01': (512, 0.4),
}


def get(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=180) as r, open(dest, 'wb') as f:
        f.write(r.read())


def run(args, env):
    subprocess.run(args, check=True, env=env, stdout=subprocess.DEVNULL)


def main():
    os.makedirs(OUT, exist_ok=True)
    env = dict(os.environ, PATH=os.path.join(KTX, 'bin') + ':' + os.environ['PATH'],
               LD_LIBRARY_PATH=os.path.join(KTX, 'lib') + ':' + os.environ.get('LD_LIBRARY_PATH', ''))
    names = sys.argv[1:] or list(PROPS)
    for name in names:
        size, simplify = PROPS[name]
        d = os.path.join(CACHE, name)
        with urllib.request.urlopen(urllib.request.Request(f'https://api.polyhaven.com/files/{name}', headers=UA), timeout=60) as r:
            files = json.load(r)
        g = files['gltf']['1k']['gltf']
        gltf = os.path.join(d, os.path.basename(g['url']))
        get(g['url'], gltf)
        for rel, inc in g.get('include', {}).items():
            get(inc['url'], os.path.join(d, rel))
        t = os.path.join(d, 'step')
        run(G + ['dedup', gltf, t + '1.glb'], env)
        run(G + ['prune', t + '1.glb', t + '2.glb'], env)
        if simplify:
            run(G + ['weld', t + '2.glb', t + '2w.glb'], env)
            run(G + ['simplify', t + '2w.glb', t + '2.glb', '--ratio', str(simplify), '--error', '0.002'], env)
        run(G + ['resize', t + '2.glb', t + '3.glb', '--width', str(size), '--height', str(size)], env)
        run(G + ['uastc', t + '3.glb', t + '4.glb', '--slots', '{normalTexture}', '--level', '2', '--rdo', '--rdo-lambda', '3', '--zstd', '18'], env)
        run(G + ['etc1s', t + '4.glb', t + '5.glb', '--quality', '170'], env)
        out = os.path.join(OUT, name + '.glb')
        run(G + ['meshopt', t + '5.glb', out, '--level', 'high'], env)
        for s in ('1', '2', '2w', '3', '4', '5'):
            if os.path.exists(t + s + '.glb'):
                os.remove(t + s + '.glb')
        print(f'{name:32s} {os.path.getsize(out) // 1024:6d} KB', flush=True)


if __name__ == '__main__':
    sys.exit(main())
