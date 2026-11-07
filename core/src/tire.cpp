#include "rs/tire.hpp"
#include "rs/math.hpp"
#include <algorithm>
#include <cmath>

namespace rs {
namespace {

// The Magic Formula itself (Pacejka MF 5.2 / 6.1):
//   y(x) = D sin(C atan(B x - E (B x - atan(B x))))
//   D = peak value, C = shape (how the curve falls after the peak), B = stiffness factor,
//   E = curvature near the peak (constrained <= 1 so the atan argument is strictly monotonic).
//   The slope at the origin is B*C*D (the slip/cornering stiffness K).
double mf(double x, double B, double C, double D, double E) {
    double bx = B * x;
    double e = std::min(E, 1.0);
    return D * std::sin(C * std::atan(bx - e * (bx - std::atan(bx))));
}

// Cosine Magic Formula used by Pacejka MF 5.2 for weighting functions Gxa, Gyk and pneumatic trail t:
//   G(x) = cos(C atan(B x - E (B x - atan(B x))))
double mf_cos(double x, double B, double C, double E) {
    double bx = B * x;
    double e = std::min(E, 1.0);
    return std::cos(C * std::atan(bx - e * (bx - std::atan(bx))));
}

// Normalised load change dfz = (Fz - Fz0) / Fz0, used for load sensitivity.
double dfz_of(const TireParams& p, double fz) { return (fz - p.fz0) / std::max(p.fz0, 1.0); }

// Longitudinal slip stiffness K_xk (MF 5.2 eq. 4.E13):
//   K_xk = Fz (pKx1 + pKx2 dfz) exp(pKx3 dfz)
//   MF 6.1 pressure: * (1 + pPx1 dpi + pPx2 dpi^2)
double kx_of(const TireParams& p, double fz, double dfz, double dpi = 0.0) {
    double factor = std::max(0.2, 1.0 + (p.pkx2 / std::max(p.kx, 1e-6)) * dfz);
    double press = std::max(0.3, 1.0 + p.ppx1 * dpi + p.ppx2 * dpi * dpi);
    return p.kx * fz * factor * std::exp(clamp(p.pkx3 * dfz, -1.0, 1.0)) * press;
}

// Lateral cornering stiffness K_ya (MF 5.2 eq. 4.E25):
//   K_ya = pKy1 Fz0 sin(2 atan(Fz / (pKy2 Fz0))) (1 - pKy3 |gamma|)
// Rises with load, then saturates: doubling load does NOT double cornering stiffness.
//   MF 6.1 pressure: pKy1 Fz0 (1 + pPy1 dpi) sin(2 atan(Fz / (pKy2 Fz0 (1 + pPy2 dpi))))
double ky_of(const TireParams& p, double fz, double gamma, double dpi = 0.0) {
    double camber_loss = std::max(0.2, 1.0 - p.pky3 * std::abs(gamma));
    double peak_load = p.pky2 * p.fz0 * std::max(0.3, 1.0 + p.ppy2 * dpi);
    return p.pky1 * p.fz0 * std::max(0.3, 1.0 + p.ppy1 * dpi) * std::sin(2.0 * std::atan(fz / peak_load)) * camber_loss;
}

// Peak friction coefficients with load, camber and pressure sensitivity (MF 6.1 eqs. 4.E13 / 4.E23):
//   mu_x = pDx1 (1 + pDx2 dfz)(1 + pPx3 dpi + pPx4 dpi^2)(1 - pDx3 gamma^2) lambda_mu
double mu_x_of(const TireParams& p, double dfz, double gamma, double mu_scale, double dpi) {
    return p.mu_x * std::max(0.2, 1.0 + p.pdx2 * dfz) * std::max(0.5, 1.0 + p.ppx3 * dpi + p.ppx4 * dpi * dpi)
           * std::max(0.2, 1.0 - p.pdx3 * gamma * gamma) * mu_scale;
}
double mu_y_of(const TireParams& p, double dfz, double gamma, double mu_scale, double dpi) {
    return p.mu_y * std::max(0.2, 1.0 + p.pdy2 * dfz) * std::max(0.5, 1.0 + p.ppy3 * dpi + p.ppy4 * dpi * dpi)
           * std::max(0.2, 1.0 - p.pdy3 * gamma * gamma) * mu_scale;
}

}  // namespace

void TireCondition::update(double slip_power_w, double load_n, double speed_mps, double dt, const TireParams* p) {
    if (dt <= 0) return;
    // Two-layer tread model (lumped capacitances):
    //   surface: C_s dTs/dt = P_slip - G (Ts - Tc) - h_a(v) (Ts - T_air)
    //   core:    C_c dTc/dt = G (Ts - Tc) - k_c(v) (Tc - T_eq) * C_c
    // P_slip = |Fx v_sx| + |Fy v_sy| (all friction work lands in the surface). The core relaxes toward the rolling
    // equilibrium T_eq (hysteresis heating balanced by carcass / rim cooling). C_s = 1.5 kJ/K (the outer 2-3 mm of
    // tread), C_c = 16 kJ/K, G = 400 W/K, air h A = 20 + 2.5 v W/K (~0.6 m^2 of tread): a 25 kW drift puts the surface
    // near 100 C in a few seconds while the core climbs ~1 C/s; the spike fades ~3 s after the slide.
    constexpr double Cs = 1500.0, Cc = 16000.0, G = 400.0, Teq = 78.0, Tair = 30.0;
    const double v = std::abs(speed_mps);
    const double ha = 20.0 + 2.5 * v;                       // W/K, surface convection to air
    const double kc = 0.012 + 0.0012 * v;                   // 1/s, core toward the rolling equilibrium
    const double hyst = 0.012 * load_n * v;                 // W, rolling hysteresis (mostly in the core)
    // integrate in <= 50 ms steps ((G + h_a) / C_s ~ 0.3 /s)
    const int n = std::max(1, (int)std::ceil(dt / 0.05));
    const double h = dt / n;
    for (int i = 0; i < n; ++i) {
        const double ts = surface_c, tc = temperature_c;
        const double dts = (slip_power_w - G * (ts - tc) - ha * (ts - Tair)) / Cs;
        const double dtc = (G * (ts - tc) + hyst) / Cc - kc * (tc - Teq);
        surface_c = clamp(ts + dts * h, 10.0, 260.0);
        temperature_c = clamp(tc + dtc * h, 10.0, 180.0);
    }
    // Inflation gas: warms with the core (it sees the inner liner, ~55 % of the core's rise above 20 C), constant
    // volume: p_abs = p_abs,cold * T_gas / T_cold.
    const double p_cold = p ? p->p_cold_kpa : 200.0;
    const double t_gas = 20.0 + 0.55 * (temperature_c - 20.0);
    pressure_kpa = (p_cold + 101.3) * (t_gas + 273.15) / 293.15 - 101.3;
    // Wear: sliding work above normal cornering
    if (slip_power_w > 18000.0) wear = clamp(wear + (slip_power_w - 18000.0) * 1.2e-9 * dt, 0.0, 1.0);
}

double TireCondition::dpi(const TireParams& p) const {
    if (pressure_kpa <= 0) return 0.0;
    return clamp((pressure_kpa - p.p_nominal_kpa) / std::max(p.p_nominal_kpa, 1.0), -0.5, 0.5);
}

double TireCondition::grip_factor(const TireParams* p) const {
    // The compound works in a window around T_opt of the core/surface blend (the contact patch feels the surface,
    // hysteresis friction the bulk). Outside it grip falls off parabolically: cold rubber is hard, hot rubber soft and
    // greasy. A surface far above the window (long slide, burnout) greases on top of that, until it cools down.
    const double t_opt = p ? p->temp_optimal_c : 90.0, w = p ? p->temp_window_c : 25.0;
    const double t = 0.65 * temperature_c + 0.35 * surface_c;
    double temp_grip = 1.0;
    if (t < t_opt - w) { double d = (t_opt - w - t) / 60.0; temp_grip = std::max(0.85, 1.0 - 0.14 * d * d - 0.02 * d); }
    else if (t > t_opt + w) { double d = (t - t_opt - w) / 50.0; temp_grip = std::max(0.82, 1.0 - 0.14 * d * d); }
    double grease = surface_c > 140.0 ? std::max(0.88, 1.0 - 0.0012 * (surface_c - 140.0)) : 1.0;
    double wear_grip = 1.0 - 0.15 * wear * wear;
    return temp_grip * grease * wear_grip;
}

double effective_rolling_radius(const TireParams& p, double fz) {
    if (fz <= 0 || p.vertical_stiffness <= 0) return p.radius;
    // Pacejka Ch. 4: under vertical load change (Fz - Fz0), radial deflection changes by d_rho = (Fz - Fz0)/C_Fz,
    // and the effective rolling radius R_e shifts by ~1/3 of the radial deflection due to belt inextensibility.
    double d_rho = (fz - p.fz0) / p.vertical_stiffness;
    return clamp(p.radius - (1.0 / 3.0) * d_rho, p.radius * 0.85, p.radius * 1.05);
}

void relaxation_lengths(const TireParams& p, double fz, double gamma, double& sigma_x, double& sigma_y) {
    if (fz <= 0) {
        sigma_x = p.relax_x;
        sigma_y = p.relax_y;
        return;
    }
    // Pacejka Ch. 7 stretched-string / carcass compliance theorem:
    //   sigma_x(Fz) = K_xk(Fz) / C_Fx,   sigma_y(Fz, gamma) = K_ya(Fz, gamma) / C_Fy
    // where C_Fx = K_xk(Fz0) / sigma_x0 and C_Fy = K_ya(Fz0, 0) / sigma_y0 are the carcass stiffnesses.
    double dfz = dfz_of(p, fz);
    double kx0 = std::max(kx_of(p, p.fz0, 0.0), 1.0);
    double ky0 = std::max(ky_of(p, p.fz0, 0.0), 1.0);
    double kx = kx_of(p, fz, dfz);
    double ky = ky_of(p, fz, gamma);
    sigma_x = clamp(p.relax_x * (kx / kx0), 0.03, p.relax_x * 2.5);
    sigma_y = clamp(p.relax_y * (ky / ky0), 0.05, p.relax_y * 2.5);
}

double mf_pure_fx(const TireParams& p, double kappa, double fz, double mu_scale, double gamma, double dpi) {
    if (fz <= 0) return 0;
    double dfz = dfz_of(p, fz);
    // Load, camber and pressure sensitivity (MF 6.1 eq. 4.E13). Note: in our config, p.pdx2 is normalised by p.mu_x.
    double mu = mu_x_of(p, dfz, gamma, mu_scale, dpi);
    double D = mu * fz;
    double K = kx_of(p, fz, dfz, dpi);
    double B = K / (p.cx * D + 1e-9);
    double shx = p.phx1 + p.phx2 * dfz;
    double svx = fz * (p.pvx1 + p.pvx2 * dfz) * mu_scale;
    double kx = kappa + shx;
    // Load-dependent curvature E_x (MF 5.2 eq. 4.E12):
    double ex = (p.ex + p.pex2 * dfz + p.pex3 * dfz * dfz) * (1.0 - p.pex4 * sign(kx));
    return mf(kx, B, p.cx, D, ex) + svx;
}

double mf_pure_fy(const TireParams& p, double alpha, double fz, double mu_scale, double gamma, double dpi) {
    if (fz <= 0) return 0;
    double dfz = dfz_of(p, fz);
    // Lateral friction coefficient with load, camber and pressure sensitivity (MF 6.1 eq. 4.E23)
    double mu = mu_y_of(p, dfz, gamma, mu_scale, dpi);
    double D = mu * fz;
    double K = ky_of(p, fz, gamma, dpi);
    double B = K / (p.cy * D + 1e-9);
    // Camber shifts (camber thrust, MF 5.2 eqs. 4.E27-4.E28):
    double shy = (p.phy1 + p.phy2 * dfz) + p.phy3 * gamma;
    double svy = fz * ((p.pvy1 + p.pvy2 * dfz) + (p.pvy3 + p.pvy4 * dfz) * gamma) * mu_scale;
    double ay = alpha + shy;
    // Load- and camber-dependent curvature E_y (MF 5.2 eq. 4.E24):
    double ey = (p.ey + p.pey2 * dfz) * (1.0 - (p.pey3 + p.pey4 * gamma) * sign(ay));
    return mf(ay, B, p.cy, D, ey) + svy;
}

double mf_aligning_torque(const TireParams& p, double kappa, double alpha, double fz, double mu_scale, double gamma,
                          double fx, double fy_no_svyk, double* out_trail) {
    if (fz <= 0) {
        if (out_trail) *out_trail = 0;
        return 0;
    }
    double dfz = dfz_of(p, fz);
    double mu_s = std::max(mu_scale, 0.1);
    double kx = kx_of(p, fz, dfz);
    double ky = std::max(ky_of(p, fz, gamma), 1.0);
    double k_ratio = kx / ky;

    // 1. Pneumatic trail t(alpha_t,eq) (MF 5.2 eqs. 4.E33-4.E42, 4.E73):
    double sht = p.qhz1 + p.qhz2 * dfz + (p.qhz3 + p.qhz4 * dfz) * gamma;
    double alpha_t = alpha + sht;
    double tan_at = std::tan(clamp(alpha_t, -1.4, 1.4));
    double alpha_teq = std::atan(std::hypot(tan_at, k_ratio * kappa)) * (alpha_t >= 0 ? 1.0 : -1.0);
    double Bt = std::max(0.5, (p.qbz1 + p.qbz2 * dfz + p.qbz3 * dfz * dfz) * (1.0 + p.qbz4 * gamma + p.qbz5 * std::abs(gamma))) / mu_s;
    double Ct = p.qcz1;
    double Dt = fz * (p.radius / std::max(p.fz0, 1.0)) * (p.qdz1 + p.qdz2 * dfz) * (1.0 + p.qdz3 * gamma + p.qdz4 * gamma * gamma);
    double Et = (p.qez1 + p.qez2 * dfz + p.qez3 * dfz * dfz) *
                (1.0 + (p.qez4 + p.qez5 * gamma) * (2.0 / kPi) * std::atan(Bt * Ct * alpha_teq));
    double trail = Dt * mf_cos(alpha_teq, Bt, Ct, Et) * std::cos(alpha);
    if (out_trail) *out_trail = trail;

    // 2. Residual torque M_zr(alpha_r,eq) (MF 5.2 eqs. 4.E43-4.E47, 4.E74):
    double shy = (p.phy1 + p.phy2 * dfz) + p.phy3 * gamma;
    double svy = fz * ((p.pvy1 + p.pvy2 * dfz) + (p.pvy3 + p.pvy4 * dfz) * gamma) * mu_scale;
    double shf = shy + svy / ky;
    double alpha_r = alpha + shf;
    double tan_ar = std::tan(clamp(alpha_r, -1.4, 1.4));
    double alpha_req = std::atan(std::hypot(tan_ar, k_ratio * kappa)) * (alpha_r >= 0 ? 1.0 : -1.0);
    double mu_y = p.mu_y * std::max(0.2, 1.0 + p.pdy2 * dfz) * std::max(0.2, 1.0 - p.pdy3 * gamma * gamma) * mu_scale;
    double By = ky / (p.cy * mu_y * fz + 1e-9);
    double Br = p.qbz9 / mu_s + p.qbz10 * By * p.cy;
    double Dr = fz * p.radius * ((p.qdz6 + p.qdz7 * dfz) + (p.qdz8 + p.qdz9 * dfz) * gamma) * mu_scale * std::cos(alpha);
    double mzr = Dr * std::cos(std::atan(Br * alpha_req));

    // 3. Moment arm s of longitudinal force Fx due to camber & lateral carcass deflection (MF 5.2 eq. 4.E76):
    double s = p.radius * (p.ssz1 + p.ssz2 * (fy_no_svyk / std::max(p.fz0, 1.0)) + (p.ssz3 + p.ssz4 * dfz) * gamma);

    return -trail * fy_no_svyk + mzr + s * fx;
}

TireForces magic_formula(const TireParams& p, double kappa, double tan_alpha, double fz, double mu_scale, double gamma,
                         const TireOperating& op) {
    TireForces out;
    if (fz <= 0) return out;
    // MF 6.1 friction decay with sliding speed:  lambda_mu* = lambda_mu / (1 + LMUV Vs / V0), V0 = LONGVL = 16.7 m/s.
    // Rubber friction drops as the slide gets faster: a locked wheel at 100 km/h holds ~17 % less than at walking pace,
    // a drift at speed sits lower on the curve than the same slip angle in a hairpin.
    // (relative to the sliding speed the coefficients describe, so ordinary cornering is unchanged)
    mu_scale *= (1.0 + p.lmuv * p.lmuv_ref_mps / 16.7) / (1.0 + p.lmuv * std::abs(op.slip_speed) / 16.7);
    const double dpi = op.dpi;
    double dfz = dfz_of(p, fz);
    double alpha = std::atan(tan_alpha);
    double fx0 = mf_pure_fx(p, kappa, fz, mu_scale, gamma, dpi);
    double fy0 = mf_pure_fy(p, alpha, fz, mu_scale, gamma, dpi);
    // MF 6.1 turn slip (spin) reduction of the lateral force (eqs. 4.E64-4.E69, peak factor zeta_2, stiffness zeta_3):
    //   B_yphi = pDyp1 (1 + pDyp2 dfz) cos(atan(pDyp3 tan alpha))
    //   zeta_2 = cos(atan(B_yphi (R0 |phi| + pDyp4 sqrt(R0 |phi|))))     zeta_3 = cos(atan(pKyp1 R0^2 phi^2))
    // Negligible at speed (phi ~ 1/R), real when parking or in a hairpin at walking pace.
    if (op.phi != 0.0) {
        const double rphi = p.radius * std::abs(op.phi);
        const double byphi = p.pdyp1 * (1.0 + p.pdyp2 * dfz) * std::cos(std::atan(p.pdyp3 * tan_alpha));
        const double zeta2 = std::cos(std::atan(byphi * (rphi + p.pdyp4 * std::sqrt(rphi))));
        const double zeta3 = std::cos(std::atan(p.pkyp1 * rphi * rphi));
        fy0 *= zeta2 * (0.5 + 0.5 * zeta3);   // peak and (approx.) slope
    }

    // Combined slip (Pacejka MF 5.2 weighting functions Gxa, Gyk + kappa-induced side force SVyk):
    //   Gxa = cos(Cxa atan(Bxa alpha_S - Exa (Bxa alpha_S - atan(Bxa alpha_S)))) / cos(...)
    //   Bxa = (rBx1 + rBx3 gamma^2) cos(atan(rBx2 kappa))
    double bxa = (p.rbx1 + p.rbx3 * gamma * gamma) * std::cos(std::atan(p.rbx2 * kappa));
    double exa = p.rex1 + p.rex2 * dfz;
    double alpha_s = alpha + p.rhx1;
    double gxa0 = std::max(mf_cos(p.rhx1, bxa, p.rcx1, exa), 1e-4);
    double gxa = clamp(mf_cos(alpha_s, bxa, p.rcx1, exa) / gxa0, 0.0, 1.0);

    //   Gyk = cos(Cyk atan(Byk kappa_S - Eyk (Byk kappa_S - atan(Byk kappa_S)))) / cos(...)
    //   Byk = (rBy1 + rBy4 gamma^2) cos(atan(rBy2 (alpha - rBy3)))
    double byk = (p.rby1 + p.rby4 * gamma * gamma) * std::cos(std::atan(p.rby2 * (alpha - p.rby3)));
    double eyk = p.rey1 + p.rey2 * dfz;
    double shyk = p.rhy1 + p.rhy2 * dfz;
    double kappa_s = kappa + shyk;
    double gyk0 = std::max(mf_cos(shyk, byk, p.rcy1, eyk), 1e-4);
    double gyk = clamp(mf_cos(kappa_s, byk, p.rcy1, eyk) / gyk0, 0.0, 1.0);

    // Braking/driving-induced lateral force SVyk (MF 5.2 eqs. 4.E65-4.E66):
    double mu_y = mu_y_of(p, dfz, gamma, mu_scale, dpi);
    double dvyk = mu_y * fz * (p.rvy1 + p.rvy2 * dfz + p.rvy3 * gamma) * std::cos(std::atan(p.rvy4 * alpha));
    double svyk = dvyk * std::sin(p.rvy5 * std::atan(p.rvy6 * kappa));

    double fx = fx0 * gxa;
    double fy_no_svyk = fy0 * gyk;
    double fy = fy_no_svyk + svyk;

    // Friction-ellipse envelope protection: ensures combined force vector never exceeds the
    // anisotropic pure-slip peak envelope (Dx, Dy) under extreme simultaneous slip + camber.
    double mu_x = mu_x_of(p, dfz, gamma, mu_scale, dpi);
    double dx_max = std::max({mu_x * fz, std::abs(fx0), 1e-6});
    double dy_max = std::max({mu_y * fz, std::abs(fy0), 1e-6});
    double ellipse = std::hypot(fx / dx_max, fy / dy_max);
    if (ellipse > 1.0) {
        fx /= ellipse;
        fy /= ellipse;
        fy_no_svyk /= ellipse;
    }

    out.fx = fx;
    out.fy = fy;
    out.mz = mf_aligning_torque(p, kappa, alpha, fz, mu_scale, gamma, fx, fy_no_svyk, &out.pneumatic_trail);
    return out;
}

}  // namespace rs
