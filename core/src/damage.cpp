#include "rs/damage.hpp"
#include <cmath>

namespace rs {

void DamageModel::add_contact(std::uint64_t id, const Vec3& pt, double impulse, double time, double dt) {
    // Average contact force over the tick F = J / dt; below min_force_g it is not a crash.
    if (impulse <= 0 || impulse / std::max(dt, 1e-6) < p_.min_force_g * mass_ * kGravity) return;
    Event& e = events_[id];
    if (e.last_time < 0 || time - e.last_time > 0.15) e.j_acc = 0;   // new crash event
    e.last_time = time;
    double j0 = e.j_acc, j1 = e.j_acc + impulse;
    e.j_acc = j1;
    auto energy = [&](double j) {                                     // E = (J - J_min)^2 / 2m
        double jj = std::max(0.0, j - p_.min_impulse);
        return jj * jj / (2.0 * mass_);
    };
    double de = energy(j1) - energy(j0);                              // J (joules)
    if (de <= 0) return;
    if (energy(j0) <= 0) ++r_.impacts;
    r_.total_energy_kj += de / 1000.0;
    r_.last_impact_kj = energy(j1) / 1000.0;
    r_.last_impact_point = pt;

    // Zone from the impact position seen from the CG (body is ~2.4x longer than wide).
    int zone = std::abs(pt.x) > 1.2 * std::abs(pt.y) ? (pt.x > 0 ? ZoneFront : ZoneRear)
                                                      : (pt.y > 0 ? ZoneLeft : ZoneRight);
    r_.last_zone = zone;
    // Crush depth from accumulated zone energy:  x = sqrt(2 E / k)
    zone_energy_[zone] += de;
    double k = zone <= ZoneRear ? p_.stiffness_front_rear : p_.stiffness_side;
    r_.crush[zone] = std::sqrt(2.0 * zone_energy_[zone] / k);
    double full = zone == ZoneFront ? p_.engine_full : zone == ZoneRear ? p_.rear_max : p_.cabin_total;
    r_.zone[zone] = std::min(1.0, r_.crush[zone] / full);
    // Engine: only once the front crumple zone is used up.
    r_.engine = clamp((r_.crush[ZoneFront] - p_.engine_start) / (p_.engine_full - p_.engine_start), 0.0, 1.0);
    // Wheels: direct hits near a wheel, share falling off linearly with plan-view distance.
    for (int w = 0; w < 4; ++w) {
        Vec3 d = pt - wheels_[w];
        double dist = std::hypot(d.x, d.y);
        if (dist < p_.wheel_radius_m)
            r_.wheel[w] = std::min(1.0, r_.wheel[w] + (1.0 - dist / p_.wheel_radius_m) * de / (p_.wheel_energy_kj * 1000.0));
    }
    // Totaled: engine wrecked, cabin crushed, or three wheels destroyed.
    if (!r_.totaled) {
        int dead_wheels = 0;
        for (double w : r_.wheel) dead_wheels += w >= 0.95;
        if (r_.engine >= p_.totaled_engine) { r_.totaled = true; r_.totaled_reason = "engine"; }
        else if (std::max(r_.crush[ZoneLeft], r_.crush[ZoneRight]) >= p_.cabin_total) { r_.totaled = true; r_.totaled_reason = "cabin"; }
        else if (dead_wheels >= 3) { r_.totaled = true; r_.totaled_reason = "wheels"; }
    }
}

double DamageModel::engine_power_factor() const { return r_.totaled ? 0.0 : 1.0 - 0.7 * r_.engine; }

double DamageModel::drag_factor() const {
    double avg = 0;
    for (double z : r_.zone) avg += z * 0.25;
    return 1.0 + 0.3 * avg;
}

double DamageModel::suspension_factor(int w) const { return 1.0 - 0.4 * r_.wheel[w]; }

// A bent arm toes the wheel OUT (left wheels point left, right wheels right): the car pulls
// toward the damaged side and wanders, as with a bent tie rod.
double DamageModel::toe_offset(int w) const {
    double toe = r_.wheel[w] * p_.max_toe_deg * kPi / 180.0;
    return (w % 2 == 0) ? toe : -toe;
}

double DamageModel::grip_factor(int w) const { return 1.0 - 0.1 * r_.wheel[w]; }

}  // namespace rs
