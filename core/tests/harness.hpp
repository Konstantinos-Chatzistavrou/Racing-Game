// Minimal test framework + "test drivers" (controllers that drive the car like a skilled human
// would, so we can measure the car). Driver aids for players are a Phase 3 core feature; these
// controllers exist only in the tests.
#pragma once
#include <cmath>
#include <cstdio>
#include <functional>
#include <map>
#include <memory>
#include <string>
#include "rs/sim.hpp"

namespace test {

struct Registry {
    static std::map<std::string, std::function<void()>>& all() {
        static std::map<std::string, std::function<void()>> m;
        return m;
    }
};
struct Reg {
    Reg(const char* name, std::function<void()> f) { Registry::all()[name] = std::move(f); }
};
#define RS_TEST(name) \
    static void test_##name(); \
    static test::Reg reg_##name(#name, test_##name); \
    static void test_##name()

inline int& failures() { static int f = 0; return f; }

// Records a pass/fail line with the measured value and the accepted range.
inline void check_range(const char* what, double value, double lo, double hi, const char* unit) {
    bool ok = value >= lo && value <= hi;
    std::printf("  [%s] %-46s %10.3f %-6s (expected %.3f .. %.3f)\n", ok ? "PASS" : "FAIL", what, value, unit, lo, hi);
    if (!ok) ++failures();
}
inline void check(const char* what, bool ok) {
    std::printf("  [%s] %s\n", ok ? "PASS" : "FAIL", what);
    if (!ok) ++failures();
}

inline std::string data_path(const std::string& rel) { return std::string(RS_DATA_DIR) + "/" + rel; }
inline rs::CarConfig car() { return rs::load_car_config(data_path("cars/vela_gt.json")); }

inline std::unique_ptr<rs::Simulation> make_sim(const rs::CarConfig& cfg, double dt = 1.0 / 240.0,
                                                rs::Vec3 ground_normal = {0, 0, 1}) {
    auto s = std::make_unique<rs::Simulation>(cfg, std::make_shared<rs::PlaneGround>(ground_normal));
    s->dt = dt;
    return s;
}

inline double speed(const rs::Simulation& s) { return rs::length(s.body.state.velocity); }

// Pure-pursuit steering toward a point `lookahead` metres ahead on a circle (centre c, radius R,
// counter-clockwise). Bicycle-model steer angle: delta = atan(2 L sin(eta) / Ld), eta = angle
// between the car's heading and the line to the target point.
inline double steer_circle(const rs::Simulation& s, rs::Vec3 c, double R, double lookahead) {
    const rs::ChassisState& st = s.body.state;
    double th = std::atan2(st.position.y - c.y, st.position.x - c.x) + lookahead / R;
    rs::Vec3 target{c.x + R * std::cos(th), c.y + R * std::sin(th), st.position.z};
    rs::Vec3 local = st.orientation.inv_rotate(target - st.position);
    double eta = std::atan2(local.y, local.x);
    double L = s.vehicle.config().wheelbase;
    double delta = std::atan(2.0 * L * std::sin(eta) / lookahead);
    return rs::clamp(delta / (s.vehicle.config().front.max_steer_deg * rs::kPi / 180.0), -1.0, 1.0);
}

// PI speed controller: throttle above target error, brake below.
struct SpeedController {
    double integral = 0;
    void apply(const rs::Simulation& s, double target, rs::DriverInput& in) {
        double e = target - rs::dot(s.body.state.velocity, s.body.state.orientation.rotate({1, 0, 0}));
        integral = rs::clamp(integral + e * s.dt, -5.0, 5.0);
        double u = 0.25 * e + 0.08 * integral;
        in.throttle = rs::clamp(u, 0.0, 1.0);
        in.brake = rs::clamp(-u * 0.5, 0.0, 1.0);
    }
};

// Driver that launches and shifts like a competent human with a manual gearbox:
// revs to launch_rpm with the clutch in, releases it over 0.35 s, modulates throttle to keep the
// driven wheels near peak slip (~10 %), shifts up at shift_rpm (clutch in, lift, next gear, 0.15 s).
struct LaunchDriver {
    double launch_rpm = 4500, shift_rpm = 7100;
    double shift_time = 0.15;   // s with the clutch down per upshift (a quick human manual shift: ~0.3-0.4)
    double t = 0, shift_t = -1, clutch = 1.0;
    int gear = 2;
    void apply(rs::Simulation& s, rs::DriverInput& in) {
        t += s.dt;
        in.gear = gear;
        double rpm = s.vehicle.engine_rpm();
        // highest slip among the driven wheels
        const auto& w = s.last.wheels;
        const auto& cfg = s.vehicle.config();
        double slip = 0;
        for (int i = 0; i < 4; ++i)
            if (cfg.axle(i).driven) slip = std::max(slip, w[i].slip_ratio);
        double thr = rs::clamp(1.0 - (slip - 0.10) * 8.0, 0.0, 1.0);
        if (t < 0.5) {                                     // hold revs at the launch rpm
            in.clutch = 1.0;
            in.throttle = rs::clamp((launch_rpm - rpm) / 800.0, 0.0, 1.0);
            return;
        }
        if (clutch > 0.0) {                                // feed the clutch out like a good driver:
            // out over ~0.35 s, pausing while the tyres spin far past their peak; throttle aims at
            // peak slip (~10-12 %) but never lets the revs drop below ~2/3 of the launch rpm (bog)
            if (slip < 0.25) clutch -= s.dt / 0.35;
            clutch = std::max(clutch, 0.0);
            in.clutch = clutch;
            double anti_bog = rpm < 0.67 * launch_rpm ? rs::clamp((0.67 * launch_rpm - rpm) / 600.0, 0.0, 1.0) : 0.0;
            in.throttle = std::max(thr, anti_bog);
            return;
        }
        if (shift_t >= 0) {                                // mid-shift
            shift_t += s.dt;
            in.throttle = 0;
            in.clutch = shift_t < shift_time ? 1.0 : std::max(0.0, 1.0 - (shift_t - shift_time) / 0.08);
            if (shift_t > shift_time + 0.08) shift_t = -1;
            return;
        }
        in.clutch = 0;
        in.throttle = thr;
        int top = (int)s.vehicle.config().drivetrain.gear_ratios.size() - 1;
        if (rpm > std::min(shift_rpm, 0.97 * cfg.engine.redline_rpm) && gear < top) {   // never past this car's redline
            ++gear;
            shift_t = 0;
            in.gear = gear;
        }
    }
};

}  // namespace test
