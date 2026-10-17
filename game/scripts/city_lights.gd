class_name CityLights
## Night-lighting runtime set-up for the baked city (rendering only, no game logic):
##  1. lamp grid texture for the wet-road shader's analytic lamp reflections
##  2. baked lamps/neon kept as CAR-ONLY lights near the camera (cull mask = car layer)

const CAR_LAYER := 2
const CELL := 14.0


## Packs every street lamp into a coarse 2D grid (one lamp per cell; RGB = position, A = 1) and
## hands it to the road material. Returns the number of lamps placed.
static func setup_lamp_grid(world: Node) -> int:
	var lamps := world.find_children("lamp_light_*", "SpotLight3D", true, false)
	if lamps.is_empty():
		return 0
	var lo := Vector2(1e9, 1e9)
	var hi := Vector2(-1e9, -1e9)
	for l in lamps:
		var p: Vector3 = (l as Node3D).global_position
		lo = lo.min(Vector2(p.x, p.z))
		hi = hi.max(Vector2(p.x, p.z))
	lo -= Vector2(CELL, CELL)
	var size := Vector2i(int((hi.x - lo.x) / CELL) + 3, int((hi.y - lo.y) / CELL) + 3)
	var img := Image.create(size.x, size.y, false, Image.FORMAT_RGBAF)
	img.fill(Color(0, 0, 0, 0))
	var placed := 0
	for l in lamps:
		var p: Vector3 = (l as Node3D).global_position
		var c := Vector2i(int((p.x - lo.x) / CELL), int((p.z - lo.y) / CELL))
		# cell taken (two lamps very close): use the nearest free neighbour
		for off in [Vector2i.ZERO, Vector2i(1, 0), Vector2i(-1, 0), Vector2i(0, 1), Vector2i(0, -1)]:
			var cc: Vector2i = c + off
			if cc.x >= 0 and cc.y >= 0 and cc.x < size.x and cc.y < size.y and img.get_pixelv(cc).a < 0.5:
				img.set_pixelv(cc, Color(p.x, p.y, p.z, 1.0))
				placed += 1
				break
	var tex := ImageTexture.create_from_image(img)
	for mi in world.find_children("road_*", "MeshInstance3D", true, false):
		var m := (mi as MeshInstance3D).mesh.surface_get_material(0) as ShaderMaterial
		if m:
			m.set_shader_parameter("lamp_grid", tex)
			m.set_shader_parameter("grid_origin", lo)
			m.set_shader_parameter("grid_cell", CELL)
			m.set_shader_parameter("grid_size", size)
			break     # all road tiles share one material
	return placed


## Baked lights stay in the scene but only light the cars, and only near the camera.
static func make_car_only(world: Node) -> Array[Light3D]:
	var out: Array[Light3D] = []
	for l in world.find_children("*", "Light3D", true, false):
		var light := l as Light3D
		if light.light_bake_mode == Light3D.BAKE_STATIC:
			light.light_cull_mask = 1 << (CAR_LAYER - 1)
			light.shadow_enabled = false
			light.visible = false
			out.append(light)
	return out


static func update_near(lights: Array[Light3D], cam_pos: Vector3, radius := 60.0) -> void:
	for l in lights:
		l.visible = l.global_position.distance_squared_to(cam_pos) < radius * radius


## Put every mesh of a car on the car render layer (probes skip it, car-only lights hit it).
static func set_car_layer(n: Node) -> void:
	if n is VisualInstance3D:
		(n as VisualInstance3D).layers = 1 << (CAR_LAYER - 1)
	for c in n.get_children():
		set_car_layer(c)
