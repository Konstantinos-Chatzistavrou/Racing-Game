// New York runtime entry. Content modules written by other stages are discovered in streamer.ts (import.meta.glob, so a missing file is not
// a build error) and replaced by placeholders.ts until they exist. Expected exports:
//   ./groundMaterials.ts  createGroundMaterials(): Record<string, THREE.Material>     keys road sidewalk curb marking crosswalk plaza grass water rail
//   ./facade.ts           createFacadeMaterial(): THREE.Material, createRoofMaterial(): THREE.Material
//   ./props.ts            class NycProps { constructor(scene, camera); setTile(key, data); removeTile(key); update(dt); dispose() }
export { NycStreamer, loadNycMaterials, type NycStats, type NycSpawn, type NycMaterials, type NycOptions, type NycPropsLike } from './streamer';

import * as THREE from 'three/webgpu';
import type { City } from '../city';

/** The parts of main.ts's `City` that make sense with streamed tiles (no old-city lights/props/bundles): lets the existing loop and warm-up run unchanged. */
export function nycCityShim(): City {
  return { root: new THREE.Group(), lights: [], lamps: 420, neon: 130, props: { drawScale: 1, assets: [], warmup() {} } as unknown as City['props'], update() {}, setBundled() {}, bundles: 0 };
}
