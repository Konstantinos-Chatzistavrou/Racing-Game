// The garage: an after-hours tuner workshop built around a turntable. Everything static is generated here in code
// (shell, steelwork, light fixtures, signage) and merged into a handful of meshes; its lighting is baked per vertex
// (bake.ts) and the floor carries a real mirror image (materials.ts). The room sits at the scene origin with the hero
// car on the turntable at (0, 0, 0), nose toward +z (the roller doors); the back wall with the sign is at -z.
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { abs, dot, normalView, positionViewDirection, pow, uv, vec3, vec4 } from 'three/tsl';
import { loadKTX2 } from '../loaders';
import { LightBake } from './bake';
import { bakedMaterial, decalMaterial, emissiveMaterial, floorMaterial, type FloorHandle, type SurfaceMaps } from './materials';

export const ROOM = { hw: 12, hd: 9, h: 6.4, deck: 3.15 } as const;
const { hw, hd, h: H } = ROOM;
const BRICK_H = 2.8;

type Face = 'px' | 'nx' | 'py' | 'ny' | 'pz' | 'nz';

/** Collects world-space geometry per material key, then merges each key into one mesh. */
class Shell {
  private parts = new Map<string, THREE.BufferGeometry[]>();
  add(key: string, g: THREE.BufferGeometry) {
    let l = this.parts.get(key);
    if (!l) this.parts.set(key, (l = []));
    l.push(g.index ? g.toNonIndexed() : g);
  }
  /** a flat panel facing `face`, centred at (cx, cy, cz); w x h in its own plane, subdivided every `seg` metres */
  panel(key: string, cx: number, cy: number, cz: number, w: number, h: number, face: Face, seg = 0.5) {
    const g = new THREE.PlaneGeometry(w, h, Math.max(1, Math.round(w / seg)), Math.max(1, Math.round(h / seg)));
    if (face === 'py') g.rotateX(-Math.PI / 2);
    else if (face === 'ny') g.rotateX(Math.PI / 2);
    else if (face === 'nz') g.rotateY(Math.PI);
    else if (face === 'px') g.rotateY(Math.PI / 2);
    else if (face === 'nx') g.rotateY(-Math.PI / 2);
    g.translate(cx, cy, cz);
    this.add(key, g);
    return g;
  }
  box(key: string, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, seg = 0.6) {
    const n = (s: number) => Math.max(1, Math.round(s / seg));
    const g = new THREE.BoxGeometry(sx, sy, sz, n(sx), n(sy), n(sz));
    g.translate(cx, cy, cz);
    this.add(key, g);
  }
  /** a cylinder along `axis` */
  tube(key: string, cx: number, cy: number, cz: number, r: number, len: number, axis: 'x' | 'y' | 'z', seg = 10) {
    const g = new THREE.CylinderGeometry(r, r, len, seg, Math.max(1, Math.round(len / 0.8)));
    if (axis === 'x') g.rotateZ(Math.PI / 2); else if (axis === 'z') g.rotateX(Math.PI / 2);
    g.translate(cx, cy, cz);
    this.add(key, g);
  }
  keys() { return [...this.parts.keys()]; }
  merged(key: string): THREE.BufferGeometry | null {
    const l = this.parts.get(key);
    if (!l?.length) return null;
    const g = mergeGeometries(l, false);
    for (const x of l) x.dispose();
    return g;
  }
}

// ---- canvas art (signs, stencils): original graphics drawn at load, no image assets -----------------------------
const FONT = '"Barlow Condensed", "Arial Black", "Segoe UI Black", "Noto Sans", system-ui, sans-serif';   // the UI's display face (ui.css)
function canvasTex(w: number, h: number, draw: (x: CanvasRenderingContext2D, w: number, h: number) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d')!, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
/** scuffs and chips: erase random specks and scratches so paint reads as worn */
function wear(x: CanvasRenderingContext2D, w: number, h: number, amount: number, seed = 7) {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  x.save();
  x.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < amount * 900; i++) {
    x.globalAlpha = 0.25 + rnd() * 0.6;
    const r = 1 + rnd() * rnd() * 9;
    x.beginPath(); x.ellipse(rnd() * w, rnd() * h, r, r * (0.4 + rnd()), rnd() * 3, 0, 7); x.fill();
  }
  x.lineCap = 'round';
  for (let i = 0; i < amount * 60; i++) {
    x.globalAlpha = 0.2 + rnd() * 0.4; x.lineWidth = 1 + rnd() * 3;
    const px = rnd() * w, py = rnd() * h, a = rnd() * 6.3, l = 20 + rnd() * 160;
    x.beginPath(); x.moveTo(px, py); x.lineTo(px + Math.cos(a) * l, py + Math.sin(a) * l); x.stroke();
  }
  x.restore();
}
function neonText(x: CanvasRenderingContext2D, text: string, px: number, py: number, size: number, color: string) {
  x.font = `italic 900 ${size}px ${FONT}`;
  x.textBaseline = 'middle';
  x.lineJoin = 'round';
  x.shadowColor = color;
  for (const [blur, lw, a] of [[60, 16, 0.5], [28, 12, 0.8], [10, 9, 1]] as const) {
    x.shadowBlur = blur; x.globalAlpha = a; x.strokeStyle = color; x.lineWidth = lw;
    x.strokeText(text, px, py);
  }
  x.shadowBlur = 0; x.globalAlpha = 1; x.strokeStyle = '#ffffff'; x.lineWidth = 3.5;
  x.strokeText(text, px, py);
}
const signTex = () => canvasTex(2048, 512, (x, w, h) => {
  x.clearRect(0, 0, w, h);
  neonText(x, 'OPEN', 250, h / 2 + 10, 400, '#eaf6ff');
  neonText(x, 'GRID', 1100, h / 2 + 10, 400, '#ff2d6a');
});
const muralTex = () => canvasTex(2048, 640, (x, w, h) => {
  x.clearRect(0, 0, w, h);
  // speed chevrons racing left to right, hot to cold
  const cols = ['#ff2d6a', '#ff5a3c', '#ffb02e', '#19d3ff', '#3a6bff'];
  for (let i = 0; i < 5; i++) {
    const x0 = 120 + i * 330, sk = 250;
    x.fillStyle = cols[i]; x.globalAlpha = 0.92;
    x.beginPath();
    x.moveTo(x0, h * 0.86); x.lineTo(x0 + sk, h * 0.5); x.lineTo(x0, h * 0.14);
    x.lineTo(x0 + 150, h * 0.14); x.lineTo(x0 + 150 + sk, h * 0.5); x.lineTo(x0 + 150, h * 0.86);
    x.closePath(); x.fill();
  }
  x.globalAlpha = 1;
  x.fillStyle = '#f2f4f8';
  x.font = `italic 900 76px ${FONT}`;
  x.fillText('NO LIMITS  ·  NIGHT SHIFT', 150, h - 26);
  wear(x, w, h, 1.6, 11);
});
const stencilTex = (text: string, color = '#e8e2d2') => canvasTex(512, 256, (x, w, h) => {
  x.clearRect(0, 0, w, h);
  x.fillStyle = color;
  x.font = `900 210px ${FONT}`;
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(text, w / 2, h / 2 + 10);
  wear(x, w, h, 0.5, text.charCodeAt(0));
});
const hazardTex = () => canvasTex(1024, 64, (x, w, h) => {
  x.fillStyle = '#16171a'; x.fillRect(0, 0, w, h);
  x.fillStyle = '#f2b90f';
  for (let i = -2; i < 20; i++) { x.beginPath(); x.moveTo(i * 64, h); x.lineTo(i * 64 + 32, h); x.lineTo(i * 64 + 96, 0); x.lineTo(i * 64 + 64, 0); x.closePath(); x.fill(); }
  wear(x, w, h, 0.35, 3);
});
const lineTex = () => canvasTex(64, 512, (x, w, h) => {
  x.clearRect(0, 0, w, h);
  x.fillStyle = '#e9b616'; x.fillRect(8, 0, w - 16, h);
  wear(x, w, h, 0.25, 5);
});
const officeTex = () => canvasTex(1024, 512, (x, w, h) => {
  const g = x.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#f2c184'); g.addColorStop(0.5, '#d98a3c'); g.addColorStop(1, '#5a2c10');
  x.fillStyle = g; x.fillRect(0, 0, w, h);
  // the room behind the glass, out of focus: shelves, a desk lamp, a monitor
  x.filter = 'blur(7px)';
  x.fillStyle = 'rgba(60,30,12,0.75)';
  for (let i = 0; i < 4; i++) x.fillRect(60 + i * 250, 120, 170, 16);
  for (let i = 0; i < 4; i++) x.fillRect(60 + i * 250, 250, 170, 16);
  x.fillRect(0, 380, w, 132);
  x.fillStyle = 'rgba(190,230,255,0.9)'; x.fillRect(620, 290, 150, 90);
  x.fillStyle = 'rgba(255,255,240,0.95)'; x.beginPath(); x.arc(250, 330, 26, 0, 7); x.fill();
  x.filter = 'none';
  // blinds
  x.fillStyle = 'rgba(30,16,8,0.42)';
  for (let y = 0; y < h; y += 20) x.fillRect(0, y, w, 9);
  // mullions
  x.fillStyle = '#0c0d10';
  for (let i = 0; i <= 4; i++) x.fillRect(i * (w / 4) - 7, 0, 14, h);
  x.fillRect(0, 0, w, 12); x.fillRect(0, h - 12, w, 12);
});
const screenTex = () => canvasTex(512, 320, (x, w, h) => {
  x.fillStyle = '#04101c'; x.fillRect(0, 0, w, h);
  x.strokeStyle = 'rgba(80,160,220,0.25)'; x.lineWidth = 1;
  for (let i = 1; i < 8; i++) { x.beginPath(); x.moveTo(i * 64, 30); x.lineTo(i * 64, h - 30); x.stroke(); }
  for (let i = 1; i < 5; i++) { x.beginPath(); x.moveTo(20, i * 64); x.lineTo(w - 20, i * 64); x.stroke(); }
  const curve = (col: string, k: number) => {
    x.strokeStyle = col; x.lineWidth = 5; x.shadowColor = col; x.shadowBlur = 12;
    x.beginPath();
    for (let i = 0; i <= 100; i++) { const t = i / 100, y = h - 40 - (Math.sin(t * 2.2 * k) * 0.85 + t * 0.25) * (h - 110); if (i) x.lineTo(30 + t * (w - 60), y); else x.moveTo(30, y); }
    x.stroke(); x.shadowBlur = 0;
  };
  curve('#ff2d6a', 0.78); curve('#19d3ff', 1.02);
  x.fillStyle = '#d8ecff'; x.font = `700 22px ${FONT}`; x.fillText('DYNO  ·  RUN 07', 30, 26);
});
const whiteTex = () => { const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true; return t; };

export interface GarageRoom {
  group: THREE.Group;
  bake: LightBake;
  floor: FloorHandle;
  floorMesh: THREE.Mesh;
  /** floor material without the mirror, for the environment capture */
  floorPlain: THREE.Material;
  /** parked-car spots: position + heading */
  bays: { x: number; z: number; ry: number }[];
}

const T = (n: string, m: string) => `/assets/garage/tex/${n}_${m}.ktx2`;
async function maps(name: string, nor = true, arm = false): Promise<SurfaceMaps> {
  const [diff, n, a] = await Promise.all([
    loadKTX2(T(name, 'diff'), true),
    nor ? loadKTX2(T(name, 'nor'), false) : Promise.resolve(undefined),
    arm ? loadKTX2(T(name, 'arm'), false) : Promise.resolve(undefined),
  ]);
  return { diff, nor: n, arm: a };
}

export async function buildRoom(env: THREE.Texture, lamps: [number, number][] = []): Promise<GarageRoom> {
  const [concreteF, brick, iron, shutter, deck, concreteW] = await Promise.all([
    maps('painted_concrete_02', true, true), maps('factory_brick'), maps('corrugated_iron_02', true, true),
    maps('painted_metal_shutter', true, true), maps('rubber_tiles'), maps('concrete_wall_008'),
  ]);
  // the signs are drawn with the UI's display face: wait for it (briefly), or they are baked in a fallback font
  await Promise.race([
    Promise.all([document.fonts.load('italic 900 120px "Barlow Condensed"'), document.fonts.load('700 120px "Barlow Condensed"')]).catch(() => undefined),
    new Promise((r) => setTimeout(r, 2500)),
  ]);
  const group = new THREE.Group();
  group.name = 'garage';
  const sh = new Shell();
  const bake = new LightBake();
  const emit: THREE.BufferGeometry[] = [];
  /** self-lit box; colour is HDR (it must bloom and read as a light in the paint) */
  const glow = (cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, color: THREE.ColorRepresentation, gain: number) => {
    const g = new THREE.BoxGeometry(sx, sy, sz).toNonIndexed();
    g.translate(cx, cy, cz);
    const c = new THREE.Color(color).multiplyScalar(gain);
    const a = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < a.length; i += 3) { a[i] = c.r; a[i + 1] = c.g; a[i + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    emit.push(g);
  };

  // ---- shell -----------------------------------------------------------------------------------------------
  sh.panel('floor', 0, 0, 0, hw * 2, hd * 2, 'py', 0.25);
  sh.panel('iron', 0, H, 0, hw * 2, hd * 2, 'ny', 1.0);
  const wall = (face: Face, cx: number, cz: number, len: number) => {
    sh.panel('brick', cx, BRICK_H / 2, cz, len, BRICK_H, face, 0.5);
    sh.panel('iron', cx, (BRICK_H + H) / 2, cz, len, H - BRICK_H, face, 0.6);
  };
  wall('pz', 0, -hd, hw * 2); wall('nz', 0, hd, hw * 2); wall('px', -hw, 0, hd * 2); wall('nx', hw, 0, hd * 2);
  // steel channel where brick meets cladding, and a skirting kerb
  for (const [cx, cz, sx, sz] of [[0, -hd + 0.04, hw * 2, 0.08], [0, hd - 0.04, hw * 2, 0.08], [-hw + 0.04, 0, 0.08, hd * 2], [hw - 0.04, 0, 0.08, hd * 2]] as const) {
    sh.box('steel', cx, BRICK_H, cz, sx, 0.14, sz);
    sh.box('concrete', cx, 0.09, cz, sx + 0.04, 0.18, sz + 0.04);
  }
  // concrete pilasters
  const pil = (cx: number, cz: number, sx: number, sz: number) => { sh.box('concrete', cx, H / 2, cz, sx, H, sz); bake.box(cx, H / 2, cz, sx, H, sz); };
  for (const x of [-6.25, 6.25]) { pil(x, -hd + 0.16, 0.55, 0.32); pil(x, hd - 0.16, 0.55, 0.32); }
  for (const z of [-3.0, 3.0]) { pil(-hw + 0.16, z, 0.32, 0.55); pil(hw - 0.16, z, 0.32, 0.55); }
  // roof steel: trusses across, purlins along, diagonal-free (cheap) but with a bottom chord for depth
  for (const z of [-6, -3, 0, 3, 6]) {
    sh.box('steel', 0, H - 0.22, z, hw * 2, 0.26, 0.16, 1.0);
    sh.box('steel', 0, H - 0.95, z, hw * 2, 0.1, 0.1, 1.0);
    for (let x = -hw + 1; x <= hw - 1; x += 2) sh.box('steel', x, H - 0.6, z, 0.07, 0.7, 0.07);
  }
  for (const x of [-8, -4, 0, 4, 8]) sh.box('steel', x, H - 0.06, 0, 0.1, 0.12, hd * 2, 1.0);
  // service runs: conduit along the back and side walls, a duct across the ceiling
  sh.tube('steel', 0, 4.55, -hd + 0.14, 0.05, hw * 2 - 0.6, 'x');
  sh.tube('steel', 0, 4.75, -hd + 0.14, 0.035, hw * 2 - 0.6, 'x');
  sh.tube('steel', -hw + 0.14, 4.4, 0, 0.05, hd * 2 - 0.6, 'z');
  sh.tube('duct', 6.6, H - 1.45, 0, 0.34, hd * 2 - 0.4, 'z', 14);
  for (const z of [-6, -3, 0, 3, 6]) sh.box('steel', 6.6, H - 0.75, z, 0.05, 0.9, 0.05);

  // ---- hero lighting: two long LED lines over the turntable (the ribbons in the paint) + cross bars ----------------
  const WHITE = 0xfff4e6, COOL = 0xcfe4ff;
  for (const x of [-1.95, 1.95]) {
    sh.box('steel', x, 4.36, 0, 0.2, 0.07, 9.3);
    glow(x, 4.31, 0, 0.12, 0.03, 9.1, WHITE, 16);
    for (const z of [-3, 0, 3]) sh.box('steel', x, 4.36 + (H - 0.95 - 4.36) / 2, z, 0.025, H - 0.95 - 4.36, 0.025);
    bake.line(new THREE.Vector3(x, 4.25, -4.5), new THREE.Vector3(x, 4.25, 4.5), WHITE, 7.5, 12, 1.0);
  }
  for (const z of [-5.4, 5.4]) {
    sh.box('steel', 0, 4.36, z, 5.4, 0.07, 0.2);
    glow(0, 4.31, z, 5.2, 0.03, 0.12, WHITE, 14);
    bake.line(new THREE.Vector3(-2.6, 4.25, z), new THREE.Vector3(2.6, 4.25, z), WHITE, 5.0, 11, 1.0);
  }
  // workshop tubes over the side bays
  for (const x of [-9.4, 9.4]) for (const z of [-4.5, -1.5, 1.5, 4.5]) {
    sh.box('steel', x, 4.92, z, 0.22, 0.06, 1.7);
    glow(x, 4.875, z, 0.1, 0.03, 1.55, COOL, 9);
    bake.line(new THREE.Vector3(x, 4.8, z - 0.7), new THREE.Vector3(x, 4.8, z + 0.7), COOL, 5.5, 10, 0.7);
  }

  // ---- back wall: neon sign, mural, corner tubes ---------------------------------------------------------------
  const decals: THREE.Mesh[] = [];
  const decal = (tex: THREE.Texture, cx: number, cy: number, cz: number, w: number, hgt: number, face: Face, gain = 1, emitK = 0, rotY = 0) => {
    const g = new THREE.PlaneGeometry(w, hgt, Math.max(1, Math.round(w / 0.5)), Math.max(1, Math.round(hgt / 0.5)));
    if (face === 'py') { g.rotateX(-Math.PI / 2); g.rotateY(rotY); }
    else if (face === 'nz') g.rotateY(Math.PI);
    else if (face === 'px') g.rotateY(Math.PI / 2);
    else if (face === 'nx') g.rotateY(-Math.PI / 2);
    g.translate(cx, cy, cz);
    bake.bake(g, false);
    const m = new THREE.Mesh(g, decalMaterial(tex, gain, emitK));
    m.renderOrder = 2;
    decals.push(m);
    return m;
  };
  const MAG = 0xff2d6a, CYAN = 0x19d3ff, AMBER = 0xffa64a;
  // (decals are baked after every light exists: see the end)
  const lateDecals: (() => void)[] = [];
  lateDecals.push(() => decal(signTex(), 0, 4.55, -hd + 0.2, 8.4, 2.1, 'pz', 0, 7));
  sh.box('steel', 0, 4.55, -hd + 0.1, 8.7, 2.3, 0.06);
  bake.line(new THREE.Vector3(-3.9, 4.5, -hd + 0.7), new THREE.Vector3(-0.3, 4.5, -hd + 0.7), 0xdff0ff, 3.4, 9, 0.9);
  bake.line(new THREE.Vector3(0.3, 4.5, -hd + 0.7), new THREE.Vector3(3.9, 4.5, -hd + 0.7), MAG, 5.2, 10, 0.9);
  lateDecals.push(() => decal(muralTex(), 0, 1.5, -hd + 0.012, 8.6, 2.6, 'pz', 1.05));
  for (const x of [-hw + 0.35, hw - 0.35]) {
    const c = x < 0 ? CYAN : MAG;
    glow(x, 2.9, -hd + 0.35, 0.05, 4.6, 0.05, c, 11);
    bake.line(new THREE.Vector3(x + Math.sign(-x) * 0.3, 0.9, -hd + 0.6), new THREE.Vector3(x + Math.sign(-x) * 0.3, 4.9, -hd + 0.6), c, 2.6, 8, 0.8);
  }

  // ---- front wall: two roller doors ---------------------------------------------------------------------------
  for (const [i, x] of [-3.7, 3.7].entries()) {
    sh.panel('shutter', x, 1.95, hd - 0.06, 4.5, 3.9, 'nz', 0.5);
    sh.box('concrete', x, 4.05, hd - 0.14, 5.0, 0.3, 0.28);                 // lintel
    for (const s of [-1, 1]) sh.box('steel', x + s * 2.34, 1.95, hd - 0.1, 0.14, 3.9, 0.16);   // guides
    sh.box('steel', x, 4.32, hd - 0.2, 4.6, 0.3, 0.34);                    // roller housing
    lateDecals.push(() => decal(hazardTex(), x, 0.14, hd - 0.075, 4.4, 0.26, 'nz', 1.1));
    lateDecals.push(() => decal(stencilTex(`0${i + 1}`), x, 3.1, hd - 0.085, 1.5, 0.75, 'nz', 0.9));
    // bulkhead lamp over each door
    sh.box('steel', x, 4.85, hd - 0.16, 0.5, 0.16, 0.22);
    glow(x, 4.76, hd - 0.2, 0.42, 0.04, 0.16, AMBER, 10);
    bake.spot(x, 4.7, hd - 0.45, x, 0, hd - 1.6, AMBER, 26, 10, 0.5, 1.15);
  }
  sh.box('concrete', 0, 2.1, hd - 0.12, 1.5, 4.2, 0.24);

  // ---- office in the back-left corner: warm glass box ----------------------------------------------------------
  {
    const x0 = -hw, x1 = -8.3, z0 = -hd, z1 = -5.0, oh = 3.0;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, sx = x1 - x0, sz = z1 - z0;
    sh.box('panel', cx, 0.45, cz, sx, 0.9, sz);                             // dwarf wall
    sh.box('panel', cx, oh - 0.12, cz, sx + 0.1, 0.24, sz + 0.1);           // roof slab
    sh.box('steel', x1, oh / 2, z1, 0.14, oh, 0.14);                        // corner post
    bake.box(cx, oh / 2, cz, sx, oh, sz);
    const glass = officeTex();
    const glassMat = (rx: number) => { const t = glass.clone(); t.repeat.set(rx, 1); t.wrapS = THREE.RepeatWrapping; t.needsUpdate = true; return t; };
    lateDecals.push(() => decal(glassMat(1), x1 + 0.01, 1.89, cz, sz - 0.1, 1.98, 'px', 0, 1.15));
    lateDecals.push(() => decal(glassMat(1), cx, 1.89, z1 + 0.01, sx - 0.1, 1.98, 'pz', 0, 1.15));
    bake.point(x1 + 0.9, 1.9, cz, 0xffb866, 9, 7, true);
    bake.point(cx, 1.9, z1 + 0.9, 0xffb866, 9, 7, true);
  }

  // ---- right wall: dyno screen ---------------------------------------------------------------------------------
  sh.box('steel', hw - 0.1, 2.25, 0.2, 0.1, 1.2, 1.9);
  lateDecals.push(() => decal(screenTex(), hw - 0.16, 2.25, 0.2, 1.75, 1.08, 'nx', 0, 3.2));
  bake.point(hw - 1.0, 2.2, 0.2, 0x6cc6ff, 5, 5, true);

  // ---- floor graphics --------------------------------------------------------------------------------------------
  const lt = lineTex();
  const floorLine = (x: number, z: number, len: number, rotY: number) => lateDecals.push(() => decal(lt, x, 0.006, z, 0.14, len, 'py', 1, 0, rotY));
  for (const s of [-1, 1]) {
    floorLine(s * 7.55, 0, 7.0, 0);
    floorLine(s * 11.25, 0, 7.0, 0);
    floorLine(s * 9.4, -3.5, 3.84, Math.PI / 2);
  }
  lateDecals.push(() => decal(stencilTex('B1', '#d9d2c0'), -9.4, 0.006, 4.3, 1.5, 0.75, 'py', 0.9, 0, 0));
  lateDecals.push(() => decal(stencilTex('B2', '#d9d2c0'), 9.4, 0.006, 4.3, 1.5, 0.75, 'py', 0.9, 0, 0));

  // ---- the cars' shadows in the bake: the hero on the deck and one per bay ----------------------------------------
  const bays = [{ x: -9.4, z: 0.1, ry: Math.PI - 0.26 }, { x: 9.4, z: -0.2, ry: -0.24 }];
  bake.box(0, 0.5, 0.05, 1.7, 0.72, 4.2);
  for (const b of bays) bake.box(b.x, 0.5, b.z, 2.2, 0.7, 4.0);
  // hanging lamps (props.ts LAMPS): a warm pool under each
  for (const [x, z] of lamps) bake.spot(x, 4.15, z, x, 0, z, 0xffc98a, 30, 9, 0.45, 1.05);
  // LED ring glow on the floor around the deck
  for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2; bake.point(Math.cos(a) * 3.3, 0.25, Math.sin(a) * 3.3, 0x8fd8ff, 0.5, 2.6, true); }

  // ---- materials + meshes ----------------------------------------------------------------------------------------
  const white = whiteTex();
  const mats: Record<string, THREE.Material> = {
    brick: bakedMaterial(brick, env, { tile: 2.4, tint: 0x9a8f8a, bump: 1.3, relief: 0.9, rough: 0.92 }),
    iron: bakedMaterial(iron, env, { tile: 2.0, tint: 0x8f9bb0, bump: 1.0, relief: 0.85, env: 0.5, gloss: 0.5, rough: 0.9 }),
    shutter: bakedMaterial(shutter, env, { tile: 2.2, tint: 0xa8b4c8, bump: 1.2, relief: 0.9, env: 0.45, gloss: 0.6, rough: 0.9 }),
    concrete: bakedMaterial(concreteW, env, { tile: 2.2, tint: 0xb0b4bc, relief: 0.6, rough: 0.9 }),
    steel: bakedMaterial({ diff: white }, env, { tile: 1, tint: 0x1b1f27, rough: 0.5, metal: 0.6, env: 0.6, gloss: 0.35 }),
    duct: bakedMaterial({ diff: white }, env, { tile: 1, tint: 0x8a94a2, rough: 0.34, metal: 0.9, env: 0.9, gloss: 0.5 }),
    panel: bakedMaterial({ diff: white }, env, { tile: 1, tint: 0x232a36, rough: 0.55, metal: 0.3, env: 0.35, gloss: 0.2 }),
  };
  const floor = floorMaterial(concreteF, deck, env, ROOM.deck);
  const floorPlain = bakedMaterial(concreteF, env, { tile: 3.2, tint: 0x8088a0, rough: 0.6, gain: 0.8 });
  let floorMesh: THREE.Mesh | null = null;
  for (const key of sh.keys()) {
    const g = sh.merged(key);
    if (!g) continue;
    bake.bake(g, key !== 'steel' && key !== 'duct');
    g.deleteAttribute('uv');
    const mesh = new THREE.Mesh(g, key === 'floor' ? floor.material : mats[key]);
    mesh.name = `garage_${key}`;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
    if (key === 'floor') floorMesh = mesh;
  }
  group.add(floor.target);
  for (const f of lateDecals) f();
  for (const d of decals) { d.matrixAutoUpdate = false; group.add(d); }
  const eg = mergeGeometries(emit, false);
  for (const g of emit) g.dispose();
  eg.deleteAttribute('uv'); eg.deleteAttribute('normal');
  const em = new THREE.Mesh(eg, emissiveMaterial());
  em.name = 'garage_lights';
  em.matrixAutoUpdate = false;
  group.add(em);

  return { group, bake, floor, floorMesh: floorMesh!, floorPlain, bays };
}

/** Soft additive light shaft under a hanging lamp (no volumetrics: a cone that fades with height and at its edges). */
export function lightShaft(color: THREE.ColorRepresentation, top = 0.16, bottom = 1.7, height = 3.6, strength = 0.2): THREE.Mesh {
  const g = new THREE.CylinderGeometry(top, bottom, height, 28, 1, true);
  g.translate(0, -height / 2, 0);
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false });
  const c = new THREE.Color(color);
  const facing = pow(abs(dot(normalView.normalize(), positionViewDirection.normalize())), 1.6);
  const fall = pow(uv().y, 1.8);
  m.colorNode = vec4(vec3(c.r, c.g, c.b).mul(fall.mul(facing).mul(strength)), 1);
  const mesh = new THREE.Mesh(g, m);
  mesh.renderOrder = 5;
  return mesh;
}
