// Tyre model: Pacejka Magic Formula with load sensitivity and combined slip.
#pragma once
#include "rs/config.hpp"

namespace rs {

struct TireForces {
    double fx = 0;   // longitudinal force in the tyre frame (+ = forward), N
    double fy = 0;   // lateral force in the tyre frame (+ = left), N
};

// Extension point for later phases (temperature, wear). Not simulated yet: grip factor is 1.
struct TireCondition {
    double temperature_c = 80.0;
    double wear = 0.0;            // 0 = new, 1 = worn out
    double grip_factor() const { return 1.0; }   // hook: temperature/wear grip curve goes here
};

// kappa: longitudinal slip ratio (-), tan_alpha: tangent of the slip angle (-, + gives +Fy),
// fz: vertical load (N), mu_scale: surface/condition grip multiplier.
TireForces magic_formula(const TireParams& p, double kappa, double tan_alpha, double fz, double mu_scale);

// Pure-slip curves, exposed for tests/plots.
double mf_pure_fx(const TireParams& p, double kappa, double fz, double mu_scale);
double mf_pure_fy(const TireParams& p, double alpha, double fz, double mu_scale);

}  // namespace rs
