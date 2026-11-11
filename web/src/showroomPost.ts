// Render pipeline of the showroom (title, garage, modes, lobby): the garage scene only. It is its own scene pass with
// its own render targets, so entering or leaving the garage never resizes or rebuilds anything of the driving pipeline
// (post.ts) and each side keeps its own render scale.
//
// The garage is cheap to draw (baked room, no city), so the budget goes into the image:
//   max    - ambient occlusion, bloom, depth of field, SMAA, vignette + grain, mirror floor at 0.6
//   ultra  - ambient occlusion, bloom, SMAA, vignette + grain, mirror floor at 0.6
//   high   - bloom, SMAA, vignette + grain, mirror floor at 0.5
//   medium - bloom, FXAA, vignette, mirror floor at 0.4, render scale 0.85
//   low    - FXAA, vignette, mirror floor at 0.3, render scale 0.7
// One pipeline per preset, all compiled at load; switching is a pointer change.
import * as THREE from 'three/webgpu';
import { convertToTexture, dot, float, mix, pass, smoothstep, uniform, uv, vec3 } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { ao as gtao } from 'three/addons/tsl/display/GTAONode.js';
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js';
import { makeGrade, toneGrade } from './fx/grade';
import { PRESET_ORDER, ScaledSMAA, casUpscale, rtt8, type PresetName } from './post';

interface ShowPreset { ao: boolean; bloom: boolean; dof: boolean; aa: 'smaa' | 'fxaa'; grain: boolean; mirror: number; scale: number }
export const SHOW_PRESETS: Record<PresetName, ShowPreset> = {
  max: { ao: true, bloom: true, dof: true, aa: 'smaa', grain: true, mirror: 0.6, scale: 1 },
  ultra: { ao: true, bloom: true, dof: false, aa: 'smaa', grain: true, mirror: 0.6, scale: 1 },
  high: { ao: false, bloom: true, dof: false, aa: 'smaa', grain: true, mirror: 0.5, scale: 1 },
  medium: { ao: false, bloom: true, dof: false, aa: 'fxaa', grain: false, mirror: 0.4, scale: 0.85 },
  low: { ao: false, bloom: false, dof: false, aa: 'fxaa', grain: false, mirror: 0.3, scale: 0.7 },
  potato: { ao: false, bloom: false, dof: false, aa: 'fxaa', grain: false, mirror: 0.3, scale: 0.7 },
};

/** The garage's own grade: an interior at night - a little contrast, cool shadows, warm practicals, restrained. */
export const SHOW_GRADE = makeGrade({ exposure: 1.0, contrast: 0.24, lift: 0.004, gamma: 1.0, sat: 1.1, split: 0.3, grain: 0.008, shadowTint: [0.0, 0.04, 0.12], highlightTint: [0.1, 0.05, 0.0] });

export class ShowroomPost {
  private scenePass: THREE.PassNode;
  private pipelines = new Map<PresetName, THREE.RenderPipeline>();
  private scaled: { setResolutionScale(s: number): unknown }[] = [];
  private smaas: ScaledSMAA[] = [];
  private blooms: { setResolutionScale(s: number): unknown }[] = [];
  private aos: { resolutionScale: number }[] = [];
  private dofBlurs: { resolutionScale: number }[] = [];
  private sharpness = uniform(1.0);
  private _scale = 1;
  /** distance from the camera to the car (m): the depth of field focuses there */
  readonly focus = uniform(6.5);
  readonly vignette = uniform(0.42);
  preset: PresetName;

  constructor(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, preset: PresetName) {
    this.scenePass = pass(scene, camera);
    const color = this.scenePass.getTextureNode('output');
    const depth = this.scenePass.getTextureNode('depth');
    const q = new URLSearchParams(location.search);
    let aoLit: THREE.Node<'vec4'> | null = null;
    let sharedBloom: ReturnType<typeof bloom> | null = null, sharedBloomAo: ReturnType<typeof bloom> | null = null;
    // darken the corners in the last pass (canvas resolution): pulls the eye to the car
    const finish = (rgb: THREE.Node<'vec3'>) => {
      const d = uv().sub(0.5);
      const v = smoothstep(0.25, 0.95, dot(d, d).mul(2.6));
      return rgb.mul(float(1).sub(v.mul(this.vignette)));
    };
    for (const name of PRESET_ORDER) {
      const pr = SHOW_PRESETS[name];
      const p = new THREE.RenderPipeline(renderer);
      let lit: THREE.Node<'vec4'> = color;
      if (pr.ao && q.get('gao') !== '0') {
        if (!aoLit) {
          const a = gtao(depth, null as unknown as THREE.Node, camera);
          a.resolutionScale = 0.5;
          a.useTemporalFiltering = false;
          a.samples.value = 12;
          a.radius.value = 0.7;
          a.thickness.value = 1.4;
          a.scale.value = 1.0;
          this.aos.push(a as unknown as { resolutionScale: number });
          const occ = a.getTextureNode().r;
          // light sources and their reflections are not occluded: fade the AO out with brightness
          const luma = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
          const k = float(1).sub(smoothstep(0.6, 3.0, luma)).mul(0.85);
          aoLit = color.mul(mix(float(1), occ, k)) as unknown as THREE.Node<'vec4'>;
        }
        lit = aoLit;
      }
      if (pr.bloom) {
        let b: ReturnType<typeof bloom> | null = pr.ao ? sharedBloomAo : sharedBloom;
        if (!b) {
          b = bloom(lit, Number(q.get('gbs') ?? 0.34), Number(q.get('gbr') ?? 0.62), Number(q.get('gbt') ?? 1.25));
          (b as unknown as { smoothWidth: { value: number } }).smoothWidth.value = 0.6;
          this.blooms.push(b);
          if (pr.ao) sharedBloomAo = b; else sharedBloom = b;
        }
        lit = lit.add(b);
      }
      if (pr.dof && q.get('gdof') !== '0') {
        // Depth of field, the cheap way: one half-resolution gaussian of the lit image, mixed in by the distance from
        // the focus plane (the car). three's DepthOfFieldNode costs ~13 ms at 1080p on the iGPU; this is ~2 ms.
        const litTex = convertToTexture(lit);
        const soft = gaussianBlur(litTex, null, 3, { resolutionScale: 0.5 });
        this.dofBlurs.push(soft as unknown as { resolutionScale: number });
        const dist = this.scenePass.getViewZNode().negate();
        const coc = smoothstep(float(Number(q.get('gdofn') ?? 3.2)), float(Number(q.get('gdofl') ?? 11)), dist.sub(this.focus).abs());
        lit = mix(litTex, soft, coc.mul(0.9)) as unknown as THREE.Node<'vec4'>;
      }
      const toned = rtt8(toneGrade(lit, 'neutral', true, SHOW_GRADE));
      this.scaled.push(toned);
      let src: THREE.TextureNode;
      if (pr.aa === 'smaa') {
        const s = new ScaledSMAA(toned);
        this.smaas.push(s);
        src = s.getTextureNode();
      } else {
        const f = rtt8(fxaa(toned));
        this.scaled.push(f);
        src = f;
      }
      p.outputColorTransform = false;
      p.outputNode = casUpscale(src, this.sharpness, pr.grain, finish);
      this.pipelines.set(name, p);
    }
    this.preset = preset;
    this.setScale(SHOW_PRESETS[preset].scale);
  }

  get scale() { return this._scale; }

  /** Render scale of the garage image (render-target resize: only when the preset changes, in the front end). */
  setScale(s: number) {
    if (s === this._scale && this.scaled.length) { /* targets already sized */ }
    this._scale = s;
    this.scenePass.setResolutionScale(s);
    for (const r of this.scaled) r.setResolutionScale(s);
    for (const m of this.smaas) m.scale = s;
    for (const b of this.blooms) b.setResolutionScale(0.25 * s);
    for (const a of this.aos) a.resolutionScale = 0.5 * s;
    for (const d of this.dofBlurs) d.resolutionScale = 0.5;
    this.sharpness.value = s >= 0.99 ? 1.0 : 0.5;
  }

/** the target the garage is really drawn into (see Post.sceneTarget) */
  get sceneTarget(): THREE.RenderTarget { return this.scenePass.renderTarget as THREE.RenderTarget; }
    render() { this.pipelines.get(this.preset)!.render(); }

  /** Every preset once (pipelines compiled behind the loading screen). */
  async warmup() {
    const keep = this.preset;
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    for (const name of PRESET_ORDER) { this.preset = name; this.render(); await frame(); }
    this.preset = keep;
  }
}
