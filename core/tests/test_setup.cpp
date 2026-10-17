// Garage tuning, spec sheet, rivals, difficulty and race events (rs/setup.hpp).
#include <cmath>
#include <fstream>
#include <sstream>
#include "harness.hpp"
#include "rs/setup.hpp"

using namespace rs;

namespace {
std::string read(const std::string& rel) {
    std::ifstream f(test::data_path(rel));
    std::stringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

// Speed gained in 2 s at full throttle in 4th gear from 100 km/h: in-gear acceleration, the thing
// gearing changes. Not 0-100 (mixes in how many shifts each ratio set needs) and not 3rd from
// 70 km/h (traction-limited there: shorter gearing only adds wheelspin).
double fourth_gear_gain(const CarConfig& cfg) {
    auto s = test::make_sim(cfg);
    s->settle(1.0);
    test::LaunchDriver drv;
    while (test::speed(*s) * 3.6 < 100 && s->time < 20) {
        DriverInput in;
        drv.apply(*s, in);
        s->step(in);
    }
    double v0 = test::speed(*s), t0 = s->time;
    while (s->time - t0 < 2.0) {
        DriverInput in;
        in.gear = 5;          // 4th
        in.throttle = 1.0;
        s->step(in);
    }
    return (test::speed(*s) - v0) * 3.6;
}
}  // namespace

RS_TEST(setup) {
    const std::string base_text = read("cars/vela_gt.json");
    const CarConfig base = parse_car_config(base_text);

    // Stock tune must not change the physics.
    const CarConfig stock = parse_car_config(apply_tune(base_text, Tune{}));
    test::check("stock tune: brake bias unchanged", stock.brake_bias_front == base.brake_bias_front);
    test::check("stock tune: final drive unchanged", stock.drivetrain.final_drive == base.drivetrain.final_drive);
    test::check("stock tune: springs unchanged", stock.front.spring_rate == base.front.spring_rate && stock.rear.spring_rate == base.rear.spring_rate);
    test::check("stock tune: anti-roll unchanged", stock.front.anti_roll_rate == base.front.anti_roll_rate);
    test::check("stock tune: diff unchanged", stock.drivetrain.rear_diff.preload == base.drivetrain.rear_diff.preload);

    // Each setting moves exactly its own numbers.
    Tune t;
    t.brake_bias = 4;
    t.gearing = 0;
    t.suspension = 2;
    t.arb = 2;
    t.diff = 2;
    const CarConfig tuned = parse_car_config(apply_tune(base_text, t));
    test::check_range("brake bias +4 %", tuned.brake_bias_front - base.brake_bias_front, 0.0399, 0.0401, "-");
    test::check_range("short gearing: final drive x1.1", tuned.drivetrain.final_drive / base.drivetrain.final_drive, 1.095, 1.105, "-");
    test::check_range("stiff: front spring x1.15", tuned.front.spring_rate / base.front.spring_rate, 1.149, 1.151, "-");
    test::check_range("stiff: rear rebound damper x1.15", tuned.rear.damper_rebound / base.rear.damper_rebound, 1.149, 1.151, "-");
    test::check_range("rear ARB bias: front x0.8", tuned.front.anti_roll_rate / base.front.anti_roll_rate, 0.799, 0.801, "-");
    test::check_range("rear ARB bias: rear x1.3", tuned.rear.anti_roll_rate / base.rear.anti_roll_rate, 1.299, 1.301, "-");
    test::check_range("locked diff: preload x2", tuned.drivetrain.rear_diff.preload / base.drivetrain.rear_diff.preload, 1.999, 2.001, "-");
    test::check("locked diff: ramps capped at 0.9", tuned.drivetrain.rear_diff.power_ramp <= 0.9 && tuned.drivetrain.rear_diff.coast_ramp <= 0.9);
    test::check("tune leaves engine and tyres alone", tuned.engine.redline_rpm == base.engine.redline_rpm && tuned.tire_front.mu_y == base.tire_front.mu_y);

    Tune wild;
    wild.brake_bias = 99;
    wild.gearing = -5;
    const CarConfig clamped = parse_car_config(apply_tune(base_text, wild));
    test::check_range("out-of-range indices clamp (bias +4 %)", clamped.brake_bias_front - base.brake_bias_front, 0.0399, 0.0401, "-");

    // Physics consequence, measured in the simulation: short gearing pulls harder in a given gear.
    Tune shortg, longg;
    shortg.gearing = 0;
    longg.gearing = 2;
    double g_short = fourth_gear_gain(parse_car_config(apply_tune(base_text, shortg)));
    double g_stock = fourth_gear_gain(base);
    double g_long = fourth_gear_gain(parse_car_config(apply_tune(base_text, longg)));
    std::printf("         4th gear, 2 s from 100 km/h: short +%.1f, stock +%.1f, long +%.1f km/h\n", g_short, g_stock, g_long);
    test::check("in-gear acceleration: short > stock > long", g_short > g_stock && g_stock > g_long);

    // Spec sheet: computed from the torque curve.
    CarStats st = car_stats(base);
    std::printf("         %s: %.0f kW @ %.0f rpm, %.0f Nm, %.0f kg, %.0f W/kg, mu %.2f\n", st.name.c_str(), st.peak_power_kw,
                st.peak_power_rpm, st.peak_torque_nm, st.mass_kg, st.power_to_weight, st.grip);
    test::check_range("Vela GT peak power", st.peak_power_kw, 330, 345, "kW");
    test::check_range("Vela GT peak torque", st.peak_torque_nm, 559, 561, "Nm");
    test::check("layout upper-case", st.layout == "RWD");

    // Rivals and difficulty.
    auto rivals = load_rivals(test::data_path("rivals.json"));
    test::check("8 rivals (one per grid slot)", rivals.size() == 8);
    AIParams p = rivals[0].params;
    AIParams easy = apply_difficulty(p, kEasy), hard = apply_difficulty(p, kHard), normal = apply_difficulty(p, kNormal);
    test::check("normal difficulty = authored values", normal.skill == p.skill && normal.reaction_time == p.reaction_time);
    test::check("easy: lower skill, slower reactions", easy.skill < p.skill && easy.reaction_time > p.reaction_time);
    test::check("hard: skill capped at 0.985", hard.skill <= 0.985 && hard.skill >= p.skill);
    test::check("hard: reaction time floor 0.25 s", hard.reaction_time >= 0.25);
    bool threw = false;
    try { parse_rivals(R"({"schema":"rivals/1","rivals":[{"name":"x","skill":1.5}]})"); } catch (const std::exception&) { threw = true; }
    test::check("rivals: skill > 1 rejected", threw);

    // Race events.
    EventSetup sr = make_event(kStreetRace, 3, 5, 3);
    test::check("street race: 5 rivals -> 6 cars, start P4", sr.cars == 6 && sr.player_index == 3 && sr.laps == 3);
    EventSetup back = make_event(kStreetRace, 1, 1, 7);
    test::check("street race: grid slot clamped to the grid", back.cars == 2 && back.player_index == 1);
    EventSetup ta = make_event(kTimeAttack, 5, 7, 7);
    test::check("time attack: alone on pole", ta.cars == 1 && ta.player_index == 0 && ta.laps == 5);
    EventSetup pk = make_event(kPackRace, 2, 0, 0);
    test::check("pack race: full grid, start last", pk.cars == kMaxCars && pk.player_index == kMaxCars - 1);
    test::check("laps >= 1", make_event(kStreetRace, 0, 3, 0).laps == 1);
}
