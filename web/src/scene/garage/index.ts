// The garage as its own scene. The showroom screens (title, garage, modes, lobby) render THIS scene instead of the
// city: nothing of the street is drawn, its 40-odd lights are not evaluated, and the room's own light is baked, so the
// frame goes to the car - full resolution, a mirror floor, soft reflections of the light lines in the paint.
//
// Scene contract (main.ts):
//  - `scene` is rendered by ShowroomPost; `holder` receives the hero car's model while a showroom screen is up
//    (the car's root, with its headlight spots, stays in the city scene so no light set ever changes there);
//  - `captureEnv()` renders the room into a cube and prefilters it: `env` (the persistent PMREM texture) is the
//    scene's environment and is what the car's paint mirrors.
import * as THREE from 'three/webgpu';
import { buildRoom, lightShaft, ROOM, type GarageRoom } from './room';
import { LAMPS, loadProps } from './props';

export { ROOM };

export class Garage {
  readonly scene = new THREE.Scene();
  /** the hero car's model goes here (origin = centre of the turntable, floor level) */
  readonly holder = new THREE.Group();
  /** unfiltered cube of the room, for consumers that prefilter into their own target (the car's reflection probe) */
  readonly cube: THREE.CubeRenderTarget;
  private cubeCam: THREE.CubeCamera;
  private envRT: THREE.RenderTarget;
  private room!: GarageRoom;
  private parked: THREE.Object3D[] = [];
  /** set when the props have arrived and the environment should be captured again */
  dirtyEnv = true;

  private constructor(private renderer: THREE.WebGPURenderer, private pmrem: THREE.PMREMGenerator, cubeSize: number) {
    this.scene.name = 'garage_scene';
    this.scene.userData.plainLights = true;   // post.ts ScaledClusteredLighting: this scene uses plain forward lights
    this.scene.background = new THREE.Color(0x020308);
    this.scene.fog = new THREE.FogExp2(0x0a0c16, 0.022);
    this.cube = new THREE.CubeRenderTarget(cubeSize, { type: THREE.HalfFloatType, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.cubeCam = new THREE.CubeCamera(0.2, 60, this.cube);
    this.cubeCam.position.set(0, 1.15, 0);
    this.envRT = pmrem.fromCubemap(this.cube.texture);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = 1;
    this.scene.add(this.holder);
    // Two real lights, for the cars only (the room is unlit/baked): a soft warm key from the doors' side for form on
    // tyres, cabin and matte parts, and a cool rim from the back wall. The paint's highlights come from the env.
    const key = new THREE.DirectionalLight(0xfff0de, 1.1);
    key.position.set(3.5, 6, 5);
    const rim = new THREE.DirectionalLight(0xa8c8ff, 0.9);
    rim.position.set(-4, 3.2, -6);
    this.scene.add(key, key.target, rim, rim.target);
  }

  get env(): THREE.Texture { return this.envRT.texture; }
  get floor() { return this.room.floor; }
  get bake() { return this.room.bake; }

  static async create(renderer: THREE.WebGPURenderer, pmrem: THREE.PMREMGenerator, cubeSize = 256): Promise<Garage> {
    const g = new Garage(renderer, pmrem, cubeSize);
    g.room = await buildRoom(g.envRT.texture, LAMPS);
    g.scene.add(g.room.group);
    for (const [x, z] of LAMPS) {
      // a bare bulb under the shade, its pool of light, and the shaft in the haze
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffc98a).multiplyScalar(14) }));
      bulb.position.set(x, 4.2, z);
      g.room.group.add(bulb);
      const shaft = lightShaft(0xffc98a, 0.2, 1.9, 4.1, 0.16);
      shaft.position.set(x, 4.2, z);
      g.room.group.add(shaft);
    }
    return g;
  }

  /** Dressing arrives after the first frame: load, bake, add, and ask for a new environment capture. */
  async loadProps(): Promise<void> {
    await loadProps(this.room.group, this.room.bake, this.envRT.texture);
    this.dirtyEnv = true;
  }

  /** Two parked cars in the side bays (clones of the traffic model, lamps off). */
  park(cars: THREE.Object3D[]) {
    for (const c of this.parked) c.removeFromParent();
    this.parked = cars.slice(0, this.room.bays.length);
    this.parked.forEach((c, i) => {
      const b = this.room.bays[i];
      c.position.set(b.x, 0.01, b.z);
      c.rotation.set(0, b.ry, 0);
      c.visible = true;
      this.scene.add(c);
    });
    this.dirtyEnv = true;
  }

  /**
   * Render the room into the cube (hero car hidden, floor without its mirror: a reflector inside a cube render would
   * allocate a mirror target per face) and prefilter it into `env`. Call with the garage scene's lights compiled.
   */
  captureEnv() {
    const r = this.renderer;
    const holderVisible = this.holder.visible;
    const mirror = this.room.floorMesh.material;
    this.holder.visible = false;
    this.room.floorMesh.material = this.room.floorPlain;
    const prevRT = r.getRenderTarget(), prevFace = r.getActiveCubeFace(), prevMip = r.getActiveMipmapLevel();
    this.cubeCam.update(r as unknown as THREE.Renderer, this.scene);
    r.setRenderTarget(prevRT, prevFace, prevMip);
    this.room.floorMesh.material = mirror;
    this.holder.visible = holderVisible;
    this.pmrem.fromCubemap(this.cube.texture, this.envRT);
    this.dirtyEnv = false;
  }

  /** Keep a camera position inside the room and clear of the dressing: scale its offset from `target` if needed. */
  clampCamera(target: THREE.Vector3, p: THREE.Vector3) {
    const mx = ROOM.hw - 4.2, mz = ROOM.hd - 1.0, top = ROOM.h - 1.3;
    const dx = p.x - target.x, dy = p.y - target.y, dz = p.z - target.z;
    let k = 1;
    if (Math.abs(p.x) > mx) k = Math.min(k, (mx - Math.sign(dx) * target.x) / Math.abs(dx));
    if (Math.abs(p.z) > mz) k = Math.min(k, (mz - Math.sign(dz) * target.z) / Math.abs(dz));
    if (p.y > top) k = Math.min(k, (top - target.y) / dy);
    if (p.y < 0.16) k = Math.min(k, (0.16 - target.y) / dy);
    if (k < 1) p.set(target.x + dx * k, target.y + dy * k, target.z + dz * k);
    const rr = Math.hypot(p.x, p.z);
    if (rr > 7.6) { p.x *= 7.6 / rr; p.z *= 7.6 / rr; }
  }
}
