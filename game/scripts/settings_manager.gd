extends Node
## Autoload: persists display, assists, HUD, garage and last race setup to
## user://simulator_settings.json. Only settings something actually reads live here.

const SETTINGS_FILE := "user://simulator_settings.json"
const DEFAULTS := {
	"graphics": {
		"fullscreen": true,
		"render_scale": 0.75,
		"vsync": false,
		"max_fps": 0,
		"rival_headlights": 0,    # 0 = nearest 2 (measured budget), 1 = all, 2 = none
		"msaa": 1,                # 0 off, 1 = 2x, 2 = 4x (multisample anti-aliasing of 3D edges)
	},
	"assists": {
		"abs": true, "tc": true, "esc": true, "countersteer": false,
		"speed_sensitive_steering": true, "auto_gearbox": true, "auto_clutch": true,
	},
	"hud": {
		"speed_unit": "KM/H",
		"show_dash": true,
		"show_timing_tower": true,
		"show_damage_widget": true,
	},
	"garage": {
		"car": "vela_gt",
		"looks": {},              # car id -> Garage.LOOK_DEFAULT-shaped dict
		"tunes": {},              # car id -> Garage.TUNE_DEFAULT-shaped dict
	},
	"race": {"area": 0, "mode": 0, "laps": 3, "rivals": 5, "grid": 3, "difficulty": 1},
}

var settings: Dictionary = DEFAULTS.duplicate(true)

signal settings_changed


func _init() -> void:
	load_settings()


func load_settings() -> void:
	if not FileAccess.file_exists(SETTINGS_FILE):
		return
	var parsed = JSON.parse_string(FileAccess.get_file_as_string(SETTINGS_FILE))
	if parsed is Dictionary:
		_merge(settings, parsed)


func save_settings() -> void:
	var f := FileAccess.open(SETTINGS_FILE, FileAccess.WRITE)
	if f != null:
		f.store_string(JSON.stringify(settings, "  "))
	settings_changed.emit()


func reset_category(category: String) -> void:
	settings[category] = DEFAULTS[category].duplicate(true)


## Only keys that exist in DEFAULTS are taken from the file (old files may carry dead keys);
## dictionaries without defaults (garage looks/tunes) are taken whole.
func _merge(target: Dictionary, source: Dictionary) -> void:
	for k in source:
		if not target.has(k):
			continue
		if target[k] is Dictionary and source[k] is Dictionary:
			if target[k].is_empty():
				target[k] = source[k]
			else:
				_merge(target[k], source[k])
		else:
			target[k] = source[k]


func get_setting(category: String, key: String, default_value = null):
	if settings.has(category) and settings[category].has(key):
		return settings[category][key]
	return default_value


func set_setting(category: String, key: String, value) -> void:
	if not settings.has(category):
		settings[category] = {}
	settings[category][key] = value


func car_look(id: String) -> Dictionary:
	var l: Dictionary = Garage.LOOK_DEFAULT.duplicate()
	if id == "vela_gtr":
		l.paint = 2
	elif id == "vela_touring":
		l.paint = 8
	l.merge(settings.garage.looks.get(id, {}), true)
	return l


func car_tune(id: String) -> Dictionary:
	var t: Dictionary = Garage.TUNE_DEFAULT.duplicate()
	t.merge(settings.garage.tunes.get(id, {}), true)
	return t


func apply_all(vp: Viewport, car: RSVehicle = null) -> void:
	apply_graphics(vp)
	if car:
		apply_assists(car)


func apply_graphics(vp: Viewport) -> void:
	var g: Dictionary = settings.graphics
	var want_fs: bool = g.get("fullscreen", true)
	var is_fs := DisplayServer.window_get_mode() in [DisplayServer.WINDOW_MODE_FULLSCREEN, DisplayServer.WINDOW_MODE_EXCLUSIVE_FULLSCREEN]
	if want_fs != is_fs and DisplayServer.get_name() != "headless":
		DisplayServer.window_set_mode(DisplayServer.WINDOW_MODE_FULLSCREEN if want_fs else DisplayServer.WINDOW_MODE_WINDOWED)
	vp.scaling_3d_mode = Viewport.SCALING_3D_MODE_BILINEAR
	vp.scaling_3d_scale = clampf(float(g.get("render_scale", 0.75)), 0.5, 1.0)
	vp.msaa_3d = [Viewport.MSAA_DISABLED, Viewport.MSAA_2X, Viewport.MSAA_4X][clampi(int(g.get("msaa", 1)), 0, 2)]
	DisplayServer.window_set_vsync_mode(DisplayServer.VSYNC_ENABLED if g.get("vsync", false) else DisplayServer.VSYNC_DISABLED)
	Engine.max_fps = int(g.get("max_fps", 0))


func apply_assists(car: RSVehicle) -> void:
	if not car or not car.is_loaded():
		return
	var a: Dictionary = settings.assists
	for k in a:
		car.set_assist(k, bool(a[k]))
