extends Node
## Visual side of crash damage. The CORE decides how far each zone is crushed (energy -> crush
## depth, see core/src/damage.cpp); this script SHOWS it:
##   - mesh deformation at the actual impact point (vertices pushed in along the crash direction by
##     the increase in crush depth, smooth falloff + small crumple wrinkles, normals recomputed),
##   - parts breaking off as physics debris (bumpers, mirrors), broken lights, engine smoke, sparks.

var vis: Dictionary            # visual config (set by CarFactory)
var car: RSVehicle
var model: Node3D
var deformables: Array[MeshInstance3D] = []
var unique := {}               # MeshInstance3D -> true once its mesh is a per-car copy
var applied := [0.0, 0.0, 0.0, 0.0]   # crush already shown per zone (m)
var detached := {}
var lights_off := {"front": false, "rear": false}
var smoke: GPUParticles3D
var sparks: GPUParticles3D
var last_impacts := 0
var _t := 0.0
var dent_queue := []           # [mesh_instance, point, dir, depth, radius]: one panel per frame
const ZONES := ["front", "rear", "left", "right"]
# Crush direction per zone in model space (X left, Y up, Z forward): the dent goes INTO the car.
const INWARD := [Vector3(0, 0, -1), Vector3(0, 0, 1), Vector3(-1, 0, 0), Vector3(1, 0, 0)]
const SKIP := ["wheel_", "caliper_", "interior_shell", "seat", "dashboard", "steering", "wheel_well"]


func _ready() -> void:
	car = get_parent()
	model = car.get_node("Model")
	for mi in model.find_children("*", "MeshInstance3D", true, false):
		var skip := false
		for p in SKIP:
			skip = skip or String(mi.name).begins_with(p)
		if not skip:
			deformables.append(mi)
	smoke = _make_smoke()
	model.add_child(smoke)
	smoke.position = Vector3(vis.engine_smoke_in_model_m[0], vis.engine_smoke_in_model_m[1], vis.engine_smoke_in_model_m[2])
	sparks = _make_sparks()
	model.add_child(sparks)


func _process(dt: float) -> void:
	if not dent_queue.is_empty():          # spread dent work over frames (no 30 ms hitch)
		var job: Array = dent_queue.pop_front()
		_dent_mesh(job[0], job[1], job[2], job[3], job[4])
	_t += dt
	if _t < 0.05:
		return
	_t = 0.0
	var tel: Dictionary = car.get_telemetry()
	if tel.is_empty():
		return
	var d: Dictionary = tel.damage
	var crush: Array = d.crush
	# ---- deformation: show the crush that the core added since last time, at the impact point
	var z: int = d.last_zone
	var delta: float = crush[z] - applied[z]
	if delta > 0.01:
		applied[z] = crush[z]
		var point_model: Vector3 = d.last_point - model.position     # car-local (CG) -> model space
		_dent(point_model, INWARD[z], delta, crush[z])
	# ---- break-offs (crush in metres)
	if crush[0] > 0.30: _detach("bumper_front")
	if crush[1] > 0.30: _detach("bumper_rear")
	if crush[2] > 0.12: _detach("mirror_L")
	if crush[3] > 0.12: _detach("mirror_R")
	# ---- lights
	if crush[0] > 0.12 and not lights_off.front:
		lights_off.front = true
		_kill_lights(vis.front_lights)
		for c in model.get_children():
			if c is SpotLight3D:
				c.visible = false
				c.name = "BrokenHeadlight"     # rival headlight manager won't turn it back on
	if crush[1] > 0.12 and not lights_off.rear:
		lights_off.rear = true
		_kill_lights(vis.rear_lights)
	# ---- smoke: grey when the engine is hurt, thick and black once the car is totaled
	var eng: float = d.engine
	smoke.emitting = eng > 0.25 or d.totaled
	if smoke.emitting:
		smoke.amount_ratio = 1.0 if d.totaled else clampf((eng - 0.25) / 0.6, 0.25, 1.0)
		var m := smoke.draw_pass_1.surface_get_material(0) as StandardMaterial3D
		m.albedo_color = Color(0.03, 0.03, 0.03) if d.totaled else Color(0.55, 0.55, 0.55).lerp(Color(0.12, 0.12, 0.12), eng)
	# ---- sparks on a new big hit
	if d.impacts > last_impacts:
		last_impacts = d.impacts
		if d.last_kj > 2.0:
			sparks.position = d.last_point - model.position
			sparks.restart()
			sparks.emitting = true


## Push vertices near `p` (model space) along `dir` by `depth` metres.
## Falloff w = (1 - (r/R)^2)^2 (smooth, zero slope at the edge); the dent radius grows with total
## crush (a deeper crash folds a wider area). A deterministic per-vertex jitter perpendicular to the
## push adds crumple wrinkles instead of a perfectly smooth dish. Work is queued per panel.
func _dent(p: Vector3, dir: Vector3, depth: float, total: float) -> void:
	var R := clampf(0.45 + 0.9 * total, 0.45, 1.2)
	var inv_model := model.global_transform.affine_inverse()
	for mi in deformables:
		if not is_instance_valid(mi) or detached.has(String(mi.name)):
			continue
		var aabb: AABB = (inv_model * mi.global_transform) * mi.mesh.get_aabb()
		if aabb.grow(R).has_point(p):
			dent_queue.append([mi, p, dir, depth, R])


func _dent_mesh(mi: MeshInstance3D, p: Vector3, dir: Vector3, depth: float, R: float) -> void:
	if not is_instance_valid(mi) or detached.has(String(mi.name)):
		return
	var xf: Transform3D = model.global_transform.affine_inverse() * mi.global_transform   # mesh-local -> model
	if not unique.has(mi):                                       # per-car copy before editing
		mi.mesh = mi.mesh.duplicate()
		unique[mi] = true
	var side := dir.cross(Vector3.UP).normalized()
	var xinv := xf.affine_inverse()
	var mesh := mi.mesh as ArrayMesh
	var new_mesh := ArrayMesh.new()
	var changed := false
	var overrides := []
	for s in mesh.get_surface_count():
		overrides.append(mi.get_surface_override_material(s))
		var arrays := mesh.surface_get_arrays(s)
		var verts: PackedVector3Array = arrays[Mesh.ARRAY_VERTEX]
		var moved := PackedInt32Array()
		for i in verts.size():
			var vm := xf * verts[i]
			var r := vm.distance_to(p)
			if r >= R:
				continue
			var w := 1.0 - (r / R) * (r / R)
			w *= w
			var h := sin(vm.x * 41.0 + vm.y * 17.0) * cos(vm.z * 29.0)          # wrinkle noise
			var disp := dir * depth * w + (side * h + Vector3.UP * h * 0.5) * depth * 0.25 * w
			verts[i] = xinv * (vm + disp)
			moved.append(i)
		if moved.size() > 0:
			changed = true
			arrays[Mesh.ARRAY_VERTEX] = verts
			arrays[Mesh.ARRAY_NORMAL] = _renormal(verts, arrays[Mesh.ARRAY_NORMAL], arrays[Mesh.ARRAY_INDEX], moved)
			# keep ARRAY_TANGENT: dropping it changes the vertex format -> a new GPU pipeline
			# compile per dented panel (measured ~15 ms each on this iGPU)
		new_mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
		new_mesh.surface_set_material(s, mesh.surface_get_material(s))
	if changed:
		mi.mesh = new_mesh
		for s in overrides.size():
			mi.set_surface_override_material(s, overrides[s])


## Recompute normals only for moved vertices: average of the face normals around them.
func _renormal(v: PackedVector3Array, n: PackedVector3Array, idx: PackedInt32Array, moved: PackedInt32Array) -> PackedVector3Array:
	var is_moved := {}
	for i in moved:
		is_moved[i] = true
		n[i] = Vector3.ZERO
	for t in range(0, idx.size(), 3):
		var a := idx[t]
		var b := idx[t + 1]
		var c := idx[t + 2]
		if not (is_moved.has(a) or is_moved.has(b) or is_moved.has(c)):
			continue
		# Godot front faces are clockwise -> (c - a) x (b - a) points outward
		var fn := (v[c] - v[a]).cross(v[b] - v[a])
		for k in [a, b, c]:
			if is_moved.has(k):
				n[k] += fn
	for i in moved:
		n[i] = n[i].normalized() if n[i].length_squared() > 0.0 else Vector3.UP
	return n


func _detach(nm: String) -> void:
	if detached.has(nm):
		return
	var n := model.find_child(nm, true, false) as Node3D
	if not n:
		return
	detached[nm] = true
	var xf := n.global_transform
	var body := RigidBody3D.new()
	body.mass = 6.0
	var mi := n as MeshInstance3D
	var cs := CollisionShape3D.new()
	var shape := BoxShape3D.new()
	shape.size = mi.mesh.get_aabb().size.max(Vector3(0.05, 0.05, 0.05)) if mi else Vector3(0.3, 0.2, 0.2)
	cs.shape = shape
	cs.position = mi.mesh.get_aabb().get_center() if mi else Vector3.ZERO
	n.get_parent().remove_child(n)
	body.add_child(n)
	body.add_child(cs)
	n.transform = Transform3D.IDENTITY
	car.get_tree().current_scene.add_child(body)
	body.global_transform = xf
	body.linear_velocity = car.linear_velocity * 0.8 + Vector3(randf_range(-1, 1), 1.5, randf_range(-1, 1))
	body.angular_velocity = Vector3(randf_range(-4, 4), randf_range(-4, 4), randf_range(-4, 4))
	car.get_tree().create_timer(30.0).timeout.connect(body.queue_free)


func _kill_lights(names: Array) -> void:
	var dark := StandardMaterial3D.new()
	dark.albedo_color = Color(0.05, 0.05, 0.05)
	dark.roughness = 0.2
	for nm in names:
		var n := model.find_child(nm, true, false) as MeshInstance3D
		if n:
			n.material_override = dark


func _soft_dot() -> ImageTexture:
	var img := Image.create(32, 32, false, Image.FORMAT_RGBA8)
	for y in 32:
		for x in 32:
			var r := Vector2(x - 15.5, y - 15.5).length() / 16.0
			img.set_pixel(x, y, Color(1, 1, 1, clampf(1.0 - r, 0, 1) ** 2))
	return ImageTexture.create_from_image(img)


func _make_smoke() -> GPUParticles3D:
	var p := GPUParticles3D.new()
	p.amount = 32
	p.lifetime = 2.5
	p.emitting = false
	var pm := ParticleProcessMaterial.new()
	pm.direction = Vector3(0, 1, 0)
	pm.spread = 25.0
	pm.initial_velocity_min = 0.6
	pm.initial_velocity_max = 1.4
	pm.gravity = Vector3(0, 0.6, 0)                # hot smoke rises
	pm.scale_min = 0.6
	pm.scale_max = 1.2
	var curve := Curve.new()
	curve.add_point(Vector2(0, 0.3))
	curve.add_point(Vector2(1, 2.5))
	var ct := CurveTexture.new()
	ct.curve = curve
	pm.scale_curve = ct
	var grad := Gradient.new()
	grad.set_color(0, Color(1, 1, 1, 0.6))
	grad.set_color(1, Color(1, 1, 1, 0.0))
	var gt := GradientTexture1D.new()
	gt.gradient = grad
	pm.color_ramp = gt
	p.process_material = pm
	var q := QuadMesh.new()
	q.size = Vector2(0.8, 0.8)
	var m := StandardMaterial3D.new()
	m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	m.billboard_mode = BaseMaterial3D.BILLBOARD_PARTICLES
	m.vertex_color_use_as_albedo = true
	m.albedo_texture = _soft_dot()
	m.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	q.material = m
	p.draw_pass_1 = q
	p.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	return p


func _make_sparks() -> GPUParticles3D:
	var p := GPUParticles3D.new()
	p.amount = 40
	p.lifetime = 0.6
	p.one_shot = true
	p.explosiveness = 0.95
	p.emitting = false
	var pm := ParticleProcessMaterial.new()
	pm.direction = Vector3(0, 1, 0)
	pm.spread = 80.0
	pm.initial_velocity_min = 3.0
	pm.initial_velocity_max = 8.0
	pm.gravity = Vector3(0, -9.8, 0)
	p.process_material = pm
	var q := QuadMesh.new()
	q.size = Vector2(0.04, 0.04)
	var m := StandardMaterial3D.new()
	m.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	m.billboard_mode = BaseMaterial3D.BILLBOARD_PARTICLES
	m.albedo_color = Color(1.0, 0.7, 0.3)
	m.emission_enabled = true
	m.emission = Color(1.0, 0.6, 0.2)
	m.emission_energy_multiplier = 8.0
	q.material = m
	p.draw_pass_1 = q
	return p
