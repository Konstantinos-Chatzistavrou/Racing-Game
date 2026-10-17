extends VBoxContainer
## Settings panel used by the main menu and the pause menu. Every change is applied and saved
## immediately (no Apply button). Sub-pages: Display, Driving, HUD, Controls.

const Row := preload("res://scripts/ui_option_row.gd")
const SCALES := [0.5, 0.6, 0.75, 0.85, 1.0]
const FPS := [0, 30, 60, 75, 120, 144]
const ASSISTS := [
	["abs", "ABS", "Stops wheels locking under hard braking  (key 1)"],
	["tc", "Traction control", "Cuts power when the rears spin  (key 2)"],
	["esc", "Stability control", "Brakes single wheels to stop spins  (key 3)"],
	["countersteer", "Countersteer assist", "Helps catch slides  (key 4)"],
	["auto_gearbox", "Automatic gearbox", "OFF = shift yourself with E / Q  (key 5)"],
	["auto_clutch", "Auto clutch", "OFF = hold Shift for the clutch  (key 6)"],
	["speed_sensitive_steering", "Speed-sensitive steering", "Less lock at speed on keyboard  (key 7)"],
]
const KEYS := [
	["Throttle", "W  /  ↑", "RT"], ["Brake / reverse", "S  /  ↓", "LT"], ["Steer", "A D  /  ← →", "Left stick"],
	["Handbrake", "Space", "A"], ["Shift up / down", "E  /  Q", "RB / LB"], ["Clutch", "Shift", "-"],
	["Camera", "C", "-"], ["Pause", "Esc", "Start"], ["Hide HUD", "H", "-"],
	["Telemetry overlay", "F1", "-"], ["Assists", "1 - 7", "-"],
]

var sm: Node
var player_car: RSVehicle
var _tabs: HBoxContainer
var _pages: Array[Control] = []
var _tab_buttons: Array[Button] = []


func _ready() -> void:
	sm = get_node_or_null("/root/SettingsManager")
	add_theme_constant_override("separation", 18)
	_tabs = HBoxContainer.new()
	_tabs.add_theme_constant_override("separation", 6)
	add_child(_tabs)
	_add_page("Display", _display_page())
	_add_page("Driving", _driving_page())
	_add_page("HUD", _hud_page())
	_add_page("Controls", _controls_page())
	show_page(0)


func first_focus() -> Control:
	return _tab_buttons[0]


func _add_page(title: String, page: Control) -> void:
	var b := Button.new()
	b.text = title.to_upper()
	b.toggle_mode = true
	b.custom_minimum_size = Vector2(120, 0)
	var i := _pages.size()
	b.pressed.connect(func(): show_page(i))
	b.focus_entered.connect(func(): show_page(i))
	_tabs.add_child(b)
	_tab_buttons.append(b)
	var scroll := ScrollContainer.new()
	scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	page.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	scroll.add_child(page)
	add_child(scroll)
	_pages.append(scroll)


func show_page(i: int) -> void:
	for k in _pages.size():
		_pages[k].visible = k == i
		_tab_buttons[k].button_pressed = k == i
		_tab_buttons[k].add_theme_color_override("font_color", UITheme.WHITE if k == i else UITheme.MUTED)
		_tab_buttons[k].add_theme_stylebox_override("normal", UITheme.box(Color(UITheme.RED, 0.16) if k == i else UITheme.BG_RAISED,
			UITheme.RED if k == i else UITheme.LINE, 6, 1, Vector2(16, 9)))


func _page() -> VBoxContainer:
	var v := VBoxContainer.new()
	v.add_theme_constant_override("separation", 6)
	return v


func _section(v: VBoxContainer, title: String) -> void:
	var l := UITheme.label(title.to_upper(), 15, UITheme.RED, "semi")
	if v.get_child_count() > 0:
		var gap := Control.new()
		gap.custom_minimum_size = Vector2(0, 10)
		v.add_child(gap)
	v.add_child(l)


func _read(cat: String, key: String, def):
	return sm.get_setting(cat, key, def) if sm else def


func _set_and_save(cat: String, key: String, value) -> void:
	if not sm:
		return
	sm.set_setting(cat, key, value)
	sm.save_settings()
	if cat == "graphics":
		sm.apply_graphics(get_viewport())
	elif cat == "assists" and is_instance_valid(player_car) and player_car.is_loaded():
		player_car.set_assist(key, bool(value))


# ---------------------------------------------------------------- pages
func _display_page() -> Control:
	var v := _page()
	_section(v, "Screen")
	var fs := Row.make("Window mode", ["Windowed", "Fullscreen"], 1 if _read("graphics", "fullscreen", true) else 0)
	fs.changed.connect(func(i): _set_and_save("graphics", "fullscreen", i == 1))
	v.add_child(fs)
	var vs := Row.make("V-Sync", ["OFF", "ON"], 1 if _read("graphics", "vsync", false) else 0, "Removes tearing, adds a little input lag")
	vs.changed.connect(func(i): _set_and_save("graphics", "vsync", i == 1))
	v.add_child(vs)
	var fps_labels := ["Unlimited", "30", "60", "75", "120", "144"]
	var fr := Row.make("Frame-rate cap", fps_labels, maxi(FPS.find(int(_read("graphics", "max_fps", 0))), 0))
	fr.changed.connect(func(i): _set_and_save("graphics", "max_fps", FPS[i]))
	v.add_child(fr)

	_section(v, "Quality")
	var cur: float = _read("graphics", "render_scale", 0.75)
	var si := 2
	for k in SCALES.size():
		if is_equal_approx(SCALES[k], cur):
			si = k
	var sc := Row.make("3D resolution", ["50 %", "60 %", "75 %", "85 %", "100 %"], si, "75 % holds 60 fps on this laptop (measured)")
	sc.changed.connect(func(i): _set_and_save("graphics", "render_scale", SCALES[i]))
	v.add_child(sc)
	var aa := Row.make("Anti-aliasing", ["Off", "MSAA 2x", "MSAA 4x"], int(_read("graphics", "msaa", 1)), "Smooths jagged edges; costs GPU time")
	aa.changed.connect(func(i): _set_and_save("graphics", "msaa", i))
	v.add_child(aa)
	var hl := Row.make("Rival headlights", ["Nearest 2", "All", "Off"], int(_read("graphics", "rival_headlights", 0)), "Each real spotlight costs ~0.5 ms GPU")
	hl.changed.connect(func(i): _set_and_save("graphics", "rival_headlights", i))
	v.add_child(hl)
	return v


func _driving_page() -> Control:
	var v := _page()
	_section(v, "Assists")
	for a in ASSISTS:
		var key: String = a[0]
		var r := Row.make(a[1], ["OFF", "ON"], 1 if _read("assists", key, true) else 0, a[2])
		r.changed.connect(func(i): _set_and_save("assists", key, i == 1))
		v.add_child(r)
	return v


func _hud_page() -> Control:
	var v := _page()
	_section(v, "Heads-up display")
	var u := Row.make("Speed unit", ["KM/H", "MPH"], 0 if _read("hud", "speed_unit", "KM/H") == "KM/H" else 1)
	u.changed.connect(func(i): _set_and_save("hud", "speed_unit", "KM/H" if i == 0 else "MPH"))
	v.add_child(u)
	for h in [["show_dash", "Speed & gear box"], ["show_timing_tower", "Standings"], ["show_damage_widget", "Engine health & assists"]]:
		var key: String = h[0]
		var r := Row.make(h[1], ["OFF", "ON"], 1 if _read("hud", key, true) else 0)
		r.changed.connect(func(i): _set_and_save("hud", key, i == 1))
		v.add_child(r)
	v.add_child(UITheme.label("HUD changes show from the next race.", 14, UITheme.MUTED))
	return v


func _controls_page() -> Control:
	var v := _page()
	_section(v, "Controls")
	var g := GridContainer.new()
	g.columns = 3
	g.add_theme_constant_override("h_separation", 28)
	g.add_theme_constant_override("v_separation", 10)
	for hdr in ["ACTION", "KEYBOARD", "GAMEPAD"]:
		g.add_child(UITheme.label(hdr, 14, UITheme.MUTED, "semi"))
	for k in KEYS:
		var name_l := UITheme.label(k[0], 18, UITheme.WHITE, "bold")
		name_l.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		g.add_child(name_l)
		g.add_child(_keycap(k[1]))
		g.add_child(_keycap(k[2]))
	v.add_child(g)
	v.add_child(UITheme.label("The game switches to whichever device you touched last.", 14, UITheme.MUTED))
	return v


func _keycap(t: String) -> Control:
	var p := PanelContainer.new()
	p.add_theme_stylebox_override("panel", UITheme.box(Color(1, 1, 1, 0.06), Color(1, 1, 1, 0.14), 5, 1, Vector2(10, 3)))
	p.size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
	p.add_child(UITheme.label(t, 16, UITheme.WHITE, "semi"))
	return p
