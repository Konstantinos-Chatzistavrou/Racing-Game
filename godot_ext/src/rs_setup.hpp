// RSSetup: Godot access to the core's setup logic (rs/setup.hpp): garage tuning, car spec sheet,
// rivals, difficulty, race events. Static functions only; nothing here runs per frame.
#pragma once
#include <godot_cpp/classes/ref_counted.hpp>
#include <godot_cpp/variant/array.hpp>
#include <godot_cpp/variant/dictionary.hpp>

namespace godot {

class RSSetup : public RefCounted {
    GDCLASS(RSSetup, RefCounted)
public:
    // Writes src car JSON with the tune applied to dst. tune: {brake_bias, gearing, suspension, arb, diff}
    static bool tune_car(const String& src, const String& dst, const Dictionary& tune);
    static Dictionary car_stats(const String& car_path);   // {name, layout, kw, rpm, nm, kg, w_per_kg, grip, downforce, brake_bias}
    static Array load_rivals(const String& path);          // [{name, skill, reaction_time, headway, aggression, lane_offset}]
    static Dictionary apply_difficulty(const Dictionary& params, int difficulty);
    static Dictionary make_event(int mode, int laps, int rivals, int grid_slot);   // {cars, player_index, laps}
    static Array tune_steps(const String& key);            // step values of one tune setting (for UI labels)
protected:
    static void _bind_methods();
};

}  // namespace godot
