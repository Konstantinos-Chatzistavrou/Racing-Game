extends Node3D
## Visual showcase ("attract mode"): cars lap the baked night street circuit.
## NOTE: there is no vehicle physics yet (Phase 1-2). Cars follow the track centreline with a
## curvature-based speed profile purely to show the graphics. This script is throwaway game-layer
## code; Phase 2 replaces the driving with the C++ physics core.
##
## Keys: C = cycle camera, H = toggle HUD, F = fullscreen, Esc = quit.
## Args (after --): --bench=60 --out=abs.json --shot=abs.png --scale=0.75 --cars=6
##                  --nohead (no opponent headlights) --keep_static_lights

const TRACK_JSON := "../data/tracks/harbour_loop.json"
const CAR_SCENE := "res://assets/cars/car_gt.glb"
const CAR_LAYER := 2
const WHEEL_R := 0.327
const WHEELBASE := 2.65
const PAINTS := [Color(0.55, 0.03, 0.02), Color(0.02, 0.1, 0.35), Color(0.75, 0.75, 0.78),
	Color(0.02, 0.02, 0.022), Color(0.85, 0.45, 0.02), Color(0.05, 0.25, 0.12), Color(0.35, 0.33, 0.3)]

# --- track (Godot space)
var pts: PackedVector3Array = []       # centreline points
var tans: PackedVector3Array = []      # unit tangents
var lefts: PackedVector3Array = []     # unit left normals (horizontal)
var curv: PackedFloat32Array = []      # signed curvature (+ = left)
var vprof: PackedFloat32Array = []     # target speed per sample (m/s)
var spacing := 2.0
var length := 0.0

var cars: Array[Dictionary] = []
var cam: Camera3D
var cam_mode := 0
var cam_names := ["chase", "bumper", "tv", "orbit"]
var hud: CanvasLayer
var bench := 0.0
var n_cars := 6
var opp_headlights := true
var keep_static := false
var toggles := {}              # profiling switches: --noprobes --noglow --nofog --nodecal --bilinear --nomoonshadow
var _time := 0.0


func _ready() -> void:
	var scale := 0.75
	var out := ""
	var shot := ""
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--bench="): bench = float(a.get_slice("=", 1))
		elif a.begins_with("--out="): out = a.get_slice("=", 1)
		elif a.begins_with("--shot="): shot = a.get_slice("=", 1)
		elif a.begins_with("--scale="): scale = float(a.get_slice("=", 1))
		elif a.begins_with("--cars="): n_cars = int(a.get_slice("=", 1))
		elif a.begins_with("--cam="): cam_mode = int(a.get_slice("=", 1))
		elif a == "--nohead": opp_headlights = false
		elif a == "--keep_static_lights": keep_static = true
		elif a.begins_with("--no") or a == "--bilinear": toggles[a.substr(2)] = true
	var vp := get_viewport()
	vp.scaling_3d_mode = Viewport.SCALING_3D_MODE_BILINEAR if toggles.has("bilinear") else Viewport.SCALING_3D_MODE_FSR
	vp.fsr_sharpness = 0.25
	vp.scaling_3d_scale = scale

	_load_track()
	var world: Node3D = load("res://scenes/harbour_night.tscn").instantiate()
	add_child(world)
	_setup_road_reflections(world)
	if not keep_static:
		_hide_baked_lights(world)
	_apply_toggles(world)
	_build_speed_profile()
	for i in n_cars:
		_spawn_car(i)
	cam = Camera3D.new()
	cam.fov = 62.0
	cam.near = 0.1
	cam.far = 900.0
	add_child(cam)
	cam.current = true
	hud = preload("res://scripts/perf_hud.gd").new()
	hud.bench_duration = bench
	hud.out_path = out
	hud.shot_path = shot
	add_child(hud)


## Feed the street-lamp positions to the wet-road shader (analytic lamp reflections).
## Lamp N is placed at track distance N * 36 m, which is the index the shader looks up.
func _setup_road_reflections(world: Node) -> void:
	var lamps := world.find_children("lamp_light_*", "SpotLight3D", true, false)
	lamps.sort_custom(func(a, b): return String(a.name) < String(b.name))
	var pos := PackedVector3Array()
	for l in lamps:
		pos.append((l as Node3D).global_position)
	var road := world.find_child("road_c00", true, false) as MeshInstance3D
	var mat := road.mesh.surface_get_material(0) as ShaderMaterial
	mat.set_shader_parameter("lamp_pos", pos)
	mat.set_shader_parameter("lamp_count", pos.size())
	mat.set_shader_parameter("track_length", length if length > 0 else 1526.0)


func _apply_toggles(world: Node) -> void:
	var we := world.find_child("WorldEnvironment", true, false) as WorldEnvironment
	if toggles.has("noglow"): we.environment.glow_enabled = false
	if toggles.has("nofog"): we.environment.fog_enabled = false
	if toggles.has("noprobes"):
		for p in world.find_children("*", "ReflectionProbe", true, false): p.queue_free()
	if toggles.has("nomoonshadow"):
		(world.find_child("Moon", true, false) as DirectionalLight3D).shadow_enabled = false


## Lamps/neon are fully baked into the lightmap (direct + bounce) for the static world. At runtime
## they are kept ONLY for the cars: cull mask = car layer, no shadows, and only the ones near the
## camera are switched on. Cars are small on screen, so this costs little and gives them real
## lamp highlights and colour spill as they drive under lamps and past neon signs.
var car_lights: Array[Light3D] = []

func _hide_baked_lights(n: Node) -> void:
	if n is Light3D and n.light_bake_mode == Light3D.BAKE_STATIC:
		var l := n as Light3D
		l.light_cull_mask = 1 << (CAR_LAYER - 1)
		l.shadow_enabled = false
		l.visible = false
		car_lights.append(l)
	for c in n.get_children():
		_hide_baked_lights(c)


func _update_car_lights() -> void:
	var cp := cam.global_position
	for l in car_lights:
		l.visible = l.global_position.distance_to(cp) < 70.0


# ================================================================== track + speed profile
func _load_track() -> void:
	var path := ProjectSettings.globalize_path("res://").path_join(TRACK_JSON)
	var data: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(path))
	spacing = data.sample_spacing_m
	for s in data.samples:
		# Track data is in core coordinates (Z-up); the wrapper owns the conversion.
		pts.append(RSVehicle.core_to_godot(Vector3(s.x, s.y, s.z)))
		var h: float = s.heading
		var t := RSVehicle.core_to_godot(Vector3(cos(h), sin(h), 0))
		tans.append(t)
		# left of travel in Godot space (Y-up): left = up x forward
		lefts.append(Vector3.UP.cross(t).normalized())
		curv.append(s.curvature)
	length = pts.size() * spacing


## Speed limit from cornering grip, then braking (backward pass) and power (forward pass) limits.
##   cornering:  v <= sqrt(a_lat / |k|)                (lateral accel = v^2 * k)
##   braking:    v_i <= sqrt(v_{i+1}^2 + 2 a_brake ds) (constant deceleration)
##   power:      a = min(a_grip, P / (m v))            (power-limited acceleration)
func _build_speed_profile() -> void:
	var n := pts.size()
	var a_lat := 11.0
	var a_brake := 10.0
	var p_over_m := 220.0     # W/kg (~330 kW, 1500 kg)
	var vmax := 72.0
	vprof.resize(n)
	for i in n:
		vprof[i] = minf(vmax, sqrt(a_lat / maxf(absf(curv[i]), 1e-4)))
	for _pass in 2:
		for k in range(n - 1, -1, -1):
			var nx := vprof[(k + 1) % n]
			vprof[k] = minf(vprof[k], sqrt(nx * nx + 2.0 * a_brake * spacing))
		for k in n:
			var pv := vprof[k - 1]
			var acc := minf(9.0, p_over_m / maxf(pv, 5.0))
			vprof[k] = minf(vprof[k], sqrt(pv * pv + 2.0 * acc * spacing))


func _sample(s: float) -> Dictionary:
	s = fposmod(s, length)
	var f := s / spacing
	var i := int(f)
	var t := f - i
	var j := (i + 1) % pts.size()
	return {
		"p": pts[i].lerp(pts[j], t), "t": tans[i].slerp(tans[j], t).normalized(),
		"l": lefts[i].lerp(lefts[j], t).normalized(), "k": lerpf(curv[i], curv[j], t),
		"v": lerpf(vprof[i], vprof[j], t),
	}


# ================================================================== cars
func _spawn_car(idx: int) -> void:
	var car: Node3D = load(CAR_SCENE).instantiate()
	add_child(car)
	var paint := StandardMaterial3D.new()
	var tail := StandardMaterial3D.new()
	var wheels := {}
	_setup_car_visuals(car, PAINTS[idx % PAINTS.size()], paint, tail, wheels)
	var hero := idx == 0
	if hero or opp_headlights:
		for side in ([-0.62, 0.62] if hero else [0.0]):
			var sl := SpotLight3D.new()
			sl.position = Vector3(side, 0.55, 2.42)   # just ahead of the bumper: inside it, the car shadows its own lamp
			sl.rotation_degrees = Vector3(-4, 180, 0)      # SpotLight shines down -Z; car front is +Z
			sl.spot_range = 70.0 if hero else 45.0
			sl.spot_angle = 24.0 if hero else 30.0
			sl.spot_attenuation = 0.8
			sl.light_energy = 10.0 if hero else 7.0
			sl.light_color = Color(0.92, 0.95, 1.0)
			sl.shadow_enabled = hero and not toggles.has("noheadshadow")   # shadow budget: hero's two lamps only
			sl.shadow_bias = 0.05
			sl.light_cull_mask = 0xFFFFF
			car.add_child(sl)
	var deca := Decal.new()                                 # soft contact shadow under the car
	deca.size = Vector3(2.3, 1.6, 5.0)
	deca.position = Vector3(0, 0.4, 0)
	deca.texture_albedo = _blob_texture()
	deca.modulate = Color(0, 0, 0, 0.85)
	deca.upper_fade = 0.3
	deca.lower_fade = 0.3
	deca.cull_mask = 1
	if not toggles.has("nodecal"):
		car.add_child(deca)
	cars.append({
		"node": car, "s": float(-idx * 26.0), "v": 0.0, "lane": [0.0, -2.6, 2.4, -1.0, 1.2, -3.2, 3.0][idx % 7],
		"skill": [1.0, 0.97, 0.96, 0.95, 0.94, 0.93, 0.92][idx % 7], "spin": 0.0, "steer": 0.0,
		"tail": tail, "wheels": wheels, "roll": 0.0, "pitch": 0.0,
	})
	cars[-1].v = _sample(cars[-1].s).v * 0.8


func _setup_car_visuals(n: Node, col: Color, paint: StandardMaterial3D, tail: StandardMaterial3D, wheels: Dictionary) -> void:
	if n is MeshInstance3D:
		var mi := n as MeshInstance3D
		mi.layers = 1 << (CAR_LAYER - 1)
		for i in mi.mesh.get_surface_count():
			var m := mi.mesh.surface_get_material(i) as StandardMaterial3D
			if m == null:
				continue
			if m.resource_name == "paint":
				if paint.resource_name == "":
					paint.resource_name = "paint"
					for prop in ["metallic", "roughness", "clearcoat_enabled", "clearcoat", "clearcoat_roughness"]:
						paint.set(prop, m.get(prop))
					paint.albedo_color = col
				mi.set_surface_override_material(i, paint)
			elif m.resource_name == "light_tail":
				if tail.resource_name == "":
					tail.resource_name = "tail"
					tail.albedo_color = m.albedo_color
					tail.emission_enabled = true
					tail.emission = m.emission
					tail.emission_energy_multiplier = m.emission_energy_multiplier
				mi.set_surface_override_material(i, tail)
	if n.name.begins_with("wheel_") and not n.name.begins_with("wheel_well"):
		wheels[String(n.name).substr(6)] = n
	for c in n.get_children():
		_setup_car_visuals(c, col, paint, tail, wheels)


var _blob: ImageTexture
func _blob_texture() -> ImageTexture:
	if _blob:
		return _blob
	var w := 64
	var h := 128
	var img := Image.create(w, h, false, Image.FORMAT_RGBA8)
	for y in h:
		for x in w:
			# rounded-rectangle distance, soft edge: darkest under the car, fading outward
			var dx := maxf(absf((x + 0.5) / w * 2.0 - 1.0) - 0.55, 0.0) / 0.45
			var dy := maxf(absf((y + 0.5) / h * 2.0 - 1.0) - 0.7, 0.0) / 0.3
			var a := clampf(1.0 - sqrt(dx * dx + dy * dy), 0.0, 1.0)
			img.set_pixel(x, y, Color(1, 1, 1, a * a))
	_blob = ImageTexture.create_from_image(img)
	return _blob


func _physics_process(dt: float) -> void:
	var space := get_world_3d().direct_space_state
	for c in cars:
		var smp := _sample(c.s)
		var target: float = smp.v * c.skill
		var dv: float = target - c.v
		var acc: float = clampf(dv / dt, -10.0, minf(9.0, 220.0 / maxf(c.v, 5.0)))
		c.v = maxf(c.v + acc * dt, 3.0)
		c.s += c.v * dt
		c.braking = acc < -3.0
		# racing-line-ish lateral: lane offset + move toward the inside of corners
		var lat: float = clampf(c.lane + clampf(smp.k * 260.0, -3.5, 3.5), -4.6, 4.6)
		c.lat = lerpf(c.get("lat", lat), lat, minf(1.0, dt * 1.5))
		var fwd: Vector3 = smp.t
		var base: Vector3 = smp.p + smp.l * c.lat
		# put the car on the road: three raycasts against the collision mesh -> ground plane
		var hits := []
		for off in [fwd * 1.3, fwd * -1.3 + smp.l * 0.8, fwd * -1.3 - smp.l * 0.8]:
			var q := PhysicsRayQueryParameters3D.create(base + off + Vector3.UP * 3.0, base + off + Vector3.DOWN * 4.0)
			var r := space.intersect_ray(q)
			hits.append(r.position if r else base + off)
		var up: Vector3 = (hits[2] - hits[0]).cross(hits[1] - hits[0]).normalized()
		if up.y < 0:
			up = -up
		var ground: Vector3 = (hits[0] + hits[1] + hits[2]) / 3.0
		fwd = (fwd - up * fwd.dot(up)).normalized()
		# visual body roll/pitch from accelerations (~0.4 deg per m/s^2 lateral, 0.25 longitudinal)
		var a_lat: float = c.v * c.v * smp.k
		c.roll = lerpf(c.roll, clampf(-a_lat * 0.007, -0.06, 0.06), minf(1.0, dt * 4.0))
		c.pitch = lerpf(c.pitch, clampf(-acc * 0.004, -0.04, 0.04), minf(1.0, dt * 4.0))
		var b := Basis.looking_at(-fwd, up)            # looking_at points -Z at target: car front is +Z
		b = b.rotated(fwd, c.roll).rotated(b.x, c.pitch)
		var car: Node3D = c.node
		car.global_transform = Transform3D(b, ground)
		# wheels: spin = distance / radius; front steer = Ackermann-free bicycle angle atan(L * k)
		c.spin = fmod(c.spin + c.v * dt / WHEEL_R, TAU)
		c.steer = lerpf(c.steer, atan(WHEELBASE * smp.k), minf(1.0, dt * 6.0))
		for key in c.wheels:
			var w: Node3D = c.wheels[key]
			var steer: float = c.steer if key.begins_with("F") else 0.0
			w.basis = Basis(Vector3.UP, steer) * Basis(Vector3.RIGHT, c.spin)
		(c.tail as StandardMaterial3D).emission_energy_multiplier = 28.0 if c.braking else 6.0


# ================================================================== cameras
func _unhandled_input(e: InputEvent) -> void:
	if e is InputEventKey and e.pressed and not e.echo:
		match e.keycode:
			KEY_C: cam_mode = (cam_mode + 1) % cam_names.size()
			KEY_H: hud.visible = not hud.visible
			KEY_F:
				var w := get_window()
				w.mode = Window.MODE_WINDOWED if w.mode == Window.MODE_FULLSCREEN else Window.MODE_FULLSCREEN
			KEY_ESCAPE: get_tree().quit()


func _process(dt: float) -> void:
	_time += dt
	if cars.is_empty():
		return
	if Engine.get_process_frames() % 10 == 0 and not toggles.has("nocarlights"):
		_update_car_lights()
	var hero: Node3D = cars[0].node
	var t := hero.global_transform
	var fwd := t.basis.z
	var v: float = cars[0].v
	hud.extra_info = "camera: %s (C)   hero %d km/h" % [cam_names[cam_mode], int(v * 3.6)]
	match cam_mode:
		0:   # chase: critically-damped follow, slight speed-based FOV
			var want := t.origin - fwd * 6.4 + Vector3.UP * 2.0
			var k := 1.0 - exp(-dt * 7.0)
			cam.global_position = cam.global_position.lerp(want, k) if _time > 0.2 else want
			cam.look_at(t.origin + fwd * 3.0 + Vector3.UP * 0.9, Vector3.UP)
			cam.fov = lerpf(cam.fov, 60.0 + v * 0.15, k)
		1:   # bumper cam
			cam.global_transform = Transform3D(t.basis, t.origin + t.basis * Vector3(0, 0.75, 2.35))
			cam.rotate_object_local(Vector3.UP, PI)
			cam.fov = 75.0
		2:   # trackside TV cameras every 120 m: on the pavement (10 m out, buildings start at 12.6 m),
			# 6 m up so they look over the 3.8 m catch fence; zoom with distance
			var s: float = fposmod(cars[0].s, length)
			var slot := floorf(s / 120.0) * 120.0 + 60.0
			var smp := _sample(slot)
			var pos: Vector3 = smp.p - smp.l * 10.0 * signf(smp.k + 1e-6) + Vector3.UP * 6.0
			cam.global_position = pos
			cam.look_at(t.origin + Vector3.UP * 0.6, Vector3.UP)
			cam.fov = clampf(900.0 / maxf(pos.distance_to(t.origin), 1.0), 8.0, 55.0)
		3:   # slow cinematic orbit, low angle
			var a := _time * 0.25
			var off := Vector3(sin(a) * 5.8, 1.1, cos(a) * 5.8)
			cam.global_position = t.origin + off
			cam.look_at(t.origin + Vector3.UP * 0.55, Vector3.UP)
			cam.fov = 45.0
