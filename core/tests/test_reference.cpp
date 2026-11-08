// Phase 5: the Vela GT against a real car of the same class, measured the way magazines do.
//
// Reference: Chevrolet Corvette C7 Stingray Z51 (2014). Front engine, RWD, 343 kW, ~1496 kg,
// 245/35 R19 front + 285/30 R20 rear summer tyres - the Vela GT's class (341 kW, 1450 kg,
// 245/35 R19 + 285/30 R19). Published figures (sources in docs/handling_reference.md):
//   0-60 mph            3.8 s (GM), 3.9 s (MotorTrend)      US practice: 1 ft rollout excluded
//   60-0 mph            104 ft = 31.7 m (MotorTrend), 107 ft = 32.6 m (GM)
//   skidpad             1.03 g sustained (GM, 300 ft), 1.11 g (MotorTrend)
//   top speed           ~290 km/h (180 mph class)
// Ranges below allow for the Vela being a different car (46 kg lighter, 19" rears, less aero).
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include "harness.hpp"

using namespace rs;

namespace {
constexpr double kMph60 = 60 * 0.44704;   // 26.82 m/s
constexpr double kFoot = 0.3048;

struct Sheet {
    double t60 = 0, t100 = 0, t200 = 0, brake60 = 0, skidpad_g = 0, vmax_kmh = 0;
};

// Launch timed like a magazine: clock starts when the car has rolled 1 ft (US rollout). The C7 was
// tested with a 7-speed manual, so the test driver shifts like a quick human (0.35 s clutch down),
// not like a robot.
void launch(const CarConfig& cfg, Sheet& out) {
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
double brake_60(const CarConfig& cfg) {
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
double skidpad(const CarConfig& cfg) {
    const double R = 150 * kFoot;
    auto s = test::make_sim(cfg);
    double v = 15;
    s->reset({}, 0, v, 3);
    test::SpeedController sc;
    double max_ay = 0, ay_f = 0;
    while (s->time < 240) {
        DriverInput in;
        in.gear = 3;
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

// Full throttle in top gear on an endless straight until the speed stops rising.
double top_speed(const CarConfig& cfg) {
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

Sheet measure(const CarConfig& cfg) {
    Sheet sh;
    launch(cfg, sh);
    sh.brake60 = brake_60(cfg);
    sh.skidpad_g = skidpad(cfg);
    sh.vmax_kmh = top_speed(cfg);
    std::printf("         %-16s 0-60 mph %.2f s | 0-100 km/h %.2f s | 0-200 km/h %.2f s | 60-0 mph %.1f m | skidpad %.3f g | top %.0f km/h\n",
                cfg.name.c_str(), sh.t60, sh.t100, sh.t200, sh.brake60, sh.skidpad_g, sh.vmax_kmh);
    return sh;
}
}  // namespace

RS_TEST(reference) {
    // Vela GT vs Corvette C7 Z51
    Sheet gt = measure(test::car());
    test::check_range("0-60 mph (1 ft rollout)  [C7 Z51 3.8-3.9 s]", gt.t60, 3.6, 4.1, "s");
    test::check_range("60-0 mph, ABS            [C7 Z51 31.7-32.6 m]", gt.brake60, 30.5, 33.5, "m");
    test::check_range("skidpad 300 ft           [C7 Z51 1.03-1.11 g]", gt.skidpad_g, 1.00, 1.10, "g");
    test::check_range("top speed                [C7 Z51 ~290 km/h]", gt.vmax_kmh, 275, 305, "km/h");

    // The track car must stay ahead of the road car: more power, less mass, more downforce. Off the line both are
    // traction-limited (launch technique decides hundredths), so power is checked where it matters: 0-200 km/h.
    Sheet kes = measure(load_car_config(test::data_path("cars/kestrel_gt.json")));
    test::check("0-200 km/h: Kestrel GT quicker than Vela GT", kes.t200 < gt.t200);
    test::check("braking: Kestrel GT shorter than Vela GT", kes.brake60 < gt.brake60);
    test::check("top speed: Vela GT faster (less drag)", gt.vmax_kmh > kes.vmax_kmh);
}
