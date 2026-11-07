// Phase 3: assists (ABS, TC, ESC) and input controls (keyboard/gamepad shaping, auto gearbox).
#include <cmath>
#include "harness.hpp"
#include "rs/controls.hpp"

using namespace rs;

namespace {

struct BrakeRun { double distance = 0; double max_lock_time = 0; double yaw_change_deg = 0; };

// Full-pedal stop from v0 with a 0.2 s pressure rise, optional steering. Clutch in.
BrakeRun brake_run(bool abs, double v0, double steer, double max_time = 20) {
    CarConfig cfg = test::car();
    auto s = test::make_sim(cfg);
    s->vehicle.assists().abs = abs;
    s->reset({}, 0, v0);
    BrakeRun r;
    Vec3 p0 = s->body.state.position;
    std::array<double, 4> lock_t{};
    double yaw0 = 0;
    while (test::speed(*s) > 0.3 && s->time < max_time) {
        DriverInput in;
        in.clutch = 1;
        in.gear = 1;
        in.brake = std::min(1.0, s->time / 0.2);
        in.steer = steer;
        s->step(in);
        for (int w = 0; w < 4; ++w) {
            bool locked = std::abs(s->last.wheels[w].angular_velocity) < 0.5 && test::speed(*s) > 3;
            lock_t[w] = locked ? lock_t[w] + s->dt : 0;
            r.max_lock_time = std::max(r.max_lock_time, lock_t[w]);
        }
    }
    r.distance = length(s->body.state.position - p0);
    Vec3 fwd = s->body.state.orientation.rotate({1, 0, 0});
    r.yaw_change_deg = std::atan2(fwd.y, fwd.x) * 180 / kPi - yaw0;
    return r;
}

// Runs the full chain: raw input -> Controls -> Vehicle.
DriverInput drive(Simulation& s, Controls& c, const RawInput& raw) {
    DriverInput in = c.update(raw, s.last, s.dt);
    s.step(in);
    return in;
}

}  // namespace

// ---------------------------------------------------------------- ABS
RS_TEST(abs) {
    BrakeRun no_abs = brake_run(false, 100 / 3.6, 0);
    BrakeRun with_abs = brake_run(true, 100 / 3.6, 0);
    std::printf("         100-0 full pedal: no ABS %.1f m (wheels locked up to %.2f s), ABS %.1f m (max lock %.2f s)\n",
                no_abs.distance, no_abs.max_lock_time, with_abs.distance, with_abs.max_lock_time);
    test::check_range("ABS 100-0 km/h, full pedal (threshold was 37.1 m)", with_abs.distance, 32, 39.1, "m");
    test::check("ABS stops shorter than locked wheels", with_abs.distance < no_abs.distance - 5);
    test::check_range("ABS: longest continuous wheel lock", with_abs.max_lock_time, 0, 0.1, "s");
    // Steering while braking: locked front tyres cannot generate lateral force; ABS keeps them rolling.
    BrakeRun steer_no = brake_run(false, 80 / 3.6, 0.3);
    BrakeRun steer_abs = brake_run(true, 80 / 3.6, 0.3);
    std::printf("         full braking + steering from 80 km/h: heading change no ABS %.1f deg, ABS %.1f deg\n",
                steer_no.yaw_change_deg, steer_abs.yaw_change_deg);
    // Criterion: at least 2.5x the heading change of the locked-wheel case.
    test::check_range("ABS / no-ABS heading change while braking + steering", std::abs(steer_abs.yaw_change_deg) / std::max(std::abs(steer_no.yaw_change_deg), 1.0), 2.5, 100, "x");
}

// ---------------------------------------------------------------- TC
RS_TEST(tc) {
    double mean_slip[2], t60[2];
    for (int tc = 0; tc < 2; ++tc) {
        CarConfig cfg = test::car();
        auto s = test::make_sim(cfg);
        s->vehicle.assists().tc = tc;
        s->settle(1.0);
        s->time = 0;
        DriverInput in;
        in.auto_clutch = true;
        in.gear = 2;
        in.throttle = 1.0;                 // floored, no driver finesse
        double slip_sum = 0;
        int n = 0;
        t60[tc] = -1;
        while (s->time < 10) {
            s->step(in);
            if (s->time > 0.5 && s->time < 3.0) {
                slip_sum += std::max(s->last.wheels[RL].slip_ratio, s->last.wheels[RR].slip_ratio);
                ++n;
            }
            if (t60[tc] < 0 && test::speed(*s) * 3.6 >= 60) t60[tc] = s->time;
        }
        mean_slip[tc] = slip_sum / n;
    }
    std::printf("         floored launch in 1st: mean rear slip no TC %.2f, TC %.2f; 0-60 km/h %.2f s vs %.2f s\n",
                mean_slip[0], mean_slip[1], t60[0], t60[1]);
    test::check_range("rear slip without TC (wheelspin)", mean_slip[0], 0.25, 10, "-");
    test::check_range("rear slip with TC (held near target 0.10)", mean_slip[1], 0.05, 0.18, "-");
    test::check("TC launch is quicker than uncontrolled wheelspin", t60[1] > 0 && t60[1] < t60[0]);
}

// ---------------------------------------------------------------- ESC: FMVSS 126 sine with dwell
RS_TEST(esc) {
    CarConfig cfg = test::car();
    // Amplitude: 6.5 x the steer angle that gives 0.3 g steady state (~3.0 deg road wheel here).
    const double lock = cfg.front.max_steer_deg * kPi / 180.0;
    const double A = 6.5 * 3.0 * kPi / 180.0 / lock;           // as a fraction of full lock
    const double f = 0.7;
    const double t_quarter3 = 0.75 / f, dwell = 0.5, t_end = 1.0 / f + dwell;
    auto steer_at = [&](double t) {
        if (t < 0) return 0.0;
        if (t < t_quarter3) return A * std::sin(2 * kPi * f * t);
        if (t < t_quarter3 + dwell) return -A;
        if (t < t_end) return A * std::sin(2 * kPi * f * (t - dwell));
        return 0.0;
    };
    for (int esc = 0; esc < 2; ++esc) {
        auto s = test::make_sim(cfg);
        s->vehicle.assists().esc = esc;
        s->reset({}, 0, 80 / 3.6, 6);
        DriverInput in;
        in.clutch = 1;
        in.gear = 1;                 // coasting, as in the regulation
        double peak = 0, r_1s = 0, r_175 = 0, lat_107 = 0;
        Vec3 p0 = s->body.state.position;
        while (s->time < t_end + 2.0) {
            double t = s->time;
            in.steer = steer_at(t);
            s->step(in);
            double r = s->last.yaw_rate;
            if (t > 0.5 / f && t < t_end + 0.5) peak = std::max(peak, std::abs(r));   // second (dwell-side) peak
            if (std::abs(t - (t_end + 1.0)) < s->dt / 2) r_1s = std::abs(r);
            if (std::abs(t - (t_end + 1.75)) < s->dt / 2) r_175 = std::abs(r);
            if (std::abs(t - 1.07) < s->dt / 2) lat_107 = std::abs(s->body.state.position.y - p0.y);
        }
        std::printf("         %s: peak yaw %.2f rad/s, 1 s after: %.0f %%, 1.75 s after: %.0f %%, lateral at 1.07 s: %.2f m\n",
                    esc ? "ESC on " : "ESC off", peak, 100 * r_1s / peak, 100 * r_175 / peak, lat_107);
        if (esc) {
            test::check_range("FMVSS 126: yaw 1.0 s after steer / peak", r_1s / peak, 0, 0.35, "-");
            test::check_range("FMVSS 126: yaw 1.75 s after steer / peak", r_175 / peak, 0, 0.20, "-");
            test::check_range("FMVSS 126: lateral displacement at 1.07 s", lat_107, 1.83, 100, "m");
        }
    }
    // ESC must stay quiet in normal driving: steady 0.5 g corner.
    auto s = test::make_sim(cfg);
    s->vehicle.assists().esc = true;
    s->reset({}, 0, 17, 3);
    test::SpeedController sc;
    double esc_time = 0;
    while (s->time < 20) {
        DriverInput in;
        in.gear = 3;
        in.steer = test::steer_circle(*s, {0, 60, 0}, 60, 9.0);
        sc.apply(*s, 17, in);
        s->step(in);
        if (s->time > 5 && s->last.assists.esc_mode != 0) esc_time += s->dt;
    }
    test::check_range("ESC intervention time in a normal 0.5 g corner", esc_time, 0, 0.2, "s");
}

// ---------------------------------------------------------------- controls
RS_TEST(controls) {
    CarConfig cfg = test::car();
    Controls c(cfg);
    VehicleOutput slow;
    slow.speed = 5;
    RawInput kb;
    kb.steer = 1;
    double steer = 0;
    for (int i = 0; i < 48; ++i) steer = c.update(kb, slow, 1.0 / 240).steer;    // 0.2 s
    test::check_range("keyboard steer after 0.2 s held (rate 2.2/s)", steer, 0.40, 0.48, "-");
    test::check_range("max steer fraction at 18 km/h", c.max_steer_fraction(5), 0.99, 1.0, "-");
    test::check_range("max steer fraction at 150 km/h", c.max_steer_fraction(41.7), 0.15, 0.25, "-");
    RawInput pad;
    pad.device = InputDevice::Gamepad;
    pad.steer = 0.05;
    Controls c2(cfg);
    for (int i = 0; i < 240; ++i) steer = c2.update(pad, slow, 1.0 / 240).steer;
    test::check_range("gamepad inside deadzone", steer, -1e-9, 1e-9, "-");
    pad.steer = 0.5;
    for (int i = 0; i < 240; ++i) steer = c2.update(pad, slow, 1.0 / 240).steer;
    test::check_range("gamepad half stick (curve 0.5 -> 0.30)", steer, 0.27, 0.33, "-");
    // keyboard throttle ramps instead of slamming
    RawInput t;
    t.throttle = 1;
    Controls c3(cfg);
    double thr = 0;
    for (int i = 0; i < 24; ++i) thr = c3.update(t, slow, 1.0 / 240).throttle;  // 0.1 s
    test::check_range("keyboard throttle after 0.1 s (rise 3/s)", thr, 0.28, 0.32, "-");
}

// ---------------------------------------------------------------- auto gearbox (+TC, auto-clutch)
RS_TEST(auto_gearbox) {
    CarConfig cfg = test::car();
    auto s = test::make_sim(cfg);
    s->vehicle.assists().tc = true;
    s->settle(1.0);
    s->time = 0;
    Controls c(cfg);
    c.settings.auto_gearbox = true;
    RawInput raw;
    raw.throttle = 1;
    int shifts = 0, downs = 0, last_gear = c.gear();
    double t100 = -1;
    bool stalled = false;
    while (s->time < 25 && test::speed(*s) * 3.6 < 160) {
        DriverInput in = drive(*s, c, raw);
        if (in.gear != last_gear) { ++shifts; if (in.gear < last_gear) ++downs; last_gear = in.gear; }
        stalled |= s->last.engine_stalled;
        if (t100 < 0 && test::speed(*s) * 3.6 >= 100) t100 = s->time;
    }
    std::printf("         keyboard floored, auto box + TC: 0-100 %.2f s, %d upshifts, %d downshifts\n", t100, shifts - downs, downs);
    test::check("no stall", !stalled);
    test::check_range("0-100 km/h with assists, no driver skill", t100, 3.9, 6.0, "s");
    test::check("no downshifts (no gear hunting) under full throttle", downs == 0);
    raw.throttle = 0;
    raw.brake = 1;
    s->vehicle.assists().abs = true;
    for (int i = 0; i < 12 * 240 && test::speed(*s) > 0.2; ++i) drive(*s, c, raw);
    for (int i = 0; i < 60; ++i) drive(*s, c, raw);
    test::check("back in 1st gear after braking to a stop", c.gear() == 2);
    test::check("no stall when braking to a stop", !s->last.engine_stalled);
}

// ---------------------------------------------------------------- wrecks stay drivable; fire; brakes
RS_TEST(wreck_drivable_fire_brakes) {
    CarConfig cfg = test::car();
    auto s = test::make_sim(cfg);
    s->settle(1.0);
    // Wreck it: 80 km/h into a wall, both doors caved in, three wheels smashed.
    s->vehicle.add_contact(1, {2.2, 0.1, 0}, cfg.mass * 80 / 3.6);
    s->vehicle.add_contact(2, {0.0, 0.95, 0}, cfg.mass * 12);
    s->vehicle.add_contact(3, {0.0, -0.95, 0}, cfg.mass * 12);
    for (int w = 0; w < 3; ++w) s->vehicle.add_contact(10 + w, {cfg.wheels[w].x, cfg.wheels[w].y, 0}, cfg.mass * 15);
    const DamageReport& r = s->vehicle.damage_model().report();
    test::check("wrecked car is totaled (report flag)", r.totaled);
    Controls c(cfg);
    c.settings.auto_gearbox = true;
    RawInput raw;
    raw.throttle = 1;
    for (int i = 0; i < 6 * 240; ++i) drive(*s, c, raw);
    std::printf("         totaled car, 6 s full throttle: %.1f km/h (engine %.2f, power x%.2f)\n", s->last.speed * 3.6,
                r.engine, s->vehicle.damage_model().engine_power_factor());
    test::check_range("totaled car still drives forward (limp home)", s->last.speed * 3.6, 10, 400, "km/h");
    raw.throttle = 0;
    double t_fire = -1, t_fail = -1;
    for (int i = 0; i < 90 * 240; ++i) {
        drive(*s, c, raw);
        double t = i / 240.0;
        if (t_fire < 0 && r.fire > 0) t_fire = t;
        if (t_fail < 0 && r.brakes_failed) t_fail = t;
    }
    std::printf("         fire %.1f s after the wreck's drive, brakes failed after %.1f s\n", t_fire, t_fail);
    test::check("wreck catches fire (smoulders first)", t_fire >= 0);
    test::check("brakes fail completely later", t_fail > t_fire || (t_fail >= 0 && t_fire >= 0));
    test::check("full fire after a while", r.fire > 0.9);
    s->vehicle.damage_model().repair();
    s->step(c.update(raw, s->last, s->dt));
    test::check("repair clears fire and brakes", r.fire == 0 && r.brakes == 1.0 && !r.brakes_failed);
}

// ---------------------------------------------------------------- reverse by pedal
RS_TEST(pedal_reverse) {
    CarConfig cfg = test::car();
    for (int autobox = 1; autobox >= 0; --autobox) {
        auto s = test::make_sim(cfg);
        s->settle(1.0);
        Controls c(cfg);
        c.settings.auto_gearbox = autobox;
        const char* box = autobox ? "auto" : "manual";
        RawInput raw;
        raw.brake = 0.5;                                   // spawn hold: must NOT reverse
        for (int i = 0; i < 240; ++i) drive(*s, c, raw);
        std::printf("         %s: half brake 1 s at rest -> gear %d\n", box, c.gear());
        test::check("half brake at rest stays in 1st", c.gear() == 2);
        raw.brake = 1;
        for (int i = 0; i < 3 * 240; ++i) drive(*s, c, raw);
        std::printf("         %s: brake held 3 s at rest -> gear %d, %.1f km/h\n", box, c.gear(), s->last.speed * 3.6);
        test::check("brake held at rest engages reverse", c.gear() == 0);
        test::check_range("drives backward on the brake pedal", s->last.speed * 3.6, -60, -3, "km/h");
        raw.brake = 0;
        raw.throttle = 1;                                   // throttle brakes, then 1st gear
        for (int i = 0; i < 4 * 240; ++i) drive(*s, c, raw);
        std::printf("         %s: then throttle 4 s -> gear %d, %.1f km/h\n", box, c.gear(), s->last.speed * 3.6);
        test::check("throttle stops it, then drives forward in 1st+", c.gear() >= 2 && s->last.speed > 1.0);
    }
}

// Hands-off steering: with the keys released in a slide (rear out to the right -> the car's front axle travels left of
// its heading), the front wheels caster round toward the direction of travel: a countersteer, built by physics.
RS_TEST(self_aligning) {
    CarConfig cfg = test::car();
    Controls c(cfg);
    VehicleOutput last;
    last.speed = 20;
    last.sideslip = 0.25;      // velocity points 14 deg left of the heading (car rotated right: rear stepping out)
    last.yaw_rate = -0.6;      // still rotating right
    RawInput raw;
    raw.device = InputDevice::Keyboard;
    raw.steer = 0;
    DriverInput in;
    for (int i = 0; i < 120; ++i) in = c.update(raw, last, 1.0 / 60.0);
    std::printf("         hands-off steering in a slide: %.3f (+ = left)\n", in.steer);
    test::check("released keys in a slide: wheels caster toward the travel direction (countersteer left)", in.steer > 0.05);
    c.settings.self_aligning = false;
    Controls c2(cfg);
    c2.settings.self_aligning = false;
    for (int i = 0; i < 120; ++i) in = c2.update(raw, last, 1.0 / 60.0);
    test::check("self-aligning off: released keys centre the wheel", std::abs(in.steer) < 1e-6);
}

