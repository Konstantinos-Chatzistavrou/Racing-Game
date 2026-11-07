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

// Tyre thermal, pressure & wear state. Two layers: the tread SURFACE takes the sliding friction power and swings fast
// (a few seconds), the CORE (bulk tread + carcass) follows it slowly and sets the inflation gas temperature. Grip comes
// from a blend of the two inside the compound's window; a surface far over the window greases up on its own.
struct TireCondition {
    double temperature_c = 80.0;  // core (bulk) temperature, C
    double surface_c = 80.0;      // tread surface temperature, C
    double pressure_kpa = 0.0;    // gauge, from the gas law (0 until the first update)
    double wear = 0.0;            // 0 = new, 1 = worn out
    void update(double slip_power_w, double load_n, double speed_mps, double dt, const TireParams* p = nullptr);
    double grip_factor(const TireParams* p = nullptr) const;
    /** Relative pressure change dpi = (p - p_nom) / p_nom (MF 6.1). */
    double dpi(const TireParams& p) const;
};

// Operating state passed to the Magic Formula besides the slips (MF 6.1).
struct TireOperating {
    double slip_speed = 0;        // |v_slip| m/s: friction falls with sliding speed (LMUV)
    double dpi = 0;               // relative inflation pressure change
    double phi = 0;               // turn slip (spin) 1/m: -(yaw rate of the wheel) / V_cx (MF 6.1)
};

// kappa: longitudinal slip ratio (-), tan_alpha: tangent of the slip angle (-, + gives +Fy),
// fz: vertical load (N), mu_scale: surface/condition grip multiplier,
// gamma: inclination / camber angle in the tyre frame (rad, + = top tilted toward +left).
TireForces magic_formula(const TireParams& p, double kappa, double tan_alpha, double fz, double mu_scale, double gamma = 0.0,
                         const TireOperating& op = {});

// Pure-slip curves and self-aligning moment, exposed for tests/plots.
double mf_pure_fx(const TireParams& p, double kappa, double fz, double mu_scale, double gamma = 0.0, double dpi = 0.0);
double mf_pure_fy(const TireParams& p, double alpha, double fz, double mu_scale, double gamma = 0.0, double dpi = 0.0);
double mf_aligning_torque(const TireParams& p, double kappa, double alpha, double fz, double mu_scale, double gamma,
                          double fx, double fy_no_svyk, double* out_trail = nullptr);

// Effective rolling radius R_e under vertical load Fz (Pacejka Ch. 4: tread inextensibility + radial deflection).
double effective_rolling_radius(const TireParams& p, double fz);

// Load- and camber-dependent transient relaxation lengths sigma_x(Fz), sigma_y(Fz, gamma) (Pacejka Ch. 7).
void relaxation_lengths(const TireParams& p, double fz, double gamma, double& sigma_x, double& sigma_y);

}  // namespace rs
