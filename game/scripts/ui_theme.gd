class_name UITheme
## Shared look for all menus and the HUD: night-city palette (near-black glass panels, one hot
## neon accent), Barlow Condensed display type + Barlow body type (SIL OFL, assets/fonts/OFL.txt).
## Menus call UITheme.make_theme() once on their root Control; every child control inherits it.

const BG := Color(0.035, 0.04, 0.055, 0.92)        # main glass panel
const BG_SOLID := Color(0.03, 0.035, 0.05, 1.0)
const BG_RAISED := Color(0.08, 0.09, 0.12, 0.95)   # inputs, cards
const BG_HOVER := Color(0.13, 0.14, 0.19, 0.98)
const LINE := Color(1, 1, 1, 0.09)                 # hairlines, idle borders

const RED := Color(1.0, 0.18, 0.33)                # accent (neon red-pink)
const RED_DARK := Color(0.62, 0.07, 0.18)
const RED_GLOW := Color(1.0, 0.18, 0.33, 0.28)
const CYAN := Color(0.25, 0.88, 1.0)               # secondary accent (info, player row)
const GREEN := Color(0.35, 0.95, 0.55)
const AMBER := Color(1.0, 0.72, 0.2)

const WHITE := Color(0.96, 0.97, 1.0)
const MUTED := Color(0.62, 0.65, 0.72)
const SUBTLE := Color(0.36, 0.38, 0.44)

const F_DISPLAY := preload("res://assets/fonts/BarlowCondensed-Bold.ttf")
const F_DISPLAY_SEMI := preload("res://assets/fonts/BarlowCondensed-SemiBold.ttf")
const F_BODY := preload("res://assets/fonts/Barlow-Medium.ttf")
const F_BODY_BOLD := preload("res://assets/fonts/Barlow-SemiBold.ttf")

static var _theme: Theme


static func box(bg := BG, border := Color.TRANSPARENT, radius := 6, border_w := 0, pad := Vector2(18, 12)) -> StyleBoxFlat:
	var sb := StyleBoxFlat.new()
	sb.bg_color = bg
	sb.border_color = border
	sb.set_border_width_all(border_w)
	sb.set_corner_radius_all(radius)
	sb.content_margin_left = pad.x
	sb.content_margin_right = pad.x
	sb.content_margin_top = pad.y
	sb.content_margin_bottom = pad.y
	sb.anti_aliasing = true
	return sb


## Panel with an accent strip on the left edge.
static func accent_box(bg := BG_RAISED, accent := RED, radius := 6) -> StyleBoxFlat:
	var sb := box(bg, accent, radius, 0, Vector2(20, 14))
	sb.border_width_left = 4
	return sb


static func make_theme() -> Theme:
	if _theme:
		return _theme
	var t := Theme.new()
	t.default_font = F_BODY
	t.default_font_size = 18

	t.set_color("font_color", "Label", WHITE)

	# Buttons (OptionButton, CheckButton, MenuButton inherit from Button in the default theme).
	for cls in ["Button", "OptionButton", "MenuButton"]:
		t.set_stylebox("normal", cls, box(BG_RAISED, LINE, 6, 1, Vector2(16, 9)))
		t.set_stylebox("hover", cls, box(BG_HOVER, Color(1, 1, 1, 0.22), 6, 1, Vector2(16, 9)))
		t.set_stylebox("pressed", cls, box(RED_DARK, RED, 6, 1, Vector2(16, 9)))
		t.set_stylebox("focus", cls, box(Color.TRANSPARENT, RED, 6, 2, Vector2(16, 9)))
		t.set_stylebox("disabled", cls, box(Color(0.06, 0.06, 0.08, 0.6), Color.TRANSPARENT, 6, 0, Vector2(16, 9)))
		t.set_color("font_color", cls, WHITE)
		t.set_color("font_hover_color", cls, WHITE)
		t.set_color("font_pressed_color", cls, WHITE)
		t.set_color("font_focus_color", cls, WHITE)
		t.set_color("font_disabled_color", cls, SUBTLE)
		t.set_font("font", cls, F_BODY_BOLD)
		t.set_font_size("font_size", cls, 17)

	var flat := StyleBoxEmpty.new()
	for st in ["normal", "hover", "pressed", "hover_pressed", "disabled"]:
		t.set_stylebox(st, "CheckButton", flat)
	t.set_stylebox("focus", "CheckButton", box(Color.TRANSPARENT, RED, 14, 2, Vector2(4, 2)))
	t.set_icon("checked", "CheckButton", _switch_icon(true))
	t.set_icon("unchecked", "CheckButton", _switch_icon(false))
	t.set_icon("checked_disabled", "CheckButton", _switch_icon(true))
	t.set_icon("unchecked_disabled", "CheckButton", _switch_icon(false))

	t.set_stylebox("panel", "PopupMenu", box(BG_SOLID, Color(1, 1, 1, 0.15), 6, 1, Vector2(6, 6)))
	t.set_stylebox("hover", "PopupMenu", box(RED_DARK, Color.TRANSPARENT, 4, 0, Vector2(10, 6)))
	t.set_font("font", "PopupMenu", F_BODY)
	t.set_font_size("font_size", "PopupMenu", 17)
	t.set_color("font_color", "PopupMenu", WHITE)
	t.set_color("font_hover_color", "PopupMenu", WHITE)
	t.set_constant("v_separation", "PopupMenu", 10)

	var track := box(Color(1, 1, 1, 0.1), Color.TRANSPARENT, 3, 0, Vector2(0, 3))
	var fill := box(RED, Color.TRANSPARENT, 3, 0, Vector2(0, 3))
	t.set_stylebox("slider", "HSlider", track)
	t.set_stylebox("grabber_area", "HSlider", fill)
	t.set_stylebox("grabber_area_highlight", "HSlider", fill)
	t.set_icon("grabber", "HSlider", _dot_icon(WHITE))
	t.set_icon("grabber_highlight", "HSlider", _dot_icon(RED))

	var sb_bar := box(Color(1, 1, 1, 0.02), Color.TRANSPARENT, 3, 0, Vector2(3, 3))
	var sb_grab := box(Color(1, 1, 1, 0.18), Color.TRANSPARENT, 3, 0, Vector2(3, 3))
	t.set_stylebox("scroll", "VScrollBar", sb_bar)
	t.set_stylebox("grabber", "VScrollBar", sb_grab)
	t.set_stylebox("grabber_highlight", "VScrollBar", box(Color(1, 1, 1, 0.3), Color.TRANSPARENT, 3, 0, Vector2(3, 3)))
	t.set_stylebox("grabber_pressed", "VScrollBar", fill)

	t.set_stylebox("panel", "PanelContainer", box())
	t.set_stylebox("separator", "HSeparator", _line_box())
	t.set_constant("separation", "HSeparator", 14)
	t.set_stylebox("panel", "TooltipPanel", box(BG_SOLID, LINE, 4, 1, Vector2(10, 6)))
	_theme = t
	return t


static func _line_box() -> StyleBoxLine:
	var l := StyleBoxLine.new()
	l.color = LINE
	l.thickness = 1
	return l


static func _switch_icon(on: bool) -> ImageTexture:
	var w := 46
	var h := 24
	var img := Image.create(w, h, false, Image.FORMAT_RGBA8)
	var track := RED if on else Color(1, 1, 1, 0.16)
	var r := h * 0.5
	for y in h:
		for x in w:
			var cx := clampf(x + 0.5, r, w - r)
			var d := Vector2(x + 0.5 - cx, y + 0.5 - r).length()
			var a := clampf(r - d, 0.0, 1.0)
			if a > 0.0:
				img.set_pixel(x, y, Color(track, track.a * a))
	var kx := w - r if on else r
	for y in h:
		for x in w:
			var d := Vector2(x + 0.5 - kx, y + 0.5 - r).length()
			var a := clampf(r - 3.0 - d, 0.0, 1.0)
			if a > 0.0:
				img.set_pixel(x, y, img.get_pixel(x, y).lerp(WHITE, a))
	return ImageTexture.create_from_image(img)


static func _dot_icon(col: Color, d := 18) -> ImageTexture:
	var img := Image.create(d, d, false, Image.FORMAT_RGBA8)
	var r := d * 0.5
	for y in d:
		for x in d:
			var a := clampf(r - Vector2(x + 0.5 - r, y + 0.5 - r).length(), 0.0, 1.0)
			img.set_pixel(x, y, Color(col, a))
	return ImageTexture.create_from_image(img)


## kind: "display" (condensed bold, headings), "semi" (condensed), "body", "bold"
static func label(text: String, size := 18, color := WHITE, kind := "body") -> Label:
	var l := Label.new()
	l.text = text
	l.add_theme_font_override("font", font(kind))
	l.add_theme_font_size_override("font_size", size)
	l.add_theme_color_override("font_color", color)
	return l


static func font(kind: String) -> Font:
	match kind:
		"display": return F_DISPLAY
		"semi": return F_DISPLAY_SEMI
		"bold": return F_BODY_BOLD
	return F_BODY


## Big call-to-action button (solid accent).
static func style_primary(btn: Button, size := 26) -> void:
	btn.add_theme_font_override("font", F_DISPLAY)
	btn.add_theme_font_size_override("font_size", size)
	btn.add_theme_stylebox_override("normal", box(RED, Color.TRANSPARENT, 6, 0, Vector2(28, 12)))
	btn.add_theme_stylebox_override("hover", box(RED.lightened(0.12), Color.TRANSPARENT, 6, 0, Vector2(28, 12)))
	btn.add_theme_stylebox_override("pressed", box(RED_DARK, Color.TRANSPARENT, 6, 0, Vector2(28, 12)))
	btn.add_theme_stylebox_override("focus", box(Color.TRANSPARENT, WHITE, 6, 2, Vector2(28, 12)))
	for c in ["font_color", "font_hover_color", "font_pressed_color", "font_focus_color"]:
		btn.add_theme_color_override(c, WHITE)


## Left-nav entry: flat text, accent bar + bright text when hovered/selected.
static func style_nav(btn: Button, selected: bool) -> void:
	btn.alignment = HORIZONTAL_ALIGNMENT_LEFT
	btn.add_theme_font_override("font", F_DISPLAY)
	btn.add_theme_font_size_override("font_size", 34)
	var idle := box(Color.TRANSPARENT, Color.TRANSPARENT, 0, 0, Vector2(22, 4))
	var on := box(Color(RED, 0.14), RED, 0, 0, Vector2(22, 4))
	on.border_width_left = 5
	var hov := box(Color(1, 1, 1, 0.05), Color(1, 1, 1, 0.5), 0, 0, Vector2(22, 4))
	hov.border_width_left = 5
	btn.add_theme_stylebox_override("normal", on if selected else idle)
	btn.add_theme_stylebox_override("hover", on if selected else hov)
	btn.add_theme_stylebox_override("pressed", on)
	btn.add_theme_stylebox_override("focus", hov)
	var col := WHITE if selected else MUTED
	btn.add_theme_color_override("font_color", col)
	btn.add_theme_color_override("font_focus_color", WHITE)
	btn.add_theme_color_override("font_hover_color", WHITE)
	btn.add_theme_color_override("font_pressed_color", WHITE)


## Selectable card (areas, modes): accent border when selected.
static func style_card(btn: Button, selected: bool, locked := false) -> void:
	var bg := Color(RED, 0.12) if selected else BG_RAISED
	var border := RED if selected else LINE
	var p := Vector2(16, 14)
	btn.add_theme_stylebox_override("normal", box(bg, border, 8, 2 if selected else 1, p))
	btn.add_theme_stylebox_override("hover", box(bg if selected else BG_HOVER, RED if selected else Color(1, 1, 1, 0.3), 8, 2 if selected else 1, p))
	btn.add_theme_stylebox_override("pressed", box(Color(RED, 0.2), RED, 8, 2, p))
	btn.add_theme_stylebox_override("focus", box(Color.TRANSPARENT, WHITE, 8, 2, p))
	btn.add_theme_stylebox_override("disabled", box(Color(0.05, 0.05, 0.07, 0.7), Color(1, 1, 1, 0.05), 8, 1, p))
	btn.modulate = Color(1, 1, 1, 0.55) if locked else Color.WHITE


## Section heading: small caps tag line + big title.
static func heading(kicker: String, title: String) -> VBoxContainer:
	var v := VBoxContainer.new()
	v.add_theme_constant_override("separation", -4)
	v.add_child(label(kicker.to_upper(), 15, RED, "semi"))
	v.add_child(label(title.to_upper(), 44, WHITE, "display"))
	return v
