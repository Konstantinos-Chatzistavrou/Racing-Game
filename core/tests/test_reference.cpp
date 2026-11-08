// Phase 5: the Vela GT against a real car of the same class, measured the way magazines do.
//
// Reference: Chevrolet Corvette C7 Stingray Z51 (2014). Front engine, RWD, 343 kW, ~1496 kg,
// 245/35 R19 front + 285/30 R20 rear summer tyres - the Vela GT's class (341 kW, 1450 kg,
// 245/35 R19 + 285/30 R19). Published figures (sources in docs/handling_reference.md):
//   0-60 mph            3.8 s (GM), 3.9 s (MotorTrend)      US practice: 1 ft rollout excluded
//   60-0 mph            104 ft = 31.7 m (MotorTrend), 107 ft = 32.6 m (GM)
//   skidpad             1.03 g sustained (GM, 300 ft), 1.11 g (MotorTrend)
//   top speed           ~290 km/h (180 mph class)
// Ranges below allow for the Vela being a different car (46 kg lighter, 19" rears, less aero).
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include "measure.hpp"

using namespace rs;

using namespace rs::sheet;


RS_TEST(reference) {
    // Vela GT vs Corvette C7 Z51
    Sheet gt = measure(test::car());
    test::check_range("0-60 mph (1 ft rollout)  [C7 Z51 3.8-3.9 s]", gt.t60, 3.6, 4.1, "s");
    test::check_range("60-0 mph, ABS            [C7 Z51 31.7-32.6 m]", gt.brake60, 30.5, 33.5, "m");
    test::check_range("skidpad 300 ft           [C7 Z51 1.03-1.11 g]", gt.skidpad_g, 1.00, 1.10, "g");
    test::check_range("top speed                [C7 Z51 ~290 km/h]", gt.vmax_kmh, 275, 305, "km/h");

    // The track car must stay ahead of the road car: more power, less mass, more downforce. Off the line both are
    // traction-limited (launch technique decides hundredths), so power is checked where it matters: 0-200 km/h.
    Sheet kes = measure(load_car_config(test::data_path("cars/kestrel_gt.json")));
    test::check("0-200 km/h: Kestrel GT quicker than Vela GT", kes.t200 < gt.t200);
    test::check("braking: Kestrel GT shorter than Vela GT", kes.brake60 < gt.brake60);
    test::check("top speed: Vela GT faster (less drag)", gt.vmax_kmh > kes.vmax_kmh);
}
