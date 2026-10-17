// WebAssembly bridge: exposes the rs_core vehicle to JavaScript with a flat C API.
//
// THE ONLY PLACE where core coordinates are converted to/from the web side's (same role as
// godot_ext/src/axes.hpp). three.js and glTF are Y-up like Godot, so the mapping is identical:
//     three = (x, z, -y)            core = (x, -z, y)
// Car models face +Z: local X = left, Y = up, Z = forward.
//
// Data crosses the boundary through one shared double buffer per car (no allocations per tick).
// Layouts are documented next to each function; web/src/physics/core.ts mirrors them.
#include <emscripten/emscripten.h>

#include <array>
#include <cmath>
#include <memory>
#include <string>
#include <vector>

#include "rs/config.hpp"
#include "rs/controls.hpp"
#include "rs/vehicle.hpp"

namespace {

rs::Vec3 to_core(double x, double y, double z) { return {x, -z, y}; }
void put(double* o, const rs::Vec3& v) { o[0] = v.x; o[1] = v.z; o[2] = -v.y; }   // core -> three

// three quaternion (x, y, z, w) -> core orientation, via the body axes.
rs::Quat quat_to_core(const double* q) {
    const double x = q[0], y = q[1], z = q[2], w = q[3];
    // columns of the three rotation matrix = local X (left), Y (up), Z (forward) in three world
    const double lx[3] = {1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)};
    const double ux[3] = {2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)};
    const double fx[3] = {2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)};
    return rs::Quat::from_axes(to_core(fx[0], fx[1], fx[2]), to_core(lx[0], lx[1], lx[2]),
                               to_core(ux[0], ux[1], ux[2]));
}

struct Car {
    rs::CarConfig cfg;
    std::unique_ptr<rs::Vehicle> vehicle;
    std::unique_ptr<rs::Controls> controls;
    rs::VehicleOutput out;
    rs::ChassisState cs;
    std::array<rs::WheelRay, 4> rays;
    std::array<double, 4> spin{};
    std::vector<double> buf = std::vector<double>(256, 0.0);
};

std::vector<std::unique_ptr<Car>> g_cars;
std::string g_error;

}  // namespace

extern "C" {

// Parse a car JSON (UTF-8, NUL-terminated). Returns a car id, or -1 (see rs_last_error).
EMSCRIPTEN_KEEPALIVE int rs_create(const char* json) {
    try {
        auto c = std::make_unique<Car>();
        c->cfg = rs::parse_car_config(json);
        c->vehicle = std::make_unique<rs::Vehicle>(c->cfg);
        c->controls = std::make_unique<rs::Controls>(c->vehicle->config());
        g_cars.push_back(std::move(c));
        return int(g_cars.size()) - 1;
    } catch (const std::exception& e) {
        g_error = e.what();
        return -1;
    }
}

EMSCRIPTEN_KEEPALIVE const char* rs_last_error() { return g_error.c_str(); }
EMSCRIPTEN_KEEPALIVE double* rs_buffer(int id) { return g_cars[id]->buf.data(); }

// Static facts the renderer needs, written to the buffer:
//   [0] mass  [1..3] inertia in three body axes (X left = pitch, Y up = yaw, Z fwd = roll)
//   [4] cg height  [5] wheel radius front  [6] wheel radius rear  [7] redline  [8] idle
//   [9] surface index of "asphalt"  [10] "pavement"  [11] "wall"
EMSCRIPTEN_KEEPALIVE void rs_info(int id) {
    const auto& c = *g_cars[id];
    double* b = g_cars[id]->buf.data();
    b[0] = c.cfg.mass;
    b[1] = c.cfg.inertia_yy;
    b[2] = c.cfg.inertia_zz;
    b[3] = c.cfg.inertia_xx;
    b[4] = c.cfg.cg_height;
    b[5] = c.cfg.tire_front.radius;
    b[6] = c.cfg.tire_rear.radius;
    b[7] = c.cfg.engine.redline_rpm;
    b[8] = c.cfg.engine.idle_rpm;
    b[9] = c.cfg.surface_index("asphalt");
    b[10] = c.cfg.surface_index("pavement");
    b[11] = c.cfg.surface_index("wall");
}

// Start rolling at speed (m/s) in a gear (-1 = keep), clearing slips.
EMSCRIPTEN_KEEPALIVE void rs_reset_motion(int id, double speed, int gear) {
    g_cars[id]->vehicle->reset_motion(speed, gear);
    g_cars[id]->out = rs::VehicleOutput{};
    if (gear >= 0) g_cars[id]->controls->set_gear(gear);
}

// IN  buf[0..12]: chassis state, three world, origin = CG:
//     pos xyz, quat xyzw, linear vel xyz, angular vel xyz
// OUT buf[16 + 6 i]: wheel i ray from xyz, to xyz (three world). Order FL, FR, RL, RR.
EMSCRIPTEN_KEEPALIVE void rs_rays(int id) {
    Car& c = *g_cars[id];
    double* b = c.buf.data();
    c.cs.position = to_core(b[0], b[1], b[2]);
    c.cs.orientation = quat_to_core(b + 3);
    c.cs.velocity = to_core(b[7], b[8], b[9]);
    c.cs.angular_velocity = to_core(b[10], b[11], b[12]);
    c.rays = c.vehicle->wheel_rays(c.cs);
    for (int i = 0; i < 4; ++i) {
        put(b + 16 + 6 * i, c.rays[i].origin);
        put(b + 19 + 6 * i, c.rays[i].origin + c.rays[i].direction * c.rays[i].length);
    }
}

// Call after rs_rays with the raycast results and the driver's raw input.
// IN  buf[48 + 8 i]: wheel i contact: hit (0/1), point xyz, normal xyz, surface index
//     buf[80..87]: raw input: steer (-1 right .. +1 left), throttle, brake, clutch, handbrake,
//                  shift_up (edge), shift_down (edge), device (0 kb, 1 pad, 2 wheel)
//     buf[88..91]: settings: abs, tc, esc, auto_gearbox (0/1)
// OUT buf[96..98] force, [99..101] torque (three world, apply at CG for one tick)
//     buf[102] speed m/s  [103] rpm  [104] gear index  [105] sideslip rad  [106] stalled
//     [107] throttle applied  [108] brake applied  [109] steer applied  [110..112] accel (body, core axes)
//     [113] abs active  [114] tc active  [115] esc active
//     buf[120 + 12 i]: wheel i centre xyz (three world), steer rad, spin rad, contact, load N,
//                      slip ratio, slip angle rad, compression m, angular velocity rad/s, surface
EMSCRIPTEN_KEEPALIVE void rs_step(int id, double dt) {
    Car& c = *g_cars[id];
    double* b = c.buf.data();
    std::array<rs::WheelContact, 4> contacts{};
    for (int i = 0; i < 4; ++i) {
        const double* w = b + 48 + 8 * i;
        if (w[0] < 0.5) continue;
        rs::WheelContact& k = contacts[i];
        k.hit = true;
        k.point = to_core(w[1], w[2], w[3]);
        k.normal = rs::normalized(to_core(w[4], w[5], w[6]));
        k.distance = rs::length(k.point - c.rays[i].origin);
        k.surface = int(w[7]);
    }
    rs::RawInput raw;
    raw.steer = b[80];
    raw.throttle = b[81];
    raw.brake = b[82];
    raw.clutch = b[83];
    raw.handbrake = b[84];
    raw.shift_up = b[85] > 0.5;
    raw.shift_down = b[86] > 0.5;
    raw.device = rs::InputDevice(int(b[87]));
    auto& a = c.vehicle->assists();
    a.abs = b[88] > 0.5;
    a.tc = b[89] > 0.5;
    a.esc = b[90] > 0.5;
    c.controls->settings.auto_gearbox = b[91] > 0.5;
    if (c.out.damage.totaled) {
        raw = rs::RawInput{};
        raw.device = rs::InputDevice::Wheel;
        raw.brake = 0.15;
    }

    const rs::DriverInput di = c.controls->update(raw, c.out, dt);
    c.vehicle->set_input(di);
    c.out = c.vehicle->update(c.cs, contacts, dt);

    put(b + 96, c.out.force);
    put(b + 99, c.out.torque);
    b[102] = c.out.speed;
    b[103] = c.out.engine_rpm;
    b[104] = c.out.gear;
    b[105] = c.out.sideslip;
    b[106] = c.out.engine_stalled ? 1 : 0;
    b[107] = c.out.throttle_applied;
    b[108] = c.out.brake_applied;
    b[109] = di.steer;
    b[110] = c.out.accel.x;
    b[111] = c.out.accel.y;
    b[112] = c.out.accel.z;
    const auto& as = c.out.assists;
    b[113] = (as.abs_active[0] || as.abs_active[1] || as.abs_active[2] || as.abs_active[3]) ? 1 : 0;
    b[114] = as.tc_cut;
    b[115] = as.esc_mode;
    for (int i = 0; i < 4; ++i) {
        const rs::WheelOutput& w = c.out.wheels[i];
        c.spin[i] = std::fmod(c.spin[i] + w.angular_velocity * dt, 2 * rs::kPi);
        double* o = b + 120 + 12 * i;
        put(o, w.centre_world);
        o[3] = w.steer_angle;
        o[4] = c.spin[i];
        o[5] = w.contact ? 1 : 0;
        o[6] = w.load;
        o[7] = w.slip_ratio;
        o[8] = w.slip_angle;
        o[9] = w.compression;
        o[10] = w.angular_velocity;
        o[11] = contacts[i].surface;
    }
}

}  // extern "C"
