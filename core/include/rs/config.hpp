// Car configuration: everything that defines a car's physics, loaded from data/cars/*.json
// (schema "car/1", see data/schema/car.schema.json). Adding a car needs no code changes.
#pragma once
#include <array>
#include <string>
#include <vector>

namespace rs {

// Pacejka "Magic Formula" coefficients (MF 5.2 subset). Notation follows Pacejka,
// "Tire and Vehicle Dynamics" (3rd ed.), chapter 4. See docs/physics.md for the equations.
struct TireParams {
    double radius = 0.33;             // m, loaded radius used for rolling (simplification)
    double inertia = 1.0;             // kg m^2, wheel + tyre + brake disc about the axle
    double fz0 = 4000;                // N, nominal load the coefficients refer to
    // longitudinal (pure slip)
    double cx = 1.65;                 // shape factor C
    double mu_x = 1.25;               // peak friction coefficient at Fz0
    double pdx2 = -0.08;              // load sensitivity of mu: mu = mu0 (1 + pdx2 dfz)
    double ex = 0.1;                  // curvature factor E
    double kx = 25.0;                 // slip stiffness per unit load: Kx = kx * Fz  [1/-]
    // lateral (pure slip)
    double cy = 1.3;
    double mu_y = 1.2;
    double pdy2 = -0.1;
    double ey = -0.4;
    double pky1 = 20.0;               // cornering stiffness peak / Fz0  [1/rad]
    double pky2 = 2.0;                // load (in Fz0 units) at which cornering stiffness peaks
    // combined slip weighting (MF 5.2: rBx1, rBx2, rCx1, rBy1, rBy2, rCy1)
    double rbx1 = 12.0, rbx2 = 10.0, rcx1 = 1.0;
    double rby1 = 10.0, rby2 = 10.0, rcy1 = 1.0;
    // transient behaviour: relaxation lengths (m). Slip builds up over this rolled distance.
    double relax_x = 0.12, relax_y = 0.30;
    double rolling_resistance = 0.012;   // F_rr = c_rr * Fz
};

struct WheelGeom {
    // Filled in at load time from axle data. Body frame, metres, relative to the CG.
    double x = 0, y = 0;
    double mount_z = 0;               // suspension top mount height (ray origin)
    double static_compression = 0;    // m, spring compression at rest
};

struct AxleParams {
    double track = 1.6;               // m, distance between wheel centres
    double spring_rate = 70000;       // N/m, at the wheel (wheel rate)
    double spring_rest_length = 0.25; // m, free length mount->wheel centre (also max droop)
    double max_compression = 0.12;    // m, travel from static before the bump stop
    double bump_stop_rate = 300000;   // N/m beyond max_compression
    double damper_bump = 3500;        // N s/m, compression
    double damper_rebound = 6500;     // N s/m, extension
    double anti_roll_rate = 20000;    // N/m, force per metre of left/right compression difference
    double roll_centre_height = 0.05; // m above ground: lateral tyre forces act on the body here
    double max_steer_deg = 0;         // >0 = steered axle
    double steer_compliance = 0;      // rad per N of axle lateral force (bushing/rack flex)
    double ackermann = 0.0;           // 0 = parallel steer, 1 = full Ackermann
    double handbrake_torque = 0;      // N m per wheel
    bool driven = false;
};

struct DiffParams {
    std::string type = "open";        // "open", "locked", "lsd"
    double preload = 0;               // N m, LSD locking torque at zero input torque
    double power_ramp = 0;            // locking torque per N m of input torque, on power
    double coast_ramp = 0;            // ... off power (engine braking)
};

struct EngineParams {
    std::vector<std::array<double, 2>> torque_curve;   // [rpm, N m] at full throttle
    double idle_rpm = 900, redline_rpm = 7500;
    double inertia = 0.25;            // kg m^2 crank + flywheel
    double friction_const = 20;       // N m, engine braking: T = c0 + c1 * omega (throttle off)
    double friction_linear = 0.03;    // N m / (rad/s)
};

struct DrivetrainParams {
    std::vector<double> gear_ratios;  // index 0 = reverse (negative), 1 = neutral (0), 2.. forward
    double final_drive = 3.7;
    double efficiency = 0.92;         // gearbox + diff, applied to drive torque
    double clutch_max_torque = 900;   // N m capacity at fully released pedal
    double driveline_inertia = 0.05;  // kg m^2 gearbox input side
    std::string layout = "rwd";       // "rwd", "fwd", "awd"
    double awd_front_split = 0.4;     // torque fraction to the front (centre diff)
    DiffParams front_diff, rear_diff, centre_diff;
};

struct AeroParams {
    double air_density = 1.225;
    double drag_area = 0.68;          // Cd * A, m^2
    double lift_area = 0.3;           // Cl * A (downforce positive), m^2
    double front_balance = 0.45;      // fraction of downforce on the front axle
};

struct CarConfig {
    std::string name;
    double mass = 1450;                       // kg, total (sprung + unsprung; wheels massless here)
    double cg_height = 0.47;                  // m above ground at static ride height
    double weight_front = 0.48;               // static front axle load fraction
    double wheelbase = 2.65;
    double inertia_xx = 550, inertia_yy = 2100, inertia_zz = 2400;   // kg m^2 about the CG
    double brake_bias_front = 0.62;           // fraction of total brake torque on the front axle
    double brake_torque_total = 7000;         // N m, all four wheels together at full pedal
    AxleParams front, rear;
    TireParams tire_front, tire_rear;
    EngineParams engine;
    DrivetrainParams drivetrain;
    AeroParams aero;
    std::vector<std::pair<std::string, double>> surface_grip;   // surface name -> grip multiplier

    // derived (set by finalize())
    std::array<WheelGeom, 4> wheels{};        // 0 FL, 1 FR, 2 RL, 3 RR
    double dist_cg_front = 0, dist_cg_rear = 0;

    const AxleParams& axle(int wheel) const { return wheel < 2 ? front : rear; }
    const TireParams& tire(int wheel) const { return wheel < 2 ? tire_front : tire_rear; }
    double grip_for_surface(int surface_index) const;
    int surface_index(const std::string& name) const;
    void finalize();   // computes wheel geometry so the car sits at cg_height when at rest
};

// Throws std::runtime_error with a readable message on missing/invalid fields.
CarConfig load_car_config(const std::string& path);
CarConfig parse_car_config(const std::string& json_text);

enum Wheel { FL = 0, FR = 1, RL = 2, RR = 3 };

}  // namespace rs
