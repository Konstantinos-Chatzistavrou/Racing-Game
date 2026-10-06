# Godot integration (Phase 2)

## Data flow per physics tick (240 Hz, Jolt)
1. `RSVehicle::_integrate_forces` converts the body state to core axes (`godot_ext/src/axes.hpp`).
2. `rs::Vehicle::wheel_rays()` -> 4 rays cast with `PhysicsDirectSpaceState3D::intersect_ray`
   (car excluded). Surface = collider meta `surface` -> index in the car's `surface_grip`.
3. `rs::Vehicle::update()` -> force and torque at the CG -> `apply_central_force/apply_torque`.
   Godot adds gravity and integrates (so walls and car-to-car collisions work).
4. `_process` places the wheel meshes (suspension position, steer, spin).

## Axis mapping (single implementation: axes.hpp)
World: core Z-up -> Godot Y-up: `godot = (x, z, -y)` (same as the Blender glTF exporter).
Body: core (x fwd, y left, z up) -> Godot local (X left, Y up, Z fwd).
Godot basis `B = M_world * R_core * M_body^T`. Both maps are proper rotations (det +1), so torques
and angular velocities convert like vectors.

## Rigid body set-up
Origin = CG (model offset from `cg_in_model_m`), custom centre of mass (0,0,0),
inertia (X, Y, Z) = (pitch, yaw, roll) from the car JSON, damping replaced with 0, no sleeping.

## Verification (`--autotest`, same car JSON as the headless tests)
| check | Godot | headless core |
|---|---|---|
| CG height at rest | 0.4700 m | 0.47 |
| front load fraction | 0.4800 | 0.480 |
| sum of loads | 14.22 kN | m g = 14.22 kN |
| 0-100 km/h (auto-clutch launch) | 4.91 s | 4.74 s (manual clutch launch driver) |
| 100-0 km/h, 0.78 pedal | 34.4 m | ~34 m from full pressure |
| steady circle 62 km/h | 0.58 g, upright | |

## Assists so far
Auto-clutch (core, `DriverInput.auto_clutch`): engagement rises with rpm above idle (centrifugal
clutch behaviour), declutch + throttle lift for 0.12 s on gear change. Phase 3 adds the rest.
