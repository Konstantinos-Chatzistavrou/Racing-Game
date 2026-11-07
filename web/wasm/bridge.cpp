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
#include "rs/damage.hpp"
#include "rs/race.hpp"
#include "rs/route.hpp"
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
    if (speed == 0) g_cars[id]->spin = {};
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
//     buf[168 + 4 i]:  wheel i self-aligning torque Mz (N m), camber rad, tread (core) temperature C, wear 0..1
//     buf[184 + i]: brake disc temperature C   buf[188 + i]: tread surface temperature C   buf[192 + i]: tyre pressure kPa
//     buf[196 + i]: brake pad friction vs. its working range (fade < 1)
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
    // No input cut-off when totaled: the car always stays drivable (limp home, see damage.hpp).

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
        double* ext = b + 168 + 4 * i;
        ext[0] = w.mz;
        ext[1] = w.camber;
        ext[2] = w.condition.temperature_c;
        ext[3] = w.condition.wear;
        b[184 + i] = w.brake_temp_c;
        b[188 + i] = w.condition.surface_c;
        b[192 + i] = w.condition.pressure_kpa;
        b[196 + i] = w.brake_mu;
    }
}

// Crash input (call during a tick, after rs_rays): contact point in three world, impulse N s
// (measured from the car's own motion, see world.ts), id of the other object.
EMSCRIPTEN_KEEPALIVE void rs_contact(int id, double x, double y, double z, double impulse, double other) {
    Car& c = *g_cars[id];
    const rs::Vec3 body = c.cs.orientation.inv_rotate(to_core(x, y, z) - c.cs.position);
    c.vehicle->add_contact(std::uint64_t(other), body, impulse);
}

// Damage report -> buf[200..]: crush m (front, rear, left, right) [200..203], zone 0..1 [204..207],
// wheel 0..1 FL FR RL RR [208..211], engine 0..1 [212], last impact kJ [213],
// last impact point in the car's LOCAL three frame (X left, Y up, Z fwd; origin CG) [214..216],
// last zone [217], impacts [218], totaled [219] (report only: the car stays drivable), total kJ [220],
// smoulder 0..1 [221], fire 0..1 [222], brake effectiveness 0..1 [223], brakes failed [224],
// severity 0..1 [225]
EMSCRIPTEN_KEEPALIVE void rs_damage(int id) {
    Car& c = *g_cars[id];
    const rs::DamageReport& d = c.out.damage;
    double* b = c.buf.data() + 200;
    for (int i = 0; i < 4; ++i) { b[i] = d.crush[i]; b[4 + i] = d.zone[i]; b[8 + i] = d.wheel[i]; }
    b[12] = d.engine;
    b[13] = d.last_impact_kj;
    const rs::Vec3& p = d.last_impact_point;   // core body: x fwd, y left, z up
    b[14] = p.y; b[15] = p.z; b[16] = p.x;
    b[17] = d.last_zone;
    b[18] = d.impacts;
    b[19] = d.totaled ? 1 : 0;
    b[20] = d.total_energy_kj;
    b[21] = d.smoulder;
    b[22] = d.fire;
    b[23] = d.brakes;
    b[24] = d.brakes_failed ? 1 : 0;
    b[25] = c.vehicle->damage_model().severity();
}

EMSCRIPTEN_KEEPALIVE void rs_repair(int id) {
    g_cars[id]->vehicle->damage_model().repair();
    g_cars[id]->out.damage = rs::DamageReport{};
}

// ---- race (laps, lap times, positions): one race at a time --------------------------------
namespace {
std::unique_ptr<rs::Route> g_route;
std::unique_ptr<rs::RaceTracker> g_race;
std::vector<double> g_race_buf(16, 0.0);
}

// Route JSON (schema route/1) + lap count (0 = free run, laps counted forever). Returns 0 or -1.
EMSCRIPTEN_KEEPALIVE int rs_race_create(const char* route_json, int laps) {
    try {
        g_race.reset();
        g_route = std::make_unique<rs::Route>(rs::Route::parse(route_json));
        g_race = std::make_unique<rs::RaceTracker>(*g_route, laps > 0 ? laps : 1000000);
        return 0;
    } catch (const std::exception& e) {
        g_error = e.what();
        return -1;
    }
}
EMSCRIPTEN_KEEPALIVE double* rs_race_buffer() { return g_race_buf.data(); }
EMSCRIPTEN_KEEPALIVE int rs_race_add(double x, double y, double z) { return g_race->add_car(to_core(x, y, z)); }

// Position in three world, race time s. Writes buf: [0] laps done, [1] current lap time,
// [2] last lap, [3] best lap, [4] distance m, [5] position, [6] finished, [7] route length m
EMSCRIPTEN_KEEPALIVE void rs_race_update(int car, double x, double y, double z, double time) {
    g_race->update(car, to_core(x, y, z), time);
    g_race->rank();
    const rs::RaceProgress& p = g_race->progress(car);
    double* b = g_race_buf.data();
    b[0] = p.lap;
    b[1] = time - p.lap_start_time;
    b[2] = p.last_lap;
    b[3] = p.best_lap;
    b[4] = p.distance;
    b[5] = p.position;
    b[6] = p.finished ? 1 : 0;
    b[7] = g_route->length();
}

}  // extern "C"
