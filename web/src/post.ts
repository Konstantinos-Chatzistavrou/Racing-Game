// Post-processing (TSL, WebGPU): scene (HDR) -> + bloom -> tone map (AgX) -> SMAA.
// Kept deliberately small: a filmic stack (TRAA, motion blur, grading, chromatic aberration,
// vignette) was tried and removed - on the laptop iGPU it cost ~25 % of the frame and, at full
// screen, pushed frames past the 33 ms budget (stutter), and the user didn't want the look.
import * as THREE from 'three/webgpu';
import { pass, renderOutput } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';

export interface PostOptions { bloom: boolean; aa: boolean }

export class Post {
  readonly pipeline: THREE.RenderPipeline;

  constructor(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, opts: PostOptions) {
    this.pipeline = new THREE.RenderPipeline(renderer);
    const color = pass(scene, camera).getTextureNode('output');
    let lit: THREE.Node<"vec4"> = color;
    if (opts.bloom) {
      const b = bloom(color, 0.35, 0.15, 1.2);
      b.setResolutionScale(0.25);   // a blur anyway: quarter resolution looks the same, costs less
      lit = color.add(b);
    }
    if (opts.aa) {
      // SMAA expects display-referred colour: tone map first, then anti-alias.
      this.pipeline.outputColorTransform = false;
      this.pipeline.outputNode = smaa(renderOutput(lit));
    } else {
      this.pipeline.outputNode = lit;
    }
  }

  render() { this.pipeline.render(); }
}
