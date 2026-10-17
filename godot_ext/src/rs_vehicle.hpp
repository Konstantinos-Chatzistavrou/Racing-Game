// RSVehicle: a RigidBody3D driven by rs_core. Thin wrapper only:
//   each physics tick: raw input -> rs::Controls -> 4 wheel raycasts -> rs::Vehicle::update()
//   -> apply force/torque. Godot integrates the body (walls and other cars collide normally).
// No physics, input shaping or assist logic here: all of it is in the core.
#pragma once
#include <array>
#include <memory>
#include <godot_cpp/classes/physics_direct_body_state3d.hpp>
#include <godot_cpp/classes/physics_ray_query_parameters3d.hpp>
#include <godot_cpp/classes/rigid_body3d.hpp>
#include "rs/ai.hpp"
#include "rs/controls.hpp"
#include "rs_route.hpp"
#include "rs/vehicle.hpp"

namespace godot {

class RSVehicle : public RigidBody3D {
    GDCLASS(RSVehicle, RigidBody3D)

public:
    RSVehicle();
    ~RSVehicle() override;

    void _ready() override;
    void _process(double delta) override;
    void _integrate_forces(PhysicsDirectBodyState3D* state) override;

    // --- configuration
    void set_car_config_path(const String& p) { car_config_path_ = p; }
    String get_car_config_path() const { return car_config_path_; }
    void set_wheel_path(int i, const NodePath& p) { wheel_paths_[i] = p; }
    NodePath get_wheel_path(int i) const { return wheel_paths_[i]; }

    // --- raw device input (set by the game layer's input script every frame)
    void set_raw_steer(double v) { raw_.steer = v; }
    double get_raw_steer() const { return raw_.steer; }
    void set_raw_throttle(double v) { raw_.throttle = v; }
    double get_raw_throttle() const { return raw_.throttle; }
    void set_raw_brake(double v) { raw_.brake = v; }
    double get_raw_brake() const { return raw_.brake; }
    void set_raw_clutch(double v) { raw_.clutch = v; }
    double get_raw_clutch() const { return raw_.clutch; }
    void set_raw_handbrake(double v) { raw_.handbrake = v; }
    double get_raw_handbrake() const { return raw_.handbrake; }
    void set_input_device(int d) { raw_.device = (rs::InputDevice)(d < 0 ? 0 : (d > 2 ? 2 : d)); }
    int get_input_device() const { return (int)raw_.device; }
    void shift_up() { pending_up_ = true; }
    void shift_down() { pending_down_ = true; }
    void set_gear(int g);
    int get_gear() const;

    // --- assists (all toggleable)
    void set_assist(const String& name, bool on);
    bool get_assist(const String& name) const;

    // --- AI driver (core rs::AIDriver). params: skill, reaction_time, headway, lane_offset, aggression
    void set_ai(const Ref<RSRoute>& route, const Dictionary& params);
    void clear_ai();
    bool is_ai() const { return ai_ != nullptr; }

    // --- damage (core rs::DamageModel, fed by Godot contact impulses)
    void set_damage_enabled(bool on);
    bool get_damage_enabled() const;
    void repair();

    // --- telemetry
    double get_speed_kmh() const;
    double get_engine_rpm() const { return out_.engine_rpm; }
    String get_gear_label() const;
    bool is_engine_stalled() const { return out_.engine_stalled; }
    bool is_loaded() const { return vehicle_ != nullptr; }
    Dictionary get_telemetry() const;   // everything the debug overlay needs

    // Axis conversion for game-layer scripts (track data is in core coordinates). Wraps axes.hpp,
    // so the project still has exactly ONE conversion implementation.
    static Vector3 core_to_godot(const Vector3& v);
    static Vector3 godot_to_core(const Vector3& v);

protected:
    static void _bind_methods();

private:
    String car_config_path_ = "../data/cars/vela_gt.json";
    std::array<NodePath, 4> wheel_paths_;
    std::unique_ptr<rs::Vehicle> vehicle_;
    std::unique_ptr<rs::Controls> controls_;    // after vehicle_: references its config
    rs::RawInput raw_;
    bool pending_up_ = false, pending_down_ = false;
    rs::DriverInput applied_;
    rs::VehicleOutput out_;
    bool has_output_ = false;   // false until the first physics step (e.g. frozen on the grid / in menus)
    std::array<int, 4> surfaces_{};
    std::array<double, 4> spin_{};       // visual wheel rotation (rad)
    Ref<PhysicsRayQueryParameters3D> ray_;
    Ref<RSRoute> ai_route_;
    std::unique_ptr<rs::AIDriver> ai_;
    std::vector<rs::OtherCar> gather_others() const;
    void feed_contacts(PhysicsDirectBodyState3D* st, const rs::ChassisState& cs, double dt);
    rs::Vec3 prev_v_;                    // core-frame velocity at the previous tick
    rs::Vec3 prev_force_;                // core force applied at the previous tick
    double prev_dt_ = 0;
};

}  // namespace godot
