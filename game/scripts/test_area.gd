extends Node3D
## Phase 2 flat test area: asphalt pad, grass patch, kerb strip, ramp, walls, one drivable car.
## Keys: see player_input.gd (driving, assists 1-7) and debug_overlay.gd (F1/F2), V = camera.
## Automated check (no keyboard needed):
##   godot --path game res://scenes/test_area.tscn -- --autotest=/abs/path/out.json

var car: RSVehicle
var cam: Camera3D
var overlay   # debug_overlay.gd instance
var cam_mode := 0
var _t := 0.0
var autotest_out := ""
var at := {}              # autotest state/results
var shot_path := ""
var crash_kmh := 0.0          # --crash_demo=KMH: drive into the end of a wall, photograph the damage


func _ready() -> void:
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--autotest="):
			autotest_out = a.get_slice("=", 1)
		if a.begins_with("--shot="):
			shot_path = a.get_slice("=", 1)
		if a.begins_with("--crash_demo="):
			crash_kmh = float(a.get_slice("=", 1))
	_build_world()
	car = CarFactory.spawn("cars/vela_gt.visual.json")
	car.position = Vector3(0, 0.49, 0)            # CG height + 2 cm drop
	if crash_kmh > 0.0:
		car.position = Vector3(40.0, 0.49, -40.0)  # facing +Z toward the end face of Wall0 (z = 20)
		autotest_out = "crash"
	add_child(car)
	if autotest_out == "":
		var drv := preload("res://scripts/player_input.gd").new()
		drv.car_path = NodePath("../" + car.name)   # input node is a sibling of the car
		add_child(drv)
	else:
		car.input_device = 2                        # "wheel": raw values pass 1:1 (no shaping)
		car.gear = 1
	cam = Camera3D.new()
	cam.fov = 65.0
	cam.far = 1500.0
	add_child(cam)
	cam.current = true
	var layer := CanvasLayer.new()
	add_child(layer)
	overlay = preload("res://scripts/debug_overlay.gd").new()
	overlay.car_path = car.get_path()
	layer.add_child(overlay)
	overlay.show_vectors = autotest_out != ""     # arrows visible in the autotest screenshot


# ------------------------------------------------------------------ world
func _static_box(name_: String, size: Vector3, pos: Vector3, surface: String, mat: Material, rot := Vector3.ZERO) -> void:
	var body := StaticBody3D.new()
	body.name = name_
	body.set_meta("surface", surface)            # read by RSVehicle's wheel raycasts
	body.position = pos
	body.rotation_degrees = rot
	var cs := CollisionShape3D.new()
	var shape := BoxShape3D.new()
	shape.size = size
	cs.shape = shape
	body.add_child(cs)
	var mi := MeshInstance3D.new()
	var bm := BoxMesh.new()
	bm.size = size
	mi.mesh = bm
	mi.material_override = mat
	body.add_child(mi)
	add_child(body)


func _mat(col: Color, rough := 0.8, tex: Texture2D = null, uv := 1.0) -> StandardMaterial3D:
	var m := StandardMaterial3D.new()
	m.albedo_color = col
	m.roughness = rough
	if tex:
		m.albedo_texture = tex
		m.uv1_triplanar = true
		m.uv1_scale = Vector3(uv, uv, uv)
		m.texture_filter = BaseMaterial3D.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS_ANISOTROPIC
	return m


func _build_world() -> void:
	var env := Environment.new()
	var sky := Sky.new()
	sky.sky_material = ProceduralSkyMaterial.new()
	env.background_mode = Environment.BG_SKY
	env.sky = sky
	env.ambient_light_source = Environment.AMBIENT_SOURCE_SKY
	env.tonemap_mode = Environment.TONE_MAPPER_AGX
	var we := WorldEnvironment.new()
	we.environment = env
	add_child(we)
	var sun := DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-50, 35, 0)
	sun.shadow_enabled = true
	sun.directional_shadow_max_distance = 80.0
	add_child(sun)
	var asphalt_tex: Texture2D = load("res://assets/textures/asphalt_albedo.png")
	# 600 m asphalt pad (top surface at y = 0)
	_static_box("Asphalt", Vector3(600, 2, 600), Vector3(0, -1, 0), "asphalt", _mat(Color(1.6, 1.6, 1.6), 0.7, asphalt_tex, 0.25))
	# grass patch (2 cm high) to the right of the start, 60 x 120 m
	_static_box("Grass", Vector3(60, 0.04, 120), Vector3(-60, 0.0, 80), "grass", _mat(Color(0.18, 0.35, 0.12), 0.95))
	# kerb strip: 1.2 m wide, 4 cm high, 80 m long
	_static_box("Kerb", Vector3(1.2, 0.08, 80), Vector3(-14, 0.0, 60), "kerb", _mat(Color(0.75, 0.1, 0.08), 0.6))
	# ramp: 8 degrees, 12 m wide, 30 m long, behind the start
	_static_box("Ramp", Vector3(12, 1, 30), Vector3(30, 1.0, -60), "asphalt", _mat(Color(0.35, 0.35, 0.37), 0.7), Vector3(8, 0, 0))
	# concrete walls along one side
	for i in 6:
		_static_box("Wall%d" % i, Vector3(1, 1.2, 20), Vector3(40, 0.6, 30 + i * 21), "wall", _mat(Color(0.6, 0.6, 0.58), 0.9))


# ------------------------------------------------------------------ camera + HUD
func _unhandled_input(e: InputEvent) -> void:
	if e is InputEventKey and e.pressed and not e.echo:
		if e.keycode == KEY_V: cam_mode = (cam_mode + 1) % 2
		if e.keycode == KEY_ESCAPE: get_tree().quit()


func _process(dt: float) -> void:
	_t += dt
	var t := car.global_transform
	var fwd := t.basis.z
	if cam_mode == 2:              # crash demo: close front three-quarter view, daylight
		cam.global_position = t.origin + t.basis * Vector3(2.6, 1.0, 3.2)
		cam.look_at(t.origin + t.basis * Vector3(0, 0.1, 1.4), Vector3.UP)
		cam.fov = 50.0
	elif cam_mode == 0:
		var want := t.origin - Vector3(fwd.x, 0, fwd.z).normalized() * 6.5 + Vector3.UP * 2.2
		cam.global_position = cam.global_position.lerp(want, 1.0 - exp(-dt * 6.0)) if _t > 0.1 else want
		cam.look_at(t.origin + fwd * 2.5 + Vector3.UP * 0.6, Vector3.UP)
	else:
		var a := _t * 0.3
		cam.global_position = t.origin + Vector3(sin(a) * 6.0, 1.4, cos(a) * 6.0)
		cam.look_at(t.origin, Vector3.UP)


# ------------------------------------------------------------------ crash demo
func _crash_demo(dt: float) -> void:
	at.t = at.get("t", 0.0) + dt
	cam_mode = 2
	car.gear = 2 if car.get_speed_kmh() < 40 else 3
	if not at.has("hit"):
		car.raw_throttle = 1.0 if car.get_speed_kmh() < crash_kmh else 0.0
		if car.get_telemetry().damage.impacts > 0:
			at.hit = at.t
			at.speed_at_hit = at.get("prev_speed", 0.0)
		at.prev_speed = car.get_speed_kmh()
		return
	if at.t < at.hit + 0.3:
		at.min_speed = minf(at.get("min_speed", 999.0), car.get_speed_kmh())
	car.raw_throttle = 0.0
	car.raw_brake = 1.0
	if at.t > at.hit + 3.0 and not at.has("done"):
		at.done = true
		var d: Dictionary = car.get_telemetry().damage
		var v0: float = at.speed_at_hit / 3.6
		var v1: float = at.get("min_speed", 0.0) / 3.6
		var ke := 0.5 * 1450.0 * (v0 * v0 - v1 * v1) / 1000.0
		print("CRASH %.0f km/h -> %.0f km/h: kinetic energy lost %.1f kJ, damage model counted %.1f kJ (x%.2f); crush %s engine %.2f totaled %s" % [
			at.speed_at_hit, at.get("min_speed", 0.0), ke, d.total_kj, d.total_kj / maxf(ke, 0.01), d.crush, d.engine, d.totaled])
		get_viewport().get_texture().get_image().save_png(shot_path)
		get_tree().quit()


# ------------------------------------------------------------------ automated check
# Open-loop sequence, no keyboard: settle -> launch + shifts -> brake from 100 -> steady circle.
func _physics_process(dt: float) -> void:
	if crash_kmh > 0.0:
		_crash_demo(dt)
		return
	if autotest_out == "":
		return
	at.t = at.get("t", 0.0) + dt
	var phase: String = at.get("phase", "settle")
	var v := car.get_speed_kmh()
	match phase:
		"settle":
			car.raw_brake = 0.3
			if at.t > 2.0:
				var total := 0.0
				var w: Array = car.get_telemetry().wheels
				for i in 4: total += w[i].load
				at.static_cg_height = car.global_position.y
				at.static_load_sum_kn = total / 1000.0
				at.static_front_frac = (w[0].load + w[1].load) / total
				at.phase = "launch"; at.t0 = at.t; car.raw_brake = 0.0; car.gear = 2
		"launch":
			# throttle limited by rear slip (same idea as the core test driver)
			var tw: Array = car.get_telemetry().wheels
			var slip := maxf(tw[2].slip_ratio, tw[3].slip_ratio)
			car.raw_throttle = clampf(1.0 - (slip - 0.10) * 8.0, 0.0, 1.0)
			if car.get_engine_rpm() > 7100 and car.gear < 7:
				car.gear = car.gear + 1
			if v >= 100.0 and not at.has("t_0_100"):
				at.t_0_100 = at.t - at.t0
			if v >= 108.0:
				at.phase = "brake"; car.raw_throttle = 0.0; at.t0 = at.t; at.brake_start = Vector3.ZERO
		"brake":
			car.raw_brake = 0.78 * minf(1.0, (at.t - at.t0) / 0.2)
			if v <= 100.0 and at.brake_start == Vector3.ZERO:
				at.brake_start = car.global_position
				at.brake_ramp_done = at.t - at.t0 > 0.2
			if v < 1.0 and at.brake_start != Vector3.ZERO:
				at.brake_100_0_m = (car.global_position - at.brake_start).length()
				at.phase = "relaunch"; at.t0 = at.t; car.raw_brake = 0.0; car.gear = 2; car.set_assist("tc", true)
		"relaunch":
			car.raw_throttle = 1.0                     # floored: TC must manage the wheelspin
			if car.get_engine_rpm() > 7100 and car.gear < 7:
				car.gear = car.gear + 1
			if v >= 108.0:
				at.phase = "abs_brake"; car.raw_throttle = 0.0; at.t0 = at.t; at.brake_start = Vector3.ZERO
				car.set_assist("abs", true)
		"abs_brake":
			car.raw_brake = minf(1.0, (at.t - at.t0) / 0.2)   # full pedal: ABS must manage it
			if v <= 100.0 and at.brake_start == Vector3.ZERO:
				at.brake_start = car.global_position
			if v < 1.0 and at.brake_start != Vector3.ZERO:
				at.abs_brake_100_0_m = (car.global_position - at.brake_start).length()
				at.phase = "circle"; at.t0 = at.t; car.raw_brake = 0.0; car.gear = 3
		"circle":
			car.raw_steer = 0.12
			if shot_path != "" and at.t - at.t0 > 8.0 and not at.has("shot"):
				at.shot = true
				get_viewport().get_texture().get_image().save_png(shot_path)
			cam_mode = 1 if shot_path != "" and at.t - at.t0 > 5.0 else cam_mode
			var err := 60.0 - v
			car.raw_throttle = clampf(0.08 * err + 0.25, 0.0, 1.0)
			if at.t - at.t0 > 14.0:
				var up := car.global_transform.basis.y
				at.circle_speed_kmh = v
				at.circle_upright = up.y
				at.circle_lat_g = car.linear_velocity.length_squared() * absf(car.angular_velocity.y) / maxf(car.linear_velocity.length(), 0.1) / 9.81
				at.phase = "done"
		"done":
			at.erase("t0"); at.erase("brake_start")
			var f := FileAccess.open(autotest_out, FileAccess.WRITE)
			f.store_string(JSON.stringify(at, "  "))
			print(JSON.stringify(at, "  "))
			get_tree().quit()
	if at.get("t", 0.0) > 90.0:
		at.phase = "done"; at.timeout = true
