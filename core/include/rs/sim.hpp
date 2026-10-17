// Headless simulation: a rigid-body integrator + simple ground, so the whole car can be run and
// tested with NO game engine. A game engine replaces this file's role (it integrates the chassis
// and answers the wheel raycasts against real track geometry).
#pragma once
#include <memory>
#include "rs/vehicle.hpp"

namespace rs {

// Answers wheel raycasts. Implement this for any ground representation.
class Ground {
public:
    virtual ~Ground() = default;
    virtual WheelContact raycast(const WheelRay& ray) const = 0;
};

// Infinite plane through the origin with a given (unit) normal: flat or inclined test ground.
class PlaneGround : public Ground {
public:
    explicit PlaneGround(Vec3 normal = {0, 0, 1}, int surface = 0) : n_(normalized(normal)), surface_(surface) {}
    WheelContact raycast(const WheelRay& ray) const override;

private:
    Vec3 n_;
    int surface_;
};

// Rigid body with a diagonal inertia tensor in body axes.
//   linear:  m dv/dt = F
//   angular (Euler's equations, body frame):  I dw/dt = tau - w x (I w)
// Semi-implicit (symplectic) Euler: velocities first, then positions with the new velocities.
struct RigidBody {
    double mass = 1;
    Vec3 inertia{1, 1, 1};   // Ixx, Iyy, Izz (body)
    ChassisState state;
    void integrate(const Vec3& force_world, const Vec3& torque_world, double dt);
};

class Simulation {
public:
    Simulation(const CarConfig& cfg, std::shared_ptr<const Ground> ground);

    // Place the car level at its static ride height, at rest, heading along +X (yaw rad).
    void reset(const Vec3& position_xy = {}, double yaw = 0, double forward_speed = 0, int gear = -1);
    void step(const DriverInput& in);          // advances by dt
    void settle(double seconds);               // run with no input (car settles on its springs)

    double dt = 1.0 / 240.0;
    double time = 0;
    Vehicle vehicle;
    RigidBody body;
    VehicleOutput last;

    // convenience in the BODY frame (x fwd, y left, z up)
    Vec3 velocity_body() const;
    Vec3 accel_body() const { return accel_body_; }

private:
    std::shared_ptr<const Ground> ground_;
    Vec3 accel_body_;
};

}  // namespace rs
