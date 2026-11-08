// Number plates with the driver's name: the player's username, a rival's #BotN, another player's username. A name that does
// not fit a plate (username.ts PLATE_MAX) gets a registration of its own (stable per name). The plate is the models' "plate"
// quad (UV 0..1, 4:1 texture); each car gets its own material clone with a canvas texture, made once per name.
import * as THREE from 'three/webgpu';
import { plateText, registration } from '../username';

const W = 1024, H = 256;
const cache = new Map<string, THREE.CanvasTexture>();

/** The plate texture for a name (cached: rivals and repeat names share it). */
export function plateTexture(name: string): THREE.CanvasTexture {
  const text = plateText(name) ?? registration(name);
  let t = cache.get(text);
  if (t) return t;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d')!;
  // reflective white sheeting, a faint vertical sheen, a dark rolled border with rounded corners
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#f6f7f4'); grad.addColorStop(0.55, '#e9ebe6'); grad.addColorStop(1, '#d9dcd6');
  g.fillStyle = '#20242c';
  g.beginPath(); g.roundRect(0, 0, W, H, 34); g.fill();
  g.fillStyle = grad;
  g.beginPath(); g.roundRect(12, 12, W - 24, H - 24, 26); g.fill();
  g.strokeStyle = '#1b2a4a'; g.lineWidth = 6;
  g.beginPath(); g.roundRect(26, 26, W - 52, H - 52, 18); g.stroke();
  // bolt holes
  g.fillStyle = '#9aa0a6';
  for (const x of [150, W - 150]) { g.beginPath(); g.arc(x, 46, 9, 0, Math.PI * 2); g.fill(); }
  // the characters: embossed dark navy, condensed to fit; the model's quad is 3.27:1 against the 4:1 texture, so the
  // glyphs are drawn 0.82x as wide to look upright on the car
  g.textAlign = 'center'; g.textBaseline = 'middle';
  let size = 176;
  g.font = `800 ${size}px "Arial Narrow", "Roboto Condensed", "Helvetica Neue", Arial, sans-serif`;
  const room = (W - 120) / 0.82;
  const wid = g.measureText(text).width;
  if (wid > room) { size = Math.floor(size * room / wid); g.font = `800 ${size}px "Arial Narrow", "Roboto Condensed", "Helvetica Neue", Arial, sans-serif`; }
  g.save();
  g.translate(W / 2, H / 2 + 10); g.scale(0.82, 1);
  g.fillStyle = '#ffffff99'; g.fillText(text, 2, 3);       // emboss highlight
  g.fillStyle = '#16233f'; g.fillText(text, 0, 0);
  g.restore();
  t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.flipY = false;   // the models' UVs follow glTF (origin top-left), like the plate texture they shipped with
  t.anisotropy = 8;
  t.name = `plate_${text}`;
  cache.set(text, t);
  return t;
}

/** Put `name` on every plate of a car model (its own material clone per mesh, made once, the map swapped after). */
export function applyPlate(model: THREE.Object3D, name: string) {
  const map = plateTexture(name);
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || Array.isArray(m.material)) return;
    const mat = m.material as THREE.MeshStandardMaterial;
    if (m.name !== 'plate' && mat.name !== 'plate') return;
    if (!m.userData.ownPlate) { m.material = mat.clone(); m.userData.ownPlate = true; }
    const own = m.material as THREE.MeshStandardMaterial;
    // swapping one map for another keeps the shader (three reads material.map through a reference node): no recompile
    if (own.map !== map) { const had = !!own.map; own.map = map; if (!had) own.needsUpdate = true; }
  });
}
