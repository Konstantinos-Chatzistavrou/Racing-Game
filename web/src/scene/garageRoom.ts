// Garage interior for the showroom (title / garage): a concrete room with a skylight, a sun that casts shadows,
// light strips, props and two parked cars. Built procedurally (no assets) and only visible while the menu is showing.
import * as THREE from 'three/webgpu';

export interface GarageRoom {
  group: THREE.Group;
  sun: THREE.DirectionalLight;
  setVisible(on: boolean): void;
  park(cars: THREE.Object3D[]): void;
}

const W = 26, D = 18, H = 7;   // room size (m)

function mat(color: number, rough = 0.85, metal = 0.1) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
}

export function createGarageRoom(scene: THREE.Scene): GarageRoom {
  const g = new THREE.Group();
  g.name = 'garage_room';

  // floor: dark concrete with painted bay lines
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), mat(0x3d3f44, 0.9));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  g.add(floor);
  const line = mat(0xd8d2c4, 0.7);
  for (const x of [-4.2, 4.2]) {
    const l = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.012, 14), line);
    l.position.set(x, 0.01, 0);
    g.add(l);
  }

  // walls with vertical ribs
  const wall = mat(0x4d5158, 0.88);
  const rib = mat(0x2a2c31, 0.95);
  const side = (x: number, rotY: number) => {
    const w = new THREE.Mesh(new THREE.PlaneGeometry(D, H), wall);
    w.position.set(x, H / 2, 0); w.rotation.y = rotY; g.add(w);
    for (let i = -6; i <= 6; i++) {
      const r = new THREE.Mesh(new THREE.BoxGeometry(0.08, H, 0.14), rib);
      r.position.set(x + (rotY ? Math.sign(x) * -0.02 : 0), H / 2, i * 1.3); g.add(r);
    }
  };
  side(-W / 2, Math.PI / 2); side(W / 2, -Math.PI / 2);
  const back = new THREE.Mesh(new THREE.PlaneGeometry(W, H), wall);
  back.position.set(0, H / 2, -D / 2); g.add(back);
  const front = new THREE.Mesh(new THREE.PlaneGeometry(W, H), wall);
  front.position.set(0, H / 2, D / 2); front.rotation.y = Math.PI; g.add(front);

  // ceiling: beams + skylight strips
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W, D), mat(0x1c1d21, 0.95));
  ceil.rotation.x = Math.PI / 2; ceil.position.y = H; g.add(ceil);
  const beam = mat(0x141518, 0.9);
  for (let i = -3; i <= 3; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(W, 0.22, 0.3), beam);
    b.position.set(0, H - 0.15, i * 2.4); g.add(b);
  }
  const sky = new THREE.MeshBasicMaterial({ color: 0xfff4e2 });
  for (const z of [-4.5, 0, 4.5]) {
    const s = new THREE.Mesh(new THREE.PlaneGeometry(9, 1.1), sky);
    s.rotation.x = Math.PI / 2; s.position.set(0, H - 0.05, z); g.add(s);
  }

  // sun through the skylight: the only shadow-casting key in the showroom
  const sun = new THREE.DirectionalLight(0xfff1dd, 3.4);
  sun.position.set(6, 16, 7);
  sun.target.position.set(0, 0, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left = -14; sc.right = 14; sc.top = 12; sc.bottom = -12; sc.near = 1; sc.far = 40;
  sun.shadow.bias = -0.0004;
  g.add(sun, sun.target);
  // cool fill from the walls so the shadow side is not black
  g.add(new THREE.HemisphereLight(0xbcd0ea, 0x3a352e, 1.15));
  const warm = new THREE.PointLight(0xffd9a8, 60, 22, 2);
  warm.position.set(-6, 4.2, -4);
  const cool = new THREE.PointLight(0x9fc4ff, 45, 20, 2);
  cool.position.set(7, 4.0, 4);
  g.add(warm, cool);

  // props: tool cart, tyre stack, pallet, workbench
  const steel = mat(0x8a9099, 0.45, 0.8), rubber = mat(0x101114, 0.95), wood = mat(0x9a7b52, 0.9);
  const cart = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.0, 0.6), mat(0xb23a2e, 0.6, 0.3));
  body.position.y = 0.55; cart.add(body);
  for (let i = 0; i < 3; i++) { const dr = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.03, 0.02), steel); dr.position.set(0, 0.35 + i * 0.25, 0.31); cart.add(dr); }
  for (const [x, z] of [[-0.45, -0.22], [0.45, -0.22], [-0.45, 0.22], [0.45, 0.22]]) { const w = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.05, 8), rubber); w.rotation.x = Math.PI / 2; w.position.set(x, 0.07, z); cart.add(w); }
  cart.position.set(-8.5, 0, -5.5); cart.rotation.y = 0.4; g.add(cart);
  for (let i = 0; i < 4; i++) { const t = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.24, 18), rubber); t.position.set(8.2, 0.12 + i * 0.25, -5.8); g.add(t); }
  const pallet = new THREE.Group();
  for (let i = 0; i < 5; i++) { const p = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.08, 0.16), wood); p.position.set(0, 0.04, -0.4 + i * 0.2); pallet.add(p); }
  pallet.position.set(-6.5, 0, 5.2); pallet.rotation.y = -0.25; g.add(pallet);
  const bench = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.12, 0.8), wood); bench.position.set(7.5, 0.9, 5.5); g.add(bench);
  for (const x of [6.1, 8.9]) for (const z of [5.2, 5.8]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.9, 0.1), steel); leg.position.set(x, 0.45, z); g.add(leg); }

  // only props and cars cast: a casting ceiling would put the whole room in its own shadow
g.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.receiveShadow = true; });
  for (const grp of [cart, pallet]) grp.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.castShadow = true; });
  g.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m.geometry && (m.geometry as THREE.CylinderGeometry).type === 'CylinderGeometry') m.castShadow = true; });
  bench.castShadow = true;
  scene.add(g);

  const park = (cars: THREE.Object3D[]) => {
    const spots: [number, number, number][] = [[-7.5, 0.02, -2.2, ], [7.5, 0.02, 2.4]];
    cars.slice(0, 2).forEach((c, i) => {
      const s = spots[i]; if (!s) return;
      c.position.set(s[0], s[1], s[2]);
      c.rotation.y = i ? -2.1 : 2.1;
      c.visible = true;
      g.add(c);
    });
  };

  return {
    group: g,
    sun,
    setVisible(on: boolean) { g.visible = on; sun.visible = on; sun.castShadow = on; },
    park,
  };
}
