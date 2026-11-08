// Car measurements the way magazines take them (shared by test_reference and test_characters):
// 0-60 mph / 0-100 / 0-200 km/h with 1 ft rollout, 60-0 mph ABS stop, steady-state circle (any radius), top speed,
// and a step-steer yaw response.
#pragma once
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <utility>
#include <vector>
#include "harness.hpp"

namespace rs::sheet {

inline constexpr double kMph60 = 60 * 0.44704;   // 26.82 m/s
inline constexpr double kFoot = 0.3048;

struct Sheet {
    double t60 = 0, t100 = 0, t200 = 0, brake60 = 0, skidpad_g = 0, vmax_kmh = 0;
};

// Launch timed like a magazine: clock starts when the car has rolled 1 ft (US rollout). The C7 was
// tested with a 7-speed manual, so the test driver shifts like a quick human (0.35 s clutch down),
// not like a robot.
inline void launch(const CarConfig& cfg, Sheet& out) {
    auto s = test::make_sim(cfg);
    s->settle(1.0);
    test::LaunchDriver drv;
    drv.shift_time = 0.35;
    Vec3 p0 = s->body.state.position;
    double t_roll = -1;
    while (s->time < 30) {
        DriverInput in;
        drv.apply(*s, in);
        s->step(in);
        double moved = length(s->body.state.position - p0);
        if (t_roll < 0 && moved >= kFoot) t_roll = s->time;
        double v = test::speed(*s);
        if (std::getenv("RS_DEBUG") && static_cast<int>(s->time * 240) % 24 == 0 && out.t60 == 0)
            std::printf("           t=%.2f v=%.1f gear=%d rpm=%.0f thr=%.2f clutch=%.2f slipRL=%.3f\n", s->time, v * 3.6, drv.gear - 1,
                        s->vehicle.engine_rpm(), in.throttle, in.clutch, s->last.wheels[2].slip_ratio);
        if (t_roll >= 0 && out.t60 == 0 && v >= kMph60) out.t60 = s->time - t_roll;
        if (t_roll >= 0 && out.t100 == 0 && v >= 100 / 3.6) out.t100 = s->time - t_roll;
        if (t_roll >= 0 && out.t200 == 0 && v >= 200 / 3.6) { out.t200 = s->time - t_roll; break; }
    }
}

// Panic stop from 60 mph: full pedal, ABS on (how every road test is done today).
inline double brake_60(const CarConfig& cfg) {
    auto s = test::make_sim(cfg);
    s->vehicle.assists().abs = true;
    s->reset({}, 0, kMph60, 4);
    s->settle(0.3);
    s->body.state.velocity = {kMph60, 0, 0};
    Vec3 p0 = s->body.state.position;
    while (test::speed(*s) > 0.05 && s->time < 20) {
        DriverInput in;
        in.gear = 4;
        in.brake = 1.0;
        in.clutch = 1.0;
        s->step(in);
    }
    return length(s->body.state.position - p0);
}

// Steady-state skidpad: 300 ft DIAMETER circle (radius 45.7 m, the US magazine standard),
// quasi-static speed ramp until the car can no longer hold the circle.
/** The gear that keeps the engine below 82 % of the redline at speed v (forward gears only). */
inline int gear_for(const CarConfig& cfg, double v) {
    const auto& g = cfg.drivetrain.gear_ratios;
    for (int i = 2; i < static_cast<int>(g.size()); ++i)
        if (v / cfg.tire_rear.radius * g[i] * cfg.drivetrain.final_drive * 60 / (2 * kPi) < 0.82 * cfg.engine.redline_rpm) return i;
    return static_cast<int>(g.size()) - 1;
}

// gear < 0: pick the gear for the speed every step (fast circles)
inline double skidpad(const CarConfig& cfg, double R = 150 * kFoot, double v0 = 15, int gear = 3) {
    auto s = test::make_sim(cfg);
    double v = v0;
    s->reset({}, 0, v, gear < 0 ? gear_for(cfg, v) : gear);
    test::SpeedController sc;
    double max_ay = 0, ay_f = 0;
    while (s->time < 240) {
        DriverInput in;
        in.gear = gear < 0 ? gear_for(cfg, test::speed(*s)) : gear;
        in.steer = test::steer_circle(*s, {0, R, 0}, R, 10.0);
        sc.apply(*s, v, in);
        s->step(in);
        v += 0.12 * s->dt;
        double r_err = std::abs(std::hypot(s->body.state.position.x, s->body.state.position.y - R) - R);
        ay_f += (s->accel_body().y - ay_f) * (s->dt / 1.0);
        if (s->time > 5 && r_err < 1.5) max_ay = std::max(max_ay, ay_f);
        if (std::getenv("RS_DEBUG") && std::fmod(s->time, 10.0) < s->dt)
            std::printf("         t=%5.1f target %.1f v %.1f ay %.2f r_err %.2f thr %.2f brk %.2f steer %.3f rpm %.0f\n", s->time, v, test::speed(*s), ay_f, r_err, in.throttle, in.brake, in.steer, s->vehicle.engine_rpm());
        if (s->time > 5 && r_err > 5.0) {
            if (std::getenv("RS_DEBUG"))
                std::printf("         skidpad lost at v=%.1f m/s, ay_f=%.2f, steer=%.3f, rpm=%.0f, t=%.1f\n", test::speed(*s), ay_f, in.steer, s->vehicle.engine_rpm(), s->time);
            break;
        }
    }
    return max_ay / kGravity;
}

// Step steer at 100 km/h (ISO 7401 style): steady straight, then a fixed steering input. Returns the time from the
// step to 90 % of the steady yaw rate (s): how quickly the car answers the wheel. Small input: linear range.
inline double step_steer(const CarConfig& cfg, double steer = 0.035) {
    const double v = 100 / 3.6;
    auto s = test::make_sim(cfg);
    s->reset({}, 0, v, gear_for(cfg, v));
    test::SpeedController sc;
    double t_step = 2.0, r_ss = 0;
    std::vector<std::pair<double, double>> trace;
    while (s->time < t_step + 4.0) {
        DriverInput in;
        in.gear = gear_for(cfg, v);
        sc.apply(*s, v, in);
        in.steer = s->time >= t_step ? steer : 0.0;
        s->step(in);
        if (s->time >= t_step) trace.emplace_back(s->time - t_step, s->last.yaw_rate);
    }
    for (auto& p : trace) if (p.first > 3.0) r_ss += p.second;
    r_ss /= std::max<std::size_t>(1, std::count_if(trace.begin(), trace.end(), [](auto& p) { return p.first > 3.0; }));
    for (auto& p : trace) if (std::abs(p.second) >= 0.9 * std::abs(r_ss)) return p.first;
    return 99;
}

// Full throttle in top gear on an endless straight until the speed stops rising.
inline double top_speed(const CarConfig& cfg) {
    auto s = test::make_sim(cfg);
    int top = static_cast<int>(cfg.drivetrain.gear_ratios.size()) - 1;
    s->reset({}, 0, 60, top);
    double best = 0, t_best = 0;
    while (s->time < 240) {
        DriverInput in;
        in.gear = top;
        in.throttle = 1.0;
        s->step(in);
        double v = test::speed(*s);
        if (v > best + 0.01) { best = v; t_best = s->time; }
        if (s->time - t_best > 10) break;           // no gain for 10 s: terminal speed
    }
    return best * 3.6;
}

inline Sheet measure(const CarConfig& cfg) {
    Sheet sh;
    launch(cfg, sh);
    sh.brake60 = brake_60(cfg);
    sh.skidpad_g = skidpad(cfg);
    sh.vmax_kmh = top_speed(cfg);
    std::printf("         %-16s 0-60 mph %.2f s | 0-100 km/h %.2f s | 0-200 km/h %.2f s | 60-0 mph %.1f m | skidpad %.3f g | top %.0f km/h\n",
                cfg.name.c_str(), sh.t60, sh.t100, sh.t200, sh.brake60, sh.skidpad_g, sh.vmax_kmh);
    return sh;
}
}  // namespace rs::sheet
