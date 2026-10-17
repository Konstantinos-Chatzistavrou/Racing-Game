#include "rs/config.hpp"
#include "rs/math.hpp"
#include <fstream>
#include <sstream>
#include <stdexcept>
#include "nlohmann/json.hpp"

namespace rs {
using nlohmann::json;

namespace {

double num(const json& j, const char* key, const std::string& ctx) {
    if (!j.contains(key)) throw std::runtime_error("car config: missing '" + ctx + "." + key + "'");
    if (!j.at(key).is_number()) throw std::runtime_error("car config: '" + ctx + "." + key + "' must be a number");
    return j.at(key).get<double>();
}
double num_or(const json& j, const char* key, double fallback) {
    return j.contains(key) ? j.at(key).get<double>() : fallback;
}

AxleParams parse_axle(const json& j, const std::string& ctx) {
    AxleParams a;
    a.track = num(j, "track_m", ctx);
    a.spring_rate = num(j, "spring_rate_n_per_m", ctx);
    a.spring_rest_length = num(j, "spring_rest_length_m", ctx);
    a.max_compression = num(j, "max_compression_m", ctx);
    a.bump_stop_rate = num_or(j, "bump_stop_rate_n_per_m", 300000);
    a.damper_bump = num(j, "damper_bump_ns_per_m", ctx);
    a.damper_rebound = num(j, "damper_rebound_ns_per_m", ctx);
    a.anti_roll_rate = num(j, "anti_roll_rate_n_per_m", ctx);
    a.roll_centre_height = num(j, "roll_centre_height_m", ctx);
    a.max_steer_deg = num_or(j, "max_steer_deg", 0);
    a.steer_compliance = num_or(j, "steer_compliance_deg_per_kn", 0) * kPi / 180.0 / 1000.0;
    a.ackermann = num_or(j, "ackermann", 0);
    a.handbrake_torque = num_or(j, "handbrake_torque_nm", 0);
    return a;
}

TireParams parse_tire(const json& j, const std::string& ctx) {
    TireParams t;
    t.radius = num(j, "radius_m", ctx);
    t.inertia = num(j, "inertia_kgm2", ctx);
    t.fz0 = num(j, "fz0_n", ctx);
    const json& lo = j.at("longitudinal");
    t.cx = num(lo, "C", ctx + ".longitudinal");
    t.mu_x = num(lo, "mu", ctx + ".longitudinal");
    t.pdx2 = num(lo, "load_sensitivity", ctx + ".longitudinal");
    t.ex = num(lo, "E", ctx + ".longitudinal");
    t.kx = num(lo, "slip_stiffness_per_load", ctx + ".longitudinal");
    const json& la = j.at("lateral");
    t.cy = num(la, "C", ctx + ".lateral");
    t.mu_y = num(la, "mu", ctx + ".lateral");
    t.pdy2 = num(la, "load_sensitivity", ctx + ".lateral");
    t.ey = num(la, "E", ctx + ".lateral");
    t.pky1 = num(la, "cornering_stiffness_per_fz0", ctx + ".lateral");
    t.pky2 = num(la, "cornering_stiffness_peak_load", ctx + ".lateral");
    const json& c = j.at("combined");
    t.rbx1 = num(c, "rBx1", ctx); t.rbx2 = num(c, "rBx2", ctx); t.rcx1 = num(c, "rCx1", ctx);
    t.rby1 = num(c, "rBy1", ctx); t.rby2 = num(c, "rBy2", ctx); t.rcy1 = num(c, "rCy1", ctx);
    t.relax_x = num(j, "relaxation_length_long_m", ctx);
    t.relax_y = num(j, "relaxation_length_lat_m", ctx);
    t.rolling_resistance = num(j, "rolling_resistance", ctx);
    return t;
}

DiffParams parse_diff(const json& j) {
    DiffParams d;
    d.type = j.value("type", "open");
    d.preload = num_or(j, "preload_nm", 0);
    d.power_ramp = num_or(j, "power_ramp", 0);
    d.coast_ramp = num_or(j, "coast_ramp", 0);
    if (d.type != "open" && d.type != "locked" && d.type != "lsd")
        throw std::runtime_error("car config: diff type must be open|locked|lsd, got '" + d.type + "'");
    return d;
}

}  // namespace

CarConfig parse_car_config(const std::string& text) {
    json j = json::parse(text);
    if (j.value("schema", "") != "car/1")
        throw std::runtime_error("car config: expected \"schema\": \"car/1\"");
    CarConfig c;
    c.name = j.value("name", "unnamed");
    const json& ch = j.at("chassis");
    c.mass = num(ch, "mass_kg", "chassis");
    c.cg_height = num(ch, "cg_height_m", "chassis");
    c.weight_front = num(ch, "weight_front", "chassis");
    c.wheelbase = num(ch, "wheelbase_m", "chassis");
    c.inertia_xx = num(ch, "inertia_roll_kgm2", "chassis");
    c.inertia_yy = num(ch, "inertia_pitch_kgm2", "chassis");
    c.inertia_zz = num(ch, "inertia_yaw_kgm2", "chassis");
    c.front = parse_axle(j.at("front_axle"), "front_axle");
    c.rear = parse_axle(j.at("rear_axle"), "rear_axle");
    c.tire_front = parse_tire(j.at("tire_front"), "tire_front");
    c.tire_rear = j.contains("tire_rear") ? parse_tire(j.at("tire_rear"), "tire_rear") : c.tire_front;
    c.brake_bias_front = num(j.at("brakes"), "bias_front", "brakes");
    c.brake_torque_total = num(j.at("brakes"), "max_total_torque_nm", "brakes");

    const json& e = j.at("engine");
    for (const auto& pt : e.at("torque_curve")) c.engine.torque_curve.push_back({pt.at(0).get<double>(), pt.at(1).get<double>()});
    if (c.engine.torque_curve.size() < 2) throw std::runtime_error("car config: torque_curve needs >= 2 points");
    c.engine.idle_rpm = num(e, "idle_rpm", "engine");
    c.engine.redline_rpm = num(e, "redline_rpm", "engine");
    c.engine.inertia = num(e, "inertia_kgm2", "engine");
    c.engine.friction_const = num(e, "friction_const_nm", "engine");
    c.engine.friction_linear = num(e, "friction_linear_nm_per_radps", "engine");

    const json& d = j.at("drivetrain");
    c.drivetrain.gear_ratios = d.at("gear_ratios").get<std::vector<double>>();
    if (c.drivetrain.gear_ratios.size() < 3 || c.drivetrain.gear_ratios[1] != 0.0)
        throw std::runtime_error("car config: gear_ratios = [reverse, 0 (neutral), 1st, ...]");
    c.drivetrain.final_drive = num(d, "final_drive", "drivetrain");
    c.drivetrain.efficiency = num(d, "efficiency", "drivetrain");
    c.drivetrain.clutch_max_torque = num(d, "clutch_max_torque_nm", "drivetrain");
    c.drivetrain.driveline_inertia = num(d, "driveline_inertia_kgm2", "drivetrain");
    c.drivetrain.layout = d.at("layout").get<std::string>();
    c.drivetrain.awd_front_split = num_or(d, "awd_front_split", 0.4);
    if (d.contains("front_diff")) c.drivetrain.front_diff = parse_diff(d.at("front_diff"));
    if (d.contains("rear_diff")) c.drivetrain.rear_diff = parse_diff(d.at("rear_diff"));
    if (d.contains("centre_diff")) c.drivetrain.centre_diff = parse_diff(d.at("centre_diff"));
    const std::string& lay = c.drivetrain.layout;
    if (lay != "rwd" && lay != "fwd" && lay != "awd") throw std::runtime_error("car config: layout must be rwd|fwd|awd");
    c.front.driven = (lay == "fwd" || lay == "awd");
    c.rear.driven = (lay == "rwd" || lay == "awd");

    const json& a = j.at("aero");
    c.aero.drag_area = num(a, "drag_area_m2", "aero");
    c.aero.lift_area = num(a, "downforce_area_m2", "aero");
    c.aero.front_balance = num(a, "front_balance", "aero");
    c.aero.air_density = num_or(a, "air_density", 1.225);

    for (auto it = j.at("surface_grip").begin(); it != j.at("surface_grip").end(); ++it)
        c.surface_grip.push_back({it.key(), it.value().get<double>()});

    c.finalize();
    return c;
}

CarConfig load_car_config(const std::string& path) {
    std::ifstream f(path);
    if (!f) throw std::runtime_error("car config: cannot open " + path);
    std::stringstream ss;
    ss << f.rdbuf();
    try {
        return parse_car_config(ss.str());
    } catch (const nlohmann::json::exception& e) {
        throw std::runtime_error(std::string("car config ") + path + ": " + e.what());
    }
}

void CarConfig::finalize() {
    // Static axle loads from the weight distribution: the CG sits b = weight_front * L ahead of
    // the rear axle (moment balance about the rear contact patch: W_f L = m g b).
    dist_cg_rear = weight_front * wheelbase;
    dist_cg_front = wheelbase - dist_cg_rear;
    const double corner_load[2] = {mass * kGravity * weight_front * 0.5, mass * kGravity * (1 - weight_front) * 0.5};
    for (int w = 0; w < 4; ++w) {
        const AxleParams& ax = axle(w);
        const TireParams& t = tire(w);
        int a = w < 2 ? 0 : 1;
        double static_compression = corner_load[a] / ax.spring_rate;   // Hooke: x = F / k
        if (static_compression >= ax.spring_rest_length)
            throw std::runtime_error("car config: springs too soft, static compression exceeds rest length");
        wheels[w].x = (w < 2) ? dist_cg_front : -dist_cg_rear;
        wheels[w].y = (w % 2 == 0 ? 0.5 : -0.5) * ax.track;          // FL/RL on +Y (left)
        // At rest the wheel centre is `radius` above the ground and the CG is cg_height above it.
        double wheel_centre_z = t.radius - cg_height;
        wheels[w].mount_z = wheel_centre_z + (ax.spring_rest_length - static_compression);
        wheels[w].static_compression = static_compression;
    }
}

double CarConfig::grip_for_surface(int i) const {
    return (i >= 0 && i < (int)surface_grip.size()) ? surface_grip[i].second : 1.0;
}

int CarConfig::surface_index(const std::string& surface_name) const {
    for (size_t i = 0; i < surface_grip.size(); ++i)
        if (surface_grip[i].first == surface_name) return (int)i;
    return -1;
}

}  // namespace rs
