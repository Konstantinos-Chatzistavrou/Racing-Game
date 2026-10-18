// Night Run (web build): three.js WebGPU renderer + Rapier rigid bodies + the rs_core physics
// compiled to WebAssembly. WebGPU required. URL options: ?scale=0.75 (render resolution), ?webgl=1 (debug only),
// ?bloom=0, ?aa=0, ?shadows=0, ?lights=12 (WebGL 2 light pool size), ?mp=1 or ?mp=ws://host:port (multiplayer, see net.ts).
import * as THREE from 'three/webgpu';
import { Post } from './post';
import { ClusteredLighting } from 'three/addons/lighting/ClusteredLighting.js';
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
  const baseRatio = Math.min(devicePixelRatio, 1);
  const adaptive = !params.has('scale');   // ?scale=x pins the resolution
  const maxScale = 1;
  // Start near ~0.9 megapixels rendered (1.07 MP measured too heavy on the laptop iGPU at 60 Hz).
  let scale = params.has('scale') ? num('scale', 1)
    : Math.min(maxScale, Math.max(0.5, Math.round(Math.sqrt(0.9e6 / (innerWidth * innerHeight * Math.min(devicePixelRatio, 1) ** 2)) * 10) / 10));
  renderer.setPixelRatio(baseRatio * scale);
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = params.get('shadows') !== '0';
  renderer.shadowMap.type = THREE.PCFShadowMap;
  await renderer.init();
  const webgpu = !!(renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend;
  const backend = webgpu ? 'WebGPU' : 'WebGL 2';
  if (webgpu) renderer.lighting = new ClusteredLighting(512);   // needs compute shaders

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x02040a);
  scene.fog = new THREE.FogExp2(0x03060d, 0.0085);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;   // placeholder until the city is captured
  scene.environmentIntensity = 0.03;
  scene.add(new THREE.HemisphereLight(0x3a4a70, 0x050508, 0.1));
  const moon = new THREE.DirectionalLight(0x7088c0, 0.12);
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
    scene.environmentIntensity = 1;
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
  const rig = new CameraRig(camera, pw, car.body);
  const hud = new Hud();
  const audio = new GameAudio();
  const damage = new DamageVisuals(visual, visualCfg, pw, scene);
  damage.onImpact = (kj, glass) => audio.impact(kj, glass);
  input.onAnyInput = () => audio.unlock();
  input.onReset = () => {
    spawn(); core.repair(); damage.repair(); input.hold = true;
    race = new CoreRace(routeJson, 0);
    raceCar = race.addCar(car.body.translation());
    raceT0 = ticks * DT;
    hud.resetLaps();
  };
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
  const post = new Post(renderer, scene, camera, { bloom: params.get('bloom') !== '0', aa: params.get('aa') !== '0' });

  rig.update(1, pos.copy(car.body.translation() as THREE.Vector3), quat.copy(car.body.rotation() as THREE.Quaternion), new THREE.Vector3(), car.out);
  cityLights.update(1, camera);
  say('Compiling shaders…');
  net?.warmup(true);   // remote car shaders compiled now, not as a hitch when someone joins
  await renderer.compileAsync(scene, camera);
  net?.warmup(false);
  hud.show();
  const setExtra = () => (hud.extra = `${backend} · ${renderer.domElement.width}×${renderer.domElement.height} · ${cityLights.mode}`
    + (net ? ` · ${net.status}` : ''));
  setExtra();
  if (net) net.onChange = setExtra;

  // --- loop: fixed 240 Hz physics, render every frame -----------------------------------------
  let acc = 0, prev = performance.now(), ticks = 0, lastScaleCheck = performance.now() + 3000, calibrationSteps = 0, bad = 0;   // skip shader warm-up
  const frameTimes: number[] = [];
  const trace: unknown[] = [];
  const g = window as unknown as { __game: object };
  g.__game = { audio, rig, damage, trace, car, core, input, renderer, camera, scene, info: () => ({ pos: car.body.translation(), speed: car.out[OUT.speed], rpm: car.out[OUT.rpm], gear: car.out[OUT.gear] }) };

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
      pw.world.step();
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
    damage.update(frame, () => core.damage());
    audio.update(car.out, car.out[OUT.speed]);
    net?.update(now, pos, quat);
    rig.update(frame, pos, quat, carAcc, car.out);
    cityLights.update(frame, camera);
    post.render();
    lap = race.update(raceCar, car.body.translation(), ticks * DT - raceT0);
    hud.update(now, frame, car.out, core.info, input.assists, damage.last, lap);
    // Adaptive resolution driven by FRAME PACING, not average fps ("34 fps" was frames alternating
    // 33/50+ ms = stutter). A resize reallocates render targets and froze the game 300-700 ms, so:
    // calibrate at the start (car held on the brake), at most 3 steps, then LOCK. After that only a
    // sustained collapse (> 30 % missed for 3 windows) steps down again; never up mid-drive.
    frameTimes.push(frame * 1000);
    if (adaptive && now - lastScaleCheck > 1500) {
      lastScaleCheck = now;
      const missed = frameTimes.filter((t) => t > 22).length / Math.max(1, frameTimes.length);
      frameTimes.length = 0;
      let next = scale;
      if (calibrationSteps < 3) {
        if (missed > 0.08) { next = Math.max(0.5, scale - 0.1); calibrationSteps++; }
        else calibrationSteps = 3;                                   // smooth: lock here
      } else {
        bad = missed > 0.3 ? bad + 1 : 0;
        if (bad >= 3) { next = Math.max(0.5, scale - 0.1); bad = 0; }
      }
      if (Math.abs(next - scale) > 1e-6) {
        scale = Math.round(next * 10) / 10;
        renderer.setPixelRatio(baseRatio * scale);
        frameTimes.length = 0;
        lastScaleCheck = now + 1000;                                 // let the resize hitch pass
        setExtra();
      }
    }
  });
}

main().catch((e) => {
  console.error(e);
  say('Error: ' + (e instanceof Error ? e.message : String(e)));
});
