// Post-processing (TSL, WebGPU). Order matters:
//   scene (HDR) -> [high: TRAA -> motion blur] -> + bloom -> tone map (AgX) -> colour grade ->
//   chromatic aberration (edges only) -> vignette -> [low: SMAA]
// high (desktop default): TRAA (temporal AA: stable thin lamp posts and wires) + camera motion blur,
//   both fed by a velocity buffer rendered alongside the scene.
// low (touch default): SMAA, no velocity buffer, no motion blur (saves bandwidth on phones).
// Depth of field is deliberately left out: in a night chase view it mostly blurs the lit city
// (the part that sells the scene) and the bokeh pass is one of the most expensive effects.
import * as THREE from 'three/webgpu';
import {
  pass, mrt, output, velocity, renderOutput, convertToTexture, uv, vec2, vec3, vec4, float, dot, mix,
  smoothstep, Fn, int, uniform,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { motionBlur } from 'three/addons/tsl/display/MotionBlur.js';
import { chromaticAberration } from 'three/addons/tsl/display/ChromaticAberrationNode.js';

export type Quality = 'high' | 'low';
type N = ReturnType<typeof vec4>;

export interface PostOptions { quality: Quality; bloom: boolean; aa: boolean }

/** Display-referred grade: gentle S-curve contrast, teal shadows / warm highlights, +6 % saturation. */
const grade = Fn(([c]: [N]) => {
  const col = c.rgb.toVar();
  const lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  const s = smoothstep(float(0), float(1), col);                        // S-curve
  const contrasted = mix(col, s, 0.35);
  const shadows = float(1).sub(lum).pow(2);
  const highs = lum.pow(2);
  const toned = contrasted
    .add(vec3(-0.012, 0.012, 0.028).mul(shadows))                     // teal into the shadows
    .add(vec3(0.03, 0.012, -0.022).mul(highs));                       // orange into the highlights
  const l2 = dot(toned, vec3(0.2126, 0.7152, 0.0722));
  return vec4(mix(vec3(l2), toned, 1.06).clamp(0, 1), c.a);
});

const vignette = Fn(([c, strength]: [N, N]) => {
  const d = uv().sub(0.5).mul(vec2(1.0, 0.8)).length().mul(1.41);
  return vec4(c.rgb.mul(float(1).sub(strength.mul(smoothstep(float(0.4), float(1.05), d)))), c.a);
});

export class Post {
  readonly pipeline: THREE.RenderPipeline;
  readonly motionBlurAmount = uniform(0.4);   // fraction of one frame's motion

  constructor(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, readonly opts: PostOptions) {
    this.pipeline = new THREE.RenderPipeline(renderer);
    const scenePass = pass(scene, camera);
    let beauty: N;
    const high = opts.quality === 'high';
    if (high) {
      scenePass.setMRT(mrt({ output, velocity }));
      const color = scenePass.getTextureNode('output');
      const vel = scenePass.getTextureNode('velocity');
      const depth = scenePass.getTextureNode('depth');
      const aa = convertToTexture(traa(color, depth, vel, camera));
      beauty = motionBlur(aa, vel.mul(this.motionBlurAmount), int(8)) as unknown as N;
    } else {
      beauty = scenePass.getTextureNode('output') as unknown as N;
    }
    const lit = opts.bloom ? beauty.add(bloom(beauty, 0.35, 0.15, 1.2)) : beauty;
    this.pipeline.outputColorTransform = false;           // tone mapping happens here, before grading
    let c = renderOutput(lit) as unknown as N;
    c = grade(c);
    c = chromaticAberration(c, float(0.12), vec2(0.5, 0.5), float(1.04)) as unknown as N;
    c = vignette(c, float(0.38) as unknown as N);
    if (!high && opts.aa) c = smaa(c) as unknown as N;
    this.pipeline.outputNode = c;
  }

  render() { this.pipeline.render(); }
}
