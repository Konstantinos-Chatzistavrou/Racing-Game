// Tyre model: Full Pacejka Magic Formula (MF 5.2 / 6.1) with load sensitivity, camber thrust,
// load/camber-dependent curvature & stiffness, combined slip (Gxa, Gyk, SVyk, friction ellipse),
// self-aligning torque Mz (pneumatic trail t + residual torque Mzr + carcass offset s),
// load-dependent carcass relaxation lengths, effective rolling radius, and tyre thermodynamics.
#pragma once
#include "rs/config.hpp"

namespace rs {

struct TireForces {
    double fx = 0;               // longitudinal force in the tyre frame (+ = forward), N
    double fy = 0;               // lateral force in the tyre frame (+ = left), N
    double mz = 0;               // self-aligning moment about contact normal (+ = CCW from above), N m
    double pneumatic_trail = 0;  // instantaneous pneumatic trail t, m
};

// Tyre thermal & wear state: sliding friction power heats the tread, airflow and road contact cool it.
struct TireCondition {
    double temperature_c = 80.0;
    double wear = 0.0;            // 0 = new, 1 = worn out
    void update(double slip_power_w, double load_n, double speed_mps, double dt);
    double grip_factor() const;
};

// kappa: longitudinal slip ratio (-), tan_alpha: tangent of the slip angle (-, + gives +Fy),
// fz: vertical load (N), mu_scale: surface/condition grip multiplier,
// gamma: inclination / camber angle in the tyre frame (rad, + = top tilted toward +left).
TireForces magic_formula(const TireParams& p, double kappa, double tan_alpha, double fz, double mu_scale, double gamma = 0.0);

// Pure-slip curves and self-aligning moment, exposed for tests/plots.
double mf_pure_fx(const TireParams& p, double kappa, double fz, double mu_scale, double gamma = 0.0);
double mf_pure_fy(const TireParams& p, double alpha, double fz, double mu_scale, double gamma = 0.0);
double mf_aligning_torque(const TireParams& p, double kappa, double alpha, double fz, double mu_scale, double gamma,
                          double fx, double fy_no_svyk, double* out_trail = nullptr);

// Effective rolling radius R_e under vertical load Fz (Pacejka Ch. 4: tread inextensibility + radial deflection).
double effective_rolling_radius(const TireParams& p, double fz);

// Load- and camber-dependent transient relaxation lengths sigma_x(Fz), sigma_y(Fz, gamma) (Pacejka Ch. 7).
void relaxation_lengths(const TireParams& p, double fz, double gamma, double& sigma_x, double& sigma_y);

}  // namespace rs
