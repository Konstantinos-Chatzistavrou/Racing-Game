# Phase 5: handling against a real car (2026-10-17)

## Reference car
Chevrolet Corvette C7 Stingray Z51 (2014): front engine, RWD, 343 kW, ~1496 kg, 245/35 R19 front,
285/30 R20 rear summer tyres. Closest real match to the Vela GT (341 kW, 1450 kg, 245/35 R19 +
285/30 R19). Published figures:
| measure | figure | source |
|---|---|---|
| 0-60 mph | 3.8 s (GM), 3.9 s (MotorTrend) | Motor Authority, Carscoops |
| 60-0 mph | 104 ft = 31.7 m (MotorTrend), 107 ft = 32.6 m (GM) | Carscoops, GTspirit |
| skidpad | 1.03 g sustained (GM), 1.11 g (MotorTrend) | GTspirit, Carscoops |
| top speed | ~290 km/h | manufacturer class figure |
Sources: https://www.motorauthority.com/news/1084923_2014-chevy-corvette-stingray-z51-0-60-in-3-8-seconds ,
https://carscoops.com/?p=141544 , https://gtspirit.com/?p=72172 ,
https://www.autoguide.com/manufacturer/chevrolet/2014-chevrolet-corvette-stingray-z51-track-test-3943.html ,
https://www.torquenews.com/106/first-real-world-quarter-mile-0-60-2014-chevrolet-corvette-announced

## Method (core/tests/test_reference.cpp, headless, `rs_tests reference`)
Measured the way US magazines do: 0-60 mph from 1 ft of rollout with a manual-gearbox human shift
(0.35 s); 60-0 mph full pedal with ABS; steady-state skidpad on a 300 ft DIAMETER circle; top
speed = terminal speed in top gear.

## Findings
1. The old acceleration test (0-100 in 4.74 s) included 0.5 s of revving before the clutch was
   released. Timed properly the car was already on target: measurement error, not physics.
2. The test driver dumped the clutch, spun the tyres (slip ratio 2-5), cut the throttle and bogged
   the engine to ~700 rpm. It now feeds the clutch out against tyre slip, aims the throttle at peak
   slip and never lets the revs drop below ~2/3 of launch rpm.
3. Real physics gap: braking 4 % long and skidpad 4 % low -> tyre peak friction raised on all three
   cars (lateral +0.06, longitudinal +0.07: GT now 1.27/1.21 front, 1.30/1.24 rear). Summer UHP
   tyres reach ~1.2-1.3 on dry asphalt. Car order (Touring < GT < GT-R) unchanged.
4. Off the line all three cars are traction-limited, so 0-60 mph does not rank them by power
   (GT-R 3.99 s vs GT 3.92 s is launch technique noise). Power is ranked on 0-200 km/h instead.

## Result
| car | 0-60 mph | 0-100 km/h | 0-200 km/h | 60-0 mph | skidpad | top speed |
|---|---|---|---|---|---|---|
| Corvette C7 Z51 (real) | 3.8-3.9 s | - | - | 31.7-32.6 m | 1.03-1.11 g | ~290 km/h |
| Vela GT | 3.92 s | 4.07 s | 12.77 s | 31.7 m | 1.04 g | 289 km/h |
(The Touring and GT-R variants below were removed from the game on 2026-11-08; the core test now checks the Kestrel GT
against the Vela GT instead. Their rows stay as the record of that calibration.)

| Vela GT Touring | 4.44 s | 4.64 s | 15.85 s | 33.3 m | 0.99 g | 298 km/h |
| Vela GT-R | 3.99 s | 4.13 s | 11.09 s | 29.8 m | 1.11 g | 279 km/h |
AI race after the change: 6/6 finish 2 laps, best laps 73.8-74.1 s (was 74.2-75.2 s).

## Still open (needs a human)
Numbers match; FEEL is not tested by numbers: steering weight/response at the limit, how the rear
lets go on throttle, how catchable slides are with and without assists, kerb behaviour.
