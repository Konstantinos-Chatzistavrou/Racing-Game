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
