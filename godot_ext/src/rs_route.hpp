// RSRoute / RSRace: Godot handles for the core's race route and race tracker.
#pragma once
#include <memory>
#include <vector>
#include <godot_cpp/classes/ref.hpp>
#include <godot_cpp/classes/ref_counted.hpp>
#include <godot_cpp/variant/dictionary.hpp>
#include "rs/race.hpp"
#include "rs/route.hpp"

namespace godot {

class RSRoute : public RefCounted {
    GDCLASS(RSRoute, RefCounted)
public:
    bool load(const String& path);              // absolute, res://, or relative to the project
    double get_length() const { return route_ ? route_->length() : 0.0; }
    Dictionary project(const Vector3& godot_pos) const;   // {s, lateral}
    Dictionary sample(double s) const;                    // {position, forward, left, width_left, width_right}
    const rs::Route* route() const { return route_.get(); }
    static String resolve(const String& path);
protected:
    static void _bind_methods();
private:
    std::shared_ptr<rs::Route> route_;
};

class RSVehicle;

class RSRace : public RefCounted {
    GDCLASS(RSRace, RefCounted)
public:
    void setup(const Ref<RSRoute>& route, int laps);
    int add_car(Object* vehicle);               // RSVehicle (or any Node3D)
    void update(double time);                    // call once per physics tick
    Dictionary get_progress(int car) const;      // {lap, laps, position, distance, last_lap, best_lap, finished, finish_time}
    // Out-of-race rule (core): returns true on the tick the car becomes DNF.
    bool check_out(int car, bool totaled, const String& reason, bool upside_down, double speed, double dt, double time);
    bool all_done() const;
    int get_car_count() const { return (int)cars_.size(); }
protected:
    static void _bind_methods();
private:
    Ref<RSRoute> route_;
    std::unique_ptr<rs::RaceTracker> tracker_;
    std::vector<ObjectID> cars_;
};

}  // namespace godot
