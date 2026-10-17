// AI street racer. Produces the same RawInput a human would (as a "wheel" device), so it drives
// the exact same physics, assists and gearbox as the player.
//
// Behaviour:
//  - Path: pure pursuit on the route centreline + a lateral lane offset.
//  - Speed: curvature speed profile v = sqrt(a_lat / |k|), with braking (backward pass) and
//    power-limited acceleration (forward pass), all scaled by skill.
//  - Traffic: reacts to the nearest car ahead in its corridor, but sees it with a REACTION DELAY
//    (a queue of past perceptions). Keeps a time headway and compares stopping distances: the
//    room it has is  gap + v_lead^2 / (2 a_lead), the deceleration it needs is  v^2 / (2 room).
//    Above its panic threshold it brakes fully, and swerves if there is road to the side.
//    On narrow streets there is often no room: that is how pile-ups happen.
//  - Recovery: if stuck against something, reverses briefly and tries again.
#pragma once
#include <deque>
#include <vector>
#include "rs/config.hpp"
#include "rs/controls.hpp"
#include "rs/route.hpp"
#include "rs/vehicle.hpp"

namespace rs {

struct OtherCar {
    Vec3 position;        // world, CG
    Vec3 velocity;        // world
    double length = 4.5, width = 1.9;
};

struct AIParams {
    double skill = 0.95;           // fraction of the car's grip/braking the AI dares to use
    double reaction_time = 0.4;    // s, delay before it perceives what the car ahead does
    double headway = 0.6;          // s, following distance it tries to keep at speed
    double lane_offset = 0.0;      // m, preferred lateral position (+ = left of centreline)
    double aggression = 0.5;       // 0..1: how late it brakes for traffic, how hard it swerves
};

struct AIOutput {
    RawInput raw;
    int gear_request = -1;         // >= 0: put the gearbox in this gear (reverse recovery)
};

class AIDriver {
public:
    AIDriver(const CarConfig& cfg, const Route& route, AIParams p);
    AIOutput update(const ChassisState& s, const VehicleOutput& last, const std::vector<OtherCar>& others, double dt);

    // telemetry
    double route_s = 0, target_speed = 0, gap_ahead = 1e9;
    bool braking_for_traffic = false, recovering = false;
    double speed_profile(double s) const;

private:
    struct Seen { double time, gap, closing, v_other; };
    const CarConfig& cfg_;
    const Route& route_;
    AIParams p_;
    std::vector<double> vprof_;
    int hint_ = -1;
    double time_ = 0, stuck_t_ = 0, reverse_t_ = 0, avoid_ = 0;
    double a_other_ = 0;                 // estimated deceleration of the car ahead (perceived)
    double prev_seen_t_ = -1, prev_seen_v_ = 0;
    std::deque<Seen> seen_;
};

}  // namespace rs
