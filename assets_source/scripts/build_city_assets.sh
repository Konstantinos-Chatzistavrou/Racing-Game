#!/usr/bin/env bash
# Compress the city exports for the web (run after make_city.py and make_city_props.py).
#   assets_source/build/city_raw.glb        -> web/public/assets/city/city.glb
#   assets_source/build/city_props_raw.glb  -> web/public/assets/city/city_props.glb
# Needs KTX-Software (toktx/ktx) >= 4.3: the release binaries unpacked into tools/ktx/ (gitignored):
#   https://github.com/KhronosGroup/KTX-Software/releases (KTX-Software-4.4.2-Linux-x86_64.tar.bz2)
#
# Geometry: meshopt (EXT_meshopt_compression + KHR_mesh_quantization), not Draco: the decoder is a
# ~20 KB JS/WASM module that decodes faster than Draco's ~300 KB WASM, it keeps index order (GPU
# vertex-cache friendly) and gzips/brotlis further on Vercel. Quantization: positions 16 bit
# (a 160 m city tile -> 2.4 mm steps, so the collision meshes and the tile seams stay tight; the
# default 14 bit would be ~1 cm), texcoords 16 bit (the city's UVs are world-scale, up to ~200
# repeats: 12 bit would visibly shift textures).
# Textures: KTX2 / Basis Universal, transcoded at load to BC7/ETC2/ASTC and kept COMPRESSED in VRAM
# (PNG/JPEG decode to raw RGBA: the old city used 270 MB of texture memory). ETC1S for colour maps
# (baseColor, emissive: small, a little blocky in flat gradients), UASTC for normal/occlusion maps (ETC1S artefacts would show as bumpy lighting);
# roughness (a smooth single channel) goes ETC1S too, which halves its size, zstd-supercompressed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
KTX_DIR="$(ls -d "$ROOT"/tools/ktx/KTX-Software-*/ 2>/dev/null | head -1)"
if [ -z "$KTX_DIR" ]; then echo "KTX-Software not found in tools/ktx/ (see the header)"; exit 1; fi
export PATH="$KTX_DIR/bin:$PATH" LD_LIBRARY_PATH="$KTX_DIR/lib:${LD_LIBRARY_PATH:-}"
G="npx -y @gltf-transform/cli@4.5.1"
B="$ROOT/assets_source/build"
OUT="$ROOT/web/public/assets/city"
mkdir -p "$OUT"
cd "$ROOT/web"   # npx cache / node_modules

pack() {   # pack <in> <out> <max texture size>
  local in="$1" out="$2" size="$3" t="$B/tmp_$(basename "$2" .glb)"
  $G dedup "$in" "$t.1.glb"
  $G prune "$t.1.glb" "$t.2.glb"
  $G resize "$t.2.glb" "$t.3.glb" --width "$size" --height "$size"
  $G uastc "$t.3.glb" "$t.4.glb" --slots "{normalTexture,occlusionTexture}" --level 2 --rdo --rdo-lambda 5 --zstd 18
  $G etc1s "$t.4.glb" "$t.5.glb" --slots "{baseColorTexture,emissiveTexture,metallicRoughnessTexture}" --quality 192
  $G meshopt "$t.5.glb" "$out" --level high --quantize-position 16 --quantize-texcoord 16
  rm -f "$t".*.glb
  ls -la "$out"
}

pack "$B/city_raw.glb" "$OUT/city.glb" 2048
pack "$B/city_props_raw.glb" "$OUT/city_props.glb" 512
