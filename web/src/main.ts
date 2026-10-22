// Night Run (web build): three.js WebGPU renderer + Rapier rigid bodies + the rs_core physics
// compiled to WebAssembly. WebGPU required. URL options: ?scale=0.75 (pins the render resolution; default adaptive),
// ?quality=high|medium|low (pins the post/render preset; default adaptive), ?webgl=1 (debug only),
// ?bloom=0, ?aa=0, ?shadows=0, ?lights=12 (WebGL 2 light pool size), ?mp=1 or ?mp=ws://host:port (preselects the Online mode, see net.ts),
// ?ai=0..3 (AI cars), ?blackcar=1 (AI cars matte black, lights off: night lighting test),
// ?menu=0 (skip the title and garage: straight into a free run, for the test tools).
// Flow: loading -> title (graphics tuned once behind a cover) -> garage (car, paint, tuning, mode) -> race / free run / online.
import * as THREE from 'three/webgpu';
import { Post, PRESETS, PRESET_ORDER, ScaledClusteredLighting, type PresetName } from './post';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CoreCar, CoreRace, OUT, loadCore, type LapInfo, type RawInput } from './physics/core';
import { CarBody, DT, PhysicsWorld, loadRapier, type CarShape } from './physics/world';
import { CityLighting, loadCity } from './scene/city';
import { CarVisual, type CarVisualConfig } from './scene/car';
import { initLoaders } from './scene/loaders';
import { CameraRig } from './camera';
import { Input } from './input';
import { Hud } from './hud';
import { DamageVisuals } from './scene/damage';
import { GameAudio } from './audio';
import { TouchControls, wantsTouch } from './touch';
import { Net } from './net';
import { Menu, type Gfx } from './menu';
import { applyMods, loadSelection, modsOf, paintOf, type CatalogCar } from './garage';
import { AiTraffic } from './ai';

const params = new URLSearchParams(location.search);
const num = (k: string, d: number) => (params.has(k) ? Number(params.get(k)) : d);
const loading = document.getElementById('loading')!;
const say = (s: string) => (loading.textContent = s);

async function main() {
  // --- renderer -------------------------------------------------------------------------------
  // WebGPU is required (clustered lighting, compute). WebGL 2 only on explicit request, for debugging.
  const forceWebGL = params.get('webgl') === '1';
  if (!forceWebGL) {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null);
    if (!adapter) {
      loading.innerHTML = `<div style="max-width:560px;text-align:left;letter-spacing:0;text-transform:none;line-height:1.6">
        <b style="color:#f4f1ea">WebGPU is not available in this browser.</b><br>
        Chrome on Linux: open <code>chrome://flags</code>, enable <b>Unsafe WebGPU Support</b> and <b>Vulkan</b>, then relaunch.<br>
        Check with <code>chrome://gpu</code> → "WebGPU: Hardware accelerated".</div>`;
      if (import.meta.env.DEV) fetch('/__telemetry', { method: 'POST', body: 'NO WEBGPU ADAPTER - stopped' }).catch(() => {});
      return;
    }
  }
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, forceWebGL });
  // The canvas always runs at baseRatio; `scale` is the RENDER scale of the scene and the passes
  // before the sharpening upscale (post.ts). It used to be the canvas pixel ratio, which the browser
  // then stretched bilinearly (soft) and whose change reconfigured the whole canvas.
  const baseRatio = Math.min(devicePixelRatio, 1);
  // Graphics: 'auto' tunes resolution + preset ONCE behind a cover in the title menu (never while a
  // car is on screen); high/medium/low are fixed. ?scale / ?quality (test tools) pin on top of that.
  const GFX_KEY = 'nr.gfx';
  const GFX_SCALE = { high: 1, medium: 0.85, low: 0.7 } as const;
  let gfx: Gfx = 'auto';
  try { const g = localStorage.getItem(GFX_KEY); if (g === 'high' || g === 'medium' || g === 'low') gfx = g; } catch { /* storage blocked */ }
  let adaptive = gfx === 'auto' && !params.has('scale');
  const maxScale = 1;
  // Start near ~0.9 megapixels rendered (1.07 MP measured too heavy on the laptop iGPU at 60 Hz).
  // The scale settled on last time on this device (a calibration costs a resize hitch per step).
  let SCALE_KEY = `nr.scale.${innerWidth}x${innerHeight}`;
  let stored = NaN;
  try { stored = Number(localStorage.getItem(SCALE_KEY) ?? NaN); } catch { /* storage blocked */ }
  let scale = params.has('scale') ? num('scale', 1) : gfx !== 'auto' ? GFX_SCALE[gfx] : stored >= 0.5 && stored <= maxScale ? stored
    : Math.min(maxScale, Math.max(0.5, Math.round(Math.sqrt(0.9e6 / (innerWidth * innerHeight * Math.min(devicePixelRatio, 1) ** 2)) * 10) / 10));
  renderer.setPixelRatio(baseRatio);
  renderer.setSize(innerWidth, innerHeight);
  // Quality preset (post.ts PRESETS), lowered by the adaptive system BEFORE the scale; stored like it.
  let PRESET_KEY = `nr.preset.${innerWidth}x${innerHeight}`;
  let presetPinned = PRESET_ORDER.includes(params.get('quality') as PresetName) || gfx !== 'auto';
  let storedPreset: string | null = null;
  try { storedPreset = localStorage.getItem(PRESET_KEY); } catch { /* storage blocked */ }
  let presetIdx = Math.max(0, PRESET_ORDER.indexOf((PRESET_ORDER.includes(params.get('quality') as PresetName) ? params.get('quality') : gfx !== 'auto' ? gfx : storedPreset ?? 'high') as PresetName));
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = params.get('shadows') !== '0';
  renderer.shadowMap.type = THREE.PCFShadowMap;
  await renderer.init();
  initLoaders(renderer);   // shared glTF decoders (meshopt, KTX2), scene/loaders.ts
  const webgpu = !!(renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend;
  const backend = webgpu ? 'WebGPU' : 'WebGL 2';
  if (webgpu) renderer.lighting = new ScaledClusteredLighting(512);   // needs compute shaders; grid follows the render scale

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
  moon.position.set(-60, 120, 40);
  scene.add(moon);

  const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 900);
  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    syncToSize();
  });
  addEventListener('keydown', (e) => {
    if (e.code !== 'KeyF' || e.repeat || e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement).tagName === 'INPUT') return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {});
  });

  // --- physics + content ----------------------------------------------------------------------
  say('Loading physics…');
  await Promise.all([loadCore(), loadRapier()]);
  const DEFAULT_VISUAL = 'cars/vela_gt.visual.json';
  const fetchVisualCfg = (path: string) => fetch(`/data/${path}`).then((r) => r.json() as Promise<CarVisualConfig>);
  const [catalog, defaultCfg, route] = await Promise.all([
    fetch('/data/cars/catalog.json').then((r) => r.json() as Promise<{ cars: CatalogCar[] }>).then((j) => j.cars),
    fetchVisualCfg(DEFAULT_VISUAL),   // the shared body: traffic, remote players, and every catalog car without its own
    fetch('/data/tracks/city_route.json').then((r) => r.json()),
  ]);
  const physics: Record<string, unknown> = {};
  await Promise.all(catalog.map((c) => fetch(`/data/${c.physics}`).then((r) => r.json()).then((j) => { physics[c.id] = j; })));
  const sel = loadSelection(catalog, params);
  const coreJson = () => JSON.stringify(applyMods(physics[sel.car], modsOf(sel)));
  const carKey = () => `${sel.car}|${JSON.stringify(modsOf(sel))}`;
  let builtKey = carKey();
  let core = new CoreCar(coreJson());
  const pw = new PhysicsWorld();
  const city = await loadCity(scene, pw, core.info.surfaces, (f) => say(`Loading city… ${Math.round(f * 100)}%`));
  const cityLights = new CityLighting(scene, city.lights, webgpu, num('lights', 12));
  // Reflections: capture the lit city once from street level (the car isn't in the scene yet).
  {
    const s0 = route.samples[0];
    camera.position.set(s0.x, s0.z + 2, -s0.y);
    cityLights.update(1, camera);
    scene.environment = pmrem.fromScene(scene, 0.02, 0.5, 400, { size: 256, position: camera.position.clone() }).texture;
    // The capture is for REFLECTIONS (lamps and neon in paint and wet asphalt). At full strength its
    // diffuse part lit every wall like an overcast sky and undid the darkness.
    scene.environmentIntensity = 0.5;
  }
  say('Loading car…');
  // The player's body: each catalog car may bring its own model + visual config (garage swaps it).
  const visualPathOf = (id: string) => catalog.find((c) => c.id === id)?.visual ?? DEFAULT_VISUAL;
  const shapeOf = (cfg: CarVisualConfig): CarShape => {
    const cb = cfg.collision_box;
    return { boxSize: cb.size_m, boxCentre: cb.centre_in_model_m, endLift: cb.end_lift_m, endLiftStart: cb.end_lift_start_m };
  };
  let visualPath = visualPathOf(sel.car);
  let visualCfg = visualPath === DEFAULT_VISUAL ? defaultCfg : await fetchVisualCfg(visualPath);
  let visual = await CarVisual.load(visualCfg);
  scene.add(visual.root);
  visual.setPaint(paintOf(sel, catalog), sel.finish);
  let net: Net | null = null;   // only while an Online session runs
  let shape = shapeOf(visualCfg);
  let car = new CarBody(pw, core, shape, visual.cg);

  // Rapier only indexes new colliders for queries during a step: step once so the spawn probe
  // below can see the city (without this the first spawn misses the road and drops 3 m).
  pw.world.step();
  say('Loading traffic…');
  const ai = await AiTraffic.create(scene, pw, defaultCfg, route.samples, Math.max(0, Math.min(3, num('ai', 3))), params.get('blackcar') === '1');

  // Start line = first route sample (core coords: Z-up) -> three (x, z, -y).
  const s0 = route.samples[0];
  const spawn = () => {
    const p = new THREE.Vector3(s0.x, s0.z + 3, -s0.y);
    const hit = pw.raycast(p, p.clone().add(new THREE.Vector3(0, -20, 0)));
    if (hit) p.y -= hit.toi;
    p.y += core.info.cgHeight + 0.05;
    car.place(p, Math.atan2(Math.cos(s0.heading), -Math.sin(s0.heading)));
  };
  spawn();

  // Laps: the core's RaceTracker on the city route (free run: laps counted forever).
  const routeJson = JSON.stringify(route);
  let race = new CoreRace(routeJson, 0);
  let raceCar = race.addCar(car.body.translation());
  let raceT0 = 0, lap: LapInfo | null = null;

  const pos = new THREE.Vector3(), quat = new THREE.Quaternion();
  const input = new Input();
  const rig = new CameraRig(camera, pw, car.body, core.info.redline);
  const hud = new Hud();
  const audio = new GameAudio();
  audio.prepare();   // the audio device opens now (behind the loading screen), not on the first key press
  let damage = new DamageVisuals(visual, visualCfg, pw, scene);
  const wireDamage = () => { damage.onImpact = (kj, glass) => audio.impact(kj, glass); };
  wireDamage();
  input.onAnyInput = () => audio.unlock();
  audio.muted = true;   // silent in the menus
  // Session state. boot/title/garage/busy: car parked on the start line under the orbit camera;
  // countdown: same, with 3-2-1; race: driving; paused: everything frozen; results: race over, car braked.
  type State = 'boot' | 'title' | 'garage' | 'busy' | 'countdown' | 'race' | 'paused' | 'results';
  let state: State = 'boot';
  let pausedFrom: State = 'race';
  const driving = () => state === 'race' || state === 'countdown' || state === 'paused' || state === 'results';
  const setState = (st: State) => { state = st; document.body.classList.toggle('menu', !driving()); };
  // brake 0.5, not 1: a full brake while stopped engages the pedal reverse
  const IDLE: RawInput = { steer: 0, throttle: 0, brake: 0.5, clutch: 0, handbrake: 1, shiftUp: false, shiftDown: false, device: 0 };
  let lapTimes: number[] = [], raceFinishedAt = -1;
  /** Fresh car on the start line, repaired, traffic back at its grid slots, lap counter at zero. */
  const resetCar = () => {
    spawn(); core.repair(); damage.repair(); input.hold = true;
    race = new CoreRace(routeJson, sel.mode === 'race' ? sel.laps : 0);
    raceCar = race.addCar(car.body.translation());
    raceT0 = ticks * DT;
    lapTimes = []; raceFinishedAt = -1; lap = null;
    hud.resetLaps();
    ai.reset();
  };
  input.onReset = () => {
    if (state === 'race') { if (sel.mode === 'race') void beginRace(); else resetCar(); }
  };
  input.onLights = () => { if (driving()) { visual.lightsOn = !visual.lightsOn; visual.applyHeadlights(); } };
  const enableTouch = () => {
    if (input.touch) return;
    document.body.classList.add('touch');
    input.touch = new TouchControls({
      reset: () => input.onReset(),
      camera: () => rig.toggle(),
      toggleGearbox: () => (input.assists.autoGearbox = !input.assists.autoGearbox),
      unlockAudio: () => audio.unlock(),
    });
  };
  const onTouch = () => { if (driving()) { enableTouch(); removeEventListener('touchstart', onTouch); } };
  addEventListener('touchstart', onTouch, { passive: true });
  input.onCamera = () => { if (driving()) rig.toggle(); };
  input.onHud = () => { if (driving()) hud.toggle(); };

  // Showroom lights for the title/garage views: a key spot and a cool rim light that follow the
  // camera. Intensity changes only (never visibility: that would recompile every material).
  const showKey = new THREE.SpotLight(0xfff1e0, 0, 40, 0.8, 0.8, 2);
  const showRim = new THREE.PointLight(0x6f8cff, 0, 16, 2);
  scene.add(showKey, showKey.target, showRim);
  // --- post-processing ------------------------------------------------------------------------
  const post = new Post(renderer, scene, camera, { bloom: params.get('bloom') !== '0', aa: params.get('aa') !== '0', scale, preset: PRESET_ORDER[presetIdx] });
  // Headlight shadow map: only the car bodies cast into it (the city does not cast), re-rendered
  // every Nth frame by preset (stale by one frame = ~1 m of light travel at 130 km/h, invisible:
  // map and light matrix stay paired, so shadows stay anchored to their casters).
  let headShadows = visual.headlights.filter((s) => s.castShadow).map((s) => s.shadow);
  for (const sh of headShadows) sh.autoUpdate = false;

  rig.update(1, pos.copy(car.body.translation() as THREE.Vector3), quat.copy(car.body.rotation() as THREE.Quaternion), new THREE.Vector3(), car.out);
  cityLights.update(1, camera);
  city.update(camera, true);
  say('Compiling shaders…');
  // Warm-up behind the loading screen: every pipeline the race can need is built now, not as a
  // freeze mid-race. compileAsync covers the scene's materials; the post chains, shadow pass and
  // render-target pipelines only exist once rendered, so every preset is RENDERED in each state:
  // remote car clone, AI cars in the beam, headlights off, broken lights (their dark material
  // clones), engine fire light on. Light states are intensity changes (never visibility), so they
  // share pipelines; the dark light clones are new materials with the same program.
  const warm = async () => {
    await renderer.compileAsync(scene, camera);
    for (const sh of headShadows) sh.needsUpdate = true;
    post.warmup();
  };
  await warm();
  if (ai.cars.length) {
    // draw the AI cars once in the headlight beam (their pipelines + shadow pass), then send them off
    const yaw = Math.atan2(Math.cos(s0.heading), -Math.sin(s0.heading));
    visual.update(pos, quat, car.out);
    ai.stage(pos.clone().setY(pos.y - core.info.cgHeight - 0.05), yaw);
    ai.update(1, camera);
    await warm();
  }
  {
    const dmgInt = damage as unknown as { killLights(n: string[]): void; fireLight: THREE.PointLight };
    visual.lightsOn = false; visual.applyHeadlights();
    dmgInt.killLights([...visualCfg.front_lights, ...visualCfg.rear_lights]);
    dmgInt.fireLight.intensity = 30;
    await warm();
    dmgInt.fireLight.intensity = 0;
    damage.repair();
    visual.lightsOn = true; visual.applyHeadlights();
    post.warmup();
  }
  ai.reset();
  {
    // compileAsync builds pipelines, but an object's GPU buffers, bind groups and textures are only
    // created the first time it is actually DRAWN. City blocks coming into view therefore stalled
    // the first second of driving (one 200-280 ms frame ~0.8 s after the start, every run, no new
    // pipeline). Draw everything once with frustum culling off, behind the loading screen.
    const culled: THREE.Object3D[] = [];
    scene.traverse((o) => { if (o.frustumCulled && (o as THREE.Mesh).isMesh) { o.frustumCulled = false; culled.push(o); } });
    post.render();
    for (const o of culled) o.frustumCulled = true;
  }
  await post.warmupFrames();
  // The warm-up queued a dozen full renders on the GPU: wait until it has worked through them, or
  // the first race frames block behind that backlog (a 130-220 ms frame 0.2-0.6 s after loading).
  if (webgpu) await (renderer.backend as unknown as { device: GPUDevice }).device.queue.onSubmittedWorkDone();
  const pipelinesAtStart =(renderer as unknown as { _pipelines: { caches: Map<string, unknown> } })._pipelines.caches.size;
  const setExtra = () => (hud.extra = `${backend} · ${Math.floor(renderer.domElement.width * scale)}×${Math.floor(renderer.domElement.height * scale)}`
    + ` → ${renderer.domElement.width}×${renderer.domElement.height} · scale ${+scale.toFixed(2)}${adaptive ? '' : ' (fixed)'}`
    + ` · ${post.preset}${presetPinned ? ' (fixed)' : ''} · ${cityLights.mode}`
    + (net ? ` · ${net.status}` : ''));
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
  const WINDOW = 1000, FPS_LOW = 40, FPS_HIGH = 55, STEP = 0.1, MIN_SCALE = 0.5, TUNE_TIMEOUT = 30000;
  let winStart = 0, tuning = false, calSteps = 0, upSteps = 0, wentDown = false, tuneStart = 0;
  const startScale = () => Math.min(maxScale, Math.max(0.5, Math.round(Math.sqrt(0.9e6 / (innerWidth * innerHeight * Math.min(devicePixelRatio, 1) ** 2)) * 10) / 10));
  const setPreset = (i: number) => {
    presetIdx = i;
    post.preset = PRESET_ORDER[i];
    try { localStorage.setItem(PRESET_KEY, post.preset); } catch { /* storage blocked */ }
  };
  const applyScale = (x: number) => {
    scale = Math.min(maxScale, Math.max(MIN_SCALE, Math.round(x * 10) / 10));
    post.setScale(scale);   // render targets + cluster grid resize: the hitch the cover hides
    try { localStorage.setItem(SCALE_KEY, String(scale)); } catch { /* storage blocked */ }
  };
  /**
   * Window or fullscreen size changed: the settled scale and preset are per size. Take the ones stored for the new
   * size, else the ~0.9 MP-render guess (never the old size's scale: a windowed 1.0 would render 2.5x the pixels
   * at 1080p fullscreen). Not while the graphics are pinned (URL, or a fixed High/Medium/Low).
   */
  let lastSize = `${innerWidth}x${innerHeight}`;
  function syncToSize() {
    const k = `${innerWidth}x${innerHeight}`;
    if (k === lastSize) return;
    lastSize = k;
    SCALE_KEY = `nr.scale.${k}`; PRESET_KEY = `nr.preset.${k}`;
    if (!adaptive) return;
    let sc = NaN, pr: string | null = null;
    try { sc = Number(localStorage.getItem(SCALE_KEY) ?? NaN); pr = localStorage.getItem(PRESET_KEY); } catch { /* storage blocked */ }
    stored = sc;
    applyScale(sc >= MIN_SCALE && sc <= maxScale ? sc : startScale());
    if (pr && PRESET_ORDER.includes(pr as PresetName)) { presetIdx = PRESET_ORDER.indexOf(pr as PresetName); post.preset = pr as PresetName; }
    setExtra();
  }
  const startTuning = (full: boolean) => {
    tuning = true; wentDown = false; tuneStart = performance.now();
    calSteps = full || Number.isNaN(stored) ? 3 : 1;
    upSteps = full ? 3 : 0;
    if (full) { setPreset(0); applyScale(startScale()); }
    frameTimes.length = 0;
    winStart = performance.now() + 2500;   // the cover has just appeared: let the frame pacing settle
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
    try { localStorage.setItem(GFX_KEY, g); } catch { /* storage blocked */ }
    if (g === 'auto') { adaptive = true; presetPinned = false; startTuning(true); return; }
    adaptive = false; presetPinned = true;
    tuning = false;
    setPreset(PRESET_ORDER.indexOf(g));
    applyScale(GFX_SCALE[g]);
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
  g.__game = { city, ai, visual, audio, rig, damage, trace, input, renderer, camera, scene, post,
    get car() { return car; }, get core() { return core; }, get state() { return state; }, menu: () => menu, sel,
    setPreset: (name: PresetName) => { setPreset(PRESET_ORDER.indexOf(name)); setExtra(); },
    setScale: (x: number) => { scale = x; post.setScale(x); setExtra(); },
    pipelines: () => ({ atStart: pipelinesAtStart, now: (renderer as unknown as { _pipelines: { caches: Map<string, unknown> } })._pipelines.caches.size }),
    // Rapier cost per step + what it simulates (static city colliders have no body: never integrated)
    physics: () => ({ stepMs, bodies: pw.world.bodies.len(), colliders: pw.world.colliders.len(),
      list: pw.world.bodies.getAll().map((b) => `${b === car.body ? 'car' : b.isKinematic() ? 'ai' : 'debris'}:${b.isSleeping() ? 'asleep' : 'awake'}`).join(' ') }),
    info: () => ({ pos: car.body.translation(), speed: car.out[OUT.speed], rpm: car.out[OUT.rpm], gear: car.out[OUT.gear] }) };

  // --- front end: title -> garage -> session -------------------------------------------------
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const menu: Menu = new Menu(sel, catalog, physics, {
    preview: () => { void showCar().then(() => visual.setPaint(paintOf(sel, catalog), sel.finish)); },
    go: () => void startSession(),
    gfx: (g2) => applyGfx(g2),
    resume: () => resume(),
    restart: () => { menu.show('none'); if (sel.mode === 'race') void beginRace(); else { resetCar(); setState('race'); audio.muted = false; prev = performance.now(); } },
    garage: () => toGarage(),
    screen: (sc) => { if (sc === 'title' || sc === 'garage') setState(sc); },
  });
  menu.gfx = gfx;

  /** The garage car's own model (if its catalog entry has one): swapped in, damage visuals rebuilt. Serialised. */
  let visualQueue: Promise<void> = Promise.resolve();
  const showCar = () => (visualQueue = visualQueue.then(async () => {
    const path = visualPathOf(sel.car);
    if (path === visualPath) return;
    const cfg = path === DEFAULT_VISUAL ? defaultCfg : await fetchVisualCfg(path);
    const next = await CarVisual.load(cfg, visual.headlights);
    scene.remove(visual.root);
    damage.dispose();
    visualPath = path; visualCfg = cfg; visual = next; shape = shapeOf(cfg);
    scene.add(visual.root);
    visual.setPaint(paintOf(sel, catalog), sel.finish);
    damage = new DamageVisuals(visual, visualCfg, pw, scene);
    wireDamage();
    headShadows = visual.headlights.filter((s) => s.castShadow).map((s) => s.shadow);
    for (const sh of headShadows) sh.autoUpdate = false;
    Object.assign(g.__game, { visual, damage });
  }).catch((e) => console.error('car swap failed', e)));

  /** A different car or tuning replaces the physics body (and, via showCar, the model). */
  const rebuildPlayer = () => {
    builtKey = carKey();
    pw.world.removeRigidBody(car.body);
    core = new CoreCar(coreJson());
    car = new CarBody(pw, core, shape, visual.cg);
    rig.setTarget(car.body, core.info.redline);
  };

  async function startSession() {
    setState('busy');
    menu.show('busy', sel.mode === 'online' ? 'Connecting…' : 'Getting ready…');
    await showCar();
    visual.setPaint(paintOf(sel, catalog), sel.finish);
    if (carKey() !== builtKey) rebuildPlayer();
    if (sel.mode === 'online') {
      net = new Net(sel.server, scene, visual);
      net.paint = parseInt(paintOf(sel, catalog).slice(1), 16);
      net.onChange = setExtra;
      net.warmup(true);              // remote car shaders compiled now, not as a hitch when someone joins
      await warm();
      net.warmup(false);
    } else await sleep(60);
    hud.lapTotal = sel.mode === 'race' ? sel.laps : 0;
    hud.show();
    if (wantsTouch()) enableTouch();
    audio.unlock();
    await beginRace();
  }

  /** Respawn and start: 3-2-1 in a race, straight into the car otherwise. */
  async function beginRace() {
    menu.show('none');
    resetCar();
    rig.snap();
    input.poll();                    // drop key edges pressed in the menus
    audio.muted = false;
    prev = performance.now(); acc = 0;
    if (sel.mode !== 'race') { setState('race'); setExtra(); return; }
    setState('countdown');
    for (const t of ['3', '2', '1']) { menu.countdown(t); await sleep(900); if (state !== 'countdown') { menu.countdown(''); return; } }
    menu.countdown('GO');
    setState('race');
    raceT0 = ticks * DT;
    setTimeout(() => menu.countdown(''), 700);
  }

  function resume() {
    setState(pausedFrom);
    menu.show('none');
    audio.muted = false;
    prev = performance.now();
  }

  function toGarage() {
    net?.close(); net = null;
    hud.hide();
    menu.countdown('');
    audio.muted = true;
    resetCar();
    setState('garage');
    menu.show('garage');
    visual.setPaint(paintOf(sel, catalog), sel.finish);
    setExtra();
  }

  function finishRace() {
    setState('results');
    audio.muted = true;
    const total = lapTimes.reduce((a, b) => a + b, 0);
    menu.showResults({ total, best: Math.min(...lapTimes), laps: lapTimes, laps_target: sel.laps });
  }

  addEventListener('keydown', (e) => {
    if (e.code !== 'Escape' || e.repeat) return;
    if (state === 'race') { pausedFrom = state; setState('paused'); audio.muted = true; menu.show('pause'); }
    else if (state === 'paused') resume();
  });

  // Showroom camera: slow turntable around the parked car, drag to turn, wheel to zoom.
  const orbit = { az: 2.3, el: 0.17, dist: 7, drag: false, x: 0, y: 0, shift: 0 };
  (g.__game as { orbit?: typeof orbit }).orbit = orbit;
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
  dom.addEventListener('wheel', (e) => { if (!driving()) orbit.dist = Math.min(11, Math.max(4.5, orbit.dist + e.deltaY * 0.004)); }, { passive: true });
  const tmpT = new THREE.Vector3(), tmpP = new THREE.Vector3(), tmpR = new THREE.Vector3(), tmpD = new THREE.Vector3();
  const placeShowroom = (dt: number, carPos: THREE.Vector3) => {
    if (!orbit.drag) orbit.az += dt * (state === 'title' ? 0.2 : 0.1);
    // on the title the car sits right of centre (the logo is on the left); in the garage it is centred
    orbit.shift += ((state === 'title' ? 1.7 : 0) - orbit.shift) * (1 - Math.exp(-dt * 4));
    tmpT.copy(carPos).add(tmpD.set(0, 0.25, 0));
    const ce = Math.cos(orbit.el);
    tmpP.set(Math.sin(orbit.az) * ce, Math.sin(orbit.el), Math.cos(orbit.az) * ce).multiplyScalar(orbit.dist).add(tmpT);
    const hit = pw.raycast(tmpT, tmpP, car.body);   // pull in front of walls (not the car itself)
    if (hit && hit.toi < orbit.dist) tmpP.sub(tmpT).setLength(Math.max(2.5, hit.toi - 0.4)).add(tmpT);
    camera.position.copy(tmpP);
    tmpR.subVectors(tmpT, tmpP).cross(tmpD.set(0, 1, 0)).setY(0).normalize();   // camera right
    camera.lookAt(tmpD.copy(tmpT).addScaledVector(tmpR, -orbit.shift));
    if (camera.fov !== 42) { camera.fov = 42; camera.updateProjectionMatrix(); }
    showKey.position.copy(camera.position).add(tmpD.set(0, 3.5, 0));
    showKey.target.position.copy(tmpT);
    showKey.intensity = 650;
    showRim.position.copy(tmpT).addScaledVector(tmpP.sub(tmpT).normalize(), -5).add(tmpD.set(0, 1.4, 0));
    showRim.intensity = 260;
  };

  if (import.meta.env.DEV) {
    const report = (msg: string) => fetch('/__telemetry', { method: 'POST', body: msg }).catch(() => {});
    report(`started ${backend} | ${navigator.userAgent.match(/Chrome\/[\d.]+|Firefox\/[\d.]+/)?.[0] ?? ''}`);
    setInterval(() => report(`${document.getElementById('perf')!.textContent!.replace('\n', ' | ')} | ${Math.round(Math.abs(car.out[OUT.speed]) * 3.6)} km/h`), 2000);
  }

  // Render interpolation: the car is drawn between the last two physics states (alpha = leftover
  // time / tick). Without it the drawn position snaps to whole 240 Hz ticks and the number of ticks
  // per frame varies, which reads as judder at 30 fps (up to ~17 cm per frame at 140 km/h).
  const prevPos = new THREE.Vector3(), prevQuat = new THREE.Quaternion();
  const physPos = new THREE.Vector3(), physQuat = new THREE.Quaternion();
  const carAcc = new THREE.Vector3(), lastVel = new THREE.Vector3();
  const readBody = (p: THREE.Vector3, q: THREE.Quaternion) => {
    const t = car.body.translation(), r = car.body.rotation();
    p.set(t.x, t.y, t.z);
    q.set(r.x, r.y, r.z, r.w);
  };
  readBody(physPos, physQuat);
  prevPos.copy(physPos);
  prevQuat.copy(physQuat);

  // Boot into the title (or, for the test tools with ?menu=0, straight into a free run).
  document.getElementById('loading')?.remove();
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
    else menu.setTuning(false, params.has('scale') || PRESET_ORDER.includes(params.get('quality') as PresetName) ? 'Graphics pinned by the URL' : `Graphics fixed: ${gfx}`);
    visual.setPaint(paintOf(sel, catalog), sel.finish);
  }
  setExtra();

  const capFps = params.has('cap') ? num('cap', 30) : 30;
  const capInterval = capFps > 0 ? 1000 / capFps : 0;
  let lastRenderAt = 0;
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const frame = Math.min(0.1, (now - prev) / 1000);
    prev = now;
    const live = state !== 'paused';
    if (live) acc += frame;
    let steps = 0;
    while (acc >= DT && steps < 24) {
      prevPos.copy(physPos);
      prevQuat.copy(physQuat);
      car.tick(state === 'race' ? input.poll() : IDLE, input.assists);
      if (state === 'title' || state === 'garage' || state === 'busy') { car.body.setLinvel({ x: 0, y: Math.min(0, car.body.linvel().y), z: 0 }, true); car.body.setAngvel({ x: 0, y: 0, z: 0 }, true); }   // parked for the showroom
      ai.tick(DT, car.body.translation());
      const t0 = performance.now();
      pw.world.step();
      stepMs += (performance.now() - t0 - stepMs) * 0.01;   // Rapier cost per 240 Hz step, smoothed
      readBody(physPos, physQuat);
      // car acceleration for the camera spring, from the physics (low-passed ~25 ms)
      const v = car.body.linvel();
      const a = new THREE.Vector3(v.x - lastVel.x, v.y - lastVel.y, v.z - lastVel.z).divideScalar(DT);
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
    if (steps === 24) acc = 0;   // too slow to keep up: drop time rather than spiral
    const alpha = Math.min(1, acc / DT);
    pos.lerpVectors(prevPos, physPos, alpha);
    quat.slerpQuaternions(prevQuat, physQuat, alpha);
    const lv = car.body.linvel();
    visual.velocity.set(lv.x, lv.y, lv.z);
    visual.update(pos, quat, car.out, prevPos, prevQuat);   // car.out was computed from the pose BEFORE the last step
    ai.update(alpha, camera);
    damage.update(live ? frame : 0, () => core.damage());
    if (driving()) audio.update(car.out, car.out[OUT.speed]);
    net?.update(now, pos, quat);
    if (!driving() || state === 'busy') { placeShowroom(frame, pos); }
    else {
      showKey.intensity = showRim.intensity = 0;
      if (live) rig.update(frame, pos, quat, carAcc, car.out);
    }
    cityLights.update(frame, camera);   // WebGL 2 pool only (5 Hz); a no-op with clustered lighting
    city.update(camera);
    // Frame cap (default 30 fps: the quality target; ?cap=0 uncapped, ?cap=45 etc.). Simulation, camera and HUD run every
    // display refresh; only the draw is skipped, so the picture holds still between rendered frames. The cap is off while
    // the graphics tuner measures (it needs the uncapped speed), and the slot clock advances by whole intervals so a
    // 60/120/144 Hz display averages exactly the cap instead of rounding down.
    if (capInterval === 0 || tuning || now - lastRenderAt >= capInterval - 2) {
      lastRenderAt = capInterval && now - lastRenderAt < capInterval * 1.5 ? lastRenderAt + capInterval : now;
      if (++frameNo % PRESETS[post.preset].shadowEvery === 0) for (const sh of headShadows) sh.needsUpdate = true;
      post.render();
      hud.rendered(now);
    }
    if (state === 'race') {
      lap = race.update(raceCar, car.body.translation(), ticks * DT - raceT0);
      if (lap.laps > lapTimes.length) lapTimes.push(lap.last);
      if (sel.mode === 'race' && lap.finished && raceFinishedAt < 0) raceFinishedAt = now;
      if (raceFinishedAt > 0 && now - raceFinishedAt > 1500) finishRace();
    }
    if (driving() && state !== 'paused') hud.update(now, frame, car.out, core.info, input.assists, damage.last, lap);
    // Graphics tuning (title menu only, behind the cover; see startTuning)
    if (now >= winStart) frameTimes.push(frame * 1000);
    if (tuning && now - winStart >= WINDOW) {
      const fps = (frameTimes.length * 1000) / (now - winStart);
      const sorted = frameTimes.slice().sort((x, y) => x - y);
      const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
      frameTimes.length = 0;
      winStart = now;
      const low = fps < FPS_LOW, high = fps > FPS_HIGH && p90 < 22;
      let changed = true;
      if (low && !presetPinned && presetIdx < PRESET_ORDER.length - 1) { setPreset(presetIdx + 1); wentDown = true; }
      else if (low && calSteps > 0 && scale > MIN_SCALE + 1e-6) { applyScale(scale - STEP); calSteps--; wentDown = true; }
      else if (high && !wentDown && upSteps > 0 && scale < maxScale - 1e-6) { applyScale(scale + STEP); upSteps--; }
      else changed = false;
      if (!changed || now - tuneStart > TUNE_TIMEOUT) finishTuning();
      else { winStart = now + 1000; setExtra(); }   // let the resize hitch pass before measuring again
    }
  });
}

main().catch((e) => {
  console.error(e);
  say('Error: ' + (e instanceof Error ? e.message : String(e)));
});
