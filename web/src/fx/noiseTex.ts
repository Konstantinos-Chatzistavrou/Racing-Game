// Precomputed noise for the per-pixel shaders. The road alone evaluated six 2D Perlin noises and a Worley noise for
// every pixel (MaterialX node functions: ~40 and ~120 arithmetic ops each); on the laptop's iGPU the ground cost about
// 4 ms of a 20 ms frame. Here the same fields come from two small tiling textures, one bilinear read each:
//   noise01(p) - 2D gradient noise in 0..1, one lattice cell per unit of p, same gradient set and scale as
//                MaterialX's mx_perlin_noise_float (so thresholds tuned against it keep their meaning); period 32
//   worleyEdge(p) - F2 - F1 of a jittered cell field (0 on the borders between cells), period 16
// Both are mipmapped: far away they fade to their mean on their own instead of shimmering.
import * as THREE from 'three/webgpu';
import { texture } from 'three/tsl';

const PERIOD = 32, RES = 512;
let noiseTex: THREE.DataTexture | null = null, worleyTex: THREE.DataTexture | null = null;

function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

function buildNoise(): THREE.DataTexture {
  const rnd = rng(0x9e3779b9);
  // one of MaterialX's 8 two-dimensional gradients per lattice point: (+-1, +-2) and (+-2, +-1)
  const gx = new Float32Array(PERIOD * PERIOD), gy = new Float32Array(PERIOD * PERIOD);
  for (let i = 0; i < gx.length; i++) {
    const h = Math.floor(rnd() * 8), a = h & 1 ? -1 : 1, b = h & 2 ? -2 : 2;
    if (h < 4) { gx[i] = a; gy[i] = b; } else { gx[i] = b; gy[i] = a; }
  }
  const data = new Uint16Array(RES * RES);
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const g = (ix: number, iy: number, dx: number, dy: number) => { const k = (iy % PERIOD) * PERIOD + (ix % PERIOD); return gx[k] * dx + gy[k] * dy; };
  for (let y = 0; y < RES; y++) for (let x = 0; x < RES; x++) {
    const fx = ((x + 0.5) / RES) * PERIOD, fy = ((y + 0.5) / RES) * PERIOD;
    const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy, u = fade(tx), v = fade(ty);
    const a = g(ix, iy, tx, ty), b = g(ix + 1, iy, tx - 1, ty), c = g(ix, iy + 1, tx, ty - 1), d = g(ix + 1, iy + 1, tx - 1, ty - 1);
    const n = (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 0.6616;   // mx_gradient_scale2d
    data[y * RES + x] = THREE.DataUtils.toHalfFloat(Math.min(1, Math.max(0, n * 0.5 + 0.5)));
  }
  return finish(new THREE.DataTexture(data, RES, RES, THREE.RedFormat, THREE.HalfFloatType));
}

function buildWorley(): THREE.DataTexture {
  const C = 16, rnd = rng(0x51ed270b);
  const px = new Float32Array(C * C), py = new Float32Array(C * C);
  for (let i = 0; i < px.length; i++) { px[i] = rnd(); py[i] = rnd(); }
  const data = new Uint16Array(RES * RES);
  for (let y = 0; y < RES; y++) for (let x = 0; x < RES; x++) {
    const fx = ((x + 0.5) / RES) * C, fy = ((y + 0.5) / RES) * C, ix = Math.floor(fx), iy = Math.floor(fy);
    let f1 = 9, f2 = 9;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const cx = ix + ox, cy = iy + oy, k = (((cy % C) + C) % C) * C + (((cx % C) + C) % C);
      const d = Math.hypot(cx + px[k] - fx, cy + py[k] - fy);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
    }
    data[y * RES + x] = THREE.DataUtils.toHalfFloat(f2 - f1);
  }
  return finish(new THREE.DataTexture(data, RES, RES, THREE.RedFormat, THREE.HalfFloatType));
}

function finish(t: THREE.DataTexture): THREE.DataTexture {
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

type V2 = THREE.Node<'vec2'>;
/** 2D gradient noise in 0..1 (0.5 mean), one cell per unit of `p`. */
export function noise01(p: V2): THREE.Node<'float'> {
  noiseTex ??= buildNoise();
  return texture(noiseTex, p.div(PERIOD)).r as unknown as THREE.Node<'float'>;
}
/** the same noise in -1..1 (drop-in for mx_noise_float) */
export function noise11(p: V2): THREE.Node<'float'> { return noise01(p).mul(2).sub(1) as unknown as THREE.Node<'float'>; }
/** F2 - F1 of a cell field, one cell per unit of `p`: 0 exactly on the cell borders (crack lines) */
export function worleyEdge(p: V2): THREE.Node<'float'> {
  worleyTex ??= buildWorley();
  return texture(worleyTex, p.div(16)).r as unknown as THREE.Node<'float'>;
}
