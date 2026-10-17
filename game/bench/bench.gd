extends Node3D
## Phase 0 stress test. Builds a night street scene procedurally, flies a camera around a ring
## road for a fixed time, records frame statistics, writes JSON, quits.
##
## Run (see tools/run_bench.sh):
##   godot --path game --rendering-method mobile --fullscreen -- --scale=0.75 --out=res.json
## User args:  --scale=0.75 --duration=30 --warmup=4 --out=file --shot=file.png
##             --spots=N (shadow-casting headlights) --lod0 (force all cars LOD0 = worst case)
##             --nopost (disable glow/tonemap) --hud=0

# ---------------- config (overridable from the command line) ----------------
var scale_3d := 1.0
var duration := 30.0
var warmup := 6.0
var out_path := ""
var shot_path := ""
var spots := 0
var force_lod0 := false
var post := true
var show_hud := true
var cam_debug := false

# ---------------- scene constants ----------------
const RING_R := 150.0        # road centre-line radius (m) -> 942 m lap
const ROAD_W := 10.0
const SPEED := 35.0          # camera speed (m/s), ~126 km/h -> a lap takes ~27 s
const N_BUILDINGS := 49      # 49 * 3072 tris = ~150k tris of buildings
const BUILD_SUBDIV := 16     # 12 * 16^2 = 3072 tris

# LOD triangle counts (body only; wheels separate). From the starting budgets.
const HERO_LODS := [38000, 17000, 7000, 1800]   # + 4 wheels * 3000 on LOD0, scaled down after
const OPP_LODS := [16000, 6500, 2500, 1200]
const HERO_WHEEL := [3000, 1200, 500, 0]
const OPP_WHEEL := [1000, 500, 200, 0]
const LOD_RANGES := [0.0, 18.0, 45.0, 100.0, 100000.0]  # metres: LOD i visible in [r[i], r[i+1])

var hud: Label
var cam: Camera3D
var frame_times: PackedFloat64Array = []
var gpu_ms: PackedFloat64Array = []
var cpu_ms: PackedFloat64Array = []
var draws: PackedFloat64Array = []
var prims: PackedFloat64Array = []
var rss_peak_mb := 0.0
var elapsed := 0.0
var last_ticks := 0
var hud_timer := 0.0
var shot_done := false
var frame_no := 0
var vp_rid: RID
var build_time_s := 0.0
var _mesh_cache := {}


func _ready() -> void:
	_parse_args()
	var t0 := Time.get_ticks_msec()
	get_viewport().scaling_3d_mode = Viewport.SCALING_3D_MODE_BILINEAR
	get_viewport().scaling_3d_scale = scale_3d
	_build_environment()
	_build_lighting()
	_build_road_and_ground()
	_build_buildings()
	_build_props()
	_build_cars()
	_build_camera_and_hud()
	build_time_s = (Time.get_ticks_msec() - t0) / 1000.0
	vp_rid = get_viewport().get_viewport_rid()
	RenderingServer.viewport_set_measure_render_time(vp_rid, true)
	last_ticks = Time.get_ticks_usec()
	print("[bench] built in %.1fs  renderer=%s adapter=%s scale=%.2f" % [
		build_time_s, RenderingServer.get_current_rendering_method(),
		RenderingServer.get_video_adapter_name(), scale_3d])


func _parse_args() -> void:
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--scale="): scale_3d = float(a.get_slice("=", 1))
		elif a.begins_with("--duration="): duration = float(a.get_slice("=", 1))
		elif a.begins_with("--warmup="): warmup = float(a.get_slice("=", 1))
		elif a.begins_with("--out="): out_path = a.get_slice("=", 1)
		elif a.begins_with("--shot="): shot_path = a.get_slice("=", 1)
		elif a.begins_with("--spots="): spots = int(a.get_slice("=", 1))
		elif a.begins_with("--hud="): show_hud = a.get_slice("=", 1) != "0"
		elif a == "--lod0": force_lod0 = true
		elif a == "--nopost": post = false
		elif a == "--camdebug": cam_debug = true


# ======================================================================== textures
## Procedural noise texture, compressed like a shipped VRAM texture would be.
func _noise_tex(size: int, freq: float, seed_: int, normal: bool, _tint := Color.WHITE) -> ImageTexture:
	var fn := FastNoiseLite.new()
	fn.seed = seed_
	fn.frequency = freq
	fn.fractal_octaves = 5
	var img := fn.get_image(size, size, false, false, false)
	if normal:
		img.bump_map_to_normal_map(6.0)
	img.convert(Image.FORMAT_RGB8)
	img.generate_mipmaps()
	img.compress(Image.COMPRESS_S3TC, Image.COMPRESS_SOURCE_NORMAL if normal else Image.COMPRESS_SOURCE_GENERIC)
	return ImageTexture.create_from_image(img)


func _pbr(albedo: Color, tex: Texture2D, nrm: Texture2D, rough: float, uv_scale := 1.0) -> StandardMaterial3D:
	var m := StandardMaterial3D.new()
	m.albedo_color = albedo
	m.albedo_texture = tex
	m.roughness = rough
	if nrm:
		m.normal_enabled = true
		m.normal_texture = nrm
	m.uv1_scale = Vector3(uv_scale, uv_scale, 1)
	return m


# ======================================================================== environment
func _build_environment() -> void:
	var env := Environment.new()
	env.background_mode = Environment.BG_SKY
	var sky := Sky.new()
	var sm := ProceduralSkyMaterial.new()
	sm.sky_top_color = Color(0.015, 0.025, 0.07)
	sm.sky_horizon_color = Color(0.06, 0.07, 0.13)
	sm.ground_horizon_color = Color(0.04, 0.045, 0.08)
	sm.ground_bottom_color = Color(0.01, 0.01, 0.02)
	sky.sky_material = sm
	env.sky = sky
	env.ambient_light_source = Environment.AMBIENT_SOURCE_SKY
	env.ambient_light_energy = 2.5
	env.reflected_light_source = Environment.REFLECTION_SOURCE_SKY
	if post:
		env.tonemap_mode = Environment.TONE_MAPPER_ACES
		env.glow_enabled = true
		env.glow_intensity = 0.7
		env.glow_hdr_threshold = 0.9
	var we := WorldEnvironment.new()
	we.environment = env
	add_child(we)

	# One reflection probe over the whole ring (wet asphalt look). Whether the renderer
	# honours it is visible in the screenshots.
	var rp := ReflectionProbe.new()
	rp.size = Vector3(500, 60, 500)
	rp.position = Vector3(0, 20, 0)
	rp.update_mode = ReflectionProbe.UPDATE_ONCE
	rp.box_projection = true
	add_child(rp)


func _build_lighting() -> void:
	var sun := DirectionalLight3D.new()   # "moon": low energy, cold colour
	sun.light_color = Color(0.55, 0.65, 1.0)
	sun.light_energy = 1.2
	sun.rotation_degrees = Vector3(-50, 30, 0)
	sun.shadow_enabled = true
	sun.directional_shadow_mode = DirectionalLight3D.SHADOW_PARALLEL_2_SPLITS
	sun.directional_shadow_max_distance = 120.0
	add_child(sun)


# ======================================================================== road / ground
func _build_road_and_ground() -> void:
	var road_tex := _noise_tex(2048, 0.02, 1, false, Color.WHITE)
	var road_nrm := _noise_tex(2048, 0.05, 2, true, Color.WHITE)
	# Wet asphalt: dark, low roughness (0.25) so the reflection probe/sky shows up in it.
	var road_mat := _pbr(Color(0.16, 0.16, 0.18), road_tex, road_nrm, 0.25)
	road_mat.metallic_specular = 0.7
	var road := MeshInstance3D.new()
	road.mesh = MeshGen.ring(RING_R, ROAD_W, 384, 6, 8.0)
	road.material_override = road_mat
	road.position.y = 0.01
	add_child(road)

	# Kerbs: two thin box-ish rings approximated with narrow ring strips raised 0.1 m.
	for side in [-1, 1]:
		var k := MeshInstance3D.new()
		k.mesh = MeshGen.ring(RING_R + side * (ROAD_W * 0.5 + 0.4), 0.8, 384, 2, 4.0)
		k.material_override = _pbr(Color(0.7, 0.2, 0.2), null, null, 0.7)
		k.position.y = 0.06
		add_child(k)

	var grass_tex := _noise_tex(1024, 0.04, 3, false, Color.WHITE)
	var grass_nrm := _noise_tex(1024, 0.08, 4, true, Color.WHITE)
	var ground := MeshInstance3D.new()
	ground.mesh = MeshGen.plane(900.0, 60)  # 7.2k tris
	ground.material_override = _pbr(Color(0.07, 0.1, 0.06), grass_tex, grass_nrm, 0.95, 0.6)
	add_child(ground)


# ======================================================================== buildings (150k tris)
func _build_buildings() -> void:
	var tex := _noise_tex(1024, 0.03, 5, false, Color.WHITE)
	var nrm := _noise_tex(1024, 0.06, 6, true, Color.WHITE)
	var wall := _pbr(Color(0.3, 0.3, 0.34), tex, nrm, 0.8, 2.0)
	var box_mesh := MeshGen.box(Vector3(1, 1, 1), BUILD_SUBDIV)
	var sign_mat := StandardMaterial3D.new()
	sign_mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	sign_mat.albedo_color = Color(1.0, 0.35, 0.15)
	sign_mat.emission_enabled = true
	sign_mat.emission = Color(1.0, 0.4, 0.15)
	sign_mat.emission_energy_multiplier = 4.0
	var sign_mesh := QuadMesh.new()
	sign_mesh.size = Vector2(4, 1.4)
	var rng := RandomNumberGenerator.new()
	rng.seed = 42
	for i in N_BUILDINGS:
		var ang := TAU * (i + rng.randf()) / N_BUILDINGS
		var outside := i % 3 != 0
		var r := RING_R + (rng.randf_range(16, 70) if outside else -rng.randf_range(16, 55))
		var dims := Vector3(rng.randf_range(10, 26), rng.randf_range(8, 45), rng.randf_range(10, 26))
		var mi := MeshInstance3D.new()
		mi.mesh = box_mesh                       # shared mesh, unique size via node scale
		mi.scale = dims
		mi.material_override = wall
		mi.position = Vector3(r * cos(ang), dims.y * 0.5, r * sin(ang))
		mi.rotation.y = -ang
		add_child(mi)
		# Emissive sign facing the road (every 3rd building)
		if i % 3 == 1:
			var sg := MeshInstance3D.new()
			sg.mesh = sign_mesh
			sg.material_override = sign_mat
			var toward := Vector3(-cos(ang), 0, -sin(ang)) * (1 if outside else -1)
			add_child(sg)
			sg.position = mi.position + toward * (dims.x * 0.5 + 0.2) + Vector3(0, minf(dims.y * 0.4, 8.0) - dims.y * 0.5, 0)
			sg.look_at(sg.position - toward, Vector3.UP)  # QuadMesh faces +Z; look_at points -Z at the target


# ======================================================================== props (MultiMesh)
func _build_props() -> void:
	# Street lamps: 100-tri posts + emissive heads, one draw call each batch.
	var post_mesh := CylinderMesh.new()
	post_mesh.top_radius = 0.08
	post_mesh.bottom_radius = 0.12
	post_mesh.height = 7.0
	post_mesh.radial_segments = 10
	post_mesh.rings = 1
	var head_mesh := SphereMesh.new()
	head_mesh.radius = 0.35
	head_mesh.height = 0.5
	head_mesh.radial_segments = 8
	head_mesh.rings = 4
	var head_mat := StandardMaterial3D.new()
	head_mat.albedo_color = Color(1, 0.85, 0.5)
	head_mat.emission_enabled = true
	head_mat.emission = Color(1, 0.8, 0.45)
	head_mat.emission_energy_multiplier = 6.0
	var n_lamps := 120
	var mm_post := MultiMesh.new()
	mm_post.transform_format = MultiMesh.TRANSFORM_3D
	mm_post.mesh = post_mesh
	mm_post.instance_count = n_lamps
	var mm_head := MultiMesh.new()
	mm_head.transform_format = MultiMesh.TRANSFORM_3D
	mm_head.mesh = head_mesh
	mm_head.instance_count = n_lamps
	for i in n_lamps:
		var ang := TAU * i / n_lamps
		var side := 1.0 if i % 2 == 0 else -1.0
		var r := RING_R + side * (ROAD_W * 0.5 + 2.0)
		var p := Vector3(r * cos(ang), 3.5, r * sin(ang))
		mm_post.set_instance_transform(i, Transform3D(Basis(), p))
		mm_head.set_instance_transform(i, Transform3D(Basis(), p + Vector3(0, 3.6, 0)))
	var mi1 := MultiMeshInstance3D.new()
	mi1.multimesh = mm_post
	mi1.material_override = _pbr(Color(0.2, 0.2, 0.22), null, null, 0.5)
	add_child(mi1)
	var mi2 := MultiMeshInstance3D.new()
	mi2.multimesh = mm_head
	mi2.material_override = head_mat
	add_child(mi2)

	# Foliage: camera-facing alpha-scissor billboards in a MultiMesh (2 tris each, 1 draw call).
	var fn := FastNoiseLite.new()
	fn.frequency = 0.08
	var leaf_img := fn.get_image(256, 256, false, false, false)
	leaf_img.convert(Image.FORMAT_RGBA8)
	var leaf_tex := ImageTexture.create_from_image(leaf_img)
	var leaf_mat := StandardMaterial3D.new()
	leaf_mat.albedo_color = Color(0.1, 0.25, 0.1)
	leaf_mat.albedo_texture = leaf_tex
	leaf_mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA_SCISSOR
	leaf_mat.billboard_mode = BaseMaterial3D.BILLBOARD_FIXED_Y
	var quad := QuadMesh.new()
	quad.size = Vector2(4, 5)
	var mm_f := MultiMesh.new()
	mm_f.transform_format = MultiMesh.TRANSFORM_3D
	mm_f.mesh = quad
	var n_f := 500
	mm_f.instance_count = n_f
	var rng := RandomNumberGenerator.new()
	rng.seed = 7
	for i in n_f:
		var ang := rng.randf() * TAU
		var r := RING_R + rng.randf_range(-100, 120)
		if absf(r - RING_R) < ROAD_W:
			r += 14.0
		mm_f.set_instance_transform(i, Transform3D(Basis(), Vector3(r * cos(ang), 2.5, r * sin(ang))))
	var mi3 := MultiMeshInstance3D.new()
	mi3.multimesh = mm_f
	mi3.material_override = leaf_mat
	mi3.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(mi3)


# ======================================================================== cars with LOD
func _cached_blob(tris: int, radii: Vector3) -> Mesh:
	var key := "%d_%s" % [tris, radii]
	if not _mesh_cache.has(key):
		_mesh_cache[key] = MeshGen.blob(tris, radii)
	return _mesh_cache[key]


func _build_cars() -> void:
	var paint_tex := _noise_tex(2048, 0.01, 8, false, Color.WHITE)   # 2K hero texture
	var hero_mat := _pbr(Color(0.5, 0.05, 0.05), paint_tex, null, 0.25)
	hero_mat.metallic = 0.6
	hero_mat.clearcoat_enabled = true
	hero_mat.clearcoat = 1.0
	hero_mat.clearcoat_roughness = 0.05
	var opp_tex := _noise_tex(1024, 0.01, 9, false, Color.WHITE)
	var opp_mats: Array[StandardMaterial3D] = []
	for c in [Color(0.05, 0.2, 0.5), Color(0.6, 0.6, 0.62), Color(0.1, 0.1, 0.1), Color(0.7, 0.5, 0.05)]:
		var m := _pbr(c, opp_tex, null, 0.35)
		m.metallic = 0.5
		opp_mats.append(m)
	var tire_mat := _pbr(Color(0.03, 0.03, 0.03), null, null, 0.9)

	var n_cars := 8
	var spots_left := spots
	for ci in n_cars:
		var hero := ci == 0
		var body_t: Array = HERO_LODS if hero else OPP_LODS
		var wheel_t: Array = HERO_WHEEL if hero else OPP_WHEEL
		var mat := hero_mat if hero else opp_mats[ci % opp_mats.size()]
		var car := Node3D.new()
		var ang := TAU * ci / n_cars
		var lane := -2.0 if ci % 2 == 0 else 2.0
		var r := RING_R + lane
		car.position = Vector3(r * cos(ang), 0, r * sin(ang))
		car.rotation.y = -ang - PI * 0.5      # car forward (local +X) -> ring tangent direction of travel
		add_child(car)
		for lod in 4:
			var lod_root := Node3D.new()
			car.add_child(lod_root)
			var lo: float = LOD_RANGES[lod]
			var hi: float = LOD_RANGES[lod + 1]
			if force_lod0:
				lo = 0.0 if lod == 0 else 1.0e9
				hi = 1.0e9 if lod == 0 else 1.0e9 + 1.0
			var body := MeshInstance3D.new()
			body.mesh = _cached_blob(body_t[lod], Vector3(2.2, 0.5, 0.9))
			body.material_override = mat
			body.position.y = 0.7
			_set_range(body, lo, hi)
			lod_root.add_child(body)
			if wheel_t[lod] > 0:
				var wm := _cached_blob(wheel_t[lod], Vector3(0.33, 0.16, 0.33))
				for wx in [-1.3, 1.3]:
					for wz in [-0.85, 0.85]:
						var w := MeshInstance3D.new()
						w.mesh = wm
						w.material_override = tire_mat
						w.position = Vector3(wx, 0.33, wz)
						w.rotation.x = PI * 0.5
						_set_range(w, lo, hi)
						lod_root.add_child(w)
		# optional shadow-casting headlight (one per car, first N cars)
		if spots_left > 0:
			spots_left -= 1
			var sl := SpotLight3D.new()
			sl.position = Vector3(2.3, 0.7, 0)
			sl.rotation_degrees.y = -90
			sl.spot_range = 60.0
			sl.spot_angle = 28.0
			sl.light_energy = 6.0
			sl.shadow_enabled = true
			car.add_child(sl)


func _set_range(g: GeometryInstance3D, lo: float, hi: float) -> void:
	g.visibility_range_begin = lo
	g.visibility_range_end = hi


# ======================================================================== camera + HUD
func _build_camera_and_hud() -> void:
	cam = Camera3D.new()
	cam.fov = 75.0
	cam.far = 600.0
	cam.current = true
	add_child(cam)
	var layer := CanvasLayer.new()
	add_child(layer)
	hud = Label.new()
	hud.position = Vector2(12, 8)
	hud.add_theme_font_size_override("font_size", 18)
	hud.add_theme_color_override("font_color", Color(0.4, 1, 0.5))
	hud.add_theme_color_override("font_outline_color", Color.BLACK)
	hud.add_theme_constant_override("outline_size", 6)
	hud.visible = show_hud
	layer.add_child(hud)


func _process(_delta: float) -> void:
	var now := Time.get_ticks_usec()
	var dt := (now - last_ticks) / 1.0e6
	last_ticks = now
	elapsed += minf(dt, 0.1)   # a one-off shader-compile stall must not eat the warmup
	frame_no += 1

	# Camera on the ring, 1.4 m above the road, looking along the direction of travel.
	var s := elapsed * SPEED
	var th := s / RING_R
	var p := Vector3(RING_R * cos(th), 1.4, RING_R * sin(th))
	var fwd := Vector3(-sin(th), 0, cos(th))
	cam.position = p
	cam.look_at(p + fwd * 20.0 + Vector3(0, -0.4, 0), Vector3.UP)
	if cam_debug:   # fixed view 7 m behind the hero car (car 0 sits at ring angle 0)
		var a0 := -0.05
		cam.position = Vector3(RING_R * cos(a0) + 0.0, 2.0, RING_R * sin(a0))
		cam.look_at(Vector3(RING_R - 2.0, 0.8, 0), Vector3.UP)

	var rss := _rss_mb()
	var d_calls := Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME)
	var d_prims := Performance.get_monitor(Performance.RENDER_TOTAL_PRIMITIVES_IN_FRAME)
	var g := RenderingServer.viewport_get_measured_render_time_gpu(vp_rid)
	var c := RenderingServer.viewport_get_measured_render_time_cpu(vp_rid)

	if elapsed > warmup and frame_no > 120:
		frame_times.append(dt)
		gpu_ms.append(g)
		cpu_ms.append(c)
		draws.append(d_calls)
		prims.append(d_prims)
		rss_peak_mb = maxf(rss_peak_mb, rss)
		if not shot_done and shot_path != "" and elapsed > warmup + duration * 0.5:
			shot_done = true
			get_viewport().get_texture().get_image().save_png(shot_path)

	hud_timer += dt
	if hud_timer > 0.25:
		hud_timer = 0.0
		var vram := Performance.get_monitor(Performance.RENDER_VIDEO_MEM_USED) / 1048576.0
		hud.text = "FPS %d  (%.1f ms)   GPU %.1f ms  CPU %.1f ms\nDraws %d   Tris %.0fk\nVRAM %.0f MB   RAM %.0f MB\n%s | %s | scale %d%%" % [
			Engine.get_frames_per_second(), dt * 1000.0, g, c, d_calls, d_prims / 1000.0,
			vram, rss, RenderingServer.get_current_rendering_method(),
			RenderingServer.get_video_adapter_name(), int(scale_3d * 100)]

	if elapsed > warmup + duration:
		_finish()


func _rss_mb() -> float:
	var f := FileAccess.open("/proc/self/status", FileAccess.READ)
	if f == null:
		return 0.0
	# /proc files report length 0, so get_as_text() is empty: read line by line instead.
	while not f.eof_reached():
		var line := f.get_line()
		if line.begins_with("VmRSS:"):
			return float(line.get_slice(":", 1).strip_edges().split(" ")[0]) / 1024.0
	return 0.0


func _avg(a: PackedFloat64Array) -> float:
	if a.is_empty():
		return 0.0
	var t := 0.0
	for x in a:
		t += x
	return t / a.size()


func _pct(a: PackedFloat64Array, q: float) -> float:
	var s := a.duplicate()
	s.sort()
	return s[clampi(int(q * (s.size() - 1)), 0, s.size() - 1)]


func _count_over(a: PackedFloat64Array, limit: float) -> int:
	var n := 0
	for x in a:
		if x > limit:
			n += 1
	return n


func _finish() -> void:
	var avg_ft := _avg(frame_times)
	var res := {
		"renderer": RenderingServer.get_current_rendering_method(),
		"adapter": RenderingServer.get_video_adapter_name(),
		"viewport_px": get_viewport().get_visible_rect().size,
		"scale": scale_3d, "spots": spots, "lod0_forced": force_lod0, "post": post,
		"frames": frame_times.size(),
		"avg_fps": 1.0 / avg_ft,
		"p1_low_fps": 1.0 / _pct(frame_times, 0.99),   # 1% low = 99th percentile frame time
		"worst_ms": _pct(frame_times, 1.0) * 1000.0,
		"hitches_over_33ms": _count_over(frame_times, 0.033),
		"hitches_over_100ms": _count_over(frame_times, 0.1),
		"avg_ms": avg_ft * 1000.0,
		"gpu_ms_avg": _avg(gpu_ms), "gpu_ms_p99": _pct(gpu_ms, 0.99),
		"cpu_ms_avg": _avg(cpu_ms),
		"draws_avg": _avg(draws), "draws_max": _pct(draws, 1.0),
		"tris_avg": _avg(prims), "tris_max": _pct(prims, 1.0),
		"vram_mb": Performance.get_monitor(Performance.RENDER_VIDEO_MEM_USED) / 1048576.0,
		"rss_peak_mb": rss_peak_mb,
		"build_s": build_time_s,
	}
	var txt := JSON.stringify(res, "  ")
	print(txt)
	if out_path != "":
		var f := FileAccess.open(out_path, FileAccess.WRITE)
		if f:
			f.store_string(txt)
		else:
			push_error("cannot write %s (use an absolute path)" % out_path)
	get_tree().quit()
