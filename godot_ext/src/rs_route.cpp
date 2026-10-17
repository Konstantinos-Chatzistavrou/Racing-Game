#include "rs_route.hpp"
#include <godot_cpp/classes/node3d.hpp>
#include <godot_cpp/classes/project_settings.hpp>
#include <godot_cpp/core/class_db.hpp>
#include <godot_cpp/variant/utility_functions.hpp>
#include "axes.hpp"

namespace godot {

String RSRoute::resolve(const String& path) {
    if (path.begins_with("res://")) return ProjectSettings::get_singleton()->globalize_path(path);
    if (path.is_absolute_path()) return path;
    return ProjectSettings::get_singleton()->globalize_path("res://").path_join(path);
}

bool RSRoute::load(const String& path) {
    try {
        route_ = std::make_shared<rs::Route>(rs::Route::load(resolve(path).utf8().get_data()));
        return true;
    } catch (const std::exception& e) {
        UtilityFunctions::push_error("RSRoute: ", e.what());
        return false;
    }
}

Dictionary RSRoute::project(const Vector3& gp) const {
    Dictionary d;
    if (!route_) return d;
    rs::Route::Projection p = route_->project(axes::to_core(gp));
    d["s"] = p.s;
    d["lateral"] = p.lateral;
    return d;
}

Dictionary RSRoute::sample(double s) const {
    Dictionary d;
    if (!route_) return d;
    rs::RouteSample r = route_->at(s);
    d["position"] = axes::to_godot(r.p);
    d["forward"] = axes::to_godot(route_->tangent(s));
    d["left"] = axes::to_godot(route_->left(s));
    d["width_left"] = r.width_left;
    d["width_right"] = r.width_right;
    d["curvature"] = r.curvature;
    return d;
}

void RSRoute::_bind_methods() {
    ClassDB::bind_method(D_METHOD("load", "path"), &RSRoute::load);
    ClassDB::bind_method(D_METHOD("get_length"), &RSRoute::get_length);
    ClassDB::bind_method(D_METHOD("project", "position"), &RSRoute::project);
    ClassDB::bind_method(D_METHOD("sample", "s"), &RSRoute::sample);
}

void RSRace::setup(const Ref<RSRoute>& route, int laps) {
    route_ = route;
    cars_.clear();
    tracker_ = (route.is_valid() && route->route()) ? std::make_unique<rs::RaceTracker>(*route->route(), laps) : nullptr;
}

int RSRace::add_car(Object* v) {
    Node3D* n = Object::cast_to<Node3D>(v);
    if (!tracker_ || !n) return -1;
    cars_.push_back(ObjectID(n->get_instance_id()));
    return tracker_->add_car(axes::to_core(n->get_global_position()));
}

void RSRace::update(double time) {
    if (!tracker_) return;
    for (size_t i = 0; i < cars_.size(); ++i) {
        Node3D* n = Object::cast_to<Node3D>(ObjectDB::get_instance(cars_[i]));
        if (n) tracker_->update((int)i, axes::to_core(n->get_global_position()), time);
    }
    tracker_->rank();
}

Dictionary RSRace::get_progress(int car) const {
    Dictionary d;
    if (!tracker_ || car < 0 || car >= tracker_->car_count()) return d;
    const rs::RaceProgress& p = tracker_->progress(car);
    d["lap"] = p.lap;
    d["laps"] = tracker_->laps();
    d["position"] = p.position;
    d["distance"] = p.distance;
    d["last_lap"] = p.last_lap;
    d["best_lap"] = p.best_lap;
    d["finished"] = p.finished;
    d["finish_time"] = p.finish_time;
    d["dnf"] = p.dnf;
    d["dnf_reason"] = String(p.dnf_reason.c_str());
    d["dnf_time"] = p.dnf_time;
    return d;
}

bool RSRace::check_out(int car, bool totaled, const String& reason, bool upside_down, double speed, double dt, double time) {
    return tracker_ && car >= 0 && car < tracker_->car_count() &&
           tracker_->check_out(car, totaled, reason.utf8().get_data(), upside_down, speed, dt, time);
}

bool RSRace::all_done() const { return tracker_ && tracker_->all_done(); }

void RSRace::_bind_methods() {
    ClassDB::bind_method(D_METHOD("check_out", "car", "totaled", "reason", "upside_down", "speed", "dt", "time"), &RSRace::check_out);
    ClassDB::bind_method(D_METHOD("all_done"), &RSRace::all_done);
    ClassDB::bind_method(D_METHOD("setup", "route", "laps"), &RSRace::setup);
    ClassDB::bind_method(D_METHOD("add_car", "vehicle"), &RSRace::add_car);
    ClassDB::bind_method(D_METHOD("update", "time"), &RSRace::update);
    ClassDB::bind_method(D_METHOD("get_progress", "car"), &RSRace::get_progress);
    ClassDB::bind_method(D_METHOD("get_car_count"), &RSRace::get_car_count);
}

}  // namespace godot
