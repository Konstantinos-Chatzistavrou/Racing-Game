#include "rs_setup.hpp"
#include <fstream>
#include <sstream>
#include <godot_cpp/core/class_db.hpp>
#include <godot_cpp/variant/utility_functions.hpp>
#include "rs/setup.hpp"
#include "rs_route.hpp"

using namespace godot;

namespace {
std::string path8(const String& p) { return RSRoute::resolve(p).utf8().get_data(); }

std::string read_file(const String& p) {
    std::ifstream f(path8(p));
    if (!f) throw std::runtime_error("cannot open " + path8(p));
    std::stringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

Dictionary to_dict(const rs::AIParams& p) {
    Dictionary d;
    d["skill"] = p.skill;
    d["reaction_time"] = p.reaction_time;
    d["headway"] = p.headway;
    d["aggression"] = p.aggression;
    d["lane_offset"] = p.lane_offset;
    return d;
}
}  // namespace

bool RSSetup::tune_car(const String& src, const String& dst, const Dictionary& d) {
    try {
        rs::Tune t;
        t.brake_bias = d.get("brake_bias", t.brake_bias);
        t.gearing = d.get("gearing", t.gearing);
        t.suspension = d.get("suspension", t.suspension);
        t.arb = d.get("arb", t.arb);
        t.diff = d.get("diff", t.diff);
        std::ofstream out(path8(dst));
        if (!out) throw std::runtime_error("cannot write " + path8(dst));
        out << rs::apply_tune(read_file(src), t);
        return true;
    } catch (const std::exception& e) {
        UtilityFunctions::push_error("RSSetup.tune_car: ", e.what());
        return false;
    }
}

Dictionary RSSetup::car_stats(const String& car_path) {
    Dictionary d;
    try {
        rs::CarStats s = rs::car_stats(rs::load_car_config(path8(car_path)));
        d["name"] = String(s.name.c_str());
        d["layout"] = String(s.layout.c_str());
        d["kw"] = s.peak_power_kw;
        d["hp"] = s.peak_power_kw * 1.341;
        d["rpm"] = s.peak_power_rpm;
        d["nm"] = s.peak_torque_nm;
        d["kg"] = s.mass_kg;
        d["w_per_kg"] = s.power_to_weight;
        d["grip"] = s.grip;
        d["downforce"] = s.downforce_area;
        d["brake_bias"] = s.brake_bias_front;
    } catch (const std::exception& e) {
        UtilityFunctions::push_error("RSSetup.car_stats: ", e.what());
    }
    return d;
}

Array RSSetup::load_rivals(const String& path) {
    Array out;
    try {
        for (const rs::Rival& r : rs::load_rivals(path8(path))) {
            Dictionary d = to_dict(r.params);
            d["name"] = String(r.name.c_str());
            out.push_back(d);
        }
    } catch (const std::exception& e) {
        UtilityFunctions::push_error("RSSetup.load_rivals: ", e.what());
    }
    return out;
}

Dictionary RSSetup::apply_difficulty(const Dictionary& d, int difficulty) {
    rs::AIParams p;
    p.skill = d.get("skill", p.skill);
    p.reaction_time = d.get("reaction_time", p.reaction_time);
    p.headway = d.get("headway", p.headway);
    p.aggression = d.get("aggression", p.aggression);
    p.lane_offset = d.get("lane_offset", p.lane_offset);
    Dictionary out = to_dict(rs::apply_difficulty(p, difficulty));
    if (d.has("name")) out["name"] = d["name"];
    return out;
}

Dictionary RSSetup::make_event(int mode, int laps, int rivals, int grid_slot) {
    rs::EventSetup e = rs::make_event(mode, laps, rivals, grid_slot);
    Dictionary d;
    d["cars"] = e.cars;
    d["player_index"] = e.player_index;
    d["laps"] = e.laps;
    return d;
}

Array RSSetup::tune_steps(const String& key) {
    Array a;
    auto add = [&](const auto& table) { for (double v : table) a.push_back(v); };
    if (key == "brake_bias") add(rs::kBrakeBiasSteps);
    else if (key == "gearing") add(rs::kGearingSteps);
    else if (key == "suspension") add(rs::kSuspensionSteps);
    else for (int i = 0; i < 3; ++i) a.push_back(i);     // arb, diff: 0 / 1 (stock) / 2
    return a;
}

void RSSetup::_bind_methods() {
    ClassDB::bind_static_method("RSSetup", D_METHOD("tune_car", "src", "dst", "tune"), &RSSetup::tune_car);
    ClassDB::bind_static_method("RSSetup", D_METHOD("car_stats", "car_path"), &RSSetup::car_stats);
    ClassDB::bind_static_method("RSSetup", D_METHOD("load_rivals", "path"), &RSSetup::load_rivals);
    ClassDB::bind_static_method("RSSetup", D_METHOD("apply_difficulty", "params", "difficulty"), &RSSetup::apply_difficulty);
    ClassDB::bind_static_method("RSSetup", D_METHOD("make_event", "mode", "laps", "rivals", "grid_slot"), &RSSetup::make_event);
    ClassDB::bind_static_method("RSSetup", D_METHOD("tune_steps", "key"), &RSSetup::tune_steps);
}
