extends Camera3D
## Cameras for a target car: 0 chase, 1 bumper, 2 street cam, 3 cinematic orbit. C cycles.

var target: RSVehicle
var route: RSRoute
var mode := 0
const NAMES := ["chase", "bumper", "street", "orbit"]
var _t := 0.0
var _street_slot := -1.0
var orbit_radius := 6.0
var orbit_height := 1.2
var orbit_speed := 0.25


## True if nothing static blocks the view from `from` to the car.
func _sees(from: Vector3, to: Vector3) -> bool:
	var q := PhysicsRayQueryParameters3D.create(from, to + Vector3.UP * 0.8)
	q.exclude = [target.get_rid()]
	var hit := get_world_3d().direct_space_state.intersect_ray(q)
	return hit.is_empty() or hit.collider is RSVehicle


func _unhandled_input(e: InputEvent) -> void:
	if e is InputEventKey and e.pressed and not e.echo and e.keycode == KEY_C:
		mode = (mode + 1) % NAMES.size()


func _process(dt: float) -> void:
	if not target:
		return
	_t += dt
	var t := target.global_transform
	var fwd := t.basis.z
	var v := target.linear_velocity.length()
	match mode:
		0:   # chase: smoothed follow behind, a little higher at speed, speed-based FOV
			var flat := Vector3(fwd.x, 0, fwd.z).normalized()
			var want := t.origin - flat * 6.4 + Vector3.UP * 2.1
			var k := 1.0 - exp(-dt * 7.0)
			global_position = global_position.lerp(want, k) if _t > 0.2 else want
			look_at(t.origin + fwd * 3.0 + Vector3.UP * 0.8, Vector3.UP)
			fov = lerpf(fov, 62.0 + v * 0.15, k)
		1:   # bumper
			global_transform = Transform3D(t.basis, t.origin + t.basis * Vector3(0, 0.3, 2.3))
			rotate_object_local(Vector3.UP, PI)
			fov = 75.0
		2:   # street cam: hung 4.5 m above the middle of the street ahead of the car, looking back at
			# it. Re-placed when the car passes it or a building blocks the view (line-of-sight ray).
			if route:
				var s: float = route.project(t.origin).s
				if _street_slot < 0.0 or s > _street_slot - 3.0 or (Engine.get_process_frames() % 15 == 0 and not _sees(global_position, t.origin)):
					_street_slot = -1.0
					for ahead in [60.0, 40.0, 25.0, 12.0]:
						var p: Vector3 = route.sample(s + ahead).position + Vector3.UP * 4.5
						if _sees(p, t.origin) or ahead == 12.0:
							_street_slot = s + ahead
							break
				global_position = route.sample(_street_slot).position + Vector3.UP * 4.5
				look_at(t.origin + Vector3.UP * 0.6, Vector3.UP)
				fov = clampf(1100.0 / maxf(global_position.distance_to(t.origin), 1.0), 15.0, 60.0)
		3:   # slow orbit
			var a := _t * orbit_speed
			global_position = t.origin + Vector3(sin(a) * orbit_radius, orbit_height, cos(a) * orbit_radius)
			look_at(t.origin + Vector3.UP * 0.5, Vector3.UP)
			fov = 45.0
