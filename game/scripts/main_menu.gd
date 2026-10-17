extends CanvasLayer
## Front end, drawn over the live 3D city (the player car orbits on the right half of the screen).
## Pages: RACE (area, event, options), GARAGE (car, paint, wheels, tuning), SETTINGS, QUIT.
## Everything the player picks is saved in SettingsManager; race.gd reads it on START.

signal start_race_requested(cfg: Dictionary)
signal quit_requested
signal car_changed(id: String)
signal look_changed(id: String)
signal page_changed(page: String)

const Row := preload("res://scripts/ui_option_row.gd")
const SettingsPanel := preload("res://scripts/settings_menu.gd")

const AREAS := [
	{"name": "Old Harbour District", "info": "1.2 km loop  ·  alleys, 7 m streets, boulevard", "locked": false},
	{"name": "Industrial Docks", "info": "Not built yet", "locked": true},
	{"name": "Hillside Switchbacks", "info": "Not built yet", "locked": true},
]
const MODES := [
	{"name": "Street Race", "info": "You vs rivals, first across the line"},
	{"name": "Time Attack", "info": "Empty streets, chase your best lap"},
	{"name": "Pack Race", "info": "Full 8-car grid, start from the back"},
]
const DIFFICULTY := ["Easy", "Normal", "Hard"]

var sm: Node
var _root: Control
var _nav: Array[Button] = []
var _pages := {}
var _page := "race"
var _content: PanelContainer
var _plate: Control

# race page
var _area_cards: Array[Button] = []
var _mode_cards: Array[Button] = []
var _rivals_row: PanelContainer
var _grid_row: PanelContainer
var _summary: Label
var _start_btn: Button
# garage page
var _car_name: Label
var _car_class: Label
var _car_blurb: Label
var _stat_box: VBoxContainer
var _garage_tabs: Array[Button] = []
var _garage_pages: Array[Control] = []
var _swatches: Array[Button] = []
var _look_rows := {}
var _tune_rows := {}
var _plate_name: Label
var _plate_stats: Label


func _ready() -> void:
	layer = 15
	sm = get_node_or_null("/root/SettingsManager")
	_build()
	show_page("race")


func _race_cfg() -> Dictionary:
	return sm.settings.race if sm else {"area": 0, "mode": 0, "laps": 3, "rivals": 5, "grid": 3, "difficulty": 1}


func _car_id() -> String:
	return sm.settings.garage.car if sm else "vela_gt"


func _save() -> void:
	if sm:
		sm.save_settings()


# ================================================================ layout
func _build() -> void:
	_root = Control.new()
	_root.set_anchors_preset(Control.PRESET_FULL_RECT)
	_root.theme = UITheme.make_theme()
	add_child(_root)

	# Shade the left side so text reads well; the car stays clear on the right.
	var g := Gradient.new()
	g.set_color(0, Color(0.01, 0.012, 0.02, 0.93))
	g.add_point(0.55, Color(0.01, 0.012, 0.02, 0.75))
	g.set_color(g.get_point_count() - 1, Color(0.01, 0.012, 0.02, 0.0))
	var gt := GradientTexture2D.new()
	gt.gradient = g
	gt.width = 256
	gt.height = 4
	var shade := TextureRect.new()
	shade.texture = gt
	shade.stretch_mode = TextureRect.STRETCH_SCALE
	shade.anchor_bottom = 1.0
	shade.offset_right = 1380
	shade.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_root.add_child(shade)

	var bottom_g := Gradient.new()
	bottom_g.set_color(0, Color(0, 0, 0, 0))
	bottom_g.set_color(1, Color(0, 0, 0, 0.7))
	var bgt := GradientTexture2D.new()
	bgt.gradient = bottom_g
	bgt.fill_from = Vector2(0, 0)
	bgt.fill_to = Vector2(0, 1)
	var bshade := TextureRect.new()
	bshade.texture = bgt
	bshade.stretch_mode = TextureRect.STRETCH_SCALE
	bshade.anchor_top = 1.0
	bshade.anchor_right = 1.0
	bshade.anchor_bottom = 1.0
	bshade.offset_top = -260
	bshade.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_root.add_child(bshade)

	_build_brand()
	_build_nav()
	_build_footer()
	_build_plate()

	_content = PanelContainer.new()
	_content.add_theme_stylebox_override("panel", UITheme.box(UITheme.BG, Color(1, 1, 1, 0.07), 10, 1, Vector2(40, 30)))
	_content.position = Vector2(400, 200)
	_content.size = Vector2(860, 790)
	_root.add_child(_content)

	_pages.race = _race_page()
	_pages.garage = _garage_page()
	var st := VBoxContainer.new()
	st.add_theme_constant_override("separation", 18)
	st.add_child(UITheme.heading("Make it yours", "Settings"))
	var panel = SettingsPanel.new()
	panel.size_flags_vertical = Control.SIZE_EXPAND_FILL
	st.add_child(panel)
	st.set_meta("panel", panel)
	_pages.settings = st
	for k in _pages:
		_content.add_child(_pages[k])


func _build_brand() -> void:
	var v := VBoxContainer.new()
	v.position = Vector2(64, 46)
	v.add_theme_constant_override("separation", -8)
	var h := HBoxContainer.new()
	h.add_theme_constant_override("separation", 12)
	h.add_child(UITheme.label("NIGHT", 72, UITheme.WHITE, "display"))
	h.add_child(UITheme.label("STREET", 72, UITheme.RED, "display"))
	v.add_child(h)
	var sub := UITheme.label("O L D   H A R B O U R   ·   S T R E E T   R A C I N G", 16, UITheme.MUTED, "semi")
	v.add_child(sub)
	_root.add_child(v)


func _build_nav() -> void:
	var v := VBoxContainer.new()
	v.position = Vector2(40, 214)
	v.custom_minimum_size = Vector2(330, 0)
	v.add_theme_constant_override("separation", 6)
	_root.add_child(v)
	for p in [["race", "Race"], ["garage", "Garage"], ["settings", "Settings"], ["quit", "Quit"]]:
		var b := Button.new()
		b.text = p[1].to_upper()
		b.custom_minimum_size = Vector2(330, 62)
		var id: String = p[0]
		b.pressed.connect(func(): _on_nav(id))
		b.focus_entered.connect(func(): if id != "quit": show_page(id))
		b.set_meta("id", id)
		v.add_child(b)
		_nav.append(b)
	var hint := UITheme.label("v0.5 prototype", 14, UITheme.SUBTLE)
	v.add_child(Control.new())
	v.add_child(hint)


func _build_footer() -> void:
	var h := HBoxContainer.new()
	h.anchor_top = 1.0
	h.anchor_bottom = 1.0
	h.position = Vector2(64, -58)
	h.add_theme_constant_override("separation", 26)
	for k in [["↑ ↓", "Navigate"], ["← →", "Change"], ["Enter", "Select"], ["Esc", "Back"]]:
		var p := HBoxContainer.new()
		p.add_theme_constant_override("separation", 8)
		var cap := PanelContainer.new()
		cap.add_theme_stylebox_override("panel", UITheme.box(Color(1, 1, 1, 0.08), Color(1, 1, 1, 0.18), 4, 1, Vector2(8, 1)))
		cap.add_child(UITheme.label(k[0], 15, UITheme.WHITE, "semi"))
		p.add_child(cap)
		p.add_child(UITheme.label(k[1], 15, UITheme.MUTED))
		h.add_child(p)
	_root.add_child(h)


## Name plate bottom-right, under the orbiting car.
func _build_plate() -> void:
	var v := VBoxContainer.new()
	v.anchor_left = 1.0
	v.anchor_right = 1.0
	v.anchor_top = 1.0
	v.anchor_bottom = 1.0
	v.offset_left = -620
	v.offset_right = -64
	v.offset_top = -190
	v.offset_bottom = -60
	v.alignment = BoxContainer.ALIGNMENT_END
	v.add_theme_constant_override("separation", -6)
	v.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_plate_name = UITheme.label("", 64, UITheme.WHITE, "display")
	_plate_name.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	_plate_stats = UITheme.label("", 20, UITheme.MUTED, "semi")
	_plate_stats.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	v.add_child(_plate_name)
	v.add_child(_plate_stats)
	_root.add_child(v)
	_plate = v
	_refresh_plate()


func _refresh_plate() -> void:
	var s := Garage.stats(_car_id())
	_plate_name.text = str(s.name).to_upper()
	_plate_stats.text = "%d HP   ·   %d NM   ·   %d KG   ·   %s" % [s.hp, s.nm, s.kg, s.layout]


func show_page(id: String) -> void:
	_page = id
	for k in _pages:
		_pages[k].visible = k == id
	for b in _nav:
		UITheme.style_nav(b, b.get_meta("id") == id)
	_plate.visible = id != "settings"
	page_changed.emit(id)


func _on_nav(id: String) -> void:
	if id == "quit":
		quit_requested.emit()
		return
	show_page(id)
	match id:
		"race": _start_btn.grab_focus.call_deferred() if _area_cards.is_empty() else _area_cards[0].grab_focus.call_deferred()
		"garage": _garage_tabs[0].grab_focus.call_deferred()
		"settings": _pages.settings.get_meta("panel").first_focus().grab_focus.call_deferred()


func focus_nav() -> void:
	for b in _nav:
		if b.get_meta("id") == _page:
			b.grab_focus()
			return
	_nav[0].grab_focus()


# ================================================================ RACE page
func _race_page() -> Control:
	var cfg := _race_cfg()
	var v := VBoxContainer.new()
	v.add_theme_constant_override("separation", 14)
	v.add_child(UITheme.heading("Pick your streets", "Race"))

	v.add_child(UITheme.label("AREA", 15, UITheme.MUTED, "semi"))
	var areas := HBoxContainer.new()
	areas.add_theme_constant_override("separation", 12)
	v.add_child(areas)
	for i in AREAS.size():
		var a: Dictionary = AREAS[i]
		var c := _card(a.name, a.info, Vector2(0, 112), "LOCKED" if a.locked else "")
		c.disabled = a.locked
		c.focus_mode = Control.FOCUS_NONE if a.locked else Control.FOCUS_ALL
		c.pressed.connect(func(): _pick_area(i))
		areas.add_child(c)
		_area_cards.append(c)

	v.add_child(UITheme.label("EVENT", 15, UITheme.MUTED, "semi"))
	var modes := HBoxContainer.new()
	modes.add_theme_constant_override("separation", 12)
	v.add_child(modes)
	for i in MODES.size():
		var c := _card(MODES[i].name, MODES[i].info, Vector2(0, 96))
		c.pressed.connect(func(): _pick_mode(i))
		modes.add_child(c)
		_mode_cards.append(c)

	var opts := VBoxContainer.new()
	opts.add_theme_constant_override("separation", 4)
	v.add_child(opts)
	var laps_opts := [1, 2, 3, 5, 10]
	var laps_row := Row.make("Laps", ["1", "2", "3", "5", "10"], maxi(laps_opts.find(int(cfg.laps)), 0))
	laps_row.changed.connect(func(i): _set_race("laps", laps_opts[i]))
	opts.add_child(laps_row)
	_rivals_row = Row.make("Rivals", ["1", "2", "3", "4", "5", "6", "7"], clampi(int(cfg.rivals) - 1, 0, 6))
	_rivals_row.changed.connect(func(i): _set_race("rivals", i + 1))
	opts.add_child(_rivals_row)
	_grid_row = Row.make("Start position", ["Front", "Middle", "Back"], [0, 3, 7].find(int(cfg.grid)) if int(cfg.grid) in [0, 3, 7] else 1)
	_grid_row.changed.connect(func(i): _set_race("grid", [0, 3, 7][i]))
	opts.add_child(_grid_row)
	var diff_row := Row.make("Rival skill", DIFFICULTY, int(cfg.difficulty), "Easy rivals brake earlier and react slower")
	diff_row.changed.connect(func(i): _set_race("difficulty", i))
	opts.add_child(diff_row)

	var spacer := Control.new()
	spacer.size_flags_vertical = Control.SIZE_EXPAND_FILL
	v.add_child(spacer)
	var bottom := HBoxContainer.new()
	bottom.add_theme_constant_override("separation", 20)
	_summary = UITheme.label("", 17, UITheme.MUTED)
	_summary.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_summary.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	bottom.add_child(_summary)
	_start_btn = Button.new()
	_start_btn.text = "START RACE  ›"
	_start_btn.custom_minimum_size = Vector2(300, 70)
	UITheme.style_primary(_start_btn, 30)
	_start_btn.pressed.connect(_on_start)
	bottom.add_child(_start_btn)
	v.add_child(bottom)
	_refresh_race()
	return v


func _card(title: String, info: String, min_size: Vector2, tag := "") -> Button:
	var b := Button.new()
	b.custom_minimum_size = min_size
	b.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	var m := VBoxContainer.new()
	m.set_anchors_preset(Control.PRESET_FULL_RECT)
	m.offset_left = 18
	m.offset_right = -14
	m.offset_top = 12
	m.offset_bottom = -10
	m.add_theme_constant_override("separation", 0)
	m.mouse_filter = Control.MOUSE_FILTER_IGNORE
	if tag != "":
		var t := UITheme.label(tag, 13, UITheme.AMBER, "semi")
		t.mouse_filter = Control.MOUSE_FILTER_IGNORE
		m.add_child(t)
	var tl := UITheme.label(title.to_upper(), 26, UITheme.WHITE, "display")
	tl.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	tl.mouse_filter = Control.MOUSE_FILTER_IGNORE
	m.add_child(tl)
	var il := UITheme.label(info, 15, UITheme.MUTED)
	il.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	il.mouse_filter = Control.MOUSE_FILTER_IGNORE
	m.add_child(il)
	b.add_child(m)
	return b


func _pick_area(i: int) -> void:
	if AREAS[i].locked:
		return
	_set_race("area", i)


func _pick_mode(i: int) -> void:
	_set_race("mode", i)


func _set_race(key: String, value) -> void:
	_race_cfg()[key] = value
	_save()
	_refresh_race()


func _refresh_race() -> void:
	var cfg := _race_cfg()
	for i in _area_cards.size():
		UITheme.style_card(_area_cards[i], i == int(cfg.area), AREAS[i].locked)
	for i in _mode_cards.size():
		UITheme.style_card(_mode_cards[i], i == int(cfg.mode))
	var mode := int(cfg.mode)
	_rivals_row.visible = mode == 0
	_grid_row.visible = mode == 0
	var sum := ""
	match mode:
		0: sum = "%s vs %d rival%s  ·  %s start" % [_laps_text(cfg.laps), cfg.rivals, "" if int(cfg.rivals) == 1 else "s", ["front", "middle", "back"][[0, 3, 7].find(int(cfg.grid))] if int(cfg.grid) in [0, 3, 7] else "middle"]
		1: sum = "%s alone  ·  best lap counts" % _laps_text(cfg.laps)
		2: sum = "%s vs 7 rivals  ·  from the back" % _laps_text(cfg.laps)
	var a := []
	if sm:
		for k in ["abs", "tc", "esc"]:
			if sm.get_setting("assists", k, true):
				a.append(k.to_upper())
	_summary.text = sum + "\nCar: %s  ·  Assists: %s" % [Garage.stats(_car_id()).name, ", ".join(a) if a.size() > 0 else "none"]


func _laps_text(n) -> String:
	return "1 lap" if int(n) == 1 else "%d laps" % n


func _on_start() -> void:
	var cfg := _race_cfg()
	var e: Dictionary = RSSetup.make_event(int(cfg.mode), int(cfg.laps), int(cfg.rivals), int(cfg.grid))
	e.difficulty = int(cfg.difficulty)
	e.mode = int(cfg.mode)
	start_race_requested.emit(e)


# ================================================================ GARAGE page
func _garage_page() -> Control:
	var v := VBoxContainer.new()
	v.add_theme_constant_override("separation", 14)
	v.add_child(UITheme.heading("Your ride", "Garage"))

	# car selector
	var sel := PanelContainer.new()
	sel.add_theme_stylebox_override("panel", UITheme.accent_box())
	var sh := HBoxContainer.new()
	sh.add_theme_constant_override("separation", 10)
	sel.add_child(sh)
	sh.add_child(_big_arrow("‹", -1))
	var mid := VBoxContainer.new()
	mid.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	mid.add_theme_constant_override("separation", -2)
	var nh := HBoxContainer.new()
	nh.add_theme_constant_override("separation", 14)
	_car_name = UITheme.label("", 40, UITheme.WHITE, "display")
	_car_class = UITheme.label("", 15, UITheme.RED, "semi")
	_car_class.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	nh.add_child(_car_name)
	nh.add_child(_car_class)
	mid.add_child(nh)
	_car_blurb = UITheme.label("", 16, UITheme.MUTED)
	_car_blurb.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	mid.add_child(_car_blurb)
	sh.add_child(mid)
	sh.add_child(_big_arrow("›", 1))
	v.add_child(sel)

	_stat_box = VBoxContainer.new()
	_stat_box.add_theme_constant_override("separation", 6)
	v.add_child(_stat_box)

	var tabs := HBoxContainer.new()
	tabs.add_theme_constant_override("separation", 6)
	v.add_child(tabs)
	var pages := [["Paint", _paint_page()], ["Wheels & glass", _wheels_page()], ["Tuning", _tuning_page()]]
	for i in pages.size():
		var b := Button.new()
		b.text = pages[i][0].to_upper()
		b.custom_minimum_size = Vector2(150, 0)
		b.pressed.connect(func(): _show_garage_tab(i))
		b.focus_entered.connect(func(): _show_garage_tab(i))
		tabs.add_child(b)
		_garage_tabs.append(b)
		var scroll := ScrollContainer.new()
		scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
		scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
		pages[i][1].size_flags_horizontal = Control.SIZE_EXPAND_FILL
		scroll.add_child(pages[i][1])
		v.add_child(scroll)
		_garage_pages.append(scroll)
	_show_garage_tab(0)
	_refresh_garage()
	return v


func _big_arrow(t: String, dir: int) -> Button:
	var b := Button.new()
	b.text = t
	b.custom_minimum_size = Vector2(56, 56)
	b.add_theme_font_override("font", UITheme.F_DISPLAY)
	b.add_theme_font_size_override("font_size", 40)
	b.pressed.connect(func(): _cycle_car(dir))
	return b


func _show_garage_tab(i: int) -> void:
	for k in _garage_pages.size():
		_garage_pages[k].visible = k == i
		var on := k == i
		_garage_tabs[k].add_theme_color_override("font_color", UITheme.WHITE if on else UITheme.MUTED)
		_garage_tabs[k].add_theme_stylebox_override("normal", UITheme.box(Color(UITheme.RED, 0.16) if on else UITheme.BG_RAISED,
			UITheme.RED if on else UITheme.LINE, 6, 1, Vector2(16, 9)))


func _cycle_car(dir: int) -> void:
	var i := (Garage.car_index(_car_id()) + dir + Garage.CARS.size()) % Garage.CARS.size()
	if sm:
		sm.settings.garage.car = Garage.CARS[i].id
		_save()
	_refresh_garage()
	_refresh_plate()
	_refresh_race()
	car_changed.emit(_car_id())


func _paint_page() -> Control:
	var v := VBoxContainer.new()
	v.add_theme_constant_override("separation", 10)
	var grid := GridContainer.new()
	grid.columns = 6
	grid.add_theme_constant_override("h_separation", 10)
	grid.add_theme_constant_override("v_separation", 10)
	for i in Garage.PAINTS.size():
		var b := Button.new()
		b.custom_minimum_size = Vector2(108, 54)
		b.tooltip_text = Garage.PAINTS[i][0]
		b.pressed.connect(func(): _set_look("paint", i))
		grid.add_child(b)
		_swatches.append(b)
	v.add_child(grid)
	var fin := Row.make("Finish", Garage.FINISHES.map(func(f): return f[0]), 0, "Gloss / pearl have a clear coat; matte has none")
	fin.changed.connect(func(i): _set_look("finish", i))
	v.add_child(fin)
	_look_rows.finish = fin
	return v


func _wheels_page() -> Control:
	var v := VBoxContainer.new()
	v.add_theme_constant_override("separation", 4)
	for spec in [["rims", "Rims", Garage.RIMS], ["calipers", "Brake calipers", Garage.CALIPERS], ["tint", "Window tint", Garage.TINTS]]:
		var key: String = spec[0]
		var r := Row.make(spec[1], spec[2].map(func(x): return x[0]), 0)
		r.changed.connect(func(i): _set_look(key, i))
		v.add_child(r)
		_look_rows[key] = r
	return v


func _tuning_page() -> Control:
	var v := VBoxContainer.new()
	v.add_theme_constant_override("separation", 4)
	for key in Garage.TUNE:
		var t: Dictionary = Garage.TUNE[key]
		var r := Row.make(t.name, t.get("labels", ["-"]), 0, t.hint)   # brake bias labels: _bias_labels()
		var k: String = key
		r.changed.connect(func(i): _set_tune(k, i))
		v.add_child(r)
		_tune_rows[key] = r
	var reset := Button.new()
	reset.text = "RESET TUNE TO STOCK"
	reset.size_flags_horizontal = Control.SIZE_SHRINK_END
	reset.pressed.connect(func():
		if sm:
			sm.settings.garage.tunes.erase(_car_id())
			_save()
		_refresh_garage())
	v.add_child(reset)
	v.add_child(UITheme.label("Tuning is written into the car's physics data when the race starts.", 14, UITheme.MUTED))
	return v


func _bias_labels() -> Array:
	return Garage.bias_labels(_car_id())


func _set_look(key: String, i: int) -> void:
	if not sm:
		return
	var look: Dictionary = sm.car_look(_car_id())
	look[key] = i
	sm.settings.garage.looks[_car_id()] = look
	_save()
	_refresh_swatches()
	look_changed.emit(_car_id())


func _set_tune(key: String, i: int) -> void:
	if not sm:
		return
	var t: Dictionary = sm.car_tune(_car_id())
	t[key] = i
	sm.settings.garage.tunes[_car_id()] = t
	_save()


func _refresh_garage() -> void:
	var id := _car_id()
	var car: Dictionary = Garage.CARS[Garage.car_index(id)]
	var s := Garage.stats(id)
	_car_name.text = str(s.name).to_upper()
	_car_class.text = car.class + "  ·  " + s.layout
	_car_blurb.text = car.blurb
	for c in _stat_box.get_children():
		c.queue_free()
	# Bars are scaled across the roster so differences are visible; numbers are the real values.
	_stat_box.add_child(_stat_bar("Power", "%d hp" % s.hp, s.kw / 420.0))
	_stat_box.add_child(_stat_bar("Torque", "%d Nm" % s.nm, s.nm / 700.0))
	_stat_box.add_child(_stat_bar("Weight", "%d kg" % s.kg, s.kg / 1600.0))
	_stat_box.add_child(_stat_bar("Power / weight", "%d W/kg" % s.w_per_kg, s.w_per_kg / 300.0))
	_stat_box.add_child(_stat_bar("Tyre grip", "µ %.2f" % s.grip, (s.grip - 0.9) / 0.4))
	var look: Dictionary = sm.car_look(id) if sm else Garage.LOOK_DEFAULT
	for k in _look_rows:
		_look_rows[k].set_index(int(look.get(k, 0)))
	var tune: Dictionary = sm.car_tune(id) if sm else Garage.TUNE_DEFAULT
	_tune_rows.brake_bias.options = _bias_labels()
	for k in _tune_rows:
		_tune_rows[k].set_index(int(tune.get(k, 0)))
	_refresh_swatches()


func _refresh_swatches() -> void:
	var look: Dictionary = sm.car_look(_car_id()) if sm else Garage.LOOK_DEFAULT
	for i in _swatches.size():
		var col: Color = Garage.PAINTS[i][1]
		var on := i == int(look.paint)
		var shown := col.lightened(0.08)
		_swatches[i].add_theme_stylebox_override("normal", UITheme.box(shown, UITheme.WHITE if on else Color(1, 1, 1, 0.12), 6, 3 if on else 1))
		_swatches[i].add_theme_stylebox_override("hover", UITheme.box(shown.lightened(0.1), Color(1, 1, 1, 0.6), 6, 2))
		_swatches[i].add_theme_stylebox_override("pressed", UITheme.box(shown, UITheme.WHITE, 6, 3))
		_swatches[i].add_theme_stylebox_override("focus", UITheme.box(Color.TRANSPARENT, UITheme.RED, 6, 3))
		_swatches[i].text = "✓" if on else ""
		_swatches[i].add_theme_color_override("font_color", Color.BLACK if col.get_luminance() > 0.5 else Color.WHITE)


func _stat_bar(name: String, value: String, frac: float) -> Control:
	var h := HBoxContainer.new()
	h.add_theme_constant_override("separation", 14)
	var n := UITheme.label(name.to_upper(), 15, UITheme.MUTED, "semi")
	n.custom_minimum_size = Vector2(150, 0)
	h.add_child(n)
	var track := Panel.new()
	track.custom_minimum_size = Vector2(0, 8)
	track.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	track.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	track.add_theme_stylebox_override("panel", UITheme.box(Color(1, 1, 1, 0.08), Color.TRANSPARENT, 4, 0, Vector2.ZERO))
	var fill := Panel.new()
	fill.anchor_bottom = 1.0
	fill.anchor_right = clampf(frac, 0.04, 1.0)
	fill.add_theme_stylebox_override("panel", UITheme.box(UITheme.RED, Color.TRANSPARENT, 4, 0, Vector2.ZERO))
	track.add_child(fill)
	h.add_child(track)
	var val := UITheme.label(value, 18, UITheme.WHITE, "semi")
	val.custom_minimum_size = Vector2(110, 0)
	val.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	h.add_child(val)
	return h


# ================================================================ input
func _unhandled_input(e: InputEvent) -> void:
	if not visible:
		return
	if e.is_action_pressed("ui_cancel"):
		var f := get_viewport().gui_get_focus_owner()
		if f and f in _nav:
			pass
		else:
			focus_nav()
		get_viewport().set_input_as_handled()
	elif e is InputEventKey and e.pressed and not e.echo and e.keycode in [KEY_ENTER, KEY_KP_ENTER] and _page == "race":
		if get_viewport().gui_get_focus_owner() == null:
			_on_start()
			get_viewport().set_input_as_handled()
