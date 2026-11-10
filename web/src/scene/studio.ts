// Studio environment for the garage: a dark photo studio with a handful of big emissive softboxes. It is rendered
// once into a prefiltered PMREM texture that the car's paint, glass and rims sample while it sits in the showroom -
// no textures on disk, no extra lights in the scene, and no per-frame cost after the first build.
import * as THREE from 'three/webgpu';

export interface StudioEnvOptions {
  /** softbox scale multiplier (default 1: the key is about 4 x 2 m at car scale) */
  size?: number;
  /** emissive multiplier (default 1) */
  intensity?: number;
}

interface Panel {
  w: number;
  h: number;
  pos: [number, number, number];
  color: THREE.ColorRepresentation;
  gain: number;
}

/**
 * Softbox layout around a car-sized target (the car is ~4.4 m long, 2 m wide, 1.3 m tall):
 *  - warm key, 4 x 2 m, 35 deg off the front axis and 2.5 m high (the long clearcoat ribbon on the flank)
 *  - cool rim strip behind and above, so the roof and rear shoulder catch a hard edge
 *  - low front fill, wide and soft, to keep the bumper from going black
 *  - ceiling strip straight above, the top highlight on the bonnet and roof
 *  - a second cool fill on the opposite rear quarter for separation
 */
const PANELS: Panel[] = [
  { w: 4.0, h: 2.2, pos: [3.2, 2.6, 2.4], color: 0xfff1e0, gain: 2.6 },
  { w: 0.7, h: 2.8, pos: [-3.4, 2.3, -2.6], color: 0x9fc4ff, gain: 2.2 },
  { w: 2.6, h: 1.2, pos: [0.4, 0.55, 3.4], color: 0xdfe8ff, gain: 0.75 },
  { w: 3.0, h: 0.5, pos: [0.2, 3.5, -0.3], color: 0xffffff, gain: 1.7 },
  { w: 1.8, h: 1.6, pos: [-2.6, 1.5, 2.6], color: 0xbfd4ff, gain: 0.55 },
];

/** Very dim floor bounce so the underside of the car is not lit by nothing. */
const FLOOR = { size: 10, color: 0x14161a } as const;

/**
 * Build a PMREM environment that looks like a dark photo studio with big softboxes.
 * Returns a filtered cube texture ready to assign to material.envMap.
 */
export function createStudioEnv(renderer: THREE.WebGPURenderer, pmrem: THREE.PMREMGenerator, opts: StudioEnvOptions = {}): THREE.Texture {
  void renderer;   // the PMREM generator owns the render state; the renderer is only part of the API shape
  const scale = opts.size ?? 1;
  const gain = opts.intensity ?? 1;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05070b);   // near black, a hint of blue
  const meshes: THREE.Mesh[] = [];
  const look = new THREE.Vector3(0, 0.7 * scale, 0);

  for (const p of PANELS) {
    const geo = new THREE.PlaneGeometry(p.w * scale, p.h * scale);
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(p.color).multiplyScalar(p.gain * gain),
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const m = new THREE.Mesh(geo, mat);
    m.position.set(p.pos[0] * scale, p.pos[1] * scale, p.pos[2] * scale);
    m.lookAt(look);
    scene.add(m);
    meshes.push(m);
  }

  // floor: a large dark card facing up, so the underside gets a little bounce and the reflection has a ground
  const floorGeo = new THREE.PlaneGeometry(FLOOR.size * scale, FLOOR.size * scale);
  const floorMat = new THREE.MeshBasicMaterial({ color: FLOOR.color, side: THREE.DoubleSide, toneMapped: false });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0;
  scene.add(floor);
  meshes.push(floor);

  const target = pmrem.fromScene(scene, 0, 0.1, 100);
  const texture = target.texture;
  // the render target owns the texture: keep it alive with it, the temp scene is thrown away below
  texture.userData.keep = target;

  for (const m of meshes) {
    m.geometry.dispose();
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) mat.dispose();
  }
  scene.clear();
  scene.background = null;

  return texture;
}
