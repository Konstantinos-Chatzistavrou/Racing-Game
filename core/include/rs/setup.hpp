// Player-facing setup logic, shared by every engine front end:
//   - garage tuning (brake bias, gearing, suspension, anti-roll balance, differential)
//   - the car spec sheet shown in the garage (computed from the physics config, never typed in)
//   - rival roster (data/rivals.json) and difficulty scaling of the AI
//   - race events: what a menu choice (mode, laps, rivals, grid slot) means for the grid
// None of this runs per frame: it is called when a race is set up.
#pragma once
#include <array>
#include <string>
#include <vector>
#include "rs/ai.hpp"
#include "rs/config.hpp"

namespace rs {

// ------------------------------------------------------------------ garage tuning
// Each field is an index into its step table below. The default is stock.
struct Tune {
    int brake_bias = 2;   // kBrakeBiasSteps: added to the car's front brake bias
    int gearing = 1;      // kGearingSteps: final-drive multiplier (short / stock / long)
    int suspension = 1;   // kSuspensionSteps: springs + dampers multiplier (soft / stock / stiff)
    int arb = 1;          // 0 stiffer front (understeer), 1 stock, 2 stiffer rear (oversteer)
    int diff = 1;         // 0 loose, 1 stock, 2 locked (LSD preload / ramps)
};
inline constexpr std::array<double, 5> kBrakeBiasSteps = {-0.04, -0.02, 0.0, 0.02, 0.04};
inline constexpr std::array<double, 3> kGearingSteps = {1.1, 1.0, 0.9};
inline constexpr std::array<double, 3> kSuspensionSteps = {0.85, 1.0, 1.15};

// Returns the car JSON (schema car/1) with the tune applied, so it can be saved and loaded like any
// other car file. Out-of-range indices are clamped. Throws on invalid JSON.
std::string apply_tune(const std::string& car_json, const Tune& tune);

// ------------------------------------------------------------------ spec sheet
struct CarStats {
    std::string name, layout;
    double peak_power_kw = 0, peak_power_rpm = 0, peak_torque_nm = 0, mass_kg = 0;
    double power_to_weight = 0;   // W/kg
    double grip = 0;              // mean lateral peak mu of front and rear tyres
    double downforce_area = 0;    // Cl*A, m^2
    double brake_bias_front = 0;
};
CarStats car_stats(const CarConfig& cfg);

// ------------------------------------------------------------------ rivals
struct Rival {
    std::string name;
    AIParams params;
};
// data/rivals.json (schema rivals/1). Throws std::runtime_error with a readable message.
std::vector<Rival> load_rivals(const std::string& path);
std::vector<Rival> parse_rivals(const std::string& json_text);

// 0 easy (brakes earlier, reacts slower, less pushy), 1 normal (as authored), 2 hard.
enum Difficulty { kEasy = 0, kNormal = 1, kHard = 2 };
AIParams apply_difficulty(AIParams p, int difficulty);

// ------------------------------------------------------------------ race events
enum EventMode { kStreetRace = 0, kTimeAttack = 1, kPackRace = 2 };
inline constexpr int kMaxCars = 8;
struct EventSetup {
    int cars = 1;           // grid size including the player
    int player_index = 0;   // 0 = pole
    int laps = 1;
};
// grid_slot: requested start position (0 = front); clamped to the grid.
EventSetup make_event(int mode, int laps, int rivals, int grid_slot);

}  // namespace rs
