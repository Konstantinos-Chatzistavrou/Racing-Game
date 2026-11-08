// Race rules: progress along the route, laps, lap times, positions. Engine-neutral game logic.
#pragma once
#include <string>
#include <vector>
#include "rs/route.hpp"

namespace rs {

struct RaceProgress {
    double distance = 0;          // total distance covered along the route since the start, m
    int lap = 0;                  // completed laps
    double lap_start_time = 0;
    double last_lap = 0, best_lap = 0;
    bool finished = false;
    double finish_time = 0;
    int position = 0;             // 1 = leading
    int hint = -1;                // route search hint
    double last_s = 0;
    Vec3 last_pos{};              // for the distance moved between updates (route projection window)
    double stuck_time = 0;        // s spent upside down / immobile
    bool dnf = false;             // out of the race: no restarts (street race / multiplayer rules)
    std::string dnf_reason;       // "totaled (engine|cabin|wheels)", "rolled over", "stuck"
    double dnf_time = 0;
};

class RaceTracker {
public:
    RaceTracker(const Route& route, int laps) : route_(route), laps_(laps) {}
    int add_car(const Vec3& start_position);    // returns car index
    void update(int car, const Vec3& position, double time);
    void rank();                                 // recompute positions (call once per tick)
    // Out-of-race rule (no restarts): totaled -> DNF; on its roof for 5 s -> DNF "rolled over";
    // unable to move for 30 s -> DNF "stuck". Returns true on the tick the car is ruled out.
    bool check_out(int car, bool totaled, const std::string& totaled_reason, bool upside_down,
                   double speed, double dt, double time);
    bool all_done() const;                       // every car finished or DNF
    const RaceProgress& progress(int car) const { return cars_[car]; }
    int laps() const { return laps_; }
    int car_count() const { return (int)cars_.size(); }

private:
    const Route& route_;
    int laps_;
    std::vector<RaceProgress> cars_;
};

}  // namespace rs
