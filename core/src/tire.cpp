#include "rs/tire.hpp"
#include "rs/math.hpp"
#include <cmath>

namespace rs {
namespace {

// The Magic Formula itself:  y(x) = D sin(C atan(B x - E (B x - atan(B x))))
//   D = peak value, C = shape (how the curve falls after the peak), B = stiffness factor,
//   E = curvature near the peak. The slope at the origin is B*C*D (the "slip stiffness").
double mf(double x, double B, double C, double D, double E) {
    double bx = B * x;
    return D * std::sin(C * std::atan(bx - E * (bx - std::atan(bx))));
}

// Normalised load change dfz = (Fz - Fz0) / Fz0, used for load sensitivity.
double dfz_of(const TireParams& p, double fz) { return (fz - p.fz0) / p.fz0; }

}  // namespace

double mf_pure_fx(const TireParams& p, double kappa, double fz, double mu_scale) {
    if (fz <= 0) return 0;
    double dfz = dfz_of(p, fz);
    // Load sensitivity: the friction coefficient DROPS as load rises (mu = mu0 (1 + pdx2 dfz),
    // pdx2 < 0). This is why load transfer reduces total grip and is the root of under/oversteer
    // tuning through roll stiffness distribution.
    double mu = p.mu_x * (1.0 + p.pdx2 * dfz) * mu_scale;
    double D = mu * fz;
    double K = p.kx * fz;                     // longitudinal slip stiffness, N per unit slip
    double B = K / (p.cx * D + 1e-9);
    return mf(kappa, B, p.cx, D, p.ex);
}

double mf_pure_fy(const TireParams& p, double alpha, double fz, double mu_scale) {
    if (fz <= 0) return 0;
    double dfz = dfz_of(p, fz);
    double mu = p.mu_y * (1.0 + p.pdy2 * dfz) * mu_scale;
    double D = mu * fz;
    // Cornering stiffness (MF 5.2):  K_ya = pKy1 Fz0 sin(2 atan(Fz / (pKy2 Fz0)))
    // Rises with load, then saturates: doubling load does NOT double cornering stiffness.
    double K = p.pky1 * p.fz0 * std::sin(2.0 * std::atan(fz / (p.pky2 * p.fz0)));
    double B = K / (p.cy * D + 1e-9);
    return mf(alpha, B, p.cy, D, p.ey);
}

TireForces magic_formula(const TireParams& p, double kappa, double tan_alpha, double fz, double mu_scale) {
    TireForces out;
    if (fz <= 0) return out;
    double alpha = std::atan(tan_alpha);
    double fx0 = mf_pure_fx(p, kappa, fz, mu_scale);
    double fy0 = mf_pure_fy(p, alpha, fz, mu_scale);
    // Combined slip (MF 5.2 weighting functions, shift terms omitted):
    //   Gxa = cos(Cxa atan(Bxa alpha)),   Bxa = rBx1 cos(atan(rBx2 kappa))
    //   Gyk = cos(Cyk atan(Byk kappa)),   Byk = rBy1 cos(atan(rBy2 alpha))
    // Braking/accelerating while cornering reduces lateral force and vice versa: the tyre has
    // one friction budget. G = 1 for pure slip, falling toward 0 as the other slip grows.
    double bxa = p.rbx1 * std::cos(std::atan(p.rbx2 * kappa));
    double gxa = std::cos(p.rcx1 * std::atan(bxa * alpha));
    double byk = p.rby1 * std::cos(std::atan(p.rby2 * alpha));
    double gyk = std::cos(p.rcy1 * std::atan(byk * kappa));
    out.fx = fx0 * std::max(gxa, 0.0);
    out.fy = fy0 * std::max(gyk, 0.0);
    return out;
}

}  // namespace rs
