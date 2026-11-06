// 'ultra' preset: wet-road reflections WITHOUT a wide MRT scene pass. The heavy way (fx/gtaoTraa.ts, preset 'max') writes
// velocity + normal + reflect-weight attachments for every pixel, which on the shared-memory iGPU costs ~3 ms and cannot hold
// 30 fps at full resolution. Here the scene pass stays the plain single-attachment one (shared with high/medium/low): the
// view normal is rebuilt from depth in one small half-res pass, and "wet" means every up-facing surface (roads, pavement,
// car roofs) reflects with fixed low roughness; everything else is discarded by SSR before ray-marching (weight 0).
// No per-material puddles (that needs the material roughness attachment), no TRAA (SMAA stays).
import * as THREE from 'three/webgpu';
import { dot, float, getNormalFromDepth, rtt, smoothstep, uniform, uv, vec4 } from 'three/tsl';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { ssrOptions } from './ssr';

export class DepthFx {
  /** beauty (HDR) with the reflections added */
  readonly color: THREE.Node<'vec4'>;
  private normals: THREE.RTTNode;
  private node: ReturnType<typeof ssr>;

  constructor(scenePass: THREE.PassNode, camera: THREE.PerspectiveCamera) {
    const opt = ssrOptions({ intensity: 0.55 });   // every up-facing surface is 'wet': keep it a sheen, not a lake (?ssr=intensity:N to tune)
    const beauty = scenePass.getTextureNode('output');
    const depth = scenePass.getTextureNode('depth');
    // Inside an RTT pass the built-in camera nodes are the quad's own camera: bind the GAME camera's matrices (the Matrix4
    // objects are updated in place by three, so the uniforms follow the camera).
    const projInv = uniform(camera.projectionMatrixInverse), viewM = uniform(camera.matrixWorldInverse);
    const n = getNormalFromDepth(uv(), depth as unknown as THREE.Node, projInv);   // view space
    const up = viewM.mul(vec4(0, 1, 0, 0)).xyz;   // world up, in view space
    const wet = smoothstep(float(0.88), float(0.98), dot(n, up).abs());   // abs: the depth-derived normal's sign depends on the derivative direction
    this.normals = rtt(vec4(n, wet), null, null, { type: THREE.HalfFloatType }) as unknown as THREE.RTTNode;
    this.node = ssr(beauty, depth, this.normals as unknown as THREE.Node<'vec3'>,
      { metalnessNode: (this.normals as unknown as { a: THREE.Node<'float'> }).a, roughnessNode: float(0.16), camera, binaryRefine: opt.binaryRefine });
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
    this.color = beauty.add(this.node.rgb) as unknown as THREE.Node<'vec4'>;
  }

  setScale(s: number) {
    this.normals.setResolutionScale(0.5 * s);
    this.node.resolutionScale = 0.5 * s;
  }
}
