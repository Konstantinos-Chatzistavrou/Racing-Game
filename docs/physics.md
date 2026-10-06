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
