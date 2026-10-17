#include "rs/ai.hpp"
#include <cmath>

namespace rs {

AIDriver::AIDriver(const CarConfig& cfg, const Route& route, AIParams p) : cfg_(cfg), route_(route), p_(p) {
    // Peak engine power from the torque curve: P = max(T w), w = rpm * 2 pi / 60.
    double p_max = 0;
    for (const auto& pt : cfg.engine.torque_curve) p_max = std::max(p_max, pt[1] * pt[0] * 2 * kPi / 60.0);
    p_max *= cfg.drivetrain.efficiency;
    const double mu = std::min(cfg.tire_front.mu_y, cfg.tire_rear.mu_y);
    const double a_lat = p_.skill * 0.82 * mu * kGravity;   // street margin: kerbs and walls, not run-off
    const double a_brake = p_.skill * 0.85 * cfg.tire_front.mu_x * kGravity;
    const auto& rs = route.samples();
    const int n = (int)rs.size();
    vprof_.resize(n);
    // cornering limit:  v^2 |k| <= a_lat
    // Narrow streets are taken more carefully (walls a metre away): grip used scales with width,
    // from 70 % in a 4.6 m alley to 100 % on roads 8 m wide or more.
    for (int i = 0; i < n; ++i) {
        double width_factor = clamp((rs[i].width_left + rs[i].width_right - 2.0) / 6.0, 0.7, 1.0);
        vprof_[i] = std::min(75.0, std::sqrt(a_lat * width_factor / std::max(std::abs(rs[i].curvature), 1e-4)));
    }
    for (int pass = 0; pass < 2; ++pass) {
        // braking: v_i^2 <= v_{i+1}^2 + 2 a ds   (backward)
        for (int k = n - 1; k >= 0; --k) {
            int j = (k + 1) % n;
            if (!route.closed() && j == 0) continue;
            double ds = (j == 0 ? route.length() : rs[j].s) - rs[k].s;
            vprof_[k] = std::min(vprof_[k], std::sqrt(vprof_[j] * vprof_[j] + 2 * a_brake * ds));
        }
        // acceleration, power limited: a = min(0.8 g, P / (m v))   (forward)
        for (int k = 0; k < n; ++k) {
            int i = (k - 1 + n) % n;
            if (!route.closed() && k == 0) continue;
            double ds = (k == 0 ? route.length() : rs[k].s) - rs[i].s;
            double a = std::min(0.8 * kGravity, p_max / (cfg.mass * std::max(vprof_[i], 5.0)));
            vprof_[k] = std::min(vprof_[k], std::sqrt(vprof_[i] * vprof_[i] + 2 * a * ds));
        }
    }
}

double AIDriver::speed_profile(double s) const {
    const auto& rs = route_.samples();
    int lo = 0, hi = (int)rs.size() - 1;
    double w = route_.wrap(s);
    while (hi - lo > 1) {
        int mid = (lo + hi) / 2;
        (rs[mid].s <= w ? lo : hi) = mid;
    }
    return vprof_[lo];
}

AIOutput AIDriver::update(const ChassisState& s, const VehicleOutput& last, const std::vector<OtherCar>& others, double dt) {
    AIOutput out;
    out.raw.device = InputDevice::Wheel;
    time_ += dt;
    const Vec3 fwd = s.orientation.rotate({1, 0, 0});
    const double v = dot(s.velocity, fwd);
    Route::Projection pr = route_.project(s.position, hint_);
    hint_ = pr.index;
    route_s = pr.s;

    // ---- perception of the nearest car ahead (recorded now, used delayed by the reaction time)
    // Judged in ROUTE space: "ahead" means further along the route, not in front of our bonnet,
    // so it works through 90-degree junctions. A car counts if it overlaps our lane, or if the
    // road between us narrows so two cars can't pass side by side (lanes merge: rear car yields).
    Seen now{time_, 1e9, 0, 0};
    for (const OtherCar& o : others) {
        if (length(o.position - s.position) > 100) continue;
        Route::Projection op = route_.project(o.position, hint_);
        double ahead = route_.delta(pr.s, op.s);
        if (ahead < 0.5 || ahead > 90) continue;
        // Only things actually ON the road near that route point (not a parked car one street over
        // that happens to project onto a nearby route sample), and consistent with real distance.
        RouteSample at_o = route_.at(op.s);
        if (std::abs(op.lateral) > std::max(at_o.width_left, at_o.width_right) + 2.0) continue;
        if (length(o.position - s.position) > ahead + 12.0) continue;
        bool same_lane = std::abs(op.lateral - pr.lateral) < 0.5 * (1.9 + o.width) + 0.4;
        double narrowest = 1e9;
        for (double ds = 0; ds <= ahead + 10.0; ds += 5.0) {
            RouteSample r = route_.at(pr.s + ds);
            narrowest = std::min(narrowest, r.width_left + r.width_right);
        }
        bool merging = narrowest < 2.0 * 1.9 + 1.5;     // no room for two cars side by side
        if (!same_lane && !merging) continue;
        double gap = ahead - 0.5 * (4.5 + o.length);
        if (gap < now.gap) {
            double vo = dot(o.velocity, route_.tangent(op.s));
            double vme = dot(s.velocity, route_.tangent(pr.s));
            now = {time_, gap, vme - vo, vo};
        }
    }
    seen_.push_back(now);
    while (seen_.size() > 2 && seen_[1].time <= time_ - p_.reaction_time) seen_.pop_front();
    const Seen& p = seen_.front();          // what the driver has "noticed" so far
    gap_ahead = p.gap;

    // ---- target speed: route profile (looking a little ahead to absorb control lag)
    double target = std::min(speed_profile(pr.s), speed_profile(pr.s + std::max(v, 0.0) * 0.5));
    braking_for_traffic = false;
    // Deceleration of the car ahead, estimated from how its PERCEIVED speed changes (low-passed).
    if (p.gap < 1e8 && prev_seen_t_ >= 0 && p.time > prev_seen_t_) {
        double a_meas = (prev_seen_v_ - p.v_other) / (p.time - prev_seen_t_);
        a_other_ += (a_meas - a_other_) * std::min(1.0, (p.time - prev_seen_t_) / 0.15);
    } else if (p.gap >= 1e8) {
        a_other_ = 0;
    }
    prev_seen_t_ = p.gap < 1e8 ? p.time : -1;
    prev_seen_v_ = p.v_other;
    if (p.gap < 1e8) {
        // Car following: hold gap = 4 m + headway * v_other.
        double desired = 4.0 + p_.headway * std::max(p.v_other, 0.0);
        double v_follow = std::max(0.0, p.v_other + 0.8 * (p.gap - desired));
        target = std::min(target, v_follow);
        // Stopping-distance check: room = gap + v_o^2 / (2 a_o) - margin; needed a = v^2 / (2 room).
        double vo = std::max(p.v_other, 0.0);
        double lead_stop = a_other_ > 0.5 ? vo * vo / (2.0 * a_other_) : 1e3;
        double room = std::max(p.gap + lead_stop - 2.0, 0.3);
        double vme = std::max(v, 0.0);
        double a_req = std::max(vme * vme / (2.0 * room),
                                p.closing > 0 ? p.closing * p.closing / (2.0 * std::max(p.gap - 1.5, 0.3)) : 0.0);
        double panic = 2.0 + 4.0 * p_.aggression;           // aggressive drivers brake later
        if (a_req > panic || p.gap < 2.0) {
            braking_for_traffic = true;
            target = 0;
        }
        // Swerve if there is road to the side and braking alone won't do.
        if (a_req > 6.0) {
            RouteSample rs = route_.at(pr.s);
            double room_l = rs.width_left - (pr.lateral) - 1.3;
            double room_r = rs.width_right + (pr.lateral) - 1.3;
            double dir = room_l > room_r ? 1.0 : -1.0;
            if (std::max(room_l, room_r) > 1.0) avoid_ += dir * 3.0 * dt;
        }
    }
    if (!braking_for_traffic) avoid_ -= sign(avoid_) * std::min(std::abs(avoid_), 0.6 * dt);
    target_speed = target;

    // ---- steering: pure pursuit to a point Ld ahead on the offset centreline
    double ld = clamp(3.5 + 0.4 * std::max(v, 0.0), 5.0, 30.0);   // short at low speed: less corner cutting
    RouteSample ahead = route_.at(pr.s + ld);
    double lat = clamp(p_.lane_offset + avoid_, -(ahead.width_right - 1.2), ahead.width_left - 1.2);
    Vec3 tp = ahead.p + route_.left(pr.s + ld) * lat;
    Vec3 local = s.orientation.inv_rotate(tp - s.position);
    double eta = std::atan2(local.y, local.x);
    double delta = std::atan(2.0 * cfg_.wheelbase * std::sin(eta) / ld);
    double lock = cfg_.front.max_steer_deg * kPi / 180.0;
    out.raw.steer = clamp(delta / lock, -1.0, 1.0);

    // ---- pedals: desired acceleration proportional to the speed error
    double a_des = clamp(1.5 * (target - v), -10.0, 8.0);
    if (braking_for_traffic && target <= 0.0) {
        out.raw.brake = 1.0;
    } else if (a_des >= 0) {
        out.raw.throttle = clamp(a_des / 4.0 + (v > 5 ? 0.1 : 0.3), 0.0, 1.0);
    } else {
        out.raw.brake = clamp(-a_des / 9.0, 0.0, 1.0);
    }

    // ---- recovery: stuck against a wall / wreck -> reverse for a moment
    if (recovering) {
        reverse_t_ -= dt;
        out.raw.throttle = 0.6;
        out.raw.brake = 0;
        out.raw.steer = -out.raw.steer;          // back out the other way
        if (reverse_t_ <= 0) {
            recovering = false;
            out.gear_request = 2;
        }
        return out;
    }
    if (std::abs(v) < 0.7 && out.raw.throttle > 0.3 && !braking_for_traffic) stuck_t_ += dt;
    else stuck_t_ = 0;
    if (stuck_t_ > 2.0) {
        recovering = true;
        reverse_t_ = 1.6;
        stuck_t_ = 0;
        out.gear_request = 0;
    }
    (void)last;
    return out;
}

}  // namespace rs
