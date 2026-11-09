// Screen-space reflections for the wet road (three's SSRNode, first-generation: one mirror ray + a
// roughness-keyed blur, no noise, no denoiser). Used by presets with `ssr: true` (post.ts).
//
// SSR needs depth + view normal + material data, i.e. an MRT scene pass (the 'ultra' preset's, fx/gtaoTraa.ts, shared
// with GTAO and TRAA). Writing those extra attachments costs bandwidth on EVERY pixel, so the presets that do not use
// SSR keep the plain single-target pass.
//
// Cost control: the material attachment carries a per-pixel reflect weight (not metalness): 0 for
// rough surfaces, rising to 1 for glossy ones, and SSR runs with reflectNonMetals=false, so the ray
// march `discard`s every pixel with weight 0 (walls, pavement, cars' matte parts) before marching.
// Only wet asphalt, puddles and glass pay for rays. The SSR + blur render at `resolution` x the canvas.
import * as THREE from 'three/webgpu';
import { float, mix, normalView, normalViewGeometry, roughness, smoothstep, vec2 } from 'three/tsl';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';

export interface SsrOptions {
  /** SSR + blur target size relative to the canvas */
  resolution: number;
  /** 0..1, share of the max 64 ray-march steps */
  quality: number;
  /** longest reflection ray in view-space metres */
  maxDistance: number;
  /** depth tolerance for a hit, metres */
  thickness: number;
  /** reflect weight ramps from 1 at roughness <= lo to 0 at roughness >= hi */
  roughLo: number;
  roughHi: number;
  /** overall strength of the added reflection */
  intensity: number;
  /** clamp on a reflected pixel's luminance (kills single-pixel sparkles from lamps/neon) */
  maxLuminance: number;
  binaryRefine: boolean;
  /** reflections fade out this far (0..1 of the screen) from the screen border */
  edgeFade: number;
}
// resolution 0.35 (was 0.5): the reflection is a roughness-blurred mirror on wet asphalt and glass, so the smaller
// target costs about 7 % of the frame less and is indistinguishable at this blur radius (measured, docs/performance.md).
export const SSR_DEFAULTS: SsrOptions = { resolution: 0.35, quality: 0.14, maxDistance: 45, thickness: 0.6, roughLo: 0.12, roughHi: 0.5, intensity: 1, maxLuminance: 4, binaryRefine: true, edgeFade: 0.2 };

/** Options with the ?ssr=quality:0.5,maxDistance:40,... tuning aid applied. */
export function ssrOptions(o: Partial<SsrOptions> = {}): SsrOptions {
  const opt = { ...SSR_DEFAULTS, ...o };
  for (const kv of (new URLSearchParams(location.search).get('ssr') ?? '').split(',')) {
    const [k, v] = kv.split(':');
    if (k in opt && v !== undefined) (opt as Record<string, number | boolean>)[k] = typeof opt[k as keyof SsrOptions] === 'boolean' ? v === '1' : Number(v);
  }
  return opt;
}

/**
 * The extra scene-pass outputs SSR needs (merge into the pass's MRT): `normal` (the reflection normal) and `mr`
 * (reflect weight 0..1, rough -> 0, and roughness; 8 bit). A mirror-smooth puddle must not follow the asphalt normal
 * map (its per-pixel detail turns a mirror into confetti); rougher glossy surfaces keep the full shading normal.
 */
export function ssrOutputs(opt: SsrOptions) {
  const weight = smoothstep(float(opt.roughHi), float(opt.roughLo), roughness);
  const reflN = mix(normalViewGeometry, normalView, smoothstep(float(0.05), float(opt.roughHi), roughness)).normalize();
  return { normal: reflN, mr: vec2(weight, roughness) };
}

/** The SSR node reading `scenePass`'s output/depth/normal/mr (set up with ssrOutputs). Returns it ready to add to the beauty. */
export function ssrNode(scenePass: THREE.PassNode, camera: THREE.Camera, opt: SsrOptions) {
  scenePass.getTexture('mr').type = THREE.UnsignedByteType;
  const mrTex = scenePass.getTextureNode('mr');
  const node = ssr(scenePass.getTextureNode('output'), scenePass.getTextureNode('depth'), scenePass.getTextureNode('normal') as unknown as THREE.Node<'vec3'>,
    { metalnessNode: mrTex.r, roughnessNode: mrTex.g, camera, binaryRefine: opt.binaryRefine });
  node.blurQuality = 1;
  node.screenEdgeFadeBlack = true;
  node.resolutionScale = opt.resolution;
  node.quality.value = opt.quality;
  node.maxDistance.value = opt.maxDistance;
  node.thickness.value = opt.thickness;
  node.intensity.value = opt.intensity;
  node.maxLuminance.value = opt.maxLuminance;
  node.screenEdgeFade.value = opt.edgeFade;
  return node;
}
