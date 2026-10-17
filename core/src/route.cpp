#include "rs/route.hpp"
#include <cmath>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include "nlohmann/json.hpp"

namespace rs {

Route Route::from_samples(std::vector<RouteSample> s, bool closed) {
    if (s.size() < 3) throw std::runtime_error("route: needs at least 3 samples");
    Route r;
    r.closed_ = closed;
    // Recompute distances so s is always consistent with the points.
    s[0].s = 0;
    for (size_t i = 1; i < s.size(); ++i) s[i].s = s[i - 1].s + rs::length(s[i].p - s[i - 1].p);
    r.length_ = s.back().s + (closed ? rs::length(s.front().p - s.back().p) : 0.0);
    r.s_ = std::move(s);
    return r;
}

Route Route::load(const std::string& path) {
    std::ifstream f(path);
    if (!f) throw std::runtime_error("route: cannot open " + path);
    std::stringstream ss;
    ss << f.rdbuf();
    nlohmann::json j = nlohmann::json::parse(ss.str());
    if (j.value("schema", "") != "route/1") throw std::runtime_error("route: expected schema route/1 in " + path);
    std::vector<RouteSample> v;
    for (const auto& e : j.at("samples")) {
        RouteSample r;
        r.p = {e.at("x").get<double>(), e.at("y").get<double>(), e.at("z").get<double>()};
        r.heading = e.at("heading").get<double>();
        r.curvature = e.at("curvature").get<double>();
        r.width_left = e.value("width_left", 3.5);
        r.width_right = e.value("width_right", 3.5);
        v.push_back(r);
    }
    return from_samples(std::move(v), j.value("closed", true));
}

double Route::wrap(double s) const {
    if (!closed_) return clamp(s, 0.0, length_);
    s = std::fmod(s, length_);
    return s < 0 ? s + length_ : s;
}

double Route::delta(double from, double to) const {
    double d = to - from;
    if (closed_) {
        d = std::fmod(d, length_);
        if (d > 0.5 * length_) d -= length_;
        if (d < -0.5 * length_) d += length_;
    }
    return d;
}

Route::Projection Route::project(const Vec3& p, int hint) const {
    const int n = (int)s_.size();
    int lo = 0, hi = n - 1;
    if (hint >= 0) { lo = hint - 60; hi = hint + 60; }
    Projection best;
    double best_d2 = 1e300;
    for (int k = lo; k <= hi; ++k) {
        int i = closed_ ? ((k % n) + n) % n : std::max(0, std::min(n - 1, k));
        int j = closed_ ? (i + 1) % n : std::min(n - 1, i + 1);
        if (i == j) continue;
        // closest point on segment i->j, in the horizontal plane
        Vec3 a = s_[i].p, b = s_[j].p;
        Vec3 ab{b.x - a.x, b.y - a.y, 0}, ap{p.x - a.x, p.y - a.y, 0};
        double len2 = dot(ab, ab);
        double t = len2 > 0 ? clamp(dot(ap, ab) / len2, 0.0, 1.0) : 0.0;
        Vec3 q = ap - ab * t;
        double d2 = dot(q, q);
        if (d2 < best_d2) {
            best_d2 = d2;
            double seg = std::sqrt(len2);
            best.s = wrap(s_[i].s + t * seg);
            best.index = i;
            best.lateral = (ab.x * ap.y - ab.y * ap.x) / std::max(seg, 1e-9);   // 2D cross: + = left
        }
    }
    return best;
}

RouteSample Route::at(double s) const {
    s = wrap(s);
    // binary search for the segment containing s
    int lo = 0, hi = (int)s_.size() - 1;
    while (hi - lo > 1) {
        int mid = (lo + hi) / 2;
        (s_[mid].s <= s ? lo : hi) = mid;
    }
    int i = s >= s_.back().s ? (int)s_.size() - 1 : lo;
    int j = closed_ ? (i + 1) % (int)s_.size() : std::min(i + 1, (int)s_.size() - 1);
    double s0 = s_[i].s, s1 = (j == 0) ? length_ : s_[j].s;
    double t = s1 > s0 ? clamp((s - s0) / (s1 - s0), 0.0, 1.0) : 0.0;
    RouteSample r = s_[i];
    r.s = s;
    r.p = s_[i].p + (s_[j].p - s_[i].p) * t;
    r.curvature = lerp(s_[i].curvature, s_[j].curvature, t);
    r.width_left = lerp(s_[i].width_left, s_[j].width_left, t);
    r.width_right = lerp(s_[i].width_right, s_[j].width_right, t);
    double dh = std::remainder(s_[j].heading - s_[i].heading, 2 * kPi);
    r.heading = s_[i].heading + dh * t;
    return r;
}

Vec3 Route::tangent(double s) const {
    double h = at(s).heading;
    return {std::cos(h), std::sin(h), 0};
}

Vec3 Route::left(double s) const {
    double h = at(s).heading;
    return {-std::sin(h), std::cos(h), 0};
}

}  // namespace rs
