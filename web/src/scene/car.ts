// Car visuals: glTF model, wheels driven by the core's suspension output, headlights, brake lights,
// soft ground contact shadow, and realistic radial spoke motion blur.
import * as THREE from 'three/webgpu';
import { applyPlate } from './plate';
import { float, smoothstep, texture, uniform, uv, vec4 } from 'three/tsl';
import { OUT } from '../physics/core';
import { materialsOf } from './city';
import { assetUrl, loadGLTF } from './loaders';

import type { DamageVisualConfig } from './damage';
import { FINISHES, type Finish } from '../garage';
import { CarCustomizer, installAero, installLivery } from './custom';
import { Driver } from './driver';

export interface CarVisualConfig extends DamageVisualConfig {
  model: string;
  lod_model: string;
  cg_in_model_m: [number, number, number];
  wheel_nodes: { fl: string; fr: string; rl: string; rr: string };
  /** driver's hip point in model space (x = left, y = up, z = forward) and figure scale */
  driver_seat_m?: [number, number, number];
  driver_scale?: number;
  /** opaque cabin shells that would hide the driver (no cockpit is drawn: the driver is) */
  hide_for_driver?: string[];
  /** Model track minus physics track, per side (m): the wheels sit this much further out. */
  wheel_visual_offset_m?: number;
  collision_box: { size_m: [number, number, number]; centre_in_model_m: [number, number, number]; end_lift_m: number; end_lift_start_m: number };
  paint_material: string;
  default_paint: [number, number, number];
  headlights: [number, number, number][];
}

/**
 * Subtle sprayed clear-coat waviness normal map (256x256 tileable fractal value noise).
 * Kept fine so reflections look like mirror-polished factory lacquer rather than pebbled plastic.
 */
let peelTex: THREE.DataTexture | null = null;
function orangePeel() {
  if (peelTex) return peelTex;
  const N = 256, h = new Float32Array(N * N);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let oct = 0, cells = 32, amp = 1; oct < 3; oct++, cells *= 2, amp *= 0.5) {
    const g = new Float32Array(cells * cells).map(rnd);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const fx = (x / N) * cells, fy = (y / N) * cells, x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0, sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const a = g[(y0 % cells) * cells + (x0 % cells)], b = g[(y0 % cells) * cells + ((x0 + 1) % cells)];
      const c = g[((y0 + 1) % cells) * cells + (x0 % cells)], d = g[((y0 + 1) % cells) * cells + ((x0 + 1) % cells)];
      h[y * N + x] += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
    }
  }
  const px = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = h[y * N + ((x + 1) % N)] - h[y * N + ((x + N - 1) % N)];
    const dy = h[((y + 1) % N) * N + x] - h[((y + N - 1) % N) * N + x];
    const nx = -dx * 4.5, ny = -dy * 4.5, l = Math.hypot(nx, ny, 1), i = (y * N + x) * 4;
    px[i] = (nx / l * 0.5 + 0.5) * 255; px[i + 1] = (ny / l * 0.5 + 0.5) * 255; px[i + 2] = (1 / l * 0.5 + 0.5) * 255; px[i + 3] = 255;
  }
  peelTex = new THREE.DataTexture(px, N, N, THREE.RGBAFormat);
  peelTex.wrapS = peelTex.wrapT = THREE.RepeatWrapping;
  peelTex.repeat.set(28, 28);
  peelTex.generateMipmaps = true;
  peelTex.minFilter = THREE.LinearMipmapLinearFilter;
  peelTex.magFilter = THREE.LinearFilter;
  peelTex.anisotropy = 4;
  peelTex.needsUpdate = true;
  return peelTex;
}

/**
 * Fine metallic basecoat micro-flake normal map for cars whose GLB paint has no embedded flake map.
 * Gives metallic/pearl/candy finishes authentic sparkling micro-facets beneath the smooth clear coat.
 */
let flakeTex: THREE.DataTexture | null = null;
function metallicFlake() {
  if (flakeTex) return flakeTex;
  const N = 256, px = new Uint8Array(N * N * 4);
  let seed = 987654321;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  // Tileable 2x2 micro-grain cells so adjacent pixels form crisp tiny metallic platelets
  const G = 128, gx = new Float32Array(G * G), gy = new Float32Array(G * G);
  for (let i = 0; i < G * G; i++) {
    const ang = rnd() * Math.PI * 2, tilt = 0.08 * Math.sqrt(rnd());
    gx[i] = Math.cos(ang) * tilt;
    gy[i] = Math.sin(ang) * tilt;
  }
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const cx = Math.floor((x / N) * G) % G, cy = Math.floor((y / N) * G) % G;
    const nx = gx[cy * G + cx], ny = gy[cy * G + cx], nz = Math.sqrt(Math.max(0.1, 1 - nx * nx - ny * ny));
    const i = (y * N + x) * 4;
    px[i] = (nx * 0.5 + 0.5) * 255;
    px[i + 1] = (ny * 0.5 + 0.5) * 255;
    px[i + 2] = (nz * 0.5 + 0.5) * 255;
    px[i + 3] = 255;
  }
  flakeTex = new THREE.DataTexture(px, N, N, THREE.RGBAFormat);
  flakeTex.wrapS = flakeTex.wrapT = THREE.RepeatWrapping;
  // 56 repeats over a ~4 m body put each platelet at a few tenths of a millimetre - invisible at 2 m, which read as
  // "no flake" in the garage. 24 repeats is a ~1.3 mm platelet, the Heat-scale sparkle you can see standing next to it.
  flakeTex.repeat.set(24, 24);
  flakeTex.generateMipmaps = true;
  flakeTex.minFilter = THREE.LinearMipmapLinearFilter;
  flakeTex.magFilter = THREE.LinearFilter;
  flakeTex.anisotropy = 4;
  flakeTex.needsUpdate = true;
  return flakeTex;
}

/**
 * Soft under-chassis + 4-tire contact ambient-occlusion shadow map (256x256).
 * Grounds every car onto wet asphalt and showroom floors without dynamic shadow-map cost.
 */
let shadowTex: THREE.DataTexture | null = null;
function contactShadowTex() {
  if (shadowTex) return shadowTex;
  const N = 256, px = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    const v = (y / (N - 1)) * 2 - 1; // -1 rear .. +1 front
    for (let x = 0; x < N; x++) {
      const u = (x / (N - 1)) * 2 - 1; // -1 right .. +1 left
      // Rounded-box signed distance for the underbody footprint (u in [-0.70, 0.70], v in [-0.76, 0.76])
      const qx = Math.max(0, Math.abs(u) - 0.56), qy = Math.max(0, Math.abs(v) - 0.62);
      const dist = Math.hypot(qx, qy);
      const bodyAo = Math.max(0, 1 - dist / 0.34);
      const bodySoft = bodyAo * bodyAo * (3 - 2 * bodyAo) * 0.86;
      // Extra concentrated contact patches directly beneath the 4 tires
      let tyreAo = 0;
      for (const tu of [-0.66, 0.66]) {
        for (const tv of [-0.52, 0.50]) {
          const d = Math.hypot((u - tu) / 0.19, (v - tv) / 0.22);
          const w = Math.max(0, 1 - d);
          tyreAo = Math.max(tyreAo, w * w * 0.94);
        }
      }
      const alpha = Math.min(1, Math.max(bodySoft, tyreAo));
      const i = (y * N + x) * 4;
      px[i] = 0; px[i + 1] = 0; px[i + 2] = 0; px[i + 3] = Math.round(alpha * 255);
    }
  }
  shadowTex = new THREE.DataTexture(px, N, N, THREE.RGBAFormat);
  shadowTex.generateMipmaps = true;
  shadowTex.minFilter = THREE.LinearMipmapLinearFilter;
  shadowTex.magFilter = THREE.LinearFilter;
  shadowTex.needsUpdate = true;
  return shadowTex;
}

/**
 * Radial motion-blurred forged-alloy spoke texture (256x256 RGBA) for high-speed wheels.
 * Keeps semi-transparent swept gaps between blurred spoke arcs so brake calipers & rotors remain subtly visible.
 */
let blurSpokeTex: THREE.DataTexture | null = null;
function spokeBlurTex() {
  if (blurSpokeTex) return blurSpokeTex;
  const N = 256, px = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    const dy = (y / (N - 1)) * 2 - 1;
    for (let x = 0; x < N; x++) {
      const dx = (x / (N - 1)) * 2 - 1;
      const r = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx);
      // 5 twin-spoke radial blur harmonics + concentric machined rings
      const s5 = 0.5 + 0.5 * Math.cos(ang * 5);
      const s10 = 0.5 + 0.5 * Math.cos(ang * 10 + 0.4);
      const spokeBand = 0.52 + 0.30 * s5 + 0.18 * s10;
      const ring = 0.88 + 0.12 * Math.sin(r * 38);
      const hub = r < 0.28 ? 0.95 : 0;
      const innerFade = THREE.MathUtils.smoothstep(r, 0.16, 0.26);
      const outerFade = 1 - THREE.MathUtils.smoothstep(r, 0.84, 0.98);
      const alpha = Math.max(hub * (1 - THREE.MathUtils.smoothstep(r, 0.22, 0.30)), innerFade * outerFade * (0.38 + 0.42 * spokeBand));
      const lum = Math.round(THREE.MathUtils.clamp((0.26 + 0.28 * spokeBand) * ring, 0, 1) * 255);
      const i = (y * N + x) * 4;
      px[i] = lum;
      px[i + 1] = Math.min(255, Math.round(lum * 1.02));
      px[i + 2] = Math.min(255, Math.round(lum * 1.06));
      px[i + 3] = Math.round(THREE.MathUtils.clamp(alpha, 0, 1) * 255);
    }
  }
  blurSpokeTex = new THREE.DataTexture(px, N, N, THREE.RGBAFormat);
  blurSpokeTex.colorSpace = THREE.SRGBColorSpace;
  blurSpokeTex.generateMipmaps = true;
  blurSpokeTex.minFilter = THREE.LinearMipmapLinearFilter;
  blurSpokeTex.magFilter = THREE.LinearFilter;
  blurSpokeTex.needsUpdate = true;
  return blurSpokeTex;
}

/** Grounded under-car contact shadow plane (shared by player, AI traffic, and remote cars). */
export function createContactShadow(width = 2.35, length = 4.95, centerZ = -0.05, strengthNode?: THREE.Node<'float'>) {
  const geo = new THREE.PlaneGeometry(width, length);
  geo.rotateX(-Math.PI / 2);
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const tex = texture(contactShadowTex(), uv());
  const op = strengthNode ? tex.a.mul(strengthNode) : tex.a.mul(0.88);
  m.colorNode = vec4(0, 0, 0, 1);
  m.opacityNode = op;
  const mesh = new THREE.Mesh(geo, m);
  mesh.name = 'wheel_contact_shadow'; // 'wheel_' prefix: ignored by DamageVisuals denting
  mesh.position.set(0, 0.015, centerZ);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = -1;
  return mesh;
}

/** Deep-clone a cached GLTF scene along with its material table (preserving intra-model material sharing). */
function cloneCarScene(src: THREE.Object3D): THREE.Object3D {
  const root = src.clone(true);
  const clonedMats = new Map<THREE.Material, THREE.Material>();
  const mapMat = (m: THREE.Material) => {
    let c = clonedMats.get(m);
    if (!c) { c = m.clone(); clonedMats.set(m, c); }
    return c;
  };
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(mapMat) : mapMat(mesh.material);
  });
  return root;
}

const Y = new THREE.Vector3(0, 1, 0), X = new THREE.Vector3(1, 0, 0), ONE = new THREE.Vector3(1, 1, 1);

/**
 * Game-side material setup shared by the player, AI and remote cars:
 *  - paint: dual-layer automotive clear coat + metallic micro-flake normal + fine lacquer orange peel;
 *  - glass: smoked automotive laminated physical glass with sharp Fresnel clear-coat sky/neon reflections;
 *  - carbon, mirrors, rims, rotors, and tyres tuned for physically plausible night/studio response.
 */
export function setupCarMaterials(model: THREE.Object3D, cfg: CarVisualConfig, paint: THREE.ColorRepresentation | null, shadows = true) {
  let paintMat: THREE.MeshPhysicalMaterial | null = null;
  let glassMat: THREE.MeshPhysicalMaterial | null = null;
  let carbonMat: THREE.MeshPhysicalMaterial | null = null;
  const color = paint === null ? new THREE.Color().setRGB(...cfg.default_paint, THREE.SRGBColorSpace) : new THREE.Color(paint);
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || m.name === 'wheel_contact_shadow') return;
    m.castShadow = true;
    m.receiveShadow = shadows;
    const mats = materialsOf(m);
    mats.forEach((mat, i) => {
      const assign = (next: THREE.Material) => {
        if (Array.isArray(m.material)) m.material[i] = next; else m.material = next;
      };
      if (mat.name === cfg.paint_material) {
        if (!paintMat) {
          const src = mat as unknown as THREE.MeshPhysicalMaterial;
          paintMat = src.isMeshPhysicalMaterial ? src.clone() : new THREE.MeshPhysicalMaterial({ name: mat.name, metalness: 0.45, roughness: 0.22 });
          if (!paintMat.normalMap) {
            paintMat.normalMap = metallicFlake();
            paintMat.normalScale.set(0.05, 0.05);
          }
          paintMat.clearcoat = 1;
          paintMat.clearcoatRoughness = 0.018;   // Heat: a hard, near-mirror coat highlight, not a satin sheen
          paintMat.clearcoatNormalMap = orangePeel();
          // The orange peel used to be 0.055, as strong as the flake normal in the base coat - the two competed and
          // the clear coat's highlight broke up into a blur. Keep a hint of peel (real paint has it, it is what stops
          // the reflection looking like a CGI gradient) and let the flake live in the base coat only.
          paintMat.clearcoatNormalScale.set(0.018, 0.018);
          paintMat.ior = 1.52;
          paintMat.specularIntensity = 1.08;
          paintMat.iridescenceIOR = 1.7;
          paintMat.iridescenceThicknessRange = [200, 520];
          paintMat.envMapIntensity = 1.45;
          paintMat.color.copy(color);
          paintMat.userData.livery = installLivery(paintMat);   // garage liveries: uniforms, no recompiles
        }
        assign(paintMat);
        return;
      }
      if (mat.name === 'glass') {
        if (!glassMat) {
          glassMat = new THREE.MeshPhysicalMaterial({
            name: 'glass',
            color: new THREE.Color(0x06080c),
            transparent: true,
            opacity: 0.64,
            roughness: 0.015,
            metalness: 0.04,
            ior: 1.52,
            specularIntensity: 1.0,
            clearcoat: 1.0,
            clearcoatRoughness: 0.01,
            envMapIntensity: 1.9,
            depthWrite: false,
          });
        }
        assign(glassMat);
        return;
      }
      if (mat.name === 'carbon') {
        if (!carbonMat) {
          const std = mat as THREE.MeshStandardMaterial;
          carbonMat = new THREE.MeshPhysicalMaterial({
            name: 'carbon',
            color: std.color ? std.color.clone() : new THREE.Color(0x101215),
            map: std.map ?? null,
            normalMap: std.normalMap ?? null,
            normalScale: std.normalScale ? std.normalScale.clone() : new THREE.Vector2(0.4, 0.4),
            roughnessMap: std.roughnessMap ?? null,
            aoMap: std.aoMap ?? null,
            metalness: 0.24,
            roughness: 0.28,
            clearcoat: 0.82,
            clearcoatRoughness: 0.06,
            envMapIntensity: 1.35,
          });
          carbonMat.userData.aero = installAero(carbonMat);      // garage aero finishes
        }
        assign(carbonMat);
        return;
      }
      if (/^mirror_glass$|^mirror\./i.test(mat.name)) {
        const std = mat as THREE.MeshStandardMaterial;
        std.color?.setHex(0xf2f6ff);
        std.metalness = 1.0;
        std.roughness = 0.015;
        std.envMapIntensity = 1.8;
      } else if (/^tyre/i.test(mat.name)) {
        const std = mat as THREE.MeshStandardMaterial;
        if (std.color && std.color.r < 0.025) std.color.setRGB(0.036, 0.038, 0.042);
        std.metalness = 0.0;
        std.roughness = Math.min(Math.max(std.roughness ?? 0.78, 0.68), 0.82);
      } else if (/^rim/i.test(mat.name)) {
        const std = mat as THREE.MeshStandardMaterial;
        std.metalness = Math.max(std.metalness ?? 0.9, 0.88);
        std.roughness = Math.min(std.roughness ?? 0.22, 0.24);
        std.envMapIntensity = 1.5;
      } else if (mat.name === 'disc') {
        const std = mat as THREE.MeshStandardMaterial;
        std.metalness = 0.92;
        std.roughness = 0.26;
        std.envMapIntensity = 1.35;
      }
      if (mat.name === 'light_beam') m.visible = false;   // fake beams: replaced by real spot lights
    });
  });
  model.userData.carMats = { paint: paintMat, glass: glassMat, carbon: carbonMat };
  return paintMat as THREE.MeshPhysicalMaterial | null;
}

export class CarVisual {
  readonly root = new THREE.Group();          // placed at the physics body (CG)
  private wheels: { node: THREE.Object3D; rest: THREE.Quaternion; restPos: THREE.Vector3; radius: number; caliper?: THREE.Object3D; caliperRest?: THREE.Quaternion; spin: number }[] = [];
  /** seconds between DRAWN frames (main.ts sets it from the cap): decides when the spokes alias and the blur disc takes over */
  renderDt = 1 / 60;
  private blurMat: THREE.MeshStandardNodeMaterial | null = null;
  /** blur disc strength (0..1): a shader uniform, because a plain material.opacity change is not picked up after the first compile */
  private blurOp = uniform(0);
  private shadowOp = uniform(0.92);
  private contactShadow: THREE.Mesh;
  private tailMats: THREE.MeshStandardMaterial[] = [];
  private lastUpdate = 0;
  /** headlight strength factor: 1 driving, ~0.015 in the showroom (title/garage), where bright nose spots otherwise bloom into a fireball */
  dim = 1;
  private qa = new THREE.Quaternion();
  private qb = new THREE.Quaternion();
  private tmpCentre = new THREE.Vector3();
  private physInv = new THREE.Matrix4();
  readonly cg: THREE.Vector3;
  headlights: THREE.SpotLight[] = [];
  readonly headlightIntensity = 900;
  /** Headlight switch (L). Off = intensity 0, never visible = false (that recompiles every material). */
  lightsOn = true;
  lightsBroken = false;
  readonly velocity = new THREE.Vector3();   // m/s, world (for debris)
  /** The car's own clone of the paint material (garage colour + finish). */
  readonly paint: THREE.MeshPhysicalMaterial | null;
  /** garage parts and colours (custom.ts) and the driver in the seat (driver.ts) */
  readonly custom: CarCustomizer;
  readonly driver: Driver;

  private constructor(readonly cfg: CarVisualConfig, readonly model: THREE.Object3D, shared?: THREE.SpotLight[]) {
    this.cg = new THREE.Vector3(...cfg.cg_in_model_m);
    model.position.copy(this.cg).negate();
    this.root.add(model);
    const n = cfg.wheel_nodes;
    for (const name of [n.fl, n.fr, n.rl, n.rr]) {
      const node = model.getObjectByName(name)!;
      const caliper = model.getObjectByName(name.replace('wheel', 'caliper'));
      const radius = this.addBlurDisc(node);
      this.wheels.push({
        node,
        rest: node.quaternion.clone(),
        restPos: node.position.clone(),
        radius,
        caliper,
        caliperRest: caliper?.quaternion.clone(),
        spin: 0,
      });
    }
    this.paint = setupCarMaterials(model, cfg, null);
    // Collect rear taillight materials so braking dynamically boosts tail glow
    const seenTail = new Set<THREE.Material>();
    for (const nm of cfg.rear_lights ?? []) {
      model.getObjectByName(nm)?.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        for (const mat of materialsOf(m) as THREE.MeshStandardMaterial[]) {
          if (mat.emissive && (mat.emissive.r > 0.05 || /tail/i.test(mat.name)) && !seenTail.has(mat)) {
            seenTail.add(mat);
            this.tailMats.push(mat);
          }
        }
      });
    }
    // Soft ground contact shadow beneath chassis + 4 tires
    const cb = cfg.collision_box;
    this.contactShadow = createContactShadow(cb.size_m[0] * 1.24, cb.size_m[2] * 1.18, cb.centre_in_model_m[2], this.shadowOp as unknown as THREE.Node<'float'>);
    model.add(this.contactShadow);

    // The player's own car never needs to be in its headlight shadow map (the spots sit at its nose and shine away
    // from it): skipping its triangles + dent shader saves the biggest part of every shadow-update frame.
    model.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = false; });

    for (const [i, hp] of cfg.headlights.entries()) {
      const s = shared?.[i] ?? new THREE.SpotLight(0xfff3e0, this.headlightIntensity, 70, 0.42, 0.45, 2);
      s.position.set(hp[0], hp[1], hp[2]).sub(this.cg);
      s.target.position.copy(s.position).add(new THREE.Vector3(0, -1.1, 14));
      if (!shared) {
        s.castShadow = i === 0;
        s.shadow.mapSize.set(1024, 1024);
        s.shadow.camera.near = 0.3;
        s.shadow.bias = -0.0004;
      }
      this.root.add(s, s.target);
      this.headlights.push(s);
    }
    const mats = model.userData.carMats as { paint: THREE.MeshPhysicalMaterial | null; glass: THREE.MeshPhysicalMaterial | null; carbon: THREE.MeshPhysicalMaterial | null };
    this.custom = new CarCustomizer(model, mats.paint, mats.glass, mats.carbon, this.headlights);
    this.driver = new Driver(new THREE.Vector3(...(cfg.driver_seat_m ?? [0.36, 0.25, -0.3])));
    this.driver.root.scale.setScalar(cfg.driver_scale ?? 0.93);
    model.add(this.driver.root);
    for (const nm of cfg.hide_for_driver ?? []) { const o = model.getObjectByName(nm); if (o) o.visible = false; }
  }

  /**
   * Radial spoke motion-blur ring placed slightly inboard of the outer rim lip so the 3D tyre sidewall,
   * outer rim lip, and inner brake caliper/rotor stay sharp while alloy spokes blur naturally at speed.
   * Returns measured outer tyre radius (m).
   */
  private addBlurDisc(node: THREE.Object3D): number {
    const rimBox = new THREE.Box3(), all = new THREE.Box3(), tmp = new THREE.Box3();
    node.traverse((c) => {
      const m = c as THREE.Mesh;
      if (!m.isMesh || m.name.startsWith('wheel_blur_')) return;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      m.updateMatrix();
      tmp.copy(m.geometry.boundingBox!).applyMatrix4(m.matrix);
      all.union(tmp);
      if (/rim/i.test(m.name)) rimBox.union(tmp);
    });
    const box = rimBox.isEmpty() ? all : rimBox;
    const tyreRadius = all.isEmpty() ? 0.335 : Math.max(all.max.y - all.min.y, all.max.z - all.min.z) / 2;
    if (box.isEmpty()) return tyreRadius;
    const rimRadius = Math.min(tyreRadius * 0.76, Math.max(box.max.y - box.min.y, box.max.z - box.min.z) / 2 * 0.92);
    const side = node.position.x >= 0 ? 1 : -1;
    // Place recessed 14 mm inside the outer rim lip so center-lock nuts & rim lips stay crisp in 3D
    const outerX = side > 0 ? box.max.x : box.min.x;
    const x = outerX - side * 0.014;
    if (!this.blurMat) {
      const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.24, metalness: 0.88, transparent: true, depthWrite: false, side: THREE.DoubleSide });
      const st = texture(spokeBlurTex(), uv());
      m.colorNode = vec4(st.rgb, 1);
      m.opacityNode = st.a.mul(this.blurOp);
      this.blurMat = m;
    }
    const ring = new THREE.Mesh(new THREE.RingGeometry(rimRadius * 0.16, rimRadius, 48, 1), this.blurMat);
    ring.name = `wheel_blur_${node.name}`;   // 'wheel_' prefix: never dented
    ring.rotation.y = side * Math.PI / 2;
    ring.position.set(x, (box.max.y + box.min.y) / 2, (box.max.z + box.min.z) / 2);
    node.add(ring);
    return tyreRadius;
  }

  /**
   * Paint for a finish. Clearcoat is the layer that makes paint read as paint instead of plastic (Metalness-only paint
   * looks like coloured plastic); the flake normal is what gives the metallic sparkle under a key light.
   *
   * Only a define change may set `needsUpdate`: colour, metalness, roughness, clearcoat and the flake normal scale are
   * uniforms, and marking the material dirty for those re-compiled the shader every time the garage changed a finish
   * (a visible hitch while browsing paint).
   */
  setPaint(hex: string, finish: Finish) {
    const m = this.paint;
    if (!m) return;
    const f = FINISHES[finish];
    const wasIri = (m.iridescence ?? 0) > 0;
    m.color.set(hex);
    m.clearcoat = f.clearcoat;
    m.clearcoatRoughness = f.ccRough;   // the coat's own highlight: crisp on candy, a sheen on satin
    m.roughness = f.roughness;
    m.metalness = f.metalness;
    m.iridescence = f.iridescence ?? 0;
    m.envMapIntensity = f.env;          // how much of the city mirrors in the coat (probe per frame)
    // NFS Heat read: metallic and candy flake read as glitter standing next to the car, pearl shimmers, gloss has a
    // quiet grain, satin/matte barely any. normalScale is a uniform, so this costs no recompile.
    const flake = finish === 'metallic' ? 0.20 : finish === 'candy' ? 0.24 : finish === 'pearl' ? 0.14 : finish === 'satin' ? 0.05 : finish === 'matte' ? 0 : 0.08;
    m.normalScale.set(flake, flake);
    if (wasIri !== ((m.iridescence ?? 0) > 0)) m.needsUpdate = true;
  }

  /** Model-space height of the tyres' lowest point: the garage sets the model down by this much onto its floor. */
  get groundY() { return this.contactShadow.position.y - 0.014; }

  /** Spot intensity from the switch and the damage state. */
  /** The driver's name on the number plate (plate.ts). */
  setPlate(name: string) { applyPlate(this.model, name); }

  applyHeadlights() {
    for (const s of this.headlights) s.intensity = this.lightsOn && !this.lightsBroken ? this.headlightIntensity * this.dim : 0;
  }

  /** Wheel hub centres and outer tyre radii in car MODEL space (used by Dents to keep crumpled fenders out of tyres). */
  wheelWells(): { pos: THREE.Vector3; radius: number }[] {
    const off = this.cfg.wheel_visual_offset_m ?? 0;
    return this.wheels.map((w) => ({
      pos: new THREE.Vector3(w.restPos.x + Math.sign(w.restPos.x) * off, w.restPos.y, w.restPos.z),
      radius: w.radius,
    }));
  }

  static async load(cfg: CarVisualConfig, sharedHeadlights?: THREE.SpotLight[]): Promise<CarVisual> {
    const gltf = await loadGLTF(assetUrl(cfg.model));
    return new CarVisual(cfg, cloneCarScene(gltf.scene), sharedHeadlights);
  }

  update(pos: THREE.Vector3, quat: THREE.Quaternion, out: Float64Array, physPos = pos, physQuat = quat) {
    this.root.position.copy(pos);
    this.root.quaternion.copy(quat);
    this.root.updateMatrixWorld();
    this.custom.sync(pos, quat);
    const inv = this.physInv.compose(physPos, physQuat, ONE).invert();
    const off = this.cfg.wheel_visual_offset_m ?? 0;
    const tNow = performance.now(), dtS = Math.min(0.05, Math.max(0.001, (tNow - this.lastUpdate) / 1000));
    const first = this.lastUpdate === 0;
    this.lastUpdate = tNow;
    this.driver.update(out[OUT.steer] || 0, out[OUT.steer + 2] || 0, dtS);   // steering applied; body lateral accel (core y = left)

    // Detect uninitialised `out` (all wheel world centres at origin while car isn't at origin)
    const outValid = (out[OUT.wheel(0)] !== 0 || out[OUT.wheel(0) + 1] !== 0 || out[OUT.wheel(0) + 2] !== 0
      || out[OUT.wheel(1)] !== 0 || out[OUT.wheel(1) + 2] !== 0);

    let spinFrame = 0;
    let wheelMinBottom = Infinity;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i], o = OUT.wheel(i);
      const side = w.restPos.x >= 0 ? 1 : -1;
      let centre: THREE.Vector3;
      if (outValid) {
        centre = this.tmpCentre.set(out[o], out[o + 1], out[o + 2]).applyMatrix4(inv).add(this.cg);
        centre.x += Math.sign(centre.x || side) * off;
        // Enforce physical wheel-arch envelope so crash wall overlaps or extreme impulses NEVER pop wheels out of arches
        centre.x = THREE.MathUtils.clamp(centre.x, side > 0 ? w.restPos.x - 0.06 : w.restPos.x - 0.06, side > 0 ? w.restPos.x + 0.06 : w.restPos.x + 0.06);
        centre.y = THREE.MathUtils.clamp(centre.y, w.restPos.y - 0.075, w.restPos.y + 0.062);
        centre.z = THREE.MathUtils.clamp(centre.z, w.restPos.z - 0.032, w.restPos.z + 0.032);
      } else {
        centre = this.tmpCentre.copy(w.restPos);
      }
      wheelMinBottom = Math.min(wheelMinBottom, centre.y - w.radius);

      const steer = outValid ? THREE.MathUtils.clamp(out[o + 3], -0.62, 0.62) : 0;
      const omega = outValid ? out[o + 10] : 0;   // exact wheel angular velocity (rad/s), immune to 2*pi fmod wraps
      if (first || (Math.abs(omega) < 0.02 && Math.abs(out[o + 4]) < 1e-4)) {
        w.spin = outValid ? out[o + 4] : 0;
      } else {
        w.spin = (w.spin + omega * dtS) % (Math.PI * 2);
      }
      spinFrame = Math.max(spinFrame, Math.abs(omega) * this.renderDt);

      this.qa.setFromAxisAngle(Y, steer);
      this.qb.setFromAxisAngle(X, w.spin);
      w.node.position.copy(centre);
      w.node.quaternion.copy(this.qa).multiply(this.qb).multiply(w.rest);
      if (w.caliper) {
        w.caliper.position.copy(centre);
        w.caliper.quaternion.copy(this.qa);
        if (w.caliperRest) w.caliper.quaternion.multiply(w.caliperRest);
      }
    }

    // Keep soft contact shadow planted right on the road surface beneath the tyres (fading smoothly if airborne)
    if (Number.isFinite(wheelMinBottom)) {
      this.contactShadow.position.y = wheelMinBottom + 0.014;
      const clearance = Math.max(0, wheelMinBottom);
      this.shadowOp.value = 0.92 * (1 - THREE.MathUtils.smoothstep(clearance, 0.04, 0.35));
    }

    // Dynamic brake light response (running tail glow -> crisp HDR crimson under braking)
    if (this.tailMats.length && !this.lightsBroken) {
      const braking = this.dim > 0.5 && out[OUT.brake] > 0.05 ? THREE.MathUtils.clamp(out[OUT.brake], 0, 1) : 0;
      const baseGlow = this.lightsOn ? (this.dim > 0.5 ? 1.85 : 1.15) : 0.08;
      const targetGlow = baseGlow + braking * 7.5;
      for (const tm of this.tailMats) tm.emissiveIntensity = targetGlow;
    }

    if (this.blurMat) {
      const target = 0.88 * THREE.MathUtils.smoothstep(spinFrame, 0.42, 1.35);
      this.blurOp.value += (target - this.blurOp.value) * 0.25;
    }
  }
}
