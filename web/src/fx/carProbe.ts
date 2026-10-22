// Live reflection probe for the player's car: a small cube map of the real, lit city (lamps, neon,
// AI cars, the headlight pools on the road) centred just above the car, with the car itself hidden.
// One cube face is rendered per probe tick (128 px, so a tick is a tiny scene render); after the sixth
// face the cube is GGX-filtered into a persistent PMREM target that the car's materials sample via
// `material.envMap`. Nothing about the materials changes after load (the envMap is attached BEFORE the
// first compile/draw and its texture object never changes), so there are no recompiles while driving.
//
// Cost model: a face = one extra scene render at size^2 (CPU: the draw calls of the city, GPU: tiny),
// the filter = a few small passes once per 6 faces. `every` spaces the face renders out over frames.
import * as THREE from 'three/webgpu';

export class CarProbe {
  private rt: THREE.CubeRenderTarget;
  private cube: THREE.CubeCamera;
  private filtered: THREE.RenderTarget;
  private face = 0;
  private tick = 0;
  private hidden: THREE.Object3D[] = [];
  /** probe centre offset above the car origin (m) */
  height = 0.9;

  constructor(private renderer: THREE.WebGPURenderer, private scene: THREE.Scene, private pmrem: THREE.PMREMGenerator,
    size = 128, private every = 1, near = 0.3, far = 250) {
    this.rt = new THREE.CubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.cube = new THREE.CubeCamera(near, far, this.rt);
    this.cube.layers.set(0);
    // allocate the persistent filtered target (and give it content) once
    this.filtered = this.pmrem.fromCubemap(this.rt.texture);
  }

  get texture() { return this.filtered.texture; }

  /** Point a model's materials at the probe. Do this BEFORE the model's first compile/draw (it changes the shader). */
  attach(model: THREE.Object3D, intensity = 1) {
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      for (const mat of (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshStandardMaterial[]) {
        mat.envMap = this.filtered.texture;
        mat.envMapIntensity = intensity;
      }
    });
  }

  /** Render all six faces + filter right now (load time / car swap). `hide`: the car's visual root. */
  captureAll(pos: THREE.Vector3, hide: THREE.Object3D) {
    this.begin(pos, hide);
    for (let i = 0; i < 6; i++) this.renderFace(i);
    this.end();
    this.filter();
    this.face = 0;
  }

  /** One probe tick: renders the next cube face (every Nth call); the 6th also re-filters. Call AFTER the main render. */
  update(pos: THREE.Vector3, hide: THREE.Object3D) {
    if (this.every <= 0 || ++this.tick % this.every !== 0) return;
    if (this.face === 0) this.begin(pos, hide);   // the probe centre is fixed for the six faces of one cycle
    else this.hideCar(hide);
    this.renderFace(this.face);
    this.end();
    if (++this.face === 6) { this.filter(); this.face = 0; }
  }

  private begin(pos: THREE.Vector3, hide: THREE.Object3D) {
    this.cube.position.copy(pos);
    this.cube.position.y += this.height;
    this.cube.updateMatrixWorld(true);
    this.hideCar(hide);
  }

  private hideCar(root: THREE.Object3D) {
    root.traverse((o) => { if ((o as THREE.Mesh).isMesh && o.visible) { o.visible = false; this.hidden.push(o); } });
  }

  private end() { for (const o of this.hidden) o.visible = true; this.hidden.length = 0; }

  private renderFace(i: number) {
    const r = this.renderer;
    if (this.cube.coordinateSystem !== r.coordinateSystem) {
      this.cube.coordinateSystem = r.coordinateSystem;
      this.cube.updateCoordinateSystem();
    }
    const prevRT = r.getRenderTarget(), prevFace = r.getActiveCubeFace(), prevMip = r.getActiveMipmapLevel();
    // No shadow sampling in the probe's shaders: building the lights' ShadowNodes a second time (for this render
    // context) replaces their shadow maps and destroys the ones the main pass still binds (WebGPU "Destroyed
    // texture ShadowDepthTexture" every frame). The flag is read at shader build time only, so toggling it here
    // gives the probe its own shadow-less variants and leaves the main pass untouched.
    const sh = r.shadowMap.enabled;
    r.shadowMap.enabled = false;
    r.setRenderTarget(this.rt, i);
    r.render(this.scene, this.cube.children[i] as THREE.Camera);
    r.setRenderTarget(prevRT, prevFace, prevMip);
    r.shadowMap.enabled = sh;
  }

  private filter() { this.pmrem.fromCubemap(this.rt.texture, this.filtered); }
}
