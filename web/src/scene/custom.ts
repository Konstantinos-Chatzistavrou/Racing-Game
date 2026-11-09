// Visual customisation, part by part (the garage's Paint / Aero / Wheels / Lights / Glass & exhaust tabs).
// Rules that keep it smooth: everything a player can change is a UNIFORM (colour, roughness, a style index) or an
// object's visibility, never a material swap or a new shader, so changing a part never compiles a pipeline. The few
// new meshes (procedural wings, underglow) are built once per car, hidden until chosen.
//
// Liveries: the models have no paint UV layout, so stripes are drawn in the car's own space (model space, x = left,
// y = up, z = forward) from the world position and a per-car inverse matrix (updated every frame by syncLivery).
import * as THREE from 'three/webgpu';
import { Fn, abs, float, materialColor, mix, positionWorld, smoothstep, texture, uniform, uv, vec3, vec4 } from 'three/tsl';
/** a colour uniform as an rgb node (the typings keep 'color' and 'vec3' apart; the shader does not) */
const rgb = (u: THREE.UniformNode<'color', THREE.Color>) => u as unknown as THREE.Node<'vec3'>;

import { AERO_FINISHES, HEAD_TINTS, RIM_FINISHES, WINGS, cleanCustom, defaultCustom, type AeroFinish, type Custom, type HeadTint, type RimFinish, type WingKind } from '../custom-data';
export { AERO_FINISHES, GLOW_COLOURS, HEAD_TINTS, LIVERIES, PART_COLOURS, RIM_FINISHES, WINGS, cleanCustom, defaultCustom } from '../custom-data';
export type { AeroFinish, Custom, HeadTint, RimFinish, WingKind } from '../custom-data';

// ---- shader nodes installed once on a car's paint / carbon material (setupCarMaterials) -------------------------------
export interface LiveryUniforms {
  style: THREE.UniformNode<'float', number>; color: THREE.UniformNode<'color', THREE.Color>;
  inv: THREE.UniformNode<'mat4', THREE.Matrix4>; bottom: THREE.UniformNode<'float', number>; top: THREE.UniformNode<'float', number>;
  /** underglow: the colour and how much of it the sills pick up (uniforms: no light, no recompile) */
  glow: THREE.UniformNode<'color', THREE.Color>; glowAmt: THREE.UniformNode<'float', number>;
}
/** Paint: base colour (material.color, set by the garage) with a livery mask in model space. */
export function installLivery(paint: THREE.MeshPhysicalMaterial): LiveryUniforms {
  const u: LiveryUniforms = {
    style: uniform(0), color: uniform(new THREE.Color(1, 1, 1)), inv: uniform(new THREE.Matrix4()), bottom: uniform(0.15), top: uniform(1.25),
    glow: uniform(new THREE.Color(0x000000)), glowAmt: uniform(0),
  };
  const mask = Fn(() => {
    const p = u.inv.mul(vec4(positionWorld, 1)).xyz;
    const ax = abs(p.x), aa = float(0.006);
    const h = p.y.sub(u.bottom).div(u.top.sub(u.bottom));
    const band = (x: THREE.Node<'float'>, a: number, b: number) => smoothstep(a - 0.006, a + 0.006, x).mul(float(1).sub(smoothstep(b - 0.006, b + 0.006, x)));
    const twin = band(ax, 0.07, 0.2);
    const wide = float(1).sub(smoothstep(float(0.24).sub(aa), float(0.24).add(aa), ax));
    const side = smoothstep(0.62, 0.7, ax).mul(band(h, 0.36, 0.45));
    const two = float(1).sub(smoothstep(0.405, 0.415, h));
    const is = (k: number) => float(1).sub(smoothstep(0.4, 0.6, abs(u.style.sub(k))));
    return twin.mul(is(1)).add(wide.mul(is(2))).add(side.mul(is(3))).add(two.mul(is(4))).clamp(0, 1);
  })();
  paint.colorNode = mix(materialColor, rgb(u.color), mask);
  // Underground: the underglow washes the sills and the underside of the body. Emissive at the bottom of the model,
  // driven by two uniforms, so a colour change (or turning it off) is a uniform write - no light, no recompile.
  const hLow = u.inv.mul(vec4(positionWorld, 1)).xyz.y.sub(u.bottom).div(u.top.sub(u.bottom));
  const under = float(1).sub(smoothstep(0.02, 0.2, hLow));
  paint.emissiveNode = rgb(u.glow).mul(u.glowAmt.mul(under).mul(0.5));
  return u;
}
export interface AeroUniforms { flat: THREE.UniformNode<'float', number>; color: THREE.UniformNode<'color', THREE.Color>; rough: THREE.UniformNode<'float', number> }
/** Carbon parts: the weave, or a flat colour (gloss / matte black, body colour). */
export function installAero(carbon: THREE.MeshPhysicalMaterial): AeroUniforms {
  const u: AeroUniforms = { flat: uniform(0), color: uniform(new THREE.Color(0x0b0c0e)), rough: uniform(0.28) };
  const weave = carbon.map ? texture(carbon.map, uv()).rgb.mul(materialColor) : materialColor;
  carbon.colorNode = mix(weave, rgb(u.color), u.flat);
  carbon.roughnessNode = u.rough;
  return u;
}

// ---- per car: parts, colours, lights ----------------------------------------------------------------------------------
type Std = THREE.MeshStandardMaterial;
const RIM: Record<RimFinish, [number, number]> = { chrome: [1, 0.05], gloss: [0.55, 0.18], satin: [0.7, 0.38], matte: [0.35, 0.7] };
const HEAD: Record<HeadTint, number> = { white: 0xfff3e0, ice: 0xd8e8ff, yellow: 0xffd98a };
const ONE = new THREE.Vector3(1, 1, 1);

export class CarCustomizer {
  private rim: Std[] = [];
  private caliper: Std[] = [];
  private exhaust: Std[] = [];
  private lens: Std[] = [];
  private tail: Std[] = [];
  private tailBase = new Map<Std, THREE.Color>();
  private lensBase = new Map<Std, number>();
  private m4 = new THREE.Matrix4();
  private stockWing: THREE.Object3D[] = [];
  private wings: Partial<Record<WingKind, THREE.Object3D>> = {};
  private glow: THREE.Mesh;
  /** the pool's real size: the warm-up trick scales optional parts to ~0 and restores 1, which is not the pool's size */
  private glowScale = new THREE.Vector3(1, 1, 1);
  private glowColor = uniform(new THREE.Color(0xff2d55));
  /** Underglow look (all uniforms, so it tunes without a rebuild). ?glow=strength:3.4,outer:0.95,inner:0.16,power:1.6 */
  private glowStrength = uniform(3.2);
  private glowInner = uniform(0.16);
  private glowOuter = uniform(0.9);
  private glowPower = uniform(1.6);
  private box = new THREE.Box3();
  private aeroMat: THREE.MeshPhysicalMaterial;
  current = defaultCustom();
  /** frames left in which the optional parts are drawn at ~zero size (their shaders compile now, behind the loading
   *  screen, not as a hitch the first time the player picks one) */
  private warm = 3;

  constructor(private model: THREE.Object3D, private paint: THREE.MeshPhysicalMaterial | null, private glass: THREE.MeshPhysicalMaterial | null,
              carbon: THREE.MeshPhysicalMaterial | null, private headlights: THREE.SpotLight[] = []) {
    model.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(model.matrixWorld).invert(), tmp = new THREE.Box3();
    // own copies of the shared (cached glTF) materials this car recolours, so another car with the same model keeps its own
    const own = new Map<THREE.Material, Std>();
    const mine = (m: THREE.Mesh, i: number, mat: THREE.Material, list: Std[]) => {
      let c = own.get(mat);
      if (!c) { c = (mat as Std).clone(); own.set(mat, c); list.push(c); }
      if (Array.isArray(m.material)) m.material[i] = c; else m.material = c;
      return c;
    };
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      if (m.geometry && !m.name.startsWith('wheel_contact')) {
        if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
        tmp.copy(m.geometry.boundingBox!).applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
        if (!/^beam|shadow|blur/.test(m.name)) this.box.union(tmp);
      }
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      mats.forEach((mat, i) => {
        const n = mat.name ?? '';
        if (/^rim/i.test(n)) mine(m, i, mat, this.rim);
        else if (n === 'caliper') mine(m, i, mat, this.caliper);
        else if (/exhaust_chrome/.test(n) || (/exhaust_tips/.test(m.name) && n === 'chrome')) mine(m, i, mat, this.exhaust);
        else if (/^light_head$|^headlight_lens$/.test(n) || /^drl_/.test(m.name)) { const c = mine(m, i, mat, this.lens); if (!this.lensBase.has(c)) this.lensBase.set(c, c.emissive ? Math.max(c.emissive.r, c.emissive.g, c.emissive.b) : 0); }
        else if (/^light_tail$|^taillight$|^tail_lens$/.test(n)) { const c = mine(m, i, mat, this.tail); if (!this.tailBase.has(c)) this.tailBase.set(c, c.color.clone()); }
      });
    });
    let w = model.getObjectByName('wing') ?? model.getObjectByName('wing_assembly');
    if (w?.name === 'wing_assembly' && w.parent && w.parent !== model && w.parent.name === 'wing') w = w.parent;
    if (w) this.stockWing.push(w);
    // procedural wings, built against the stock wing's box (or the tail of the car)
    const wb = new THREE.Box3();
    if (w) { w.updateMatrixWorld(true); w.traverse((o) => { const mm = o as THREE.Mesh; if (mm.isMesh) { tmp.copy(mm.geometry.boundingBox ?? new THREE.Box3()).applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, mm.matrixWorld)); wb.union(tmp); } }); }
    if (wb.isEmpty()) wb.set(new THREE.Vector3(-0.8, this.box.max.y - 0.25, this.box.min.z + 0.1), new THREE.Vector3(0.8, this.box.max.y - 0.15, this.box.min.z + 0.35));
    this.aeroMat = carbon ?? new THREE.MeshPhysicalMaterial({ color: 0x101215, roughness: 0.3, metalness: 0.2, clearcoat: 0.8, name: 'carbon' });
    this.wings.ducktail = this.makeDucktail(wb);
    this.wings.gt = this.makeGtWing(wb);
    for (const k of ['ducktail', 'gt'] as WingKind[]) model.add(this.wings[k]!);
    // underglow: a soft additive pool on the ground under the car (no light: adding lights recompiles everything).
    // Underground reads as a bright core about a car wide with a fast falloff, so the plane is generous (the geometry
    // is built once) and the VISIBLE pool is shaped by the falloff uniforms: ?glow=outer:0.95 widens it, inner tightens
    // the core, strength and power set the punch. Tuning never touches geometry.
    for (const kv of (new URLSearchParams(location.search).get('glow') ?? '').split(',')) {
      const [k, v] = kv.split(':'); const n = Number(v);
      if (!Number.isFinite(n)) continue;
      if (k === 'strength') this.glowStrength.value = n;
      else if (k === 'inner') this.glowInner.value = n;
      else if (k === 'outer') this.glowOuter.value = n;
      else if (k === 'power') this.glowPower.value = n;
    }
    const gm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    const d = uv().sub(0.5).mul(2);
    const fall = float(1).sub(smoothstep(this.glowInner, this.glowOuter, d.length())).pow(this.glowPower);
    gm.colorNode = vec4(rgb(this.glowColor).mul(fall.mul(this.glowStrength)), fall);
    const sx = this.box.max.x - this.box.min.x, sz = this.box.max.z - this.box.min.z;
    this.glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), gm);
    this.glow.scale.set(sx * 3.0, 1, sz * 2.2);   // the falloff uniforms decide how much of that is lit
    this.glowScale.copy(this.glow.scale);
    this.glow.rotation.x = -Math.PI / 2;
    this.glow.position.set((this.box.max.x + this.box.min.x) / 2, this.box.min.y + 0.02, (this.box.max.z + this.box.min.z) / 2);
    this.glow.name = 'wheel_underglow';   // 'wheel_' prefix: never dented
    this.glow.renderOrder = 1;
    model.add(this.glow);
    for (const o of this.optional()) { o.visible = true; o.scale.setScalar(1e-4); }
    const lu = this.paint?.userData.livery as LiveryUniforms | undefined;
    if (lu) { lu.bottom.value = this.box.min.y + 0.1; lu.top.value = this.box.max.y; }
  }

  private makeDucktail(wb: THREE.Box3) {
    const w = (wb.max.x - wb.min.x) * 0.92, s = new THREE.Shape();
    s.moveTo(0, 0); s.lineTo(0.16, 0.0); s.lineTo(0.2, 0.065); s.lineTo(0.02, 0.025); s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: w, bevelEnabled: false });
    g.translate(0, 0, -w / 2); g.rotateY(Math.PI / 2);
    const mesh = new THREE.Mesh(g, this.paint ?? this.aeroMat);
    mesh.name = 'wing_ducktail';
    mesh.position.set((wb.max.x + wb.min.x) / 2, wb.min.y - 0.02, (wb.max.z + wb.min.z) / 2 + 0.05);
    mesh.rotation.y = Math.PI;
    return mesh;
  }

  private makeGtWing(wb: THREE.Box3) {
    const grp = new THREE.Group();
    grp.name = 'wing_gt';
    const span = Math.min(1.85, (this.box.max.x - this.box.min.x) * 0.98), chord = 0.3;
    // blade: a cambered airfoil section extruded along the span
    const s = new THREE.Shape();
    s.moveTo(0, 0); s.bezierCurveTo(0.06, 0.05, 0.2, 0.05, chord, 0.012); s.lineTo(chord, -0.004); s.bezierCurveTo(0.2, 0.012, 0.06, 0.004, 0, 0);
    const blade = new THREE.Mesh(new THREE.ExtrudeGeometry(s, { depth: span, bevelEnabled: false, curveSegments: 6 }), this.aeroMat);
    blade.geometry.translate(-chord / 2, 0, -span / 2); blade.geometry.rotateY(Math.PI / 2);
    blade.rotation.x = -0.12;
    const y = wb.max.y + 0.16, z = (wb.max.z + wb.min.z) / 2 - 0.08;
    blade.position.set(0, y, z);
    grp.add(blade);
    // endplates: a slim trapezoid under each blade tip
    const ps = new THREE.Shape();
    ps.moveTo(-chord / 2 - 0.03, 0.03); ps.lineTo(chord / 2 + 0.04, 0.04); ps.lineTo(chord / 2 + 0.01, -0.09); ps.lineTo(-chord / 2 + 0.03, -0.07); ps.closePath();
    const plate = new THREE.ExtrudeGeometry(ps, { depth: 0.01, bevelEnabled: false });
    plate.translate(0, 0, -0.005); plate.rotateY(Math.PI / 2);
    for (const sx of [-1, 1]) {
      const p = new THREE.Mesh(plate, this.aeroMat);
      p.position.set(sx * span / 2, y, z);
      grp.add(p);
      const st = new THREE.Mesh(new THREE.BoxGeometry(0.018, y - wb.min.y + 0.02, 0.09), this.aeroMat);
      st.position.set(sx * span * 0.3, (y + wb.min.y) / 2, z + 0.02);
      st.rotation.x = 0.1;
      grp.add(st);
    }
    return grp;
  }

  /** Apply a full set of choices (cheap: uniforms and visibility only). paintHex: the body colour (aero 'body'). */
  apply(c: Custom, paintHex?: string) {
    this.current = c;
    const lu = this.paint?.userData.livery as LiveryUniforms | undefined;
    if (lu) { lu.style.value = c.livery; lu.color.value.set(c.liveryColor); }
    const au = this.aeroMat.userData.aero as AeroUniforms | undefined;
    if (au) {
      au.flat.value = c.aero === 'carbon' ? 0 : 1;
      au.color.value.set(c.aero === 'body' ? paintHex ?? '#888888' : '#0b0c0e');
      au.rough.value = c.aero === 'matte' ? 0.72 : c.aero === 'carbon' ? 0.28 : 0.14;
    }
    for (const w of this.stockWing) w.visible = c.wing === 'stock';
    this.showOptional();
    const [met, rough] = RIM[c.rimFinish];
    for (const m of this.rim) { m.color.set(c.rimColor); m.metalness = met; m.roughness = rough; }
    for (const m of this.caliper) m.color.set(c.caliper);
    for (const m of this.exhaust) {
      if (c.exhaust === 'black') { m.color.set(0x111214); m.metalness = 0.5; m.roughness = 0.45; }
      else if (c.exhaust === 'titanium') { m.color.set(0x7a6aa0); m.metalness = 1; m.roughness = 0.22; }
      else { m.color.set(0xe8eaee); m.metalness = 1; m.roughness = 0.05; }
    }
    const hc = new THREE.Color(HEAD[c.headlights]);
    for (const s of this.headlights) s.color.copy(hc);
    for (const m of this.lens) if (m.emissive) m.emissive.copy(hc).multiplyScalar(this.lensBase.get(m) ?? 0);
    for (const m of this.tail) m.color.copy(this.tailBase.get(m) ?? m.color).multiplyScalar(c.smokedTails ? 0.25 : 1);
    if (this.glass) { this.glass.opacity = [0.5, 0.64, 0.86][c.tint]; this.glass.color.setHex([0x101418, 0x06080c, 0x020203][c.tint]); }
    // Underglow on the car itself: the paint's sills take the colour and the rims pick it up. Emissive on materials
    // that already have the input is a uniform write, so this costs nothing per frame and compiles nothing.
    const glow = c.underglow;
    if (glow) this.glowColor.value.set(glow);
    const lv = this.paint?.userData.livery as LiveryUniforms | undefined;
    if (lv) { lv.glow.value.set(glow || 0x000000); lv.glowAmt.value = glow ? 1 : 0; }
    for (const m of this.rim) { m.emissive.set(glow || 0x000000); m.emissiveIntensity = glow ? 0.28 : 0; }
    this.showOptional();
  }

  private optional() { return [this.wings.ducktail!, this.wings.gt!, this.glow]; }
  private showOptional() {
    if (this.warm > 0) return;   // still warming: stay drawn, tiny
    const c = this.current;
    this.wings.ducktail!.visible = c.wing === 'ducktail';
    this.wings.gt!.visible = c.wing === 'gt';
    this.glow.visible = !!c.underglow;
  }

  /** Every frame, after the car root moved (root at pos / quat, in the scene): the livery's model-space matrix. */
  sync(pos: THREE.Vector3, quat: THREE.Quaternion) {
    if (this.warm > 0 && --this.warm === 0) { for (const o of this.optional()) { if (o === this.glow) o.scale.copy(this.glowScale); else o.scale.setScalar(1); } this.showOptional(); }
    const lu = this.paint?.userData.livery as LiveryUniforms | undefined;
    if (!lu || lu.style.value === 0) return;
    this.model.updateMatrix();
    lu.inv.value.copy(this.m4.compose(pos, quat, ONE).multiply(this.model.matrix)).invert();
  }

  /** Model-space box of the body (for the driver seat estimate and the garage camera). */
  get bounds() { return this.box; }
}
