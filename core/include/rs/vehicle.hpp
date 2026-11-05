// Vehicle model: suspension, tyres, drivetrain, brakes, aero.
//
// HOW AN ENGINE USES IT (Godot wrapper in Phase 2, or the headless Simulation in tests):
//   every physics tick (e.g. 240 Hz):
//     1. rays = vehicle.wheel_rays(chassis)          -> engine casts 4 rays
//     2. out  = vehicle.update(chassis, contacts, dt) -> engine applies out.force / out.torque
//                                                        at the CG, plus gravity, and integrates
// Plain structs only, SI units, Z-up right-handed world. The core never integrates the chassis
// itself (the engine does, so it can resolve collisions); the stiff internal parts (wheel spin,
// clutch, differentials, tyre slip) are sub-stepped inside update() at >= 1 kHz.
#pragma once
#include <array>
#include "rs/assists.hpp"
#include "rs/config.hpp"
#include "rs/damage.hpp"
#include "rs/drivetrain.hpp"
#include "rs/math.hpp"
#include "rs/tire.hpp"

namespace rs {

struct DriverInput {
    double steer = 0;       // -1 (full right) .. +1 (full left)
    double throttle = 0;    // 0..1
    double brake = 0;       // 0..1
    double clutch = 0;      // 0 = engaged (pedal up) .. 1 = disengaged (pedal down)
    double handbrake = 0;   // 0..1
    int gear = 1;           // index into gear_ratios: 0 = reverse, 1 = neutral, 2 = 1st, ...
    bool auto_clutch = false;   // ASSIST: clutch handled automatically (launch, anti-stall, shifts)
};

struct ChassisState {       // rigid body state of the car, world frame, origin = CG
    Vec3 position;
    Quat orientation;       // body -> world
    Vec3 velocity;          // m/s
    Vec3 angular_velocity;  // rad/s, world frame
};

struct WheelRay {
    Vec3 origin;            // world, suspension top mount
    Vec3 direction;         // world, unit, pointing down the suspension axis
    double length = 0;      // m, rest length + tyre radius
};

struct WheelContact {
    bool hit = false;
    double distance = 0;    // m from ray origin to the hit point
    Vec3 point;             // world
    Vec3 normal{0, 0, 1};   // world, unit
    int surface = 0;        // index into CarConfig::surface_grip
};

struct WheelOutput {
    bool contact = false;
    double load = 0;                 // N, normal load Fz
    double compression = 0;          // m, spring compression (0 = full droop)
    double slip_ratio = 0;           // kappa (relaxed)
    double slip_angle = 0;           // rad (relaxed)
    double camber = 0;               // rad, inclination angle gamma in tyre frame (+ = top tilted left)
    double fx = 0, fy = 0;           // N, tyre-frame forces (averaged over sub-steps)
    double mz = 0;                   // N m, self-aligning moment about contact normal
    double angular_velocity = 0;     // rad/s about the axle (+ = rolling forward)
    double steer_angle = 0;          // rad
    Vec3 centre_world;               // wheel centre position (for visuals)
    Vec3 contact_point;              // world, where the tyre touches the ground
    Vec3 force_world;                // world, tyre force in the ground plane (Fx + Fy), N
    double grip_limit = 0;           // N, approx. max friction force (peak mu * surface * load)
    TireCondition condition;         // tyre temperature & wear state
};

struct VehicleOutput {
    Vec3 force;                      // world, N, total excluding gravity, applied at the CG
    Vec3 torque;                     // world, N m, about the CG
    std::array<WheelOutput, 4> wheels;
    // chassis telemetry, body frame
    double speed = 0;                // m/s, forward component of velocity
    double sideslip = 0;             // rad, beta = atan(v_y / |v_x|) (0 when slow)
    double yaw_rate = 0;             // rad/s, + = turning left
    Vec3 accel;                      // m/s^2, what an accelerometer on the CG reads (no gravity)
    AssistStatus assists;
    DamageReport damage;
    double throttle_applied = 0;     // after assists
    double brake_applied = 0;
    double engine_rpm = 0;
    int gear = 1;
    bool engine_stalled = false;
};

// Physical effect multipliers (filled from DamageModel each tick when damage is enabled).
struct DamageState {
    double engine_power = 1.0;
    std::array<double, 4> suspension_stiffness{1, 1, 1, 1};
    double aero_drag = 1.0;
    std::array<double, 4> toe{};               // rad, added to each wheel's steer angle
    std::array<double, 4> grip{1, 1, 1, 1};    // tyre grip multiplier
    double brakes = 1.0;                       // brake effectiveness (fade / failure), all brakes
};

class Vehicle {
public:
    explicit Vehicle(const CarConfig& cfg);
    Vehicle(const Vehicle&) = delete;              // drivetrain keeps a reference to cfg_
    Vehicle& operator=(const Vehicle&) = delete;

    void set_input(const DriverInput& in) { input_ = in; }
    const DriverInput& input() const { return input_; }
    const CarConfig& config() const { return cfg_; }
    DamageState& damage() { return damage_; }
    // Crash input from the engine's collision system (point in BODY frame, impulse N s).
    void add_contact(std::uint64_t object_id, const Vec3& point_body, double impulse);
    DamageModel& damage_model() { return damage_model_; }
    bool damage_enabled = true;
    AssistSettings& assists() { return assists_; }
    const AssistSettings& assists() const { return assists_; }

    std::array<WheelRay, 4> wheel_rays(const ChassisState& s) const;
    // Start already rolling at `forward_speed` (m/s): wheels spin at v/r, slips cleared.
    // If gear >= 0, the engine is also set to the matching rpm (clutch engaged at that speed).
    void reset_motion(double forward_speed, int gear = -1);
    double engine_rpm() const { return drivetrain_.engine_rpm(); }
    VehicleOutput update(const ChassisState& s, const std::array<WheelContact, 4>& contacts, double dt);

    double max_substep = 1.0 / 1000.0;   // s; internal integration step upper bound

private:
    CarConfig cfg_;
    DriverInput input_;
    DamageState damage_;
    DamageModel damage_model_;
    double time_ = 0;
    double last_dt_ = 1.0 / 240.0;
    AssistSettings assists_;
    std::array<double, 4> abs_pressure_{1, 1, 1, 1};
    double tc_cut_ = 0;
    Drivetrain drivetrain_;
    std::array<double, 4> kappa_{};      // relaxed longitudinal slip per wheel
    std::array<double, 4> tan_alpha_{};  // relaxed lateral slip (tan of slip angle) per wheel
    std::array<TireCondition, 4> tire_condition_{};
    std::array<double, 2> prev_axle_fy_{};
    int last_gear_ = 1;                     // auto-clutch: detects gear changes
    double shift_timer_ = 0;  // last lateral force per axle (geometric load transfer)

    double steer_angle(int wheel) const;
};

}  // namespace rs
