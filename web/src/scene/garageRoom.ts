// Garage interior for the showroom (title / garage): a concrete room with a skylight, a sun that casts shadows,
// light strips, a working workshop's worth of props and two parked cars. Everything is procedural three.js geometry
// (no assets, no textures); the room is static and only visible while the menu is showing.
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

  // ---- shell ------------------------------------------------------------------------------------------------
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

  // ---- lights -----------------------------------------------------------------------------------------------
  const sun = new THREE.DirectionalLight(0xfff1dd, 3.4);
  sun.position.set(6, 16, 7);
  sun.target.position.set(0, 0, 0);
  sun.castShadow = true;
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left = -14; sc.right = 14; sc.top = 12; sc.bottom = -12; sc.near = 0.5; sc.far = 40;
  sc.updateProjectionMatrix();   // without this the shadow frustum stays at its defaults and nothing lands
  sun.shadow.bias = -0.0004;
  sun.shadow.mapSize.set(2048, 2048);
  g.add(sun, sun.target);
  g.add(new THREE.HemisphereLight(0xbcd0ea, 0x3a352e, 1.15));
  const warm = new THREE.PointLight(0xffd9a8, 60, 22, 2);
  warm.position.set(-6, 4.2, -4);
  const cool = new THREE.PointLight(0x9fc4ff, 45, 20, 2);
  cool.position.set(7, 4.0, 4);
  g.add(warm, cool);

  // ---- shared materials + helpers ---------------------------------------------------------------------------
  const steel = mat(0x8a9099, 0.45, 0.8), darkSteel = mat(0x3a3d42, 0.6, 0.75);
  const rubber = mat(0x101114, 0.95), wood = mat(0x9a7b52, 0.9), chrome = mat(0xd8dde3, 0.18, 1);
  const red = mat(0xb23a2e, 0.6, 0.3), fabric = mat(0xff6a2b, 0.92), fabric2 = mat(0xe8e2d6, 0.95);
  const paper = mat(0xcfc6b4, 0.95), tube = new THREE.MeshBasicMaterial({ color: 0xf2f7ff });
  const solids: THREE.Object3D[] = [];

  const box = (w: number, h: number, d: number, m: THREE.Material) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  const cyl = (r: number, h: number, m: THREE.Material, seg = 12) => new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), m);
  const at = <T extends THREE.Object3D>(o: T, x: number, y: number, z: number, ry = 0): T => { o.position.set(x, y, z); o.rotation.y = ry; return o; };
  const prop = (grp: THREE.Group, x: number, y: number, z: number, ry = 0) => { at(grp, x, y, z, ry); g.add(grp); solids.push(grp); return grp; };

  // ---- ECU tuning desk with laptops --------------------------------------------------------------------------
  {
    const d = new THREE.Group();
    d.add(at(box(2.6, 0.08, 1.1, wood), 0, 0.92, 0));
    for (const x of [-1.15, 1.15]) for (const z of [-0.42, 0.42]) d.add(at(box(0.08, 0.9, 0.08, steel), x, 0.45, z));
    // open laptop: base, tilted screen, glowing tuning graph
    const laptop = new THREE.Group();
    laptop.add(at(box(0.44, 0.03, 0.32, darkSteel), 0, 0.955, 0));
    const lid = at(box(0.44, 0.3, 0.02, darkSteel), 0, 1.1, -0.16);
    lid.rotation.x = -0.22;
    laptop.add(lid);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.26), new THREE.MeshBasicMaterial({ color: 0x0a1524 }));
    screen.position.set(0, 1.1, -0.148); screen.rotation.x = -0.22;
    laptop.add(screen);
    for (let i = 0; i < 3; i++) {
      const bar = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.012), new THREE.MeshBasicMaterial({ color: i === 2 ? 0xffb547 : 0x3ddc84 }));
      bar.position.set(0, 1.05 + i * 0.035, -0.147); bar.rotation.x = -0.22;
      laptop.add(bar);
    }
    d.add(laptop);
    // second laptop, closed-ish, plus keyboard and coffee
    d.add(at(box(0.38, 0.03, 0.28, darkSteel), 0.95, 0.955, 0.08, 0.2));
    d.add(at(box(0.36, 0.27, 0.02, darkSteel), 0.95, 1.08, -0.02, 0.2));
    d.add(at(box(0.4, 0.02, 0.16, darkSteel), -0.75, 0.955, 0.28, -0.06));
    d.add(at(cyl(0.045, 0.1, paper, 10), -1.05, 1.0, -0.3));
    prop(d, -10.4, 0, -7.5, 0.55);

    // wheeled stool at the desk
    const stool = new THREE.Group();
    stool.add(at(cyl(0.22, 0.06, darkSteel, 12), 0, 0.55, 0));
    stool.add(at(cyl(0.03, 0.5, steel, 8), 0, 0.3, 0));
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const leg = at(box(0.34, 0.03, 0.05, darkSteel), Math.cos(a) * 0.17, 0.08, Math.sin(a) * 0.17, -a);
      stool.add(leg);
    }
    prop(stool, -9.0, 0, -6.2);
  }

  // ---- folded drag chute on the wall -------------------------------------------------------------------------
  {
    const c = new THREE.Group();
    const bag = new THREE.Mesh(new THREE.SphereGeometry(0.55, 12, 9), fabric);
    bag.scale.set(1.15, 0.6, 0.5); bag.position.y = 0;
    c.add(bag);
    for (const [y, z] of [[0.16, 0.1], [-0.14, 0.12]]) {
      const fold = at(box(0.7, 0.16, 0.24, fabric2), 0, y, z);
      fold.rotation.z = 0.08;
      c.add(fold);
    }
    for (const x of [-0.22, 0.22]) c.add(at(box(0.05, 1.5, 0.02, darkSteel), x, -0.75, 0.08));
    prop(c, 2.6, 3.2, -8.55);
  }

  // ---- engine hoist ------------------------------------------------------------------------------------------
  {
    const h = new THREE.Group();
    h.add(at(box(1.1, 0.12, 0.75, red), -0.45, 0.06, 0));
    h.add(at(cyl(0.075, 3.3, red, 10), 0, 1.7, 0));
    const boom = at(box(2.4, 0.13, 0.13, red), 0.95, 3.25, 0);
    boom.rotation.z = -0.12;
    h.add(boom);
    h.add(at(box(0.9, 0.08, 0.08, steel), -0.15, 2.3, 0));
    for (let i = 0; i < 6; i++) {
      const link = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.016, 6, 8), darkSteel);
      link.position.set(2.0, 3.05 - i * 0.11, 0);
      link.rotation.y = i % 2 ? Math.PI / 2 : 0;
      h.add(link);
    }
    const hook = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.02, 6, 10, Math.PI * 1.5), chrome);
    hook.position.set(2.0, 2.3, 0); hook.rotation.z = Math.PI / 2;
    h.add(hook);
    prop(h, 10.4, 0, -6.4, -0.6);
  }

  // ---- toolbox stack -----------------------------------------------------------------------------------------
  {
    const t = new THREE.Group();
    t.add(at(box(1.3, 0.88, 0.6, red), 0, 0.44, 0));
    t.add(at(box(1.05, 0.5, 0.52, red), 0.06, 1.13, 0.02));
    for (let i = 0; i < 5; i++) t.add(at(box(1.16, 0.055, 0.02, darkSteel), 0, 0.18 + i * 0.145, 0.31));
    for (let i = 0; i < 2; i++) t.add(at(box(0.8, 0.04, 0.02, chrome), 0.06, 1.02 + i * 0.2, 0.28));
    prop(t, -11.9, 0, -2.3, 1.35);
  }

  // ---- tyre wall ---------------------------------------------------------------------------------------------
  {
    const w = new THREE.Group();
    for (const x of [-2.2, 2.2]) w.add(at(box(0.09, 2.7, 0.8, steel), x, 1.35, 0));
    for (const y of [0.9, 1.55, 2.2]) w.add(at(box(4.5, 0.07, 0.07, steel), 0, y, 0));
    for (let r = 0; r < 3; r++) for (let c = 0; c < 2; c++) {
      const tyre = cyl(0.33, 0.24, rubber, 14);
      tyre.rotation.z = Math.PI / 2;
      tyre.position.set(c ? 0.75 : -0.75, 0.33 + r * 0.26, 0.05);
      w.add(tyre);
    }
    prop(w, 5.6, 0, -8.2);
  }

  // ---- oil drums ---------------------------------------------------------------------------------------------
  {
    const o = new THREE.Group();
    const colours = [0x2a5fa8, 0x3c7a46, 0x8a4a2a];
    colours.forEach((c, i) => {
      const drum = cyl(0.28, 0.86, mat(c, 0.7, 0.4), 12);
      drum.position.set((i - 1) * 0.66, 0.43, i === 2 ? 0.2 : 0);
      o.add(drum);
      o.add(at(cyl(0.285, 0.05, darkSteel, 12), (i - 1) * 0.66, 0.6, i === 2 ? 0.2 : 0));
    });
    prop(o, 11.9, 0, -1.0);
  }

  // ---- spare engines on stands (two) -------------------------------------------------------------------------
  const engine = (x: number, z: number) => {
    const e = new THREE.Group();
    e.add(at(box(0.55, 0.05, 0.55, steel), 0, 0.03, 0));
    e.add(at(cyl(0.05, 0.9, steel, 8), 0, 0.48, 0));
    e.add(at(box(0.5, 0.06, 0.06, steel), 0, 0.92, 0));
    e.add(at(box(0.62, 0.5, 0.42, darkSteel), 0, 1.2, 0));
    for (const dz of [-0.12, 0.12]) e.add(at(box(0.58, 0.09, 0.16, chrome), 0, 1.48, dz));
    e.add(at(box(0.28, 0.16, 0.3, steel), 0.34, 1.3, 0));
    prop(e, x, 0, z, Math.PI / 2);
  };
  engine(-12.0, 1.9); engine(-12.0, 3.8);

  // ---- cable spools ------------------------------------------------------------------------------------------
  {
    const s = new THREE.Group();
    for (const [x, y] of [[-0.45, 0.42], [0.45, 0.42], [0, 0.42]]) {
      const spool = new THREE.Group();
      const drum = cyl(0.34, 0.42, darkSteel, 12);
      drum.rotation.z = Math.PI / 2;
      spool.add(drum);
      for (const dz of [-0.21, 0.21]) { const f = cyl(0.42, 0.04, wood, 12); f.rotation.z = Math.PI / 2; f.position.x = dz; spool.add(f); }
      spool.position.set(x, y, 0);
      s.add(spool);
    }
    prop(s, 12.0, 0, 5.4, 0);
  }

  // ---- posters on the back wall ------------------------------------------------------------------------------
  {
    const posters: [number, number, number][] = [[-4.4, 4.3, 0], [0.3, 4.6, 0.1], [3.6, 4.2, -0.06]];
    posters.forEach(([x, y, ry], i) => {
      const p = new THREE.Group();
      p.add(at(box(1.3, 1.8, 0.02, paper), 0, 0, 0));
      const block = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.5), new THREE.MeshBasicMaterial({ color: [0xff2d55, 0x9fc4ff, 0xffb547][i] }));
      block.position.set(0, 0.3 - i * 0.1, 0.012);
      p.add(block);
      p.add(at(box(0.5, 0.06, 0.03, darkSteel), 0, -0.55, 0.02));
      p.position.set(x, y, -8.88);
      p.rotation.y = ry;
      g.add(p);
    });
  }

  // ---- fluorescent tubes + two wall light pools --------------------------------------------------------------
  {
    for (const [x, z] of [[-12.8, -5], [-12.8, 1], [12.8, -5], [12.8, 1]]) {
      const t = box(2.0, 0.09, 0.14, tube);
      t.position.set(x, 5.4, z); t.rotation.y = Math.PI / 2;
      g.add(t);
    }
    for (const x of [-6, 6]) {
      const l = new THREE.PointLight(0xdfe9ff, 28, 18, 2);
      l.position.set(x, 5.2, 0); g.add(l);
    }
  }

  // ---- wheel rack + work light + floor jack ------------------------------------------------------------------
  {
    const r = new THREE.Group();
    for (const x of [-1.1, 1.1]) r.add(at(box(0.09, 2.1, 0.09, steel), x, 1.05, 0));
    for (const y of [0.8, 1.45]) r.add(at(box(2.0, 0.07, 0.07, steel), 0, y, 0));
    for (let i = 0; i < 4; i++) {
      const rim = new THREE.Group();
      rim.add(at(cyl(0.34, 0.22, chrome, 16), 0, 0, 0));
      rim.add(at(cyl(0.2, 0.24, darkSteel, 12), 0, 0, 0));
      rim.rotation.z = Math.PI / 2;
      rim.position.set(-0.6 + i * 0.4, i < 2 ? 0.8 : 1.45, 0.18);
      r.add(rim);
    }
    prop(r, 11.9, 0, 3.0, -1.2);
  }
  {
    const wl = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const leg = at(cyl(0.025, 1.5, steel, 6), Math.cos(a) * 0.22, 0.75, Math.sin(a) * 0.22);
      leg.rotation.z = Math.cos(a) * 0.18; leg.rotation.x = -Math.sin(a) * 0.18;
      wl.add(leg);
    }
    wl.add(at(box(0.34, 0.22, 0.14, darkSteel), 0, 1.6, 0));
    const face = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 0.17), tube);
    face.position.set(0, 1.6, 0.075);
    wl.add(face);
    const lamp = new THREE.PointLight(0xfff2d0, 30, 12, 2);
    lamp.position.set(0, 1.65, 0.35);
    wl.add(lamp);
    prop(wl, -2.8, 0, -6.9, -0.4);
  }
  {
    const j = new THREE.Group();
    j.add(at(box(0.95, 0.2, 0.42, red), 0, 0.22, 0));
    j.add(at(cyl(0.035, 1.1, steel, 8), -0.3, 0.7, 0.2));
    for (const [x, z] of [[-0.36, -0.17], [0.36, -0.17], [-0.36, 0.17], [0.36, 0.17]]) {
      const w = cyl(0.07, 0.05, rubber, 8);
      w.rotation.x = Math.PI / 2; w.position.set(x, 0.07, z);
      j.add(w);
    }
    prop(j, -4.9, 0, -5.9, 0.3);
  }

  // ---- shadow flags: room shell receives, props cast ---------------------------------------------------------
  g.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.receiveShadow = true; });
  for (const s of solids) s.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.castShadow = true; });
  scene.add(g);

  const park = (cars: THREE.Object3D[]) => {
    const spots: [number, number, number][] = [[-7.2, 0.02, -2.0], [7.2, 0.02, 2.2]];
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
