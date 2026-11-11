// A generated night-city environment map for potato mode: what the car's paint and the wet road reflect.
//
// The normal boot captures the real street into a cube (PMREMGenerator.fromScene), which compiles every city material
// a second time for the cube pass: 44 render pipelines and 4 s of a throttled load, minutes on a Mali. This draws the
// same idea into a 128 x 64 equirectangular HDR texture instead (dark sky, a warm haze at the horizon, rows of sodium
// lamps, a few neon signs, lit windows, a dim wet ground) and prefilters that: one small pipeline.
import * as THREE from 'three/webgpu';

export function nightEnvTexture(): THREE.DataTexture {
  const W = 128, H = 64, d = new Float32Array(W * H * 4);
  let seed = 20261111;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const add = (x: number, y: number, r: number, g: number, b: number) => {
    const i = (((y % H) + H) % H * W + ((x % W) + W) % W) * 4;
    d[i] += r; d[i + 1] += g; d[i + 2] += b;
  };
  for (let y = 0; y < H; y++) {
    const el = (y / (H - 1) - 0.5) * Math.PI;   // -90 deg (down) .. +90 deg (up); row 0 is the bottom of the texture
    const haze = Math.exp(-((el - 0.05) ** 2) / 0.03);
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (el < 0) { d[i] = 0.020 + 0.05 * haze; d[i + 1] = 0.014 + 0.032 * haze; d[i + 2] = 0.012 + 0.02 * haze; }   // wet asphalt under sodium light
      else { d[i] = 0.008 + 0.07 * haze; d[i + 1] = 0.010 + 0.045 * haze; d[i + 2] = 0.022 + 0.04 * haze; }          // sky: blue-black, warm at the horizon
      d[i + 3] = 1;
    }
  }
  const row = (deg: number) => Math.round((deg / 180 + 0.5) * (H - 1));
  // street lamps: two rows either side, warm, bright enough to streak along the paint
  for (let k = 0; k < 26; k++) { const x = Math.floor(rnd() * W), y = row(6 + rnd() * 16), s = 14 + rnd() * 22; add(x, y, s, s * 0.62, s * 0.26); add(x, y - 1, s * 0.3, s * 0.18, s * 0.07); }
  // neon signs: short coloured bars
  const NEON = [[1, 0.12, 0.38], [0.1, 0.75, 1], [1, 0.45, 0.08], [0.55, 0.2, 1]];
  for (let k = 0; k < 9; k++) {
    const c = NEON[k % NEON.length], x = Math.floor(rnd() * W), y = row(3 + rnd() * 22), s = 5 + rnd() * 7, len = 2 + Math.floor(rnd() * 3);
    for (let j = 0; j < len; j++) add(x + j, y, c[0] * s, c[1] * s, c[2] * s);
  }
  // lit windows up the towers
  for (let k = 0; k < 90; k++) { const s = 0.5 + rnd() * 1.6; add(Math.floor(rnd() * W), row(8 + rnd() * 50), s, s * 0.82, s * 0.55); }
  // the lamps' glow on the wet road, straight below them
  for (let k = 0; k < 14; k++) { const s = 0.6 + rnd() * 1.2; add(Math.floor(rnd() * W), row(-4 - rnd() * 22), s, s * 0.6, s * 0.26); }
  const tex = new THREE.DataTexture(d, W, H, THREE.RGBAFormat, THREE.FloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}
