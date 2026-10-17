// Driver assists that act inside the vehicle (they need per-wheel slip at the sub-step rate).
// They sit ON TOP of the physical model: they only modulate the driver's pedals and add brake
// torque, exactly like real ABS/TC/ESC controllers acting on hydraulics and engine management.
// All are off by default.
#pragma once
#include <array>

namespace rs {

struct AssistSettings {
    bool abs = false;                 // anti-lock brakes
    bool tc = false;                  // traction control
    bool esc = false;                 // electronic stability control
    double abs_slip_target = 0.10;    // |kappa| to hold under braking (~ tyre peak)
    double abs_gain = 30.0;           // pressure change per second per unit slip error
    double tc_slip_target = 0.10;     // driven-wheel kappa to hold under power
    double tc_gain = 14.0;            // torque cut per unit slip above target
    double esc_understeer_gradient = 0.0028;   // s^2/m, reference model K_us (~1.6 deg/g)
    double esc_yaw_deadband = 0.06;   // rad/s before intervening
    double esc_gain = 6000.0;         // N m brake per rad/s of yaw error
    double esc_max_brake = 2500.0;    // N m per wheel
    double esc_sideslip_limit = 0.12; // rad: beyond this the car is sliding, act as oversteer
};

struct AssistStatus {
    std::array<bool, 4> abs_active{};       // brake pressure currently reduced on that wheel
    std::array<double, 4> abs_pressure{1, 1, 1, 1};   // 0..1 fraction of driver brake pressure
    double tc_cut = 0;                      // 0..1 engine torque reduction
    std::array<double, 4> esc_brake{};      // N m added per wheel
    int esc_mode = 0;                       // +1 oversteer correction, -1 understeer, 0 none
    double yaw_rate = 0, yaw_rate_ref = 0;  // rad/s, measured and reference
};

}  // namespace rs
