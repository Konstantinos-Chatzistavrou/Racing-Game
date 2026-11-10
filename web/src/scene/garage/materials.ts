// Materials of the garage room. None of them is lit in real time: the light arrives in the vertex attributes written
// by the bake (bake.ts), the surface detail comes from CC0 PBR sets (Poly Haven) mapped in world space, and the shine
// is one prefiltered environment sample. Per pixel that is 2-3 texture reads and a handful of dot products - against
// the ~50 clustered lights the old room evaluated.
//
// World-planar mapping: every shell surface is an axis-aligned wall, floor or beam, so texture coordinates and the
// tangent frame are derived from the world position and the geometric normal. No UVs or tangents to author, the
// tiling is in metres, and merged pieces line up on their own.
import * as THREE from 'three/webgpu';
import {
  abs, attribute, cameraPosition, cameraWorldMatrix, cross, dot, float, max, mix, mx_noise_float, normalMap, normalWorldGeometry, normalize,
  pmremTexture, positionWorld, pow, reflect, reflector, select, smoothstep, texture, uv, vec2, vec3, vec4, length, uniform,
} from 'three/tsl';

type V3 = THREE.Node<'vec3'>;
type F = THREE.Node<'float'>;

export interface SurfaceMaps { diff: THREE.Texture; nor?: THREE.Texture; arm?: THREE.Texture }

export interface BakedOpts {
  /** metres per texture repeat */
  tile: number;
  tint?: THREE.ColorRepresentation;
  /** normal-map strength */
  bump?: number;
  /** how strongly the normal map modulates the baked light (0 = flat lightmap look, 1 = full) */
  relief?: number;
  /** roughness used when there is no ARM map / multiplier when there is */
  rough?: number;
  metal?: number;
  /** environment reflection amount (0 = skip the sample entirely: brick, raw concrete) */
  env?: number;
  /** Blinn highlight from the dominant baked light (ridges of corrugated steel, shutter slats) */
  gloss?: number;
  /** overall multiplier on the baked light (art control per surface) */
  gain?: number;
}

/** world-space tangent frame + planar coordinates for an axis-aligned surface */
function planar(tile: number) {
  const N = normalWorldGeometry.normalize();
  const flat = abs(N.y).greaterThan(0.7);
  const T = select(flat, vec3(1, 0, 0), normalize(cross(vec3(0, 1, 0), N))) as V3;
  const B = cross(N, T) as V3;
  const st = vec2(dot(positionWorld, T), dot(positionWorld, B)).div(tile);
  return { N, T, B, st };
}

/** Unlit, bake-driven surface. `env` is the persistent PMREM target of the room (its content is filled in later). */
export function bakedMaterial(maps: SurfaceMaps, env: THREE.Texture, o: BakedOpts): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  const { N, T, B, st } = planar(o.tile);
  const irr = attribute('color', 'vec3') as V3;
  const ldir = (attribute('ldir', 'vec3') as V3).normalize();
  let alb = texture(maps.diff, st).rgb as V3;
  if (o.tint !== undefined) alb = alb.mul(vec3(...new THREE.Color(o.tint).toArray())) as V3;
  let nW: V3 = N;
  if (maps.nor) {
    const n = texture(maps.nor, st).xyz.mul(2).sub(1);
    const s = o.bump ?? 1;
    nW = normalize(T.mul(n.x.mul(s)).add(B.mul(n.y.mul(s))).add(N.mul(n.z))) as V3;
  }
  const arm = maps.arm ? texture(maps.arm, st) : null;
  const ao: F = arm ? (arm.r as F) : float(1);
  const rough: F = arm ? (arm.g.mul(o.rough ?? 1) as F) : float(o.rough ?? 0.85);
  const metal: F = arm ? (arm.b.mul(o.metal ?? 1) as F) : float(o.metal ?? 0);
  // normal-map relief against the dominant light, relative to what the flat surface would receive
  const gdl = max(dot(N, ldir), 0.25);
  const detail = mix(float(1), max(dot(nW, ldir), 0).div(gdl).clamp(0, 1.8), o.relief ?? 0.7);
  let out = alb.mul(irr).mul(detail).mul(ao).mul(float(1).sub(metal.mul(0.85))).mul(o.gain ?? 1) as V3;
  const V = normalize(cameraPosition.sub(positionWorld)) as V3;
  if ((o.env ?? 0) > 0) {
    const ndv = max(dot(nW, V), 0);
    const f0 = mix(vec3(0.04), alb, metal);
    const fres = f0.add(vec3(1).sub(f0).mul(pow(float(1).sub(ndv), 5)).mul(float(1).sub(rough)));
    out = out.add(pmremTexture(env, reflect(V.negate(), nW), rough).rgb.mul(fres).mul(ao).mul(o.env!)) as V3;
  }
  if ((o.gloss ?? 0) > 0) {
    const H = normalize(ldir.add(V));
    const shin = mix(float(90), float(10), rough);
    const spec = pow(max(dot(nW, H), 0), shin).mul(max(dot(nW, ldir), 0));
    out = out.add(irr.mul(mix(vec3(0.6), alb.mul(2.2), metal)).mul(spec).mul(o.gloss!)) as V3;
  }
  m.colorNode = vec4(out, 1);
  return m;
}

/**
 * A loaded prop (glTF, its own UVs and PBR maps) shaded by the same bake as the room: the prop picks up the light of
 * the spot where it stands - the neon wash by the back wall, the tube over its bay - instead of one average.
 */
export function bakedPropMaterial(src: THREE.MeshStandardMaterial, env: THREE.Texture, gain = 1): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ side: src.side, transparent: src.transparent, alphaTest: src.alphaTest });
  const irr = attribute('color', 'vec3') as V3;
  const ldir = (attribute('ldir', 'vec3') as V3).normalize();
  const c = src.color ?? new THREE.Color(1, 1, 1);
  const base = src.map ? texture(src.map, uv()) : null;
  const alb = (base ? base.rgb.mul(vec3(c.r, c.g, c.b)) : vec3(c.r, c.g, c.b)) as V3;
  const N = normalWorldGeometry.normalize() as V3;
  const nW = (src.normalMap ? normalize(cameraWorldMatrix.mul(vec4(normalMap(texture(src.normalMap, uv())) as unknown as V3, 0)).xyz) : N) as V3;
  const orm = src.roughnessMap ? texture(src.roughnessMap, uv()) : null;
  const rough: F = orm ? (orm.g.mul(src.roughness) as F) : float(src.roughness);
  const metal: F = orm ? (orm.b.mul(src.metalness) as F) : float(src.metalness);
  const ao: F = src.aoMap ? (texture(src.aoMap, uv()).r as F) : float(1);
  const gdl = max(dot(N, ldir), 0.25);
  const detail = mix(float(1), max(dot(nW, ldir), 0).div(gdl).clamp(0, 1.8), 0.75);
  const V = normalize(cameraPosition.sub(positionWorld)) as V3;
  const ndv = max(dot(nW, V), 0);
  const f0 = mix(vec3(0.04), alb, metal);
  const fres = f0.add(vec3(1).sub(f0).mul(pow(float(1).sub(ndv), 5)).mul(float(1).sub(rough)));
  const spec = pmremTexture(env, reflect(V.negate(), nW), rough).rgb.mul(fres).mul(ao).mul(0.7);
  const H = normalize(ldir.add(V));
  const hl = pow(max(dot(nW, H), 0), mix(float(80), float(8), rough)).mul(max(dot(nW, ldir), 0)).mul(float(1).sub(rough).mul(0.9).add(0.05));
  const out = alb.mul(irr).mul(detail).mul(ao).mul(float(1).sub(metal.mul(0.8))).mul(gain).add(spec).add(irr.mul(mix(vec3(0.5), alb.mul(2), metal)).mul(hl));
  m.colorNode = vec4(out, base ? base.a : 1);
  return m;
}

/**
 * Baked decal (wall art, floor stencils): an alpha-mapped canvas texture lit by the bake. Uses the geometry's own UVs.
 * `emit` adds unlit colour on top (backlit signs).
 */
export function decalMaterial(map: THREE.Texture, gain = 1, emit = 0): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const t = texture(map, uv());
  const irr = attribute('color', 'vec3') as V3;
  m.colorNode = vec4(t.rgb.mul(irr.mul(gain).add(emit)), t.a);
  return m;
}

/** Self-lit geometry (LED lines, neon tubes, lamp faces): colour per vertex, HDR, so it blooms and mirrors in paint. */
export function emissiveMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.colorNode = vec4(attribute('color', 'vec3'), 1);
  return m;
}

export interface FloorHandle {
  material: THREE.MeshBasicNodeMaterial;
  /** add to the scene: the mirror plane */
  target: THREE.Object3D;
  /** mirror resolution relative to the canvas (render-target resize: front end only) */
  setResolution(s: number): void;
  /** 0 = no mirror (cheapest preset), 1 = full */
  strength: THREE.UniformNode<'float', number>;
  /** LED ring colour around the turntable (follows the car's underglow / accent) */
  ring: THREE.UniformNode<'color', THREE.Color>;
}

/**
 * The floor: sealed concrete with a REAL mirror image (planar reflection of the room and the car, blurred by the
 * roughness map through the mip chain), a rubber-tiled turntable deck under the car and an LED ring around it.
 * One material, one draw: the deck and the ring are masks on the distance from the centre.
 */
export function floorMaterial(concrete: SurfaceMaps, deck: SurfaceMaps, env: THREE.Texture, radius: number): FloorHandle {
  const m = new THREE.MeshBasicNodeMaterial();
  const P = positionWorld;
  const irr = attribute('color', 'vec3') as V3;
  const r = length(P.xz) as F;
  const onDeck = float(1).sub(smoothstep(radius - 0.012, radius + 0.012, r));
  const stC = P.xz.div(3.2), stD = P.xz.div(1.6);
  // large-scale wear so the 3.2 m concrete tile does not read as a repeat
  const wear = mx_noise_float(P.xz.mul(0.33)).mul(0.5).add(0.5);
  const wear2 = mx_noise_float(P.xz.mul(1.3).add(vec2(7.1, 2.3))).mul(0.5).add(0.5);
  const albC = (texture(concrete.diff, stC).rgb as V3).mul(mix(float(0.62), float(1.0), wear)).mul(vec3(0.74, 0.78, 0.86));
  const albD = (texture(deck.diff, stD).rgb as V3).mul(vec3(0.5, 0.52, 0.56));
  const alb = mix(albC, albD, onDeck) as V3;
  const nC = texture(concrete.nor!, stC).xyz.mul(2).sub(1), nD = texture(deck.nor!, stD).xyz.mul(2).sub(1);
  const n = mix(nC, nD, onDeck);
  const armC = texture(concrete.arm!, stC);
  // roughness: the sealed concrete is glossy where it is worn smooth, duller in the dusty patches; the deck is satin
  const rough = mix(armC.g.mul(mix(float(0.42), float(0.85), wear2)), float(0.2), onDeck).clamp(0.05, 1) as F;
  const ao = mix(armC.r as F, float(1), onDeck);

  const refl = reflector({ resolutionScale: 0.5, generateMipmaps: true, bounces: false });
  refl.target.rotateX(-Math.PI / 2);
  // ripple the mirror with the surface normal: a real floor is never optically flat
  refl.uvNode = refl.uvNode!.add(n.xy.mul(mix(float(0.012), float(0.004), onDeck)));
  const mirror = refl.blur(rough.mul(0.62)).rgb as V3;
  const V = normalize(cameraPosition.sub(P)) as V3;
  const ndv = max(V.y, 0);
  const strength = uniform(1);
  // sealed floor: a clear coat over the concrete - weak head-on, a mirror at grazing angles, killed by roughness
  const fres = mix(float(0.07), float(0.82), pow(float(1).sub(ndv), 2.6)).mul(float(1).sub(rough.mul(0.75)));
  const envFallback = pmremTexture(env, reflect(V.negate(), vec3(0, 1, 0)), rough).rgb as V3;
  const spec = mix(envFallback, mirror, strength).mul(fres);

  // LED ring: a thin line of light let into the floor around the deck
  const ring = uniform(new THREE.Color(0.55, 0.85, 1.0));
  const line = smoothstep(radius + 0.03, radius + 0.055, r).mul(float(1).sub(smoothstep(radius + 0.085, radius + 0.11, r)));
  const halo = float(1).sub(smoothstep(0.0, 0.55, abs(r.sub(radius + 0.07)))).pow(2.5);
  const steel = smoothstep(radius - 0.012, radius + 0.0, r).mul(float(1).sub(smoothstep(radius + 0.11, radius + 0.125, r)));
  const base = mix(alb.mul(irr).mul(ao), vec3(0.08, 0.085, 0.09).mul(irr).mul(2.4), steel.mul(float(1).sub(line)));
  const out = base.mul(float(1).sub(fres.mul(0.6))).add(spec)
    .add(vec3(ring.r, ring.g, ring.b).mul(line.mul(7).add(halo.mul(0.028))));
  m.colorNode = vec4(out, 1);
  return {
    material: m, target: refl.target, strength, ring,
    setResolution(s: number) { (refl as unknown as { reflector: { resolutionScale: number } }).reflector.resolutionScale = s; },
  };
}
