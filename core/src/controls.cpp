#include "rs/controls.hpp"
#include <cmath>
#include <utility>

namespace rs {

namespace {
double move_toward(double v, double target, double max_step) {
    return std::abs(target - v) <= max_step ? target : v + sign(target - v) * max_step;
}
}  // namespace

Controls::Controls(const CarConfig& cfg) : cfg_(cfg) {}

void Controls::set_gear(int g) {
    int n = (int)cfg_.drivetrain.gear_ratios.size();
    int prev = gear_;
    gear_ = g < 0 ? 0 : (g >= n ? n - 1 : g);
    if (gear_ != 0) pedal_reverse_ = false;
    if (gear_ != prev) reverse_timer_ = 0;
}

double Controls::max_steer_fraction(double v) const {
    if (!settings.speed_sensitive_steering) return 1.0;
    double lock = cfg_.front.max_steer_deg * kPi / 180.0;
    v = std::max(std::abs(v), 1.0);
    double grip_angle = cfg_.wheelbase * settings.steer_mu_estimate * kGravity / (v * v);
    double max_angle = clamp(grip_angle + settings.steer_slip_margin, lock * settings.steer_min_fraction, lock);
    return max_angle / lock;
}

DriverInput Controls::update(const RawInput& raw, const VehicleOutput& last, double dt) {
    const ControlSettings& s = settings;
    DriverInput in;
    const double v = last.speed;

    // ---- steering shaping per device
    double target = clamp(raw.steer, -1.0, 1.0);
    // hands off (keyboard released / stick centred, rolling): the caster, not the centring ramp, moves the wheel (below)
    const bool hands_off = s.self_aligning && raw.device != InputDevice::Wheel && std::abs(target) < 0.08 && v > 3.0;
    if (!hands_off) switch (raw.device) {
        case InputDevice::Keyboard: {
            // Digital key -> ramp. Releasing returns to centre faster than turning in (like a
            // self-centring steering rack); reversing direction passes through centre quickly.
            bool returning = std::abs(target) < 1e-3 || sign(target) != sign(steer_);
            steer_ = move_toward(steer_, target, (returning ? s.kb_steer_return : s.kb_steer_rate) * dt);
            break;
        }
        case InputDevice::Gamepad: {
            // Deadzone, then a curve y = (1-c) x + c x^3 for finer control near centre,
            // then a first-order low-pass filter (time constant tau): y += (x - y) dt / tau.
            double a = std::abs(target);
            a = a < s.pad_deadzone ? 0.0 : (a - s.pad_deadzone) / (1.0 - s.pad_deadzone);
            a = (1 - s.pad_curve) * a + s.pad_curve * a * a * a;
            double shaped = sign(target) * a;
            steer_ += (shaped - steer_) * std::min(1.0, dt / s.pad_smoothing);
            break;
        }
        case InputDevice::Wheel:
            steer_ = target;    // a real wheel is 1:1; no filtering, no speed scaling
            break;
    }
    // ---- hands off (keyboard released / stick centred): caster and aligning torque turn the front wheels toward the
    // direction the front axle is travelling, i.e. zero front slip angle. In a slide that is the countersteer angle:
    //   delta_free = atan2(v_y + r a, v_x)   (front axle velocity in the body frame; a = CG to front axle)
    if (hands_off) {
        const double lock = cfg_.front.max_steer_deg * kPi / 180.0 * max_steer_fraction(v);
        const double vy = std::tan(last.sideslip) * v;
        const double free_angle = std::atan2(vy + last.yaw_rate * cfg_.dist_cg_front, v);
        steer_ = move_toward(steer_, clamp(free_angle / std::max(lock, 1e-3), -1.0, 1.0), s.self_align_rate * dt);
    }
    double steer = steer_;
    if (raw.device != InputDevice::Wheel) steer *= max_steer_fraction(v);

    // ---- countersteer assist: when the rear steps out (sideslip beta), add steering toward the
    // direction of travel, proportional to beta. Driver input still adds on top.
    if (s.countersteer_assist && v > 5.0 && std::abs(last.sideslip) > 0.03) {
        double lock = cfg_.front.max_steer_deg * kPi / 180.0;
        steer += s.countersteer_gain * last.sideslip / lock;
    }
    in.steer = clamp(steer, -1.0, 1.0);

    // ---- pedals
    if (raw.device == InputDevice::Keyboard) {
        throttle_ = move_toward(throttle_, raw.throttle, (raw.throttle > throttle_ ? s.kb_throttle_rise : s.kb_throttle_fall) * dt);
        brake_ = move_toward(brake_, raw.brake, (raw.brake > brake_ ? s.kb_brake_rise : s.kb_brake_fall) * dt);
    } else {
        throttle_ = clamp(raw.throttle, 0.0, 1.0);
        brake_ = clamp(raw.brake, 0.0, 1.0);
    }
    in.throttle = throttle_;
    in.brake = brake_;
    in.clutch = raw.clutch;
    in.handbrake = raw.handbrake;
    in.auto_clutch = s.auto_clutch;

    // ---- gears: manual shift events always work; the automatic gearbox only moves between
    // forward gears. Shift points from engine rpm; a downshift is refused if it would over-rev.
    shift_cooldown_ = std::max(0.0, shift_cooldown_ - dt);
    if (raw.shift_up) set_gear(gear_ + 1);
    if (raw.shift_down) set_gear(gear_ - 1);
    const auto& ratios = cfg_.drivetrain.gear_ratios;
    int top = (int)ratios.size() - 1;
    if (s.auto_gearbox && gear_ >= 2 && shift_cooldown_ <= 0) {
        double rpm = last.engine_rpm;
        if (rpm > s.upshift_rpm_fraction * cfg_.engine.redline_rpm && gear_ < top && throttle_ > 0.1) {
            set_gear(gear_ + 1);
            shift_cooldown_ = 0.6;
        } else if (gear_ > 2 && rpm < s.downshift_rpm) {
            double rpm_after = rpm * ratios[gear_ - 1] / ratios[gear_];
            if (rpm_after < 0.85 * cfg_.engine.redline_rpm) {
                set_gear(gear_ - 1);
                shift_cooldown_ = 0.4;
            }
        }
        if (std::abs(v) < 1.0 && brake_ > 0.2) set_gear(2);   // stopped: back to first
    }
    // ---- reverse by pedal (see ControlSettings): brake held at a standstill -> R, pedals swap;
    // throttle held at a standstill while pedal-reversing -> 1st. Works with either gearbox; an
    // explicit shift into R (manual) keeps the normal pedals.
    if (s.pedal_reverse && !raw.shift_up && !raw.shift_down) {
        const bool stopped = std::abs(v) < s.reverse_speed;
        const double want = pedal_reverse_ ? throttle_ : brake_;   // the pedal that asks to switch
        const double other = pedal_reverse_ ? brake_ : throttle_;
        if (stopped && want > s.reverse_brake && other < 0.05) reverse_timer_ += dt;
        else reverse_timer_ = 0;
        if (reverse_timer_ > s.reverse_delay) {
            bool to_reverse = !pedal_reverse_;
            set_gear(to_reverse ? 0 : 2);
            pedal_reverse_ = to_reverse;
        }
    }
    if (pedal_reverse_) std::swap(in.throttle, in.brake);
    in.gear = gear_;
    return in;
}

}  // namespace rs
