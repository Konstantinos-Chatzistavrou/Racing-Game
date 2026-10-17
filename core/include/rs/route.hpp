// Race route: an ordered centreline through the street network (engine-neutral JSON "route/1").
// Used by the AI driver (where to drive) and the race tracker (progress, laps, positions).
#pragma once
#include <string>
#include <vector>
#include "rs/math.hpp"

namespace rs {

struct RouteSample {
    double s = 0;              // distance along the route, m
    Vec3 p;                    // centreline point (world, Z-up)
    double heading = 0;        // rad, direction of travel in the XY plane
    double curvature = 0;      // 1/m, + = turning left
    double width_left = 3.5;   // m of drivable road to the left of the centreline
    double width_right = 3.5;  // ... to the right
};

class Route {
public:
    static Route load(const std::string& path);                 // throws std::runtime_error
    static Route parse(const std::string& json_text);           // same, from JSON text (web build)
    static Route from_samples(std::vector<RouteSample> s, bool closed);

    struct Projection {
        double s = 0;          // distance along the route of the closest point
        double lateral = 0;    // signed offset from the centreline, + = left
        int index = 0;         // sample index (use as the next search hint)
    };
    // Closest point on the route. hint >= 0 limits the search to a window around it (fast,
    // and avoids jumping to another street that happens to pass close by).
    Projection project(const Vec3& p, int hint = -1) const;
    RouteSample at(double s) const;       // linear interpolation, wraps if closed
    Vec3 tangent(double s) const;
    Vec3 left(double s) const;            // horizontal unit vector to the left of travel

    double length() const { return length_; }
    bool closed() const { return closed_; }
    const std::vector<RouteSample>& samples() const { return s_; }
    double wrap(double s) const;          // into [0, length) for closed routes
    double delta(double from, double to) const;   // shortest signed distance along a closed route

private:
    std::vector<RouteSample> s_;
    bool closed_ = true;
    double length_ = 0;
};

}  // namespace rs
