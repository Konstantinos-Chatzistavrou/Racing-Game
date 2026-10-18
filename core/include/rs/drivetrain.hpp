// Drivetrain: engine -> clutch -> gearbox -> differential(s) -> wheels, plus brakes.
// Integrates the rotating parts (engine and the four wheel spins) for one sub-step.
#pragma once
#include <array>
#include <vector>
#include "rs/config.hpp"

namespace rs {

struct DrivetrainInput {
    double throttle = 0, clutch = 0, brake = 0, handbrake = 0;
    int gear = 1;
    double engine_power_scale = 1.0;            // damage hook
    double brake_power_scale = 1.0;             // damage hook: brake fade / failure (all brakes)
    std::array<double, 4> brake_scale{1, 1, 1, 1};   // ABS: fraction of driver brake pressure
    std::array<double, 4> extra_brake{};             // ESC: added brake torque, N m
};

class Drivetrain {
public:
    explicit Drivetrain(const CarConfig& cfg);

    // tyre_torque[i]: torque the road applies to wheel i about its axle (= -Fx * r), N m.
    // rolling_torque[i]: rolling-resistance torque magnitude, N m (always opposes spin).
    void step(const DrivetrainInput& in, const std::array<double, 4>& tyre_torque,
              const std::array<double, 4>& rolling_torque, double h);

    std::array<double, 4> wheel_omega{};        // rad/s
    double engine_omega = 0;                    // rad/s
    bool stalled = false;
    double engine_rpm() const;
    double engine_torque_full(double rpm) const; // N m at full throttle
    double clutch_torque = 0;                   // last clutch torque (engine -> gearbox), N m

    // Differential tree node: a wheel (leaf) or a differential with two children and a torque
    // split (fraction of input torque to child a). Built once from the layout (rwd/fwd/awd).
    struct Node {
        int wheel = -1;
        int a = -1, b = -1;
        double split = 0.5;
        const DiffParams* diff = nullptr;
    };

private:
    const CarConfig& cfg_;
    std::vector<Node> nodes_;
    int root_ = -1;
    double gear_ratio(int gear) const;
};

}  // namespace rs
