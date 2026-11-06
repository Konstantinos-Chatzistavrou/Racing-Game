// Placeholder tile materials, used until the real ones are merged (groundMaterials.ts, facade.ts): flat dark ground per glb material
// name, and a grey facade with a trivial window grid (+ a few lit windows) built from the contract's attributes (UV in metres, COLOR_0).
// Same rule as the real ones: ONE shared instance per name, created once, never disposed with a tile.
import * as THREE from 'three/webgpu';
import { attribute, float, floor, fract, hash, mix, step, uv, vec2, vec3, vertexColor } from 'three/tsl';

const GROUND: Record<string, [number, number, number, number]> = {   // colour, roughness
  road: [0.045, 0.047, 0.055, 0.55], sidewalk: [0.12, 0.12, 0.13, 0.85], curb: [0.16, 0.16, 0.17, 0.8], marking: [0.55, 0.55, 0.5, 0.6],
  crosswalk: [0.5, 0.5, 0.48, 0.6], plaza: [0.1, 0.1, 0.11, 0.8], grass: [0.03, 0.07, 0.035, 0.95], water: [0.01, 0.025, 0.05, 0.1], rail: [0.07, 0.06, 0.055, 0.7],
};

export function createPlaceholderGround(): Record<string, THREE.Material> {
  const out: Record<string, THREE.Material> = {};
  for (const [name, [r, g, b, rough]] of Object.entries(GROUND)) {
    const m = new THREE.MeshStandardNodeMaterial({ roughness: rough, metalness: 0 });
    m.name = name;
    m.colorNode = vec3(r, g, b).mul(vertexColor().rgb.mul(0.6).add(0.4));
    if (name === 'marking' || name === 'crosswalk') { m.polygonOffset = true; m.polygonOffsetFactor = -1; m.polygonOffsetUnits = -4; }
    out[name] = m;
  }
  return out;
}

function windows(lit: number) {
  const cell = vec2(3.2, 3.6);                       // metres per bay, per floor
  const p = uv().div(cell), id = floor(p), f = fract(p);
  const win = step(0.18, f.x).mul(step(f.x, 0.82)).mul(step(0.3, f.y)).mul(step(f.y, 0.78));
  const h = hash(id.x.mul(37).add(id.y.mul(91)).add(attribute('_bld', 'vec4').x.mul(1000)));
  return { win, on: step(1 - lit, h).mul(win), h };
}

/** Grey walls, dark glass panes, a third of the windows lit warm at night. Needs _BLD (seed 0..1 in x) and UV in metres. */
export function createPlaceholderFacade(): THREE.Material {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.8, metalness: 0 });
  m.name = 'facade';
  const w = windows(0.3);
  const wall = vertexColor().rgb.mul(vertexColor().a.mul(0.5).add(0.5));
  m.colorNode = mix(wall, vec3(0.02, 0.03, 0.045), w.win.mul(0.9));
  m.emissiveNode = vec3(1.0, 0.66, 0.36).mul(w.on).mul(float(0.4).add(w.h.mul(0.6))).mul(0.9);
  return m;
}

export function createPlaceholderRoof(): THREE.Material {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
  m.name = 'roof';
  m.colorNode = vertexColor().rgb.mul(0.45);
  return m;
}
