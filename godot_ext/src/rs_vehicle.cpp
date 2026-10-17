#include "rs_vehicle.hpp"
#include <stdexcept>
#include <godot_cpp/classes/engine.hpp>
#include <godot_cpp/classes/physics_direct_space_state3d.hpp>
#include <godot_cpp/classes/project_settings.hpp>
#include <godot_cpp/classes/scene_tree.hpp>
#include <godot_cpp/core/class_db.hpp>
#include <godot_cpp/variant/utility_functions.hpp>
#include "axes.hpp"
#include "rs/config.hpp"

namespace godot {

RSVehicle::RSVehicle() = default;
RSVehicle::~RSVehicle() = default;

void RSVehicle::_ready() {
    if (Engine::get_singleton()->is_editor_hint()) return;
    // Resolve the car JSON: absolute, res://..., or relative to the project folder.
    String path = car_config_path_;
    if (path.begins_with("res://")) path = ProjectSettings::get_singleton()->globalize_path(path);
    else if (!path.is_absolute_path()) path = ProjectSettings::get_singleton()->globalize_path("res://").path_join(path);
    try {
        rs::CarConfig cfg = rs::load_car_config(path.utf8().get_data());
        vehicle_ = std::make_unique<rs::Vehicle>(cfg);
        controls_ = std::make_unique<rs::Controls>(vehicle_->config());
    } catch (const std::exception& e) {
        UtilityFunctions::push_error("RSVehicle: ", e.what());
        return;
    }
    const rs::CarConfig& c = vehicle_->config();
    // Rigid body set-up from the car data. Origin = CG; inertia mapped to Godot local axes
    // (X = left -> pitch, Y = up -> yaw, Z = forward -> roll). No engine-side damping.
    set_mass(c.mass);
    set_inertia(Vector3(c.inertia_yy, c.inertia_zz, c.inertia_xx));
    set_center_of_mass_mode(CENTER_OF_MASS_MODE_CUSTOM);
    set_center_of_mass(Vector3());
    set_linear_damp_mode(DAMP_MODE_REPLACE);
    set_angular_damp_mode(DAMP_MODE_REPLACE);
    set_linear_damp(0.0);
    set_angular_damp(0.0);
    set_can_sleep(false);
    // Crash damage needs the physics engine to report contacts and their impulses.
    set_contact_monitor(true);
    set_max_contacts_reported(8);
    add_to_group("rs_vehicles");
    ray_.instantiate();
    TypedArray<RID> exclude;
    exclude.push_back(get_rid());
    ray_->set_exclude(exclude);
}

void RSVehicle::set_gear(int g) {
    if (controls_) controls_->set_gear(g);
}

int RSVehicle::get_gear() const { return controls_ ? controls_->gear() : 1; }

// Assist names: abs, tc, esc (vehicle); countersteer, auto_gearbox, auto_clutch,
// speed_sensitive_steering (controls).
void RSVehicle::set_assist(const String& name, bool on) {
    if (!vehicle_) return;
    rs::AssistSettings& a = vehicle_->assists();
    rs::ControlSettings& c = controls_->settings;
    if (name == "abs") a.abs = on;
    else if (name == "tc") a.tc = on;
    else if (name == "esc") a.esc = on;
    else if (name == "countersteer") c.countersteer_assist = on;
    else if (name == "auto_gearbox") c.auto_gearbox = on;
    else if (name == "auto_clutch") c.auto_clutch = on;
    else if (name == "speed_sensitive_steering") c.speed_sensitive_steering = on;
    else UtilityFunctions::push_warning("RSVehicle: unknown assist '", name, "'");
}

bool RSVehicle::get_assist(const String& name) const {
    if (!vehicle_) return false;
    const rs::AssistSettings& a = vehicle_->assists();
    const rs::ControlSettings& c = controls_->settings;
    if (name == "abs") return a.abs;
    if (name == "tc") return a.tc;
    if (name == "esc") return a.esc;
    if (name == "countersteer") return c.countersteer_assist;
    if (name == "auto_gearbox") return c.auto_gearbox;
    if (name == "auto_clutch") return c.auto_clutch;
    if (name == "speed_sensitive_steering") return c.speed_sensitive_steering;
    return false;
}

void RSVehicle::_integrate_forces(PhysicsDirectBodyState3D* st) {
    if (!vehicle_) return;
    const double dt = st->get_step();
    const Transform3D t = st->get_transform();
    rs::ChassisState cs;
    cs.position = axes::to_core(t.origin);
    cs.orientation = axes::to_core(t.basis);
    cs.velocity = axes::to_core(st->get_linear_velocity());
    cs.angular_velocity = axes::to_core(st->get_angular_velocity());

    // Wheel raycasts through Godot's physics space.
    const auto rays = vehicle_->wheel_rays(cs);
    std::array<rs::WheelContact, 4> contacts;
    PhysicsDirectSpaceState3D* space = st->get_space_state();
    for (int i = 0; i < 4; ++i) {
        ray_->set_from(axes::to_godot(rays[i].origin));
        ray_->set_to(axes::to_godot(rays[i].origin + rays[i].direction * rays[i].length));
        Dictionary hit = space->intersect_ray(ray_);
        if (hit.is_empty()) continue;
        rs::WheelContact& c = contacts[i];
        c.hit = true;
        c.point = axes::to_core(Vector3(hit["position"]));
        c.normal = axes::to_core(Vector3(hit["normal"]));
        c.distance = rs::length(c.point - rays[i].origin);
        // Surface type: StaticBody3D meta "surface" (set by the track import script).
        c.surface = 0;
        Object* col = Object::cast_to<Object>(hit["collider"]);
        if (col && col->has_meta("surface")) {
            int idx = vehicle_->config().surface_index(String(col->get_meta("surface")).utf8().get_data());
            if (idx >= 0) c.surface = idx;
        }
        surfaces_[i] = c.surface;
    }

    // Crashes: collision impulse this tick -> core damage model.
    feed_contacts(st, cs, dt);

    // A totaled car is a wreck: no driver input any more (the core also kills the engine).
    if (out_.damage.totaled) {
        raw_ = rs::RawInput{};
        raw_.device = rs::InputDevice::Wheel;
        raw_.brake = 0.15;
    } else if (ai_) {
        // AI: the core decides; the engine only provides what the AI can "see" (other cars).
        rs::AIOutput ao = ai_->update(cs, out_, gather_others(), dt);
        raw_ = ao.raw;
        if (ao.gear_request >= 0) controls_->set_gear(ao.gear_request);
    }
    // Raw device input -> shaped driver input (core Controls), using last tick's output.
    rs::RawInput raw = raw_;
    raw.shift_up = pending_up_;
    raw.shift_down = pending_down_;
    pending_up_ = pending_down_ = false;
    applied_ = controls_->update(raw, out_, dt);
    vehicle_->set_input(applied_);
    out_ = vehicle_->update(cs, contacts, dt);
    has_output_ = true;
    prev_force_ = out_.force;
    st->apply_central_force(axes::to_godot(out_.force));
    st->apply_torque(axes::to_godot(out_.torque));
    for (int i = 0; i < 4; ++i) spin_[i] = std::fmod(spin_[i] + out_.wheels[i].angular_velocity * dt, rs::kPi * 2);
}

void RSVehicle::_process(double) {
    // No simulated wheel positions yet: leave the wheels where the model has them (rest pose).
    if (!vehicle_ || !has_output_) return;
    // Wheel visuals: position from the suspension, steer about the car's up axis, then spin
    // about the axle (local X).
    const Basis car = get_global_transform().basis;
    for (int i = 0; i < 4; ++i) {
        if (wheel_paths_[i].is_empty()) continue;
        Node3D* w = Object::cast_to<Node3D>(get_node_or_null(wheel_paths_[i]));
        if (!w) continue;
        const rs::WheelOutput& wo = out_.wheels[i];
        Basis b = car * Basis(Vector3(0, 1, 0), wo.steer_angle) * Basis(Vector3(1, 0, 0), spin_[i]);
        w->set_global_transform(Transform3D(b, axes::to_godot(wo.centre_world)));
    }
}

std::vector<rs::OtherCar> RSVehicle::gather_others() const {
    std::vector<rs::OtherCar> v;
    SceneTree* tree = get_tree();
    if (!tree) return v;
    for (const char* group : {"rs_vehicles", "rs_obstacles"}) {
        TypedArray<Node> nodes = tree->get_nodes_in_group(group);
        for (int i = 0; i < nodes.size(); ++i) {
            RigidBody3D* b = Object::cast_to<RigidBody3D>(nodes[i]);
            if (!b || b == this) continue;
            v.push_back({axes::to_core(b->get_global_position()), axes::to_core(b->get_linear_velocity())});
        }
    }
    return v;
}

// Collision impulse measured from the car's own motion: the velocity change this tick that the
// known forces (tyres/suspension/aero from the core + gravity) do NOT explain was caused by
// collisions:  J = m |v_now - (v_prev + (F_prev / m + g) dt)|.
// (Engine-reported per-contact impulses over-count crash energy by 1.3-1.65x: measured.)
// The engine's contact list only tells us WHERE and WITH WHAT we collided.
void RSVehicle::feed_contacts(PhysicsDirectBodyState3D* st, const rs::ChassisState& cs, double dt) {
    const double m = vehicle_->config().mass;
    rs::Vec3 expected = prev_v_ + (prev_force_ / m + rs::Vec3(0, 0, -rs::kGravity * get_gravity_scale())) * prev_dt_;
    rs::Vec3 residual = cs.velocity - expected;
    prev_v_ = cs.velocity;
    prev_dt_ = dt;
    int n = st->get_contact_count();
    if (n == 0 || prev_dt_ <= 0) return;
    int best = 0;
    double best_j = -1;
    for (int i = 0; i < n; ++i) {
        double j = st->get_contact_impulse(i).length();
        if (j > best_j) { best_j = j; best = i; }
    }
    double j = m * rs::length(residual);
    if (j <= 0) return;
    // get_contact_local_position() is in GLOBAL coordinates (Godot 4 naming quirk).
    rs::Vec3 p = axes::to_core(st->get_contact_local_position(best));
    rs::Vec3 body = cs.orientation.inv_rotate(p - cs.position);
    vehicle_->add_contact((std::uint64_t)st->get_contact_collider_id(best), body, j);
}

void RSVehicle::set_ai(const Ref<RSRoute>& route, const Dictionary& d) {
    if (!vehicle_ || route.is_null() || !route->route()) return;
    rs::AIParams p;
    p.skill = d.get("skill", p.skill);
    p.reaction_time = d.get("reaction_time", p.reaction_time);
    p.headway = d.get("headway", p.headway);
    p.lane_offset = d.get("lane_offset", p.lane_offset);
    p.aggression = d.get("aggression", p.aggression);
    ai_route_ = route;
    ai_ = std::make_unique<rs::AIDriver>(vehicle_->config(), *route->route(), p);
    controls_->settings.auto_gearbox = true;
    controls_->settings.auto_clutch = true;
    vehicle_->assists().abs = vehicle_->assists().tc = vehicle_->assists().esc = true;
    raw_.device = rs::InputDevice::Wheel;
}

void RSVehicle::clear_ai() {
    ai_.reset();
    ai_route_.unref();
    raw_ = rs::RawInput{};
}

void RSVehicle::set_damage_enabled(bool on) { if (vehicle_) vehicle_->damage_enabled = on; }
bool RSVehicle::get_damage_enabled() const { return vehicle_ && vehicle_->damage_enabled; }
void RSVehicle::repair() { if (vehicle_) vehicle_->damage_model().repair(); }

Vector3 RSVehicle::core_to_godot(const Vector3& v) { return axes::to_godot(rs::Vec3(v.x, v.y, v.z)); }
Vector3 RSVehicle::godot_to_core(const Vector3& v) {
    rs::Vec3 c = axes::to_core(v);
    return Vector3(c.x, c.y, c.z);
}

double RSVehicle::get_speed_kmh() const { return get_linear_velocity().length() * 3.6; }

String RSVehicle::get_gear_label() const {
    int g = get_gear();
    if (g == 0) return "R";
    if (g == 1) return "N";
    return String::num_int64(g - 1);
}

Dictionary RSVehicle::get_telemetry() const {
    Dictionary d;
    if (!vehicle_) return d;
    const auto& grip = vehicle_->config().surface_grip;
    const double lock = vehicle_->config().front.max_steer_deg;
    d["speed_kmh"] = get_speed_kmh();
    d["rpm"] = out_.engine_rpm;
    d["redline"] = vehicle_->config().engine.redline_rpm;
    d["gear"] = get_gear_label();
    d["stalled"] = out_.engine_stalled;
    d["sideslip_deg"] = out_.sideslip * 180.0 / rs::kPi;
    d["yaw_rate"] = out_.yaw_rate;
    d["yaw_rate_ref"] = out_.assists.yaw_rate_ref;
    // accelerometer in g, body axes: x forward, y left
    d["g_long"] = out_.accel.x / rs::kGravity;
    d["g_lat"] = out_.accel.y / rs::kGravity;
    d["steer_raw"] = raw_.steer;
    d["steer_applied"] = applied_.steer;
    d["steer_deg"] = applied_.steer * lock;
    d["steer_limit"] = controls_->max_steer_fraction(out_.speed);
    d["throttle_raw"] = raw_.throttle;
    d["throttle_applied"] = out_.throttle_applied;
    d["brake_raw"] = raw_.brake;
    d["brake_applied"] = out_.brake_applied;
    d["clutch"] = applied_.clutch;
    d["device"] = (int)raw_.device;
    d["tc_cut"] = out_.assists.tc_cut;
    d["esc_mode"] = out_.assists.esc_mode;
    Array wheels;
    for (int i = 0; i < 4; ++i) {
        const rs::WheelOutput& w = out_.wheels[i];
        Dictionary wd;
        wd["contact"] = w.contact;
        wd["load"] = w.load;
        wd["fx"] = w.fx;
        wd["fy"] = w.fy;
        wd["grip_limit"] = w.grip_limit;
        wd["slip_ratio"] = w.slip_ratio;
        wd["slip_angle_deg"] = w.slip_angle * 180.0 / rs::kPi;
        wd["omega"] = w.angular_velocity;
        wd["compression"] = w.compression;
        int s = surfaces_[i];
        wd["surface"] = (s >= 0 && s < (int)grip.size()) ? String(grip[s].first.c_str()) : String("?");
        wd["abs"] = out_.assists.abs_active[i];
        wd["abs_pressure"] = out_.assists.abs_pressure[i];
        wd["esc_brake"] = out_.assists.esc_brake[i];
        wd["contact_point"] = axes::to_godot(w.contact_point);
        wd["force"] = axes::to_godot(w.force_world);
        wheels.push_back(wd);
    }
    d["wheels"] = wheels;
    const rs::DamageReport& dr = out_.damage;
    Dictionary dmg;
    Array zones, wd;
    for (double z : dr.zone) zones.push_back(z);
    for (double w : dr.wheel) wd.push_back(w);
    Array crush;
    for (double c : dr.crush) crush.push_back(c);
    dmg["zones"] = zones;          // front, rear, left, right (0..1)
    dmg["crush"] = crush;          // m of crush per zone
    dmg["last_zone"] = dr.last_zone;
    dmg["totaled"] = dr.totaled;
    dmg["totaled_reason"] = String(dr.totaled_reason.c_str());
    dmg["wheels"] = wd;
    dmg["engine"] = dr.engine;
    dmg["impacts"] = dr.impacts;
    dmg["total_kj"] = dr.total_energy_kj;
    dmg["last_kj"] = dr.last_impact_kj;
    // last impact point in Godot LOCAL car coordinates (body frame -> X left, Y up, Z forward)
    dmg["last_point"] = Vector3(dr.last_impact_point.y, dr.last_impact_point.z, dr.last_impact_point.x);
    d["damage"] = dmg;
    if (ai_) {
        Dictionary ai;
        ai["target_speed"] = ai_->target_speed;
        ai["gap_ahead"] = ai_->gap_ahead;
        ai["braking_for_traffic"] = ai_->braking_for_traffic;
        ai["recovering"] = ai_->recovering;
        ai["route_s"] = ai_->route_s;
        d["ai"] = ai;
    }
    return d;
}

void RSVehicle::_bind_methods() {
    ClassDB::bind_method(D_METHOD("set_car_config_path", "path"), &RSVehicle::set_car_config_path);
    ClassDB::bind_method(D_METHOD("get_car_config_path"), &RSVehicle::get_car_config_path);
    ADD_PROPERTY(PropertyInfo(Variant::STRING, "car_config_path"), "set_car_config_path", "get_car_config_path");

    ClassDB::bind_method(D_METHOD("set_wheel_path", "index", "path"), &RSVehicle::set_wheel_path);
    ClassDB::bind_method(D_METHOD("get_wheel_path", "index"), &RSVehicle::get_wheel_path);
    ADD_GROUP("Wheel visuals", "wheel_");
    ADD_PROPERTYI(PropertyInfo(Variant::NODE_PATH, "wheel_fl"), "set_wheel_path", "get_wheel_path", 0);
    ADD_PROPERTYI(PropertyInfo(Variant::NODE_PATH, "wheel_fr"), "set_wheel_path", "get_wheel_path", 1);
    ADD_PROPERTYI(PropertyInfo(Variant::NODE_PATH, "wheel_rl"), "set_wheel_path", "get_wheel_path", 2);
    ADD_PROPERTYI(PropertyInfo(Variant::NODE_PATH, "wheel_rr"), "set_wheel_path", "get_wheel_path", 3);

    ADD_GROUP("Raw input", "raw_");
#define RS_BIND(name, type)                                                                         \
    ClassDB::bind_method(D_METHOD("set_" #name, "value"), &RSVehicle::set_##name);                  \
    ClassDB::bind_method(D_METHOD("get_" #name), &RSVehicle::get_##name);                           \
    ADD_PROPERTY(PropertyInfo(type, #name), "set_" #name, "get_" #name);
    RS_BIND(raw_steer, Variant::FLOAT)
    RS_BIND(raw_throttle, Variant::FLOAT)
    RS_BIND(raw_brake, Variant::FLOAT)
    RS_BIND(raw_clutch, Variant::FLOAT)
    RS_BIND(raw_handbrake, Variant::FLOAT)
    ADD_GROUP("", "");
    RS_BIND(input_device, Variant::INT)
    RS_BIND(gear, Variant::INT)
#undef RS_BIND
    ClassDB::bind_method(D_METHOD("shift_up"), &RSVehicle::shift_up);
    ClassDB::bind_method(D_METHOD("shift_down"), &RSVehicle::shift_down);
    ClassDB::bind_method(D_METHOD("set_assist", "name", "enabled"), &RSVehicle::set_assist);
    ClassDB::bind_method(D_METHOD("get_assist", "name"), &RSVehicle::get_assist);
    ClassDB::bind_method(D_METHOD("get_telemetry"), &RSVehicle::get_telemetry);
    ClassDB::bind_method(D_METHOD("set_ai", "route", "params"), &RSVehicle::set_ai);
    ClassDB::bind_method(D_METHOD("clear_ai"), &RSVehicle::clear_ai);
    ClassDB::bind_method(D_METHOD("is_ai"), &RSVehicle::is_ai);
    ClassDB::bind_method(D_METHOD("set_damage_enabled", "enabled"), &RSVehicle::set_damage_enabled);
    ClassDB::bind_method(D_METHOD("get_damage_enabled"), &RSVehicle::get_damage_enabled);
    ADD_PROPERTY(PropertyInfo(Variant::BOOL, "damage_enabled"), "set_damage_enabled", "get_damage_enabled");
    ClassDB::bind_method(D_METHOD("repair"), &RSVehicle::repair);

    ClassDB::bind_method(D_METHOD("get_speed_kmh"), &RSVehicle::get_speed_kmh);
    ClassDB::bind_method(D_METHOD("get_engine_rpm"), &RSVehicle::get_engine_rpm);
    ClassDB::bind_method(D_METHOD("get_gear_label"), &RSVehicle::get_gear_label);
    ClassDB::bind_method(D_METHOD("is_engine_stalled"), &RSVehicle::is_engine_stalled);
    ClassDB::bind_method(D_METHOD("is_loaded"), &RSVehicle::is_loaded);
    ClassDB::bind_static_method("RSVehicle", D_METHOD("core_to_godot", "v"), &RSVehicle::core_to_godot);
    ClassDB::bind_static_method("RSVehicle", D_METHOD("godot_to_core", "v"), &RSVehicle::godot_to_core);
}

}  // namespace godot
