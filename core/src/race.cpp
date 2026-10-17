#include "rs/race.hpp"
#include <algorithm>
#include <cmath>

namespace rs {

int RaceTracker::add_car(const Vec3& start) {
    RaceProgress p;
    Route::Projection pr = route_.project(start);
    p.hint = pr.index;
    p.last_s = pr.s;
    // Cars on the grid behind the start line start with a small negative distance.
    p.distance = route_.delta(0.0, pr.s);
    cars_.push_back(p);
    return (int)cars_.size() - 1;
}

void RaceTracker::update(int car, const Vec3& pos, double time) {
    RaceProgress& p = cars_[car];
    if (p.finished || p.dnf) return;
    Route::Projection pr = route_.project(pos, p.hint);
    double ds = route_.delta(p.last_s, pr.s);
    if (std::abs(ds) > 40.0) {                  // lost track (e.g. teleport/reset): re-acquire
        pr = route_.project(pos);
        ds = 0;
    }
    p.hint = pr.index;
    p.last_s = pr.s;
    int lap_before = (int)std::floor(p.distance / route_.length());
    p.distance += ds;
    int lap_now = (int)std::floor(p.distance / route_.length());
    if (lap_now > lap_before && lap_now >= 1 && lap_now > p.lap) {   // crossed the line forwards
        p.last_lap = time - p.lap_start_time;
        if (p.lap >= 1 || p.lap_start_time > 0) p.best_lap = p.best_lap > 0 ? std::min(p.best_lap, p.last_lap) : p.last_lap;
        else p.best_lap = p.last_lap;
        p.lap = lap_now;
        p.lap_start_time = time;
        if (p.lap >= laps_) {
            p.finished = true;
            p.finish_time = time;
        }
    }
}

bool RaceTracker::check_out(int car, bool totaled, const std::string& reason, bool upside_down,
                            double speed, double dt, double time) {
    RaceProgress& p = cars_[car];
    if (p.finished || p.dnf) return false;
    std::string why;
    if (totaled) why = "totaled (" + reason + ")";
    p.stuck_time = (upside_down || speed < 0.28) ? p.stuck_time + dt : 0.0;
    if (why.empty() && upside_down && p.stuck_time > 5.0) why = "rolled over";
    if (why.empty() && p.stuck_time > 30.0) why = "stuck";
    if (why.empty()) return false;
    p.dnf = true;
    p.dnf_reason = why;
    p.dnf_time = time;
    return true;
}

bool RaceTracker::all_done() const {
    for (const RaceProgress& p : cars_)
        if (!p.finished && !p.dnf) return false;
    return !cars_.empty();
}

void RaceTracker::rank() {
    std::vector<int> order(cars_.size());
    for (size_t i = 0; i < order.size(); ++i) order[i] = (int)i;
    // Finished cars first (by finish time), then by distance covered.
    std::sort(order.begin(), order.end(), [&](int a, int b) {
        const RaceProgress &pa = cars_[a], &pb = cars_[b];
        // finished (by time) > still racing (by distance) > DNF (by distance covered)
        if (pa.finished != pb.finished) return pa.finished;
        if (pa.finished) return pa.finish_time < pb.finish_time;
        if (pa.dnf != pb.dnf) return !pa.dnf;
        return pa.distance > pb.distance;
    });
    for (size_t k = 0; k < order.size(); ++k) cars_[order[k]].position = (int)k + 1;
}

}  // namespace rs
