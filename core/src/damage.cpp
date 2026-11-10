#include "rs/damage.hpp"
#include <algorithm>
#include <cmath>

namespace rs {

namespace {
// Energy per kg (J/kg) of one crash event that lies in a damage band, as a function of the event's speed change dv:
//   G(dv) = integral over u = 0..dv of  clamp((u - lo) / (hi - lo), 0, 1) * u du
// (d(E/m) = u du, weighted by how far past the band's lower edge the event already is).
double band_energy(double dv, double lo, double hi) {
    if (dv <= lo) return 0.0;
    auto part = [&](double u) { return (u * u * u / 3.0 - lo * u * u / 2.0) / (hi - lo); };
    if (dv <= hi) return part(dv) - part(lo);
    return part(hi) - part(lo) + 0.5 * (dv * dv - hi * hi);
}
// Which wheels sit in a zone: front FL FR, rear RL RR, left FL RL, right FR RR.
bool wheel_in_zone(int w, int zone) {
    switch (zone) {
        case ZoneFront: return w < 2;
        case ZoneRear: return w >= 2;
        case ZoneLeft: return w % 2 == 0;
        default: return w % 2 == 1;
    }
}
}  // namespace

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
    // ---- panels: crush depth from all the energy the zone took,  x = sqrt(2 E / k)
    zone_energy_[zone] += de;
    double k = zone <= ZoneRear ? p_.stiffness_front_rear : p_.stiffness_side;
    r_.crush[zone] = std::sqrt(2.0 * zone_energy_[zone] / k);
    double full = zone == ZoneFront ? p_.front_max : zone == ZoneRear ? p_.rear_max : p_.side_max;
    r_.zone[zone] = std::min(1.0, r_.crush[zone] / full);

    // ---- structure: only the part of the event above the bands (J/kg), see damage.hpp
    const double dv0 = std::max(0.0, j0 - p_.min_impulse) / mass_, dv1 = std::max(0.0, j1 - p_.min_impulse) / mass_;
    const double heavy = band_energy(dv1, p_.heavy_dv_lo, p_.heavy_dv_hi) - band_energy(dv0, p_.heavy_dv_lo, p_.heavy_dv_hi);
    const double wheel_band = band_energy(dv1, p_.wheel_dv_lo, p_.wheel_dv_hi) - band_energy(dv0, p_.wheel_dv_lo, p_.wheel_dv_hi);
    zone_heavy_[zone] += heavy;
    double total_heavy = 0;
    for (double h : zone_heavy_) total_heavy += h;
    r_.structural_kj_per_t = total_heavy;
    // Engine: front hits in full, a share of the rest (mounts, ancillaries, lines).
    const double bay = zone_heavy_[ZoneFront] + p_.engine_other_share * (total_heavy - zone_heavy_[ZoneFront]);
    r_.engine = clamp((bay - p_.engine_start) / (p_.engine_full - p_.engine_start), 0.0, 1.0);
    // Wheels: direct hits near a wheel (share falling off linearly with plan-view distance), plus the load a heavy
    // crash puts through the suspension of the zone it lands in.
    for (int w = 0; w < 4; ++w) {
        Vec3 d = pt - wheels_[w];
        double dist = std::hypot(d.x, d.y);
        double e_w = dist < p_.wheel_radius_m ? (1.0 - dist / p_.wheel_radius_m) * wheel_band : 0.0;
        if (wheel_in_zone(w, zone)) e_w += p_.wheel_zone_share * heavy;
        r_.wheel[w] = std::min(1.0, r_.wheel[w] + e_w / p_.wheel_energy);
    }
    // Totaled: engine wrecked, cabin crushed, three wheels gone, or the shell as a whole.
    if (!r_.totaled) {
        int dead_wheels = 0;
        for (int w = 0; w < 4; ++w) dead_wheels += wheel_off(w);
        if (r_.engine >= p_.totaled_engine) { r_.totaled = true; r_.totaled_reason = "engine"; }
        else if (std::max(zone_heavy_[ZoneLeft], zone_heavy_[ZoneRight]) >= p_.cabin_total) { r_.totaled = true; r_.totaled_reason = "cabin"; }
        else if (dead_wheels >= 3) { r_.totaled = true; r_.totaled_reason = "wheels"; }
        else if (total_heavy >= p_.severity) { r_.totaled = true; r_.totaled_reason = "structure"; }
    }
}

// Limp-home floor instead of a dead engine: the car must never become immovable (game rule).
double DamageModel::engine_power_factor() const { return std::max(p_.limp_power, 1.0 - 0.7 * r_.engine); }

double DamageModel::severity() const {
    return clamp(std::max(r_.engine, r_.structural_kj_per_t / p_.severity), 0.0, 1.0);
}

void DamageModel::update(double dt) {
    const double s = severity();
    if (r_.fire > 0) {
        r_.fire = std::min(1.0, r_.fire + dt / p_.fire_grow_s);
    } else if (s >= p_.overheat_severity) {                   // steam first; only a wreck goes on to burn
        r_.smoulder = std::min(1.0, r_.smoulder + dt / p_.smoulder_s);
        if (r_.smoulder >= 1.0 && s >= p_.fire_severity) r_.fire = 1e-3;
    }
    double rate = std::max(0.0, s - p_.fade_severity) / (1.0 - p_.fade_severity) / p_.fade_damage_s + r_.fire / p_.fade_fire_s;
    brake_wear_ = std::min(1.0, brake_wear_ + rate * dt);
    r_.brakes_failed = brake_wear_ >= 1.0;
    r_.brakes = r_.brakes_failed ? 0.0 : 1.0 - 0.7 * brake_wear_;
}

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

// A wheel that is gone leaves hub and brake disc on the road: steel on asphalt, about a third of a tyre's grip.
double DamageModel::grip_factor(int w) const { return wheel_off(w) ? p_.wheel_off_grip : 1.0 - 0.1 * r_.wheel[w]; }

}  // namespace rs
