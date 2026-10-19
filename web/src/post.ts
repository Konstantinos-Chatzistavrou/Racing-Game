// Post-processing (TSL, WebGPU): scene (HDR, at the RENDER scale) -> + bloom -> tone map (AgX) ->
// anti-aliasing -> contrast-adaptive sharpening upscale to the full canvas.
// Kept deliberately small: a filmic stack (TRAA, motion blur, grading, chromatic aberration,
// vignette) was tried and removed - on the laptop iGPU it cost ~25 % of the frame and, at full
// screen, pushed frames past the 33 ms budget (stutter), and the user didn't want the look.
//
// Resolution model (2026-10-18, after docs/threejspunk_notes.md): the CANVAS always runs at the
// full (capped) pixel ratio; only the scene pass and the post passes before the upscale render at
// `scale` x the canvas. The last pass samples that image with 5 bilinear taps one source texel
// apart and applies RCAS-style sharpening (AMD FidelityFX CAS/RCAS limiter, ported from three's
// SharpenNode), so a 0.7 render is upscaled ONCE, in the shader, instead of being stretched
// bilinearly by the browser compositor (soft, the old path). Every expensive pass has its own
// resolution: bloom at 0.25 of the render (it is a blur), AA at the render size.
//
// Quality presets (the adaptive system lowers these BEFORE the resolution): each preset is its own
// RenderPipeline built and compiled at load; they share the one scene pass. Switching preset only
// changes which pipeline renders: no material, light set or pipeline changes, no recompiles, no
// render-target resizes of the scene. Measured: switching costs no frame over the normal budget.
import * as THREE from 'three/webgpu';
import { Fn, clamp, float, int, log, max, min, pass, positionView, renderOutput, rtt, screenUV, textureSize, uniform, uv, vec2, vec3, vec4 } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import * as SMAAModule from 'three/addons/tsl/display/SMAANode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { ClusteredLighting } from 'three/addons/lighting/ClusteredLighting.js';

export type PresetName = 'high' | 'medium' | 'low';
export interface Preset {
  aa: 'smaa' | 'fxaa' | 'none';
  /** bloom resolution relative to the RENDER size; 0 = no bloom */
  bloom: number;
  /** headlight shadow map re-rendered every Nth frame (see main.ts) */
  shadowEvery: number;
}
// Ordered best -> cheapest. The GPU cost differences are small but real on the iGPU (measured with
// timestamp queries, see docs/web_port.md): SMAA = 3 passes, FXAA = 1, bloom = ~11 small passes.
export const PRESETS: Record<PresetName, Preset> = {
  high: { aa: 'smaa', bloom: 0.25, shadowEvery: 2 },
  medium: { aa: 'fxaa', bloom: 0.25, shadowEvery: 2 },
  low: { aa: 'none', bloom: 0, shadowEvery: 3 },
};
export const PRESET_ORDER: PresetName[] = ['high', 'medium', 'low'];

export interface PostOptions { bloom: boolean; aa: boolean; scale: number; preset: PresetName }

type BloomNode = ReturnType<typeof bloom>;
// The JS module default-exports the class; @types/three declares a named export.
type SMAALike = THREE.TempNode<'vec4'> & { setSize(w: number, h: number): void; getTextureNode(): THREE.TextureNode };
const SMAANode = (SMAAModule as unknown as { default: new (t: THREE.Node) => SMAALike }).default;

/** SMAA that sizes its targets from the render scale (stock SMAANode uses the full drawing buffer). */
class ScaledSMAA extends SMAANode {
  scale = 1;
  constructor(t: THREE.Node) {
    super(t);
    // display-referred 0..1 data (as in the SMAA reference): 8 bit, half the bandwidth of half-float
    const self = this as unknown as Record<string, THREE.RenderTarget>;
    for (const k of ['_renderTargetEdges', '_renderTargetWeights', '_renderTargetBlend']) self[k].texture.type = THREE.UnsignedByteType;
  }
  setSize(width: number, height: number) { super.setSize(Math.max(1, Math.floor(width * this.scale)), Math.max(1, Math.floor(height * this.scale))); }
}

/**
 * Clustered lighting that works at any render scale WITHOUT rebuilding. The stock node bakes the
 * grid size (from the drawing buffer) into every lit material's fragment shader and finds a
 * fragment's tile from its PIXEL coordinate / 32: a scaled scene pass would look lights up in the
 * wrong tiles, and resizing the grid recompiled every lit material (measured 1.0-1.9 s freeze per
 * scale step - most of what the old setPixelRatio "resize hitch" was). Here the grid stays at the
 * full canvas size and the fragment finds its tile from screenUV (0..1, resolution independent),
 * which also matches the compute pass's tile -> NDC mapping exactly.
 */
export class ScaledClusteredLighting extends ClusteredLighting {
  createNode(lights: THREE.Light[] = []) {
    type CL = {
      create(w: number, h: number): void; tileSize: number; zSlices: number;
      _screenClusterIndex: THREE.Node; _cameraNear: THREE.Node<'float'>; _cameraFar: THREE.Node<'float'>;
    };
    const node = super.createNode(lights) as unknown as CL;
    const create = node.create.bind(node);
    node.create = (w: number, h: number) => {
      create(w, h);
      const NX = Math.floor(w / node.tileSize), NY = Math.floor(h / node.tileSize), NZ = node.zSlices;
      node._screenClusterIndex = Fn(() => {
        const tile = screenUV.mul(vec2(NX, NY)).floor().min(vec2(NX - 1, NY - 1));
        const viewDepth = positionView.z.negate();
        const invLog = float(1).div(log(node._cameraFar.div(node._cameraNear)));
        const zSlice = clamp(log(viewDepth.div(node._cameraNear)).mul(invLog).mul(NZ).floor(), 0, NZ - 1);
        return int(tile.x).add(int(tile.y).mul(NX)).add(int(zSlice).mul(NX * NY));
      })().toVar();
    };
    return node as unknown as ReturnType<ClusteredLighting['createNode']>;
  }
}

/**
 * Single-pass upscale + RCAS sharpening. src: a display-referred (tone-mapped, sRGB) texture at
 * the render size; evaluated per CANVAS pixel. The 5 taps are bilinear and one SOURCE texel apart,
 * so at scale 1 it is plain RCAS and at 0.7 it reconstructs and sharpens in one go (no extra
 * render target). sharpness: 0 = strongest, 2 = none (RCAS convention).
 */
function casUpscale(src: THREE.TextureNode, sharpness: THREE.UniformNode<'float', number>) {
  return Fn(() => {
    const t = vec2(1).div(vec2(textureSize(src) as unknown as THREE.Node<'ivec2'>));
    const p = uv();
    const e = src.sample(p), b = src.sample(p.sub(vec2(0, t.y))), h = src.sample(p.add(vec2(0, t.y)));
    const d = src.sample(p.sub(vec2(t.x, 0))), f = src.sample(p.add(vec2(t.x, 0)));
    const mn4 = min(min(b.rgb, d.rgb), min(f.rgb, h.rgb)).toConst();
    const mx4 = max(max(b.rgb, d.rgb), max(f.rgb, h.rgb)).toConst();
    // RCAS limiter: the negative lobe is as strong as the local contrast allows without clipping
    const hitMin = min(mn4, e.rgb).div(mx4.mul(4).max(1e-4)).toConst();
    const hitMax = vec3(1).sub(max(mx4, e.rgb)).div(mn4.mul(4).sub(4).min(-1e-4)).toConst();
    const lobeRGB = max(hitMin.negate(), hitMax).toConst();
    const lobe = max(float(-(0.25 - 1 / 16)), min(max(lobeRGB.r, max(lobeRGB.g, lobeRGB.b)), 0)).mul(sharpness.negate().exp2()).toConst();
    const rgb = b.rgb.add(d.rgb).add(f.rgb).add(h.rgb).mul(lobe).add(e.rgb).div(lobe.mul(4).add(1));
    return vec4(rgb, 1);
  })();
}

/** Render-to-texture in 8 bit: everything after the tone map is display-referred (0..1, sRGB). */
const rtt8 = (n: THREE.Node) => rtt(n, null, null, { type: THREE.UnsignedByteType }) as unknown as THREE.RTTNode;

export class Post {
  private scenePass: THREE.PassNode;
  private pipelines = new Map<PresetName, THREE.RenderPipeline>();
  private blooms: { node: BloomNode; res: number }[] = [];
  private scaled: { setResolutionScale(s: number): unknown }[] = [];
  private smaas: ScaledSMAA[] = [];
  private sharpness = uniform(0.5);
  private _scale = 1;
  preset: PresetName;

  constructor(private renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, private opts: PostOptions) {
    this.scenePass = pass(scene, camera);
    const color = this.scenePass.getTextureNode('output');
    for (const name of PRESET_ORDER) {
      const pr = PRESETS[name];
      const p = new THREE.RenderPipeline(renderer);
      let lit: THREE.Node<'vec4'> = color;
      if (opts.bloom && pr.bloom > 0) {
        const b = bloom(color, 0.35, 0.15, 1.2);
        this.blooms.push({ node: b, res: pr.bloom });
        lit = color.add(b);
      }
      // display-referred image at the render size (AA and the sharpening limiter expect 0..1)
      const toned = rtt8(renderOutput(lit));
      this.scaled.push(toned);
      let src: THREE.TextureNode = toned;
      const aa = opts.aa ? pr.aa : 'none';
      if (aa === 'smaa') {
        const s = new ScaledSMAA(toned);
        this.smaas.push(s);
        src = s.getTextureNode();
      } else if (aa === 'fxaa') {
        const fx = rtt8(fxaa(toned));
        this.scaled.push(fx);
        src = fx;
      }
      p.outputColorTransform = false;
      p.outputNode = casUpscale(src, this.sharpness);
      this.pipelines.set(name, p);
    }
    this.preset = opts.preset;
    this.setScale(opts.scale);
  }

  get scale() { return this._scale; }

  /** Render scale of everything before the upscale. Resizes render targets: only at the allowed points. */
  setScale(s: number) {
    this._scale = s;
    this.scenePass.setResolutionScale(s);
    for (const r of this.scaled) r.setResolutionScale(s);
    for (const m of this.smaas) m.scale = s;
    for (const b of this.blooms) b.node.setResolutionScale(b.res * s);
    // full-resolution image: a light touch only (RCAS at 1:1 sharpens texture noise); reduced: stronger
    this.sharpness.value = s >= 0.99 ? 1.0 : 0.5;
  }

  render() { this.pipelines.get(this.preset)!.render(); }

  /** Renders every preset once (shader warm-up behind the loading screen). */
  warmup() {
    const keep = this.preset;
    for (const name of PRESET_ORDER) { this.preset = name; this.render(); }
    this.preset = keep;
  }
}
