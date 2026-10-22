// Night Run (web build): three.js WebGPU renderer + Rapier rigid bodies + the rs_core physics
// compiled to WebAssembly. WebGPU required. URL options: ?scale=0.75 (pins the render resolution; default adaptive),
// ?quality=high|medium|low (pins the post/render preset; default adaptive), ?webgl=1 (debug only),
// ?bloom=0, ?aa=0, ?shadows=0, ?lights=12 (WebGL 2 light pool size), ?mp=1 or ?mp=ws://host:port (multiplayer, see net.ts),
// ?ai=0..3 (AI cars), ?blackcar=1 (AI cars matte black, lights off: night lighting test).
import * as THREE from 'three/webgpu';
import { Post, PRESETS, PRESET_ORDER, ScaledClusteredLighting, type PresetName } from './post';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CoreCar, CoreRace, OUT, loadCore, type LapInfo } from './physics/core';
import { CarBody, DT, PhysicsWorld, loadRapier } from './physics/world';
import { CityLighting, loadCity } from './scene/city';
import { CarVisual, type CarVisualConfig } from './scene/car';
import { CameraRig } from './camera';
import { Input } from './input';
import { Hud } from './hud';
import { DamageVisuals } from './scene/damage';
import { GameAudio } from './audio';
import { TouchControls, wantsTouch } from './touch';
import { Net, netUrl } from './net';
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
  const adaptive = !params.has('scale');   // ?scale=x pins the resolution
  const maxScale = 1;
  // Start near ~0.9 megapixels rendered (1.07 MP measured too heavy on the laptop iGPU at 60 Hz).
  // The scale settled on last time on this device (a calibration costs a resize hitch per step).
  const SCALE_KEY = `nr.scale.${innerWidth}x${innerHeight}`;
  let stored = NaN;
  try { stored = Number(localStorage.getItem(SCALE_KEY) ?? NaN); } catch { /* storage blocked */ }
  let scale = params.has('scale') ? num('scale', 1) : stored >= 0.5 && stored <= maxScale ? stored
    : Math.min(maxScale, Math.max(0.5, Math.round(Math.sqrt(0.9e6 / (innerWidth * innerHeight * Math.min(devicePixelRatio, 1) ** 2)) * 10) / 10));
  renderer.setPixelRatio(baseRatio);
  renderer.setSize(innerWidth, innerHeight);
  // Quality preset (post.ts PRESETS), lowered by the adaptive system BEFORE the scale; stored like it.
  const PRESET_KEY = `nr.preset.${innerWidth}x${innerHeight}`;
  const presetPinned = PRESET_ORDER.includes(params.get('quality') as PresetName);
  let storedPreset: string | null = null;
  try { storedPreset = localStorage.getItem(PRESET_KEY); } catch { /* storage blocked */ }
  let presetIdx = Math.max(0, PRESET_ORDER.indexOf((presetPinned ? params.get('quality') : storedPreset ?? 'high') as PresetName));
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = params.get('shadows') !== '0';
  renderer.shadowMap.type = THREE.PCFShadowMap;
  await renderer.init();
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
  });

  // --- physics + content ----------------------------------------------------------------------
  say('Loading physics…');
  await Promise.all([loadCore(), loadRapier()]);
  const [carJson, visualCfg, route] = await Promise.all([
    fetch('/data/cars/vela_gt.json').then((r) => r.text()),
    fetch('/data/cars/vela_gt.visual.json').then((r) => r.json() as Promise<CarVisualConfig>),
    fetch('/data/tracks/city_route.json').then((r) => r.json()),
  ]);
  const core = new CoreCar(carJson);
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
  const visual = await CarVisual.load(visualCfg);
  scene.add(visual.root);
  const mpUrl = netUrl(params);
  const net = mpUrl ? new Net(mpUrl, scene, visual) : null;   // clones the car model as loaded
  const cb = visualCfg.collision_box;
  const car = new CarBody(pw, core, {
    boxSize: cb.size_m, boxCentre: cb.centre_in_model_m, endLift: cb.end_lift_m, endLiftStart: cb.end_lift_start_m,
  }, visual.cg);

  // Rapier only indexes new colliders for queries during a step: step once so the spawn probe
  // below can see the city (without this the first spawn misses the road and drops 3 m).
  pw.world.step();
  say('Loading traffic…');
  const ai = await AiTraffic.create(scene, pw, visualCfg, route.samples, Math.max(0, Math.min(3, num('ai', 3))), params.get('blackcar') === '1');

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
  const damage = new DamageVisuals(visual, visualCfg, pw, scene);
  damage.onImpact = (kj, glass) => audio.impact(kj, glass);
  input.onAnyInput = () => audio.unlock();
  input.onReset = () => {
    spawn(); core.repair(); damage.repair(); input.hold = true;
    race = new CoreRace(routeJson, 0);
    raceCar = race.addCar(car.body.translation());
    raceT0 = ticks * DT;
    hud.resetLaps();
    ai.reset();
  };
  input.onLights = () => { visual.lightsOn = !visual.lightsOn; visual.applyHeadlights(); };
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
  if (wantsTouch()) enableTouch();
  addEventListener('touchstart', enableTouch, { once: true, passive: true });
  input.onCamera = () => rig.toggle();
  input.onHud = () => hud.toggle();

  // --- post-processing ------------------------------------------------------------------------
  const post = new Post(renderer, scene, camera, { bloom: params.get('bloom') !== '0', aa: params.get('aa') !== '0', scale, preset: PRESET_ORDER[presetIdx] });
  // Headlight shadow map: only the car bodies cast into it (the city does not cast), re-rendered
  // every Nth frame by preset (stale by one frame = ~1 m of light travel at 130 km/h, invisible:
  // map and light matrix stay paired, so shadows stay anchored to their casters).
  const headShadows = visual.headlights.filter((s) => s.castShadow).map((s) => s.shadow);
  for (const sh of headShadows) sh.autoUpdate = false;

  rig.update(1, pos.copy(car.body.translation() as THREE.Vector3), quat.copy(car.body.rotation() as THREE.Quaternion), new THREE.Vector3(), car.out);
  cityLights.update(1, camera);
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
  net?.warmup(true);   // remote car shaders compiled now, not as a hitch when someone joins
  await warm();
  net?.warmup(false);
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
  hud.show();
  const setExtra = () => (hud.extra = `${backend} · ${Math.floor(renderer.domElement.width * scale)}×${Math.floor(renderer.domElement.height * scale)}`
    + ` → ${renderer.domElement.width}×${renderer.domElement.height} · scale ${+scale.toFixed(2)}${adaptive ? '' : ' (pinned)'}`
    + ` · ${post.preset}${presetPinned ? ' (pinned)' : ''} · ${cityLights.mode}`
    + (net ? ` · ${net.status}` : '') + (input.locked ? ' · calibrating…' : ''));
  setExtra();
  if (net) net.onChange = setExtra;

  // --- loop: fixed 240 Hz physics, render every frame -----------------------------------------
  let acc = 0, prev = performance.now(), ticks = 0;
  const frameTimes: number[] = [];
  // adaptive resolution state (see the end of the loop)
  const WINDOW = 2000, FPS_LOW = 40, FPS_FLOOR = 30, FPS_HIGH = 55, CONFIRM = 2, CONFIRM_DOWN = 3, STEP = 0.1, MIN_SCALE = 0.5;
  let winStart = performance.now() + 3000;   // skip shader warm-up
  let calibrating = adaptive, calSteps = Number.isNaN(stored) ? 3 : 1, lowRun = 0, highRun = 0, lastUp = -Infinity, lastDown = -Infinity, upCooldown = 10000;
  input.locked = adaptive;
  setExtra();
  let stepMs = 0;
  const trace: unknown[] = [];
  const g = window as unknown as { __game: object };
  // Hidden tab: requestAnimationFrame stops, so nothing renders; but the first window after coming
  // back would average in the hidden time and read as "< 30 fps" -> a needless step down. Restart it.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { frameTimes.length = 0; winStart = performance.now() + 1000; lowRun = highRun = 0; prev = performance.now(); }
  });
  let frameNo = 0;
  const setPreset = (i: number) => {
    presetIdx = i;
    post.preset = PRESET_ORDER[i];
    try { localStorage.setItem(PRESET_KEY, post.preset); } catch { /* storage blocked */ }
  };
  g.__game = { ai, visual, audio, rig, damage, trace, car, core, input, renderer, camera, scene, post,
    setPreset: (name: PresetName) => { setPreset(PRESET_ORDER.indexOf(name)); setExtra(); },
    setScale: (x: number) => { scale = x; post.setScale(x); setExtra(); },
    pipelines: () => ({ atStart: pipelinesAtStart, now: (renderer as unknown as { _pipelines: { caches: Map<string, unknown> } })._pipelines.caches.size }),
    // Rapier cost per step + what it simulates (static city colliders have no body: never integrated)
    physics: () => ({ stepMs, bodies: pw.world.bodies.len(), colliders: pw.world.colliders.len(),
      list: pw.world.bodies.getAll().map((b) => `${b === car.body ? 'car' : b.isKinematic() ? 'ai' : 'debris'}:${b.isSleeping() ? 'asleep' : 'awake'}`).join(' ') }),
    info: () => ({ pos: car.body.translation(), speed: car.out[OUT.speed], rpm: car.out[OUT.rpm], gear: car.out[OUT.gear] }) };

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

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const frame = Math.min(0.1, (now - prev) / 1000);
    prev = now;
    acc += frame;
    let steps = 0;
    while (acc >= DT && steps < 24) {
      prevPos.copy(physPos);
      prevQuat.copy(physQuat);
      car.tick(input.poll(), input.assists);
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
    visual.update(pos, quat, car.out, physPos, physQuat);
    ai.update(alpha, camera);
    damage.update(frame, () => core.damage());
    audio.update(car.out, car.out[OUT.speed]);
    net?.update(now, pos, quat);
    rig.update(frame, pos, quat, carAcc, car.out);
    cityLights.update(frame, camera);   // WebGL 2 pool only (5 Hz); a no-op with clustered lighting
    if (++frameNo % PRESETS[post.preset].shadowEvery === 0) for (const sh of headShadows) sh.needsUpdate = true;
    post.render();
    lap = race.update(raceCar, car.body.translation(), ticks * DT - raceT0);
    hud.update(now, frame, car.out, core.info, input.assists, damage.last, lap);
    // Adaptive resolution: every 2 s, average fps over the window. A resize reallocates every
    // render target and froze the game 300-700 ms, and pacing (missed frames) is what reads as
    // stutter, so changes are rare and deliberate:
    // - calibration (up to 3 windows of 1 s; 1 window when a scale is stored from a previous
    //   session): the car is LOCKED on the brake (input.locked, HUD "calibrating…") and one window
    //   < 40 fps is enough to step down, so the hitches happen before the player can drive;
    //   the settled scale is stored per window size, so later sessions start there;
    // - while driving, only a real collapse steps down: < 30 fps for 3 consecutive windows -> -0.1
    //   (min 0.5). Driving costs more than the parked calibration view, and on the laptop iGPU it runs
    //   33-39 fps at the calibrated scale: a 40 fps rule there froze the game ~0.7 s per step mid-drive
    //   and walked the resolution down to 0.5 (the user accepts ~30 fps for image quality);
    // - "stably" > 55 fps (2 consecutive windows, and 90 % of frames under 22 ms) -> +0.1, at most
    //   one step up per 10 s, only while the car is stopped, never above maxScale. If a step up is followed by a step down
    //   within 20 s it was too much: the up cooldown doubles (10 -> 20 -> 40 -> 80 s), so the
    //   game cannot oscillate between two scales and freeze every few seconds;
    // - after any resize the next window starts 1 s later and the counters reset, so the resize
    //   hitch itself is never measured.
    // ?scale=x pins the resolution (adaptive off).
    if (now >= winStart) frameTimes.push(frame * 1000);
    if (adaptive && now - winStart >= (calibrating ? WINDOW / 2 : WINDOW)) {
      const fps = (frameTimes.length * 1000) / (now - winStart);
      const sorted = frameTimes.slice().sort((a, b) => a - b);
      const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
      frameTimes.length = 0;
      winStart = now;
      lowRun = fps < (calibrating ? FPS_LOW : FPS_FLOOR) ? lowRun + 1 : 0;
      highRun = fps > FPS_HIGH && p90 < 22 ? highRun + 1 : 0;
      let next = scale, nextPreset = presetIdx;
      const canDropPreset = !presetPinned && presetIdx < PRESET_ORDER.length - 1;
      if (calibrating) {
        // stays locked until a window WITHOUT a change, so the last resize hitch is never driven through
        if (lowRun > 0 && canDropPreset) nextPreset++;
        else if (lowRun > 0 && calSteps > 0 && scale > MIN_SCALE) { next = scale - STEP; calSteps--; }
        else calibrating = false;
      } else if (lowRun >= CONFIRM_DOWN) {
        if (canDropPreset) nextPreset++;                              // cheaper post first (no hitch)
        else next = scale - STEP;                                     // only then the resolution
      } else if (highRun >= CONFIRM && now - lastUp >= upCooldown && now - lastDown >= upCooldown) {
        // up in reverse order: resolution first (only when stopped: resize hitch), then the preset
        if (scale < maxScale - 1e-6) { if (Math.abs(car.out[OUT.speed]) < 1) next = scale + STEP; }
        else if (!presetPinned && presetIdx > 0) nextPreset--;
      }
      if (nextPreset !== presetIdx) {
        // no resize, no recompile (every preset pipeline was built at load): applies at once
        if (nextPreset > presetIdx) { if (now - lastUp < 20000) upCooldown = Math.min(80000, upCooldown * 2); lastDown = now; }
        else lastUp = now;
        setPreset(nextPreset);
        lowRun = highRun = 0;
        setExtra();
      }
      next = Math.min(maxScale, Math.max(MIN_SCALE, Math.round(next * 10) / 10));
      if (input.locked !== calibrating) { input.locked = calibrating; setExtra(); }
      if (Math.abs(next - scale) > 1e-6) {
        if (next < scale) {
          if (now - lastUp < 20000) upCooldown = Math.min(80000, upCooldown * 2);
          lastDown = now;
        } else lastUp = now;
        scale = next;
        post.setScale(scale);   // render targets + cluster grid resize: the hitch this logic schedules
        try { localStorage.setItem(SCALE_KEY, String(scale)); } catch { /* storage blocked */ }
        lowRun = highRun = 0;
        winStart = now + 1000;                                       // let the resize hitch pass
        setExtra();
      }
    }
  });
}

main().catch((e) => {
  console.error(e);
  say('Error: ' + (e instanceof Error ? e.message : String(e)));
});
