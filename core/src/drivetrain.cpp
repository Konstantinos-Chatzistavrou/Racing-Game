#include "rs/drivetrain.hpp"
#include "rs/math.hpp"
#include <cmath>
#include <limits>
#include <vector>

namespace rs {
namespace {

constexpr double kRpmToRad = 2.0 * kPi / 60.0;

// Differential tree (see Drivetrain::Node). For an open differential with split s:
//   torques:    T_a = s T_in,   T_b = (1 - s) T_in
//   kinematics: w_carrier = s w_a + (1 - s) w_b          (power balance T_in w_c = T_a w_a + T_b w_b)
using Node = Drivetrain::Node;

// Per-substep context for the tree walk.
struct Ctx {
    const std::vector<Node>& nodes;
    const CarConfig& c;
    const std::array<double, 4>& omega;
    const std::array<double, 4>& ext;      // external (tyre) torque per wheel
    std::array<double, 4>& drive;          // output: drive torque per wheel
    double h;
};

double speed(const Ctx& x, int n) {
    const Node& nd = x.nodes[n];
    if (nd.wheel >= 0) return x.omega[nd.wheel];
    return nd.split * speed(x, nd.a) + (1 - nd.split) * speed(x, nd.b);
}

// Effective inertia seen at a node's input:  1/I = s^2/I_a + (1-s)^2/I_b
// (derived from w_c = s w_a + (1-s) w_b with T_a = s T, T_b = (1-s) T).
double inertia(const Ctx& x, int n) {
    const Node& nd = x.nodes[n];
    if (nd.wheel >= 0) return x.c.tire(nd.wheel).inertia;
    double s = nd.split;
    return 1.0 / (s * s / inertia(x, nd.a) + (1 - s) * (1 - s) / inertia(x, nd.b));
}

// Angular acceleration of a node's input if no drive torque were applied (tyre torques only).
double free_accel(const Ctx& x, int n) {
    const Node& nd = x.nodes[n];
    if (nd.wheel >= 0) return x.ext[nd.wheel] / x.c.tire(nd.wheel).inertia;
    return nd.split * free_accel(x, nd.a) + (1 - nd.split) * free_accel(x, nd.b);
}

// "Coulomb coupling" between two rotating bodies, solved exactly for one time step h.
// The coupling torque T (applied +T to body 1, -T to body 2... here: taken FROM 1 and GIVEN to 2)
// that makes both speeds equal at the end of the step is
//     T_req = (w1 - w2 + h (a1 - a2)) / (h (1/I1 + 1/I2))
// where a1, a2 are each body's acceleration without the coupling. If |T_req| fits within the
// friction capacity the coupling is LOCKED (apply T_req); otherwise it SLIPS (apply +-capacity).
// Used for the clutch and for limited-slip / locked differentials. Unconditionally stable.
double coulomb(double w1, double a1, double i1, double w2, double a2, double i2, double h, double capacity) {
    double t_req = (w1 - w2 + h * (a1 - a2)) / (h * (1.0 / i1 + 1.0 / i2));
    return clamp(t_req, -capacity, capacity);
}

void distribute(const Ctx& x, int n, double torque) {
    const Node& nd = x.nodes[n];
    if (nd.wheel >= 0) {
        x.drive[nd.wheel] += torque;
        return;
    }
    double ta = nd.split * torque, tb = (1 - nd.split) * torque;
    const DiffParams& p = *nd.diff;
    if (p.type != "open") {
        double limit = std::numeric_limits<double>::infinity();          // locked
        if (p.type == "lsd") {
            // Clutch-pack LSD: locking capacity = preload + ramp * |input torque|.
            bool on_power = torque * speed(x, n) >= 0;
            limit = p.preload + (on_power ? p.power_ramp : p.coast_ramp) * std::abs(torque);
        }
        double ia = inertia(x, nd.a), ib = inertia(x, nd.b);
        double t_lock = coulomb(speed(x, nd.a), free_accel(x, nd.a) + ta / ia, ia,
                                speed(x, nd.b), free_accel(x, nd.b) + tb / ib, ib, x.h, limit);
        ta -= t_lock;   // torque moves from the faster side to the slower side
        tb += t_lock;
    }
    distribute(x, nd.a, ta);
    distribute(x, nd.b, tb);
}

}  // namespace

Drivetrain::Drivetrain(const CarConfig& cfg) : cfg_(cfg) {
    engine_omega = cfg.engine.idle_rpm * kRpmToRad;
    auto leaf = [&](int w) { nodes_.push_back(Node{w}); return (int)nodes_.size() - 1; };
    auto diff = [&](int a, int b, double s, const DiffParams* p) {
        Node n; n.a = a; n.b = b; n.split = s; n.diff = p;
        nodes_.push_back(n);
        return (int)nodes_.size() - 1;
    };
    const auto& d = cfg.drivetrain;
    if (d.layout == "rwd") root_ = diff(leaf(RL), leaf(RR), 0.5, &d.rear_diff);
    else if (d.layout == "fwd") root_ = diff(leaf(FL), leaf(FR), 0.5, &d.front_diff);
    else {
        int f = diff(leaf(FL), leaf(FR), 0.5, &d.front_diff);
        int r = diff(leaf(RL), leaf(RR), 0.5, &d.rear_diff);
        root_ = diff(f, r, d.awd_front_split, &d.centre_diff);   // centre diff: front share = split
    }
}

double Drivetrain::engine_rpm() const { return engine_omega / kRpmToRad; }

double Drivetrain::engine_torque_full(double rpm) const {
    const auto& c = cfg_.engine.torque_curve;
    if (rpm <= c.front()[0]) return c.front()[1] * std::max(rpm, 0.0) / std::max(c.front()[0], 1.0);
    for (size_t i = 1; i < c.size(); ++i)
        if (rpm <= c[i][0]) return lerp(c[i - 1][1], c[i][1], (rpm - c[i - 1][0]) / (c[i][0] - c[i - 1][0]));
    return c.back()[1];
}

double Drivetrain::gear_ratio(int gear) const {
    const auto& g = cfg_.drivetrain.gear_ratios;
    if (gear < 0 || gear >= (int)g.size()) return 0.0;
    return g[gear] * cfg_.drivetrain.final_drive;      // total ratio engine : wheel
}

void Drivetrain::step(const DrivetrainInput& in, const std::array<double, 4>& tyre_torque,
                      const std::array<double, 4>& rolling_torque, double h) {
    const EngineParams& e = cfg_.engine;
    const double idle_w = e.idle_rpm * kRpmToRad;
    const double G = gear_ratio(in.gear);
    const double clutch_cap = cfg_.drivetrain.clutch_max_torque * clamp(1.0 - in.clutch, 0.0, 1.0);

    // ---- engine torque
    if (stalled && (in.clutch > 0.9 || G == 0.0)) {     // restart (starter) when declutched
        stalled = false;
        engine_omega = idle_w;
    }
    double t_engine = 0;
    if (!stalled) {
        double rpm = engine_rpm();
        // Idle controller: opens the throttle a little when revs fall below idle.
        double thr = std::max(in.throttle, clamp((e.idle_rpm - rpm) / 300.0, 0.0, 1.0) * 0.5);
        if (rpm > e.redline_rpm) thr = 0;               // rev limiter (fuel cut)
        // T = throttle * T_full(rpm) - (1 - throttle) * (c0 + c1 w): pumping/friction losses
        // are what produce engine braking when the throttle is closed.
        t_engine = thr * engine_torque_full(rpm) * in.engine_power_scale
                   - (1 - thr) * (e.friction_const + e.friction_linear * engine_omega);
    }

    // ---- clutch: couples engine (I_e) to the gearbox input shaft (speed G * w_carrier)
    std::array<double, 4> drive{};
    Ctx x{nodes_, cfg_, wheel_omega, tyre_torque, drive, h};
    clutch_torque = 0;
    if (G != 0.0 && clutch_cap > 0 && !stalled) {
        double i_shaft = cfg_.drivetrain.driveline_inertia + inertia(x, root_) / (G * G);
        double w_shaft = G * speed(x, root_);
        double a_shaft = G * free_accel(x, root_) * (inertia(x, root_) / (G * G)) / i_shaft;
        clutch_torque = coulomb(engine_omega, t_engine / e.inertia, e.inertia, w_shaft, a_shaft, i_shaft, h, clutch_cap);
        // Torque multiplication through the gears, minus mechanical losses.
        distribute(x, root_, clutch_torque * G * cfg_.drivetrain.efficiency);
    }

    // ---- engine speed
    if (!stalled) {
        engine_omega += h * (t_engine - clutch_torque) / e.inertia;
        if (engine_omega < 0.3 * idle_w) {                // dragged below ~300 rpm: stall
            stalled = true;
            engine_omega = 0;
        }
    }

    // ---- wheels: I dw/dt = T_drive + T_tyre, then brakes/rolling resistance as friction that can
    // stop the wheel but never spin it backwards (applied as a clamped impulse).
    const double bias = cfg_.brake_bias_front;
    for (int w = 0; w < 4; ++w) {
        const double I = cfg_.tire(w).inertia;
        wheel_omega[w] += h * (drive[w] + tyre_torque[w]) / I;
        double t_brake = in.brake * cfg_.brake_torque_total * (w < 2 ? bias : 1 - bias) * 0.5 * in.brake_scale[w];
        t_brake += in.handbrake * cfg_.axle(w).handbrake_torque + in.extra_brake[w];
        t_brake *= in.brake_power_scale;                // cooked brakes: fade, then nothing
        double dw = h * (t_brake + rolling_torque[w]) / I;
        wheel_omega[w] = std::abs(wheel_omega[w]) <= dw ? 0.0 : wheel_omega[w] - sign(wheel_omega[w]) * dw;
    }
}

}  // namespace rs
