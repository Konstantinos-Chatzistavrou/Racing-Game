// Static light bake for the garage. The room never changes, so its lighting is computed ONCE on the CPU, per vertex,
// and stored in two attributes that the room's unlit materials read (scene/garage/materials.ts):
//   color (vec3) - irradiance arriving at the vertex, linear HDR
//   ldir  (vec3) - the direction most of that light comes from (normal maps shade against it, so brick and
//                  corrugated steel keep their relief without any real-time light)
// Why: every real-time light costs every pixel it can reach (measured on the i3 iGPU at 1080p: about 2.5 ms per
// overlapping light), and the old garage had ~50 of them. Baked, the room can have as many light sources as it wants
// for the price of a vertex attribute. Occlusion is a ray against a short list of boxes (props, pillars, parked cars):
// soft at vertex resolution, which is what a workshop lit by many ceiling fixtures looks like anyway.
import * as THREE from 'three/webgpu';

export interface BakeLight {
  pos: THREE.Vector3;
  color: THREE.Color;
  /** candela-like strength: irradiance = intensity * cos / (d^2 + 1) */
  intensity: number;
  range: number;
  /** spot: unit direction + cosines of the inner / outer half-angle. Omitted = point light. */
  dir?: THREE.Vector3;
  cosInner?: number;
  cosOuter?: number;
  /** lights that never cast a shadow (glow strips at floor level, neon washes) */
  noShadow?: boolean;
}

export interface Occluder { min: THREE.Vector3; max: THREE.Vector3 }

export class LightBake {
  readonly lights: BakeLight[] = [];
  readonly occluders: Occluder[] = [];
  /** flat fill so nothing is pure black: sky colour from above, ground bounce from below */
  ambientSky = new THREE.Color(0.020, 0.026, 0.040);
  ambientGround = new THREE.Color(0.012, 0.010, 0.010);

  point(x: number, y: number, z: number, color: THREE.ColorRepresentation, intensity: number, range: number, noShadow = false) {
    this.lights.push({ pos: new THREE.Vector3(x, y, z), color: new THREE.Color(color), intensity, range, noShadow });
  }

  /** A cone aimed at (tx, ty, tz); angles in radians (half-angles). */
  spot(x: number, y: number, z: number, tx: number, ty: number, tz: number, color: THREE.ColorRepresentation, intensity: number, range: number, inner = 0.5, outer = 0.9, noShadow = false) {
    const pos = new THREE.Vector3(x, y, z);
    this.lights.push({ pos, color: new THREE.Color(color), intensity, range, dir: new THREE.Vector3(tx, ty, tz).sub(pos).normalize(), cosInner: Math.cos(inner), cosOuter: Math.cos(outer), noShadow });
  }

  /** A tube / LED line: a row of downward-biased point lights along it. */
  line(a: THREE.Vector3, b: THREE.Vector3, color: THREE.ColorRepresentation, intensityPerMetre: number, range: number, step = 1.0) {
    const len = a.distanceTo(b), n = Math.max(1, Math.round(len / step));
    for (let i = 0; i < n; i++) {
      const p = a.clone().lerp(b, (i + 0.5) / n);
      this.lights.push({ pos: p, color: new THREE.Color(color), intensity: intensityPerMetre * len / n, range });
    }
  }

  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number) {
    this.occluders.push({ min: new THREE.Vector3(cx - sx / 2, cy - sy / 2, cz - sz / 2), max: new THREE.Vector3(cx + sx / 2, cy + sy / 2, cz + sz / 2) });
  }

  /** Slab test: is the segment p -> q blocked by any occluder? The first and last 4 cm are ignored (self-hits). */
  private blocked(px: number, py: number, pz: number, qx: number, qy: number, qz: number): boolean {
    const dx = qx - px, dy = qy - py, dz = qz - pz;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.1) return false;
    const t0 = 0.04 / len, t1 = 1 - 0.04 / len;
    const ix = 1 / (dx || 1e-9), iy = 1 / (dy || 1e-9), iz = 1 / (dz || 1e-9);
    for (const o of this.occluders) {
      let a = (o.min.x - px) * ix, b = (o.max.x - px) * ix;
      let tmin = Math.min(a, b), tmax = Math.max(a, b);
      a = (o.min.y - py) * iy; b = (o.max.y - py) * iy;
      tmin = Math.max(tmin, Math.min(a, b)); tmax = Math.min(tmax, Math.max(a, b));
      if (tmax < tmin) continue;
      a = (o.min.z - pz) * iz; b = (o.max.z - pz) * iz;
      tmin = Math.max(tmin, Math.min(a, b)); tmax = Math.min(tmax, Math.max(a, b));
      if (tmax >= Math.max(tmin, t0) && tmin <= t1) return true;
    }
    return false;
  }

  /** Irradiance at a point with a normal (also used to match loose props to the light where they stand). */
  sample(px: number, py: number, pz: number, nx: number, ny: number, nz: number, out: Float32Array | number[], o = 0, dirOut?: Float32Array | number[], shadows = true) {
    const up = ny * 0.5 + 0.5;
    let r = this.ambientGround.r + (this.ambientSky.r - this.ambientGround.r) * up;
    let g = this.ambientGround.g + (this.ambientSky.g - this.ambientGround.g) * up;
    let b = this.ambientGround.b + (this.ambientSky.b - this.ambientGround.b) * up;
    let lx = nx * 0.02, ly = ny * 0.02, lz = nz * 0.02;
    for (const L of this.lights) {
      const dx = L.pos.x - px, dy = L.pos.y - py, dz = L.pos.z - pz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > L.range * L.range) continue;
      const d = Math.sqrt(d2), ux = dx / d, uy = dy / d, uz = dz / d;
      // wrapped Lambert (0.25): surfaces turning away from a fixture fall off softly, as under a large source
      const cos = (ux * nx + uy * ny + uz * nz + 0.25) / 1.25;
      if (cos <= 0) continue;
      let k = L.intensity * cos / (d2 + 1);
      const w = 1 - d / L.range;
      k *= w * w * (3 - 2 * w) * 1.0;   // smooth window to zero at the range
      if (L.dir) {
        const c = -(ux * L.dir.x + uy * L.dir.y + uz * L.dir.z);
        if (c <= L.cosOuter!) continue;
        const s = Math.min(1, (c - L.cosOuter!) / Math.max(1e-4, L.cosInner! - L.cosOuter!));
        k *= s * s * (3 - 2 * s);
      }
      if (k < 1e-4) continue;
      if (shadows && !L.noShadow && this.blocked(px + nx * 0.03, py + ny * 0.03, pz + nz * 0.03, L.pos.x, L.pos.y, L.pos.z)) k *= 0.12;
      r += L.color.r * k; g += L.color.g * k; b += L.color.b * k;
      const lum = (L.color.r * 0.2126 + L.color.g * 0.7152 + L.color.b * 0.0722) * k;
      lx += ux * lum; ly += uy * lum; lz += uz * lum;
    }
    out[o] = r; out[o + 1] = g; out[o + 2] = b;
    if (dirOut) {
      const l = Math.hypot(lx, ly, lz) || 1;
      dirOut[o] = lx / l; dirOut[o + 1] = ly / l; dirOut[o + 2] = lz / l;
    }
  }

  /** Bake a world-space geometry in place: adds `color` and `ldir`. */
  bake(geo: THREE.BufferGeometry, shadows = true) {
    const pos = geo.attributes.position, nor = geo.attributes.normal;
    const n = pos.count;
    const col = new Float32Array(n * 3), dir = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      this.sample(pos.getX(i), pos.getY(i), pos.getZ(i), nor.getX(i), nor.getY(i), nor.getZ(i), col, i * 3, dir, shadows);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('ldir', new THREE.BufferAttribute(dir, 3));
  }
}
