// Directional-light shadows on three r186's WebGPURenderer.
//
// What the installed source actually requires (verified in web/node_modules/three):
//
// 1. `renderer.shadowMap.enabled` is **false by default** (`src/renderers/common/Renderer.js:713`) and
//    `ShadowNode.setup()` bails out immediately when it is false (`src/nodes/lighting/ShadowNode.js:597`).
//    It must be true **before the receiving materials are compiled**, because every material compiles its shadow
//    sampling into the pipeline. `NodeManager` puts the flag in the pipeline cache key
//    (`renderers/common/nodes/NodeManager.js:655-656`), so flipping it at runtime is a recompile, not a switch.
// 2. Only materials of objects with `receiveShadow === true` get a shadow node at all: `AnalyticLightNode.setup()`
//    gates on `builder.object.receiveShadow` (`src/nodes/lighting/AnalyticLightNode.js:256-262`). The flag is read
//    at compile time, so it must be set before the object is first drawn.
// 3. The shadow map is only rendered when `shadow.needsUpdate || shadow.autoUpdate`
//    (`src/nodes/lighting/ShadowNode.js:800-816`) and is skipped during precompilation (`:790`). `autoUpdate` is
//    true by default, so a static sun needs nothing extra; a sun moved/attached after the first frame needs
//    `shadow.needsUpdate = true` once.
// 4. The map pass is a real `renderer.render(scene, shadow.camera)` with `scene.overrideMaterial`, and its casters
//    are filtered by `object.castShadow === true` (`src/nodes/lighting/ShadowBaseNode.js:90`). A mesh whose
//    `castShadow` is false (or set after the pass already drew) contributes nothing.
// 5. `PCFSoftShadowMap` is downgraded to `PCFShadowMap` by the WebGPU backend
//    (`Renderer.js:902-906` and `:1658-1662`), so do not wait for soft shadows; set PCF.
// 6. The game's custom `ScaledClusteredLighting` does **not** drop directional lights: it only clusters
//    non-shadow point lights and hands everything else to `LightsNode.setLights` via `super`
//    (`examples/jsm/tsl/lighting/ClusteredLightsNode.js:219-234`).
//
// Two gotchas specific to this game:
//  - `web/src/fx/carProbe.ts:91-96` toggles `renderer.shadowMap.enabled` off/on around every probe render. That
//    invalidates the pipeline cache key on every probe tick (NodeManager.js:655), which is at best a recompile storm
//    and at worst leaves the showroom frames compiled without shadow nodes. Do not probe while the garage is up.
//  - Shader warm-up runs with `_isPreCompiling`, during which ShadowNode deliberately skips map rendering
//    (ShadowNode.js:790). Warm up without the showroom visible, or expect the first shown frame to have no map yet.
import * as THREE from 'three/webgpu';

export interface ShadowSunOptions {
  /** Shadow map resolution (default 2048). */
  mapSize?: number;
  /** Orthographic half-extent of the shadow camera in metres (default 16). */
  extent?: number;
  /** Optional explicit frustum rather than the symmetric extent. */
  frustum?: { left: number; right: number; top: number; bottom: number; near: number; far: number };
  /** Depth bias (default -0.0004) and normal bias (default 0.02). */
  bias?: number;
  normalBias?: number;
}

/**
 * Force the renderer into a shadow-capable state. Call once, before the renderer is initialised and before any
 * material is drawn. `PCFSoftShadowMap` is useless here: the WebGPU backend downgrades it to PCF.
 */
export function enableShadows(renderer: THREE.WebGPURenderer): void {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;   // per-frame updates live on the light's LightShadow (autoUpdate)
}

/**
 * Configure a directional light as a working shadow sun: frustum applied (the missing `updateProjectionMatrix` is
 * the classic "light is on but no shadow lands" bug), target parented and updated, caster flags prepared, and the
 * one-shot `needsUpdate` that makes the first frame render a map.
 */
export function configureShadowSun(renderer: THREE.WebGPURenderer, sun: THREE.DirectionalLight, scene: THREE.Scene, opts: ShadowSunOptions = {}): void {
  enableShadows(renderer);

  const mapSize = opts.mapSize ?? 2048;
  const extent = opts.extent ?? 16;

  sun.castShadow = true;
  sun.shadow.mapSize.set(mapSize, mapSize);
  sun.shadow.bias = opts.bias ?? -0.0004;
  sun.shadow.normalBias = opts.normalBias ?? 0.02;
  sun.shadow.autoUpdate = true;

  const cam = sun.shadow.camera;
  if (opts.frustum) {
    const f = opts.frustum;
    cam.left = f.left; cam.right = f.right; cam.top = f.top; cam.bottom = f.bottom; cam.near = f.near; cam.far = f.far;
  } else {
    cam.left = -extent; cam.right = extent; cam.top = extent; cam.bottom = -extent; cam.near = 0.5; cam.far = extent * 4;
  }
  cam.updateProjectionMatrix();   // without this the light keeps the default frustum and no shadow can land

  // The target must be in the scene graph: the shadow camera looks from light to target in world space.
  if (!sun.target.parent) scene.add(sun.target);
  sun.target.updateMatrixWorld(true);
  sun.updateMatrixWorld(true);

  // One forced update, then autoUpdate drives it: needed when the light was attached after the first render.
  sun.shadow.needsUpdate = true;
}

/**
 * Mark the objects that should cast (and/or receive) and force a shadow-map refresh after they were added or moved.
 * Call it when the garage room is shown; the flags must be true before the mesh is drawn for the first time.
 */
export function refreshShadowCasters(casters: THREE.Object3D[], receivers: THREE.Object3D[] = [], sun?: THREE.DirectionalLight): void {
  for (const o of casters) o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (m.isMesh) { m.castShadow = true; m.frustumCulled = false; }
  });
  for (const o of receivers) o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (m.isMesh) m.receiveShadow = true;
  });
  if (sun) sun.shadow.needsUpdate = true;
}

/**
 * Dev assertion: returns the conditions the backend needs, so a "no shadow" bug can be localised in one frame.
 * `ready` is true only when the renderer, the sun and at least one receiver are all configured.
 */
export function inspectShadowPipeline(renderer: THREE.WebGPURenderer, sun: THREE.DirectionalLight, receivers: THREE.Object3D[]): {
  ready: boolean; enabled: boolean; type: number; castShadow: boolean; autoUpdate: boolean; needsUpdate: boolean;
  targetInScene: boolean; receiversWithFlag: number; mapSize: [number, number]; frustum: [number, number, number, number];
} {
  let receiversWithFlag = 0;
  for (const o of receivers) o.traverse((c) => { const m = c as THREE.Mesh; if (m.isMesh && m.receiveShadow) receiversWithFlag++; });
  const cam = sun.shadow.camera;
  return {
    ready: renderer.shadowMap.enabled && sun.castShadow && receiversWithFlag > 0 && !!sun.target.parent,
    enabled: renderer.shadowMap.enabled,
    type: renderer.shadowMap.type,
    castShadow: sun.castShadow,
    autoUpdate: sun.shadow.autoUpdate,
    needsUpdate: sun.shadow.needsUpdate,
    targetInScene: !!sun.target.parent,
    receiversWithFlag,
    mapSize: [sun.shadow.mapSize.width, sun.shadow.mapSize.height],
    frustum: [cam.left, cam.right, cam.top, cam.bottom],
  };
}
