extends Control
## Debug overlay for an RSVehicle (F1 toggle, F2 = 3D force arrows).
## Panels: inputs (raw vs applied), drivetrain, chassis (g, sideslip, yaw rate vs ESC reference),
## assist states, g-g diagram, and per-wheel friction circles.
## Friction circle: the ring is the tyre's grip limit (peak mu x surface x load); the dot is the
## current horizontal tyre force (Fx up, Fy left). Dot on the ring = tyre at its limit.

@export var car_path: NodePath
var car: RSVehicle
var t := {}
var gg_trail: PackedVector2Array = []
var vectors: MeshInstance3D
var imesh: ImmediateMesh
var show_vectors := false
var font: Font

const ASSIST_NAMES := [["abs", "1 ABS"], ["tc", "2 TC"], ["esc", "3 ESC"], ["countersteer", "4 C-STEER"],
	["auto_gearbox", "5 AUTO BOX"], ["auto_clutch", "6 AUTO CLUTCH"], ["speed_sensitive_steering", "7 SPD STEER"]]
const WHEEL_NAMES := ["FL", "FR", "RL", "RR"]
const BG := Color(0, 0, 0, 0.55)


func _ready() -> void:
	set_anchors_preset(Control.PRESET_FULL_RECT)
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	car = get_node(car_path)
	font = ThemeDB.fallback_font
	imesh = ImmediateMesh.new()
	vectors = MeshInstance3D.new()
	vectors.mesh = imesh
	var m := StandardMaterial3D.new()
	m.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	m.vertex_color_use_as_albedo = true
	m.no_depth_test = true
	vectors.material_override = m
	vectors.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	car.get_parent().add_child.call_deferred(vectors)


func _unhandled_input(e: InputEvent) -> void:
	if e is InputEventKey and e.pressed and not e.echo:
		if e.keycode == KEY_F1: visible = not visible
		if e.keycode == KEY_F2: show_vectors = not show_vectors


func _process(_dt: float) -> void:
	t = car.get_telemetry()
	if t.is_empty():
		return
	gg_trail.append(Vector2(t.g_lat, t.g_long))
	if gg_trail.size() > 120:
		gg_trail.remove_at(0)
	_draw_vectors()
	if visible:
		queue_redraw()


# ---------------------------------------------------------------- 3D force arrows
func _draw_vectors() -> void:
	imesh.clear_surfaces()
	if not show_vectors:
		return
	imesh.surface_begin(Mesh.PRIMITIVE_LINES)
	for w in t.wheels:
		if not w.contact:
			continue
		var p: Vector3 = w.contact_point + Vector3.UP * 0.05
		var util: float = Vector2(w.fx, w.fy).length() / maxf(w.grip_limit, 1.0)
		imesh.surface_set_color(_util_color(util))
		imesh.surface_add_vertex(p)
		imesh.surface_add_vertex(p + w.force / 4000.0)           # 1 m per 4 kN
		imesh.surface_set_color(Color(0.3, 0.6, 1.0))
		imesh.surface_add_vertex(p)
		imesh.surface_add_vertex(p + Vector3.UP * w.load / 8000.0)   # load: 1 m per 8 kN
	imesh.surface_end()


func _util_color(u: float) -> Color:
	return Color(0.3, 1.0, 0.4).lerp(Color(1.0, 0.85, 0.2), clampf(u * 1.4, 0, 1)) if u < 0.75 \
		else Color(1.0, 0.85, 0.2).lerp(Color(1.0, 0.2, 0.15), clampf((u - 0.75) * 4.0, 0, 1))


# ---------------------------------------------------------------- 2D overlay
func _text(pos: Vector2, s: String, col := Color.WHITE, size := 15) -> void:
	draw_string(font, pos, s, HORIZONTAL_ALIGNMENT_LEFT, -1, size, col)


func _bar(pos: Vector2, w: float, value: float, col: Color, label: String, centred := false) -> void:
	draw_rect(Rect2(pos, Vector2(w, 12)), Color(1, 1, 1, 0.12))
	if centred:
		var mid := pos.x + w * 0.5
		draw_rect(Rect2(Vector2(minf(mid, mid + value * w * 0.5), pos.y), Vector2(absf(value) * w * 0.5, 12)), col)
		draw_line(Vector2(mid, pos.y - 2), Vector2(mid, pos.y + 14), Color(1, 1, 1, 0.5))
	else:
		draw_rect(Rect2(pos, Vector2(clampf(value, 0, 1) * w, 12)), col)
	_text(pos + Vector2(w + 8, 11), label, Color(0.85, 0.85, 0.85), 13)


func _draw() -> void:
	if t.is_empty():
		return
	var vp := get_viewport_rect().size
	# ---- left panel: inputs + drivetrain + chassis
	var x := 16.0
	var y := 16.0
	draw_rect(Rect2(x - 8, y - 8, 360, 300), BG)
	_text(Vector2(x, y + 14), "%3d km/h   gear %s   %5d rpm%s" % [int(t.speed_kmh), t.gear, int(t.rpm), "   STALLED" if t.stalled else ""], Color.WHITE, 18)
	y += 26
	_bar(Vector2(x, y), 220, t.rpm / t.redline, Color(1, 0.3, 0.2) if t.rpm > 0.95 * t.redline else Color(0.9, 0.9, 0.9), "rpm")
	y += 22
	_text(Vector2(x, y + 10), "INPUT  (%s)" % ["keyboard", "gamepad", "wheel"][t.device], Color(0.7, 0.85, 1.0), 13)
	y += 18
	_bar(Vector2(x, y), 220, t.throttle_raw, Color(0.3, 0.8, 0.3, 0.4), "")
	_bar(Vector2(x, y), 220, t.throttle_applied, Color(0.3, 1.0, 0.4), "throttle (raw / after TC)")
	y += 18
	_bar(Vector2(x, y), 220, t.brake_raw, Color(1, 0.3, 0.3, 0.4), "")
	_bar(Vector2(x, y), 220, t.brake_applied, Color(1, 0.3, 0.3), "brake")
	y += 18
	_bar(Vector2(x, y), 220, t.steer_raw, Color(0.5, 0.7, 1.0, 0.35), "", true)
	_bar(Vector2(x, y), 220, t.steer_applied, Color(0.5, 0.7, 1.0), "steer %+.1f° (limit %d%%)" % [t.steer_deg, int(t.steer_limit * 100)], true)
	y += 18
	_bar(Vector2(x, y), 220, t.clutch, Color(0.8, 0.8, 0.5), "clutch (1 = open)")
	y += 26
	_text(Vector2(x, y), "CHASSIS", Color(0.7, 0.85, 1.0), 13)
	y += 16
	_text(Vector2(x, y), "long %+.2f g   lat %+.2f g   sideslip %+.1f°" % [t.g_long, t.g_lat, t.sideslip_deg], Color.WHITE, 14)
	y += 18
	_bar(Vector2(x, y), 220, clampf(t.yaw_rate / 1.5, -1, 1), Color(1, 0.8, 0.3), "yaw %+.2f rad/s" % t.yaw_rate, true)
	y += 16
	_bar(Vector2(x, y), 220, clampf(t.yaw_rate_ref / 1.5, -1, 1), Color(1, 0.8, 0.3, 0.45), "ESC reference %+.2f" % t.yaw_rate_ref, true)
	y += 24
	# ---- assists row
	var ax := x
	var any_abs := false
	for w in t.wheels:
		any_abs = any_abs or w.abs
	for pair in ASSIST_NAMES:
		var on: bool = car.get_assist(pair[0])
		var active: bool = (pair[0] == "abs" and any_abs) or (pair[0] == "tc" and t.tc_cut > 0.05) or (pair[0] == "esc" and t.esc_mode != 0)
		var col := Color(1, 0.75, 0.1) if active else (Color(0.4, 0.9, 0.5) if on else Color(0.45, 0.45, 0.45))
		var label: String = pair[1]
		var wdt := font.get_string_size(label, HORIZONTAL_ALIGNMENT_LEFT, -1, 12).x + 10
		if ax + wdt > x + 345:
			ax = x
			y += 20
		draw_rect(Rect2(ax, y - 12, wdt, 17), col * Color(1, 1, 1, 0.35))
		_text(Vector2(ax + 5, y), label, col, 12)
		ax += wdt + 4
	_text(Vector2(x, y + 22), "F1 overlay  F2 force arrows  E/Q shift  R reset", Color(0.6, 0.6, 0.6), 12)

	# ---- g-g diagram (bottom left): lateral right/left, longitudinal up = accelerating
	var c := Vector2(110, vp.y - 110)
	var R := 90.0
	draw_rect(Rect2(c - Vector2(R + 12, R + 12), Vector2(2 * R + 24, 2 * R + 24)), BG)
	draw_arc(c, R, 0, TAU, 48, Color(1, 1, 1, 0.35), 1.5)
	draw_arc(c, R * 0.5, 0, TAU, 32, Color(1, 1, 1, 0.15), 1.0)
	draw_line(c - Vector2(R, 0), c + Vector2(R, 0), Color(1, 1, 1, 0.15))
	draw_line(c - Vector2(0, R), c + Vector2(0, R), Color(1, 1, 1, 0.15))
	for i in gg_trail.size():
		var g := gg_trail[i]
		draw_circle(c + Vector2(-g.x, -g.y) * R, 2.0, Color(1, 0.8, 0.3, float(i) / gg_trail.size()))
	_text(c + Vector2(-R, -R - 2), "g-g (ring = 1 g)", Color(0.8, 0.8, 0.8), 12)

	# ---- friction circles (bottom right), laid out like the car seen from above
	# Each wheel gets a fixed 160 x 135 cell: label on top, circle in the middle, slips below.
	var origin := Vector2(vp.x - 336, vp.y - 290)
	draw_rect(Rect2(origin - Vector2(8, 8), Vector2(336, 290)), BG)
	var max_lim := 1.0
	for w in t.wheels:
		max_lim = maxf(max_lim, w.grip_limit)
	for i in 4:
		var w: Dictionary = t.wheels[i]
		var cell := origin + Vector2((0 if i % 2 == 0 else 1) * 164, (0 if i < 2 else 1) * 140)
		var cc := cell + Vector2(80, 68)
		var rad := 42.0 * sqrt(maxf(w.grip_limit, 0.0) / max_lim) + 4.0
		var util: float = Vector2(w.fx, w.fy).length() / maxf(w.grip_limit, 1.0)
		draw_arc(cc, rad, 0, TAU, 40, Color(1, 1, 1, 0.5), 1.5)
		var dot := Vector2(-w.fy, -w.fx) / maxf(w.grip_limit, 1.0) * rad
		draw_line(cc, cc + dot, _util_color(util), 2.0)
		draw_circle(cc + dot, 4.0, _util_color(util))
		var flag := ""
		if w.abs: flag += " ABS"
		if w.esc_brake > 10: flag += " ESC"
		_text(cell + Vector2(4, 12), "%s %.1f kN %s%s" % [WHEEL_NAMES[i], w.load / 1000.0, w.surface if w.contact else "AIR", flag], Color.WHITE, 12)
		_text(cell + Vector2(4, 130), "κ %+.2f   α %+.1f°" % [w.slip_ratio, w.slip_angle_deg], Color(0.85, 0.85, 0.85), 12)
