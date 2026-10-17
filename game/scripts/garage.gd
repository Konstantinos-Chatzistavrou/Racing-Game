class_name Garage
## Car roster, cosmetic options and setup tuning for the player car.
## Cosmetics (material overrides) live here: they are rendering, so they are engine-specific.
## Tuning maths, the spec sheet and the tune step tables live in the C++ core (rs/setup.hpp, via
## RSSetup) so an Unreal front end gets them unchanged. This file keeps only names, labels, hints.

const CARS := [
	{"id": "vela_touring", "visual": "cars/vela_touring.visual.json", "class": "ROAD",
		"blurb": "Softer springs and road tyres. Forgiving, easy to catch when it slides."},
	{"id": "vela_gt", "visual": "cars/vela_gt.visual.json", "class": "GT",
		"blurb": "The baseline V8 coupe. Balanced, rear-wheel drive, rewards smooth throttle."},
	{"id": "vela_gtr", "visual": "cars/vela_gtr.visual.json", "class": "TRACK",
		"blurb": "Lighter, more power, semi-slicks and stiff springs. Fast and twitchy."},
]

const PAINTS := [
	["Rosso", Color(0.55, 0.03, 0.02)], ["Neon Pink", Color(0.8, 0.04, 0.32)],
	["Sunset", Color(0.85, 0.45, 0.02)], ["Acid", Color(0.55, 0.75, 0.04)],
	["Racing Green", Color(0.03, 0.22, 0.1)], ["Teal", Color(0.02, 0.4, 0.42)],
	["Deep Blue", Color(0.02, 0.1, 0.35)], ["Violet", Color(0.25, 0.06, 0.45)],
	["Silver", Color(0.75, 0.75, 0.78)], ["Gunmetal", Color(0.2, 0.21, 0.23)],
	["Pearl White", Color(0.9, 0.9, 0.88)], ["Midnight", Color(0.02, 0.02, 0.022)],
]
# [name, metallic, roughness, clearcoat, clearcoat_roughness]
const FINISHES := [
	["Gloss", 0.55, 0.32, 1.0, 0.04], ["Pearl", 0.85, 0.2, 1.0, 0.02],
	["Satin", 0.35, 0.5, 0.4, 0.3], ["Matte", 0.0, 0.78, 0.0, 0.0],
]
const RIMS := [
	["Silver", Color(0.78, 0.78, 0.8)], ["Gunmetal", Color(0.22, 0.23, 0.25)], ["Black", Color(0.03, 0.03, 0.03)],
	["Bronze", Color(0.55, 0.38, 0.18)], ["Gold", Color(0.85, 0.65, 0.2)], ["White", Color(0.92, 0.92, 0.92)],
]
const CALIPERS := [
	["Black", Color(0.04, 0.04, 0.04)], ["Red", Color(0.75, 0.04, 0.04)], ["Yellow", Color(0.95, 0.75, 0.05)],
	["Blue", Color(0.05, 0.2, 0.7)], ["Lime", Color(0.5, 0.85, 0.1)],
]
const TINTS := [["Light", 0.55], ["Medium", 0.78], ["Limo", 0.93]]

# Garage UI text for each tune setting. The step VALUES are in the core (RSSetup.tune_steps).
const TUNE := {
	"brake_bias": {"name": "Brake bias",
		"hint": "More front = stable braking, more rear = rotates on entry"},
	"gearing": {"name": "Gearing", "labels": ["Short", "Stock", "Long"],
		"hint": "Short = harder pull in each gear (more shifts), long = higher top speed"},
	"suspension": {"name": "Suspension", "labels": ["Soft", "Stock", "Stiff"],
		"hint": "Springs + dampers. Soft rides kerbs, stiff responds faster"},
	"arb": {"name": "Anti-roll balance", "labels": ["Front", "Stock", "Rear"],
		"hint": "Stiffer front = understeer, stiffer rear = oversteer"},
	"diff": {"name": "Differential", "labels": ["Loose", "Stock", "Locked"],
		"hint": "Locked = traction on exit but pushes wide; loose = turns in easier"},
}
const TUNE_DEFAULT := {"brake_bias": 2, "gearing": 1, "suspension": 1, "arb": 1, "diff": 1}
const LOOK_DEFAULT := {"paint": 0, "finish": 0, "rims": 1, "calipers": 1, "tint": 1}


static func car_index(id: String) -> int:
	for i in CARS.size():
		if CARS[i].id == id:
			return i
	return 1


## Physics JSON of a car, as a path the core resolves (relative to the project folder).
static func physics_path(id: String) -> String:
	return CarFactory.DATA_DIR + CarFactory.load_visual(CARS[car_index(id)].visual).physics


## Spec sheet from the core: {name, layout, kw, hp, rpm, nm, kg, w_per_kg, grip, downforce, brake_bias}
static func stats(id: String) -> Dictionary:
	return RSSetup.car_stats(physics_path(id))


## Brake bias options as "% front" labels for this car.
static func bias_labels(id: String) -> Array:
	var base: float = stats(id).get("brake_bias", 0.65)
	return RSSetup.tune_steps("brake_bias").map(func(s): return "%d %% front" % roundi((base + s) * 100.0))


## The core writes the tuned physics JSON; returns its absolute path (RSVehicle accepts it).
static func tuned_config(id: String, tune: Dictionary) -> String:
	var out := ProjectSettings.globalize_path("user://tuned_%s.json" % id)
	var t := TUNE_DEFAULT.duplicate()
	t.merge(tune, true)
	if not RSSetup.tune_car(physics_path(id), out, t):
		return ProjectSettings.globalize_path("res://").path_join(physics_path(id))   # stock on failure
	return out


static func paint_color(look: Dictionary) -> Color:
	return PAINTS[clampi(int(look.get("paint", 0)), 0, PAINTS.size() - 1)][1]


## Material overrides on every model under `n` (full model and LOD). Always starts from the
## imported material, so it can be re-applied any number of times.
static func apply_look(n: Node, look: Dictionary) -> void:
	var l := LOOK_DEFAULT.duplicate()
	l.merge(look, true)
	if n is MeshInstance3D:
		var mi := n as MeshInstance3D
		for i in mi.mesh.get_surface_count():
			var base := mi.mesh.surface_get_material(i) as StandardMaterial3D
			if base == null:
				continue
			var m: StandardMaterial3D
			match base.resource_name:
				"paint":
					var f: Array = FINISHES[int(l.finish) % FINISHES.size()]
					m = base.duplicate() as StandardMaterial3D
					m.albedo_color = PAINTS[int(l.paint) % PAINTS.size()][1]
					m.metallic = f[1]
					m.roughness = f[2]
					m.clearcoat_enabled = f[3] > 0.0
					m.clearcoat = f[3]
					m.clearcoat_roughness = f[4]
				"rim_alloy":
					m = base.duplicate() as StandardMaterial3D
					m.albedo_color = RIMS[int(l.rims) % RIMS.size()][1]
				"brake_caliper":
					m = base.duplicate() as StandardMaterial3D
					m.albedo_color = CALIPERS[int(l.calipers) % CALIPERS.size()][1]
				"glass":
					m = base.duplicate() as StandardMaterial3D
					m.albedo_color.a = TINTS[int(l.tint) % TINTS.size()][1]
			if m:
				mi.set_surface_override_material(i, m)
	for c in n.get_children():
		apply_look(c, look)
