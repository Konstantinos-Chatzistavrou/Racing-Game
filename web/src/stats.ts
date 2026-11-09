// What a frame actually costs, measured rather than guessed: the draw calls three counts for the frame, and the
// textures resident in VRAM with their mip chains. The perf line shows it, and window.__game.stats() returns the same
// numbers so the headless tools can log them (drive.mjs reports it, see docs/performance.md).
//
// Why mips matter: sampling a texture with no mip chain makes the GPU fetch from many cache lines per pixel at a
// distance (the whole point of the user's note). A compressed texture with one level is just as bad, so a KTX2 file
// without its mip chain is counted here as "no mips" instead of assumed fine.
import * as THREE from 'three/webgpu';

export interface TextureStats {
  /** distinct textures reachable from the scene's materials */
  textures: number;
  /** VRAM estimate: block-compressed textures use their real transcoded bytes, plain images use size x format */
  bytes: number;
  /** textures whose filter asks for mips but which carry none (one level only): cache thrash on distant surfaces */
  noMips: number;
  /** textures stored block-compressed (KTX2/Basis) */
  compressed: number;
  /** the ones with no mip chain, by name, for the log */
  offenders: string[];
}

export interface FrameStats extends Omit<TextureStats, 'offenders' | 'compressed'> {
  /** draw calls in the last rendered frame */
  calls: number;
  triangles: number;
  /** texture MB, rounded, for the readout */
  textureMB: number;
}

const SLOTS = [
  'map', 'normalMap', 'bumpMap', 'displacementMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap',
  'alphaMap', 'lightMap', 'envMap', 'specularMap', 'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap',
  'sheenColorMap', 'sheenRoughnessMap', 'iridescenceMap', 'transmissionMap', 'thicknessMap', 'anisotropyMap',
  'specularColorMap', 'specularIntensityMap',
] as const;

const MIP_FILTERS = new Set<number>([
  THREE.LinearMipmapLinearFilter, THREE.LinearMipmapNearestFilter,
  THREE.NearestMipmapLinearFilter, THREE.NearestMipmapNearestFilter,
]);

const CHANNELS: Record<number, number> = {
  [THREE.RedFormat]: 1, [THREE.RGFormat]: 2, [THREE.RGBFormat]: 3, [THREE.RGBAFormat]: 4,
  [THREE.DepthFormat]: 1, [THREE.DepthStencilFormat]: 2, [THREE.RedIntegerFormat]: 1, [THREE.RGIntegerFormat]: 2,
};
const TYPE_BYTES: Record<number, number> = {
  [THREE.UnsignedByteType]: 1, [THREE.ByteType]: 1, [THREE.UnsignedShortType]: 2, [THREE.ShortType]: 2,
  [THREE.HalfFloatType]: 2, [THREE.FloatType]: 4, [THREE.UnsignedIntType]: 4, [THREE.IntType]: 4,
};

/** Bytes one texture occupies, mip chain included. Compressed textures report their real transcoded bytes. */
function textureBytes(t: THREE.Texture): number {
  const c = t as THREE.CompressedTexture;
  if (c.isCompressedTexture && c.mipmaps?.length) {
    let n = 0;
    for (const m of c.mipmaps) n += (m as { data?: { byteLength?: number } }).data?.byteLength ?? 0;
    if (n) return n;
  }
  const data = (t.source?.data ?? t.image) as { width?: number; height?: number } | undefined;
  const w = data?.width ?? 0, h = data?.height ?? 0;
  if (!w || !h) return 0;
  const bpp = (CHANNELS[t.format] ?? 4) * (TYPE_BYTES[t.type] ?? 1);
  const base = w * h * bpp;
  const mips = t.generateMipmaps && MIP_FILTERS.has(t.minFilter) ? 4 / 3 : 1;
  return Math.round(base * mips);
}

/** Every texture reachable through a material of the scene, once per texture. */
export function sceneTextures(scene: THREE.Scene): TextureStats {
  const seen = new Set<string>();
  const offenders: string[] = [];
  let textures = 0, bytes = 0, noMips = 0, compressed = 0;
  const want = (t: THREE.Texture | null | undefined) => {
    if (!t || !(t as { isTexture?: boolean }).isTexture || seen.has(t.uuid)) return;
    seen.add(t.uuid);
    textures++;
    bytes += textureBytes(t);
    const c = t as THREE.CompressedTexture;
    const levels = c.isCompressedTexture ? c.mipmaps?.length ?? 0 : 0;
    if (c.isCompressedTexture) compressed++;
    const needs = MIP_FILTERS.has(t.minFilter);
    if (needs && levels <= 1 && !(t.generateMipmaps && !c.isCompressedTexture)) {
      noMips++;
      if (offenders.length < 12) offenders.push(`${t.name || (t.source?.data as { src?: string } | undefined)?.src || 'texture'} ${(t.source?.data as { width?: number } | undefined)?.width ?? '?'}px`);
    }
  };
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      const slots = mat as unknown as Record<string, THREE.Texture | null>;
      for (const k of SLOTS) want(slots[k]);
    }
  });
  return { textures, bytes, noMips, compressed, offenders };
}

let cached: { at: number; stats: TextureStats } | null = null;
/** The scene scan is a traversal: cache it (default 10 s), the draw calls are read every frame. */
export function sceneTextureStats(scene: THREE.Scene, maxAgeMs = 10_000): TextureStats {
  const now = performance.now();
  if (!cached || now - cached.at > maxAgeMs) cached = { at: now, stats: sceneTextures(scene) };
  return cached.stats;
}

export function frameStats(scene: THREE.Scene, renderer: { info: { render: { drawCalls?: number; calls: number; triangles: number } } }): FrameStats {
  const t = sceneTextureStats(scene);
  return {
    // drawCalls is the per-draw counter (Info.update, reset each frame); render.calls counts renderer.render()
    // invocations (main pass, shadow maps, the reflection probe), which is a different, much smaller number.
    calls: renderer.info.render.drawCalls ?? renderer.info.render.calls, triangles: renderer.info.render.triangles,
    textures: t.textures, bytes: t.bytes, textureMB: Math.round(t.bytes / 1048576), noMips: t.noMips,
  };
}
