# Threejs-Punk Drive: what it does, and what we take from it

Studied 2026-10-18: https://threejspunk.vercel.app/ (canonical: threejspunkdrive.vercel.app), by
Anderson Mancini and Sunag (sunag wrote three.js's WebGPURenderer and node system). It is a free
cyberpunk driving game on three.js WebGPU + TSL + Rapier, the same stack as ours, so its choices
are directly comparable. No public source repo was found (web search, GitHub links in the bundle).
Everything below comes from the shipped bundle `assets/index-H-uJ8qQR.js` (2.07 MB minified,
three.js included; game code after ~1.19 MB). Minified names are quoted so the code can be found
again.

## 1. Camera (`nfe(...)`, presets `Vc`)

**Presets** (`distance` m behind, `height` m, `lookHeight`, `fovBoost` deg):

| id | distance | height | lookHeight | fovBoost | lag | breathe |
|---|---|---|---|---|---|---|
| chase | 5.8 | 1.85 | 0.95 | 9 | 1 | 0.6 |
| chaseFar | 9.5 | 2.7 | 1.1 | 10 | 1 | 1.2 |
| hood (fixed) | -0.35 | 1.36 | 1.05 | 16 | 0 | |
| bumper (fixed) | -2.7 | 0.62 | 0.6 | 18 | 0 | |

Base FOV 62 (desktop), 72 on phones, 68 on "lite" phones.

**Smoothing primitive** everywhere: `rr(a, b, k, dt) = lerp(a, b, 1 - exp(-k dt))`, i.e. the
framerate-independent form of `a.lerp(b, k*dt)`. No spring/inertia anywhere: every channel is a
first-order exponential chase, each with its own rate.

Per frame, with `J = |speed|` (m/s), `Q = clamp(J/55, 0, 1)`, `j = smoothstep(J, 20, 70)`:
- **Yaw** (world-space angle `c`, not a position lerp): target = car heading, plus at > 3 m/s a
  drift offset `clamp(slipAngle, -0.9, 0.9) * 0.55 * (1 - 0.7 j)` (camera swings to show the drift
  angle, less at speed). Rate `4.5 + 2.5 smoothstep(J, 5, 30) - 3.8 j` 1/s: ~7 at city speed,
  ~3.2 at 250 km/h (lazier at speed = calmer image). Look-back: target + pi at rate 30.
- **Distance/height "breathe"**: distance -> `preset + Q * breathe` (+0.6 m at 200 km/h), height
  `+ Q * 0.15`, both at rate 3.
- **Longitudinal-G lag**: offset along the camera's back axis `clamp(-longG * 0.55, -0.6, 0.8)` m,
  rate 3.5 (same idea as our acceleration-driven spring, but first-order and from G not accel).
- **Position**: horizontal offset from the car chased at rate 18 (nearly rigid, so it never trails
  with speed: the "behind" distance is defined in car-relative terms, like ours), height chased at
  `10 - 5 j`. Wall avoidance: ray from car+1.3 m up to the camera, `max(0.12, (toi - 0.35)/len)`.
- **Look target**: `2.2 + 3 Q` m ahead along the camera yaw at `lookHeight`, chased at rate 14
  horizontally, `8 - 4 j` vertically.
- **Shake**: one scalar `p` (impacts call `addShake(x)`, capped 1.5, decays at rate 5) plus nitro
  `x`: `V = p*0.06 + nitro*0.0035` rad, then
  `rotateX((sin(37.1t)+sin(23.7t)) V/2)`, `rotateY((sin(31.3t)+sin(17.9t)) V*0.35)`,
  `rotateZ(sin(29.3t) V*0.4)` (t = seconds; the factors are rad/s, so 2.8-5.9 Hz: already
  low-frequency). Rotation only, never position. Nitro: ~0.2 deg; impacts up to ~5 deg.
- **FOV**: `base + fovBoost * Q^2 + nitro * 9`, chased at rate 2.5. Quadratic in speed: nothing
  in town, the full +9 deg only near 200 km/h. Nitro adds +9 with attack rate 6 / release 2.5.
- Mouse/stick orbit offsets return to 0 at rate 3 after 1.4 s idle.

## 2. Performance

**Pixel ratio / resolution** (`ve` profile, `D0e` adaptive controller, `M0e` fps sampler):
- `maxPixelRatio` 1.5 desktop ultra, 1.25 medium, 1 low; renderer pixel ratio =
  `min(devicePixelRatio, maxPixelRatio)`. Desktop renders the 3D at `renderScale` 0.85 and
  upscales (Catmull-Rom or FSR-EASU style "fsr" pass, sharpness 0.2).
- Adaptive controller: fps counted over **1 s windows**; `targetFps 50`; fps below target in
  **2 consecutive windows** -> step down, then **ignore 3 windows** (settle). A step down first
  lowers the whole QUALITY PRESET (ultra -> medium -> low: AO off, FXAA, bloom at 0.5 res,
  fewer particles, shorter draw distance, smaller shadow map) and only as a last resort drops
  DPR to 0.9 and locks. **It never steps up.** Sampling is gated (`getAllowAdaptiveSample`) so
  menus, the intro and loading do not count. Phones: adaptive DPR off, a fixed phone budget.
- Bloom at 0.7 resolution (0.35-0.5 on phones), AO at 0.5, ground reflection at 0.5, lens rain at
  0.5: every expensive pass has its own resolution scale.

**Draw calls / instancing / culling / LOD** (`np(...)`, `Hre(...)`):
- The whole city is placed from a compact placement array (asset id, x, y, z, yaw, scale) into
  **InstancedMesh per asset per LOD level** (instance matrices in a storage buffer on WebGPU,
  `frustumCulled = false`, `count` rewritten every update). Cells of 160-240 m: cell AABB vs
  distance and frustum first, then per-instance sphere test.
- **3 LOD levels** by distance: buildings 60/180 m, towers 180/520 m, signs 35/110 m, all times
  `cityLodScale` (0.8 low, 0.55 phone); draw distance 1300 m (1000 low, 600 phone).
- **CPU software occlusion culling**: a 256x128 depth buffer (160x80 on phones) is rasterized on
  the CPU from simplified occluder boxes within 260 m; instance AABBs behind it are skipped.
- Signs far away become **impostors** (a 256 px atlas, one instanced quad each). Collision uses
  one instanced box proxy mesh.

**Shadows**: one directional sun, `shadowMap.autoUpdate = false`; a follow-camera shadow frustum
(extent 90 m, 70 phone) centred 0.55*extent ahead of the camera, **snapped to whole shadow texels**
(no shimmering), re-rendered every `followShadowFrameSkip` frames (1 ultra, 2 low/phone).
Map 4096 ultra, 2048 medium/low, 1024 phone. City instances `castShadow = false`.

**Other**: car reflection cube probe 64 px, ONE face per frame, every 3rd frame (every frame when
fast); KTX2/Basis textures with a per-profile max size; a shader warm-up that renders a few frames
of every effect behind the loading screen; camera far 2800 (700 phone) with fog scaled to match.

**Physics stepping** (`zhe(...)`): Rapier at **120 Hz**, accumulator `+= min(frameDt, 0.1)`, at
most **8 steps per frame**, accumulator dropped when it would spiral; returns `acc/dt` as the
render interpolation alpha. 4 solver iterations.

## 3. What applies to us

| Idea | Status for us |
|---|---|
| `1 - exp(-k dt)` smoothing everywhere | We already use it for heading/FOV; the user's `lerp(target, dt*k)` is now written this way |
| Car-relative offset (no speed trailing) | Same conclusion as ours (we use a 2nd-order spring; kept) |
| Quadratic speed FOV + separate boost channel with fast attack / slow release | **Adopted**: throttle FOV punch (+5 deg, ~1 s in, slower out) on top of the speed FOV, total capped |
| Rotation-only, low-frequency shake from one decaying scalar | **Adopted** for redline shake, but lower (3-7 Hz, smoothed noise, <= 0.15 deg) because we run at ~30 fps |
| Adaptive quality: 2 confirm windows + settle windows, gated during loading | **Adopted** in the new 2 s average-fps monitor (2 windows to act, pause after each resize) |
| Never step up | We allow step-ups but rate-limited (>= 10 s apart, 2 good windows, never above max) |
| Lower QUALITY before resolution (bloom/AO res, AA) | Not yet: our post has only high/low; a "drop to low post before dropping scale" step is the next win |
| Per-pass resolution scales (bloom 0.5-0.7) | Not yet: worth checking in post.ts (bloom is full-res today) |
| Shadow map updated every N frames, texel-snapped follow frustum | Not yet: our only shadow is the car headlight spot (1024); could update every 2nd frame |
| Instanced city with LOD + cell culling + CPU occlusion | Not applicable yet: our city is one glTF; would need the Blender export to emit placements |
| 120 Hz physics, max 8 steps | We keep 240 Hz (the core's tyre model is tuned for it), max 24 steps |
| 64 px reflection probe, one face per frame | Not applicable: our env map is captured once |
| Render 3D at 0.85 + upscale pass | Equivalent to our pixel-ratio scale; an FSR/Catmull upscale would look sharper than the browser's bilinear canvas stretch |
