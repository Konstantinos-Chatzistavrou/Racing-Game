// Phase 4: damage, route, AI driver (incl. reaction-time pile-ups), race tracker.
#include <cmath>
#include <memory>
#include "harness.hpp"
#include "rs/ai.hpp"
#include "rs/race.hpp"

using namespace rs;

namespace {

// Rectangle of streets with rounded corners (like driving around a city block).
Route block_route(double w, double h, double r, double half_width) {
    std::vector<RouteSample> v;
    auto add = [&](double x, double y, double hd, double k) {
        RouteSample s;
        s.p = {x, y, 0};
        s.heading = hd;
        s.curvature = k;
        s.width_left = s.width_right = half_width;
        v.push_back(s);
    };
    double step = 2.0;
    double cx[4] = {w - r, w - r, r, r}, cy[4] = {r, h - r, h - r, r};
    for (int side = 0; side < 4; ++side) {
        double h0 = side * kPi / 2;                   // heading of this straight
        Vec3 a{cx[(side + 3) % 4] + r * std::cos(h0 - kPi / 2), cy[(side + 3) % 4] + r * std::sin(h0 - kPi / 2), 0};
        Vec3 b{cx[side] + r * std::cos(h0 - kPi / 2), cy[side] + r * std::sin(h0 - kPi / 2), 0};
        double L = length(b - a);
        for (double t = 0; t < L; t += step) add(a.x + (b.x - a.x) * t / L, a.y + (b.y - a.y) * t / L, h0, 0);
        for (double ang = 0; ang < kPi / 2; ang += step / r)   // left-hand 90 degree corner
            add(cx[side] + r * std::cos(h0 - kPi / 2 + ang), cy[side] + r * std::sin(h0 - kPi / 2 + ang), h0 + ang, 1.0 / r);
    }
    return Route::from_samples(v, true);
}

Route straight_route(double len, double half_width) {
    std::vector<RouteSample> v;
    for (double x = 0; x <= len; x += 2) {
        RouteSample s;
        s.p = {x, 0, 0};
        s.width_left = s.width_right = half_width;
        v.push_back(s);
    }
    return Route::from_samples(v, false);
}

struct AICar {
    std::unique_ptr<Simulation> sim;
    std::unique_ptr<Controls> ctl;
    std::unique_ptr<AIDriver> ai;
    AICar(const CarConfig& cfg, const Route& r, AIParams p, Vec3 pos, double yaw, double v) {
        sim = test::make_sim(cfg);
        sim->vehicle.assists().abs = sim->vehicle.assists().tc = true;
        sim->reset(pos, yaw, v, v > 10 ? 4 : 2);
        ctl = std::make_unique<Controls>(sim->vehicle.config());
        ctl->settings.auto_gearbox = true;
        ctl->set_gear(v > 10 ? 4 : 2);
        ai = std::make_unique<AIDriver>(sim->vehicle.config(), r, p);
    }
    void step(const std::vector<OtherCar>& others) {
        AIOutput o = ai->update(sim->body.state, sim->last, others, sim->dt);
        if (o.gear_request >= 0) ctl->set_gear(o.gear_request);
        sim->step(ctl->update(o.raw, sim->last, sim->dt));
    }
    OtherCar as_other() const { return {sim->body.state.position, sim->body.state.velocity}; }
};

}  // namespace

// ---------------------------------------------------------------- damage
RS_TEST(damage) {
    CarConfig cfg = test::car();
    std::array<Vec3, 4> wp;
    for (int w = 0; w < 4; ++w) wp[w] = {cfg.wheels[w].x, cfg.wheels[w].y, 0};
    // Full-width wall impacts at various speeds (impulse J = m v, split over 3 ticks).
    struct Case { double kmh; double crush_lo, crush_hi; bool totaled; const char* what; };
    Case cases[] = {{30, 0.27, 0.33, false, "30 km/h wall: smashed front, engine intact"},
                    {50, 0.48, 0.55, false, "50 km/h wall: engine damaged, still runs"},
                    {65, 0.64, 0.70, true, "65 km/h wall: totaled"}};
    for (const Case& c : cases) {
        DamageModel m(cfg.mass, wp);
        double j = cfg.mass * c.kmh / 3.6;
        for (int i = 0; i < 3; ++i) m.add_contact(1, {2.2, 0.1, 0}, j / 3, i / 240.0, 1 / 240.0);
        const DamageReport& r = m.report();
        std::printf("         %-46s %5.0f kJ  crush %.2f m  engine %.2f  power x%.2f  %s\n", c.what, r.total_energy_kj,
                    r.crush[ZoneFront], r.engine, m.engine_power_factor(), r.totaled ? "TOTALED" : "drivable");
        test::check_range(c.what, r.crush[ZoneFront], c.crush_lo, c.crush_hi, "m");
        test::check(c.totaled ? "  ...is totaled" : "  ...is still drivable", r.totaled == c.totaled);
    }
    // Car-to-car: 30 km/h rear-end between equal cars. Reduced mass m/2 -> J = (m/2) dv per car.
    DamageModel shunt(cfg.mass, wp);
    shunt.add_contact(2, {2.2, 0, 0}, 0.5 * cfg.mass * 30 / 3.6, 0, 1 / 240.0);
    test::check_range("30 km/h rear-end (each car): crush", shunt.report().crush[ZoneFront], 0.10, 0.18, "m");
    test::check("  ...engine untouched", shunt.report().engine == 0.0);
    // T-bone at 50 km/h into the left door: cabin intrusion -> totaled.
    DamageModel tbone(cfg.mass, wp);
    tbone.add_contact(3, {0.0, 0.95, 0}, 0.5 * cfg.mass * 50 / 3.6, 0, 1 / 240.0);
    test::check("50 km/h T-bone into the door: totaled (cabin)", tbone.report().totaled && tbone.report().totaled_reason == "cabin");
    // Pushing a wall at full throttle for 10 s (~0.8 g contact force) must cause NO damage.
    DamageModel push(cfg.mass, wp);
    for (int i = 0; i < 2400; ++i) push.add_contact(4, {2.2, 0, 0}, 0.8 * cfg.mass * kGravity / 240.0, i / 240.0, 1 / 240.0);
    test::check_range("10 s pushing a wall at 0.8 g: damage", push.report().total_energy_kj, 0, 0.0, "kJ");
    // A side hit on the front-left wheel bends it: the car then pulls (mildly) when driven straight.
    double yaw_drift[2];
    for (int dmg = 0; dmg < 2; ++dmg) {
        auto s = test::make_sim(cfg);
        s->reset({}, 0, 22, 4);
        if (dmg) s->vehicle.add_contact(3, {cfg.wheels[FL].x, 0.95, 0}, cfg.mass * 25 / 3.6);
        DriverInput in;
        in.gear = 4;
        test::SpeedController sc;
        for (int i = 0; i < 4 * 240; ++i) { sc.apply(*s, 22, in); s->step(in); }
        Vec3 fwd = s->body.state.orientation.rotate({1, 0, 0});
        yaw_drift[dmg] = std::atan2(fwd.y, fwd.x) * 180 / kPi;
    }
    std::printf("         hands-off heading change over 4 s: intact %.2f deg, bent FL wheel %.2f deg\n", yaw_drift[0], yaw_drift[1]);
    test::check_range("intact car tracks straight", std::abs(yaw_drift[0]), 0, 0.5, "deg");
    test::check_range("bent wheel makes the car pull (mildly)", std::abs(yaw_drift[1]), 1, 15, "deg");
}

// ---------------------------------------------------------------- route
RS_TEST(route) {
    Route r = block_route(200, 120, 12, 3.5);
    test::check_range("block route length", r.length(), 2 * (200 + 120) - 8 * 12 + 2 * kPi * 12 - 8, 2 * (200 + 120) - 8 * 12 + 2 * kPi * 12 + 8, "m");
    Route::Projection p = r.project({100, 2.0, 0});
    test::check_range("projection: s on the first straight", p.s, 86, 90, "m");
    test::check_range("projection: lateral offset (+ = left)", p.lateral, 1.9, 2.1, "m");
    test::check_range("delta wraps across the start line", r.delta(r.length() - 5, 5), 9.9, 10.1, "m");
}

// ---------------------------------------------------------------- AI lap
RS_TEST(ai_lap) {
    CarConfig cfg = test::car();
    Route r = block_route(220, 140, 12, 3.5);        // narrow two-lane street, 12 m corners
    AICar car(cfg, r, AIParams{}, {120, 0, 0}, 0, 0);
    car.sim->settle(0.5);
    double max_lat = 0, corner_v = 0;
    double s_start = 0, travelled = 0;
    double last_s = car.ai->route_s;
    bool started = false;
    while (car.sim->time < 120 && travelled < r.length()) {
        car.step({});
        if (!started) { started = true; s_start = car.ai->route_s; last_s = s_start; }
        travelled += r.delta(last_s, car.ai->route_s);
        last_s = car.ai->route_s;
        Route::Projection pr = r.project(car.sim->body.state.position);
        if (car.sim->time > 3) max_lat = std::max(max_lat, std::abs(pr.lateral));
        if (std::abs(r.at(pr.s).curvature) > 0.05) corner_v = std::max(corner_v, test::speed(*car.sim));
    }
    double ideal = std::sqrt(0.95 * 0.9 * 1.15 * kGravity * 12);
    std::printf("         lap of %.0f m in %.1f s, max distance from centre %.2f m, corner speed %.1f km/h (grip limit ~%.0f km/h)\n",
                r.length(), car.sim->time, max_lat, corner_v * 3.6, ideal * 3.6);
    test::check("AI completes a lap", travelled >= r.length());
    test::check_range("AI stays on a 7 m wide street", max_lat, 0, 3.5 - 0.9, "m");
    test::check_range("AI corner speed vs grip limit", corner_v / ideal, 0.8, 1.15, "x");
}

// ---------------------------------------------------------------- AI traffic: reaction time
// A lead car at 90 km/h brakes to a stop (ABS). The follower sees it only after its reaction time.
// A careful driver (0.4 s, 0.6 s headway) stops in time; an aggressive racer (0.8 s, 0.15 s
// headway) on a single-lane street (no room to swerve) cannot: that's a pile-up.
RS_TEST(ai_traffic) {
    CarConfig cfg = test::car();
    Route r = straight_route(1500, 2.3);
    const double v0 = 25;
    double min_gap[2], impact_kmh[2];
    for (int aggressive = 0; aggressive < 2; ++aggressive) {
        auto lead = test::make_sim(cfg);
        lead->vehicle.assists().abs = true;
        lead->reset({60, 0, 0}, 0, v0, 4);
        AIParams p;
        p.reaction_time = aggressive ? 0.8 : 0.4;
        p.headway = aggressive ? 0.15 : 0.6;
        p.aggression = aggressive ? 1.0 : 0.3;
        AICar follow(cfg, r, p, {60 - 4.5 - 4.0 - p.headway * v0, 0, 0}, 0, v0);
        test::SpeedController sc;
        min_gap[aggressive] = 1e9;
        impact_kmh[aggressive] = 0;
        while (lead->time < 12) {
            DriverInput in;
            in.gear = 4;
            if (lead->time < 4) sc.apply(*lead, v0, in);
            else { in.brake = 1; in.clutch = 1; }
            lead->step(in);
            follow.step({{lead->body.state.position, lead->body.state.velocity}});
            double gap = lead->body.state.position.x - follow.sim->body.state.position.x - 4.5;
            min_gap[aggressive] = std::min(min_gap[aggressive], gap);
            if (gap <= 0) {   // contact (the headless test has no car-to-car collision: stop here)
                impact_kmh[aggressive] = (follow.sim->body.state.velocity.x - lead->body.state.velocity.x) * 3.6;
                break;
            }
        }
        std::printf("         %s follower: smallest gap %.2f m, impact speed %.1f km/h\n",
                    aggressive ? "aggressive" : "careful", min_gap[aggressive], impact_kmh[aggressive]);
    }
    test::check_range("careful driver stops behind the car (gap)", min_gap[0], 0.3, 100, "m");
    test::check_range("aggressive racer hits it (closing speed)", impact_kmh[1], 5, 200, "km/h");
}

// ---------------------------------------------------------------- race tracker
RS_TEST(race) {
    Route r = block_route(200, 120, 12, 3.5);
    RaceTracker race(r, 2);
    int a = race.add_car(r.at(0).p);
    int b = race.add_car(r.at(r.length() - 8).p);    // on the grid, 8 m behind the line
    double t = 0;
    // a drives at 30 m/s, b at 25 m/s along the route
    for (int i = 0; i < 240 * 60; ++i) {
        t = i / 240.0;
        race.update(a, r.at(30 * t).p, t);
        race.update(b, r.at(r.length() - 8 + 25 * t).p, t);
        race.rank();
    }
    const RaceProgress &pa = race.progress(a), &pb = race.progress(b);
    double lap_a = r.length() / 30.0;
    std::printf("         car A: finished %d, lap %.2f s (theory %.2f), position %d; car B position %d\n",
                pa.finished, pa.last_lap, lap_a, pa.position, pb.position);
    test::check("2-lap race: A finished", pa.finished);
    test::check_range("A lap time", pa.last_lap, lap_a - 0.05, lap_a + 0.05, "s");
    test::check("A ranked first, B second", pa.position == 1 && pb.position == 2);
    // out-of-race rules (on a car that has not finished)
    int c = race.add_car(r.at(100).p);
    bool r1 = false, r2 = false;
    for (int i = 0; i < 240 * 4; ++i) r1 |= race.check_out(c, false, "", true, 0.0, 1 / 240.0, 60);   // 4 s on its roof
    for (int i = 0; i < 240 * 2; ++i) r2 |= race.check_out(c, false, "", true, 0.0, 1 / 240.0, 64);   // 6 s
    test::check("rolled over: not DNF at 4 s, DNF after 5 s", !r1 && r2 && race.progress(c).dnf_reason == "rolled over");
    int d = race.add_car(r.at(200).p);
    test::check("totaled car is DNF immediately", race.check_out(d, true, "engine", false, 5.0, 1 / 240.0, 70) &&
                race.progress(d).dnf_reason == "totaled (engine)");
    race.rank();
    test::check("DNF cars rank behind running cars", race.progress(c).position > race.progress(b).position);
}

// ---------------------------------------------------------------- race tracker where the route doubles back
// The NYC circuit has a U-turn (samples 107-109: -119 deg -> +51 deg) where both legs run a few metres apart. A car on
// the inside was projected onto the other leg, the 80 m jump was taken for a reset and ~160 m of the lap were lost.
RS_TEST(race_uturn) {
    Route r = Route::load(test::data_path("tracks/nyc_route.json"));
    for (double lane : {-3.5, 0.0, 3.5}) {
        RaceTracker race(r, 1);
        auto pos = [&](double s) { RouteSample q = r.at(s); return Vec3{q.p.x - std::sin(q.heading) * lane, q.p.y + std::cos(q.heading) * lane, 0}; };
        int c = race.add_car(pos(0.5));
        double t = 0;
        for (int i = 1; i < 240 * 120 && !race.progress(c).finished; ++i) { t = i / 240.0; race.update(c, pos(0.5 + 36 * t), t); }
        char what[96];
        std::snprintf(what, sizeof what, "lap tracked %+.1f m off the centreline (%.1f s, theory %.1f s)", lane, race.progress(c).finish_time, r.length() / 36);
        test::check(what, race.progress(c).finished && std::abs(race.progress(c).finish_time - r.length() / 36) < 0.5);
    }
}
