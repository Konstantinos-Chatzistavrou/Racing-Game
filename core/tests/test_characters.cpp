// The three cars must stay three different cars (same physics, own setups; data/cars/*.json):
//   Vela GT     road GT: the reference (C7 Z51 class, test_reference), least drag
//   Kestrel GT  light, high-revving, big wing: shortest stops, most grip in fast corners, quickest to turn in;
//               the drag of its wing costs top speed
//   Harrier GT  wide, heavy, twin-turbo torque: quickest to 200 km/h and fastest flat out, planted (slower to rotate)
#include <cstdio>
#include "measure.hpp"

using namespace rs;
using namespace rs::sheet;

namespace {
struct Char { Sheet sh; double fast_g = 0, turn_in = 0; };
Char run(const char* id) {
    CarConfig cfg = load_car_config(test::data_path(std::string("cars/") + id + ".json"));
    Char c;
    c.sh = measure(cfg);
    c.fast_g = skidpad(cfg, 200.0, 32.0, -1);     // 200 m radius: ~170-200 km/h at the limit, where downforce counts
    c.turn_in = step_steer(cfg);
    std::printf("         %-16s fast corner (R 200 m) %.3f g | step steer 90 %% yaw %.3f s\n", cfg.name.c_str(), c.fast_g, c.turn_in);
    return c;
}
}  // namespace

RS_TEST(characters) {
    Char gt = run("vela_gt"), kes = run("kestrel_gt"), har = run("harrier_gt");
    test::check("every car completes the launch", gt.sh.t200 > 0 && kes.sh.t200 > 0 && har.sh.t200 > 0);
    test::check("Harrier quickest to 200 km/h", har.sh.t200 > 0 && har.sh.t200 < kes.sh.t200 && har.sh.t200 < gt.sh.t200);
    test::check("Harrier fastest flat out", har.sh.vmax_kmh > gt.sh.vmax_kmh && har.sh.vmax_kmh > kes.sh.vmax_kmh);
    test::check("Kestrel shortest 60-0 stop", kes.sh.brake60 < har.sh.brake60 && kes.sh.brake60 < gt.sh.brake60);
    test::check("Kestrel most grip in the fast corner", kes.fast_g > har.fast_g && kes.fast_g > gt.fast_g);
    test::check("Kestrel: aero adds grip at speed (fast corner > skidpad)", kes.fast_g > kes.sh.skidpad_g + 0.05);
    test::check("Kestrel quickest to turn in", kes.turn_in < har.turn_in && kes.turn_in < gt.turn_in);
    test::check("Kestrel lowest top speed (wing drag)", kes.sh.vmax_kmh < gt.sh.vmax_kmh);
    test::check("both GTs out-grip the Vela on the skidpad", kes.sh.skidpad_g > gt.sh.skidpad_g && har.sh.skidpad_g > gt.sh.skidpad_g);
}
