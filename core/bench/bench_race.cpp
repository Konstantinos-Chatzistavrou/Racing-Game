// CPU cost of the core for a full grid: AI + controls, physics and race tracker for 8 cars on the
// real city route, 30 simulated seconds at 240 Hz. Headless, no engine. Run after any change to
// the core that runs every tick, and compare with docs/performance.md.
//   core/build/rs_bench data/cars/vela_gt.json data/tracks/city_route.json
#include <chrono>
#include <cmath>
#include <cstdio>
#include <memory>
#include <vector>
#include "rs/ai.hpp"
#include "rs/controls.hpp"
#include "rs/race.hpp"
#include "rs/route.hpp"
#include "rs/sim.hpp"
using namespace rs;
using clk = std::chrono::steady_clock;
int main(int, char** argv) {
    CarConfig cfg = load_car_config(argv[1]);
    Route r = Route::load(argv[2]);
    const int n = 8;
    std::vector<std::unique_ptr<Simulation>> sims;
    std::vector<std::unique_ptr<Controls>> ctls;
    std::vector<std::unique_ptr<AIDriver>> ais;
    RaceTracker race(r, 3);
    for (int k = 0; k < n; ++k) {
        RouteSample p = r.at(75.0 - 9.0 * k);
        auto s = std::make_unique<Simulation>(cfg, std::make_shared<PlaneGround>(Vec3{0, 0, 1}));
        s->dt = 1.0 / 240.0;
        s->vehicle.assists().abs = s->vehicle.assists().tc = true;
        s->reset({p.p.x + (k % 2 ? 2.4 : -2.4) * -std::sin(p.heading), p.p.y + (k % 2 ? 2.4 : -2.4) * std::cos(p.heading), 0}, p.heading, 0, 2);
        auto c = std::make_unique<Controls>(s->vehicle.config());
        c->settings.auto_gearbox = c->settings.auto_clutch = true;
        AIParams ap;
        ap.lane_offset = k % 2 ? 1.0 : -1.0;
        ais.push_back(std::make_unique<AIDriver>(s->vehicle.config(), r, ap));
        race.add_car(s->body.state.position);
        sims.push_back(std::move(s));
        ctls.push_back(std::move(c));
    }
    double t_ai = 0, t_phys = 0, t_race = 0;
    const int N = 240 * 30;
    for (int i = 0; i < N; ++i) {
        std::vector<OtherCar> all;
        for (auto& s : sims) all.push_back({s->body.state.position, s->body.state.velocity});
        for (int k = 0; k < n; ++k) {
            std::vector<OtherCar> others;
            for (int j = 0; j < n; ++j) if (j != k) others.push_back(all[j]);
            auto a = clk::now();
            AIOutput o = ais[k]->update(sims[k]->body.state, sims[k]->last, others, sims[k]->dt);
            if (o.gear_request >= 0) ctls[k]->set_gear(o.gear_request);
            DriverInput in = ctls[k]->update(o.raw, sims[k]->last, sims[k]->dt);
            auto b = clk::now();
            sims[k]->step(in);
            auto c = clk::now();
            race.update(k, sims[k]->body.state.position, i / 240.0);
            auto d = clk::now();
            t_ai += std::chrono::duration<double, std::micro>(b - a).count();
            t_phys += std::chrono::duration<double, std::micro>(c - b).count();
            t_race += std::chrono::duration<double, std::micro>(d - c).count();
        }
    }
    double per = 1.0 / (N * n);
    std::printf("per car per tick: AI+controls %.2f us, physics %.2f us, race tracker %.2f us\n", t_ai * per, t_phys * per, t_race * per);
    std::printf("8 cars, 4 ticks per 60 fps frame: %.3f ms per frame total\n", (t_ai + t_phys + t_race) / N * 4 / 1000.0);
}
