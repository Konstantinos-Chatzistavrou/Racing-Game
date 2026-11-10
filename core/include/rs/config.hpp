// Car configuration: everything that defines a car's physics, loaded from data/cars/*.json
// (schema "car/1", see data/schema/car.schema.json). Adding a car needs no code changes.
#pragma once
#include <array>
#include <string>
#include <vector>

namespace rs {

// Pacejka "Magic Formula" coefficients (MF 5.2 / 6.1). Notation follows Pacejka,
// "Tire and Vehicle Dynamics" (3rd ed.), chapter 4 & 7. See docs/physics.md for the equations.
struct TireParams {
    double radius = 0.33;             // m, nominal unloaded/reference radius R0
    double inertia = 1.0;             // kg m^2, wheel + tyre + brake disc about the axle
    double fz0 = 4000;                // N, nominal load Fz0 the coefficients refer to
    double vertical_stiffness = 220000; // N/m, radial carcass stiffness C_Fz (effective rolling radius)
    // longitudinal (pure slip, MF 5.2)
    double cx = 1.65;                 // shape factor pCx1
    double mu_x = 1.25;               // peak friction coefficient pDx1 at Fz0
    double pdx2 = -0.08;              // load sensitivity of mu: pDx2 (mu drops with load)
    double pdx3 = 0.0;                // camber sensitivity of longitudinal friction: pDx3
    double ex = 0.1;                  // curvature factor pEx1 at Fz0
    double pex2 = -0.12;              // variation of curvature Ex with dfz
    double pex3 = -0.05;              // variation of curvature Ex with dfz^2
    double pex4 = 0.0;                // driving/braking asymmetry of Ex
    double kx = 25.0;                 // slip stiffness per unit load pKx1: Kx0 = pKx1 * Fz  [1/-]
    double pkx2 = -0.06;              // variation of slip stiffness with dfz
    double pkx3 = 0.08;               // exponential load sensitivity of slip stiffness
    double phx1 = 0.0, phx2 = 0.0;    // horizontal shift SHx
    double pvx1 = 0.0, pvx2 = 0.0;    // vertical shift SVx / Fz
    // lateral (pure slip + camber, MF 5.2)
    double cy = 1.3;                  // shape factor pCy1
    double mu_y = 1.2;                // peak lateral friction pDy1 at Fz0, gamma = 0
    double pdy2 = -0.1;               // load sensitivity of lateral mu: pDy2
    double pdy3 = 0.8;                // camber sensitivity of peak lateral friction: pDy3 (1 - pDy3 gamma^2)
    double ey = -0.4;                 // curvature factor pEy1 at Fz0
    double pey2 = -0.04;              // variation of curvature Ey with dfz
    double pey3 = 0.0;                // zero-camber asymmetry of Ey
    double pey4 = -0.5;               // variation of curvature Ey with camber gamma
    double pky1 = 20.0;               // cornering stiffness peak / Fz0  [1/rad]
    double pky2 = 2.0;                // load (in Fz0 units) at which cornering stiffness peaks
    double pky3 = 0.12;               // variation of cornering stiffness with |gamma|
    double phy1 = 0.0, phy2 = 0.0;    // load-dependent lateral horizontal shift
    double phy3 = 0.08;               // camber contribution to horizontal shift SHy
    double pvy1 = 0.0, pvy2 = 0.0;    // load-dependent lateral vertical shift
    double pvy3 = 0.25;               // camber thrust vertical shift at Fz0
    double pvy4 = -0.08;              // variation of camber thrust vertical shift with dfz
    // combined slip weighting (MF 5.2: Gxa, Gyk, SVyk)
    double rbx1 = 12.0, rbx2 = 10.0, rbx3 = 0.0, rcx1 = 1.0, rex1 = -0.05, rex2 = -0.02, rhx1 = 0.0;
    double rby1 = 10.0, rby2 = 10.0, rby3 = 0.0, rby4 = 0.0, rcy1 = 1.0, rey1 = -0.05, rey2 = -0.02, rhy1 = 0.0, rhy2 = 0.0;
    double rvy1 = 0.0, rvy2 = 0.0, rvy3 = -0.15, rvy4 = 14.0, rvy5 = 1.9, rvy6 = 10.0;
    // self-aligning moment Mz (pneumatic trail t + residual torque Mzr + Fx arm s, MF 5.2)
    double qbz1 = 10.5, qbz2 = -1.4, qbz3 = -0.4, qbz4 = 0.0, qbz5 = 0.25;
    double qcz1 = 1.18;
    double qdz1 = 0.11, qdz2 = -0.02, qdz3 = 0.0, qdz4 = -1.0;
    double qez1 = -1.6, qez2 = -0.35, qez3 = 0.0, qez4 = 0.15, qez5 = -0.7;
    double qhz1 = 0.0, qhz2 = 0.0, qhz3 = 0.005, qhz4 = -0.005;
    double qbz9 = 12.0, qbz10 = 0.75;
    double qdz6 = 0.0, qdz7 = 0.0, qdz8 = 0.14, qdz9 = 0.04;
    double ssz1 = 0.0, ssz2 = 0.02, ssz3 = 0.5, ssz4 = -0.15;
    // transient behaviour: nominal relaxation lengths at Fz0 (m). Scaled dynamically by K(Fz)/C_F.
    double relax_x = 0.12, relax_y = 0.30;
    double rolling_resistance = 0.012;   // F_rr = (c_rr0 + c_rr2 * (v/30)^2) * Fz
    double rolling_resistance_v2 = 0.001; // speed-dependent rolling hysteresis
    // MF 6.1 additions
    // Friction falls with sliding speed (rubber friction, Persson): lambda_mu* = 1 / (1 + LMUV Vs / V0), Vs = |slip
    // velocity|, V0 = 16.7 m/s (LONGVL). The slip curves alone can't tell a 10 km/h slide from a 100 km/h one.
    double lmuv = 0.12;
    double lmuv_ref_mps = 1.5;        // sliding speed the mu coefficients were fitted at (normal cornering): no decay there
    // Inflation pressure (gauge, kPa): nominal (the coefficients' reference) and cold set pressure. Hot pressure follows
    // the gas law from the tyre's core temperature; dpi = (p - p_nom) / p_nom changes slip stiffness and friction
    // (Pacejka 3rd ed. Table 4.2 passenger tyre: PPX1..4, PPY1..4).
    double p_nominal_kpa = 220, p_cold_kpa = 188;   // 188 kPa cold -> ~220 kPa with the core at ~80 C
    double ppx1 = -0.3485, ppx2 = 0.37824, ppx3 = -0.09603, ppx4 = 0.06518;
    double ppy1 = -0.6255, ppy2 = -0.06523, ppy3 = -0.16666, ppy4 = 0.2811;
    // MF 6.1 turn slip (spin): peak lateral force and cornering stiffness drop when the contact patch also rotates
    // (tight turns at low speed, parking). Pacejka's default coefficients.
    double pdyp1 = 0.4, pdyp2 = 0.0, pdyp3 = 0.0, pdyp4 = 0.0, pkyp1 = 1.0;
    // Thermal window: core/surface blend temperature with full grip (C), and the half-width of the window.
    double temp_optimal_c = 90, temp_window_c = 25;
};

/** Brakes: disc + pad thermal model (per axle). */
struct BrakeThermal {
    double disc_mass_front = 8.5, disc_mass_rear = 6.0;   // kg (cast iron, c = 460 J/kg K)
    double disc_area_front = 0.13, disc_area_rear = 0.10; // m^2 of radiating / cooled surface
    // Convective cooling h A = base + per_mps v (W/K). A ducted, vented disc sheds ~80 W/K at 30 m/s and ~180 W/K at
    // 70 m/s (h ~200-450 W/m^2K over ~0.4 m^2 of faces and vanes): a 600 C disc drops 15-25 C/s on a fast straight,
    // so only repeated hard stops from high speed with little air in between push it into fade.
    double cooling_base = 5.0, cooling_per_mps = 2.5;
    double start_temp_c = 150;                             // warm brakes
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
    double static_camber_deg = -1.5;  // deg, negative = top of wheel tilted inward
    double camber_gain_rad_per_m = -0.785; // rad/m of suspension compression (~-45 deg/m double-wishbone camber recovery)
    double caster_deg = 6.8;          // deg, steering axis caster angle (induces negative camber on outer steered wheel)
    double kpi_deg = 7.0;             // deg, kingpin inclination angle
    double handbrake_torque = 0;      // N m per wheel
    bool driven = false;
    // ---- suspension kinematics (double-wishbone-like defaults; dz = compression from static, m, + = bump)
    double camber_gain2_rad_per_m2 = -4.0;  // quadratic camber curve: camber(dz) = static + g1 dz + g2 dz^2 (recovery grows in bump)
    double static_toe_deg = 0.0;            // + = toe-in
    double bump_steer_deg_per_m = 0.0;      // toe-in change per metre of bump (+ = toes in under bump)
    double roll_centre_gain = -1.8;         // roll centre height change per metre of axle heave (drops ~1.8x the body)
    double anti_pitch = 0.0;                // front: anti-dive (braking) / anti-lift (front drive); rear: anti-squat (drive)
    double anti_lift_rear_braking = 0.0;    // rear: anti-lift under braking
    // ---- dampers: digressive valving (firm at low shaft speed for body control, softer past the knee for bumps)
    double damper_knee_mps = 0.13;
    double damper_high_speed_ratio = 0.45;  // coefficient above the knee / below it
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
    // Ride-height sensitivity: underbody and diffuser work harder closer to the road; nose-down pitch moves the
    // aero balance forward. Changes per metre of mean / front-minus-rear compression from static.
    double ground_effect_per_m = 1.5;     // downforce * (1 + this * mean compression), clamped 0.6 .. 1.5
    double pitch_balance_per_m = 1.0;     // front balance + this * (front - rear compression)
};

struct CarConfig {
    std::string name;
    double mass = 1450;                       // kg, total (sprung + unsprung; wheels massless here)
    double cg_height = 0.47;                  // m above ground at static ride height
    double weight_front = 0.48;               // static front axle load fraction
    double wheelbase = 2.65;
    double inertia_xx = 550, inertia_yy = 2100, inertia_zz = 2400;   // kg m^2 about the CG
    double brake_bias_front = 0.62;           // fraction of total brake torque on the front axle
    double brake_torque_total = 7000;         // N m, all four wheels together at full pedal (pads in their range)
    BrakeThermal brake_thermal;
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
