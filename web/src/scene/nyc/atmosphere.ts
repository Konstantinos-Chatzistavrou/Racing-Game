// A believable New York night: orange-pink light-pollution glow over the skyline, a deep indigo zenith, exponential fog tuned so the avenues read
// ~700 m long (the far buildings melt into the glow instead of into black), a warm sky-lit fill and a trace of cold moon light.
//
//   const atm = applyNycAtmosphere(scene, renderer);   // once, after the scene exists (replaces background, fog, hemisphere light)
//   atm.update(camera)                                  // optional: keeps the sky dome glow centred under the camera heading (no cost to skip)
//   atm.dispose()                                       // restores what it replaced
//
// Costs nothing per frame: the sky is one background node (a few ALU ops per pixel), the fog is the cheap FogExp2.
import * as THREE from 'three/webgpu';
import { positionWorldDirection, vec3, mix, smoothstep, pow, float, clamp, uniform, dot, normalize } from 'three/tsl';

export interface NycAtmosphere {
  fog: THREE.FogExp2;
  hemi: THREE.HemisphereLight;
  /** raise/lower the whole city glow (0.5 .. 1.5) */
  glow: { value: number };
  dispose(): void;
}

export interface NycAtmosphereOptions {
  /** fog density (FogExp2); 0.0026 = ~5 % contrast at 700 m. */
  fogDensity?: number;
}

export function applyNycAtmosphere(scene: THREE.Scene, renderer?: THREE.WebGPURenderer, opts: NycAtmosphereOptions = {}): NycAtmosphere {
  void renderer;
  const prev = { background: scene.background, backgroundNode: scene.backgroundNode, fog: scene.fog };
  // ?look=heat swaps the sodium-orange horizon for Heat's magenta/purple light pollution. Read here rather than passed
  // in, so the street look stays in this file (main.ts is shared with the car and garage work).
  const heat = typeof location !== 'undefined' && new URLSearchParams(location.search).get('look') === 'heat';
  const horizon = heat ? new THREE.Color(0.110, 0.035, 0.085) : new THREE.Color(0.085, 0.048, 0.042);
  const glow = uniform(heat ? 1.08 : 1.0);

  // sky: realistic NYC night sky with warm horizon light-pollution dome fading into deep midnight indigo zenith.
  const dir = positionWorldDirection;
  const up = clamp(dir.y, -1, 1);
  const hz = vec3(horizon.r, horizon.g, horizon.b);
  const low = heat ? vec3(0.048, 0.016, 0.062) : vec3(0.032, 0.022, 0.036);   // mid sky: violet under Heat
  const zen = heat ? vec3(0.012, 0.005, 0.030) : vec3(0.005, 0.008, 0.018);   // zenith
  const t1 = smoothstep(0.0, 0.18, up);
  const t2 = smoothstep(0.08, 0.68, up);
  const skyUp = mix(mix(hz, low, t1), zen, t2);
  // below the horizon: dark ground bounce
  const below = hz.mul(0.45);
  // a brighter patch toward Midtown's centre of light along the avenues
  const patch = pow(clamp(dot(normalize(vec3(0.3, 0.0, -0.95)), normalize(vec3(dir.x, 0.0, dir.z))), 0, 1), 4.0).mul(smoothstep(0.32, 0.0, up)).mul(0.42);
  scene.backgroundNode = mix(below, skyUp.mul(float(1).add(patch)), smoothstep(-0.02, 0.01, up)).mul(glow);
  scene.background = null;

  // fog: crisp dark atmospheric haze so distant skyscraper windows and crowns retain high contrast
  const fog = new THREE.FogExp2((heat ? new THREE.Color(0.058, 0.020, 0.062) : new THREE.Color(0.036, 0.026, 0.032)).getHex(), opts.fogDensity ?? 0.0018);
  scene.fog = fog;

  // fill: subtle warm sky bounce from above, deep cool-neutral bounce from the street
  let hemi = scene.children.find((c) => (c as THREE.HemisphereLight).isHemisphereLight) as THREE.HemisphereLight | undefined;
  const ownHemi = !hemi;
  const hemiPrev = hemi ? { c: hemi.color.clone(), g: hemi.groundColor.clone(), i: hemi.intensity } : null;
  if (!hemi) { hemi = new THREE.HemisphereLight(); scene.add(hemi); }
  if (heat) { hemi.color.setRGB(0.31, 0.13, 0.24); hemi.groundColor.setRGB(0.05, 0.022, 0.062); }
  else { hemi.color.setRGB(0.24, 0.17, 0.16); hemi.groundColor.setRGB(0.035, 0.03, 0.038); }
  hemi.intensity = 0.48;

  return {
    fog, hemi, glow,
    dispose() {
      scene.backgroundNode = prev.backgroundNode ?? null;
      scene.background = prev.background;
      scene.fog = prev.fog;
      if (ownHemi) hemi!.removeFromParent();
      else if (hemiPrev) { hemi!.color.copy(hemiPrev.c); hemi!.groundColor.copy(hemiPrev.g); hemi!.intensity = hemiPrev.i; }
    },
  };
}
