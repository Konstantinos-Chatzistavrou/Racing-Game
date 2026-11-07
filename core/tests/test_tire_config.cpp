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
    // Find the lateral peak. The tyre curves come from a fitted 245/40 R18 (data/tires, PAC2002): that tyre peaks at
    // ~10.9 deg / slip ratio ~0.15 (measured road tyres: ~8-12 deg; race slicks lower). Grip and stiffness are scaled
    // together per car (tools/tir2car.mjs), so the peaks stay there.
    double best = 0, best_a = 0;
    for (double a = 0; a < 20; a += 0.05) {
        double f = mf_pure_fy(p, a * deg, 4000, 1);
        if (f > best) { best = f; best_a = a; }
    }
    test::check_range("lateral peak slip angle", best_a, 6, 12, "deg");
    // extreme-performance summer tyres (the C7 Z51 reference runs Pilot Super Sports): ~1.2-1.35 at nominal load
    test::check_range("lateral peak mu at Fz0", best / 4000, 1.05, 1.35, "-");
    double kbest = 0, kpk = 0;
    for (double k = 0; k < 0.5; k += 0.002) {
        double f = mf_pure_fx(p, k, 4000, 1);
        if (f > kbest) { kbest = f; kpk = k; }
    }
    test::check_range("longitudinal peak slip ratio", kpk, 0.08, 0.18, "-");
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

    // Tyre thermodynamics (two layers) & wear: 10 s of hard sliding (25 kW) on a cold tyre
    TireCondition cond;
    cond.temperature_c = cond.surface_c = 30.0;
    double cold_grip = cond.grip_factor(&p);
    for (int i = 0; i < 100; ++i) cond.update(25000.0, 4000.0, 25.0, 0.1, &p);
    std::printf("         10 s at 25 kW sliding from 30 C: surface %.0f C, core %.0f C, grip %.3f -> %.3f\n", cond.surface_c, cond.temperature_c, cold_grip, cond.grip_factor(&p));
    test::check("sliding heats the surface fast", cond.surface_c > 70.0);
    test::check("the core follows slowly", cond.temperature_c > 40.0 && cond.temperature_c < cond.surface_c);
    test::check("warmer tyre grips better", cond.grip_factor(&p) > cold_grip);
    for (int i = 0; i < 100; ++i) cond.update(0.0, 4000.0, 25.0, 0.1, &p);
    test::check("the surface spike fades in seconds once the slide stops", cond.surface_c - cond.temperature_c < 8.0);

    // MF 6.1 friction decay with sliding speed: same slip angle, slow slide vs. fast slide
    TireOperating slow, fast;
    slow.slip_speed = 1.5;
    fast.slip_speed = 25.0;
    double fy_slow = magic_formula(p, 0.0, std::tan(20 * deg), 4000, 1.0, 0.0, slow).fy;
    double fy_fast = magic_formula(p, 0.0, std::tan(20 * deg), 4000, 1.0, 0.0, fast).fy;
    test::check_range("Fy at 25 m/s sliding / at 1.5 m/s (LMUV)", fy_fast / fy_slow, 0.80, 0.92, "x");

    // Inflation: gas law from the core temperature; a warm tyre sits near its nominal pressure
    TireCondition pc;
    pc.temperature_c = pc.surface_c = 20.0;
    pc.update(0.0, 0.0, 0.0, 0.01, &p);
    double cold_p = pc.pressure_kpa;
    pc.temperature_c = pc.surface_c = 85.0;
    pc.update(0.0, 0.0, 0.0, 0.01, &p);
    std::printf("         pressure cold %.0f kPa, core 85 C %.0f kPa (nominal %.0f)\n", cold_p, pc.pressure_kpa, p.p_nominal_kpa);
    test::check_range("pressure rise cold -> hot", pc.pressure_kpa - cold_p, 20, 50, "kPa");
    TireOperating over;
    over.dpi = 0.25;   // 25 % over-inflated: stiffer, less grip
    double fy_nom = magic_formula(p, 0.0, std::tan(8 * deg), 4000, 1.0).fy;
    double fy_over = magic_formula(p, 0.0, std::tan(8 * deg), 4000, 1.0, 0.0, over).fy;
    test::check("over-inflated tyre: less lateral force at the limit", fy_over < fy_nom);
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
