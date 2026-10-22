// Crash dents in the VERTEX SHADER: a TSL positionNode shared by every body material applies an
// array of up to MAX_DENTS accumulated dents. Each dent = impact point (car model space), depth,
// inward crash direction and radius. Vertices within the radius move inward along their normal
// (blended with the crash direction, see below) with a smooth falloff, so dents are permanent and
// accumulate at ZERO per-hit CPU cost; repair just sets the count to 0.
//
// Why this REPLACES the old CPU path (vertex loop + normal recompute per panel, queued one panel
// per frame): that cost scaled with panel vertex count on every hit (the Godot lesson), cloned
// every touched geometry, and big hits took several frames to show. Here a hit is 8 floats into
// a uniform array. Shader cost: one loop over the live dents per car vertex (~16 x a few dozen
// ALU, car only, early-out when count = 0) - noise for the Intel UHD iGPU next to the lit city.
// When all slots are used, a new dent MERGES into the nearest one (depth-weighted centre, summed
// depth, larger radius) instead of baking into the vertex buffer: 16 slots of 0.45-1.2 m already
// cover the whole body, so merging loses nothing visible and keeps the zero-CPU property.
//
// Normals: the analytic gradient of the falloff tilts each normal toward the dent centre
// (surface height h = -depth w(r):  n' = n + depth * grad_t w), written into normalLocal the way
// three's skinning does, so lighting reads the dent without recomputing geometry normals.
//
// Spaces: dents live in car MODEL space. Each car mesh carries its rest mesh->model matrix
// (userData.dentToModel / dentToLocal), fed as per-object uniforms: one node serves meshes with
// different transforms and shared materials, and a part that breaks off keeps its dents. Meshes
// without the matrices (wheels, interior sharing a material) get dentOn = 0: never dented.
import * as THREE from 'three/webgpu';
import { Fn, Loop, If, uniform, uniformArray, positionLocal, normalLocal, vec3, vec4, float, sin, cos } from 'three/tsl';

export const MAX_DENTS = 16;
const MAX_DEPTH = 0.3;            // m per slot (merged dents stop deepening here)
const I4 = new THREE.Matrix4();

type Obj = { object?: THREE.Object3D | null };

export class Dents {
  private pt = Array.from({ length: MAX_DENTS }, () => new THREE.Vector4());    // xyz point, w depth (m)
  private dir = Array.from({ length: MAX_DENTS }, () => new THREE.Vector4());   // xyz inward dir, w radius (m)
  private countU = uniform(0, 'int');
  count = 0;
  readonly positionNode: THREE.Node;

  constructor() {
    const ptU = uniformArray(this.pt, 'vec4'), dirU = uniformArray(this.dir, 'vec4');
    // Object3D.clone() JSON-copies userData: on a cloned mesh (remote players' cars) the matrices are
    // plain objects, not Matrix4. Those meshes are never dented: identity and off.
    const isM4 = (m: unknown): m is THREE.Matrix4 => !!(m as { isMatrix4?: boolean } | undefined)?.isMatrix4;
    const mat = (m: unknown) => (isM4(m) ? m : I4);
    const toModel = uniform(new THREE.Matrix4()).onObjectUpdate(({ object }: Obj) => mat(object?.userData.dentToModel));
    const toLocal = uniform(new THREE.Matrix4()).onObjectUpdate(({ object }: Obj) => mat(object?.userData.dentToLocal));
    const on = uniform(0, 'int').onObjectUpdate(({ object }: Obj) => (isM4(object?.userData.dentToModel) ? 1 : 0));
    const count = this.countU;
    this.positionNode = Fn(() => {
      const p = toModel.mul(vec4(positionLocal, 1)).xyz.toVar();
      const n = toModel.mul(vec4(normalLocal, 0)).xyz.normalize().toVar();
      const disp = vec3(0).toVar(), tilt = vec3(0).toVar();
      Loop({ start: 0, end: count.mul(on), type: 'int', condition: '<' }, ({ i }: { i: THREE.Node }) => {
        const a = ptU.element(i) as unknown as THREE.Node<'vec4'>, b = dirU.element(i) as unknown as THREE.Node<'vec4'>;
        const d = p.sub(a.xyz);
        const R2 = b.w.mul(b.w);
        const q = d.dot(d).div(R2);                                   // (r / R)^2
        If(q.lessThan(1), () => {
          const s = float(1).sub(q), w = s.mul(s);                     // (1 - (r/R)^2)^2: zero slope at the edge
          // Inward along the normal, blended with the crash direction: pure -normal would dent a
          // bonnet straight down in a frontal hit. (0.6 c - 0.4 n never vanishes for unit vectors.)
          const push = b.xyz.mul(0.6).sub(n.mul(0.4)).normalize();
          const side = vec3(b.z.negate(), 0, b.x);                     // crash dir x up: crumple wrinkles
          const h = sin(p.x.mul(41).add(p.y.mul(17))).mul(cos(p.z.mul(29)));
          disp.addAssign(push.mul(a.w.mul(w)).add(side.mul(h.mul(a.w).mul(0.25).mul(w))));
          tilt.addAssign(d.mul(s.mul(a.w).mul(-4).div(R2)));          // depth * grad w (toward the centre)
        });
      });
      const t = tilt.sub(n.mul(tilt.dot(n)));                          // tangential part only
      normalLocal.assign(toLocal.mul(vec4(n.add(t.mul(float(1.5).div(t.length().max(1.5)))), 0)).xyz.normalize());
      return toLocal.mul(vec4(p.add(disp), 1)).xyz;
    })() as unknown as THREE.Node;
  }

  /** Mark a car mesh as dentable: store its rest mesh -> model matrix (model = car glTF root). */
  register(mesh: THREE.Mesh, model: THREE.Object3D) {
    model.updateWorldMatrix(true, true);
    const toModel = model.matrixWorld.clone().invert().multiply(mesh.matrixWorld);
    mesh.userData.dentToModel = toModel;
    mesh.userData.dentToLocal = toModel.clone().invert();
  }

  /** Add a dent (model space). Nearby dents merge; when all slots are used it merges into the nearest. */
  add(p: THREE.Vector3, inward: THREE.Vector3, depth: number, radius: number) {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < this.count; i++) {
      const d = p.distanceTo(new THREE.Vector3(this.pt[i].x, this.pt[i].y, this.pt[i].z));
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0 && (bestD < 0.5 * Math.min(radius, this.dir[best].w) || this.count === MAX_DENTS)) {
      const a = this.pt[best], b = this.dir[best], wsum = a.w + depth;
      const nd = new THREE.Vector3(b.x * a.w + inward.x * depth, b.y * a.w + inward.y * depth, b.z * a.w + inward.z * depth).normalize();
      b.set(nd.x, nd.y, nd.z, Math.max(b.w, radius));
      a.set((a.x * a.w + p.x * depth) / wsum, (a.y * a.w + p.y * depth) / wsum, (a.z * a.w + p.z * depth) / wsum, Math.min(MAX_DEPTH, wsum));
      return;
    }
    this.pt[this.count].set(p.x, p.y, p.z, Math.min(MAX_DEPTH, depth));
    this.dir[this.count].set(inward.x, inward.y, inward.z, radius);
    this.countU.value = ++this.count;
  }

  clear() { this.count = 0; this.countU.value = 0; }
}
