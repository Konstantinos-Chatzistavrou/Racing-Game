// 'ultra' preset chain: half-resolution GTAO multiplied onto the lit image + TRAA (jittered camera,
// velocity MRT) instead of SMAA. Own scene pass (colour + velocity + view normal), so the shared
// pass of the other presets keeps its single attachment and costs nothing extra.
//
// - GTAO runs at `resolutionScale` x the drawing buffer (0.5 x render scale), temporal filtering on
//   (rotating sample pattern); TRAA then accumulates it, so no separate denoise pass is needed.
// - AO is applied to the HDR lit colour (indirect-only is impossible: lights are already summed in
//   the scene pass). It is faded out on bright pixels (lit by headlights / emissive) so direct
//   light is not darkened: occlusion strength = 1 - smoothstep(0.5, 3, luma).
// - TRAA works on the tone-mapped 8 bit image (jittered HDR highlights would flicker). The jitter
//   is applied by the node itself (view offset) only while the ultra pipeline renders.
import * as THREE from 'three/webgpu';
import { dot, mix, mrt, output, pass, smoothstep, vec3, velocity, normalView } from 'three/tsl';
import { ao as gtao } from 'three/addons/tsl/display/GTAONode.js';
import { ssrNode, ssrOptions, ssrOutputs } from './ssr';
import { traa } from 'three/addons/tsl/display/TRAANode.js';

export class UltraFx {
  readonly scenePass: THREE.PassNode;
  readonly color: THREE.TextureNode;
  readonly ao: ReturnType<typeof gtao>;
  /** screen-space reflections on the wet road (fx/ssr.ts), sharing this pass; null when the preset has none */
  readonly ssr: ReturnType<typeof ssrNode> | null = null;

  constructor(scene: THREE.Scene, private camera: THREE.PerspectiveCamera, private aoRes = 0.5, withSsr = false) {
    this.scenePass = pass(scene, camera);
    const so = withSsr ? ssrOptions() : null;
    // with SSR the normal attachment is the reflection normal (geometry normal on mirror-smooth puddles): fine for AO too
    this.scenePass.setMRT(mrt({ output, velocity, ...(so ? ssrOutputs(so) : { normal: normalView }) }));
    const beauty = this.scenePass.getTextureNode('output');
    if (so) this.ssr = ssrNode(this.scenePass, camera, so);
    this.color = (this.ssr ? beauty.add(this.ssr.rgb) : beauty) as unknown as THREE.TextureNode;
    const depth = this.scenePass.getTextureNode('depth');
    const normal = this.scenePass.getTextureNode('normal');
    this.ao = gtao(depth, normal, camera);
    this.ao.resolutionScale = aoRes;
    this.ao.useTemporalFiltering = true;
    this.ao.samples.value = 12;
    this.ao.radius.value = 0.6;
    this.ao.thickness.value = 1.5;
    this.ao.scale.value = 1.2;
  }

  /** HDR colour with the occlusion applied (before bloom / tone mapping). */
  occlude(): THREE.Node<'vec4'> {
    const a = this.ao.getTextureNode();
    const luma = dot(this.color.rgb, vec3(0.2126, 0.7152, 0.0722));
    const k = smoothstep(0.5, 3.0, luma).oneMinus();
    return this.color.mul(mix(1, a.r, k)) as unknown as THREE.Node<'vec4'>;
  }

  /** TRAA on the display-referred image `toned` (an RTT node at the render size). */
  resolve(toned: THREE.Node): THREE.TextureNode {
    const velTex = this.scenePass.getTextureNode('velocity');
    const depth = this.scenePass.getTextureNode('depth');
    const t = traa(toned as THREE.TextureNode, depth, velTex, this.camera);
    // display-referred input -> 8 bit history/resolve (the node defaults to half float; the history copy
    // needs matching formats, and 8 bit halves the bandwidth of these two full-size targets)
    const priv = t as unknown as Record<string, THREE.RenderTarget>;
    for (const k of ['_historyRenderTarget', '_resolveRenderTarget']) priv[k].texture.type = THREE.UnsignedByteType;
    return (t as unknown as { getTextureNode(): THREE.TextureNode }).getTextureNode();
  }

  setScale(s: number) {
    this.scenePass.setResolutionScale(s);
    this.ao.resolutionScale = this.aoRes * s;
    if (this.ssr) this.ssr.resolutionScale = 0.5 * s;
  }
}
