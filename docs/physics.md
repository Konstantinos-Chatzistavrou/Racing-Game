# Physics core: model, equations, decisions

Code: `core/` (C++17, zero engine dependencies). Units SI. World and body frames are right-handed,
Z up. Body frame (ISO 8855): +X forward, +Y left, +Z up, origin at the centre of gravity (CG).

## 1. Integration architecture
- The engine integrates the chassis rigid body (so collisions work) at a fixed physics tick
  (target 240 Hz). Each tick: `wheel_rays()` -> engine raycasts -> `update(chassis, contacts, dt)`
  -> engine applies `force`/`torque` at the CG plus gravity.
- Inside `update()`, the stiff rotating parts (4 wheel spins, engine, clutch, diffs, tyre slip
  states) are sub-stepped at h <= 1 ms (5 sub-steps at 240 Hz) with the chassis velocity frozen.
  Tyre forces are averaged over the sub-steps.
- Headless `Simulation` (tests) integrates the chassis with semi-implicit Euler:
  `v += F/m dt`, Euler's equations in body axes `I dw/dt = tau - w x (I w)`,
  `dq/dt = 1/2 (0, w) q`, then `x += v dt`.
- Verified: braking distance differs by 0.1 % between 240 Hz and 1000 Hz.

## 2. Suspension (per wheel, raycast)
- Ray from the top mount along body -Z, length = spring free length + tyre radius.
- Compression `c = L0 + r - d_hit`. Spring `F = k c`; bump stop `k_bs (c - c_static - travel)`.
- Damper `F = c_bump * dc/dt` (compressing) or `c_rebound * dc/dt` (extending). dc/dt is the
  mount velocity along the suspension axis (no finite differences, so no noise).
- Anti-roll bar `F = k_arb (c_this - c_other)` per axle.
- Tyre load `Fz = F_susp * (up . n)` + geometric transfer (below). Springs only push.
- Static geometry is derived from the data: mounts are placed so the car rests exactly at
  `cg_height` with the static compression `x_s = m g w / (2k)`.
- Simplification: wheels/unsprung mass are massless (no wheel hop). Revisit if kerb behaviour
  needs it.

## 3. Load transfer (emerges, nothing is scripted)
- Longitudinal: tyre forces act at the contact patch -> pitch moment -> springs.
  Theory `dFz_front = m a h / L`. Test: measured/theory = 0.98.
- Lateral: total `sum(Fz y) = -m a_y h`. Split into:
  - elastic part through springs/ARBs: body roll moment `F_y (h - h_rc)` (lateral tyre forces
    are applied to the body at the roll-centre height `h_rc`);
  - geometric part through the links: `dFz = F_y_axle h_rc / track` added to tyre loads (uses
    the previous tick's axle force).
  Test: measured/theory = 1.02.

## 4. Tyres: Pacejka Magic Formula
`y(x) = D sin(C atan(B x - E (B x - atan(B x))))`, slope at origin `BCD`.
- Longitudinal: `D = mu_x (1 + pdx2 dfz) Fz`, `K = kx Fz`, `B = K / (C D)`, `dfz = (Fz - Fz0)/Fz0`.
- Lateral: `D = mu_y (1 + pdy2 dfz) Fz`, cornering stiffness `K = pKy1 Fz0 sin(2 atan(Fz / (pKy2 Fz0)))`.
- Load sensitivity (pdx2, pdy2 < 0): mu falls as load rises -> load transfer costs total grip.
- Combined slip (MF 5.2 weighting): `Fx = Fx0 cos(rCx1 atan(Bxa alpha))`,
  `Bxa = rBx1 cos(atan(rBx2 kappa))`; `Fy = Fy0 cos(rCy1 atan(Byk kappa))`,
  `Byk = rBy1 cos(atan(rBy2 alpha))`.
- Slip with relaxation lengths (first-order transient):
  `d kappa/dt = (w r - v_x - |v_x| kappa) / sigma_x`, `d tanA/dt = (-v_y - |v_x| tanA) / sigma_y`,
  integrated implicitly: `k1 = (k0 + h v_s/sigma) / (1 + h |v_x|/sigma)`. Steady state equals the
  textbook definitions, but it is finite at standstill (no divide by zero).
- Low-speed damping (< 2 m/s, blended out): `F += 2 Fz * v_slip`, capped at mu Fz. Stops the
  relaxation "spring" oscillating when parked. Test: 0.000 m drift in 10 s, holds a 10 % slope.
- Rolling resistance torque `c_rr Fz r`. Surface grip multiplies mu (asphalt 1.0, kerb 0.92, ...).
- Hooks (not simulated yet): `TireCondition` (temperature, wear -> grip_factor), `DamageState`.
- Not modelled yet: aligning moment Mz (needed for force feedback), camber, pressure.

## 5. Drivetrain
- Engine: `T = thr T_full(rpm) - (1 - thr)(c0 + c1 w)` (engine braking = pumping/friction losses).
  Idle controller below idle rpm, fuel-cut rev limiter, stall below ~300 rpm (restart when
  declutched / in neutral).
- Clutch and LSDs are "Coulomb couplings" solved exactly per sub-step. Torque that makes both
  sides equal speed at the end of the step:
  `T_req = (w1 - w2 + h (a1 - a2)) / (h (1/I1 + 1/I2))`. If `|T_req| <= capacity`, apply it
  (locked); else apply `+-capacity` (slipping). Unconditionally stable, no stiff springs.
- Gearbox: total ratio `G = gear * final_drive`; wheel torque `T_clutch G eta`.
- Differential tree (RWD, FWD, AWD = centre diff over front and rear diffs). Open diff with split s:
  `T_a = s T`, `T_b = (1 - s) T`, `w_c = s w_a + (1 - s) w_b`, effective inertia
  `1/I = s^2/I_a + (1-s)^2/I_b`. LSD locking capacity `preload + ramp |T_in|` (power/coast ramps).
- Brakes: total torque x pedal, split by front bias; applied as friction that can stop a wheel
  but never reverse it (clamped impulse) -> clean lock-ups.
- Steering: `delta = input * max_lock`, Ackermann blend `tan(d_in) = L/(R - t/2)`,
  `tan(d_out) = L/(R + t/2)`; compliance steer `d -= c * Fy_axle` (rack/bushing flex).

## 6. Aerodynamics
Drag `F = -1/2 rho CdA |v| v` at the CG. Downforce `1/2 rho ClA v_x^2` split front/rear by
balance, applied at the axles (so it pitches the car).

## 7. Validation (Vela GT data, `core/tests`, all headless)
| check | result | reference / theory |
|---|---|---|
| static axle split | 0.480 | spec 0.48 |
| longitudinal transfer | 0.98 x theory | m a h / L |
| lateral transfer | 1.02 x theory | m a_y h |
| 100-0 km/h, threshold, 0.2 s pressure rise | 37.1 m | ~34 m from full pressure; magazines 33-37 m (ABS) |
| 100-0 km/h, locked (no ABS) | 50.1 m | longer than threshold, as expected |
| lock order | front 0.70 pedal, rear 0.90 | fronts first = stable |
| skidpad max (60 m) | 0.98 g | 0.95-1.1 g for summer-tyre performance cars |
| understeer gradient | 1.57 deg/g (commanded) | road cars understeer, ~1-3 deg/g |
| 0-100 km/h RWD / AWD / FWD | 4.74 / 4.25 / 7.24 s | ~228 W/kg RWD coupes: 4.2-4.8 s |
| 240 Hz vs 1000 Hz | 0.1 % difference | timestep independent |

## 8. Tuning decisions made from tests
- Brake bias 0.67: ideal = F_front,max / (F_front,max + F_rear,max) at full deceleration.
  0.64 locked the rears first (unstable); 0.70 under-used the rears.
- Wider rear tyres (285 vs 245) + 0.12 deg/kN front compliance: with identical tyres the car
  was almost neutral (0.13 deg/g) because cornering stiffness scales with load.

## 9. Assists and controls (Phase 3). All toggleable, all in the core
Order each physics tick: raw device input -> `rs::Controls` -> `rs::Vehicle` (ABS/TC/ESC inside).

**Controls (input side)**
- Keyboard: digital keys become ramps (steer 2.2/s in, 4.0/s back to centre; throttle 3/s up,
  6/s down; brake 5/s up, 8/s down).
- Gamepad: deadzone 0.08, response curve `y = (1-c) x + c x^3` (c = 0.5), 40 ms low-pass.
- Wheel: 1:1, no filtering, no speed scaling.
- Speed-sensitive steering (keyboard/gamepad): full input commands at most
  `delta_max(v) = L mu g / v^2 + 0.10 rad` (Ackermann angle at the grip-limited radius plus
  room for front slip angle), never below 15 % of lock. At 150 km/h: 21 % of lock.
- Countersteer assist: `delta += 0.8 * beta` (sideslip) when sliding.
- Auto gearbox: up at 95 % of redline (on throttle), down below 3200 rpm if the lower gear
  stays under 85 % of redline; 0.6 s / 0.4 s anti-hunting cool-downs; first gear when stopped.
- Auto-clutch: engagement rises with rpm above idle (centrifugal-clutch behaviour).

**Vehicle side**
- ABS: per wheel, integral control on slip, `p += h * 30 * (kappa + 0.10)`, p in [0, 1] scales
  the driver's brake pressure. Runs at the ~1 kHz sub-step rate.
- TC: engine torque cut `clamp((kappa_driven - 0.10) * 14, 0, 1)`, 30 ms filter.
  (Gain 6 left a steady-state slip of 0.19; raised to 14 -> 0.15.)
- ESC: reference yaw rate `r_ref = v delta / (L + K v^2)`, K = 0.0028 s^2/m (matches the car's
  measured 1.57 deg/g), capped at `mu g / v`. Oversteer (|r| > |r_ref| + band, or |beta| > 0.12 rad)
  -> brake the outer front wheel and cut 30 % throttle. Understeer -> brake the inner rear, cut 50 %.

**Validation (headless, `core/tests/test_assists.cpp`)**
| check | result | criterion |
|---|---|---|
| ABS 100-0 km/h full pedal (0.2 s rise) | 37.7 m, no lock > 0 s | <= threshold (37.1) + 2 m; no-ABS 50.1 m |
| ABS steer while braking from 80 km/h | 50.8 deg vs 15.6 deg without | >= 2.5x |
| TC floored launch, mean rear slip | 0.15 (no TC 2.57) | 0.05-0.18 |
| TC 0-60 km/h | 2.90 s (no TC 3.80 s) | faster than wheelspin |
| ESC, FMVSS 126 sine with dwell @80 km/h | yaw 1 s after 0 %, 1.75 s 0 %, lateral 3.92 m | <= 35 %, <= 20 %, >= 1.83 m |
| same manoeuvre, ESC off | 56 % at 1 s | fails the regulation (why ESC matters) |
| ESC in a normal 0.5 g corner | 0 s intervention | <= 0.2 s |
| keyboard floored, auto box + TC | 0-100 4.57 s, 3 upshifts, 0 downshifts | no hunting, no stall |
In Godot (`--autotest`): ABS full pedal from 100 km/h = 33.6 m (fixed 0.78 pedal: 34.4 m).

## 10. Crash damage (Phase 4). `core/src/damage.cpp`
- Energy from impulse: a body of mass m receiving impulse J loses kinetic energy `E = J^2 / (2 m)`
  (exact for a full stop against a rigid wall). Godot reports per-tick contact impulses; they are
  accumulated per crash event (same object, < 0.15 s apart) and damage is charged on the energy
  increment `dE = E(J_acc + j) - E(J_acc)`, minus a 600 N s threshold (~1.5 km/h).
- Pushing is not crashing: per-tick contact force `F = j / dt` below 3 g (`3 m g`) is ignored.
  A car pushing a wall at full throttle is < 1 g; real impacts are tens of g. Test: 10 s of 0.8 g
  pushing -> 0 kJ.
- Zones: front/rear if `|x| > 1.2 |y|` at the impact point (body frame), else left/right.
  `zone += dE / 90 kJ`; front hits also damage the engine (60 %); wheels within 1 m of the impact
  take `(1 - d) dE / 25 kJ`.
- Effects: engine power x(1 - 0.85 engine), drag x(1 + 0.5 mean zone), spring rate x(1 - 0.5 wheel),
  toe-out up to 4 deg per wheel (car pulls), tyre grip x(1 - 0.2 wheel).
- Validation: 50 km/h wall -> 132 kJ (= theory), front zone 1.0, engine power x0.25; 8 km/h bump
  -> 2.6 %; bent front-left wheel -> 19 deg heading drift in 4 s hands-off (intact: 0.00 deg).

## 11. AI street racer (Phase 4). `core/src/ai.cpp`
- Path: pure pursuit to a point `Ld = clamp(3.5 + 0.4 v, 5, 30)` m ahead on the route + lane
  offset; steer `delta = atan(2 L sin(eta) / Ld)`.
- Speed profile: `v = sqrt(a_lat / |k|)`, `a_lat = skill * 0.82 * mu g * width_factor`
  (width_factor 0.7 in a 4.6 m alley .. 1.0 on >= 8 m roads), braking pass `a = 0.85 skill mu g`,
  power-limited acceleration pass `a = min(0.8 g, P / (m v))`.
- Traffic, judged in ROUTE space (works through 90-degree junctions): a car is "ahead" if it is
  further along the route, on the road near that point, and either in our lane or where the road
  is too narrow for two cars (lanes merge: the rear car yields).
- Reaction time: perceptions are queued and used `reaction_time` later.
- Emergency braking compares stopping distances: room = `gap + v_lead^2 / (2 a_lead) - 2 m`
  (a_lead estimated from the delayed perceived speeds), needed `a = v^2 / (2 room)`; above
  `2 + 4 aggression` m/s^2 -> full brake; swerve if the road has room.
- Validation: careful follower (0.4 s, 0.6 s headway) stops 3.5 m behind a car braking from
  90 km/h; aggressive follower (0.8 s, 0.15 s headway) on a single lane hits it at 41 km/h.
- Recovery: stuck 2 s with throttle -> 1.6 s reverse. Race rule (core RaceTracker): upside down
  3 s or < 1 km/h for 10 s -> respawn 15 m back on the route, damage kept.

## MF 6.1 completion, tyre thermals, brake thermals (2026-11-07)

- **Friction vs. sliding speed** (MF 6.1 LMUV): lambda_mu* = lambda_mu (1 + LMUV V_ref/V0) / (1 + LMUV Vs/V0), Vs = |contact
  patch slip velocity|, V0 = 16.7 m/s, LMUV = 0.12, V_ref = 1.5 m/s (the sliding speed the coefficients were fitted at, so
  ordinary cornering is unchanged). Fy at 25 m/s sliding = 0.85 of the 1.5 m/s value. Locked-wheel 100-0: 51.9 m vs 35.4 m
  threshold braking.
- **Inflation pressure** (MF 6.1, Pacejka 3rd ed. Table 4.2 passenger tyre): Kx * (1 + PPX1 dpi + PPX2 dpi^2),
  mu_x * (1 + PPX3 dpi + PPX4 dpi^2), Ky: pKy1 (1 + PPY1 dpi), load scale pKy2 (1 + PPY2 dpi), mu_y * (1 + PPY3 dpi + PPY4
  dpi^2). Hot pressure from the gas law: gas temperature = 20 + 0.55 (T_core - 20); 188 kPa cold -> ~223 kPa at 85 C core
  (nominal 220).
- **Two-layer tread temperature**: surface C_s = 1.5 kJ/K (takes all sliding power), core C_c = 16 kJ/K, conduction 400 W/K,
  surface air cooling 20 + 2.5 v W/K, core relaxes to the rolling equilibrium (78 C). 10 s at 25 kW sliding from 30 C:
  surface 94 C, core 53 C. Grip window on 0.65 core + 0.35 surface around 90 C +- 25; surface over 140 C greases.
- **Brake discs**: per wheel, heated by T_brake |w| (a locked wheel heats the tyre, not the disc), cooled by hA = 5 + 1.0 v
  W/K (vented) + radiation eps sigma A (T^4 - Ta^4); cast iron 8.5 / 6 kg front / rear. Pad friction vs. disc temperature:
  0.86 cold, 1.0 at 250-500 C, 0.82 at 700, 0.52 at 900. Six back-to-back ABS stops from 200 km/h: 135, 136, 136, 137,
  160, 202 m; front discs 306 -> 967 C. HUD shows BRAKES HOT / FADING over 620 C.
- Output buffer: [184+i] disc C, [188+i] tread surface C, [192+i] pressure kPa, [196+i] pad mu.

