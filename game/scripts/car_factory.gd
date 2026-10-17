class_name CarFactory
## Builds a drivable car from data: physics JSON (core) + visual JSON (this file's concern).
## Adding a car = adding two JSON files and a model; no code changes.

const DATA_DIR := "../data/"


static func load_visual(rel_path: String) -> Dictionary:
	var path := ProjectSettings.globalize_path("res://").path_join(DATA_DIR + rel_path)
	var d = JSON.parse_string(FileAccess.get_file_as_string(path))
	assert(d is Dictionary and d.get("schema") == "car_visual/1", "bad visual config: " + path)
	return d


## Returns an RSVehicle (RigidBody3D, origin = centre of gravity) with model, collision, wheels,
## headlights and damage visuals. hero = shadow-casting headlights (shadow budget: hero only).
## physics_path: absolute path of a tuned physics JSON (garage) instead of the visual's default.
static func spawn(visual_rel_path: String, paint := Color(-1, 0, 0), hero := false, physics_path := "") -> RSVehicle:
	var vis := load_visual(visual_rel_path)
	var car := RSVehicle.new()
	car.name = vis.name.replace(" ", "")
	car.car_config_path = physics_path if physics_path != "" else DATA_DIR + vis.physics
	var cg := _vec(vis.cg_in_model_m)
	var model := add_models(car, vis, paint)
	var cs := CollisionShape3D.new()             # body hull; wheels are raycasts and never collide
	cs.shape = body_hull(vis.collision_box)
	cs.position = _vec(vis.collision_box.centre_in_model_m) - cg
	car.add_child(cs)
	var keys := ["fl", "fr", "rl", "rr"]
	for i in 4:
		var w := model.find_child(vis.wheel_nodes[keys[i]], true, false)
		if w:
			car.set_wheel_path(i, NodePath("Model/" + str(model.get_path_to(w))))
	# Headlights: hero gets both lamps with shadows; others one unshadowed lamp (light budget).
	var lamps: Array = vis.headlights if hero else [[0.0, vis.headlights[0][1], vis.headlights[0][2]]]
	for p in lamps:
		var sl := SpotLight3D.new()
		sl.name = "Headlight"
		sl.position = _vec(p)                         # model space (model is offset by -CG)
		sl.rotation_degrees = Vector3(-4, 180, 0)     # SpotLight shines down -Z; car front is +Z
		sl.spot_range = 120.0 if hero else 50.0
		sl.spot_angle = 28.0 if hero else 30.0
		sl.spot_attenuation = 0.8
		sl.light_energy = 18.0 if hero else 12.0
		sl.light_color = Color(0.92, 0.95, 1.0)
		sl.light_volumetric_fog_energy = 3.0 if hero else 1.5
		sl.shadow_enabled = hero
		sl.shadow_bias = 0.05
		model.add_child(sl)
	var dv := preload("res://scripts/damage_visuals.gd").new()
	dv.name = "DamageVisuals"
	dv.vis = vis
	car.add_child(dv)
	return car


## Full-detail model (separate parts: damage, spinning wheels) up close, merged ~6k-triangle LOD
## beyond lod_distance_m. Both are offset so the model's CG point sits on the parent's origin.
static func add_models(parent: Node3D, vis: Dictionary, paint := Color(-1, 0, 0)) -> Node3D:
	var cg := _vec(vis.cg_in_model_m)
	var model: Node3D = load(vis.model).instantiate()
	model.name = "Model"
	model.position = -cg
	parent.add_child(model)
	var d: float = vis.get("lod_distance_m", 0.0)
	if vis.has("lod_model") and d > 0.0:
		var lod: Node3D = load(vis.lod_model).instantiate()
		lod.name = "ModelLOD"
		lod.position = -cg
		parent.add_child(lod)
		_set_range(model, 0.0, d)
		_set_range(lod, d, 0.0)
		if paint.r >= 0.0:
			_repaint(lod, vis.paint_material, paint)
	if paint.r >= 0.0:
		_repaint(model, vis.paint_material, paint)
	return model


static func _set_range(n: Node, begin: float, end: float) -> void:
	if n is GeometryInstance3D:
		var g := n as GeometryInstance3D
		g.visibility_range_begin = begin
		g.visibility_range_end = end
		g.visibility_range_begin_margin = 2.0 if begin > 0.0 else 0.0
		g.visibility_range_end_margin = 2.0 if end > 0.0 else 0.0
	for c in n.get_children():
		_set_range(c, begin, end)


## Parked cars: no light emission (any material whose name starts with "light").
static func darken_lights(n: Node) -> void:
	if n is MeshInstance3D:
		var mi := n as MeshInstance3D
		for i in mi.mesh.get_surface_count():
			var m: Material = mi.mesh.surface_get_material(i)
			if m and m.resource_name.begins_with("light"):
				var dark := StandardMaterial3D.new()
				dark.albedo_color = Color(0.04, 0.04, 0.04)
				mi.set_surface_override_material(i, dark)
	for c in n.get_children():
		darken_lights(c)


## Convex body hull: a box whose underside rises toward both bumpers (approach/departure angle),
## so the nose rides over kerbs and slope changes the way a real bumper lip does.
static func body_hull(cb: Dictionary) -> ConvexPolygonShape3D:
	var s := _vec(cb.size_m) * 0.5
	var lift: float = cb.get("end_lift_m", 0.0)
	var z0: float = cb.get("end_lift_start_m", s.z)
	var pts := PackedVector3Array()
	for x in [-s.x, s.x]:
		for z in [-s.z, s.z]:
			pts.append(Vector3(x, s.y, z))                 # roof line
			pts.append(Vector3(x, -s.y + lift, z))         # bumper underside (lifted)
		for z in [-z0, z0]:
			pts.append(Vector3(x, -s.y, z))                # flat floor between the axles
	var shape := ConvexPolygonShape3D.new()
	shape.points = pts
	return shape


static func _vec(a: Array) -> Vector3:
	return Vector3(a[0], a[1], a[2])


static func _repaint(n: Node, mat_name: String, col: Color) -> void:
	if n is MeshInstance3D:
		for i in n.mesh.get_surface_count():
			var m: Material = n.mesh.surface_get_material(i)
			if m and m.resource_name == mat_name:
				var dup := m.duplicate() as StandardMaterial3D
				dup.albedo_color = col
				n.set_surface_override_material(i, dup)
	for c in n.get_children():
		_repaint(c, mat_name, col)
