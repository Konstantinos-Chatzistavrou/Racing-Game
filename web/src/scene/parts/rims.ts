// Rim catalog: 30 deterministic, code-generated wheel designs (10 families x 3 variants). No assets, no textures,
// no randomness, and nothing modelled after a real wheel brand: every shape is a primitive arrangement parameterised
// by spoke count, spoke section, dish depth, lip and tilt. Each build returns a Group centred on the origin with the
// axle along +z, so the outer face looks down +z (callers can scale by ctx.radius / 0.34 to fit another car).
import * as THREE from 'three/webgpu';

export interface RimCtx { readonly radius: number; readonly width: number; readonly mat: THREE.Material; }
export interface RimSpec { id: string; name: string; build(ctx: RimCtx): THREE.Object3D; }

/** Concatenate indexed primitives (positions, normals, uvs) into one geometry: one draw call per spoke set. */
function mergeGeoms(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  let off = 0;
  for (const g of list) {
    const p = g.attributes.position, n = g.attributes.normal, u = g.attributes.uv;
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      nor.push(n.getX(i), n.getY(i), n.getZ(i));
      uv.push(u ? u.getX(i) : 0, u ? u.getY(i) : 0);
    }
    const ix = g.index;
    if (ix) for (let i = 0; i < ix.count; i++) idx.push(ix.getX(i) + off);
    else for (let i = 0; i < p.count; i++) idx.push(i + off);
    off += p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  out.setIndex(idx);
  return out;
}

interface Opt {
  spokes: number;
  /** tangential spoke width (m) */
  w: number;
  /** spoke thickness along z (m) */
  t: number;
  /** how far the face is recessed behind the lip (m); 0 = flush */
  dish?: number;
  /** torus lip thickness (m); 0/undefined = none */
  lip?: number;
  /** a second, smaller step behind the lip */
  step?: boolean;
  /** spokes lean in/out along z (radians, + = outer end forward) */
  tilt?: number;
  /** turbine pitch around the spoke's own axis (radians) */
  twist?: number;
  /** sub-spokes per position (split spokes) */
  split?: number;
  hub?: number;
  /** how thick the visible face plate is: spokes sit at this z */
  face?: number;
}

const TAU = Math.PI * 2;

function build(ctx: RimCtx, o: Opt): THREE.Object3D {
  const R = ctx.radius, W = ctx.width;
  const g = new THREE.Group();
  const flat = Math.PI / 2;   // cylinder axis y -> z

  // barrel (open both ends) and the inner back plate: the wheel sits centred on z = 0
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.995, R * 0.995, W, 30, 1, true), ctx.mat);
  barrel.rotation.x = flat;
  g.add(barrel);
  const back = new THREE.Mesh(new THREE.CircleGeometry(R * 0.985, 30), ctx.mat);
  back.position.z = -W / 2 + 0.004;
  back.rotation.y = Math.PI;   // faces -z, so it is only seen from inside the wheel
  g.add(back);

  const k = R / 0.34;              // the numeric table below is authored at r = 0.34 m; scale to the caller's wheel
  const dish = (o.dish ?? 0.018) * k;
  const lipR = R - 0.014 * k;
  const hubR = (o.hub ?? 0.072) * k;
  const faceZ = W / 2 - dish - 0.006 * k;
  const len = lipR - hubR - 0.01;
  const geoms: THREE.BufferGeometry[] = [];
  for (let i = 0; i < o.spokes; i++) {
    const a = (i / o.spokes) * TAU;
    const subs = o.split ?? 1;
    for (let s = 0; s < subs; s++) {
      const off = subs > 1 ? (s - (subs - 1) / 2) * o.w * k * 1.15 : 0;
      const box = new THREE.BoxGeometry(len, o.w * k, o.t * k);
      const m = new THREE.Matrix4()
        .makeRotationZ(a)
        .multiply(new THREE.Matrix4().makeTranslation(hubR + len / 2, off, 0))
        .multiply(new THREE.Matrix4().makeRotationY(o.tilt ?? 0))
        .multiply(new THREE.Matrix4().makeRotationX(o.twist ?? 0));
      box.applyMatrix4(m);
      geoms.push(box);
    }
  }
  const face = new THREE.Mesh(mergeGeoms(geoms), ctx.mat);
  face.position.z = faceZ;
  g.add(face);

  // hub cap
  const hubH = Math.max(0.03, o.t * 1.35) * k;
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(hubR, hubR * 0.92, hubH, 20), ctx.mat);
  hub.rotation.x = flat;
  hub.position.z = faceZ + hubH * 0.35;
  g.add(hub);

  // lip (and an optional step behind it)
  const lipW = (o.lip ?? 0) * k;
  if (lipW > 0) {
    // a short straight or slightly conical ring: the lip edge is a cylinder wall, not a modelled torus
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(R, R - lipW * 0.45, lipW, 40, 1, true), ctx.mat);
    ring.rotation.x = flat;
    ring.position.z = W / 2 - lipW / 2;
    g.add(ring);
    if (o.step) {
      const step = new THREE.Mesh(new THREE.CylinderGeometry(R - lipW * 1.6, R - lipW * 2.2, lipW * 0.6, 36, 1, true), ctx.mat);
      step.rotation.x = flat;
      step.position.z = W / 2 - lipW * 1.8;
      g.add(step);
    }
  }

  // recessed dish wall between the face and the lip
  if (dish > 0.012 * k) {
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(lipR, lipR, dish, 30, 1, true), ctx.mat);
    wall.rotation.x = flat;
    wall.position.z = W / 2 - dish / 2 - 0.004;
    g.add(wall);
  }
  // centre the whole wheel on its own bounding box: the axle runs through the origin at z = 0, so a caller can
  // drop the group straight onto a wheel node without compensating for the dish or the hub cap.
  const bb = new THREE.Box3().setFromObject(g);
  const ctr = bb.getCenter(new THREE.Vector3());
  for (const ch of g.children) ch.position.sub(ctr);
  return g;
}

type Variant = Opt & { id: string; name: string };
const spec = (v: Variant): RimSpec => ({ id: v.id, name: v.name, build: (ctx) => build(ctx, v) });

// 10 families x 3 variants. Numbers are metres at the reference radius (0.34) and width (0.22).
export const RIM_SPECS: RimSpec[] = [
  // 1. five-spoke
  spec({ id: 'five-classic', name: 'Five Classic', spokes: 5, w: 0.060, t: 0.030, dish: 0.018, lip: 0.012 }),
  spec({ id: 'five-split', name: 'Five Split', spokes: 5, w: 0.030, t: 0.028, split: 2, dish: 0.022, lip: 0.012 }),
  spec({ id: 'five-flat', name: 'Five Flat', spokes: 5, w: 0.072, t: 0.024, dish: 0.006, lip: 0.010, tilt: 0.06 }),
  // 2. six-spoke
  spec({ id: 'six-classic', name: 'Six Classic', spokes: 6, w: 0.052, t: 0.030, dish: 0.016, lip: 0.012 }),
  spec({ id: 'six-tapered', name: 'Six Tapered', spokes: 6, w: 0.044, t: 0.026, dish: 0.020, lip: 0.012, tilt: -0.08 }),
  spec({ id: 'six-twin', name: 'Six Twin', spokes: 6, w: 0.024, t: 0.026, split: 2, dish: 0.018, lip: 0.012 }),
  // 3. seven-spoke
  spec({ id: 'seven-thin', name: 'Seven Thin', spokes: 7, w: 0.038, t: 0.024, dish: 0.020, lip: 0.012 }),
  spec({ id: 'seven-wide', name: 'Seven Wide', spokes: 7, w: 0.074, t: 0.032, dish: 0.014, lip: 0.010 }),
  spec({ id: 'seven-race', name: 'Seven Race', spokes: 7, w: 0.034, t: 0.020, dish: 0.030, lip: 0.016, tilt: -0.05 }),
  // 4. mesh (many thin spokes)
  spec({ id: 'mesh-12', name: 'Mesh 12', spokes: 12, w: 0.016, t: 0.016, dish: 0.016, lip: 0.012, hub: 0.064 }),
  spec({ id: 'mesh-16', name: 'Mesh 16', spokes: 16, w: 0.013, t: 0.014, dish: 0.016, lip: 0.012, hub: 0.062 }),
  spec({ id: 'mesh-20', name: 'Mesh 20', spokes: 20, w: 0.011, t: 0.013, dish: 0.016, lip: 0.012, hub: 0.060 }),
  // 5. split five (10 / 15 effective spokes)
  spec({ id: 'split5-fine', name: 'Split Five Fine', spokes: 5, w: 0.022, t: 0.024, split: 2, dish: 0.020, lip: 0.012 }),
  spec({ id: 'split5-triple', name: 'Split Five Triple', spokes: 5, w: 0.015, t: 0.022, split: 3, dish: 0.022, lip: 0.012 }),
  spec({ id: 'split5-tilt', name: 'Split Five Tilt', spokes: 5, w: 0.020, t: 0.022, split: 2, dish: 0.024, lip: 0.014, tilt: -0.10 }),
  // 6. turbine
  spec({ id: 'turbine-8', name: 'Turbine 8', spokes: 8, w: 0.052, t: 0.022, twist: 0.38, dish: 0.018, lip: 0.012 }),
  spec({ id: 'turbine-12', name: 'Turbine 12', spokes: 12, w: 0.040, t: 0.020, twist: 0.46, dish: 0.018, lip: 0.012 }),
  spec({ id: 'turbine-16', name: 'Turbine 16', spokes: 16, w: 0.032, t: 0.018, twist: 0.54, dish: 0.020, lip: 0.012, hub: 0.064 }),
  // 7. dish / stepped lip
  spec({ id: 'dish-step', name: 'Dish Step', spokes: 6, w: 0.046, t: 0.026, dish: 0.055, lip: 0.018, step: true }),
  spec({ id: 'dish-deep', name: 'Dish Deep', spokes: 6, w: 0.042, t: 0.026, dish: 0.075, lip: 0.020, step: true }),
  spec({ id: 'dish-ultra', name: 'Dish Ultra', spokes: 6, w: 0.038, t: 0.024, dish: 0.095, lip: 0.022, step: true, tilt: -0.06 }),
  // 8. concave
  spec({ id: 'concave-soft', name: 'Concave Soft', spokes: 6, w: 0.050, t: 0.026, dish: 0.030, lip: 0.014, tilt: -0.12 }),
  spec({ id: 'concave-mid', name: 'Concave Mid', spokes: 6, w: 0.046, t: 0.024, dish: 0.038, lip: 0.016, tilt: -0.18 }),
  spec({ id: 'concave-hard', name: 'Concave Hard', spokes: 6, w: 0.042, t: 0.022, dish: 0.046, lip: 0.018, tilt: -0.24 }),
  // 9. deep lip
  spec({ id: 'lip-deep', name: 'Deep Lip', spokes: 7, w: 0.036, t: 0.024, dish: 0.062, lip: 0.034, hub: 0.080 }),
  spec({ id: 'lip-wide', name: 'Wide Lip', spokes: 7, w: 0.034, t: 0.024, dish: 0.070, lip: 0.044, hub: 0.084 }),
  spec({ id: 'lip-max', name: 'Max Lip', spokes: 7, w: 0.032, t: 0.022, dish: 0.080, lip: 0.054, hub: 0.088, step: true }),
  // 10. rally (chunky, small face)
  spec({ id: 'rally-6', name: 'Rally 6', spokes: 6, w: 0.090, t: 0.046, dish: 0.008, lip: 0.008, hub: 0.090 }),
  spec({ id: 'rally-8', name: 'Rally 8', spokes: 8, w: 0.078, t: 0.044, dish: 0.008, lip: 0.008, hub: 0.088 }),
  spec({ id: 'rally-10', name: 'Rally 10', spokes: 10, w: 0.064, t: 0.042, dish: 0.008, lip: 0.008, hub: 0.086 }),
];