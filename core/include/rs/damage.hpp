// Crash damage: impacts in, crush depth per zone and physical consequences out.
//
// ENERGY. A body of mass m receiving impulse J loses kinetic energy  E = J^2 / (2 m)  (exact for a
// full stop against a rigid wall). Impulses arrive over several physics ticks, so they are summed
// per "crash event" (same object, < 0.15 s apart) and damage is charged on the energy INCREMENT.
// Contact forces below 3 g are pushing/scraping, not crashing, and are ignored.
//
// CRUSH. Car structure behaves roughly like a spring in a crash: absorbed energy  E = 1/2 k x^2,
// so crush depth  x = sqrt(2 E / k).  Energies of successive hits on the same zone add:
//   x_new = sqrt(x_old^2 + 2 dE / k).
// k ~ 1.0 MN/m front/rear matches crash tests (56 km/h full frontal, ~175 kJ -> ~0.6 m crush);
// sides are softer with far less room before the cabin.
//   front: bumper/lights 0-0.15 m, radiator 0.15-0.35 m, ENGINE from 0.35 m (wrecked by 0.65 m)
//   side:  doors; cabin intrusion from 0.25 m, car totaled at 0.40 m (no one drives on after that)
//
// NEVER IMMOVABLE (game rule). "Totaled" is a report flag (race DNF, HUD), not a dead car: the
// engine keeps a limp-home floor of limp_power and the controls are never cut, so the player can
// always crawl forward (or reverse) after any amount of damage. R repairs.
//
// FIRE AND BRAKES. Severity s = max(engine damage, total crash energy / severity_kj). From
// s >= fire_severity the engine bay smoulders (smoke only) for smoulder_s, then catches fire;
// the flames grow 0 -> 1 over fire_grow_s. Heat cooks the brakes (pads glaze, fluid boils):
//   d(wear)/dt = max(0, s - fade_severity) / (1 - fade_severity) / fade_damage_s + fire / fade_fire_s
//   brake effectiveness = 1 - 0.7 wear   while wear < 1   (fade: down to 30 %)
//                       = 0               once wear >= 1  (fluid boiled: pedal to the floor)
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
    double stiffness_front_rear = 1.0e6;   // N/m (crash-test calibrated, see above)
    double stiffness_side = 0.35e6;        // N/m
    double engine_start = 0.35;            // m of front crush before the engine bay is reached
    double engine_full = 0.65;             // m: engine wrecked
    double cabin_total = 0.40;             // m of side crush: car totaled (cabin intrusion)
    double rear_max = 0.70;                // m of rear crush for "zone fully crushed"
    double wheel_energy_kj = 40.0;         // energy into one wheel that wrecks its suspension
    double wheel_radius_m = 0.7;           // impacts this close (plan view) to a wheel hit it
    double min_impulse = 600.0;            // N s ignored per event (~1.5 km/h dv)
    double min_force_g = 3.0;              // per-tick contact force below this is not a crash
    double max_toe_deg = 1.5;              // bent steering arm at a destroyed wheel
    double totaled_engine = 0.9;           // engine damage at which the car is totaled
    double limp_power = 0.25;              // engine power floor: the car can ALWAYS drive on
    double severity_kj = 900.0;            // total crash energy that counts as "wrecked" (s = 1)
    double fire_severity = 0.6;            // severity at which the engine bay starts to smoulder
    double smoulder_s = 10.0;              // smoke-only phase before flames
    double fire_grow_s = 45.0;             // flames grow from nothing to full over this
    double fade_severity = 0.5;            // brakes start to fade above this severity
    double fade_damage_s = 90.0;           // s to brake failure from damage alone at s = 1
    double fade_fire_s = 25.0;             // s to brake failure in a full fire (adds to damage)
};

struct DamageReport {
    std::array<double, 4> crush{};     // m of crush per zone (front, rear, left, right)
    std::array<double, 4> zone{};      // 0..1 = crush relative to "fully crushed" for that zone
    std::array<double, 4> wheel{};     // 0..1 per wheel (FL, FR, RL, RR)
    double engine = 0;                 // 0..1
    double total_energy_kj = 0;
    double last_impact_kj = 0;         // size of the most recent crash event so far
    Vec3 last_impact_point;            // body frame
    int last_zone = 0;
    int impacts = 0;                   // crash events that caused damage
    bool totaled = false;
    std::string totaled_reason;        // "engine", "cabin", "wheels"
    double smoulder = 0;               // 0..1 progress of the smoke phase before ignition
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
    void repair() { r_ = DamageReport{}; events_.clear(); zone_energy_ = {}; brake_wear_ = 0; }
    // Time-driven effects (fire, brake fade). Call once per physics tick.
    void update(double dt);
    double severity() const;                    // 0..1, see FIRE AND BRAKES above

    // Physical consequences (fed into Vehicle each tick):
    double engine_power_factor() const;         // 1 .. 0.3 from engine damage, never below limp_power
    double drag_factor() const;                 // 1 .. 1.3 (crumpled body, open panels)
    double suspension_factor(int wheel) const;  // 1 .. 0.6 spring stiffness
    double toe_offset(int wheel) const;         // rad, bent steering/suspension arm
    double grip_factor(int wheel) const;        // 1 .. 0.9 (misaligned tyre)
    double brake_factor() const { return r_.brakes; }   // 1 .. 0 (fade, then failure)

private:
    struct Event { double j_acc = 0, last_time = -1; };
    double mass_;
    std::array<Vec3, 4> wheels_;
    DamageParams p_;
    DamageReport r_;
    std::array<double, 4> zone_energy_{};   // J absorbed per zone
    std::map<std::uint64_t, Event> events_;
    double brake_wear_ = 0;                 // 0..1, 1 = brakes failed
};

}  // namespace rs
