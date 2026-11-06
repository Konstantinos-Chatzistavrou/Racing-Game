// 'ultra' preset: wet-road reflections WITHOUT a wide MRT scene pass. The heavy way (fx/gtaoTraa.ts, preset 'max') writes
// velocity + normal + reflect-weight attachments for every pixel, which on the shared-memory iGPU costs ~3 ms and cannot hold
// 30 fps at full resolution. Here the scene pass stays the plain single-attachment one (shared with high/medium/low): the
// view normal is rebuilt from depth in one small half-res pass, and "wet" means every up-facing surface (roads, pavement,
// car roofs) reflects with fixed low roughness; everything else is discarded by SSR before ray-marching (weight 0).
// No per-material puddles (that needs the material roughness attachment), no TRAA (SMAA stays).
import * as THREE from 'three/webgpu';
import { dot, float, getNormalFromDepth, getViewPosition, mix, mx_noise_float, rtt, smoothstep, uniform, uv, vec2, vec3, vec4 } from 'three/tsl';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { ao as gtao } from 'three/addons/tsl/display/GTAONode.js';
import { ssrOptions } from './ssr';

export interface DepthFxOpts {
  resScale?: number;
  quality?: number;
  maxDistance?: number;
  intensity?: number;
  withAo?: boolean;
}

export class DepthFx {
  /** beauty (HDR) with reflections (and subtle contact AO on 'max') applied */
  readonly color: THREE.Node<'vec4'>;
  private normals: THREE.RTTNode;
  private node: ReturnType<typeof ssr>;
  private aoNode: ReturnType<typeof gtao> | null = null;
  private resScale: number;

  constructor(scenePass: THREE.PassNode, camera: THREE.PerspectiveCamera, opts: DepthFxOpts = {}) {
    this.resScale = opts.resScale ?? 0.5;
    const opt = ssrOptions({
      resolution: this.resScale,
      quality: opts.quality ?? 0.16,
      maxDistance: opts.maxDistance ?? 55,
      intensity: opts.intensity ?? 0.62,
    });
    const beauty = scenePass.getTextureNode('output');
    const depth = scenePass.getTextureNode('depth');
    // Inside an RTT pass the built-in camera nodes are the quad's own camera: bind the GAME camera's matrices (the Matrix4
    // objects are updated in place by three, so the uniforms follow the camera).
    const projInv = uniform(camera.projectionMatrixInverse), viewM = uniform(camera.matrixWorldInverse), worldM = uniform(camera.matrixWorld);
    const n = getNormalFromDepth(uv(), depth as unknown as THREE.Node, projInv);   // view space
    const vPos = getViewPosition(uv(), depth as unknown as THREE.Node, projInv);
    const wPos = worldM.mul(vec4(vPos, 1.0)).xyz;
    const up = viewM.mul(vec4(0, 1, 0, 0)).xyz;   // world up, in view space
    const ndotv = dot(n, vPos.normalize().negate()).abs().clamp(0, 1);
    const fresnel = float(1).sub(ndotv).pow(2.4);
    // Reconstruct world-space rainwater puddle mask (matches groundMaterials.ts road puddles) so dry/damp pavement stays textured while puddles mirror-reflect
    const wp = vec2(wPos.x, wPos.z.negate());
    const pLo = mx_noise_float(wp.mul(0.068).add(vec2(3.1, 9.4))).mul(0.5).add(0.5);
    const pMid = mx_noise_float(wp.mul(0.19).add(vec2(5.3, 1.7))).mul(0.5).add(0.5);
    const pud = smoothstep(0.52, 0.70, pLo.mul(0.72).add(pMid.mul(0.28)));
    const wetWeight = mix(mix(float(0.04), float(0.26), fresnel), mix(float(0.52), float(0.92), fresnel), pud);
    const wet = smoothstep(float(0.88), float(0.985), dot(n, up).abs()).mul(wetWeight);
    this.normals = rtt(vec4(n, wet), null, null, { type: THREE.HalfFloatType }) as unknown as THREE.RTTNode;
    this.node = ssr(beauty, depth, this.normals as unknown as THREE.Node<'vec3'>,
      { metalnessNode: (this.normals as unknown as { a: THREE.Node<'float'> }).a, roughnessNode: float(0.18), camera, binaryRefine: opt.binaryRefine });
    this.node.screenEdgeFadeBlack = true;
    const raw = this.node as unknown as { _blurredTextureNode: unknown; _textureNode: unknown; _blurRenderTarget: THREE.RenderTarget };
    raw._blurredTextureNode = raw._textureNode;
    raw._blurRenderTarget.texture.mipmaps.length = 0;
    this.node.resolutionScale = opt.resolution;
    this.node.quality.value = opt.quality;
    this.node.maxDistance.value = opt.maxDistance;
    this.node.thickness.value = opt.thickness;
    this.node.intensity.value = opt.intensity;
    this.node.maxLuminance.value = opt.maxLuminance;
    this.node.screenEdgeFade.value = opt.edgeFade;

    let base: THREE.Node<'vec4'> = beauty as unknown as THREE.Node<'vec4'>;
    if (opts.withAo) {
      const ao = gtao(depth, this.normals as unknown as THREE.Node, camera);
      ao.resolutionScale = 0.5;
      ao.useTemporalFiltering = false;
      ao.samples.value = 8;
      ao.radius.value = 0.45;
      ao.thickness.value = 1.2;
      ao.scale.value = 0.75;
      this.aoNode = ao;
      const a = ao.getTextureNode();
      const luma = dot(beauty.rgb, vec3(0.2126, 0.7152, 0.0722));
      const k = smoothstep(0.4, 2.2, luma).oneMinus().mul(0.38);
      base = beauty.mul(mix(1, a.r, k)) as unknown as THREE.Node<'vec4'>;
    }
    this.color = base.add(this.node.rgb) as unknown as THREE.Node<'vec4'>;
  }

  setScale(s: number) {
    this.normals.setResolutionScale(this.resScale * s);
    this.node.resolutionScale = this.resScale * s;
    if (this.aoNode) this.aoNode.resolutionScale = 0.5 * s;
  }
}
