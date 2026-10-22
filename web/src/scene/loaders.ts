// Shared glTF loading for every asset (cars now, the city when it moves to compressed assets):
// one GLTFLoader wired to
//   - MeshoptDecoder (EXT_meshopt_compression): geometry. Chosen over Draco for the car: the
//     decoder is a ~20 KB inline-WASM module that decodes on the main thread at >1 GB/s (no worker
//     start-up, no extra download of a 300 KB decoder), and meshopt + zstd'd KTX2 came out within
//     a few % of Draco in size for these files (numbers: docs/car_model_v3.md);
//   - KTX2Loader (KHR_texture_basisu): textures stay block-compressed in VRAM (BC7/ETC/ASTC picked
//     by detectSupport for the GPU), ~4-8x less video memory than PNG/JPEG and no main-thread image
//     decode. The Basis transcoder (WASM, runs in workers) is served from /libs/basis/ (copied from
//     three/examples/jsm/libs/basis, same three version: public/libs/basis/README).
// Files without these extensions load exactly as before, so the old assets keep working.
// Call initLoaders(renderer) once after renderer.init(): KTX2 needs the device's format support.
import type * as THREE from 'three/webgpu';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

let loader: GLTFLoader | null = null;
let ktx2: KTX2Loader | null = null;
const cache = new Map<string, Promise<GLTF>>();

/** Wire the decoders to the renderer (once, after renderer.init()). */
export function initLoaders(renderer: THREE.WebGPURenderer) {
  if (loader) return;
  ktx2 = new KTX2Loader().setTranscoderPath('/libs/basis/').detectSupport(renderer as never);
  // Prefer BC whenever the GPU has it. KTX2Loader ranks ETC2 (colour) and ASTC (normals) first,
  // and Mesa on Linux ADVERTISES both on Intel/AMD GPUs that only emulate them (three disables
  // them for this case on its WebGL path, not on WebGPU). On this laptop (Intel UHD, Vulkan) the
  // emulated formats ended in "WebGPU Device Lost" a few seconds into a drive; with BC7/BC1-3 it
  // never happened. Phones (no BC) keep ETC2/ASTC.
  const cfg = (ktx2 as unknown as { workerConfig: Record<string, boolean> | null }).workerConfig;
  if (cfg?.bptcSupported) cfg.astcSupported = cfg.etc1Supported = cfg.etc2Supported = false;
  loader = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
}

/** The shared loader (a plain GLTFLoader with meshopt only if initLoaders was not called). */
export function gltfLoader(): GLTFLoader {
  return loader ?? new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
}

/**
 * Load a glTF once per URL: callers that keep the scene as is (the player car) must be the only
 * user of that URL; everyone else clones (gltf.scene.clone(true) shares geometry and materials).
 */
export function loadGLTF(url: string, onProgress?: (e: ProgressEvent) => void): Promise<GLTF> {
  let p = cache.get(url);
  if (!p) {
    p = gltfLoader().loadAsync(url, onProgress).then((g) => (shareTextures(g.scene), g));
    cache.set(url, p);
    p.catch(() => cache.delete(url));
  }
  return p;
}

/**
 * GLTFLoader clones a texture per material whenever the reference differs (texCoord 1 for the AO
 * map, a texture transform): each clone is a separate GPU upload. The car's one 2048^2 AO atlas
 * was uploaded 14 times (39 MB of VRAM instead of 2.8 MB, measured with web/tools/probe_car.js).
 * Materials whose texture has the same image, UV channel and transform get one shared Texture.
 */
function shareTextures(root: THREE.Object3D) {
  const keep = new Map<string, THREE.Texture>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      const slots = mat as unknown as Record<string, THREE.Texture | null>;
      for (const k of Object.keys(slots)) {
        const t = slots[k];
        if (!t || !(t as { isTexture?: boolean }).isTexture) continue;
        const key = [t.source.uuid, t.channel, t.offset.toArray(), t.repeat.toArray(), t.rotation, t.colorSpace, t.flipY].join('|');
        const first = keep.get(key);
        if (!first) keep.set(key, t);
        else if (first !== t) slots[k] = first;
      }
    }
  });
}

/** Game asset path from a Godot-style res:// path (the visual JSONs still use those). */
export const assetUrl = (res: string) => res.replace('res://assets/', '/assets/');
