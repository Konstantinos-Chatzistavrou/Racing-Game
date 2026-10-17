extends CanvasLayer
## In-Game Racing HUD styled after DashCam:
## - Bottom-Center: Solid black speed & gear box (e.g. "080 MPH" | "3 / Gear")
## - Bottom-Right: Monospace timing strip ("00:33:54  BEST // 00:48:35")
## - Bottom-Left: Red badge status meter ("ENG" integrity & assist badges)
## - Top-Left: Minimalist Standings & Relative intervals
## - Clean in-game UI without fake recording/camera overlays


var route: RSRoute
var race: RSRace
var cars: Array[RSVehicle] = []
var player: RSVehicle
var names: Array[String] = []
var cam: Camera3D
var player_index := 0

# Settings references
var speed_unit := "MPH"
var show_dash := true
var show_pedals := true
var show_timing_tower := true
var show_minimap := true
var show_damage_widget := true
var hud_visible := true

var _root: Control
var _cluster_panel: Control
var _timing_panel: Control
var _status_panel: Control
var _tower_panel: Control
var _banner_label: Label
var _banner_sub: Label
var _banner_container: Control

const CLUSTER_W := 240.0
const CLUSTER_H := 58.0


func _ready() -> void:
	layer = 5
	_load_settings()
	_build_ui()


func set_context(p_route: RSRoute, p_race: RSRace, p_cars: Array[RSVehicle], p_player: RSVehicle, p_names: Array[String], p_cam: Camera3D, p_pindex: int) -> void:
	route = p_route
	race = p_race
	cars = p_cars
	player = p_player
	names = p_names
	cam = p_cam
	player_index = p_pindex


func _load_settings() -> void:
	var sm = get_node_or_null("/root/SettingsManager")
	if sm:
		speed_unit = sm.get_setting("hud", "speed_unit", "MPH")
		show_dash = sm.get_setting("hud", "show_dash", true)
		show_pedals = sm.get_setting("hud", "show_pedals", true)
		show_timing_tower = sm.get_setting("hud", "show_timing_tower", true)
		show_damage_widget = sm.get_setting("hud", "show_damage_widget", true)


func _build_ui() -> void:
	_root = Control.new()
	_root.set_anchors_preset(Control.PRESET_FULL_RECT)
	_root.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(_root)

	# 1. DashCam Speed & Gear Box (Bottom Center)
	_build_speed_gear_cluster()

	# 2. Timing Strip (Bottom Right)
	_build_timing_strip()

	# 3. Vehicle Health & Assists Meter (Bottom Left)
	_build_status_meter()

	# 4. Standings & Relative (Top Left)
	_build_standings_box()

	# 5. Center Banner for Countdown / Finish
	_build_center_banner()


# ---------------------------------------------------------------- Bottom-Center Cluster
func _build_speed_gear_cluster() -> void:
	_cluster_panel = Control.new()
	_cluster_panel.custom_minimum_size = Vector2(CLUSTER_W, CLUSTER_H)
	_cluster_panel.set_anchors_preset(Control.PRESET_CENTER_BOTTOM)
	_cluster_panel.position = Vector2(-CLUSTER_W * 0.5, -CLUSTER_H - 18)
	_root.add_child(_cluster_panel)

	_cluster_panel.draw.connect(_draw_cluster)


func _draw_cluster() -> void:
	if not player or not show_dash:
		return
	var t: Dictionary = (cam.target as RSVehicle).get_telemetry() if cam and cam.target else player.get_telemetry()
	if t.is_empty():
		return

	# Solid jet black rectangular box with sharp/subtle edges
	var box_rect := Rect2(0, 0, CLUSTER_W, CLUSTER_H)
	_cluster_panel.draw_rect(box_rect, Color(0.0, 0.0, 0.0, 0.94))

	var font := UITheme.F_DISPLAY_SEMI

	# Left: Speed e.g. "080 MPH"
	var raw_speed: float = float(t.get("speed_kmh", 0.0))
	var display_speed := raw_speed if speed_unit == "KM/H" else raw_speed * 0.621371
	var speed_str := "%03d" % int(display_speed)

	_cluster_panel.draw_string(font, Vector2(16, 40), speed_str, HORIZONTAL_ALIGNMENT_LEFT, -1, 34, UITheme.WHITE)
	_cluster_panel.draw_string(font, Vector2(92, 38), speed_unit, HORIZONTAL_ALIGNMENT_LEFT, -1, 16, UITheme.WHITE)

	# Divider line
	_cluster_panel.draw_line(Vector2(160, 8), Vector2(160, CLUSTER_H - 8), Color(0.2, 0.2, 0.22), 1.0)

	# Right: Gear e.g. "3" and "Gear" below
	var gear_str: String = str(t.get("gear", "N"))
	var gear_col := UITheme.WHITE
	if gear_str == "R": gear_col = UITheme.RED
	elif gear_str == "N": gear_col = UITheme.MUTED

	_cluster_panel.draw_string(font, Vector2(178, 38), gear_str, HORIZONTAL_ALIGNMENT_CENTER, 48, 32, gear_col)
	_cluster_panel.draw_string(font, Vector2(178, 50), "Gear", HORIZONTAL_ALIGNMENT_CENTER, 48, 10, UITheme.MUTED)


# ---------------------------------------------------------------- Bottom-Right Timing
func _build_timing_strip() -> void:
	_timing_panel = Control.new()
	_timing_panel.custom_minimum_size = Vector2(360, 40)
	_timing_panel.set_anchors_preset(Control.PRESET_BOTTOM_RIGHT)
	_timing_panel.position = Vector2(-380, -48)
	_root.add_child(_timing_panel)

	_timing_panel.draw.connect(_draw_timing)


func _draw_timing() -> void:
	if not race or not player:
		return
	var p: Dictionary = race.get_progress(cars.find(player))
	if p.is_empty():
		return

	# Background pill
	var bg_rect := Rect2(0, 0, 360, 36)
	_timing_panel.draw_rect(bg_rect, Color(0.0, 0.0, 0.0, 0.90))

	var font := UITheme.F_DISPLAY_SEMI
	var time_str := _fmt_dashcam(p.get("finish_time", 0.0) if p.get("finished", false) else _last_race_time)
	var best_str := _fmt_dashcam(p.get("best_lap", 0.0))

	var text := "%s    BEST // %s" % [time_str, best_str]
	_timing_panel.draw_string(font, Vector2(16, 24), text, HORIZONTAL_ALIGNMENT_LEFT, -1, 15, UITheme.WHITE)


var _last_race_time := 0.0


# ---------------------------------------------------------------- Bottom-Left Status
func _build_status_meter() -> void:
	_status_panel = Control.new()
	_status_panel.custom_minimum_size = Vector2(280, 48)
	_status_panel.set_anchors_preset(Control.PRESET_BOTTOM_LEFT)
	_status_panel.position = Vector2(24, -56)
	_root.add_child(_status_panel)

	_status_panel.draw.connect(_draw_status)


func _draw_status() -> void:
	if not player or not show_damage_widget:
		return
	var t: Dictionary = (cam.target as RSVehicle).get_telemetry() if cam and cam.target else player.get_telemetry()
	if t.is_empty():
		return

	var font := UITheme.F_DISPLAY_SEMI

	# Red badge tag "ENG" (styled just like the "NOS" tag in DashCam)
	var tag_rect := Rect2(0, 4, 46, 26)
	_status_panel.draw_rect(tag_rect, UITheme.RED)
	_status_panel.draw_string(font, Vector2(6, 22), "ENG", HORIZONTAL_ALIGNMENT_CENTER, 34, 13, UITheme.WHITE)

	# Engine integrity / health meter bar
	var dmg: Dictionary = t.get("damage", {})
	var eng_health: float = 1.0 - float(dmg.get("engine", 0.0))
	var bar_w := 140.0
	var bar_rect := Rect2(52, 4, bar_w, 26)
	_status_panel.draw_rect(bar_rect, Color(0.08, 0.08, 0.09, 0.9))

	var fill_w := clampf(eng_health, 0.0, 1.0) * (bar_w - 4.0)
	var fill_col := UITheme.RED if eng_health < 0.4 else (UITheme.WHITE if eng_health > 0.8 else UITheme.MUTED)
	_status_panel.draw_rect(Rect2(54, 6, fill_w, 22), fill_col)

	# Assists summary badges on the right
	var any_abs := false
	for w in t.get("wheels", []):
		if w.get("abs", false):
			any_abs = true
			break
	var tc_cut: float = float(t.get("tc_cut", 0.0))

	var abs_col := UITheme.RED if any_abs else (UITheme.WHITE if player.get_assist("abs") else UITheme.SUBTLE)
	var tc_col := UITheme.RED if tc_cut > 0.05 else (UITheme.WHITE if player.get_assist("tc") else UITheme.SUBTLE)

	_status_panel.draw_string(font, Vector2(204, 22), "ABS", HORIZONTAL_ALIGNMENT_LEFT, -1, 11, abs_col)
	_status_panel.draw_string(font, Vector2(236, 22), "TC", HORIZONTAL_ALIGNMENT_LEFT, -1, 11, tc_col)


# ---------------------------------------------------------------- Top-Left Standings
func _build_standings_box() -> void:
	_tower_panel = Control.new()
	_tower_panel.custom_minimum_size = Vector2(220, 150)
	_tower_panel.set_anchors_preset(Control.PRESET_TOP_LEFT)
	_tower_panel.position = Vector2(20, 20)
	_root.add_child(_tower_panel)

	_tower_panel.draw.connect(_draw_standings)


func _draw_standings() -> void:
	if not show_timing_tower or not race or not player:
		return
	var p: Dictionary = race.get_progress(cars.find(player))
	if p.is_empty():
		return

	var box_rect := Rect2(0, 0, 220, 150)
	_tower_panel.draw_rect(box_rect, Color(0.0, 0.0, 0.0, 0.88))
	_tower_panel.draw_rect(Rect2(0, 0, 3, 150), UITheme.RED)

	var font := UITheme.F_DISPLAY_SEMI
	var lap_num := mini(p.get("lap", 0) + 1, p.get("laps", 3))
	var header_text := "POS P%d / %d   LAP %d/%d" % [p.get("position", 1), cars.size(), lap_num, p.get("laps", 3)]
	_tower_panel.draw_string(font, Vector2(12, 22), header_text, HORIZONTAL_ALIGNMENT_LEFT, -1, 12, UITheme.WHITE)
	_tower_panel.draw_line(Vector2(12, 28), Vector2(210, 28), Color(0.2, 0.2, 0.22))

	# Sort cars
	var order := range(cars.size())
	order.sort_custom(func(a, b): return race.get_progress(a).get("position", 99) < race.get_progress(b).get("position", 99))

	var y := 48.0
	for i in mini(5, order.size()):
		var c_idx: int = order[i]
		var prog: Dictionary = race.get_progress(c_idx)
		var is_p := cars[c_idx] == player
		var c_name: String = names[c_idx] if c_idx < names.size() else "AI"
		var dnf: bool = prog.get("dnf", false)
		var row_col := UITheme.RED if is_p else UITheme.WHITE

		_tower_panel.draw_string(font, Vector2(12, y), "P%d" % prog.get("position", i + 1), HORIZONTAL_ALIGNMENT_LEFT, -1, 11, UITheme.MUTED)
		_tower_panel.draw_string(font, Vector2(40, y), c_name, HORIZONTAL_ALIGNMENT_LEFT, -1, 11, row_col)

		var gap_str := "YOU" if is_p else ("DNF" if dnf else "")
		if gap_str == "":
			var p_dist: float = float(p.get("distance", 0.0))
			var c_dist: float = float(prog.get("distance", 0.0))
			var diff := (c_dist - p_dist) / 40.0
			gap_str = "%+.1fs" % diff

		var gap_col := UITheme.RED if (is_p or dnf) else UITheme.MUTED
		_tower_panel.draw_string(font, Vector2(150, y), gap_str, HORIZONTAL_ALIGNMENT_RIGHT, 60, 11, gap_col)
		y += 22.0


# ---------------------------------------------------------------- Center Banner
func _build_center_banner() -> void:
	var box := VBoxContainer.new()
	box.anchor_right = 1.0
	box.anchor_top = 0.28
	box.anchor_bottom = 0.28
	box.add_theme_constant_override("separation", -10)
	box.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_banner_container = box
	_root.add_child(_banner_container)

	_banner_label = Label.new()
	_banner_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_banner_label.add_theme_font_override("font", UITheme.F_DISPLAY)
	_banner_label.add_theme_font_size_override("font_size", 96)
	_banner_label.add_theme_color_override("font_color", UITheme.WHITE)
	_banner_label.add_theme_color_override("font_outline_color", Color.BLACK)
	_banner_label.add_theme_constant_override("outline_size", 8)
	_banner_container.add_child(_banner_label)

	_banner_sub = Label.new()
	_banner_sub.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_banner_sub.add_theme_font_override("font", UITheme.F_DISPLAY_SEMI)
	_banner_sub.add_theme_font_size_override("font_size", 24)
	_banner_sub.add_theme_color_override("font_color", UITheme.RED)
	_banner_sub.add_theme_color_override("font_outline_color", Color.BLACK)
	_banner_sub.add_theme_constant_override("outline_size", 6)
	_banner_container.add_child(_banner_sub)


# ---------------------------------------------------------------- Updates
func update_hud(dt: float, race_time: float, state: String, countdown: float, player_out: bool, spectate: int) -> void:
	if not hud_visible:
		_root.visible = false
		return
	_root.visible = true
	_last_race_time = race_time

	if show_dash: _cluster_panel.queue_redraw()
	_timing_panel.queue_redraw()
	if show_damage_widget: _status_panel.queue_redraw()
	if show_timing_tower: _tower_panel.queue_redraw()

	if state == "countdown":
		if countdown > 0.5:
			_banner_label.text = str(ceili(countdown))
			_banner_label.add_theme_color_override("font_color", UITheme.WHITE)
			_banner_sub.text = "READY"
		else:
			_banner_label.text = "GO"
			_banner_label.add_theme_color_override("font_color", UITheme.RED)
			_banner_sub.text = ""
		_banner_container.visible = true
	elif state == "racing":
		if race_time < 1.8:
			_banner_label.text = "GO"
			_banner_label.add_theme_color_override("font_color", UITheme.RED)
			_banner_sub.text = ""
			_banner_container.visible = true
		else:
			_banner_container.visible = false
	elif state == "finished":
		_banner_label.text = "FINISH"
		_banner_label.add_theme_color_override("font_color", UITheme.RED)
		_banner_sub.text = "RACE COMPLETE"
		_banner_container.visible = true

	if player_out:
		_banner_container.visible = true
		_banner_label.text = "CRASHED"
		_banner_label.add_theme_color_override("font_color", UITheme.RED)
		var sp_name := names[spectate] if spectate >= 0 and spectate < names.size() else "-"
		_banner_sub.text = "SPECTATING: %s  (< > to switch) | ESC for menu" % sp_name


func _fmt_dashcam(t: float) -> String:
	if t <= 0.0:
		return "00:00:00"
	var m := int(t / 60.0)
	var s := int(fmod(t, 60.0))
	var cs := int(fmod(t * 100.0, 100.0))
	return "%02d:%02d:%02d" % [m, s, cs]
