// Final-image look, folded into the existing tone-map stage and the final upscale pass (0 extra
// passes). `toneGrade` replaces renderOutput(): HDR linear -> exposure -> tone curve -> sRGB ->
// analytic grade (contrast, lift/gamma, saturation, teal/orange split tone) -> triangular
// dither (kills banding in the dark gradients when the result is stored in 8 bit).
// `filmGrain` runs per CANVAS pixel in the last pass (grain at the render size would be blotchy
// after the upscale). All strengths are uniforms (tweak at runtime through GRADE).
import * as THREE from 'three/webgpu';
import { Fn, abs, acesFilmicToneMapping, agxToneMapping, exp, float, floor, mix, neutralToneMapping, pow, renderOutput, screenCoordinate, smoothstep, step, time, uniform, vec3, vec4 } from 'three/tsl';

export type CurveName = 'agx' | 'aces' | 'neutral' | 'uchimura';
export const CURVES: CurveName[] = ['agx', 'aces', 'neutral', 'uchimura'];

type Node3 = THREE.Node<'vec3'>;
type F = THREE.Node<'float'>;

/** Runtime knobs. */
export const GRADE = {
  exposure: uniform(1.45),
  contrast: uniform(0.1),       // 0..1 blend toward a smoothstep S-curve in display space
  lift: uniform(0.006),          // raises the black point a hair: no crushed void, hides banding
  gamma: uniform(1.0),
  sat: uniform(1.08),
  shadowTint: uniform(new THREE.Vector3(0.0, 0.10, 0.16)),   // teal, added in shadows
  highlightTint: uniform(new THREE.Vector3(0.16, 0.08, 0.0)), // warm orange, added in highlights
  split: uniform(0.25),
  dither: uniform(1.0),
  grain: uniform(0.009),
};

/**
 * A named look is just a set of the uniforms above. Nothing here is applied by default.
 *
 * `natural`  - exactly the numbers the game ships with today (documented so a look can be compared against it).
 * `underground` - the Need for Speed Underground direction (docs/art_direction.md): more exposure in the lights,
 *   harder contrast, saturated colour, a magenta lift in the highlights against teal shadows, a touch more grain.
 *   The lead tunes it against screenshots: `?look=underground` turns it on, and the per-knob overrides
 *   (`?contrast= ?sat= ?split= ?lift= ?exposure= ?grain=`) win over it when both are given.
 */
export interface Look {
  exposure: number; contrast: number; lift: number; gamma: number; sat: number; split: number; grain: number;
  shadowTint: [number, number, number]; highlightTint: [number, number, number];
}
export const LOOKS: Record<string, Look> = {
  natural: { exposure: 1.45, contrast: 0.1, lift: 0.006, gamma: 1.0, sat: 1.08, split: 0.25, grain: 0.009, shadowTint: [0.0, 0.10, 0.16], highlightTint: [0.16, 0.08, 0.0] },
  underground: { exposure: 1.62, contrast: 0.3, lift: 0.012, gamma: 1.04, sat: 1.34, split: 0.55, grain: 0.014, shadowTint: [-0.01, 0.10, 0.24], highlightTint: [0.26, 0.05, 0.20] },
  // Heat: a hot magenta/purple night with cyan-black shadows, stronger contrast and a lifted, coloured black point.
  heat: { exposure: 1.56, contrast: 0.34, lift: 0.014, gamma: 1.03, sat: 1.42, split: 0.62, grain: 0.012, shadowTint: [-0.015, 0.055, 0.26], highlightTint: [0.33, 0.045, 0.24] },
};
/** Apply a named look to the live uniforms (called by post.ts for ?look=; safe at any time). */
export function applyLook(name: string) {
  const l = LOOKS[name];
  GRADE.exposure.value = l.exposure;
  GRADE.contrast.value = l.contrast;
  GRADE.lift.value = l.lift;
  GRADE.gamma.value = l.gamma;
  GRADE.sat.value = l.sat;
  GRADE.split.value = l.split;
  GRADE.grain.value = l.grain;
  GRADE.shadowTint.value.set(...l.shadowTint);
  GRADE.highlightTint.value.set(...l.highlightTint);
}

/** Uchimura "GT" curve (Gran Turismo), per channel, linear in/out, P = 1. */
const uchimura = Fn(([x]: [F]) => {
  const P = 1.0, a = 1.0, m = 0.22, l = 0.4, c = 1.33, b = 0.0;
  const l0 = ((P - m) * l) / a, S0 = m + l0, S1 = m + a * l0, C2 = (a * P) / (P - S1), CP = -C2 / P;
  const w0 = float(1).sub(smoothstep(0, m, x));
  const w2 = step(m + l0, x);
  const w1 = float(1).sub(w0).sub(w2);
  const T = float(m).mul(pow(x.div(m).max(1e-5), c)).add(b);
  const S = float(P).sub(float(P - S1).mul(exp(x.sub(S0).mul(CP))));
  const L = x.sub(m).mul(a).add(m);
  return T.mul(w0).add(L.mul(w1)).add(S.mul(w2));
});

const luma = (c: Node3) => c.dot(vec3(0.2126, 0.7152, 0.0722));

/** Interleaved gradient noise (Jimenez), 0..1, from the pixel coordinate. */
const ign = (p: THREE.Node<'vec2'>, off: F) => {
  const q = p.add(off.mul(5.588238));
  return q.x.mul(0.06711056).add(q.y.mul(0.00583715)).fract().mul(52.9829189).fract();
};

/** HDR linear (scene + bloom) -> display-referred sRGB 0..1, graded and dithered. */
export function toneGrade(hdr: THREE.Node, curve: CurveName, full: boolean): THREE.Node<'vec4'> {
  const rgb = (hdr as THREE.Node<'vec4'>).rgb;
  let lin: Node3;
  if (curve === 'agx') lin = agxToneMapping(rgb, GRADE.exposure) as Node3;
  else if (curve === 'aces') lin = acesFilmicToneMapping(rgb, GRADE.exposure) as Node3;
  else if (curve === 'neutral') lin = neutralToneMapping(rgb, GRADE.exposure) as Node3;
  else {
    const e = rgb.mul(GRADE.exposure);
    lin = vec3(uchimura(e.x), uchimura(e.y), uchimura(e.z));
  }
  let c = renderOutput(vec4(lin, 1), THREE.NoToneMapping, THREE.SRGBColorSpace).rgb as Node3;
  if (full) {
    c = c.clamp(0, 1);
    // contrast: blend with a smoothstep S-curve (keeps black and white fixed)
    c = mix(c, c.mul(c).mul(c.mul(-2).add(3)), GRADE.contrast);
    // lift (black point), gamma
    c = c.mul(float(1).sub(GRADE.lift)).add(GRADE.lift);
    c = pow(c.max(0), vec3(float(1).div(GRADE.gamma)));
    // saturation about the luma
    const l = luma(c);
    c = mix(vec3(l), c, GRADE.sat);
    // split toning: teal in the shadows, warm in the highlights
    const ws = float(1).sub(smoothstep(0.0, 0.45, l));
    const wh = smoothstep(0.5, 1.0, l);
    c = c.add(GRADE.shadowTint.mul(ws).add(GRADE.highlightTint.mul(wh)).mul(GRADE.split));
  }
  // triangular dither, +-1 LSB of the 8 bit target
  const p = screenCoordinate;
  const tri = ign(p, float(0)).add(ign(p, float(1))).sub(1);
  c = c.add(tri.mul(GRADE.dither).div(255));
  return vec4(c.clamp(0, 1), 1);
}

/** Animated film grain on the final (canvas resolution) colour; strongest in the mid-tones. */
export function filmGrain(c: THREE.Node<'vec3'>): THREE.Node<'vec3'> {
  const t = floor(time.mul(24)).mod(64);   // 24 grain frames per second
  const n = ign(screenCoordinate, t).sub(0.5);
  const w = float(1).sub(abs(luma(c).mul(2).sub(1)).mul(0.6));   // 1 in mid-tones, 0.4 at black/white
  return c.add(vec3(n.mul(2).mul(GRADE.grain).mul(w)));
}
