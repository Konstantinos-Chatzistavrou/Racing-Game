#include "rs/vehicle.hpp"
#include <cmath>

namespace rs {

namespace {
std::array<Vec3, 4> wheel_points(const CarConfig& c) {
    std::array<Vec3, 4> p;
    for (int w = 0; w < 4; ++w) p[w] = {c.wheels[w].x, c.wheels[w].y, 0};
    return p;
}
}  // namespace

Vehicle::Vehicle(const CarConfig& cfg)
    : cfg_(cfg), damage_model_(cfg.mass, wheel_points(cfg)), drivetrain_(cfg_) {}

void Vehicle::add_contact(std::uint64_t id, const Vec3& point_body, double impulse) {
    if (damage_enabled) damage_model_.add_contact(id, point_body, impulse, time_, last_dt_);
}

void Vehicle::reset_motion(double v, int gear) {
    for (int w = 0; w < 4; ++w) {
        drivetrain_.wheel_omega[w] = v / cfg_.tire(w).radius;
        kappa_[w] = tan_alpha_[w] = 0;
    }
    const auto& g = cfg_.drivetrain.gear_ratios;
    if (gear >= 0 && gear < (int)g.size() && g[gear] != 0.0) {
        double idle_w = cfg_.engine.idle_rpm * 2.0 * kPi / 60.0;
        drivetrain_.engine_omega = std::max(idle_w, v / cfg_.tire(RL).radius * g[gear] * cfg_.drivetrain.final_drive);
        drivetrain_.stalled = false;
    }
    prev_axle_fy_ = {0, 0};
}

// Steering: input * max lock, with optional Ackermann geometry. For a turn of radius R (rear
// axle centre), ideal wheel angles are  tan(d_inner) = L / (R - t/2),  tan(d_outer) = L / (R + t/2),
// so the inner wheel turns more. `ackermann` blends from parallel (0) to ideal (1).
double Vehicle::steer_angle(int w) const {
    const AxleParams& ax = cfg_.axle(w);
    if (ax.max_steer_deg <= 0) return damage_.toe[w];
    double d = input_.steer * ax.max_steer_deg * kPi / 180.0 + damage_.toe[w];
    // Compliance steer: lateral force flexes bushings/rack and turns the wheels back toward
    // straight:  d_actual = d_cmd - c * Fy_axle.  A major source of road-car understeer.
    d -= ax.steer_compliance * prev_axle_fy_[w < 2 ? 0 : 1];
    if (std::abs(d) < 1e-6 || ax.ackermann <= 0) return d;
    double L = cfg_.wheelbase, t = ax.track;
    double R = L / std::tan(std::abs(d));
    bool left_wheel = (w % 2 == 0);
    bool inner = (d > 0) == left_wheel;               // turning left: left wheel is inner
    double ideal = std::atan(L / (inner ? R - 0.5 * t : R + 0.5 * t));
    return sign(d) * lerp(std::abs(d), ideal, ax.ackermann);
}

std::array<WheelRay, 4> Vehicle::wheel_rays(const ChassisState& s) const {
    std::array<WheelRay, 4> rays;
    Vec3 down = s.orientation.rotate({0, 0, -1});
    for (int w = 0; w < 4; ++w) {
        const WheelGeom& g = cfg_.wheels[w];
        rays[w].origin = s.position + s.orientation.rotate({g.x, g.y, g.mount_z});
        rays[w].direction = down;
        rays[w].length = cfg_.axle(w).spring_rest_length + cfg_.tire(w).radius;
    }
    return rays;
}

VehicleOutput Vehicle::update(const ChassisState& s, const std::array<WheelContact, 4>& contacts, double dt) {
    VehicleOutput out;
    time_ += dt;
    last_dt_ = dt;
    // ---- crash damage -> physical effects
    if (damage_enabled) {
        damage_model_.update(dt);
        const DamageModel& dm = damage_model_;
        damage_.brakes = dm.brake_factor();
        damage_.engine_power = dm.engine_power_factor();
        damage_.aero_drag = dm.drag_factor();
        for (int w = 0; w < 4; ++w) {
            damage_.suspension_stiffness[w] = dm.suspension_factor(w);
            damage_.toe[w] = dm.toe_offset(w);
            damage_.grip[w] = dm.grip_factor(w);
        }
    }
    out.damage = damage_model_.report();
    const Vec3 up = s.orientation.rotate({0, 0, 1});
    const std::array<WheelRay, 4> rays = wheel_rays(s);

    // ------------------------------------------------------------------ suspension
    // Compression c = rest_length + radius - hit_distance (0 = full droop).
    // Spring  F_s = k c          (Hooke's law, wheel rate)
    // Damper  F_d = c_b/r * dc/dt (separate bump / rebound coefficients)
    // Bump stop: extra stiff spring beyond static + max_compression.
    // Anti-roll bar: F = k_arb (c_left - c_right), pushing the more compressed side up and the
    // other side down. It transfers load across an axle, which is how roll stiffness
    // distribution (front vs rear) tunes understeer/oversteer.
    std::array<double, 4> comp{}, comp_rate{}, susp_force{};
    std::array<bool, 4> touching{};
    for (int w = 0; w < 4; ++w) {
        const WheelContact& c = contacts[w];
        touching[w] = c.hit && c.distance <= rays[w].length;
        if (!touching[w]) continue;
        comp[w] = rays[w].length - c.distance;
        // Compression rate = speed of the mount along the suspension axis toward the ground
        // (ground assumed static).
        Vec3 v_mount = s.velocity + cross(s.angular_velocity, rays[w].origin - s.position);
        comp_rate[w] = dot(v_mount, rays[w].direction);
    }
    for (int w = 0; w < 4; ++w) {
        if (!touching[w]) continue;
        const AxleParams& ax = cfg_.axle(w);
        double k = ax.spring_rate * damage_.suspension_stiffness[w];
        double f = k * comp[w];
        double bump_start = cfg_.wheels[w].static_compression + ax.max_compression;
        if (comp[w] > bump_start) f += ax.bump_stop_rate * (comp[w] - bump_start);
        f += (comp_rate[w] > 0 ? ax.damper_bump : ax.damper_rebound) * comp_rate[w];
        int other = w ^ 1;                              // FL<->FR, RL<->RR
        double other_comp = touching[other] ? comp[other] : 0.0;
        f += ax.anti_roll_rate * (comp[w] - other_comp);
        susp_force[w] = std::max(0.0, f);               // a spring can push, not pull the ground
    }

    // ------------------------------------------------------------------ tyre kinematics
    struct Kin { Vec3 fwd, lat, point; double vx = 0, vy = 0, load = 0, mu = 1; };
    std::array<Kin, 4> kin;
    for (int w = 0; w < 4; ++w) {
        out.wheels[w].steer_angle = steer_angle(w);
        if (!touching[w]) continue;
        const WheelContact& c = contacts[w];
        Kin& k = kin[w];
        double d = out.wheels[w].steer_angle;
        Vec3 heading = s.orientation.rotate({std::cos(d), std::sin(d), 0});
        k.fwd = normalized(heading - c.normal * dot(heading, c.normal));   // in the contact plane
        k.lat = cross(c.normal, k.fwd);                                    // left
        k.point = c.point;
        Vec3 v_c = s.velocity + cross(s.angular_velocity, c.point - s.position);
        k.vx = dot(v_c, k.fwd);
        k.vy = dot(v_c, k.lat);
        k.load = susp_force[w] * std::max(dot(up, c.normal), 0.0);       // normal component
        // Geometric (roll-centre) load transfer: the part of lateral load transfer that goes
        // through the suspension links instead of the springs:  dFz = Fy_axle * h_rc / track.
        // A leftward force (left turn) loads the right (outer) wheel. Uses last step's Fy.
        const AxleParams& ax = cfg_.axle(w);
        double geo = prev_axle_fy_[w < 2 ? 0 : 1] * ax.roll_centre_height / ax.track;
        k.load = std::max(0.0, k.load + (w % 2 == 0 ? -geo : geo));
        k.mu = cfg_.grip_for_surface(c.surface) * tire_condition_[w].grip_factor() * damage_.grip[w];
    }

    // ------------------------------------------------------------------ chassis telemetry
    const Vec3 v_body = s.orientation.inv_rotate(s.velocity);
    const double yaw_rate = s.orientation.inv_rotate(s.angular_velocity).z;
    out.speed = v_body.x;
    out.sideslip = std::abs(v_body.x) > 2.0 ? std::atan2(v_body.y, std::abs(v_body.x)) : 0.0;
    out.yaw_rate = yaw_rate;
    AssistStatus& as = out.assists;
    as.yaw_rate = yaw_rate;

    // ------------------------------------------------------------------ ASSIST: ESC (stability)
    // Reference yaw rate from the linear bicycle model with understeer gradient K:
    //   r_ref = v delta / (L + K v^2),  capped at the friction limit |r| <= mu g / v.
    // Oversteer (yawing more than the driver asked, or sliding: |beta| large) -> brake the OUTER
    // front wheel, creating a yaw moment out of the turn. Understeer (yawing less) -> brake the
    // INNER rear wheel and cut power, turning the car in. Same strategy as production ESC.
    std::array<double, 4> esc_brake{};
    double esc_throttle_cut = 0;
    {
        double delta = 0.5 * (out.wheels[FL].steer_angle + out.wheels[FR].steer_angle);
        double v = std::max(out.speed, 0.0);
        double r_ref = v * delta / (cfg_.wheelbase + assists_.esc_understeer_gradient * v * v);
        double r_max = 1.0 * kGravity / std::max(v, 1.0);
        r_ref = clamp(r_ref, -r_max, r_max);
        as.yaw_rate_ref = r_ref;
        if (assists_.esc && v > 5.0) {
            double err = yaw_rate - r_ref;                      // + = yawing more to the left
            double band = assists_.esc_yaw_deadband + 0.1 * std::abs(r_ref);
            bool sliding = std::abs(out.sideslip) > assists_.esc_sideslip_limit;
            // Oversteer: yawing faster than the reference (in either direction), or sliding.
            // Understeer: yawing slower than the reference by more than the deadband.
            bool over = sliding || (std::abs(err) > band && std::abs(yaw_rate) > std::abs(r_ref));
            bool under = !over && std::abs(err) > band && std::abs(yaw_rate) < std::abs(r_ref) && v > 8.0;
            double mag = clamp(assists_.esc_gain * (std::abs(err) - band), 0.0, assists_.esc_max_brake);
            if (sliding) mag = std::max(mag, clamp(assists_.esc_gain * (std::abs(out.sideslip) - assists_.esc_sideslip_limit) * 4.0, 0.0, assists_.esc_max_brake));
            if (over) {
                // yawing left too much (err > 0) -> brake the front RIGHT (outer) wheel
                bool rot_left = (sliding ? yaw_rate : err) > 0;
                esc_brake[rot_left ? FR : FL] = mag;
                esc_throttle_cut = 0.3;
                as.esc_mode = 1;
            } else if (under) {
                // turning left but not enough -> brake the rear LEFT (inner) wheel
                esc_brake[r_ref > 0 ? RL : RR] = mag * 0.6;
                esc_throttle_cut = 0.5;
                as.esc_mode = -1;
            }
        }
        as.esc_brake = esc_brake;
    }

    // ------------------------------------------------------------------ sub-stepped spin dynamics
    // Slip with relaxation length (first-order transient tyre model):
    //   d kappa / dt  = (v_sx - |v_x| kappa) / sigma_x,   v_sx = w r - v_x (slip velocity)
    //   d tanA / dt   = (-v_y - |v_x| tanA) / sigma_y
    // In steady state these give the textbook kappa = v_sx/|v_x| and tanA = -v_y/|v_x|, but they
    // stay finite and smooth at standstill (no divide by zero, a parked car holds still).
    // Integrated with implicit Euler:  k_{n+1} = (k_n + h v_sx / s) / (1 + h |v_x| / s)  (stable
    // for any step size).
    const int n_sub = std::max(1, (int)std::ceil(dt / max_substep - 1e-9));
    const double h = dt / n_sub;
    std::array<double, 4> fx_sum{}, fy_sum{};
    DrivetrainInput din{input_.throttle, input_.clutch, input_.brake, input_.handbrake, input_.gear,
                        damage_.engine_power};
    din.brake_power_scale = damage_.brakes;
    // ---- ASSIST: auto-clutch (sits on top of the model; the drivetrain only sees a pedal value)
    // Behaves like a centrifugal clutch: engagement rises with engine rpm above idle, so the car
    // launches when you add throttle and declutches before stalling when you slow down. Gear
    // changes get a short declutch + throttle lift.
    if (input_.auto_clutch) {
        if (input_.gear != last_gear_) shift_timer_ = 0.12;
        if (shift_timer_ > 0) {
            shift_timer_ -= dt;
            din.clutch = 1.0;
            din.throttle = 0.0;
        }
        const auto& ratios = cfg_.drivetrain.gear_ratios;
        if (input_.gear >= 0 && input_.gear < (int)ratios.size() && ratios[input_.gear] != 0.0) {
            double engage = clamp((drivetrain_.engine_rpm() - (cfg_.engine.idle_rpm + 300.0)) / 1500.0, 0.0, 1.0);
            din.clutch = std::max(din.clutch, 1.0 - engage);
        }
    }
    last_gear_ = input_.gear;
    const double throttle_after_shift = din.throttle;
    for (int step = 0; step < n_sub; ++step) {
        std::array<double, 4> tyre_t{}, roll_t{};
        for (int w = 0; w < 4; ++w) {
            const TireParams& tp = cfg_.tire(w);
            if (!touching[w]) {
                kappa_[w] *= 0.9;
                tan_alpha_[w] *= 0.9;
                continue;
            }
            const Kin& k = kin[w];
            double v_sx = drivetrain_.wheel_omega[w] * tp.radius - k.vx;
            kappa_[w] = (kappa_[w] + h * v_sx / tp.relax_x) / (1.0 + h * std::abs(k.vx) / tp.relax_x);
            tan_alpha_[w] = (tan_alpha_[w] + h * (-k.vy) / tp.relax_y) / (1.0 + h * std::abs(k.vx) / tp.relax_y);
            TireForces f = magic_formula(tp, kappa_[w], tan_alpha_[w], k.load, k.mu);
            fx_sum[w] += f.fx;
            fy_sum[w] += f.fy;
            tyre_t[w] = -f.fx * tp.radius;                        // road pushes back on the wheel
            roll_t[w] = tp.rolling_resistance * k.load * tp.radius;
        }
        // ---- ASSIST: ABS. Per wheel, adjust brake pressure to hold the slip ratio at the target
        // (near the tyre's force peak). Integral control on slip error:
        //   p += h * gain * (kappa + target)   (kappa < -target -> too much slip -> release)
        for (int w = 0; w < 4; ++w) {
            if (assists_.abs && input_.brake > 0.01 && touching[w] && std::abs(kin[w].vx) > 2.0) {
                abs_pressure_[w] = clamp(abs_pressure_[w] + h * assists_.abs_gain * (kappa_[w] + assists_.abs_slip_target), 0.0, 1.0);
            } else {
                abs_pressure_[w] = 1.0;
            }
            din.brake_scale[w] = abs_pressure_[w];
            din.extra_brake[w] = esc_brake[w];
        }
        // ---- ASSIST: TC. Cut engine torque in proportion to driven-wheel slip above target,
        // filtered over ~30 ms (like an ignition/throttle cut).
        double cut_target = 0;
        if (assists_.tc) {
            double slip = 0;
            for (int w = 0; w < 4; ++w)
                if (cfg_.axle(w).driven && touching[w]) slip = std::max(slip, kappa_[w] * sign(kin[w].vx + 1e-9));
            cut_target = clamp((slip - assists_.tc_slip_target) * assists_.tc_gain, 0.0, 1.0);
        }
        tc_cut_ += (cut_target - tc_cut_) * std::min(1.0, h / 0.03);
        din.throttle = throttle_after_shift * (1.0 - tc_cut_) * (1.0 - esc_throttle_cut);
        drivetrain_.step(din, tyre_t, roll_t, h);
    }
    for (int w = 0; w < 4; ++w) {
        as.abs_pressure[w] = abs_pressure_[w];
        as.abs_active[w] = abs_pressure_[w] < 0.98;
    }
    as.tc_cut = tc_cut_;
    out.throttle_applied = din.throttle;
    out.brake_applied = input_.brake;

    // ------------------------------------------------------------------ forces on the chassis
    Vec3 force, torque;
    std::array<double, 2> axle_fy{};
    for (int w = 0; w < 4; ++w) {
        WheelOutput& wo = out.wheels[w];
        const TireParams& tp = cfg_.tire(w);
        double droop = cfg_.axle(w).spring_rest_length - comp[w];
        wo.centre_world = rays[w].origin + rays[w].direction * droop;
        wo.angular_velocity = drivetrain_.wheel_omega[w];
        wo.slip_ratio = kappa_[w];
        wo.slip_angle = std::atan(tan_alpha_[w]);
        wo.condition = tire_condition_[w];
        if (!touching[w]) continue;
        const Kin& k = kin[w];
        double fx = fx_sum[w] / n_sub, fy = fy_sum[w] / n_sub;
        // Low-speed damping (below ~2 m/s): the relaxation-length model acts like an undamped
        // spring at standstill; real tyres have internal damping. Blends out with speed.
        double speed = std::hypot(k.vx, k.vy);
        double blend = clamp(1.0 - speed / 2.0, 0.0, 1.0);
        if (blend > 0) {
            double c = 2.0 * k.load;   // N per (m/s)
            fx += blend * c * (drivetrain_.wheel_omega[w] * tp.radius - k.vx);
            fy += blend * c * (-k.vy);
            double fmax = std::max(tp.mu_x, tp.mu_y) * k.mu * k.load;   // never exceed friction
            double fm = std::hypot(fx, fy);
            if (fm > fmax) { fx *= fmax / fm; fy *= fmax / fm; }
        }
        wo.contact = true;
        wo.load = k.load;
        wo.compression = comp[w];
        wo.fx = fx;
        wo.fy = fy;
        wo.contact_point = k.point;
        wo.force_world = k.fwd * fx + k.lat * fy;
        wo.grip_limit = std::max(tp.mu_x, tp.mu_y) * k.mu * k.load;
        // Suspension force acts along the body's up axis; longitudinal tyre force at the contact
        // patch; lateral tyre force at the roll-centre height (models suspension geometry: a
        // higher roll centre means less body roll for the same cornering force).
        Vec3 f_susp = up * susp_force[w];
        Vec3 f_long = k.fwd * fx;
        Vec3 f_lat = k.lat * fy;
        Vec3 p_lat = k.point + up * cfg_.axle(w).roll_centre_height;
        force += f_susp + f_long + f_lat;
        axle_fy[w < 2 ? 0 : 1] += fy;
        torque += cross(k.point - s.position, f_susp + f_long) + cross(p_lat - s.position, f_lat);
    }

    prev_axle_fy_ = axle_fy;

    // ------------------------------------------------------------------ aerodynamics
    // Drag:      F = -1/2 rho CdA |v| v
    // Downforce: F = 1/2 rho ClA v_x^2, split between the axles by aero balance.
    const AeroParams& a = cfg_.aero;
    double v = length(s.velocity);
    force += s.velocity * (-0.5 * a.air_density * a.drag_area * damage_.aero_drag * v);
    double vx_body = dot(s.velocity, s.orientation.rotate({1, 0, 0}));
    double down = 0.5 * a.air_density * a.lift_area * vx_body * vx_body;
    Vec3 p_front = s.position + s.orientation.rotate({cfg_.dist_cg_front, 0, 0});
    Vec3 p_rear = s.position + s.orientation.rotate({-cfg_.dist_cg_rear, 0, 0});
    Vec3 f_front = up * (-down * a.front_balance), f_rear = up * (-down * (1 - a.front_balance));
    force += f_front + f_rear;
    torque += cross(p_front - s.position, f_front) + cross(p_rear - s.position, f_rear);

    out.force = force;
    out.torque = torque;
    out.accel = s.orientation.inv_rotate(force) / cfg_.mass;
    out.engine_rpm = drivetrain_.engine_rpm();
    out.gear = input_.gear;
    out.engine_stalled = drivetrain_.stalled;
    return out;
}

}  // namespace rs
