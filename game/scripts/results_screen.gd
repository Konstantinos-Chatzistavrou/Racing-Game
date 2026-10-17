extends CanvasLayer
## End-of-race classification: finishing order, best laps, gaps, DNFs.

signal restart_requested
signal main_menu_requested
signal quit_requested

var _root: Control
var _card: Control


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	layer = 20
	_root = Control.new()
	_root.set_anchors_preset(Control.PRESET_FULL_RECT)
	_root.theme = UITheme.make_theme()
	add_child(_root)
	var bg := ColorRect.new()
	bg.set_anchors_preset(Control.PRESET_FULL_RECT)
	bg.color = Color(0.01, 0.012, 0.02, 0.8)
	_root.add_child(bg)


func show_results(race: RSRace, cars: Array[RSVehicle], names: Array[String], player: RSVehicle) -> void:
	if _card:
		_card.queue_free()
	var center := CenterContainer.new()
	center.set_anchors_preset(Control.PRESET_FULL_RECT)
	_root.add_child(center)
	_card = center
	var panel := PanelContainer.new()
	panel.custom_minimum_size = Vector2(1060, 0)
	panel.add_theme_stylebox_override("panel", UITheme.box(UITheme.BG, Color(1, 1, 1, 0.08), 10, 1, Vector2(44, 34)))
	center.add_child(panel)
	var v := VBoxContainer.new()
	v.add_theme_constant_override("separation", 14)
	panel.add_child(v)

	var order := range(cars.size())
	order.sort_custom(func(a, b): return race.get_progress(a).get("position", 99) < race.get_progress(b).get("position", 99))
	var pi := cars.find(player)
	var pp: Dictionary = race.get_progress(pi) if pi >= 0 else {}
	var title := "Race over"
	if pp.get("finished", false):
		title = "You won" if int(pp.get("position", 0)) == 1 and cars.size() > 1 else ("Finished P%d" % pp.get("position", 0) if cars.size() > 1 else "Session complete")
	elif pp.get("dnf", false):
		title = "Wrecked"
	v.add_child(UITheme.heading("Results", title))

	var winner_time := 0.0
	if order.size() > 0 and race.get_progress(order[0]).get("finished", false):
		winner_time = float(race.get_progress(order[0]).get("finish_time", 0.0))

	var grid := GridContainer.new()
	grid.columns = 5
	grid.add_theme_constant_override("h_separation", 34)
	grid.add_theme_constant_override("v_separation", 0)
	v.add_child(grid)
	for h in ["POS", "DRIVER", "STATUS", "BEST LAP", "TIME / GAP"]:
		var l := UITheme.label(h, 14, UITheme.MUTED, "semi")
		l.custom_minimum_size = Vector2([70, 300, 220, 160, 160][["POS", "DRIVER", "STATUS", "BEST LAP", "TIME / GAP"].find(h)], 30)
		grid.add_child(l)
	for idx in order:
		var c_idx: int = idx
		var prog: Dictionary = race.get_progress(c_idx)
		var is_p := cars[c_idx] == player
		var finished: bool = prog.get("finished", false)
		var pos: int = prog.get("position", 0)
		var col: Color = UITheme.CYAN if is_p else UITheme.WHITE
		grid.add_child(_cell("P%d" % pos, UITheme.RED if pos == 1 else col, 30, "display"))
		var name := (names[c_idx] if c_idx < names.size() else "AI").to_upper()
		grid.add_child(_cell(name if name == "YOU" or not is_p else name + "  (YOU)", col, 24, "display"))
		var dnf: bool = prog.get("dnf", false)
		grid.add_child(_cell("FINISHED" if finished else ("DNF  " + str(prog.get("dnf_reason", "")).to_upper() if dnf else "RUNNING"),
			UITheme.GREEN if finished else (UITheme.RED if dnf else UITheme.MUTED), 16, "semi"))
		grid.add_child(_cell(_fmt(prog.get("best_lap", 0.0)), UITheme.WHITE, 20, "semi"))
		var gap := "-"
		if finished:
			var ft: float = float(prog.get("finish_time", 0.0))
			gap = _fmt(ft) if pos == 1 or winner_time <= 0.0 else "+%.2f s" % (ft - winner_time)
		grid.add_child(_cell(gap, UITheme.MUTED, 20, "semi"))

	v.add_child(HSeparator.new())
	var bar := HBoxContainer.new()
	bar.add_theme_constant_override("separation", 14)
	bar.alignment = BoxContainer.ALIGNMENT_END
	v.add_child(bar)
	var quit := Button.new()
	quit.text = "QUIT"
	quit.pressed.connect(func(): quit_requested.emit())
	bar.add_child(quit)
	var menu := Button.new()
	menu.text = "MAIN MENU"
	menu.pressed.connect(func(): main_menu_requested.emit())
	bar.add_child(menu)
	var again := Button.new()
	again.text = "RACE AGAIN  ›"
	again.custom_minimum_size = Vector2(240, 0)
	UITheme.style_primary(again, 24)
	again.pressed.connect(func(): restart_requested.emit())
	bar.add_child(again)
	again.grab_focus.call_deferred()


func _cell(t: String, col: Color, size: int, kind: String) -> Label:
	var l := UITheme.label(t, size, col, kind)
	l.custom_minimum_size = Vector2(0, 40)
	l.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	return l


func _fmt(t: float) -> String:
	return "--:--.---" if t <= 0.0 else "%d:%06.3f" % [int(t / 60.0), fmod(t, 60.0)]
