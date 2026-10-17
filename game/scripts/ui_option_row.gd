extends PanelContainer
## One settings row:  NAME ............ ‹ VALUE ›
## Keyboard/gamepad: focus the row, Left/Right change the value. Mouse: click the arrows or the
## value (cycles forward). Toggles are just two options ["OFF", "ON"].

signal changed(index: int)

var options: Array = []
var index := 0
var hint := ""

var _name: Label
var _value: Label
var _hint: Label
var _hovered := false


static func make(title: String, opts: Array, start := 0, hint_text := "") -> PanelContainer:
	var r = load("res://scripts/ui_option_row.gd").new()
	r.options = opts
	r.index = clampi(start, 0, maxi(opts.size() - 1, 0))
	r.hint = hint_text
	r._build(title)
	return r


func _build(title: String) -> void:
	focus_mode = Control.FOCUS_ALL
	mouse_filter = Control.MOUSE_FILTER_STOP
	custom_minimum_size = Vector2(0, 52)
	mouse_entered.connect(func(): _hovered = true; _restyle())
	mouse_exited.connect(func(): _hovered = false; _restyle())
	focus_entered.connect(_restyle)
	focus_exited.connect(_restyle)

	var h := HBoxContainer.new()
	h.add_theme_constant_override("separation", 10)
	add_child(h)
	var left := VBoxContainer.new()
	left.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	left.alignment = BoxContainer.ALIGNMENT_CENTER
	left.add_theme_constant_override("separation", -2)
	h.add_child(left)
	_name = UITheme.label(title, 19, UITheme.WHITE, "bold")
	left.add_child(_name)
	if hint != "":
		_hint = UITheme.label(hint, 14, UITheme.MUTED)
		left.add_child(_hint)

	h.add_child(_arrow("‹", -1))
	_value = UITheme.label("", 20, UITheme.WHITE, "semi")
	_value.custom_minimum_size = Vector2(190, 0)
	_value.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_value.mouse_filter = Control.MOUSE_FILTER_STOP
	_value.gui_input.connect(func(e): if e is InputEventMouseButton and e.pressed and e.button_index == MOUSE_BUTTON_LEFT: step(1))
	h.add_child(_value)
	h.add_child(_arrow("›", 1))
	_refresh()
	_restyle()


func _arrow(t: String, dir: int) -> Button:
	var b := Button.new()
	b.text = t
	b.flat = true
	b.focus_mode = Control.FOCUS_NONE
	b.add_theme_font_override("font", UITheme.F_DISPLAY)
	b.add_theme_font_size_override("font_size", 30)
	b.add_theme_color_override("font_color", UITheme.MUTED)
	b.add_theme_color_override("font_hover_color", UITheme.RED)
	b.add_theme_stylebox_override("normal", StyleBoxEmpty.new())
	b.add_theme_stylebox_override("hover", StyleBoxEmpty.new())
	b.add_theme_stylebox_override("pressed", StyleBoxEmpty.new())
	b.pressed.connect(func(): step(dir))
	return b


func step(dir: int) -> void:
	if options.is_empty():
		return
	index = (index + dir + options.size()) % options.size()
	_refresh()
	changed.emit(index)


func set_index(i: int) -> void:
	index = clampi(i, 0, options.size() - 1)
	_refresh()


func _refresh() -> void:
	if _value and not options.is_empty():
		_value.text = str(options[index]).to_upper()
		var v := str(options[index]).to_upper()
		_value.add_theme_color_override("font_color", UITheme.SUBTLE if v == "OFF" else (UITheme.GREEN if v == "ON" else UITheme.WHITE))


func _restyle() -> void:
	var f := has_focus()
	var bg := Color(1, 1, 1, 0.07) if (f or _hovered) else Color(1, 1, 1, 0.025)
	var sb := UITheme.box(bg, UITheme.RED if f else Color.TRANSPARENT, 6, 0, Vector2(18, 6))
	sb.border_width_left = 4 if f else 0
	add_theme_stylebox_override("panel", sb)


func _gui_input(e: InputEvent) -> void:
	if e.is_action_pressed("ui_left"):
		step(-1)
		accept_event()
	elif e.is_action_pressed("ui_right") or e.is_action_pressed("ui_accept"):
		step(1)
		accept_event()
