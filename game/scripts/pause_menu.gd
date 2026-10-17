extends CanvasLayer
## Pause menu (Esc): resume, restart, settings, main menu, quit, plus a live session card.

signal resume_requested
signal restart_requested
signal main_menu_requested
signal quit_requested

const SettingsPanel := preload("res://scripts/settings_menu.gd")

var player: RSVehicle
var race: RSRace
var cars: Array[RSVehicle] = []
var names: Array[String] = []
var player_index := 0

var _root: Control
var _menu: VBoxContainer
var _status: VBoxContainer
var _settings_wrap: PanelContainer
var _settings: Control
var _btn_resume: Button


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	layer = 25
	_build()
	visibility_changed.connect(func(): if visible: _close_settings())


func set_context(p_player: RSVehicle, p_race: RSRace, p_cars: Array[RSVehicle], p_names: Array[String], p_pindex: int) -> void:
	player = p_player
	race = p_race
	cars = p_cars
	names = p_names
	player_index = p_pindex
	_refresh_status()


func _build() -> void:
	_root = Control.new()
	_root.set_anchors_preset(Control.PRESET_FULL_RECT)
	_root.theme = UITheme.make_theme()
	add_child(_root)
	var bg := ColorRect.new()
	bg.set_anchors_preset(Control.PRESET_FULL_RECT)
	bg.color = Color(0.01, 0.012, 0.02, 0.78)
	_root.add_child(bg)

	var row := HBoxContainer.new()
	row.position = Vector2(120, 170)
	row.add_theme_constant_override("separation", 40)
	_root.add_child(row)

	_menu = VBoxContainer.new()
	_menu.custom_minimum_size = Vector2(420, 0)
	_menu.add_theme_constant_override("separation", 8)
	row.add_child(_menu)
	_menu.add_child(UITheme.heading("Session on hold", "Paused"))
	var gap := Control.new()
	gap.custom_minimum_size = Vector2(0, 16)
	_menu.add_child(gap)
	_btn_resume = _menu_btn("Resume", func(): resume_requested.emit(), true)
	_menu_btn("Restart race", func(): restart_requested.emit())
	_menu_btn("Settings", _open_settings)
	_menu_btn("Main menu", func(): main_menu_requested.emit())
	_menu_btn("Quit to desktop", func(): quit_requested.emit())

	var card := PanelContainer.new()
	card.custom_minimum_size = Vector2(520, 0)
	card.add_theme_stylebox_override("panel", UITheme.box(UITheme.BG, Color(1, 1, 1, 0.07), 10, 1, Vector2(32, 26)))
	row.add_child(card)
	_status = VBoxContainer.new()
	_status.add_theme_constant_override("separation", 12)
	card.add_child(_status)

	_settings_wrap = PanelContainer.new()
	_settings_wrap.add_theme_stylebox_override("panel", UITheme.box(UITheme.BG_SOLID, Color(1, 1, 1, 0.1), 10, 1, Vector2(40, 30)))
	_settings_wrap.position = Vector2(580, 130)
	_settings_wrap.size = Vector2(860, 820)
	_settings_wrap.visible = false
	_root.add_child(_settings_wrap)
	var sv := VBoxContainer.new()
	sv.add_theme_constant_override("separation", 16)
	_settings_wrap.add_child(sv)
	var top := HBoxContainer.new()
	var hd := UITheme.heading("Changes apply instantly", "Settings")
	hd.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	top.add_child(hd)
	var close := Button.new()
	close.text = "DONE"
	close.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	close.pressed.connect(_close_settings)
	top.add_child(close)
	sv.add_child(top)
	_settings = SettingsPanel.new()
	_settings.size_flags_vertical = Control.SIZE_EXPAND_FILL
	sv.add_child(_settings)


func _menu_btn(text: String, cb: Callable, primary := false) -> Button:
	var b := Button.new()
	b.text = text.to_upper()
	b.custom_minimum_size = Vector2(420, 60)
	if primary:
		UITheme.style_primary(b, 28)
		b.alignment = HORIZONTAL_ALIGNMENT_LEFT
	else:
		UITheme.style_nav(b, false)
		b.add_theme_font_size_override("font_size", 28)
	b.pressed.connect(cb)
	_menu.add_child(b)
	return b


func _refresh_status() -> void:
	for c in _status.get_children():
		c.queue_free()
	_status.add_child(UITheme.label("THIS RACE", 15, UITheme.RED, "semi"))
	if not player or not race:
		return
	var p: Dictionary = race.get_progress(cars.find(player))
	var dmg: Dictionary = player.get_telemetry().get("damage", {})
	var laps: int = p.get("laps", 3)
	var big := HBoxContainer.new()
	big.add_theme_constant_override("separation", 40)
	big.add_child(_big_stat("POSITION", "%d/%d" % [p.get("position", 1), cars.size()]))
	big.add_child(_big_stat("LAP", "%d/%d" % [mini(int(p.get("lap", 0)) + 1, laps), laps]))
	big.add_child(_big_stat("BEST LAP", _fmt(p.get("best_lap", 0.0))))
	_status.add_child(big)
	_status.add_child(HSeparator.new())
	var eng := 1.0 - float(dmg.get("engine", 0.0))
	var totaled: bool = dmg.get("totaled", false)
	var h := HBoxContainer.new()
	h.add_child(UITheme.label("ENGINE", 15, UITheme.MUTED, "semi"))
	var spacer := Control.new()
	spacer.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	h.add_child(spacer)
	var col := UITheme.RED if totaled or eng < 0.4 else (UITheme.AMBER if eng < 0.8 else UITheme.GREEN)
	h.add_child(UITheme.label("WRECKED" if totaled else "%d %%" % roundi(eng * 100.0), 22, col, "display"))
	_status.add_child(h)
	_status.add_child(UITheme.label("C  camera   ·   H  hide HUD   ·   F1  telemetry   ·   1-7  assists", 15, UITheme.MUTED))


func _big_stat(title: String, value: String) -> VBoxContainer:
	var v := VBoxContainer.new()
	v.add_theme_constant_override("separation", -6)
	v.add_child(UITheme.label(title, 14, UITheme.MUTED, "semi"))
	v.add_child(UITheme.label(value, 44, UITheme.WHITE, "display"))
	return v


func _open_settings() -> void:
	_settings.player_car = player
	_settings_wrap.visible = true
	_settings.first_focus().grab_focus()


func _close_settings() -> void:
	if _settings_wrap.visible:
		_settings_wrap.visible = false
	_btn_resume.grab_focus.call_deferred()


func settings_open() -> bool:
	return _settings_wrap.visible


func _fmt(t: float) -> String:
	return "--:--.-" if t <= 0.0 else "%d:%04.1f" % [int(t / 60.0), fmod(t, 60.0)]
