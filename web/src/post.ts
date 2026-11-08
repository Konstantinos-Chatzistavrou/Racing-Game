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
import { Fn, clamp, float, int, log, max, min, pass, positionView, rtt, screenUV, textureSize, uniform, uv, vec2, vec3, vec4 } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import * as SMAAModule from 'three/addons/tsl/display/SMAANode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { CURVES, GRADE, filmGrain, toneGrade, type CurveName } from './fx/grade';
import { DepthFx } from './fx/depthFx';
import { ClusteredLighting } from 'three/addons/lighting/ClusteredLighting.js';

export type PresetName = 'max' | 'ultra' | 'high' | 'medium' | 'low';
export interface Preset {
  aa: 'smaa' | 'fxaa' | 'traa' | 'none';
  /** half-resolution GTAO (ultra only; uses its own MRT scene pass, see fx/gtaoTraa.ts) */
  ao?: boolean;
  /** bloom resolution relative to the RENDER size; 0 = no bloom */
  bloom: number;
  /** headlight shadow map re-rendered every Nth frame (see main.ts) */
  shadowEvery: number;
  /** fx/grade.ts: 'full' = contrast/saturation/split tone, 'tone' = tone curve only */
  grade: 'full' | 'tone';
  /** animated film grain in the final pass */
  grain: boolean;
  /** screen-space reflections on wet road / glass (fx/ssr.ts); rides on the ultra MRT pass (needs `ao`) */
  ssr?: boolean;
}
// Ordered best -> cheapest. The GPU cost differences are small but real on the iGPU (measured with
// timestamp queries, see docs/web_port.md): SMAA = 3 passes, FXAA = 1, bloom = ~11 small passes.
export const PRESETS: Record<PresetName, Preset> = {
  max: { aa: 'smaa', ao: true, ssr: true, bloom: 0.25, shadowEvery: 1, grade: 'full', grain: true },
  ultra: { aa: 'smaa', ssr: true, bloom: 0.25, shadowEvery: 2, grade: 'full', grain: true },
  high: { aa: 'smaa', bloom: 0.25, shadowEvery: 3, grade: 'full', grain: true },
  medium: { aa: 'fxaa', bloom: 0.25, shadowEvery: 3, grade: 'full', grain: false },
  low: { aa: 'none', bloom: 0, shadowEvery: 4, grade: 'tone', grain: false },
};
/** final-image look defaults (fx/grade.ts); ?tm=agx|aces|neutral|uchimura, ?grade=0 for A/B */
const DEFAULT_CURVE: CurveName = 'neutral';
const BLOOM = { strength: 0.45, radius: 0.45, threshold: 1.0, knee: 0.5 };
export const PRESET_ORDER: PresetName[] = ['max', 'ultra', 'high', 'medium', 'low'];

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
const FIXED_GRID = [1920, 1088] as const;   // drawing-buffer size the cluster grid is built for (multiple of the 32 px tile)

export class ScaledClusteredLighting extends ClusteredLighting {
  createNode(lights: THREE.Light[] = []) {
    type CL = {
      create(w: number, h: number): void; tileSize: number; zSlices: number; _bufferSize: unknown;
      updateProgram(r: unknown): void; setSize(w: number, h: number): unknown;
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
    // One grid for every canvas size: tiles are found from screenUV, so the grid need not follow the drawing buffer,
    // and rebuilding it recompiles every lit material (measured: 4 s frozen when going fullscreen). 60 x 34 tiles
    // (a 1080p layout; tiles stretch a little on other aspects and sizes, the light lists stay exact).
    node.updateProgram = () => { if (node._bufferSize === null || node._bufferSize === undefined) node.create(FIXED_GRID[0], FIXED_GRID[1]); };
    node.setSize = () => node;
    return node as unknown as ReturnType<ClusteredLighting['createNode']>;
  }
}

/**
 * Single-pass upscale + RCAS sharpening. src: a display-referred (tone-mapped, sRGB) texture at
 * the render size; evaluated per CANVAS pixel. The 5 taps are bilinear and one SOURCE texel apart,
 * so at scale 1 it is plain RCAS and at 0.7 it reconstructs and sharpens in one go (no extra
 * render target). sharpness: 0 = strongest, 2 = none (RCAS convention).
 */
function casUpscale(src: THREE.TextureNode, sharpness: THREE.UniformNode<'float', number>, grain: boolean) {
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
    return vec4(grain ? filmGrain(rgb) : rgb, 1);
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
  private maxFx: DepthFx | null = null;
  private depthFx: DepthFx | null = null;
  /** Shared world position of the player car (mutated in-place by main.ts so DepthFx masks car roof ripples & underbody SSR). */
  readonly carPos = new THREE.Vector3(0, -100, 0);
  private sharpness = uniform(0.5);
  private _scale = 1;
  preset: PresetName;

  constructor(private renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, private opts: PostOptions) {
    this.scenePass = pass(scene, camera);
    const color = this.scenePass.getTextureNode('output');
    const q = new URLSearchParams(location.search);
    const curve: CurveName = (CURVES as string[]).includes(q.get('tm') ?? '') ? (q.get('tm') as CurveName) : DEFAULT_CURVE;
    const grading = q.get('grade') !== '0';
    for (const k of ['contrast', 'sat', 'split', 'grain', 'lift', 'exposure'] as const) if (q.has(k)) (GRADE[k] as { value: number }).value = Number(q.get(k));
    const bloomStrength = Number(q.get('bs') ?? BLOOM.strength), bloomRadius = Number(q.get('br') ?? BLOOM.radius);
    const bloomThreshold = Number(q.get('bt') ?? BLOOM.threshold), bloomKnee = Number(q.get('bk') ?? BLOOM.knee);
    let sharedBloom: BloomNode | null = null;
    let sharedTonedFull: THREE.RTTNode | null = null;
    const ssrOn = q.get('ssr') !== '0';
    const aoOn = q.get('ao') !== '0';
    for (const name of PRESET_ORDER) {
      const pr = PRESETS[name];
      const p = new THREE.RenderPipeline(renderer);
      const fx = pr.ao && pr.ssr && ssrOn
        ? (this.maxFx ??= new DepthFx(this.scenePass, camera, { resScale: 0.75, quality: 0.3, maxDistance: 85, intensity: 0.72, withAo: aoOn, carPos: this.carPos }))
        : null;
      const lite = !fx && pr.ssr && ssrOn
        ? (this.depthFx ??= new DepthFx(this.scenePass, camera, { resScale: 0.5, quality: 0.16, maxDistance: 55, intensity: 0.6, carPos: this.carPos }))
        : null;
      let lit: THREE.Node<'vec4'> = fx ? fx.color : lite ? lite.color : color;
      if (opts.bloom && pr.bloom > 0) {
        if (!fx && !lite && sharedBloom) {
          lit = lit.add(sharedBloom);
        } else {
          const b = bloom(lit, bloomStrength, bloomRadius, bloomThreshold);
          (b as unknown as { smoothWidth: { value: number } }).smoothWidth.value = bloomKnee;
          this.blooms.push({ node: b, res: pr.bloom });
          if (!fx && !lite) sharedBloom = b;
          lit = lit.add(b);
        }
      }
      // display-referred image at the render size (AA and the sharpening limiter expect 0..1)
      let toned: THREE.RTTNode;
      if (!fx && !lite && opts.bloom && pr.bloom > 0 && pr.grade === 'full' && sharedTonedFull) {
        toned = sharedTonedFull;
      } else {
        toned = rtt8(toneGrade(lit, curve, pr.grade === 'full' && grading));
        this.scaled.push(toned);
        if (!fx && !lite && opts.bloom && pr.bloom > 0 && pr.grade === 'full') sharedTonedFull = toned;
      }
      let src: THREE.TextureNode = toned;
      const aa = opts.aa ? pr.aa : 'none';
      if (aa === 'smaa' || aa === 'traa') {
        const s = new ScaledSMAA(toned);
        this.smaas.push(s);
        src = s.getTextureNode();
      } else if (aa === 'fxaa') {
        const fx = rtt8(fxaa(toned));
        this.scaled.push(fx);
        src = fx;
      }
      p.outputColorTransform = false;
      p.outputNode = casUpscale(src, this.sharpness, pr.grain && grading);
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
    this.maxFx?.setScale(s);
    this.depthFx?.setScale(s);
    for (const r of this.scaled) r.setResolutionScale(s);
    for (const m of this.smaas) m.scale = s;
    for (const b of this.blooms) b.node.setResolutionScale(b.res * s);
    // full-resolution image: a light touch only (RCAS at 1:1 sharpens texture noise); reduced: stronger
    this.sharpness.value = s >= 0.99 ? 1.0 : 0.5;
  }

  /** called with the preset before every render */
  onPreset: ((p: PresetName) => void) | null = null;
  render() { this.onPreset?.(this.preset); this.pipelines.get(this.preset)!.render(); }

  /** Renders active/fallback presets once (shader warm-up behind the loading screen). */
  warmup() {
    const keep = this.preset;
    for (const name of PRESET_ORDER) { this.preset = name; this.render(); }
    this.preset = keep;
  }

  /** Same, one preset per real frame so per-frame nodes initialize without redundant loops. */
  async warmupFrames() {
    const keep = this.preset;
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    // every preset: the in-race fallback (phones: medium -> low) must never build pipelines with a car on screen (6.5 s measured)
    for (const name of PRESET_ORDER) { this.preset = name; this.render(); await frame(); }
    this.preset = keep;
  }
}
