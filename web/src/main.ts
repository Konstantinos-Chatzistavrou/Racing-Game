// Night Run (web build): three.js WebGPU renderer + Rapier rigid bodies + the rs_core physics
// compiled to WebAssembly. WebGPU required. URL options: ?scale=0.75 (pins the render resolution; default adaptive),
// ?quality=max|ultra|high|medium|low|potato (pins the post/render preset; default adaptive), ?webgl=1 (debug only),
// ?bloom=0, ?aa=0, ?shadows=0, ?lights=12 (WebGL 2 light pool size), ?party=CODE (invite: join that multiplayer party, see party.ts),
// ?peer=host:port (own PeerJS server), ?ai=0..5 (race rivals, default 5), ?blackcar=1 (AI cars matte black, lights off: night lighting test),
// ?menu=0 (skip the title and garage: straight into a free run, for the test tools).
// Flow: loading -> title (graphics tuned once behind a cover) -> Play -> game modes: Race (you + 5 AI rivals) / Free Roam (just you) /
// Multiplayer (party lobby). The garage (title -> Garage) is cars, paint and upgrades only: back to the title, or Continue -> game modes.
import * as THREE from 'three/webgpu';
import { Post, PRESETS, PRESET_ORDER, ScaledClusteredLighting, usePotatoOnly, type PresetName } from './post';
import { CarProbe } from './fx/carProbe';
import { nightEnvTexture } from './fx/nightEnv';
import { Particles } from './scene/damage';
import { Garage } from './scene/garage';
import { SHOW_PRESETS, ShowroomPost } from './showroomPost';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CoreCar, CoreRace, OUT, loadCore, type LapInfo, type RawInput } from './physics/core';
import { CarBody, DT, PhysicsWorld, loadRapier, type CarShape } from './physics/world';
import { CityLighting, loadCity } from './scene/city';
import { NycStreamer, nycCityShim } from './scene/nyc';
import { StreetObstacles, type PoleHit } from './scene/nyc/obstacles';
import { drawEarly, type BreachSpec, type WallHit } from './scene/nyc/breach';
import { CarVisual, type CarVisualConfig } from './scene/car';
import { initLoaders } from './scene/loaders';
import { CameraRig } from './camera';
import { Input } from './input';
import { Hud } from './hud';
import { DamageVisuals, DEBRIS_LAYER } from './scene/damage';
import { GameAudio } from './audio';
import { TouchControls, wantsTouch } from './touch';
import { ForceFeedback } from './ffb';
import { ControlsUi } from './controls-menu';
import { MenuNav } from './menu-nav';
import { fromToggles, loadAssists, saveAssists, toToggles } from './assists';
import { MpCareer, SpCareer } from './career';
import { Cloud } from './cloud';
import { RankedLink } from './ranked';
import { FREE_ROAM_XP_PER_KM, raceReward } from './progression';
import { DrivingLine } from './driving-line';
import { Minimap, type Blip } from './minimap';
import { Loader, steadyFrames } from './loading';
import type RAPIER from '@dimforge/rapier3d-compat';
import { RemoteCars } from './net';
import { Party, cleanCode, type Progress } from './party';
import { Menu, rank, type Gfx, type Screen, type Standing } from './menu';
import { applyMods, customOf, loadSelection, modsOf, paintOf, saveSelection, type CatalogCar, type Mode } from './garage';
import { cleanCustom } from './custom-data';
import { frameStats, sceneTextureStats } from './stats';
import { GRADE } from './fx/grade';
import { HEAT_MAX, Heat } from './heat';
import { skinOf } from './scene/driver';
import RAPIERLib from '@dimforge/rapier3d-compat';
import { AiTraffic, Lane } from './ai';
import { Cops } from './cops';
import { assetUrl, loadGLTF } from './scene/loaders';
import { Identity } from './identity';
import { usernameError } from './username';
import { formatLap } from './hud';
import { autoCap, benchClose, benchProgress, benchResults, measureRefresh, recommend, stats, type BenchReport, type PhaseResult, type SoakWindow } from './bench';

const params = new URLSearchParams(location.search);
const num = (k: string, d: number) => (params.has(k) ? Number(params.get(k)) : d);
/**
 * The GPU's name as the driver reports it ("Mali-G57 MC2", "Adreno (TM) 610"). WebGPU's adapter info hides it in
 * Chrome; a throwaway WebGL context does not. '' when the browser masks it.
 */
function gpuName(): string {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    const name = gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '') : '';
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return name;
  } catch { return ''; }
}
/**
 * Phone GPUs that get potato mode by name: Mali-G57 (Helio G99, Dimensity 700/6020) and everything at or below it -
 * Mali-4xx / T-series, G31, G51, G52, G68, G71, G72; Adreno 3xx-5xx and 60x / 61x; every PowerVR.
 */
const WEAK_GPU = /Mali-(4\d\d|T\d{3}|G31|G51|G52|G57|G68|G71|G72)\b|Adreno \(TM\) ([345]\d\d|6[01]\d)\b|PowerVR/i;
const loading = document.getElementById('loading')!;
/**
 * First screen is a click-for-fullscreen gate, not the loading bar: the game boots behind it, and the click is the
 * user gesture the Fullscreen API needs. Once entered, the normal loading screen (if still loading) or the game shows.
 */
const enterEl = document.getElementById('enter');
let gameReady = false;
const enter = () => {
  const el = enterEl;
  if (!el || !el.isConnected) return;
  el.remove();
  if (!gameReady) loading.hidden = false;
  try {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      void document.documentElement.requestFullscreen().catch(() => { /* iOS Safari: no element fullscreen, play as is */ });
    }
  } catch { /* denied: play in the tab */ }
};
enterEl?.addEventListener('click', enter, { once: true });
enterEl?.addEventListener('touchend', enter, { once: true });
// automation gets past the gate (no user gesture to give); ?gate=1 forces it, ?gate=0 skips it everywhere
const auto = navigator.webdriver || /HeadlessChrome/i.test(navigator.userAgent) || params.get('gate') === '0';
if (auto && params.get('gate') !== '1') enter();
const loadFill = document.getElementById('load-fill');
const loadMsg = document.getElementById('load-msg');
const say = (s: string, pct?: number) => {
  if (loadMsg) loadMsg.textContent = s; else loading.textContent = s;
  if (loadFill && pct !== undefined) loadFill.style.width = `${Math.round(Math.max(5, Math.min(100, pct)))}%`;
};

/**
 * Load profile: what each stage of the start-up cost (ms since navigation, render pipelines compiled so far).
 * `__loadLog` in the console; Settings shows the total under Graphics.
 */
const loadLog: { stage: string; ms: number; pipelines: number }[] = [];
let pipelineCount = () => 0;
const mark = (stage: string) => { loadLog.push({ stage, ms: Math.round(performance.now()), pipelines: pipelineCount() }); };
(globalThis as { __loadLog?: unknown }).__loadLog = loadLog;

async function main() {
  const refreshP = measureRefresh();   // runs while the renderer and assets load
  // --- renderer -------------------------------------------------------------------------------
  // WebGPU is what the game is built for (clustered lighting, compute). Without it: a phone starts in potato mode on
  // WebGL 2 (same picture as potato on WebGPU, measured); a desktop gets the instructions and a link to do the same.
  // ?webgl=1 forces WebGL 2 for debugging.
  const isTouch = params.has('touch') ? params.get('touch') !== '0' : wantsTouch();
  let forceWebGL = params.get('webgl') === '1';
  let noWebGPU = false;
  if (!forceWebGL) {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null);
    if (!adapter) {
      const gl2 = !!document.createElement('canvas').getContext('webgl2');
      if (isTouch && gl2) { forceWebGL = true; noWebGPU = true; }
      else {
        const u = new URL(location.href);
        u.searchParams.set('webgl', '1'); u.searchParams.set('quality', 'potato');
        loading.innerHTML = `<div style="max-width:560px;text-align:left;letter-spacing:0;text-transform:none;line-height:1.6">
          <b style="color:#f4f1ea">WebGPU is not available in this browser.</b><br>
          Chrome on Linux: open <code>chrome://flags</code>, enable <b>Unsafe WebGPU Support</b> and <b>Vulkan</b>, then relaunch.<br>
          Check with <code>chrome://gpu</code> → "WebGPU: Hardware accelerated".
          ${gl2 ? `<br><a href="${u.pathname + u.search}" style="color:#ff2d6a">Start anyway in potato mode (WebGL 2, lowest graphics)</a>` : ''}</div>`;
        if (import.meta.env.DEV) fetch('/__telemetry', { method: 'POST', body: 'NO WEBGPU ADAPTER - stopped' }).catch(() => {});
        return;
      }
    }
  }
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, forceWebGL });
  // The canvas always runs at baseRatio; `scale` is the RENDER scale of the scene and the passes
  // before the sharpening upscale (post.ts). It used to be the canvas pixel ratio, which the browser
  // then stretched bilinearly (soft) and whose change reconfigured the whole canvas.
  // Graphics: 'auto' tunes resolution + preset behind a cover in the title menu and steps down preset/scale
  // if high-speed driving drops FPS; high/medium/low are fixed. ?scale / ?quality (test tools) pin on top of that.
  // ?touch=1 / ?touch=0 forces the phone path (the headless harness reports a fine pointer, the real phone a coarse one)
  // Phones: the canvas follows the panel (up to 2x CSS px) and `scale` picks the pixels actually rendered, sharpened up to
  // the panel in post.ts. A 1x canvas (915 x 412 on a 2.6x phone) was stretched by the browser: every texture looked unloaded.
  const GFX_KEY = 'nr.gfx.v4';
  let gfx: Gfx = 'auto';
  try { const g = localStorage.getItem(GFX_KEY); if (g === 'max' || g === 'ultra' || g === 'high' || g === 'medium' || g === 'low' || g === 'potato') gfx = g; } catch { /* storage blocked */ }
  /**
   * POTATO: a boot mode for phones a Mali-G57 (Helio G99) class GPU or slower, below `low`. Decided here, before
   * anything is built, because most of what it saves cannot be switched later without recompiling every shader:
   * one tone-mapped pass instead of five post pipelines, no shadow maps, a 1x canvas, short city rings behind thicker
   * fog, 8 street lights, no garage props. It is entered by choice (Settings / ?quality=potato), by the GPU's name,
   * by 3 GB of RAM or less, or by the flag the tuner sets when `low` at its smallest resolution still misses the target.
   */
  const POTATO_KEY = 'nr.potato.v1';
  let potatoFlag = false;
  try { potatoFlag = localStorage.getItem(POTATO_KEY) === '1'; } catch { /* storage blocked */ }
  const gpu = isTouch ? gpuName() : '';
  const weakDevice = isTouch && (WEAK_GPU.test(gpu) || ((navigator as { deviceMemory?: number }).deviceMemory ?? 8) <= 3);
  const qParam = params.get('quality');
  const potato = noWebGPU || qParam === 'potato' || (!qParam && (gfx === 'potato' || (gfx === 'auto' && (weakDevice || potatoFlag))));
  if (potato) usePotatoOnly();
  const baseRatio = Math.min(devicePixelRatio, potato ? 1 : isTouch ? 2 : 1);
  const GFX_SCALE = { max: 1, ultra: 1, high: 1, medium: 0.85, low: 0.7, potato: 0.7 } as const;   // phones (their canvas is tuned separately)
  /**
   * Desktop: every preset renders a fixed PIXEL budget, whatever the window size, and the last pass sharpens it up to
   * the canvas (post.ts). Measured on the i3 iGPU the street costs about 6.5 ms + 27 ms per 2 megapixels before any
   * effect, so resolution is the one lever that moves a tier: 0.5 MP is the 45-60 fps picture, 1 MP the 30 fps one.
   * A window smaller than the budget simply renders 1:1.
   */
  const PRESET_MP: Record<PresetName, number> = { max: 0.8e6, ultra: 0.88e6, high: 1.0e6, medium: 0.62e6, low: 0.5e6, potato: 0.22e6 };
  let adaptive = gfx === 'auto' && !params.has('scale') && !potato;
  const maxScale = 1;
  const targetPixels = isTouch ? 0.72e6 : 0.9e6;
  const MIN_RENDER = isTouch ? 0.35 : 0.45;   // lowest render scale (a 2x phone canvas at 0.5 was the old 1x picture)
  const guessScale = () => Math.min(maxScale, Math.max(MIN_RENDER, Math.round(Math.sqrt(targetPixels / (innerWidth * innerHeight * baseRatio ** 2)) * 10) / 10));
  let SCALE_KEY = `nr.scale.v5.${innerWidth}x${innerHeight}`;
  let stored = NaN;
  try { stored = Number(localStorage.getItem(SCALE_KEY) ?? NaN); } catch { /* storage blocked */ }
  const presetScale = (p: PresetName) => isTouch && p !== 'potato' ? Math.min(GFX_SCALE[p], guessScale())
    : Math.min(maxScale, Math.max(MIN_RENDER, Math.round(Math.sqrt(PRESET_MP[p] / (innerWidth * innerHeight * baseRatio ** 2)) * 20) / 20));
  const scalePinned = params.has('scale');
  let scale = scalePinned ? num('scale', 1) : potato ? presetScale('potato') : gfx !== 'auto' ? presetScale(gfx) : stored >= MIN_RENDER && stored <= maxScale ? stored : guessScale();
  renderer.setPixelRatio(baseRatio);
  renderer.setSize(innerWidth, innerHeight);
  // Quality preset (post.ts PRESETS), lowered by the adaptive system BEFORE the scale; stored like it.
  const defaultPreset: PresetName = isTouch ? 'medium' : 'ultra';
  let PRESET_KEY = `nr.preset.v5.${innerWidth}x${innerHeight}`;
  let presetPinned = PRESET_ORDER.includes(params.get('quality') as PresetName) || gfx !== 'auto' || potato;
  let storedPreset: string | null = null;
  try { storedPreset = localStorage.getItem(PRESET_KEY); } catch { /* storage blocked */ }
  let presetIdx = Math.max(0, PRESET_ORDER.indexOf((PRESET_ORDER.includes(params.get('quality') as PresetName) ? params.get('quality') : gfx !== 'auto' ? gfx : storedPreset ?? defaultPreset) as PresetName));
  if (!isTouch && !scalePinned) scale = presetScale(PRESET_ORDER[presetIdx]);   // desktop: always the preset's budget (a stored scale is a phone thing)
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = params.get('shadows') !== '0' && !potato;   // potato: no shadow pass, no shadow code in any shader
  renderer.shadowMap.type = THREE.PCFShadowMap;
  await renderer.init();
  pipelineCount = () => (renderer as unknown as { _pipelines?: { caches?: Map<string, unknown> } })._pipelines?.caches?.size ?? 0;
  mark('renderer');
  if (params.has('pipelog')) {
    // ?pipelog=1: which object caused each new render pipeline (`__pipeLog`): the load time of a phone is this list
    const P = (renderer as unknown as { _pipelines: { caches: Map<string, unknown>; getForRender(ro: unknown, p?: unknown): unknown } })._pipelines;
    const log: string[] = ((globalThis as { __pipeLog?: string[] }).__pipeLog = []);
    const orig = P.getForRender.bind(P);
    P.getForRender = (ro: unknown, promises?: unknown) => {
      const n = P.caches.size, out = orig(ro, promises);
      if (P.caches.size > n) {
        const r = ro as { object: THREE.Object3D; material: THREE.Material; context?: { id?: number; sampleCount?: number; renderTarget?: { width: number; height: number; texture?: { type: number; name?: string }; depthTexture?: unknown; samples?: number } | null } };
        const rt = r.context?.renderTarget;
        const path: string[] = [];
        for (let o: THREE.Object3D | null = r.object; o && path.length < 5; o = o.parent) path.unshift(o.name || o.type);
        log.push(`${path.join('/')} | ${r.material.type}${r.material.name ? ':' + r.material.name : ''}${r.material.transparent ? ' transparent' : ''} side${r.material.side} | ctx${r.context?.id} ${rt ? `${rt.width}x${rt.height} type${rt.texture?.type} ${rt.texture?.name ?? ''} depthTex${rt.depthTexture ? 1 : 0}` : 'canvas'} samples${r.context?.sampleCount} @${Math.round(performance.now())}`);
      }
      return out;
    };
  }
  initLoaders(renderer);   // shared glTF decoders (meshopt, KTX2), scene/loaders.ts
  const webgpu = !!(renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend;
  const backend = webgpu ? 'WebGPU' : 'WebGL 2';
  if (webgpu) renderer.lighting = potato ? new ScaledClusteredLighting(96, 32, 12, 32, [960, 544]) : new ScaledClusteredLighting(512);   // needs compute shaders; grid follows the render scale

  const scene = new THREE.Scene();
  // Night: very dark but never pure black. The hemisphere fill is the floor of the picture
  // (silhouettes barely readable, a matte black car or dark wall all but invisible); headlights are
  // the main light, street lamps leave faint pools. Sky/fog are a hair above black, so distant
  // shapes fade into a deep blue-black instead of a void.
  scene.background = new THREE.Color(0x05060c);
  scene.fog = new THREE.FogExp2(0x05060c, 0.0085);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;   // placeholder until the city is captured
  scene.environmentIntensity = 0.03;
  scene.add(new THREE.HemisphereLight(0x0a0a14, 0x000000, 0.1));
  const moon = new THREE.DirectionalLight(0x7088c0, 0.04);   // a trace of cold top light on roofs and car bodies
  // rim light: one extra directional from behind-left, very low, so silhouettes separate from the night
  const rimLight = new THREE.DirectionalLight(0x8fb4ff, 0.07);
  rimLight.position.set(-0.45, 0.55, -1);
  scene.add(rimLight, rimLight.target);
  moon.position.set(-60, 120, 40);
  scene.add(moon);

  const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 260);
  camera.layers.enable(DEBRIS_LAYER);   // parts broken off the car (damage.ts): main view only, not the reflection probe
  // Resize (window drag, fullscreen): at most once per frame, and never a preset change (that rebuilds pipelines =
  // seconds of shader compiles); the render scale keeps the pixel count the GPU was tuned for (syncToSize).
  let resizeQueued = false;
  addEventListener('resize', () => {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => {
      resizeQueued = false;
      renderer.setSize(innerWidth, innerHeight);
      camera.aspect = innerWidth / innerHeight;
      camera.updateProjectionMatrix();
      syncToSize();
    });
  });
  addEventListener('keydown', (e) => {
    if (e.code !== 'KeyF' || e.repeat || e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement).tagName === 'INPUT') return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {});
  });

  // --- physics + content (parallel prefetch for fast startup) ---------------------------------
  say('Loading physics & track…', 12);
  const DEFAULT_VISUAL = 'cars/vela_gt.visual.json';
  const visualCfgCache = new Map<string, Promise<CarVisualConfig>>();
  const fetchVisualCfg = (path: string) => {
    let p = visualCfgCache.get(path);
    if (!p) { p = fetch(`/data/${path}`).then((r) => r.json() as Promise<CarVisualConfig>); visualCfgCache.set(path, p); }
    return p;
  };
  const physics: Record<string, unknown> = {};
  const catalogP = fetch('/data/cars/catalog.json').then((r) => r.json() as Promise<{ cars: CatalogCar[] }>).then(async (j) => {
    await Promise.all(j.cars.map((c) => fetch(`/data/${c.physics}`).then((r) => r.json()).then((d) => { physics[c.id] = d; })));
    return j.cars;
  });
  const useNyc = params.get('city') !== 'old';
  const [catalog, defaultCfg, route] = await Promise.all([
    catalogP,
    fetchVisualCfg(DEFAULT_VISUAL),
    fetch(useNyc ? '/data/tracks/nyc_route.json' : '/data/tracks/city_route.json').then((r) => r.json()),
    loadCore(),
    loadRapier(),
  ]);
  const sel = loadSelection(catalog, params);
  // credits, owned cars and upgrades. Dev server tests (?car=..., ?unlockall=1) own everything.
  // careers: single player (XP levels, this device) and online (the server's profile). Dev tests (?car=, ?unlockall=1)
  // unlock the whole single-player career.
  const sp = new SpCareer(import.meta.env.DEV && (params.get('unlockall') === '1' || params.has('car')));
  const cloud = new Cloud();
  const mp = new MpCareer(cloud, catalog);
  // username (unique online, shown in races and on the plates) and friends: identity.ts
  // dev tests (drive.mjs): ?user=NAME skips the first-start username card
  if (import.meta.env.DEV && params.get('user') && !usernameError(params.get('user')!)) sel.name = params.get('user')!;
  const identity = new Identity(sel, cloud);
  const careerOf = () => (sel.career === 'mp' ? mp : sp);
  if (sel.career === 'mp') sel.career = 'sp';   // the game opens on the single-player career; the lobby switches
  // driving assists (Settings): levels of the core's existing aids
  const assistSet = loadAssists();
  const visualPathOf = (id: string) => catalog.find((c) => c.id === id)?.visual ?? DEFAULT_VISUAL;
  const shapeOf = (cfg: CarVisualConfig): CarShape => {
    const cb = cfg.collision_box;
    return { boxSize: cb.size_m, boxCentre: cb.centre_in_model_m, endLift: cb.end_lift_m, endLiftStart: cb.end_lift_start_m };
  };
  let visualPath = visualPathOf(sel.car);
  // Start downloading the player's car GLTF in parallel with the city tiles!
  const carLoadP = (visualPath === DEFAULT_VISUAL ? Promise.resolve(defaultCfg) : fetchVisualCfg(visualPath))
    .then(async (cfg) => ({ cfg, vis: await CarVisual.load(cfg) }));
  const coreJson = () => JSON.stringify(applyMods(physics[sel.car], modsOf(sel)));
  const carKey = () => `${sel.car}|${JSON.stringify(modsOf(sel))}`;
  let builtKey = carKey();
  let core = new CoreCar(coreJson());
  const pw = new PhysicsWorld();
  const nyc = useNyc ? new NycStreamer(scene, renderer, pw, camera, {
    surfaces: core.info.surfaces,
    debug: params.get('nycdebug') === '1',
    fogDensity: num('fog', potato ? 0.0045 : 0.0024),
    // Phones: the far ring is skyline only and the fog eats most of it anyway, but every far tile is a draw and the
    // phone is draw-submission bound (docs/performance.md "Where the CPU goes"), so it stops at 560 m there. The
    // near ring is what the player actually drives through. ?far= overrides both for tests.
    // Potato: both rings pulled in (every tile is draws and triangles a Mali-G57 cannot afford) and the fog thickened
    // so the edge is not seen: at 0.0045 the 420 m ring edge is at 3 % visibility.
    farLoad: num('far', potato ? 420 : isTouch ? 560 : 1000),
    farKeep: num('farkeep', potato ? 500 : isTouch ? 660 : 1150),
    ...(potato ? { nearLoad: num('near', 300), nearKeep: num('nearkeep', 380), treeDensity: num('trees', 0.4) } : {}),
    onProgress: (f) => say(`Loading the city… ${Math.round(f * 100)}%`, 20 + f * 55),
  }) : null;
  if (nyc) {
    await nyc.ready();
    mark('city first ring');
    camera.far = potato ? 560 : 1600;
    camera.updateProjectionMatrix();
  }
  const nycS0 = nyc ? nyc.spawnPoint() : null;
  // Poles, hydrants, bins, shelters, kiosks and tree trunks near the car are solid (obstacles.ts)
  const streetProps = nyc?.streetProps ?? null;
  const obstacles = streetProps && params.get('solidprops') !== '0' ? new StreetObstacles(pw, streetProps) : null;
  const city = nyc ? nycCityShim() : await loadCity(scene, pw, core.info.surfaces, (f) => say(`Loading city… ${Math.round(f * 100)}%`, 20 + f * 55), webgpu && num('bundle', 1) === 1);
  const cityLights = new CityLighting(scene, city.lights, webgpu, num('lights', 12));
  // Reflections: capture the lit city once from street level (the car isn't in the scene yet).
  {
    const s0 = nycS0 ?? route.samples[0];
    camera.position.set(s0.x, s0.z + 2, -s0.y);
    cityLights.update(1, camera);
    // Potato: a generated night environment (fx/nightEnv.ts) instead of the capture, which compiles every city
    // material again for the cube pass (44 pipelines: minutes of a weak phone's load).
    if (potato) { const eq = nightEnvTexture(); scene.environment = pmrem.fromEquirectangular(eq).texture; eq.dispose(); }
    else scene.environment = pmrem.fromScene(scene, 0.02, 0.5, 400, { size: 256, position: camera.position.clone() }).texture;
    // The capture is for REFLECTIONS (lamps and neon in paint and wet asphalt). At full strength its
    // diffuse part lit every wall like an overcast sky and undid the darkness.
    scene.environmentIntensity = nyc ? 0.65 : 0.5;
  }
  mark('environment capture');
  say('Loading car…', 80);
  // Frame cap: uncapped (native display refresh) by default; ?cap=N pins a specific frame rate.
  const hz = await refreshP;
  // Desktop uncapped (the cap only delays a ready frame); phones capped at 30 - uncapped there just burns the power
  // budget, heats the SoC and throttles down to the 20s, which reads as "laggy". ?cap=0 uncaps, ?cap=45 changes it.
  const capFps = num('cap', isTouch || potato ? 30 : 0);
  const capInterval = capFps > 0 ? 1000 / capFps : 0;
  const loadedCar = await carLoadP;
  let visualCfg = loadedCar.cfg;
  let visual = loadedCar.vis;
  visual.setPlate(sel.name);
  drawEarly(visual.model);   // cars stay visible inside a wall breach (breach.ts portal)
  scene.add(visual.root);
  visual.setPaint(paintOf(sel, catalog), sel.finish);
  // Live car reflection probe (src/fx/carProbe.ts): renders one 128 px cube face every Nth drawn frame so streetlamps,
  // neon signs, and skyscrapers glide across clearcoat paint & glass in real time (?probe=0 disables).
  // Off on phones: one cube face is a whole extra scene render (the full draw list), so even one every 30 frames landed
  // as a visible hitch about once a second while driving. ?probe=N turns it on for an experiment.
  const probeEvery = num('probe', isTouch || potato ? 0 : 4);
  const probeIntensity = num('probei', 1.25);
  const probeSize = num('probesize', isTouch ? 48 : 256);
  const probe = webgpu && probeEvery > 0 ? new CarProbe(renderer, scene, pmrem, probeSize, probeEvery) : null;
  // The garage: its own scene (scene/garage). Built while the car loads; its cube matches the probe's so the probe
  // can prefilter the room into the texture the car's materials already sample (no material ever changes).
  // Potato has no garage room: the title and the garage menus show the car parked on the street (the showroom camera's
  // street path below). The room is a second scene - 88 more pipelines, 15 textures, a mirror pass - for a backdrop.
  const garageP: Promise<Garage | null> = potato ? Promise.resolve(null) : Garage.create(renderer, pmrem, probe ? probeSize : 128);
  let readyDone = () => {};
  /** resolves when the game is on screen: potato loads the optional car parts after it, not alongside the city */
  const readyP = new Promise<void>((r) => { readyDone = r; });
  const partsGate = potato ? readyP : Promise.resolve();
  // Blender-authored replacement shells (vela_front_wide / vela_front_track): swapped in when they arrive
  void partsGate.then(() => Promise.all([
    loadGLTF(assetUrl('cars/v3/vela_front_wide.glb')),
    loadGLTF(assetUrl('cars/v3/vela_front_track.glb')),
  ])).then(([w, t]) => visual.custom.setShells(w.scene, t.scene)).catch(() => { /* keep the derived shells */ });
  void partsGate.then(() => Promise.all([
    loadGLTF(assetUrl('cars/v3/vela_hood_domed.glb')),
    loadGLTF(assetUrl('cars/v3/vela_rear_wide.glb')),
    loadGLTF(assetUrl('cars/v3/vela_hood_dome.glb')),
    loadGLTF(assetUrl('cars/v3/vela_hood_track.glb')),
    loadGLTF(assetUrl('cars/v3/vela_hood_vent_auth.glb')),
    loadGLTF(assetUrl('cars/v3/vela_front_split_auth.glb')),
  ])).then(([h, r, hd, ht, hv, fs2]) => visual.custom.setExtraParts({
    'hood-blender': h.scene, 'rear-blender': r.scene, 'hood-dome': hd.scene, 'hood-track': ht.scene,
    'hood-vent-auth': hv.scene, 'front-split-auth': fs2.scene,
  })).catch(() => { /* fitted clones stay */ });
  // parts modelled in Blender (shrink-wrapped onto the car's real surface)
  void partsGate.then(() => Promise.all([
    loadGLTF(assetUrl('cars/v3/vela_front_bumper_pro.glb')),
    loadGLTF(assetUrl('cars/v3/vela_hood_pro.glb')),
  ])).then(([b, h2]) => visual.custom.setExtraParts({ 'front-bumper-pro': b.scene, 'hood-pro': h2.scene })).catch(() => { /* authored parts stay */ });
  const screenNone = () => menu.screen === 'none';
  // Tyre smoke: billboards at the rear contact patches, emitted from the core's slip ratio (not a canned effect)
  const tireSmoke = webgpu ? new Particles(180, { additive: false, gravity: 0.25, grow: 1.4, drag: 1.1, style: 'smoke', opacity: 0.15 }) : null;
  if (tireSmoke) tireSmoke.color.setRGB(0.72, 0.72, 0.76);   // grey tyre smoke, not tail-light red
  if (tireSmoke) { tireSmoke.sprite.frustumCulled = false; scene.add(tireSmoke.sprite); }
  const smokeP = new THREE.Vector3(), smokeV = new THREE.Vector3(), smokeF = new THREE.Vector3(), smokeR = new THREE.Vector3();
  // Launch control: hold the throttle on the grid, the start clamps wheelspin for ~1.1 s
  let launchArmed = false, launchUntil = 0;
  const launchEl = document.getElementById('launch');
  // In the garage the car's own lamps are nearly off (no headlight blowout in the room): every emissive "light"
  // material is dimmed and restored for driving. Uniform writes only.
  const dimLamps = (on: boolean) => {
    visual.model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mm of mats) {
        const mat = mm as THREE.MeshStandardMaterial;
        if (!mat || !mat.emissive) continue;
        const u = mat.userData as { showroomSave?: number };
        const name = (mat.name ?? '') + ' ' + (mesh.name ?? '');
        if (!/light|drl|lens|beam|tail/i.test(name)) continue;
        if (on) { if (u.showroomSave === undefined) u.showroomSave = mat.emissiveIntensity ?? 1; mat.emissiveIntensity = (u.showroomSave ?? 1) * 0.16; }
        else if (u.showroomSave !== undefined) { mat.emissiveIntensity = u.showroomSave; u.showroomSave = undefined; }
      }
    });
  };
  probe?.attach(visual.model, probeIntensity);
  let remote: RemoteCars | null = null;   // other players' cars, while a party session runs
  let party: Party | null = null;         // the multiplayer party we are in (lobby or driving)
  const remoteProg = new Map<string, Progress>();
  let shape = shapeOf(visualCfg);
  visual.renderDt = capInterval ? capInterval / 1000 : 1 / 60;
  let car = new CarBody(pw, core, shape, visual.cg);

  // Rapier only indexes new colliders for queries during a step: step once so the spawn probe
  // below can see the city (without this the first spawn misses the road and drops 3 m).
  pw.world.step();
  const garage = await garageP;
  const aiCount = Math.max(0, Math.min(5, num('ai', 5)));
  if (aiCount > 0) say('Loading rivals…');
  const ai = await AiTraffic.create(scene, pw, defaultCfg, route.samples, aiCount, params.get('blackcar') === '1', physics.vela_gt ?? physics[catalog[0].id]);
  ai.onWreck = (name) => { hud.toast('RIVAL OUT', `${name} WRECKED`); };
  if (garage) try {
    const parked: THREE.Object3D[] = [];
    for (const i of [0, 1]) {
      const src = (ai as unknown as { cars?: { model?: THREE.Object3D }[] }).cars?.[i]?.model;
      if (!src) continue;
      const clone = src.clone(true);
      clone.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mesh.material = Array.isArray(mesh.material) ? mats.map((x) => x.clone()) : (mats[0] as THREE.Material).clone();
        const mm = mesh.material as THREE.MeshStandardMaterial;
        if (mm && mm.color && /paint/i.test(mm.name ?? '')) mm.color.setHex(i ? 0x2a4fd6 : 0xe8e8ea);
        // parked cars are switched off: their headlights at emissive 10 bloom into a huge white orb in the garage
        for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          const st = mat as THREE.MeshStandardMaterial;
          if (st && st.emissive && /light|drl|lens|tail|turn|interior/i.test(st.name ?? '')) st.emissiveIntensity = 0.05;
          else if (st && st.emissive && st.emissiveIntensity > 0.5) st.emissiveIntensity = 0.05;
        }
      });
      parked.push(clone);
    }
    garage.park(parked);
  } catch { /* no parked cars */ }

  // Start line = first route sample (core coords: Z-up) -> three (x, z, -y).
  const s0 = nycS0 ?? route.samples[0];
  const startYaw = Math.atan2(Math.cos(s0.heading), -Math.sin(s0.heading));
  /** Grid slot: metres ahead of the start point (ds) and to its right (lat). Free roam: 0, 0. */
  let grid = { ds: 0, lat: 0 };
  const spawn = () => {
    const p = new THREE.Vector3(s0.x, s0.z + 3, -s0.y);
    p.x += Math.sin(startYaw) * grid.ds - Math.cos(startYaw) * grid.lat;
    p.z += Math.cos(startYaw) * grid.ds + Math.sin(startYaw) * grid.lat;
    const hit = pw.raycast(p, p.clone().add(new THREE.Vector3(0, -20, 0)));
    if (hit) p.y -= hit.toi;
    p.y += core.info.cgHeight + 0.02;
    car.place(p, startYaw);
    car.settle();
  };
  spawn();

  // Laps: the core's RaceTracker on the city route (free run: laps counted forever).
  const routeJson = JSON.stringify(route);
  let race = new CoreRace(routeJson, 0);
  let raceCar = race.addCar(car.body.translation());
  let raceT0 = 0, lap: LapInfo | null = null;
  /** AI rivals in the race tracker: their tracker index, last progress, finish time (-1 racing) */
  let aiRace: { idx: number; lap: LapInfo | null; fin: number }[] = [];
  /** Laps of the session's race (0: free roam / free party session). */
  const raceLaps = () => sel.mode === 'race' ? sel.laps : sel.mode === 'online' && party?.mode === 'race' ? party.laps : 0;
  /** Race rules: full realism (no resets; wrecked / rolled over / stuck = DNF, then spectate) or respawns. A party uses the leader's. */
  const realism = () => raceLaps() > 0 && (sel.mode === 'online' ? party?.realism !== false : sel.realism);
  /** Out of the race (realism): why, or '' while racing. */
  let myDnf = '';
  let rolledT = 0, stuckT = 0;

  const pos = new THREE.Vector3(), quat = new THREE.Quaternion();
  const input = new Input();
  const rig = new CameraRig(camera, pw, car.body, core.info.redline);
  try { const cam = localStorage.getItem('nr.cam'); if (cam) rig.setMode(cam as never); } catch { /* blocked */ }
  const hud = new Hud();
  hud.cap = capFps > 0 ? Math.round(capFps) : 0;
  /**
   * Wanted heat (docs/design/heat-and-cops.md): a visible 0-5 dial with a real decision behind it. Slice 1 raises it
   * from what the player does (finishing a race, wrecking the car) and cools it over quiet minutes; no cops yet.
   */
  const heat = new Heat();
  const heatEl = document.getElementById('heat')!;
  const renderHeat = () => {
    heatEl.innerHTML = Array.from({ length: HEAT_MAX }, (_, i) => `<i class="${i < heat.level ? 'on' : ''}"></i>`).join('') + `<b>${heat.level}/${HEAT_MAX}</b>`;
    heatEl.classList.toggle('lvl4', heat.level === 4);
    heatEl.classList.toggle('maxed', heat.maxed);
  };
  renderHeat();
  const bumpHeat = (n: number) => { heat.add(n); renderHeat(); menu.heat = heat.level; };
  /**
   * Cops (docs/design/heat-and-cops.md, slice 2): one unmarked car that joins a race you started at 3+ heat - never in
   * the garage, never while cruising, never while tuning. Escape is distance, not a bar; a bust resets the heat only.
   */
  const copsEl = document.getElementById('cops')!;
  let copMsg = '';
  let copMsgUntil = 0;
  const copNote = (t: string, ms = 3500) => { copMsg = t; copMsgUntil = performance.now() + ms; };
  const cops = new Cops(new Lane(route.samples), {
    bust: () => {
      // Busting is a setback, not a wipe: impound fee in reputation, heat reset, car kept (docs/design/heat-and-cops.md).
      const fine = 150;
      if (sp.kind === 'sp') sp.penalty(fine);
      heat.clear(); renderHeat(); menu.heat = 0;
      copNote(`BUSTED · -${fine} XP · heat reset`, 5000);
    },
    escaped: () => { copNote('LOST THEM', 4000); },
  });
  // unmarked car: the traffic model, loaded in the background; the pursuit logic runs with or without it
  void loadGLTF('/assets/cars/v3/vela_gt_traffic.glb').then((g) => {
    const root = g.scene;
    root.visible = false;
    root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.frustumCulled = false; });
    // light bar: two blocks on the roof, flashed from the loop while the pursuit is live
    const bar = new THREE.Group();
    const blk = (c: number) => new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.09, 0.2), new THREE.MeshBasicMaterial({ color: c }));
    const rl = blk(0x2a0008), bl = blk(0x001030);
    rl.position.x = 0.18; bl.position.x = -0.18;
    bar.add(rl, bl); bar.position.set(0, 1.38, -0.2);
    root.add(bar);
    copsLights = { r: rl.material as THREE.MeshBasicMaterial, b: bl.material as THREE.MeshBasicMaterial };
    scene.add(root);
    cops.root = root;
  }).catch(() => { /* no visual: the chase still works */ });
  let playerS = 0, copSpawned = false;
  /** the cop's roof light bar, once its model loads */
  let copsLights: { r: THREE.MeshBasicMaterial; b: THREE.MeshBasicMaterial } | null = null;
  /** test/dev hook: the headless probes set the dial directly */
  const setHeat = (n: number) => { heat.level = Math.max(0, Math.min(HEAT_MAX, n)); heat.lastGain = Date.now(); renderHeat(); menu.heat = heat.level; return heat.level; };
  const audio = new GameAudio();
  audio.prepare();   // the audio device opens now (behind the loading screen), not on the first key press
  let damage = new DamageVisuals(visual, visualCfg, pw, scene);
  let rumbleKj = 0;   // crash energy for the pad's rumble this frame
  let racePaid = false;   // this race's XP is in the career
  let raceImpacts = 0;    // crashes this race (clean-race bonus)
  let ranked: RankedLink | null = null;   // a party race's link to the online race room
  let freeRoamM = 0;      // metres driven in free roam this session (paid on leaving)
  toToggles(assistSet, input.assists);
  input.onAssistKey = () => { fromToggles(assistSet, input.assists); toToggles(assistSet, input.assists); saveAssists(assistSet); };
  const wireDamage = () => { damage.onImpact = (kj, glass) => { audio.impact(kj, glass); rumbleKj = Math.max(rumbleKj, kj); if (state === 'race' && kj > 3) raceImpacts++; }; };
  wireDamage();
  input.onAnyInput = () => audio.unlock();
  audio.muted = true;   // silent in the menus
  // Session state. boot/title/garage/busy: car parked on the start line under the orbit camera;
  // countdown: same, with 3-2-1; race: driving; paused: everything frozen; results: race over, car braked.
  type State = 'boot' | 'title' | 'garage' | 'modes' | 'lobby' | 'busy' | 'countdown' | 'race' | 'paused' | 'spectate' | 'results';
  let state: State = 'boot';
  let pausedFrom: State = 'race';
  let settledShowroom = 0;
  const driving = () => state === 'race' || state === 'countdown' || state === 'paused' || state === 'spectate' || state === 'results';
  const setState = (st: State) => {
    state = st;
    if (!driving()) settledShowroom = 0;
    document.body.classList.toggle('menu', !driving());
    // full realism race: no reset button (R does nothing)
    hud.canRecover = !realism();
    document.body.classList.toggle('noreset', !hud.canRecover);
    document.body.classList.toggle('spectating', st === 'spectate');
    syncHeadlights();
    if (city) city.props.drawScale = driving() ? DRAW_SCALE[post.preset] : Math.min(0.45, DRAW_SCALE[post.preset]);
  };
  // In the showroom (title/garage/busy) the nose spots are nearly off so they never bloom into a white veil over the bumper.
  const syncHeadlights = () => { visual.dim = driving() ? 1 : 0.008; visual.applyHeadlights(); };
  // brake 0.5, not 1: a full brake while stopped engages the pedal reverse
  const IDLE: RawInput = { steer: 0, throttle: 0, brake: 0.5, clutch: 0, handbrake: 1, shiftUp: false, shiftDown: false, device: 0 };
  let lapTimes: number[] = [], raceFinishedAt = -1;
  const prevPos = new THREE.Vector3(), prevQuat = new THREE.Quaternion();
  const physPos = new THREE.Vector3(), physQuat = new THREE.Quaternion();
  const readBody = (p: THREE.Vector3, q: THREE.Quaternion) => {
    const t = car.body.translation(), r = car.body.rotation();
    p.set(t.x, t.y, t.z);
    q.set(r.x, r.y, r.z, r.w);
  };
  const syncPose = () => {
    readBody(physPos, physQuat);
    prevPos.copy(physPos);
    prevQuat.copy(physQuat);
    pos.copy(physPos);
    quat.copy(physQuat);
    visual.update(pos, quat, car.out, physPos, physQuat);
  };
  /** Fresh car on the start line, repaired, traffic back at its grid slots, lap counter at zero. */
  const resetCar = () => {
    car.body.setEnabled(true);   // paused while spectating (the city streams around the watched car then)
    spawn(); core.repair(); damage.repair(); input.hold = true; settledShowroom = 0;
    syncPose();
    ai.reset();
    race = new CoreRace(routeJson, raceLaps());
    raceCar = race.addCar(car.body.translation());
    aiRace = ai.mode === 'race' ? ai.cars.map((c) => ({ idx: race.addCar(c.pos), lap: null, fin: -1 })) : [];
    raceT0 = ticks * DT;
    lapTimes = []; raceFinishedAt = -1; lap = null; racePaid = false; raceImpacts = 0;
    myDnf = ''; rolledT = stuckT = 0; hud.outWarn = '';
    hud.resetLaps();
    remoteProg.clear();
  };
  /** R in a race or a party: back on the road where you are (nearest route point, facing the right way), repaired. */
  const recover = () => {
    const t = car.body.translation();
    let best = 0, bd = Infinity;
    for (let i = 0; i < route.samples.length; i++) {
      const q = route.samples[i], d = (q.x - t.x) ** 2 + (-q.y - t.z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    const q = route.samples[best];
    const p = new THREE.Vector3(q.x, t.y + 3, -q.y);
    const hit = pw.raycast(p, p.clone().add(new THREE.Vector3(0, -30, 0)), car.body);
    if (hit) p.y -= hit.toi;
    p.y += core.info.cgHeight + 0.02;
    car.place(p, Math.atan2(Math.cos(q.heading), -Math.sin(q.heading)));
    car.settle();
    ranked?.reset();
    core.repair(); damage.repair(); input.hold = true;
    syncPose();
    remote?.kick();
  };
  input.onReset = () => {
    if (state !== 'race' || realism()) return;   // full realism: no resets in a race
    if (sel.mode === 'free') resetCar(); else recover();
  };
  input.onLights = () => { if (driving()) { visual.lightsOn = !visual.lightsOn; visual.applyHeadlights(); } };
  const enableTouch = () => {
    if (input.touch) return;
    document.body.classList.add('touch');
    input.touch = new TouchControls({
      reset: () => input.onReset(),
      camera: () => rig.toggle(),
      toggleGearbox: () => { input.assists.autoGearbox = !input.assists.autoGearbox; input.onAssistKey(); return input.assists.autoGearbox; },
      unlockAudio: () => audio.unlock(),
      garage: () => { if (driving()) quitSession(party ? 'lobby' : 'title'); },
      recentre: () => input.recentreTilt(),
      tilt: () => input.settings.touchSteering === 'tilt',
    });
  };
  const onTouch = () => { if (driving()) { enableTouch(); removeEventListener('touchstart', onTouch); } };
  // tilt steering chosen earlier: the motion permission (iOS) needs a tap, so ask on the first one
  const tiltAgain = () => { if (input.settings.touchSteering === 'tilt') void input.enableTilt(); removeEventListener('touchend', tiltAgain); };
  addEventListener('touchend', tiltAgain, { passive: true });
  addEventListener('touchstart', onTouch, { passive: true });
  input.onCamera = () => { if (driving()) rig.toggle(); };
  input.onHud = () => { if (driving()) hud.toggle(); };
  input.onGarage = () => { if (driving()) quitSession(party ? 'lobby' : 'title'); };

  // --- post-processing ------------------------------------------------------------------------
  const DRAW_SCALE: Record<PresetName, number> = { max: 1, ultra: 0.9, high: 0.9, medium: 0.78, low: 0.62, potato: 0.42 };
  const post = new Post(renderer, scene, camera, { bloom: params.get('bloom') !== '0', aa: params.get('aa') !== '0', scale, preset: PRESET_ORDER[presetIdx] });
  // The showroom's own pipeline on the garage scene. Phones keep their tuned pixel budget there too.
  const showPost = garage ? new ShowroomPost(renderer, garage.scene, camera, PRESET_ORDER[presetIdx]) : null;
  const showScale = (p: PresetName) => (isTouch ? Math.min(SHOW_PRESETS[p].scale, Math.max(0.5, guessScale())) : SHOW_PRESETS[p].scale);
  const syncShowPreset = () => {
    if (!garage || !showPost) return;
    const p = post.preset;
    showPost.preset = p;
    if (showPost.scale !== showScale(p)) showPost.setScale(showScale(p));
    garage.floor.setResolution(SHOW_PRESETS[p].mirror * (isTouch ? 0.5 : 1));
  };
  syncShowPreset();
  /**
   * Hero car in the garage or on the street. Only the MODEL moves between the scenes: the car's root (with its
   * headlight spots) stays in the city, so the city's light set - and with it every compiled city shader - never
   * changes. In the garage the car's reflection probe is filled from the room; back on the street it captures the city.
   */
  let inGarage = false;
  const IDENT_Q = new THREE.Quaternion();
  const setGarage = (on: boolean, recapture = true) => {
    if (!garage || on === inGarage) return;
    inGarage = on;
    if (on) {
      visual.model.position.set(0, 0, 0);
      garage.holder.add(visual.model);
      garage.holder.position.set(0, -visual.groundY, 0);
      if (garage.dirtyEnv) garage.captureEnv();
      probe?.fromCube(garage.cube.texture);
    } else {
      visual.root.add(visual.model);
      visual.model.position.copy(visual.cg).negate();
      if (recapture) { visual.root.updateMatrixWorld(true); probe?.captureAll(pos, visual.root); }
    }
    dimLamps(on);
  };
  const NEAR_TREES: Record<PresetName, number> = { max: 80, ultra: 80, high: 70, medium: 45, low: 28, potato: 14 };   // photoreal tree range, m
  // Street-light reach (clustered point lights): about half the per-pixel cost of the street is these lights, and
  // 0.7 x their authored range gives most of it back; below that nothing more is saved (measured).
  const LIGHT_RANGE: Record<PresetName, number> = { max: 0.9, ultra: 0.8, high: 0.74, medium: 0.7, low: 0.66, potato: 0.55 };
  /** street lights alive at once (the nearest ones): fewer lights, smaller cluster lists */
  const LIGHT_CAP: Record<PresetName, number> = { max: 36, ultra: 32, high: 28, medium: 22, low: 16, potato: 8 };
  post.onPreset = (p) => {
    city.setBundled(true); city.props.drawScale = driving() ? DRAW_SCALE[p] : Math.min(0.45, DRAW_SCALE[p]);
    const sp = nyc?.streetProps; if (sp) { sp.nearR = NEAR_TREES[p]; sp.rangeScale = LIGHT_RANGE[p]; sp.lightCap = LIGHT_CAP[p]; }
  };
  post.onPreset(post.preset);
  // Headlight shadow map: only the car bodies cast into it (the city does not cast), re-rendered
  // every Nth frame by preset (stale by one frame = ~1 m of light travel at 130 km/h, invisible:
  // map and light matrix stay paired, so shadows stay anchored to their casters).
  let headShadows = visual.headlights.filter((s) => s.castShadow).map((s) => s.shadow);
  for (const sh of headShadows) sh.autoUpdate = false;

  rig.update(1, pos.copy(car.body.translation() as THREE.Vector3), quat.copy(car.body.rotation() as THREE.Quaternion), new THREE.Vector3(), car.out);
  cityLights.update(1, camera);
  city.update(camera, true);
  mark('car, rivals, garage room, post');
  say('Compiling shaders…', 90);
  // Fast unified warm-up behind the loading screen: compile all scene materials once with unculled
  // meshes + props + particle sprites so GPU buffers, bind groups, and pipelines are created in one pass.
  /**
   * Precompile everything visible in a scene FOR THE TARGET IT IS DRAWN INTO. A pipeline belongs to its render target's
   * formats; renderer.compileAsync builds for whatever target happens to be current - at boot that was the environment
   * prefilter's leftover target, so every street material was compiled for a target nothing draws to and then again,
   * synchronously, on the first real frame (measured in potato: 136 of 220 pipelines were never used).
   */
  const compileFor = async (sc: THREE.Scene, target: THREE.RenderTarget) => {
    // Potato skips it: the precompile generates every shader a second time on the main thread (the warm-up frame that
    // follows builds its own copy), which doubled a throttled load (22 s -> 11 s without it, same 88 pipelines). The
    // normal boot keeps it: there it saves pipelines across its five presets (222 with, 260 without).
    if (params.has('precompile') ? params.get('precompile') === '0' : potato) return;
    renderer.setRenderTarget(target);
    try { await renderer.compileAsync(sc, camera); } finally { renderer.setRenderTarget(null); }
  };
  const warm = async () => {
    await compileFor(scene, post.sceneTarget);
    probe?.captureAll(pos, visual.root);
    for (const sh of headShadows) sh.needsUpdate = true;
    post.warmup();
  };
  city.props.warmup(true);
  nyc?.breaches.warmup(true, pos);   // room / rubble / portal materials compiled now, not at the first crash
  damage.warmup(true);
  visual.update(pos, quat, car.out);
  if (ai.cars.length && !potato) {   // potato compiles the rivals at the first race start (compileRivals), not here
    const yaw = Math.atan2(Math.cos(s0.heading), -Math.sin(s0.heading));
    ai.stage(pos.clone().setY(pos.y - core.info.cgHeight - 0.05), yaw);
    ai.mode = 'race';
    ai.update(1, camera);
  }
  {
    const culled: THREE.Object3D[] = [];
    scene.traverse((o) => { if (o.frustumCulled && (o as THREE.Mesh).isMesh) { o.frustumCulled = false; culled.push(o); } });
    await warm();
    mark('compile street');
    // one real frame per likely preset with culling off: GPU buffers/bind groups for every city tile + prop
    // are created now (rendering presets back to back inside one frame skips per-frame node updates)
    await post.warmupFrames();
    for (const o of culled) o.frustumCulled = true;
  }
  mark('warm presets');
  {
    const dmgInt = damage as unknown as { killLights(n: string[]): void; fireLight: THREE.PointLight };
    visual.lightsOn = false; visual.applyHeadlights();
    dmgInt.killLights([...visualCfg.front_lights, ...visualCfg.rear_lights]);
    dmgInt.fireLight.intensity = 30;
    await compileFor(scene, post.sceneTarget);
    post.render();
    dmgInt.fireLight.intensity = 0;
    damage.repair();
    visual.lightsOn = true; visual.applyHeadlights();
  }
  mark('compile damage states');
  // the garage: car in the room, room into the cube, every showroom preset once
  if (garage && showPost) {
    setGarage(true);
    await compileFor(garage.scene, showPost.sceneTarget);
    garage.captureEnv();
    probe?.fromCube(garage.cube.texture);
    await showPost.warmup();
    setGarage(false, false);
  }
  mark('compile garage');
  if (garage) void garage.loadProps().catch(() => { /* the room works without its dressing */ });
  ai.setMode('off');
  city.props.warmup(false);
  nyc?.breaches.warmup(false);
  nyc?.endWarm();
  damage.warmup(false);
  city.update(camera, true);
  if (webgpu) await (renderer.backend as unknown as { device: GPUDevice }).device.queue.onSubmittedWorkDone();
  const pipelinesAtStart =(renderer as unknown as { _pipelines: { caches: Map<string, unknown> } })._pipelines.caches.size;
  mark('ready');
  readyDone();
  const setExtra = () => (hud.extra = `${backend} · ${Math.floor(renderer.domElement.width * scale)}×${Math.floor(renderer.domElement.height * scale)}`
    + ` → ${renderer.domElement.width}×${renderer.domElement.height} · scale ${+scale.toFixed(2)}${adaptive ? '' : ' (fixed)'}`
    + ` · ${post.preset}${presetPinned ? ' (fixed)' : ''} · ${cityLights.mode}`
    + (party ? ` · party ${party.code} · ${party.members.length} driver${party.members.length > 1 ? 's' : ''}` : ''));
  setExtra();

  // --- loop: fixed 240 Hz physics, render every frame -----------------------------------------
  let acc = 0, prev = performance.now(), ticks = 0;
  const frameTimes: number[] = [];
  // Graphics tuning. It runs ONLY from the title menu, behind an opaque cover (menu.ts), so no
  // resolution or preset change is ever visible with a car on screen, and nothing changes while
  // driving. Windows of 1 s average the fps of the parked showroom view (a drive costs more, hence
  // the 40 fps bar rather than 30): below it -> cheaper preset first (no hitch), then -0.1 scale
  // (min 0.5); above 55 fps with 90 % of frames < 22 ms -> +0.1 (only if nothing was lowered).
  // The settled scale and preset are stored per window size, so the next visit is one window.
  // The tuner measures with the cap off, so its target is the uncapped rate that still holds the cap: 30 fps needs
  // ~30.6 uncapped, not 36 - that number threw a preset tier away for headroom nobody sees. Phones keep their 48.
  const WINDOW = 650, STEP = 0.1, MIN_SCALE = MIN_RENDER, TUNE_TIMEOUT = 15000;
  /** the target the tuner protects (fps), and the median frame time that still holds it, with a 3 % margin */
  // The quality target is its own number now (?target=), independent of the cap: uncapped rendering must not make the
  // tuner chase 60 and spend the whole quality budget (that was the "tiers do nothing" bug). Default 30.
  const TUNE_TARGET = num('target', 30);
  const FRAME_BUDGET = (1000 / TUNE_TARGET) * 1.03;
  /** resolution gives way before an effect tier does; phones stop at 0.5 (the old 1x picture) before dropping effects */
  const RES_FLOOR = isTouch ? 0.5 : MIN_SCALE;
  let winStart = 0, tuning = false, upSteps = 0, wentDown = false, tuneStart = 0, lowStreak = 0, okStreak = 0, quietWindows = 0;
  /** the last valid windows' median frame times: a single noisy window must not move the scale (title-screen p50 swings 26-39 ms) */
  const p50s: number[] = [];
  const medianP50 = () => (p50s.length ? [...p50s].sort((a, b) => a - b)[p50s.length >> 1] : 0);
  /**
   * The title camera streams the city in for a few seconds. fps while it does is CPU-bound and does not move with
   * render scale (measured: 25.3 fps at 1.0, 0.9, 0.8 and 0.7 - docs/performance.md), so those windows must not
   * decide anything; once the streamer is dry the same screen reads 24.6 / 27.3 / 31.1 fps at scale 1.0 / 0.8 / 0.6.
   */
  const citySettled = () => { const s = nyc?.stats(); return !s || (s.loading === 0 && s.queued === 0); };
  let driveWinTime = 0, driveFrames = 0, lowDrive = 0;
  /**
   * A phone at the resolution floor that still misses the target on `low` - or misses it by 40 % on any preset - needs
   * potato: a different boot (one pipeline, no shadows, short rings), so the flag is stored and the page reloads behind
   * the tuning cover.
   */
  const needsPotato = (fps: number) => isTouch && !potato && !presetPinned && scale <= RES_FLOOR + 1e-6
    // on `low` already, or so far under the target that the effects between here and `low` (bloom, FXAA) cannot close it
    && (presetIdx === PRESET_ORDER.length - 1 || fps < TUNE_TARGET * 0.6);
  /** false when the flag cannot be stored (storage blocked): reloading then would tune and reload forever */
  const goPotato = () => {
    try { localStorage.setItem(POTATO_KEY, '1'); if (localStorage.getItem(POTATO_KEY) !== '1') return false; } catch { return false; }
    location.reload();
    return true;
  };
  const POTATO_NOTE = noWebGPU ? 'Potato mode on WebGL 2: this browser has no WebGPU, which every other preset needs.'
    : 'Potato mode: the lightest picture, for low-end phones. Pick another preset to leave it (the game reloads).';
  const startScale = () => guessScale();
  /** `resize`: also move to the preset's own pixel budget (desktop; a render-target resize, so never while driving). */
  const setPreset = (i: number, resize = true) => {
    presetIdx = i;
    post.preset = PRESET_ORDER[i];
    if (resize && !isTouch && !scalePinned && scale !== presetScale(post.preset)) applyScale(presetScale(post.preset));
    syncShowPreset();
    try { localStorage.setItem(PRESET_KEY, post.preset); } catch { /* storage blocked */ }
  };
  const applyScale = (x: number) => {
    scale = Math.min(maxScale, Math.max(MIN_SCALE, Math.round(x * 20) / 20));
    post.setScale(scale);   // render targets + cluster grid resize: the hitch the cover hides
    try { localStorage.setItem(SCALE_KEY, String(scale)); } catch { /* storage blocked */ }
  };
  /**
   * Window or fullscreen size changed. The PRESET stays (changing it builds new pipelines: seconds of shader compiles,
   * the old 10 s fullscreen freeze). The render scale keeps the pixel count the GPU was tuned for: a 1.0 scale tuned in
   * a 1280x800 window becomes ~0.7 at 1920x1080 fullscreen. A scale stored for the new size wins (tuned there before).
   */
  let lastSize = `${innerWidth}x${innerHeight}`, lastPixels = innerWidth * innerHeight;
  function syncToSize() {
    const k = `${innerWidth}x${innerHeight}`;
    if (k === lastSize) return;
    const px = innerWidth * innerHeight, ratio = Math.sqrt(lastPixels / Math.max(1, px));
    lastSize = k; lastPixels = px;
    SCALE_KEY = `nr.scale.v5.${k}`; PRESET_KEY = `nr.preset.v5.${k}`;
    try { localStorage.setItem(PRESET_KEY, post.preset); } catch { /* storage blocked */ }
    if (!adaptive && isTouch) return;
    let sc = NaN;
    try { sc = Number(localStorage.getItem(SCALE_KEY) ?? NaN); } catch { /* storage blocked */ }
    stored = sc;
    if (!isTouch) { if (!scalePinned) applyScale(presetScale(post.preset)); setExtra(); return; }
    applyScale(sc >= MIN_SCALE && sc <= maxScale ? sc : scale * ratio);
    setExtra();
  }
  const startTuning = (full: boolean) => {
    if (!full && !Number.isNaN(stored) && storedPreset && PRESET_ORDER.includes(storedPreset as PresetName)) {
      finishTuning();
      return;
    }
    tuning = true; wentDown = false; lowStreak = 0; okStreak = 0; quietWindows = 0; p50s.length = 0; tuneStart = performance.now();
    upSteps = full ? 1 : 0;
    if (full || Number.isNaN(stored)) { setPreset(PRESET_ORDER.indexOf(defaultPreset)); if (isTouch) applyScale(startScale()); }
    frameTimes.length = 0;
    winStart = performance.now() + 450;   // let the cover frame pacing settle briefly
    menu.setTuning(true);
    setExtra();
  };
  const finishTuning = () => {
    tuning = false;
    frameTimes.length = 0;
    menu.setTuning(false, `Graphics tuned for this device: ${post.preset}, ${Math.round(scale * 100)} % resolution`);
    setExtra();
  };
  const applyGfx = (g: Gfx) => {
    gfx = g;
    try {
      localStorage.setItem(GFX_KEY, g);
      if (g === 'auto') localStorage.removeItem(POTATO_KEY);   // Auto measures again (a weak GPU by name still boots potato)
    } catch { /* storage blocked */ }
    // Into or out of potato: the pipelines, shadow maps and city rings of the other side were never built. Reload.
    if (noWebGPU) { menu.setTuning(false, POTATO_NOTE); return; }   // nothing else can run here
    if (potato !== (g === 'potato')) { menu.setTuning(true); location.reload(); return; }
    if (g === 'auto') { adaptive = true; presetPinned = false; startTuning(true); return; }
    adaptive = false; presetPinned = true;
    tuning = false;
    setPreset(PRESET_ORDER.indexOf(g));
    applyScale(presetScale(g));   // desktop: the preset's pixel budget; phones: fixed presets keep the tuned budget
    menu.setTuning(false, `Graphics fixed: ${g}`);
    setExtra();
  };
  let stepMs = 0;
  const trace: unknown[] = [];
  const g = window as unknown as { __game: object };
  // Hidden tab: requestAnimationFrame stops, so nothing renders; restart the tuning window and the
  // frame clock on return (the hidden time would read as one enormous frame).
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { frameTimes.length = 0; if (tuning) winStart = performance.now() + 1000; prev = performance.now(); }
  });
  let frameNo = 0;
  g.__game = { city, nyc, ai, visual, audio, rig, damage, trace, input, renderer, camera, scene, post, THREE, grade: GRADE, heat, setHeat, cops, stats: () => frameStats(scene, renderer), texStats: () => sceneTextureStats(scene, 0),
    get car() { return car; }, get core() { return core; }, get state() { return state; }, ticksNow: () => ticks, routeSamples: route.samples, menu: () => menu, sel,
    get party() { return party; }, get remote() { return remote; }, streetProps, obstacles, standings: () => standings(), get lap() { return lap; },
    bench: (soak = false) => runBench(soak),
    setPreset: (name: PresetName) => { setPreset(PRESET_ORDER.indexOf(name)); setExtra(); },
    garage, showPost, probe, get inGarage() { return inGarage; },
    setScale: (x: number) => { scale = x; post.setScale(x); setExtra(); },
    presetScale, get scale() { return scale; },
    pipelines: () => ({ atStart: pipelinesAtStart, now: (renderer as unknown as { _pipelines: { caches: Map<string, unknown> } })._pipelines.caches.size }),
    // Rapier cost per step + what it simulates (static city colliders have no body: never integrated)
    physics: () => ({ stepMs, bodies: pw.world.bodies.len(), colliders: pw.world.colliders.len(),
      list: pw.world.bodies.getAll().map((b) => `${b === car.body ? 'car' : b.isKinematic() ? 'ai' : 'debris'}:${b.isSleeping() ? 'asleep' : 'awake'}`).join(' ') }),
    info: () => ({ pos: car.body.translation(), speed: car.out[OUT.speed], rpm: car.out[OUT.rpm], gear: car.out[OUT.gear] }) };

  // --- benchmark (bench.ts): scripted drive along the route, per preset: uncapped, then at the cap; optional soak ------------
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const bench = { active: false, uncap: false, dist: 0, speed: 26, dy: 0, stamps: [] as number[], cb: [] as number[], gpu: [] as number[], pending: false, ts: false };
  const benchPos = new THREE.Vector3();
  const benchStep = (frame: number) => {   // from the loop: the car is PLACED on the route each frame (same load every run, no physics noise)
    bench.dist += bench.speed * frame;
    const smp = route.samples[Math.floor(bench.dist / 2) % route.samples.length];
    benchPos.set(smp.x, smp.z + bench.dy, -smp.y);
    car.place(benchPos, Math.atan2(Math.cos(smp.heading), -Math.sin(smp.heading)), bench.speed);
  };
  const runBench = async (soak: boolean): Promise<BenchReport | null> => {
    if (state !== 'title' || bench.active) return null;
    const keepIdx = presetIdx, keepAdaptive = adaptive;
    adaptive = false;
    menu.show('none'); resetCar(); setState('race'); hud.show(); audio.muted = true;
    bench.dy = car.body.translation().y - s0.z; bench.dist = 0;
    bench.ts = (renderer as unknown as { hasFeature(f: string): boolean }).hasFeature('timestamp-query');
    (renderer.backend as unknown as { trackTimestamp: boolean }).trackTimestamp = bench.ts;
    bench.active = true;
    const benchCap = capFps || autoCap(hz, isTouch ? 60 : 60);
    const benchCapInterval = 1000 / benchCap;
    const collect = async (ms: number, uncap: boolean) => {
      bench.uncap = uncap; bench.stamps = []; bench.cb = []; bench.gpu = [];
      await sleep(ms);
      return stats(bench.stamps.slice(), bench.cb.slice(), bench.gpu.slice(), uncap ? 0 : benchCapInterval);
    };
    const phases: PhaseResult[] = [];
    for (const [i, name] of PRESET_ORDER.entries()) {
      setPreset(i); setExtra();
      benchProgress(`${name} (${i + 1}/${PRESET_ORDER.length}): warming up`);
      bench.uncap = true; await sleep(2000);
      benchProgress(`${name} (${i + 1}/${PRESET_ORDER.length}): uncapped (what the device can do)`);
      const open = await collect(5000, true);
      benchProgress(`${name} (${i + 1}/${PRESET_ORDER.length}): locked at ${benchCap} fps`);
      const capped = await collect(8000, false);
      phases.push({ preset: name, open, capped });
    }
    const recommended = recommend(phases, benchCap);
    let soakRes: BenchReport['soak'];
    if (soak) {
      setPreset(PRESET_ORDER.indexOf(recommended as PresetName)); setExtra();
      const windows: SoakWindow[] = [], total = num('soak', 300) * 1000, step = 15000;
      for (let t = 0; t < total; t += step) {
        benchProgress(`soak ${recommended}: ${Math.round(t / 1000)} / ${Math.round(total / 1000)} s`);
        const st = await collect(step, false);
        windows.push({ t: t / 1000, fps: st.fps, late: st.late, p99: st.p99 });
      }
      soakRes = { preset: recommended, windows };
    }
    bench.active = false; bench.uncap = false;
    setPreset(keepIdx); adaptive = keepAdaptive; setExtra();
    hud.hide(); audio.muted = true; resetCar(); setState('title'); menu.show('title');
    benchClose();
    const info = await navigator.gpu?.requestAdapter().then((a) => (a as unknown as { info?: { description?: string; vendor?: string; architecture?: string } } | null)?.info).catch(() => undefined);
    const report: BenchReport = {
      when: new Date().toISOString(), ua: navigator.userAgent, screen: [innerWidth, innerHeight], dpr: devicePixelRatio, hz, cap: capFps, scale, timestamps: bench.ts,
      gpu: info ? (info.description || [info.vendor, info.architecture].filter(Boolean).join(' ')) || 'unknown GPU' : 'unknown GPU', phases, recommended, soak: soakRes,
    };
    benchResults(report, (p) => { setPreset(PRESET_ORDER.indexOf(p as PresetName)); setExtra(); menu.setTuning(false, `Graphics set from the benchmark: ${p}`); });
    return report;
  };

  // --- front end: title -> garage -> session -------------------------------------------------
  let garagePreloaded = false;
  const preloadGarageCars = () => {
    if (garagePreloaded) return;
    garagePreloaded = true;
    for (const c of catalog) {
      const p = visualPathOf(c.id);
      if (p !== visualPath) void fetchVisualCfg(p);
    }
  };
  const paintInt = () => parseInt(paintOf(sel, catalog).slice(1), 16);
  const meForParty = () => ({ name: sel.name, car: sel.car, paint: paintInt(), skin: sel.skin, look: customOf(sel) });
  /** The garage look (parts, colours) and the driver's skin on the car on show. */
  const applyLook = () => { visual.custom.apply(customOf(sel), paintOf(sel, catalog)); visual.driver.setSkin(skinOf(sel.skin)); };
  /** The online account keeps each car's look; a garage click pushes once (debounced) once the profile is known. */
  let lookPush = 0;
  const pushLook = () => {
    if (!mp.profile) return;
    clearTimeout(lookPush);
    lookPush = window.setTimeout(() => { void cloud.saveLook(sel.car, customOf(sel)).catch(() => { /* offline: the look stays local */ }); }, 700);
  };
  const isShowroom = (st: State) => st === 'title' || st === 'garage' || st === 'modes' || st === 'lobby' || st === 'busy';
  const menu: Menu = new Menu(sel, catalog, physics, {
    preview: () => { void (async () => {
      // a different model: the loading screen covers the download and the first frames with the new car (shader
      // compiles), and lifts once the garage renders steadily again
      const swap = visualPathOf(sel.car) !== visualPath;
      if (swap) await loader.show(`Loading ${catalog.find((c) => c.id === sel.car)?.name ?? 'car'}…`);
      await showCar();
      visual.setPaint(paintOf(sel, catalog), sel.finish);
      applyLook();
      party?.updateMe(meForParty());
      if (swap) { await steadyFrames(5, 70, 6000); loader.hide(); }
    })(); },
    play: (mode) => void startSession(mode),
    gfx: (g2) => applyGfx(g2),
    resume: () => resume(),
    restart: () => { menu.show('none'); if (raceLaps() > 0) void beginRace(); else { resetCar(); setState('race'); audio.muted = false; prev = performance.now(); } },
    quit: (to) => quitSession(party ? 'lobby' : to),
    bench: (soak) => void runBench(soak),
    screen: (sc: Screen) => {
      if (sc === 'garage') { orbit.dist = 6.6; orbit.el = 0.17; }   // whole car in frame, just above the belt line
      if (sc === 'title' || sc === 'garage' || sc === 'modes' || sc === 'lobby') setState(sc);
      if (sc === 'garage') preloadGarageCars();
    },
    // garage camera presets are relative to the car: 0 = in front, pi/2 = the driver's (left) side, pi = behind
    cam: (az, el, dist) => {
      if (Number.isNaN(az)) { orbit.holdUntil = 0; orbit.el = 0.17; orbit.dist = 6.8; orbit.drag = false; return; }   // Orbit button: turntable now
      orbit.az = az; orbit.el = el; orbit.dist = dist; orbit.drag = false;   // in the garage the car's nose points down +z
      orbit.holdUntil = performance.now() + 15000;   // the turntable waits while you look at that part
    },
    // ---- multiplayer ----
    partyCreate: () => {
      if (menu.partyBusy) return;
      menu.partyBusy = true; menu.partyNote = ''; menu.render();
      Party.create(meForParty()).then(attachParty, (e: Error) => { menu.partyNote = e.message; })
        .finally(() => { menu.partyBusy = false; if (menu.screen === 'lobby') menu.render(); });
    },
    partyJoin: (code) => {
      code = cleanCode(code);
      if (menu.partyBusy) return;
      if (code.length < 4) { menu.partyNote = 'Type the party code your friend sent you.'; menu.render(); return; }
      menu.partyBusy = true; menu.partyNote = ''; menu.render();
      Party.join(code, meForParty()).then(attachParty, (e: Error) => { menu.partyNote = e.message; })
        .finally(() => { menu.partyBusy = false; if (menu.screen === 'lobby') menu.render(); });
    },
    partyLeave: () => {
      party?.leave();
      detachParty('');
    },
    partyMode: (mode, laps, real) => party?.setMode(mode, laps, real),
    partyStart: () => party?.start(),
    partyLobby: () => { if (party?.isHost) party.backToLobby(); quitSession('lobby'); },
    partyRejoin: () => { if (party?.phase === 'driving') void startSession('online', true); },
    partyMe: () => party?.updateMe(meForParty()),
    spectate: () => enterSpectate(),
    assists: () => { toToggles(assistSet, input.assists); saveAssists(assistSet); },
    look: () => { applyLook(); party?.updateMe(meForParty()); pushLook(); },
    // the bank/pay choice: spend reputation to clear the wanted level before the next race
    layLow: () => { if (sp.kind !== 'sp' || sp.xp < 300) return; sp.penalty(300); heat.clear(); renderHeat(); menu.heat = 0; menu.render(); },
    // driving camera chosen in Settings: chase / far / cinematic / hood / bumper (C cycles)
    camMode: (mode) => { try { localStorage.setItem('nr.cam', mode); } catch { /* blocked */ } rig.setMode(mode as never); },
  });
  menu.gfx = gfx;
  const loader = new Loader();
  menu.loader = loader;
  menu.sp = sp;
  menu.mp = mp;
  menu.layLowCost = sp.kind === 'sp' ? 300 : -1;   // reputation is the SP wallet; the online career has no spend path yet
  try { const cam = localStorage.getItem('nr.cam'); if (cam) menu.camMode = cam; } catch { /* blocked */ }
  const rerender = () => { if (['title', 'shop', 'garage', 'lobby', 'results', 'settings', 'profile'].includes(menu.screen)) menu.render(); };
  let syncedProfile: unknown = null;
  let looksPulled = false;
  mp.onChange = () => {
    if (mp.profile && mp.profile !== syncedProfile) {
      syncedProfile = mp.profile;
      void identity.sync(mp.profile);
      // the account's saved looks arrive once per session; after that local edits are pushed, not pulled over
      if (!looksPulled) {
        looksPulled = true;
        let applied = false;
        for (const [car, look] of Object.entries(mp.profile.looks ?? {})) {
          if (!catalog.some((c) => c.id === car)) continue;
          sel.custom[car] = cleanCustom(look);
          applied = true;
        }
        if (applied) { saveSelection(sel); applyLook(); }
        if (!mp.profile.looks?.[sel.car]) pushLook();   // nothing saved yet: keep the look this device already has
      }
    }
    rerender();
  };
  let mpLoadTried = false;
  identity.onChange = () => {
    party?.updateMe(meForParty()); visual.setPlate(sel.name);
    if (!mpLoadTried && cloud.id && !mp.profile) { mpLoadTried = true; void mp.refresh(); }
    rerender();
  };
  menu.cloud = cloud;
  menu.identity = identity;
  if (cloud.id) void mp.refresh();   // an online account exists on this device: show its level / credits on the title
  else if (cloud.available && !identity.needsPick && !identity.claimed) void identity.pick(sel.name);   // claim the name picked offline
  const presenceBeat = identity.startPresence(() => party?.code ?? null);
  menu.assists = assistSet;
  applyLook();
  const drivingLine = new DrivingLine(scene, ai);
  // GPS minimap: the tiles' road graphs (loaded in the background), the race route, rivals / players
  const minimap = new Minimap(document.getElementById('hud')!);
  minimap.setRoute(route.samples);
  input.onMap = () => minimap.show(!minimap.visible);
  if (nyc) void (async () => {
    try {
      const idx = await fetch('/assets/nyc/tiles/index.json').then((r) => r.json()) as { tiles: Record<string, { files: string[] }> };
      const names = Object.entries(idx.tiles).filter(([, t]) => t.files.some((f) => f.endsWith('.graph.json'))).map(([k]) => k);
      for (let i = 0; i < names.length; i += 6)   // a few at a time: never competes with the city tiles for long
        await Promise.all(names.slice(i, i + 6).map((k) => fetch(`/assets/nyc/tiles/${k}.graph.json`).then((r) => r.json()).then((g) => minimap.addGraph(g)).catch(() => {})));
    } catch { /* no map: the minimap shows the route only */ }
  })();
  const mmFwd = new THREE.Vector3();
  drivingLine.setCar(applyMods(physics[sel.car], modsOf(sel)));
  // every input device: force feedback (WebHID wheels), the Controls screen, pad / keyboard menu navigation
  const ffb = new ForceFeedback();
  const forwardGears = () => Math.max(1, ((physics[sel.car] as { drivetrain?: { gear_ratios?: number[] } })?.drivetrain?.gear_ratios?.length ?? 8) - 2);
  menu.ctl = new ControlsUi(input, ffb, () => { if (menu.screen === 'controls') menu.render(); }, forwardGears);
  const menuNav = new MenuNav(document.getElementById('menu')!);
  const helpEl = document.getElementById('help');
  input.onDevice = () => { if (helpEl) helpEl.innerHTML = input.helpHtml(); };
  (g.__game as Record<string, unknown>).ffb = ffb;
  (g.__game as Record<string, unknown>).input = input;
  {
    const inv = cleanCode(params.get('party') ?? '');
    if (inv.length >= 4) menu.invite = inv;
  }

  /** Party session: the leader started (load now), everyone is in (go), back to the lobby, others' cars and progress. */
  let partyGo = false, loadingSession = false;
  function attachParty(p: Party) {
    party = p;
    menu.party = p;
    presenceBeat();   // friends see the party at once
    menu.partyNote = '';
    menu.invite = '';
    if (params.has('party')) history.replaceState(null, '', location.pathname + location.search.replace(/[?&]party=[^&]*/, '').replace(/^&/, '?'));
    if (p.isHost) p.setMode(p.mode, p.laps, sel.realism);   // the leader's own rules setting is the party default
    p.hooks = {
      changed: () => {
        if (remote) { remote.names = new Map(p.members.map((m) => [m.id, m.name])); remote.looks = new Map(p.members.map((m) => [m.id, { skin: m.skin, look: m.look }])); remote.refreshTags(); }
        if (menu.screen === 'lobby' || menu.screen === 'modes') menu.render();
        setExtra();
      },
      start: () => { partyGo = false; void startSession('online'); },
      go: () => { if (loadingSession) partyGo = true; else if (state === 'busy') void beginRace(); },
      lobby: () => { if (driving() || state === 'busy') quitSession('lobby'); else if (menu.screen === 'lobby') menu.render(); },
      pose: (id, ps, paint) => { if (remote && (driving() || state === 'busy')) remote.receive(id, ps, paint); },
      progress: (id, gp) => { remoteProg.set(id, gp); if (state === 'results') menu.updateResults(standings()); },
      left: (id) => { remote?.remove(id); remoteProg.delete(id); if (state === 'spectate') specRetarget(); },
      gone: (id) => { remote?.remove(id); if (state === 'spectate') specRetarget(); },
      breach: (spec: BreachSpec) => { if (driving()) nyc?.breaches.open(spec); },
      pole: (x, y, vx, vz) => {
        const pl = streetProps?.poleAt(x, y);
        if (pl && driving()) poleHit({ pole: pl, point: { x: pl.x, y: pl.z, z: -pl.y }, impulse: 0, vx, vz }, false);
      },
      closed: (reason) => detachParty(reason),
    };
    menu.show('lobby');
    setExtra();
  }
  function detachParty(reason: string) {
    party = null;
    menu.party = null;
    presenceBeat();
    menu.partyNote = reason;
    if (driving() || state === 'busy') quitSession('lobby');
    else if (menu.screen === 'lobby') menu.render();
    else if (reason) menu.show('lobby');
    setExtra();
  }

  /** Everyone in the race, in order: you, the AI rivals (single player) or the party (online). */
  function standings(): Standing[] {
    const L = lap?.routeLength ?? route.length_m;
    const myFin = lap?.finished ? lapTimes.reduce((a, b) => a + b, 0) : -1;
    const list: Standing[] = [{ name: sel.name, you: true, fin: myFin, d: lap?.distance ?? -L, best: lap?.best ?? 0, ai: false, dnf: !!myDnf, why: myDnf }];
    if (sel.mode === 'race') ai.cars.forEach((c, i) => { const r = aiRace[i]; if (r) list.push({ name: c.name, you: false, fin: r.fin, d: r.lap?.distance ?? 0, best: r.lap?.best ?? 0, ai: true }); });
    if (sel.mode === 'online' && party) for (const m of party.members) {
      if (m.id === party.selfId) continue;
      const g = remoteProg.get(m.id);
      list.push({ name: m.name, you: false, fin: g?.fin ?? -1, d: g?.d ?? -L, best: g?.best ?? 0, ai: false, dnf: !!g?.dnf });
    }
    return list;
  }
  // ---- full realism: out of the race, then spectate ------------------------------------------------
  // Same rules as the core's RaceTracker::check_out: totaled, upside down for 5 s, or stuck (< 1 km/h) for 30 s.
  const ROLL_OUT_S = 5, STUCK_OUT_S = 30;
  function checkOut(frame: number) {
    if (!realism() || myDnf || lap?.finished) { hud.outWarn = ''; return; }
    const upY = 1 - 2 * (physQuat.x * physQuat.x + physQuat.z * physQuat.z);   // body up . world up
    rolledT = upY < 0.3 ? rolledT + frame : 0;
    stuckT = Math.abs(car.out[OUT.speed]) < 0.28 ? stuckT + frame : 0;
    const why = damage.last?.totaled ? 'wrecked' : rolledT > ROLL_OUT_S ? 'rolled over' : stuckT > STUCK_OUT_S ? 'stuck' : '';
    hud.outWarn = rolledT > 0.5 ? `ROLLED OVER · OUT IN ${Math.ceil(ROLL_OUT_S - rolledT)} s` : stuckT > STUCK_OUT_S - 10 ? `STUCK · OUT IN ${Math.ceil(STUCK_OUT_S - stuckT)} s` : '';
    if (!why) return;
    myDnf = why;
    hud.outWarn = '';
    ranked?.dnf(why);
    party?.sendProgress({ d: lap?.distance ?? 0, lap: lap?.laps ?? 0, fin: -1, best: lap?.best ?? 0, dnf: 1 });
    enterSpectate(`OUT · ${why.toUpperCase()}`);
  }

  /** Cars to watch: the AI rivals (single player) or the other players, best placed first. */
  type SpecTarget = { name: string; body: RAPIER.RigidBody | null; root: THREE.Object3D; ground: boolean; speed: () => number };
  function specTargets(): SpecTarget[] {
    const order = rank(standings()).map((x) => x.name);
    const list: SpecTarget[] = [];
    if (sel.mode === 'race') for (const c of ai.cars) list.push({ name: c.name, body: c.body, root: c.root, ground: true, speed: () => c.v });
    if (remote && party) for (const id of remote.ids()) {
      const r = remote.get(id);
      if (r) list.push({ name: party.members.find((m) => m.id === id)?.name ?? 'Driver', body: r.body, root: r.root, ground: false, speed: () => 0 });
    }
    return list.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  }
  let specIdx = 0, specName = '', specLabel = '', specAt = 0, resAt = 0, resKey = '';
  const specOut = new Float64Array(car.out.length), specPos = new THREE.Vector3(), specQuat = new THREE.Quaternion(), specPrev = new THREE.Vector3();
  const specEl = document.getElementById('spectate')!;
  function enterSpectate(label = specLabel || (lap?.finished ? 'FINISHED' : 'OUT')) {
    specLabel = label;
    setState('spectate');
    menu.show('none');
    audio.muted = true;
    specAt = performance.now();
    specIdx = 0; specName = '';
    specRetarget();
    specEl.hidden = false;
    car.body.setEnabled(false);   // out of the race: parked; its ground may unload while the city follows the watched car
  }
  function hideSpectate() { specEl.hidden = true; }
  function specRetarget() {
    const t = specTargets();
    if (!t.length) { if (state === 'spectate') finishRace(); return; }
    const keep = t.findIndex((x) => x.name === specName);
    specIdx = keep >= 0 ? keep : Math.min(specIdx, t.length - 1);
    const cur = t[specIdx];
    specName = cur.name;
    if (cur.body) rig.setTarget(cur.body, 7000);
    specPrev.copy(cur.root.position);
    rig.snap();
    specEl.innerHTML = `<span class="sp-out">${specLabel}</span><span class="dim">Spectating</span><b></b>
      <button type="button" data-sp="-1" aria-label="Previous car">◀</button><button type="button" data-sp="1" aria-label="Next car">▶</button>
      <button type="button" data-sp="res">Results</button>`;
    specEl.querySelector('b')!.textContent = `${specIdx + 1}. ${cur.name}`;
  }
  function specStep(d: number) { const n = specTargets().length; if (!n) return; specIdx = (specIdx + d + n) % n; specName = ''; specRetarget(); }
  specEl.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('[data-sp]') as HTMLElement | null;
    if (!b || state !== 'spectate') return;
    if (b.dataset.sp === 'res') finishRace(); else specStep(Number(b.dataset.sp));
  });
  function specCamera(frame: number) {
    const cur = specTargets().find((x) => x.name === specName);
    if (!cur) { specRetarget(); return; }
    specPos.copy(cur.root.position);
    if (cur.ground) specPos.y += 0.5;           // AI roots sit on the road, players' at the body centre
    specQuat.copy(cur.root.quaternion);
    const v = frame > 0 ? specPrev.distanceTo(cur.root.position) / frame : 0;
    specPrev.copy(cur.root.position);
    specOut[OUT.speed] = cur.ground ? cur.speed() : v;
    rig.update(frame, specPos, specQuat, stepAcc.set(0, 0, 0), specOut);
  }

  /** HUD running order: gap to the car in front, in seconds at the current speed (distance-based) or metres. */
  let boardAt = 0, progAt = 0;
  function updateBoard(now: number) {
    if (now - boardAt < 250) return;
    boardAt = now;
    if (raceLaps() === 0) { hud.board(null); return; }
    const ranked = rank(standings());
    if (ranked.length < 2) { hud.board(null); return; }
    hud.board(ranked.map((s, i) => {
      if (i === 0) return { name: s.name, gap: s.fin >= 0 ? 'FIN' : 'LEADER', you: s.you };
      const a = ranked[i - 1];
      const gap = s.dnf ? 'DNF' : s.fin >= 0 ? (a.fin >= 0 ? `+${(s.fin - a.fin).toFixed(1)}s` : 'FIN') : `+${Math.max(0, Math.round(a.d - s.d))} m`;
      return { name: s.name, gap, you: s.you };
    }));
  }
  document.getElementById('hud-garage')?.addEventListener('click', () => { if (driving()) quitSession(party ? 'lobby' : 'title'); });
  const togglePause = () => {
    if (state === 'spectate') { finishRace(); return; }
    if (state === 'race') { pausedFrom = state; setState('paused'); audio.muted = true; menu.show('pause'); }
    else if (state === 'paused') resume();
  };
  document.getElementById('hud-pause')?.addEventListener('click', togglePause);
  input.onPause = togglePause;   // Start / Options / Menu on a pad, the mapped button on a wheel
  document.getElementById('hud-reset')?.addEventListener('click', () => input.onReset());
  document.getElementById('hud-cam')?.addEventListener('click', () => { if (driving()) rig.toggle(); });

  /** A different car or tuning replaces the physics body (and, via showCar, the model). */
  const rebuildPlayer = () => {
    builtKey = carKey();
    pw.world.removeRigidBody(car.body);
    core = new CoreCar(coreJson());
    car = new CarBody(pw, core, shape, visual.cg);
    rig.setTarget(car.body, core.info.redline);
    drivingLine.setCar(applyMods(physics[sel.car], modsOf(sel)));
  };

  /** The garage car's own model (if its catalog entry has one): swapped in, physics + damage rebuilt. Serialised. */
  let visualQueue: Promise<void> = Promise.resolve();
  let carSwapped = false;
  const showCar = () => (visualQueue = visualQueue.then(async () => {
    const path = visualPathOf(sel.car);
    const needModel = path !== visualPath;
    if (needModel) {
      const cfg = path === DEFAULT_VISUAL ? defaultCfg : await fetchVisualCfg(path);
      const next = await CarVisual.load(cfg, visual.headlights);
      probe?.attach(next.model, probeIntensity);
      const wasInGarage = inGarage;
      setGarage(false, false);
      scene.remove(visual.root);
      damage.dispose();
      visualPath = path; visualCfg = cfg; visual = next; shape = shapeOf(cfg);
      visual.setPlate(sel.name);
      drawEarly(visual.model);
      carSwapped = true;
      visual.renderDt = capInterval ? capInterval / 1000 : 1 / 60;
      syncHeadlights();
      scene.add(visual.root);
      damage = new DamageVisuals(visual, visualCfg, pw, scene);
      wireDamage();
      headShadows = visual.headlights.filter((s) => s.castShadow).map((s) => s.shadow);
      for (const sh of headShadows) sh.autoUpdate = false;
      visual.update(pos, quat, car.out);
      setGarage(wasInGarage);
    }
    visual.setPaint(paintOf(sel, catalog), sel.finish);
    applyLook();
    if (needModel || carKey() !== builtKey) {
      rebuildPlayer();
      spawn();
      settledShowroom = 0;
      syncPose();
      post.carPos.copy(pos);
      if (!inGarage) probe?.captureAll(pos, visual.root);
    }
    Object.assign(g.__game, { visual, damage });   // `car` / `core` are live getters on __game
  }).catch((e) => console.error('car swap failed', e)));

  /**
   * Load a session: race (you + AI rivals on a grid), free roam (just you) or a party session
   * (online: the party's rules, other players' cars). A party session waits for the leader's GO
   * unless we rejoin one already driving.
   */
  let rivalsCompiled = false;
  async function startSession(mode: Mode, rejoin = false) {
    if (loadingSession) return;
    loadingSession = true;
    sel.mode = mode;
    setState('busy');
    menu.show('busy', mode === 'online' ? 'Loading the party session…' : 'Getting ready…');
    if (mode === 'online' && cloud.available) {
      // online: drive only what the online account owns (the race room checks it), from a fresh profile
      await mp.refresh();
      mp.fit(sel);
    }
    await showCar();
    visual.setPaint(paintOf(sel, catalog), sel.finish);
    if (carKey() !== builtKey) rebuildPlayer();
    // grid: single-player race = P4 of 6 between the rivals; party = slot by join order (two columns, 8 m rows)
    if (mode === 'race' && ai.cars.length) {
      grid = { ds: 0, lat: 0 };
      grid = { ds: 0, lat: ai.setGrid(new THREE.Vector3(s0.x, s0.z, -s0.y)) };
      ai.setMode('race');
      if (potato && !rivalsCompiled) {
        // potato skipped the rivals at boot: build their pipelines now, behind "Getting ready…", not as a freeze on the grid
        rivalsCompiled = true;
        ai.update(1, camera);
        const culled: THREE.Object3D[] = [];
        scene.traverse((o) => { if (o.frustumCulled && (o as THREE.Mesh).isMesh) { o.frustumCulled = false; culled.push(o); } });
        await compileFor(scene, post.sceneTarget).catch(() => { /* they compile on first sight instead */ });
        for (const o of culled) o.frustumCulled = true;
      }
    } else {
      ai.setMode('off');
      const slot = party ? Math.max(0, party.members.findIndex((m) => m.id === party!.selfId)) : 0;
      grid = mode === 'online' ? { ds: -8 * (slot >> 1), lat: slot % 2 ? 2.2 : -2.2 } : { ds: 0, lat: 0 };
    }
    if (mode === 'online' && party?.mode === 'race' && !rejoin && cloud.available) {
      // ranked: the online race room times this race and pays the online career (it decides whether it counts)
      ranked?.close();
      if (mp.ready) {
        const a = assistSet;
        ranked = new RankedLink(cloud, party.code, { car: sel.car, mods: { ...modsOf(sel) }, host: party.isHost, manual: a.gearbox === 'manual',
          assistsOff: +(a.abs === 'off') + +(a.tc === 0) + +!a.stability + +(a.countersteer === 'off') + +(a.line === 'off') });
        menu.ranked(null);
        ranked.onResult = (r) => {
          if (r.profile && r.you) mp.paid({ xp: r.you.xp, cr: r.you.cr, reason: r.ranked ? `ranked race · P${r.you.pos}` : 'unranked race', parts: r.you.parts }, r.profile);
          menu.ranked(r);
        };
      }
    }
    if (mode === 'online') {
      remote?.clear();
      remote = new RemoteCars(scene, visual, pw, shape);
      if (party) { remote.names = new Map(party.members.map((m) => [m.id, m.name])); remote.looks = new Map(party.members.map((m) => [m.id, { skin: m.skin, look: m.look }])); }
      remote.warmup(true);           // remote car shaders compiled now, not as a hitch when someone joins
      await warm();
      remote.warmup(false);
    } else await sleep(60);          // brief settle for any fullscreen transition
    hud.lapTotal = raceLaps();
    hud.show();
    if (wantsTouch()) enableTouch();
    audio.unlock();
    loadingSession = false;
    if (mode === 'online' && !rejoin) {
      if (!party) { quitSession('lobby'); return; }
      resetCar();
      menu.show('busy', 'Waiting for the other drivers…');
      party.ready();
      if (partyGo || party.phase === 'driving') { partyGo = false; await beginRace(); }
      return;
    }
    await beginRace();
  }

  /** Respawn and start: 3-2-1 in a race, straight into the car otherwise. */
  async function beginRace() {
    resetCar();
    setGarage(false);
    visual.dim = 1;
    visual.applyHeadlights();
    readBody(physPos, physQuat);
    prevPos.copy(physPos);
    prevQuat.copy(physQuat);
    pos.copy(physPos);
    quat.copy(physQuat);
    visual.update(pos, quat, car.out);
    rig.snap();
    rig.update(1, pos, quat, new THREE.Vector3(), car.out);
    cityLights.update(1, camera);
    city.update(camera, true);
    // (a swapped car's shaders were compiled by the garage frames; anything left compiles behind the loading screen)
    carSwapped = false;
    for (const sh of headShadows) sh.needsUpdate = true;
    post.render();
    loader.hold = loader.shown;      // a session load: the loading screen stays until the race view renders steadily
    menu.show('none');
    hud.resetFps();
    input.poll();                    // drop key edges pressed in the menus
    audio.muted = false;
    remote?.kick();
    prev = performance.now(); acc = 0; lastRenderAt = 0;
    setState('countdown');           // parked on the grid (no input) while the view warms up
    if (loader.hold) {
      loader.text('Almost there…');
      await steadyFrames(6, 70, 8000);   // tiles around the start stream in, shaders compile: behind the screen
      loader.hold = false;
      loader.hide();
      await sleep(250);
      if (state !== 'countdown') return;
    }
    if (raceLaps() === 0) { ai.go(); setState('race'); setExtra(); return; }
    for (const t of ['3', '2', '1']) { menu.countdown(t); await sleep(900); if (state !== 'countdown') { menu.countdown(''); return; } }
    menu.countdown('GO');
    if (launchArmed) launchUntil = ticks * DT + 1.1;   // throttle held on the grid: clamp the launch
    launchArmed = false;
    setState('race');
    if (ranked && party?.isHost) ranked.start(raceLaps(), useNyc ? 'nyc' : 'city', realism());   // the room's clock starts
    raceT0 = ticks * DT;
    ai.go();
    setTimeout(() => menu.countdown(''), 700);
  }

  function resume() {
    setState(pausedFrom);
    menu.show('none');
    input.syncPads();
    audio.muted = false;
    prev = performance.now();
  }

  /** End the session: back to the title, the game modes, or (party) the lobby. */
  function quitSession(to: 'title' | 'modes' | 'lobby') {
    if (freeRoamM > 50 && sel.mode === 'free') sp.earn(freeRoamM / 1000 * FREE_ROAM_XP_PER_KM, `free roam · ${(freeRoamM / 1000).toFixed(1)} km`);
    freeRoamM = 0;
    ranked?.close(); ranked = null;
    if (remote) party?.sendGone();
    remote?.clear(); remote = null;
    hideSpectate();
    rig.setTarget(car.body, core.info.redline);
    hud.hide();
    hud.board(null);
    menu.countdown('');
    audio.muted = true;
    ai.setMode('off');
    grid = { ds: 0, lat: 0 };
    resetCar();
    setState(to);
    menu.show(to);
    visual.setPaint(paintOf(sel, catalog), sel.finish);
    setExtra();
  }

  function finishRace() {
    bumpHeat(1);   // a finished race is a player action: +1 heat (docs/design/heat-and-cops.md)
    setState('results');
    audio.muted = true;
    const total = lapTimes.reduce((a, b) => a + b, 0);
    hideSpectate();
    rig.setTarget(car.body, core.info.redline);
    const st = standings();
    let earned = 0;
    if (!racePaid && sel.mode !== 'online') {
      // single player: XP only (online races are paid by the server's race room)
      racePaid = true;
      const order = rank(st), pos = order.findIndex((x) => x.you) + 1;
      const a = assistSet;
      const reward = raceReward({ pos, laps: raceLaps(), dnf: !!myDnf, gained: ai.cars.length ? Math.max(0, 4 - pos) : 0, clean: raceImpacts === 0,
        assistsOff: +(a.abs === 'off') + +(a.tc === 0) + +!a.stability + +(a.countersteer === 'off') + +(a.line === 'off'),
        manual: a.gearbox === 'manual', realism: sel.realism }, 'sp');
      // High heat pays (design: "let high heat pay"): 4 stars x1.5, 5 stars x1.8 on the single-player purse. This is
      // what makes the dial a gamble rather than a punishment.
      const heatMul = heat.level >= 5 ? 1.8 : heat.level >= 4 ? 1.5 : 1;
      const purse = Math.round(reward.xp * heatMul);
      earned = sp.earn(purse, myDnf ? 'race · DNF' : `race · P${pos} of ${order.length}${heatMul > 1 ? ` · HEAT x${heatMul}` : ''}`, reward.parts).xp;
    }
    menu.showResults({ total, best: lapTimes.length ? Math.min(...lapTimes) : 0, laps: lapTimes, laps_target: raceLaps(), standings: st,
      routeLength: lap?.routeLength ?? route.length_m, online: sel.mode === 'online', earned });
    if (party) party.sendProgress({ d: lap?.distance ?? 0, lap: lap?.laps ?? 0, fin: lap?.finished ? total : -1, best: lap?.best ?? 0, dnf: myDnf ? 1 : 0 });
  }

  addEventListener('keydown', (e) => {
    if (state === 'spectate' && !e.repeat) {
      if (e.code === 'ArrowLeft' || e.code === 'KeyA') specStep(-1);
      else if (e.code === 'ArrowRight' || e.code === 'KeyD') specStep(1);
      else if (e.code === 'Escape') finishRace();
      return;
    }
    if (e.code !== 'Escape' || e.repeat) return;
    if (state === 'race') { pausedFrom = state; setState('paused'); audio.muted = true; menu.show('pause'); }
    else if (state === 'paused') resume();
  });

  // Showroom camera: slow turntable around the parked car, drag to turn, wheel to zoom.
  const orbit = { az: 2.3, el: 0.17, dist: 7, drag: false, x: 0, y: 0, shift: 0, holdUntil: 0 };
  (g.__game as { orbit?: typeof orbit; nyc?: typeof nyc }).orbit = orbit;
  (g.__game as { orbit?: typeof orbit; nyc?: typeof nyc }).nyc = nyc;
  const dom = renderer.domElement;
  dom.addEventListener('pointerdown', (e) => { if (driving()) return; orbit.drag = true; orbit.x = e.clientX; orbit.y = e.clientY; dom.setPointerCapture(e.pointerId); });
  dom.addEventListener('pointermove', (e) => {
    if (!orbit.drag) return;
    orbit.az -= (e.clientX - orbit.x) * 0.008;
    orbit.el = Math.min(0.7, Math.max(0.03, orbit.el + (e.clientY - orbit.y) * 0.004));
    orbit.x = e.clientX; orbit.y = e.clientY;
  });
  const endDrag = () => { orbit.drag = false; };
  dom.addEventListener('pointerup', endDrag);
  dom.addEventListener('pointercancel', endDrag);
  dom.addEventListener('wheel', (e) => { if (!driving()) orbit.dist = Math.min(inGarage ? 7.6 : 11, Math.max(inGarage ? 3.6 : 4.5, orbit.dist + e.deltaY * 0.004)); }, { passive: true });
  const tmpT = new THREE.Vector3(), tmpP = new THREE.Vector3(), tmpR = new THREE.Vector3(), tmpD = new THREE.Vector3();
  /**
   * Showroom camera. In the garage it orbits the turntable (car at the origin, nose down +z) and stays inside the
   * room; behind the tuner's cover it orbits the car where it stands on the street (that view is what gets measured).
   */
  const placeShowroom = (dt: number, carPos: THREE.Vector3) => {
    if (!orbit.drag && performance.now() > orbit.holdUntil) orbit.az += dt * (state === 'title' ? 0.16 : 0.08);
    // on the title the car sits right of centre (the menu is on the left); in the garage it is centred
    orbit.shift += ((state === 'title' ? 1.55 : state === 'garage' ? -0.35 : 0) - orbit.shift) * (1 - Math.exp(-dt * 4));
    if (inGarage) tmpT.set(0, 0.58, 0); else tmpT.copy(carPos).add(tmpD.set(0, 0.25, 0));
    const dist = inGarage ? Math.min(7.6, Math.max(3.2, orbit.dist)) : orbit.dist;
    const ce = Math.cos(orbit.el);
    tmpP.set(Math.sin(orbit.az) * ce, Math.sin(orbit.el), Math.cos(orbit.az) * ce).multiplyScalar(dist).add(tmpT);
    if (inGarage) garage!.clampCamera(tmpT, tmpP);
    else {
      const hit = pw.raycast(tmpT, tmpP, car.body);   // pull in front of walls (not the car itself)
      if (hit && hit.toi < orbit.dist) tmpP.sub(tmpT).setLength(Math.max(2.5, hit.toi - 0.4)).add(tmpT);
    }
    camera.position.copy(tmpP);
    tmpR.subVectors(tmpT, tmpP).cross(tmpD.set(0, 1, 0)).setY(0).normalize();   // camera right
    camera.lookAt(tmpD.copy(tmpT).addScaledVector(tmpR, -orbit.shift));
    const fov = inGarage ? 38 : 42;
    if (camera.fov !== fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
    if (showPost) showPost.focus.value = tmpP.distanceTo(tmpT);
  };

  if (import.meta.env.DEV) {
    const report = (msg: string) => fetch('/__telemetry', { method: 'POST', body: msg }).catch(() => {});
    report(`started ${backend} | ${navigator.userAgent.match(/Chrome\/[\d.]+|Firefox\/[\d.]+/)?.[0] ?? ''}`);
    setInterval(() => report(`${document.getElementById('perf')!.textContent!.replace('\n', ' | ')} | ${Math.round(Math.abs(car.out[OUT.speed]) * 3.6)} km/h`), 2000);
  }

  const carAcc = new THREE.Vector3(), lastVel = new THREE.Vector3(), stepAcc = new THREE.Vector3();
  /**
   * Car-to-car contact with another player: their body is kinematic (infinitely heavy) here, so the step gave our car
   * the whole velocity change of hitting a wall. Two equal cars share it: keep half. (Their game does the same with us.)
   */
  const preV = new THREE.Vector3(), preW = new THREE.Vector3();
  /**
   * We sheared a pole (obstacles.afterStep already took the speed off): it falls, our front takes the impulse (the
   * collider is gone, so feedCrash can't find the contact point), the others in the party see it fall too.
   */
  let contactId = 900000;
  const poleHit = (h: PoleHit, mine: boolean) => {
    streetProps!.knockDown(h.pole, h.vx, h.vz);
    if (!mine) { obstacles?.release(h.pole); return; }
    core.contact(h.point, h.impulse, ++contactId);
    audio.impact(Math.max(15, h.impulse / 400), false, 'pole');
    party?.sendPole(h.pole.x, h.pole.y, h.vx, h.vz);
  };
  /** We broke through a building wall: the front takes the energy the car lost; the party sees the hole. */
  const wallHit = (w: WallHit) => {
    core.contact(w.point, w.impulse, ++contactId);
    audio.impact(Math.max(60, (w.impulse * w.impulse) / (2 * core.info.mass) / 1000), w.storefront, 'wall');
    party?.sendBreach(w.spec);
  };
  // A falling pole landing on our car: dent where it lands.
  if (streetProps) {
    // the core's damage reads an impulse on our car: the one that carries this energy (E = J^2 / 2m)
    streetProps.onLand = (x, y, z, energy) => { core.contact({ x, y, z }, Math.sqrt(2 * core.info.mass * energy), ++contactId); audio.impact(Math.max(10, energy / 1000), true, 'pole'); };
  }
  const carBox = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), half: [0, 0, 0] as [number, number, number], centre: [0, 0, 0] as [number, number, number] };
  const halveRemoteHits = (tTick: number) => {
    let touching = false;
    for (const c of remote!.colliders) {
      let hit = false;
      pw.world.contactPair(car.collider, c, (m) => { if (m.numContacts() > 0) hit = true; });
      if (hit) { touching = true; remote!.touched(c, tTick); }
    }
    if (!touching) return;
    const lv = car.body.linvel(), av = car.body.angvel();
    car.body.setLinvel({ x: (preV.x + lv.x) / 2, y: (preV.y + lv.y) / 2, z: (preV.z + lv.z) / 2 }, true);
    car.body.setAngvel({ x: (preW.x + av.x) / 2, y: (preW.y + av.y) / 2, z: (preW.z + av.z) / 2 }, true);
  };
  syncPose();
  post.carPos.copy(pos);

  // Boot into the title (or, for the test tools with ?menu=0, straight into a free run).
  gameReady = true;
  { const l = document.getElementById('loading'); if (l) { l.classList.add('out'); setTimeout(() => l.remove(), 450); } }   // fade, not a cut
  if (params.get('menu') === '0') {
    sel.mode = 'free';
    hud.show();
    if (wantsTouch()) enableTouch();
    resetCar();
    setState('race');
    audio.muted = false;
  } else {
    setState('title');
    menu.show('title');
    if (adaptive) startTuning(false);
    else menu.setTuning(false, potato ? POTATO_NOTE : params.has('scale') || PRESET_ORDER.includes(params.get('quality') as PresetName) ? 'Graphics pinned by the URL' : `Graphics fixed: ${gfx}`);
    visual.setPaint(paintOf(sel, catalog), sel.finish);
  }
  setExtra();

  let lastRenderAt = 0, statsAt = 0, statsLogAt = 0;
  /** CPU time per frame section (ms, accumulated): window.__prof. Sections sum to `total`, the whole callback. */
  const prof = { n: 0, total: 0, sim: 0, vis: 0, city: 0, post: 0, hud: 0, audio: 0 };
  (globalThis as { __prof?: unknown }).__prof = prof;
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const p0 = now;
    const cb0 = bench.active ? now : 0;
    const frame = Math.min(0.1, (now - prev) / 1000);
    prev = now;
    const inShowroom = isShowroom(state);
    const live = state !== 'paused' && (!inShowroom || settledShowroom < 24 || bench.active);
    if (bench.active) benchStep(frame);
    if (live) acc += frame; else acc = 0;
    // The street under the car is not built yet (a slow phone or network was outrun by the car, or a reset landed on an
    // unloaded tile): hold the simulation until its colliders exist, instead of letting the car fall through the map.
    if (nyc && live && driving() && state !== 'spectate' && !bench.active) {
      const cp = car.body.translation();
      const held = !nyc.groundReady(cp.x, cp.z);
      if (held) acc = 0;
      const warn = held ? 'LOADING THE STREET…' : '';
      if (hud.holdWarn !== warn) hud.holdWarn = warn;
    } else if (hud.holdWarn) hud.holdWarn = '';
    let steps = 0;
    const tSim = performance.now();
    while (acc >= DT && steps < 24) {
      prevPos.copy(physPos);
      prevQuat.copy(physQuat);
      const script = (g.__game as { script?: ((tick: number) => RawInput) | null }).script;   // dev / replay: inputs by tick
      let tin = script ? script(ticks) : state === 'race' ? input.poll() : IDLE;
      if (state === 'countdown' && input.raw.throttle > 0.5) launchArmed = true;
      if (state === 'race' && launchUntil > 0 && ticks * DT < launchUntil) {
        const ph = Math.min(1, Math.max(0, (ticks * DT - (launchUntil - 1.1)) / 1.1));
        tin = { ...tin, throttle: Math.min(tin.throttle, 0.55 + 0.45 * ph) };   // ramp instead of instant full power
      }
      car.tick(tin, input.assists);
      if (tireSmoke) {
        if (state === 'race' && ticks % 3 === 0) {
          const slip = Math.max(Math.abs(car.out[OUT.wheel(2) + 7]), Math.abs(car.out[OUT.wheel(3) + 7]));
          const kmh = Math.abs(car.out[OUT.speed]) * 3.6;
          if (slip > 0.32 && kmh > 3) {
            smokeF.set(0, 0, 1).applyQuaternion(quat);
            smokeR.set(1, 0, 0).applyQuaternion(quat);
            for (const side of [-1, 1]) {
              smokeP.copy(pos).addScaledVector(smokeF, -1.35).addScaledVector(smokeR, side * 0.8).setY(0.12);
              smokeV.set((Math.random() - 0.5) * 1.1, 0.7 + Math.random() * 0.7, (Math.random() - 0.5) * 1.1);
              tireSmoke.emit(smokeP, smokeV, 0.9 + Math.random() * 0.7, 0.3 + Math.min(1, slip) * 0.45);
            }
          }
        }
        tireSmoke.update(frame);
      }
      if (launchEl) launchEl.textContent = state === 'countdown' && launchArmed ? 'LAUNCH READY' : state === 'race' && launchUntil > 0 && ticks * DT < launchUntil ? 'LAUNCH' : '';
      if (inShowroom) { car.body.setLinvel({ x: 0, y: Math.min(0, car.body.linvel().y), z: 0 }, true); car.body.setAngvel({ x: 0, y: 0, z: 0 }, true); settledShowroom++; }   // parked for the showroom
      ai.tick(DT, car.body.translation());
      remote?.tick(now - (acc - DT) * 1000, DT);   // other players' bodies at this tick's time
      if (remote?.colliders.size || obstacles || nyc || ai.mode === 'race') { const lv = car.body.linvel(), av = car.body.angvel(); preV.set(lv.x, lv.y, lv.z); preW.set(av.x, av.y, av.z); }
      const t0 = performance.now();
      pw.world.step();
      if (obstacles) { const h = obstacles.afterStep(car.collider, car.body, core.info.mass, preV, preW); if (h) poleHit(h, true); }
      if (nyc && driving()) { const w = nyc.breaches.check(car.collider, car.body, core.info.mass, preV, preW); if (w) wallHit(w); }
      if (remote?.colliders.size) halveRemoteHits(now - (acc - DT) * 1000);
      if (ai.mode === 'race') ai.afterStep(car.collider, car.body, preV, preW);   // rivals take their half of a hit (ai.ts)
      stepMs += (performance.now() - t0 - stepMs) * 0.01;   // Rapier cost per 240 Hz step, smoothed
      readBody(physPos, physQuat);
      // car acceleration for the camera spring, from the physics (low-passed ~25 ms)
      const v = car.body.linvel();
      const a = stepAcc.set(v.x - lastVel.x, v.y - lastVel.y, v.z - lastVel.z).divideScalar(DT);
      lastVel.set(v.x, v.y, v.z);
      carAcc.lerp(a.clampLength(0, 60), 1 - Math.exp(-DT / 0.025));
      ticks++;   // simulation clock (race timing)
      if (trace.length < 300 && ticks % 4 === 0) {
        const r = car.body.rotation(), t = car.body.translation(), o = car.out;
        trace.push([ticks, +(Math.atan2(2 * (r.w * r.y + r.x * r.z), 1 - 2 * (r.y * r.y + r.x * r.x)) * 57.2958).toFixed(2), +t.y.toFixed(3),
          [0, 1, 2, 3].map((i) => Math.round(o[OUT.wheel(i) + 6])).join('/'), +frame.toFixed(3)]);
      }
      acc -= DT;
      steps++;
    }
    prof.sim += performance.now() - tSim;
    if (steps === 24) acc = 0;   // too slow to keep up: drop time rather than spiral
    const alpha = Math.min(1, acc / DT);
    pos.lerpVectors(prevPos, physPos, alpha);
    quat.slerpQuaternions(prevQuat, physQuat, alpha);
    post.carPos.copy(pos);
    // pursuit: track the player's arc length, call the cops once when a race at 3+ heat is underway, then update
    playerS = cops.nearest(pos, playerS);
    if (state === 'race' && sel.mode === 'race' && !copSpawned && heat.level >= 3 && ticks > 480) { copSpawned = true; cops.spawn(playerS, pos); }
    cops.update(frame, playerS, pos, Math.abs(car.out[OUT.speed]) * 3.6);
    if (cops.active) {
      // line of sight: a ray from the cop to the car; any building hit means the cop cannot see you
      const from = cops.world, to = pos;
      const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
      const len = Math.hypot(dx, dy, dz) || 1;
      const ray = new RAPIERLib.Ray({ x: from.x, y: from.y + 1.2, z: from.z }, { x: dx / len, y: dy / len, z: dz / len });
      const hit = pw.world.castRay(ray, len - 2, true);
      cops.see(!!hit, frame);
      const on = Math.floor(performance.now() / 260) % 2 === 0;
      if (copsLights) { copsLights.r.color.setHex(on ? 0xff2d55 : 0x2a0008); copsLights.b.color.setHex(on ? 0x001030 : 0x2a9dff); }
      audio.siren(cops.proximity);
      copsEl.textContent = `🚨 POLICE · ${Math.round(cops.distance)} m`;
    } else {
      audio.siren(0);
      if (copsLights) { copsLights.r.color.setHex(0x2a0008); copsLights.b.color.setHex(0x001030); }
      copsEl.textContent = performance.now() < copMsgUntil ? copMsg : '';
    }
    const tVis = performance.now();
    {
      const lv = car.body.linvel();
      visual.velocity.set(lv.x, lv.y, lv.z);
      visual.update(pos, quat, car.out, prevPos, prevQuat);   // car.out was computed from the pose BEFORE the last step
      if (!inShowroom || settledShowroom <= 24) {
        ai.update(alpha, camera);
        damage.update(live ? frame : 0, () => core.damage());
      }
    }
    prof.vis += performance.now() - tVis;
    const tAud = performance.now();
    if (driving()) audio.update(car.out, car.out[OUT.speed]);
    // force feedback runs every frame (it ramps to zero in the menus); only while the wheel is the driving device
    ffb.update(frame, { driving: state === 'race' && input.device === 'wheel', rackTorque: car.out[OUT.steerTorque], speed: Math.abs(car.out[OUT.speed]),
      wheel: input.wheelPos, wheelVel: input.wheelVel, impactKj: state === 'race' ? rumbleKj : 0 }, input.settings);
    prof.audio += performance.now() - tAud;
    if (state === 'race') { input.rumble(now, car.out, rumbleKj); rumbleKj = 0; }
    if (state === 'paused' && !menu.ctl?.calibrating) input.menuPoll();
    if (ranked && (state === 'race' || state === 'spectate' || state === 'results') && !myDnf) ranked.pos(now, car.body.translation(), Math.abs(car.out[OUT.speed]));
    if (state === 'race' && raceLaps() === 0) freeRoamM += Math.min(Math.abs(car.out[OUT.speed]), 90) * frame;
    drivingLine.update(assistSet.line, state === 'race' || state === 'countdown', pos, car.out[OUT.speed]);
    if (driving() && state !== 'paused' && state !== 'busy') {
      const watching = state === 'spectate';   // spectating: the map follows the watched car (no GPS directions)
      mmFwd.set(0, 0, 1).applyQuaternion(watching ? specQuat : quat);
      const blips: Blip[] = [];
      if (ai.mode === 'race') for (const c of ai.cars) blips.push({ x: c.pos.x, z: c.pos.z, color: '#ff4d6d' });
      if (remote) for (const id of remote.ids()) { const r = remote.get(id); if (r) blips.push({ x: r.root.position.x, z: r.root.position.z, color: '#4dd2ff' }); }
      const L = lap?.routeLength ?? route.length_m;
      if (watching) minimap.update(now, specPos, mmFwd, specOut[OUT.speed], null, blips);
      else minimap.update(now, pos, mmFwd, Math.abs(car.out[OUT.speed]), lap ? ((lap.distance % L) + L) % L : null, blips);
    }
    menuNav.paused = !!menu.ctl?.calibrating;
    menuNav.update(now);
    if (menu.screen === 'controls') menu.ctl?.tick();
    if (remote) {
      remote.update(now, camera);
      if (party && driving()) { const out = remote.outgoing(now, pos, quat, car.body.linvel()); if (out) party.sendPose(out, paintInt()); }
    }
    // The garage is on screen for every showroom state, except behind the tuner's cover and during the benchmark
    // (both measure the street).
    setGarage(inShowroom && !tuning && !bench.active);
    if (inGarage) {
      visual.custom.sync(garage!.holder.position, IDENT_Q);   // livery mask: the model sits on the turntable, not at the body
      if (garage!.dirtyEnv) { garage!.captureEnv(); probe?.fromCube(garage!.cube.texture); }
    }
    if (!driving() || state === 'busy') { placeShowroom(frame, pos); }
    else {
      if (state === 'spectate') specCamera(frame);
      else if (live) rig.update(frame, pos, quat, carAcc, car.out);
    }
    cityLights.update(frame, camera);   // WebGL 2 pool only (5 Hz); a no-op with clustered lighting
    if (obstacles) obstacles.sync(frame, pos);
    if (streetProps) {
      carBox.pos.copy(physPos); carBox.quat.copy(physQuat);
      carBox.half = [shape.boxSize[0] / 2, shape.boxSize[1] / 2, shape.boxSize[2] / 2];
      carBox.centre = [shape.boxCentre[0] - visual.cg.x, shape.boxCentre[1] - visual.cg.y, shape.boxCentre[2] - visual.cg.z];
      streetProps.carBox = driving() ? carBox : null;
    }
    nyc?.update(state === 'spectate' ? specPos : pos, frame, driving() && state !== 'spectate' ? visual.velocity : undefined, (impulse, kind) => {   // spectating: detail around the watched car
      const lv = car.body.linvel();
      const s = Math.hypot(lv.x, lv.z);
      if (s > 1) {
        const drag = Math.min(0.28, (impulse / 1800) / Math.max(4, s));
        car.body.setLinvel({ x: lv.x * (1 - drag), y: lv.y, z: lv.z * (1 - drag) }, true);
      }
      audio.impact(Math.max(12, impulse * 0.18), kind === 'shop' || kind === 'wall', kind);
      // Wrecking the car is a player action too: +1 heat, but only for real hits and at most one per 20 s.
      if (impulse > 5000 && Date.now() - heat.lastGain > 20_000) bumpHeat(1);
    });
    const tCity = performance.now();
    city.update(camera);
    prof.city += performance.now() - tCity;
    // Frame cap (default 30 fps: the quality target; ?cap=0 uncapped, ?cap=45 etc.). Simulation, camera and HUD run every
    // display refresh; only the draw is skipped, so the picture holds still between rendered frames. The cap is off while
    // the graphics tuner measures (it needs the uncapped speed), and the slot clock advances by whole intervals so a
    // 60/120/144 Hz display averages exactly the cap instead of rounding down.
    if (capInterval === 0 || tuning || bench.uncap || now - lastRenderAt >= capInterval - 2) {
      lastRenderAt = capInterval && !bench.uncap && now - lastRenderAt < capInterval * 1.5 ? lastRenderAt + capInterval : now;
      const hasCasters = ai.mode === 'race' || remote !== null || damage.debrisCount > 0;
      if (hasCasters && ++frameNo % (params.has('se') ? num('se', 2) : PRESETS[post.preset].shadowEvery) === 0) for (const sh of headShadows) sh.needsUpdate = true;
      const tPost = performance.now();
      if (inGarage) showPost!.render(); else post.render();
      prof.post += performance.now() - tPost;
      // never while the garage is up: the probe's cube render rebuilds ShadowNodes and destroys the sun's shadow map
      if (screenNone() && post.preset !== 'low' && post.preset !== 'medium') probe?.update(pos, visual.root);
      hud.rendered(now);
      if (now - statsAt > 1000) {   // draw calls are per frame; the texture scan is cached for 10 s
        statsAt = now;
        const s = frameStats(scene, renderer);
        hud.stats = s;
        if (import.meta.env.DEV && now - statsLogAt > 10_000) {
          statsLogAt = now;
          console.log(`[stats] ${s.calls} calls · ${s.textures} textures · ${s.textureMB} MB · ${s.noMips} without mips · ${s.triangles} tris`);
        }
      }
      if (adaptive && state === 'race' && !bench.active && car.out[OUT.speed] > 5 && frame < 0.095) {
        driveWinTime += frame;
        if (++driveFrames >= 60) {
          const dfps = driveFrames / driveWinTime;
          driveWinTime = 0; driveFrames = 0;
          const medIdx = PRESET_ORDER.indexOf('medium');
          if (dfps < (isTouch ? 42 : 27.5) && !presetPinned && presetIdx < medIdx) {
            setPreset(presetIdx + 1, false); setExtra();
          } else if (dfps < 25 && !presetPinned && presetIdx < PRESET_ORDER.length - 1) {
            setPreset(presetIdx + 1, false); setExtra();
          }
          // a phone that cannot hold 22 fps on `low` for three windows in a row starts in potato next time (no reload mid-drive)
          lowDrive = isTouch && !potato && !presetPinned && presetIdx === PRESET_ORDER.length - 1 && dfps < 22 ? lowDrive + 1 : 0;
          if (lowDrive >= 3) { try { localStorage.setItem(POTATO_KEY, '1'); } catch { /* storage blocked */ } }
        }
      } else if (state !== 'race') { driveWinTime = 0; driveFrames = 0; }
      if (bench.active) {
        bench.stamps.push(now);
        if (bench.ts && !bench.pending) {
          bench.pending = true;
          const r = renderer as unknown as { resolveTimestampsAsync(t: string): Promise<number | undefined> };
          Promise.all([r.resolveTimestampsAsync('render'), r.resolveTimestampsAsync('compute')]).then(([a, c]) => { if (a) bench.gpu.push(a + (c || 0)); bench.pending = false; });
        }
      }
    }
    if (state === 'race' || (raceLaps() > 0 && (state === 'spectate' || state === 'results'))) {
      const tRace = ticks * DT - raceT0;
      // our progress only while we race (a wreck being pushed around must not gain places)
      if (state === 'race' && !myDnf) {
        lap = race.update(raceCar, car.body.translation(), tRace);
        if (lap.laps > lapTimes.length) lapTimes.push(lap.last);
      }
      for (const [i, r] of aiRace.entries()) {
        r.lap = race.update(r.idx, ai.cars[i].pos, tRace);
        if (r.lap.finished && r.fin < 0) r.fin = tRace;
      }
      if (raceLaps() > 0 && lap) {
        if (state === 'race') {
          if (lap.finished && raceFinishedAt < 0) raceFinishedAt = now;
          if (raceFinishedAt > 0 && now - raceFinishedAt > 1500) finishRace();
          checkOut(frame);
        }
        updateBoard(now);
        if (party && now - progAt > 250) { progAt = now; party.sendProgress({ d: lap.distance, lap: lap.laps, fin: lap.finished ? lapTimes.reduce((a, b) => a + b, 0) : -1, best: lap.best, dnf: myDnf ? 1 : 0 }); }
        // everyone else done: the race is over (spectating -> results); results on screen follow the field
        if (state === 'spectate' && now - specAt > 2000 && !rank(standings()).some((x) => !x.you && x.fin < 0 && !x.dnf)) finishRace();
        if (state === 'results' && now - resAt > 1000) {
          resAt = now;
          const key = JSON.stringify(standings().map((x) => [x.fin, x.dnf, Math.round(x.d / 50)]));
          if (key !== resKey) { resKey = key; menu.updateResults(standings()); }
        }
      }
    }
    if (driving() && state !== 'paused' && state !== 'spectate') {
      const tHud = performance.now();
      hud.update(now, frame, car.out, core.info, input.assists, damage.last, lap);
      prof.hud += performance.now() - tHud;
    }
    // Graphics tuning (title menu only, behind the cover; see startTuning)
    if (now >= winStart) frameTimes.push(frame * 1000);
    if (tuning && now - winStart >= WINDOW) {
      const fps = (frameTimes.length * 1000) / (now - winStart);
      const sorted = frameTimes.slice().sort((x, y) => x - y);
      const p50 = sorted[Math.floor(sorted.length / 2)] ?? 0;
      const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
      frameTimes.length = 0;
      winStart = now;
      quietWindows = citySettled() ? quietWindows + 1 : 0;
      const warm = quietWindows < 2;   // one dry window to settle, one to measure from
      // Judge on the median of the last three windows, not one window: the title camera swings p50 by 10 ms between
      // identical windows (26-39 ms at scale 0.7), and a single bad window used to cost a whole scale step.
      if (!warm) { p50s.push(p50); if (p50s.length > 3) p50s.shift(); }
      const p50med = medianP50();
      // Both the median frame and the window's mean must hold the target: a window whose p50 is fine but whose mean
      // is 29 fps still stutters (p90 spikes from streaming and uploads), and "30 fps locked" is about the mean.
      const low = !warm && (p50med > FRAME_BUDGET || fps < TUNE_TARGET * 1.02), high = !warm && p50med < FRAME_BUDGET * 0.65;
      const log = ((globalThis as { __tuneLog?: unknown[] }).__tuneLog ??= []);
      log.push({ fps: +fps.toFixed(1), p50: Math.round(p50), p50med: Math.round(p50med), p90: Math.round(p90), preset: post.preset, scale, warm });
      if (log.length > 40) log.shift();
      // a single bad window (a shader compile, a texture upload) must not cost a quality tier: two in a row do it
      lowStreak = low ? lowStreak + 1 : 0;
      // phones: pixels above the old 1x picture (scale 0.5 of the 2x canvas) go before any effect does
      // Resolution before effects on every device: a slightly softer picture that keeps SSR, bloom and GTAO reads
      // better than a sharp low preset, and it is where the frame is actually lost (the pinned profile in
      // docs/performance.md is fill-bound: 25.6 -> 31.0 fps from scale 1.0 to 0.8).
      if (warm) { tuneStart = now; }   // the timeout clock runs on measurable windows only
      else if (low && lowStreak >= 2 && isTouch && scale > RES_FLOOR + 1e-6) { applyScale(scale - STEP); wentDown = true; lowStreak = 0; p50s.length = 0; }
      else if (low && lowStreak >= 2 && needsPotato(fps) && goPotato()) return;
      else if (low && lowStreak >= 2 && !presetPinned && presetIdx < PRESET_ORDER.length - 1) { setPreset(presetIdx + 1); wentDown = true; lowStreak = 0; p50s.length = 0; }
      else if (low && lowStreak >= 2 && scale > MIN_SCALE + 1e-6) { applyScale(scale - STEP); wentDown = true; lowStreak = 0; }
      else if (high && isTouch && upSteps > 0 && scale < maxScale - 1e-6) { applyScale(scale + STEP); upSteps--; }
      // done when two windows in a row sit in the band (the frame holds the cap) or when time is up
      okStreak = !warm && !low && !high ? okStreak + 1 : 0;
      if (low && now - tuneStart > TUNE_TIMEOUT && !warm && needsPotato(fps) && goPotato()) return;
      if (okStreak >= 2 || (now - tuneStart > TUNE_TIMEOUT && !warm)) finishTuning();
      else { winStart = now + 1000; setExtra(); }   // let the resize hitch pass before measuring again
    }
    if (heat.tick(Date.now())) renderHeat();   // quiet minutes cool one level; the dial is the state
    prof.total += performance.now() - p0;
    prof.n++;
    if (bench.active) bench.cb.push(performance.now() - cb0);
  });
}

main().catch((e) => {
  console.error(e);
  say('Error: ' + (e instanceof Error ? e.message : String(e)));
});
