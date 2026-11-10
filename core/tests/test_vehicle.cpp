// Whole-car tests against physics theory and real-car reference figures.
#include <cmath>
#include <vector>
#include "harness.hpp"

using namespace rs;

namespace {

double axle_load(const VehicleOutput& o, bool front) {
    return front ? o.wheels[FL].load + o.wheels[FR].load : o.wheels[RL].load + o.wheels[RR].load;
}

// Braking from v0 to (almost) standstill in a straight line, clutch in. Returns metres.
double brake_distance(const CarConfig& cfg, double v0, double pedal, double dt, bool* locked = nullptr) {
    auto s = test::make_sim(cfg, dt);
    s->reset({}, 0, v0);
    DriverInput in;
    in.clutch = 1;
    in.gear = 1;
    double x0 = s->body.state.position.x;
    bool any_lock = false;
    while (test::speed(*s) > 0.3 && s->time < 20) {
        in.brake = pedal * std::min(1.0, s->time / 0.2);   // pressure rises over ~0.2 s
        s->step(in);
        for (int w = 0; w < 4; ++w)
            if (std::abs(s->last.wheels[w].angular_velocity) < 0.5 && test::speed(*s) > 3) any_lock = true;
    }
    if (locked) *locked = any_lock;
    return s->body.state.position.x - x0;
}

}  // namespace

// ---------------------------------------------------------------- static
RS_TEST(static) {
    CarConfig cfg = test::car();
    auto s = test::make_sim(cfg);
    s->settle(3.0);
    double total = 0;
    for (auto& w : s->last.wheels) total += w.load;
    test::check_range("sum of wheel loads / (m g)", total / (cfg.mass * kGravity), 0.99, 1.01, "-");
    test::check_range("front axle load fraction (spec 0.48)", axle_load(s->last, true) / total, 0.475, 0.485, "-");
    test::check_range("CG height at rest (spec 0.47)", s->body.state.position.z, 0.46, 0.48, "m");
    // Parked in neutral, no brakes: must not creep (low-speed tyre model stability).
    DriverInput none;
    Vec3 p0 = s->body.state.position;
    for (int i = 0; i < 10 * 240; ++i) s->step(none);
    test::check_range("drift over 10 s parked on flat ground", length(s->body.state.position - p0), 0, 0.01, "m");
    // 10 % slope (5.7 deg): brakes held -> stays; brakes off in neutral -> rolls away.
    double a = std::atan(0.10);
    Vec3 n{-std::sin(a), 0, std::cos(a)};      // slope rising toward +X
    for (int hold = 1; hold >= 0; --hold) {
        auto h = test::make_sim(cfg, 1.0 / 240.0, n);
        h->reset();
        h->body.state.position.z = cfg.cg_height + 0.0;
        h->body.state.orientation = Quat::from_axis_angle({0, 1, 0}, -a);
        DriverInput in;
        in.brake = hold ? 1.0 : 0.0;
        for (int i = 0; i < 240; ++i) h->step(in);                 // settle onto the slope
        Vec3 q0 = h->body.state.position;
        for (int i = 0; i < 5 * 240; ++i) h->step(in);
        double moved = length(h->body.state.position - q0);
        if (hold) test::check_range("10% slope, brakes on: movement in 5 s", moved, 0, 0.02, "m");
        else test::check_range("10% slope, brakes off: rolls back (5 s)", moved, 1.0, 1000, "m");
    }
}

// ---------------------------------------------------------------- weight transfer
// Longitudinal:  dFz_front = m a h / L                      (moment balance about the rear contact)
// Lateral:       sum over wheels of Fz * y = - m a_y h      (moment balance about the centre line)
RS_TEST(weight_transfer) {
    CarConfig cfg = test::car();
    {
        auto s = test::make_sim(cfg);
        s->reset({}, 0, 22.0);
        DriverInput in;
        in.clutch = 1;
        in.brake = 0.4;
        double static_front = cfg.mass * kGravity * cfg.weight_front;
        double sum_meas = 0, sum_theory = 0;
        int n = 0;
        while (s->time < 1.6) {
            s->step(in);
            if (s->time > 0.8) {      // pitch motion settled
                double ax = s->accel_body().x;   // negative under braking
                double v = test::speed(*s);
                double aero_front = 0.5 * cfg.aero.air_density * cfg.aero.lift_area * v * v * cfg.aero.front_balance;
                sum_meas += axle_load(s->last, true) - static_front - aero_front;
                sum_theory += cfg.mass * (-ax) * cfg.cg_height / cfg.wheelbase;
                ++n;
            }
        }
        std::printf("         braking: dFz_front measured %.0f N, theory %.0f N\n", sum_meas / n, sum_theory / n);
        test::check_range("longitudinal transfer measured/theory", sum_meas / sum_theory, 0.9, 1.1, "-");
    }
    {
        // Steady cornering on a 60 m circle at 17 m/s (~0.5 g).
        auto s = test::make_sim(cfg);
        double R = 60, v = 17;
        s->reset({}, 0, v, 3);
        test::SpeedController sc;
        double sum_meas = 0, sum_theory = 0, sum_ay = 0;
        int n = 0;
        while (s->time < 25) {
            DriverInput in;
            in.gear = 3;
            in.steer = test::steer_circle(*s, {0, R, 0}, R, 9.0);
            sc.apply(*s, v, in);
            s->step(in);
            if (s->time > 15) {
                double m = 0;
                for (int w = 0; w < 4; ++w) {
                    Vec3 rel = s->body.state.orientation.inv_rotate(s->last.wheels[w].centre_world - s->body.state.position);
                    m += s->last.wheels[w].load * rel.y;
                }
                double ay = s->accel_body().y;
                sum_meas += -m;
                sum_theory += cfg.mass * ay * cfg.cg_height;
                sum_ay += ay;
                ++n;
            }
        }
        std::printf("         cornering at %.2f g: roll moment from loads %.0f N m, m a_y h = %.0f N m\n",
                    sum_ay / n / kGravity, sum_meas / n, sum_theory / n);
        test::check_range("lateral transfer measured/theory", sum_meas / sum_theory, 0.9, 1.1, "-");
    }
}

// ---------------------------------------------------------------- braking
// Reference: road-legal performance cars on summer tyres stop from 100 km/h in ~33-37 m
// (needs mu_eff ~1.1-1.2: d = v^2 / (2 mu g) = 27.8^2 / (2 * 1.15 * 9.81) = 34 m).
RS_TEST(braking) {
    CarConfig cfg = test::car();
    const double v0 = 100 / 3.6;
    double best = 1e9, best_p = 0;
    for (double p = 0.40; p <= 1.001; p += 0.02) {
        double d = brake_distance(cfg, v0, p, 1.0 / 240.0);
        if (d < best) { best = d; best_p = p; }
    }
    bool locked = false;
    double full = brake_distance(cfg, v0, 1.0, 1.0 / 240.0, &locked);
    std::printf("         threshold pedal %.2f -> %.2f m; full pedal (no ABS) -> %.2f m\n", best_p, best, full);
    test::check_range("100-0 km/h, threshold braking", best, 32, 38, "m");
    test::check("full pedal locks wheels (no ABS yet)", locked);
    test::check_range("100-0 km/h, locked wheels (longer)", full, best + 1.0, 55, "m");
    // Front wheels must lock before the rears (stable). Find the lowest locking pedal per axle.
    double lock_f = 2, lock_r = 2;
    for (double p = 0.5; p <= 1.001; p += 0.01) {
        auto s = test::make_sim(cfg);
        s->reset({}, 0, v0);
        DriverInput in;
        in.clutch = 1;
        in.brake = p;
        for (int i = 0; i < 240; ++i) {
            s->step(in);
            if (std::abs(s->last.wheels[FL].angular_velocity) < 1 && lock_f > 1) lock_f = p;
            if (std::abs(s->last.wheels[RL].angular_velocity) < 1 && lock_r > 1) lock_r = p;
        }
    }
    std::printf("         lowest locking pedal: front %.2f, rear %.2f\n", lock_f, lock_r);
    test::check("fronts lock before rears (stable brake bias)", lock_f < lock_r);
}

// ---------------------------------------------------------------- anti-dive / anti-squat
// The suspension links carry part of the longitudinal load transfer: the same braking pitches the body less with
// anti-dive / anti-lift, the same launch squats less with anti-squat (the load transfer itself is unchanged).
RS_TEST(anti_pitch) {
    auto pitch_at = [](double anti_scale, double brake, double throttle) {
        CarConfig cfg = test::car();
        cfg.front.anti_pitch *= anti_scale;
        cfg.rear.anti_pitch *= anti_scale;
        cfg.rear.anti_lift_rear_braking *= anti_scale;
        auto s = test::make_sim(cfg);
        s->reset({}, 0, brake > 0 ? 25.0 : 8.0, brake > 0 ? -1 : 2);   // launch: rolling in 1st (gear index 2)
        s->vehicle.assists().abs = true;
        s->vehicle.assists().tc = true;
        DriverInput in;
        in.clutch = brake > 0 ? 1 : 0;
        in.gear = brake > 0 ? 1 : 2;
        for (int i = 0; i < (brake > 0 ? 240 : 120); ++i) { in.brake = brake; in.throttle = throttle; s->step(in); }
        const Vec3 fwd = s->body.state.orientation.rotate({1, 0, 0});
        return std::asin(clamp(fwd.z, -1.0, 1.0)) * 180.0 / kPi;   // + = nose up
    };
    const double dive0 = pitch_at(0, 0.9, 0), dive = pitch_at(1, 0.9, 0);
    const double squat0 = pitch_at(0, 0, 1), squat = pitch_at(1, 0, 1);
    std::printf("         braking pitch: no anti %.2f deg, with %.2f deg | launch pitch: no anti %.2f deg, with %.2f deg\n", dive0, dive, squat0, squat);
    test::check("anti-dive: less nose-down under braking", dive0 < 0 && dive > dive0 && dive < 0);
    test::check("anti-squat: less nose-up on launch", squat0 > 0 && squat < squat0 && squat > 0);
}

// ---------------------------------------------------------------- brake fade
// Eight back-to-back ABS stops from 200 km/h with NO air between them (the worst case: each dumps ~700 kJ into each front
// disc). Sport pads hold to ~700 C, so the first four stops are the same length; after that the pads fade, slowly.
RS_TEST(brake_fade) {
    CarConfig cfg = test::car();
    const double v0 = 200 / 3.6;
    double temp = cfg.brake_thermal.start_temp_c, first = 0, fourth = 0, last = 0;
    for (int k = 0; k < 8; ++k) {
        auto s = test::make_sim(cfg);
        s->reset({}, 0, v0);
        s->vehicle.set_brake_temperature(temp);
        s->vehicle.assists().abs = true;
        DriverInput in;
        in.clutch = 1;
        double x0 = s->body.state.position.x;
        while (test::speed(*s) > 0.3 && s->time < 30) {
            in.brake = std::min(1.0, s->time / 0.2);
            s->step(in);
        }
        double d = s->body.state.position.x - x0;
        temp = 0.5 * (s->last.wheels[FL].brake_temp_c + s->last.wheels[FR].brake_temp_c);
        std::printf("         stop %d: %.1f m, front discs %.0f C, pad mu %.2f\n", k + 1, d, temp, s->last.wheels[FL].brake_mu);
        if (k == 0) first = d;
        if (k == 3) fourth = d;
        last = d;
    }
    test::check_range("200-0 km/h, first stop", first, 100, 150, "m");
    test::check_range("4th stop / 1st stop (no fade yet)", fourth / first, 0.97, 1.03, "x");
    test::check_range("front disc temperature after 8 stops", temp, 800, 1100, "C");
    test::check_range("8th stop / 1st stop (fade)", last / first, 1.08, 2.0, "x");
    // Air cools them: a 650 C disc coasting from 216 km/h for 10 s is back in its working range.
    auto s = test::make_sim(cfg);
    s->reset({}, 0, 60);
    s->vehicle.set_brake_temperature(650);
    DriverInput in;
    in.clutch = 1;
    for (int i = 0; i < 10 * 240; ++i) s->step(in);
    std::printf("         650 C disc, 10 s coasting from 216 km/h: %.0f C at %.0f km/h\n", s->last.wheels[FL].brake_temp_c, test::speed(*s) * 3.6);
    test::check_range("front disc after 10 s of air at speed", s->last.wheels[FL].brake_temp_c, 380, 560, "C");
}

// ---------------------------------------------------------------- cornering
// Reference: performance road cars on summer tyres reach ~0.95-1.1 g on a skidpad.
// Understeer gradient K = d(delta)/d(a_y) > 0 for a road car (stable): the driver must add
// steering beyond the geometric (Ackermann) angle L/R as lateral acceleration rises.
RS_TEST(cornering) {
    CarConfig cfg = test::car();
    const double R = 60;
    auto s = test::make_sim(cfg);
    double v = 10;
    s->reset({}, 0, v, 3);
    test::SpeedController sc;
    std::vector<double> ay_hist;
    double max_ay = 0, steer_at_03 = 0, steer_at_06 = 0;
    double ay_f = 0, steer_f = 0;
    while (s->time < 120) {
        DriverInput in;
        in.gear = 3;
        in.steer = test::steer_circle(*s, {0, R, 0}, R, 10.0);
        sc.apply(*s, v, in);
        s->step(in);
        v += 0.12 * s->dt;                               // slow speed ramp: quasi steady state
        double r_err = std::abs(std::hypot(s->body.state.position.x, s->body.state.position.y - R) - R);
        // 1 s low-pass on lateral acceleration and steer angle
        double k = s->dt / 1.0;
        ay_f += (s->accel_body().y - ay_f) * k;
        // commanded steer angle (what the driver applies; includes compliance in the gradient)
        steer_f += (in.steer * cfg.front.max_steer_deg * kPi / 180.0 - steer_f) * k;
        if (s->time > 5 && r_err < 1.5) max_ay = std::max(max_ay, ay_f);
        if (steer_at_03 == 0 && ay_f > 0.3 * kGravity) steer_at_03 = steer_f;
        if (steer_at_06 == 0 && ay_f > 0.6 * kGravity) steer_at_06 = steer_f;
        if (s->time > 5 && r_err > 5.0) break;           // can no longer hold the circle
    }
    double K = (steer_at_06 - steer_at_03) / 0.3 * 180 / kPi;    // deg per g
    std::printf("         ran out of grip at %.1f m/s (%.0f km/h); steer %.2f deg @0.3g, %.2f deg @0.6g; L/R = %.2f deg\n",
                v, v * 3.6, steer_at_03 * 180 / kPi, steer_at_06 * 180 / kPi, cfg.wheelbase / R * 180 / kPi);
    test::check_range("max steady lateral acceleration (60 m skidpad)", max_ay / kGravity, 0.92, 1.15, "g");
    test::check_range("understeer gradient (front wheel angle)", K, 0.3, 4.0, "deg/g");
}

// ---------------------------------------------------------------- acceleration
// Reference: ~330 kW / 1450 kg RWD coupes (power-to-weight ~228 W/kg) do 0-100 km/h in
// ~4.2-4.8 s with a good launch.
RS_TEST(acceleration) {
    CarConfig cfg = test::car();
    auto s = test::make_sim(cfg);
    s->settle(1.0);
    test::LaunchDriver drv;
    double t100 = -1, t200 = -1;
    bool stalled = false;
    double t0 = s->time;
    while (s->time - t0 < 30) {
        DriverInput in;
        drv.apply(*s, in);
        s->step(in);
        stalled |= s->last.engine_stalled;
        double v = test::speed(*s) * 3.6;
        if (t100 < 0 && v >= 100) t100 = s->time - t0;
        if (t200 < 0 && v >= 200) { t200 = s->time - t0; break; }
    }
    std::printf("         0-100 %.2f s, 0-200 %.2f s, final gear %d\n", t100, t200, drv.gear - 1);
    test::check("engine never stalled", !stalled);
    test::check_range("0-100 km/h", t100, 3.9, 5.2, "s");
    test::check_range("0-200 km/h", t200, 11.0, 18.0, "s");
}

// ---------------------------------------------------------------- timestep independence
RS_TEST(timestep) {
    CarConfig cfg = test::car();
    double d240 = brake_distance(cfg, 25, 0.6, 1.0 / 240.0);
    double d480 = brake_distance(cfg, 25, 0.6, 1.0 / 480.0);
    double d1000 = brake_distance(cfg, 25, 0.6, 1.0 / 1000.0);
    std::printf("         braking distance @240 Hz %.3f m, @480 Hz %.3f m, @1000 Hz %.3f m\n", d240, d480, d1000);
    test::check_range("240 Hz vs 1000 Hz relative difference", std::abs(d240 - d1000) / d1000, 0, 0.02, "-");
    test::check_range("480 Hz vs 1000 Hz relative difference", std::abs(d480 - d1000) / d1000, 0, 0.02, "-");
}

// ---------------------------------------------------------------- drivetrain layouts
// Same car with FWD / RWD / AWD (open front, LSD rear, 40:60 centre diff). Expectations:
// all accelerate without stalling; AWD launches fastest (four driven tyres share the torque);
// FWD is slowest off the line (weight shifts AWAY from the driven front wheels under acceleration).
RS_TEST(layouts) {
    double t[3] = {0, 0, 0};
    const char* names[3] = {"fwd", "rwd", "awd"};
    for (int i = 0; i < 3; ++i) {
        CarConfig cfg = test::car();
        cfg.drivetrain.layout = names[i];
        cfg.front.driven = (i != 1);
        cfg.rear.driven = (i != 0);
        cfg.drivetrain.centre_diff.type = "open";
        auto s = test::make_sim(cfg);
        s->settle(1.0);
        test::LaunchDriver drv;
        double t0 = s->time;
        bool stalled = false;
        while (s->time - t0 < 15) {
            DriverInput in;
            drv.apply(*s, in);
            s->step(in);
            stalled |= s->last.engine_stalled;
            if (test::speed(*s) * 3.6 >= 100) { t[i] = s->time - t0; break; }
        }
        std::printf("         %s: 0-100 km/h %.2f s\n", names[i], t[i]);
        test::check((std::string(names[i]) + " reaches 100 km/h without stalling").c_str(), t[i] > 0 && !stalled);
    }
    test::check("AWD launches faster than RWD", t[2] < t[1]);
    test::check("RWD launches faster than FWD", t[1] < t[0]);
}

// ---------------------------------------------------------------- auto-clutch assist
RS_TEST(auto_clutch) {
    CarConfig cfg = test::car();
    auto s = test::make_sim(cfg);
    s->settle(1.0);
    DriverInput in;
    in.auto_clutch = true;
    in.gear = 2;
    in.throttle = 0.6;                 // keyboard-style: no clutch pedal at all
    bool stalled = false;
    double t50 = -1;
    while (s->time < 12) {
        s->step(in);
        stalled |= s->last.engine_stalled;
        if (test::speed(*s) * 3.6 >= 50) { t50 = s->time; break; }
    }
    test::check("pulls away from standstill with no clutch input", t50 > 0);
    in.throttle = 0;
    in.brake = 0.8;                    // brake to a stop while still in gear
    for (int i = 0; i < 6 * 240; ++i) {
        s->step(in);
        stalled |= s->last.engine_stalled;
    }
    test::check_range("speed after braking in gear", test::speed(*s), 0, 0.3, "m/s");
    test::check("never stalled (launch + stop in gear)", !stalled);
    Quat q = Quat::from_axis_angle({0.3, -0.5, 0.8}, 1.1);
    Quat r = Quat::from_axes(q.rotate({1, 0, 0}), q.rotate({0, 1, 0}), q.rotate({0, 0, 1}));
    test::check("Quat::from_axes round-trips a rotation", length(r.rotate({1, 2, 3}) - q.rotate({1, 2, 3})) < 1e-9);
}
