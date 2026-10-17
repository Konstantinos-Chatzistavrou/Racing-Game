extends CanvasLayer
## Performance HUD + benchmark recorder (FPS, frame time, GPU/CPU time, draw calls, triangles,
## VRAM, RAM). In benchmark mode it records after a warm-up, writes JSON and quits.

var bench_duration := 0.0          # > 0 = benchmark mode
var warmup := 8.0
var out_path := ""
var shot_path := ""
var extra_info := ""

var _label: Label
var _vp: RID
var _ticks := 0
var _t := 0.0
var _hud_t := 0.0
var _frames := 0
var _shot_done := false
var _ft: PackedFloat64Array = []
var _gpu: PackedFloat64Array = []
var _cpu: PackedFloat64Array = []
var _draws: PackedFloat64Array = []
var _prims: PackedFloat64Array = []
var _rss_peak := 0.0


func _ready() -> void:
	layer = 10
	_label = Label.new()
	_label.position = Vector2(14, 10)
	_label.add_theme_font_size_override("font_size", 17)
	_label.add_theme_color_override("font_color", Color(0.55, 1.0, 0.6))
	_label.add_theme_color_override("font_outline_color", Color.BLACK)
	_label.add_theme_constant_override("outline_size", 6)
	add_child(_label)
	_vp = get_viewport().get_viewport_rid()
	RenderingServer.viewport_set_measure_render_time(_vp, true)
	_ticks = Time.get_ticks_usec()


func _process(_d: float) -> void:
	var now := Time.get_ticks_usec()
	var dt := (now - _ticks) / 1.0e6
	_ticks = now
	_t += minf(dt, 0.1)
	_frames += 1
	var g := RenderingServer.viewport_get_measured_render_time_gpu(_vp)
	var c := RenderingServer.viewport_get_measured_render_time_cpu(_vp)
	var dc := Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME)
	var pr := Performance.get_monitor(Performance.RENDER_TOTAL_PRIMITIVES_IN_FRAME)
	if bench_duration > 0.0 and _t > warmup and _frames > 120:
		_ft.append(dt); _gpu.append(g); _cpu.append(c); _draws.append(dc); _prims.append(pr)
		_rss_peak = maxf(_rss_peak, rss_mb())
		if not _shot_done and shot_path != "" and _t > warmup + bench_duration * 0.5:
			_shot_done = true
			get_viewport().get_texture().get_image().save_png(shot_path)
		if _t > warmup + bench_duration:
			_finish()
	_hud_t += dt
	if _hud_t > 0.25 and visible:
		_hud_t = 0.0
		_label.text = "FPS %d  (%.1f ms)   GPU %.1f ms  CPU %.1f ms\nDraws %d   Tris %.0fk   VRAM %.0f MB   RAM %.0f MB\n%s  scale %d%%\n%s" % [
			Engine.get_frames_per_second(), dt * 1000.0, g, c, dc, pr / 1000.0,
			Performance.get_monitor(Performance.RENDER_VIDEO_MEM_USED) / 1048576.0, rss_mb(),
			RenderingServer.get_current_rendering_method(), int(get_viewport().scaling_3d_scale * 100), extra_info]


static func rss_mb() -> float:
	var f := FileAccess.open("/proc/self/status", FileAccess.READ)
	if f == null:
		return 0.0
	while not f.eof_reached():      # /proc reports length 0: read line by line
		var line := f.get_line()
		if line.begins_with("VmRSS:"):
			return float(line.get_slice(":", 1).strip_edges().split(" ")[0]) / 1024.0
	return 0.0


static func _avg(a: PackedFloat64Array) -> float:
	var t := 0.0
	for x in a:
		t += x
	return t / maxi(1, a.size())


static func _pct(a: PackedFloat64Array, q: float) -> float:
	var s := a.duplicate()
	s.sort()
	return s[clampi(int(q * (s.size() - 1)), 0, s.size() - 1)] if s.size() > 0 else 0.0


static func _over(a: PackedFloat64Array, lim: float) -> int:
	var n := 0
	for x in a:
		if x > lim:
			n += 1
	return n


func _finish() -> void:
	var avg := _avg(_ft)
	var res := {
		"renderer": RenderingServer.get_current_rendering_method(),
		"adapter": RenderingServer.get_video_adapter_name(),
		"scale": get_viewport().scaling_3d_scale, "info": extra_info,
		"frames": _ft.size(), "avg_fps": 1.0 / avg, "p1_low_fps": 1.0 / _pct(_ft, 0.99),
		"avg_ms": avg * 1000.0, "worst_ms": _pct(_ft, 1.0) * 1000.0,
		"hitches_over_33ms": _over(_ft, 0.033), "hitches_over_100ms": _over(_ft, 0.1),
		"gpu_ms_avg": _avg(_gpu), "gpu_ms_p99": _pct(_gpu, 0.99), "cpu_ms_avg": _avg(_cpu),
		"draws_avg": _avg(_draws), "draws_max": _pct(_draws, 1.0),
		"tris_avg": _avg(_prims), "tris_max": _pct(_prims, 1.0),
		"vram_mb": Performance.get_monitor(Performance.RENDER_VIDEO_MEM_USED) / 1048576.0,
		"rss_peak_mb": _rss_peak,
	}
	var txt := JSON.stringify(res, "  ")
	print(txt)
	if out_path != "":
		var f := FileAccess.open(out_path, FileAccess.WRITE)
		if f:
			f.store_string(txt)
		else:
			push_error("cannot write " + out_path)
	get_tree().quit()
