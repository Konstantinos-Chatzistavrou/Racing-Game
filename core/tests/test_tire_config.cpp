// Tyre model sanity + config loading.
#include <cmath>
#include <stdexcept>
#include "harness.hpp"
#include "rs/tire.hpp"

using namespace rs;

RS_TEST(tire) {
    TireParams p = test::car().tire_front;
    const double deg = kPi / 180.0;
    test::check("Fy(0) == 0", std::abs(mf_pure_fy(p, 0, 4000, 1)) < 1e-6);
    test::check("Fy is odd: Fy(-a) == -Fy(a)", std::abs(mf_pure_fy(p, -5 * deg, 4000, 1) + mf_pure_fy(p, 5 * deg, 4000, 1)) < 1e-6);
    // Find the lateral peak: performance road tyres peak at roughly 5-10 degrees of slip.
    double best = 0, best_a = 0;
    for (double a = 0; a < 20; a += 0.05) {
        double f = mf_pure_fy(p, a * deg, 4000, 1);
        if (f > best) { best = f; best_a = a; }
    }
    test::check_range("lateral peak slip angle", best_a, 5, 10, "deg");
    test::check_range("lateral peak mu at Fz0", best / 4000, 1.05, 1.25, "-");
    double kbest = 0, kpk = 0;
    for (double k = 0; k < 0.5; k += 0.002) {
        double f = mf_pure_fx(p, k, 4000, 1);
        if (f > kbest) { kbest = f; kpk = k; }
    }
    test::check_range("longitudinal peak slip ratio", kpk, 0.06, 0.15, "-");
    // Load sensitivity: friction coefficient falls as load rises.
    double mu_lo = mf_pure_fy(p, best_a * deg, 2000, 1) / 2000, mu_hi = mf_pure_fy(p, best_a * deg, 8000, 1) / 8000;
    test::check("load sensitivity: mu(2 kN) > mu(8 kN)", mu_lo > mu_hi);
    // Combined slip: braking while cornering reduces lateral force.
    double fy_pure = magic_formula(p, 0.0, std::tan(4 * deg), 4000, 1).fy;
    double fy_comb = magic_formula(p, -0.08, std::tan(4 * deg), 4000, 1).fy;
    test::check_range("combined: Fy(4 deg, -8% slip) / Fy(4 deg)", fy_comb / fy_pure, 0.2, 0.9, "-");
    // Surface grip scales the peak.
    test::check_range("grass (0.6) peak / asphalt peak", mf_pure_fy(p, best_a * deg, 4000, 0.6) / best, 0.55, 0.65, "-");

    // Pacejka MF 5.2 camber thrust: positive inclination gamma at zero slip angle produces lateral camber thrust.
    double fy_camber = mf_pure_fy(p, 0.0, 4000, 1.0, 2.5 * deg);
    test::check_range("camber thrust Fy(0 deg, +2.5 deg camber)", fy_camber, 80.0, 800.0, "N");
    test::check("camber thrust is antisymmetric at alpha=0",
                std::abs(fy_camber + mf_pure_fy(p, 0.0, 4000, 1.0, -2.5 * deg)) < 1e-6);

    // Pacejka MF 5.2 self-aligning torque Mz & pneumatic trail t:
    // At small positive slip angle (3 deg), pneumatic trail is positive (~20-50 mm) and Mz < 0 (restoring torque).
    // Beyond the lateral force peak (16 deg), pneumatic trail collapses toward zero or reverses.
    TireForces tf_small = magic_formula(p, 0.0, std::tan(3 * deg), 4000, 1.0, 0.0);
    TireForces tf_large = magic_formula(p, 0.0, std::tan(16 * deg), 4000, 1.0, 0.0);
    test::check_range("pneumatic trail at 3 deg slip", tf_small.pneumatic_trail, 0.015, 0.055, "m");
    test::check_range("self-aligning torque Mz at 3 deg slip", tf_small.mz, -220.0, -40.0, "Nm");
    test::check("pneumatic trail collapses at high slip (16 deg)", tf_large.pneumatic_trail < tf_small.pneumatic_trail * 0.4);

    // Effective rolling radius & stretched-string relaxation lengths (Pacejka Ch. 4 & Ch. 7):
    double re_light = effective_rolling_radius(p, 2000), re_heavy = effective_rolling_radius(p, 6000);
    test::check("effective rolling radius shrinks under load", re_heavy < re_light && re_light > p.radius);
    double sx_lo = 0, sy_lo = 0, sx_hi = 0, sy_hi = 0;
    relaxation_lengths(p, 2000, 0.0, sx_lo, sy_lo);
    relaxation_lengths(p, 5000, 0.0, sx_hi, sy_hi);
    test::check("relaxation length grows with load (sigma = K / C_F)", sy_hi > sy_lo && sx_hi > sx_lo);

    // Tire thermodynamics & wear:
    TireCondition cond;
    cond.temperature_c = 30.0; // cold tyre
    double cold_grip = cond.grip_factor();
    for (int i = 0; i < 100; ++i) cond.update(25000.0, 4000.0, 25.0, 0.1);
    test::check("sliding work heats tyre into optimal window", cond.temperature_c > 65.0 && cond.grip_factor() > cold_grip);
}

RS_TEST(config) {
    CarConfig c = test::car();
    test::check("name loaded", c.name == "Vela GT");
    test::check_range("front CG distance a = L (1 - wf)", c.dist_cg_front, 1.377, 1.379, "m");
    bool threw = false;
    std::string msg;
    try {
        parse_car_config(R"({"schema":"car/1","name":"x","chassis":{"mass_kg":1000}})");
    } catch (const std::exception& e) {
        threw = true;
        msg = e.what();
    }
    test::check("missing field throws a readable error", threw && msg.find("cg_height_m") != std::string::npos);
    std::printf("         message: %s\n", msg.c_str());
    threw = false;
    try { parse_car_config(R"({"schema":"car/2"})"); } catch (const std::exception&) { threw = true; }
    test::check("wrong schema version rejected", threw);
}
