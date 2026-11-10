// Crash damage: impacts in, crush depth per zone and physical consequences out.
//
// ENERGY. A body of mass m receiving impulse J loses kinetic energy  E = J^2 / (2 m)  (exact for a
// full stop against a rigid wall). Impulses arrive over several physics ticks, so they are summed
// per "crash event" (same object, < 0.15 s apart) and damage is charged on the energy INCREMENT.
// Contact forces below 3 g are pushing/scraping, not crashing, and are ignored.
//
// TWO LAYERS.
//  1. PANELS (what you see): crush depth per zone from ALL the energy the zone took,
//       x = sqrt(2 E / k),  k ~ 1.0 MN/m front/rear, softer sides.
//     Bumpers, lights, dents and a little drag. Scrapes and bumps add up here and nowhere else.
//  2. STRUCTURE (what breaks the car): only the part of a crash above what bumper, crash boxes and
//     crumple zone are built to take. Per event, with dv = J / m the speed change so far, the
//     energy increment is weighted by  w(dv) = clamp((dv - lo) / (hi - lo), 0, 1):
//       structural band  lo = 9 m/s (32 km/h), hi = 18 m/s (65 km/h)
//       wheel band       lo = 5 m/s (18 km/h), hi = 11 m/s (40 km/h)   (suspension arms are weaker)
//     so a hit below `lo` never reaches engine, cabin or suspension however often it happens, and a
//     hit above `hi` counts in full. All structural energies are per kg of car (J/kg = kJ/t), which
//     makes the thresholds speeds, not masses. For one full stop against a wall from speed v the
//     structural energy is  v^2 / 2 - 94.5  kJ/t  (v >= 65 km/h):
//        60 km/h   46      80 km/h  152     100 km/h  291     130 km/h  557     150 km/h  774
//     ENGINE  0 at 150, wrecked at 600 kJ/t reaching the engine bay (front hits in full, others 25 %):
//        one 80 km/h wall leaves it intact, 100 km/h costs ~30 %, ~130 km/h wrecks it.
//     CABIN   300 kJ/t into one side (a ~100 km/h slide into a wall, or several 70 km/h ones).
//     WHEELS  75 kJ/t (wheel band) of direct hits tears a wheel off; a heavy crash also loads the
//        wheels of the zone it lands in (15 % of the structural energy), so the wreck that kills the
//        engine takes the front wheels with it.
//
// NEVER IMMOVABLE (game rule). "Totaled" is a report flag (race DNF, HUD), not a dead car: the
// engine keeps a limp-home floor of limp_power and the controls are never cut, so the player can
// always crawl forward (or reverse) after any amount of damage. R repairs.
//
// OVERHEATING, FIRE, BRAKES. Severity s = max(engine damage, total structural energy / severity).
//   s >= overheat_severity  the cooling system is gone: steam builds over smoulder_s and stays.
//   s >= fire_severity      (a wreck) once it is steaming fully it catches; flames grow over fire_grow_s.
// Crash damage alone hardly touches the brakes; a fire under the car does (pads glaze, fluid boils):
//   d(wear)/dt = max(0, s - fade_severity) / (1 - fade_severity) / fade_damage_s + fire / fade_fire_s
//   brake effectiveness = 1 - 0.7 wear   while wear < 1   (fade: down to 30 %)
//                       = 0               once wear >= 1  (fluid boiled: pedal to the floor)
// Hot-disc fade from hard braking is a separate model (Vehicle, brake_pad_mu).
// No explosion. Everything resets on repair.
#pragma once
#include <array>
#include <cstdint>
#include <map>
#include <string>
#include "rs/math.hpp"

namespace rs {

enum DamageZone { ZoneFront = 0, ZoneRear = 1, ZoneLeft = 2, ZoneRight = 3 };

struct DamageParams {
    // ---- panels (visible crush)
    double stiffness_front_rear = 1.0e6;   // N/m (crash-test calibrated, see above)
    double stiffness_side = 0.35e6;        // N/m
    double front_max = 0.65;               // m of front crush for "zone fully crushed"
    double side_max = 0.40;                // m of side crush for "zone fully crushed"
    double rear_max = 0.70;                // m of rear crush for "zone fully crushed"
    double min_impulse = 600.0;            // N s ignored per event (~1.5 km/h dv)
    double min_force_g = 3.0;              // per-tick contact force below this is not a crash
    // ---- structure (energies in kJ per tonne = J/kg)
    double heavy_dv_lo = 9.0;              // m/s: an event below this speed change does no structural damage
    double heavy_dv_hi = 18.0;             // m/s: above this all further energy is structural
    double engine_start = 150.0;           // structural energy in the engine bay before the engine is touched
    double engine_full = 600.0;            // ...at which it is wrecked
    double engine_other_share = 0.25;      // share of rear / side structural energy that reaches the engine
    double cabin_total = 300.0;            // structural energy into one side: car totaled (cabin intrusion)
    double wheel_dv_lo = 5.0;              // m/s, wheel band (suspension arms bend before the shell does)
    double wheel_dv_hi = 11.0;
    double wheel_energy = 75.0;            // wheel-band energy into one wheel that tears it off
    double wheel_radius_m = 0.7;           // impacts this close (plan view) to a wheel hit it directly
    double wheel_zone_share = 0.15;        // share of a zone's structural energy carried by each of its wheels
    double wheel_off = 0.95;               // wheel damage from which the wheel is gone
    double wheel_off_grip = 0.35;          // grip left at that corner (hub and disc on the road)
    double max_toe_deg = 1.5;              // bent steering arm at a destroyed wheel
    double totaled_engine = 0.9;           // engine damage at which the car is totaled
    double limp_power = 0.25;              // engine power floor: the car can ALWAYS drive on
    double severity = 1200.0;              // total structural energy that counts as "wrecked" (s = 1)
    // ---- overheating, fire, brakes
    double overheat_severity = 0.5;        // cooling system gone: steam
    double fire_severity = 0.9;            // a wreck: the steaming engine bay catches fire
    double smoulder_s = 20.0;              // steam builds this long (and precedes any flames)
    double fire_grow_s = 45.0;             // flames grow from nothing to full over this
    double fade_severity = 0.9;            // crash damage starts to cost brakes above this severity
    double fade_damage_s = 240.0;          // s to brake failure from damage alone at s = 1
    double fade_fire_s = 40.0;             // s to brake failure in a full fire (adds to damage)
};

struct DamageReport {
    std::array<double, 4> crush{};     // m of crush per zone (front, rear, left, right)
    std::array<double, 4> zone{};      // 0..1 = crush relative to "fully crushed" for that zone
    std::array<double, 4> wheel{};     // 0..1 per wheel (FL, FR, RL, RR)
    double engine = 0;                 // 0..1
    double total_energy_kj = 0;        // every crash, scrapes included
    double structural_kj_per_t = 0;    // the part that reached the structure (see TWO LAYERS)
    double last_impact_kj = 0;         // size of the most recent crash event so far
    Vec3 last_impact_point;            // body frame
    int last_zone = 0;
    int impacts = 0;                   // crash events that caused damage
    bool totaled = false;
    std::string totaled_reason;        // "engine", "cabin", "wheels", "structure"
    double smoulder = 0;               // 0..1 steam from a cooked engine (overheating); at 1 a wreck ignites
    double fire = 0;                   // 0 = no fire, (0..1] flame size (grows over time)
    double brakes = 1;                 // brake effectiveness 1..0.3, 0 once failed
    bool brakes_failed = false;
};

class DamageModel {
public:
    DamageModel(double mass, std::array<Vec3, 4> wheel_positions_body, DamageParams p = {})
        : mass_(mass), wheels_(wheel_positions_body), p_(p) {}

    // One contact for one physics tick. point in the BODY frame, impulse in N s, object_id
    // identifies the other object, time = simulation time, dt = tick length.
    void add_contact(std::uint64_t object_id, const Vec3& point_body, double impulse, double time, double dt);

    const DamageReport& report() const { return r_; }
    const DamageParams& params() const { return p_; }
    void repair() { r_ = DamageReport{}; events_.clear(); zone_energy_ = {}; zone_heavy_ = {}; brake_wear_ = 0; }
    // Time-driven effects (fire, brake fade). Call once per physics tick.
    void update(double dt);
    double severity() const;                    // 0..1, see OVERHEATING, FIRE, BRAKES above

    // Physical consequences (fed into Vehicle each tick):
    double engine_power_factor() const;         // 1 .. 0.3 from engine damage, never below limp_power
    double drag_factor() const;                 // 1 .. 1.3 (crumpled body, open panels)
    double suspension_factor(int wheel) const;  // 1 .. 0.6 spring stiffness
    bool wheel_off(int wheel) const { return r_.wheel[wheel] >= p_.wheel_off; }
    double toe_offset(int wheel) const;         // rad, bent steering/suspension arm
    double grip_factor(int wheel) const;        // 1 .. 0.9 (misaligned tyre); wheel_off_grip once the wheel is gone
    double brake_factor() const { return r_.brakes; }   // 1 .. 0 (fade, then failure)

private:
    struct Event { double j_acc = 0, last_time = -1; };
    double mass_;
    std::array<Vec3, 4> wheels_;
    DamageParams p_;
    DamageReport r_;
    std::array<double, 4> zone_energy_{};   // J absorbed per zone (panels)
    std::array<double, 4> zone_heavy_{};    // J/kg of structural energy per zone
    std::map<std::uint64_t, Event> events_;
    double brake_wear_ = 0;                 // 0..1, 1 = brakes failed
};

}  // namespace rs
