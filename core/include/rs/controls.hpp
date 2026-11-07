// Controls: raw device input -> DriverInput for the vehicle.
// Lives in the core so every engine port gets identical feel. Contains the input-side assists:
// keyboard/gamepad shaping, speed-sensitive steering, countersteer assist and automatic gearbox.
#pragma once
#include "rs/config.hpp"
#include "rs/vehicle.hpp"

namespace rs {

enum class InputDevice { Keyboard = 0, Gamepad = 1, Wheel = 2 };

struct RawInput {
    double steer = 0;        // -1 (right) .. +1 (left); keyboard sends -1/0/+1
    double throttle = 0;     // 0..1 (keyboard: 0 or 1)
    double brake = 0;        // 0..1
    double clutch = 0;       // 0..1 (pedal down = 1)
    double handbrake = 0;    // 0..1
    bool shift_up = false;   // edge events: true for ONE update when pressed
    bool shift_down = false;
    InputDevice device = InputDevice::Keyboard;
};

struct ControlSettings {
    bool speed_sensitive_steering = true;
    bool countersteer_assist = false;
    // Hands-off self-alignment (keyboard / gamepad, physical, on by default): with no steering input the front wheels
    // are free to caster toward their own path (rack torque -> 0), the way a loosely held wheel spins into a slide.
    bool self_aligning = true;
    double self_align_rate = 3.0;        // steering units per second (how fast the caster pulls the wheel round)
    bool auto_gearbox = false;
    bool auto_clutch = true;
    // keyboard: digital keys become ramps (units per second)
    double kb_steer_rate = 2.2, kb_steer_return = 4.0;
    double kb_throttle_rise = 3.0, kb_throttle_fall = 6.0;
    double kb_brake_rise = 5.0, kb_brake_fall = 8.0;
    // gamepad
    double pad_deadzone = 0.08;
    double pad_curve = 0.5;          // 0 = linear, 1 = cubic (finer control near centre)
    double pad_smoothing = 0.04;     // s, first-order filter time constant on steering
    // speed-sensitive steering: at speed, full input commands only the angle the tyres can use
    //   delta_max(v) = L mu g / v^2  (Ackermann angle at the grip-limited radius R = v^2/(mu g))
    //                + steer_slip_margin (room for front slip angle)
    double steer_mu_estimate = 1.0;
    double steer_slip_margin = 0.10;     // rad (~5.7 deg)
    double steer_min_fraction = 0.15;    // never below this fraction of full lock
    double countersteer_gain = 0.8;      // rad of steer per rad of sideslip
    double upshift_rpm_fraction = 0.95;  // of redline
    double downshift_rpm = 3200;
    // reverse by pedal (auto AND manual gearbox): hold the brake (> reverse_brake) at a standstill
    // (|v| < reverse_speed) for reverse_delay s -> reverse gear, pedals swap (brake drives backward,
    // throttle brakes). Throttle held at a standstill for reverse_delay -> back to 1st.
    // reverse_brake is above the 0.5 spawn hold (web input.ts) so a parked car never backs away.
    bool pedal_reverse = true;
    double reverse_speed = 0.5;          // m/s
    double reverse_delay = 0.4;          // s
    double reverse_brake = 0.8;
};

class Controls {
public:
    explicit Controls(const CarConfig& cfg);
    // last = previous vehicle output (speed, sideslip, rpm, wheel data). dt = physics tick.
    DriverInput update(const RawInput& raw, const VehicleOutput& last, double dt);
    int gear() const { return gear_; }
    bool pedal_reversing() const { return pedal_reverse_; }   // reverse engaged by the brake pedal
    void set_gear(int g);
    double max_steer_fraction(double speed) const;   // exposed for tests / overlay
    ControlSettings settings;

private:
    const CarConfig& cfg_;
    double steer_ = 0, throttle_ = 0, brake_ = 0;
    int gear_ = 2;
    double shift_cooldown_ = 0;
    bool pedal_reverse_ = false;         // in reverse via the brake pedal (pedals swapped)
    double reverse_timer_ = 0;
};

}  // namespace rs
