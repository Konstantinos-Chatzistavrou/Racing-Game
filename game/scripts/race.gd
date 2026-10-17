extends Node3D
## Illegal street race through the night city: player + AI rivals on the route loop.
## Everything that decides anything (physics, AI, damage, race positions/laps) runs in the C++
## core; this script builds the scene, manages simulator menus, HUD, settings, and camera.

const ROUTE := "../data/tracks/city_route.json"
const CITY := "../data/tracks/city.json"
const PAINTS := [
	Color(0.55, 0.03, 0.02), Color(0.02, 0.1, 0.35), Color(0.75, 0.75, 0.78), Color(0.02, 0.02, 0.022),
	Color(0.85, 0.45, 0.02), Color(0.05, 0.25, 0.12), Color(0.35, 0.33, 0.3), Color(0.4, 0.05, 0.3)
]
const RIVALS_FILE := "../data/rivals.json"     # personalities + names, read by the core

var route: RSRoute
var race: RSRace
var cars: Array[RSVehicle] = []
var player: RSVehicle
var player_index := 3
var cam: Camera3D
var car_lights: Array[Light3D] = []

var state := "countdown"
var race_time := 0.0
var countdown := 3.5
var n_cars := 6
var laps := 3
var bench := 0.0
var autotest_out := ""
var shot_path := ""
var all_ai := false
var stats := {}
var names: Array[String] = []
var player_out := false
var spectate := -1
var input_node: Node
var grid_s := 75.0
var trace := false
var toggles := {}
var shot_t := 25.0
var crash_skill := 0.0
var rivals: Array = []
var difficulty := 1

# Simulator UI & Menu Systems
var sim_hud: CanvasLayer
var main_menu: CanvasLayer
var pause_menu: CanvasLayer
var results_screen: CanvasLayer
var debug_overlay: Control
var sm: Node
var menu_tab := 0
var show_pause := false
var show_results_test := false
var menu_start := false
var shot_frame := 25


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	var scale := 0.75
	var out := ""
	var cam_mode := 0

	for a in OS.get_cmdline_user_args():
		if a.begins_with("--bench="): bench = float(a.get_slice("=", 1))
		elif a.begins_with("--autotest="): autotest_out = a.get_slice("=", 1)
		elif a.begins_with("--out="): out = a.get_slice("=", 1)
		elif a.begins_with("--shot="): shot_path = a.get_slice("=", 1)
		elif a.begins_with("--scale="): scale = float(a.get_slice("=", 1))
		elif a.begins_with("--laps="): laps = int(a.get_slice("=", 1))
		elif a.begins_with("--cars="): n_cars = clampi(int(a.get_slice("=", 1)), 1, 8)
		elif a.begins_with("--cam="): cam_mode = int(a.get_slice("=", 1))
		elif a.begins_with("--grid_s="): grid_s = float(a.get_slice("=", 1))
		elif a == "--trace": trace = true
		elif a.begins_with("--shot_t="): shot_t = float(a.get_slice("=", 1))
		elif a.begins_with("--crash_skill="): crash_skill = float(a.get_slice("=", 1))
		elif a.begins_with("--menu_tab="): menu_tab = int(a.get_slice("=", 1))
		elif a == "--show_pause": show_pause = true
		elif a == "--show_results": show_results_test = true
		elif a.begins_with("--shot_frame="): shot_frame = int(a.get_slice("=", 1))
		elif a == "--menu_start": menu_start = true    # test hook: press START after the menu loads
		elif a.begins_with("--no"): toggles[a.substr(2)] = true

	all_ai = bench > 0 or autotest_out != ""
	player_index = mini(player_index, n_cars - 1)

	# Initialize settings
	sm = get_node_or_null("/root/SettingsManager")
	var vp := get_viewport()
	if sm:
		sm.apply_graphics(vp)
	else:
		vp.scaling_3d_mode = Viewport.SCALING_3D_MODE_BILINEAR
		vp.scaling_3d_scale = scale
		vp.fsr_sharpness = 0.25

	# World environment
	var world: Node3D = load("res://scenes/city_night.tscn").instantiate()
	add_child(world)
	if not toggles.has("nolampspec"):
		CityLights.setup_lamp_grid(world)
	car_lights = CityLights.make_car_only(world)
	if toggles.has("nocarlights"):
		car_lights.clear()

	# Route
	route = RSRoute.new()
	route.load(ROUTE)

	# Spawn parked traffic & race grid
	_spawn_parked_cars()
	_spawn_grid()

	# Setup race tracker
	race = RSRace.new()
	race.setup(route, laps)
	for c in cars:
		race.add_car(c)
		c.freeze = true

	# Camera rig
	cam = preload("res://scripts/camera_rig.gd").new()
	cam.target = player
	cam.route = route
	cam.mode = cam_mode
	cam.far = 900.0
	add_child(cam)
	cam.current = true

	# Decide startup state
	if all_ai:
		# Automated benchmark / autotest mode -> start race immediately
		state = "countdown"
		_build_hud()
		if bench > 0:
			var ph := preload("res://scripts/perf_hud.gd").new()
			ph.bench_duration = bench
			ph.out_path = out
			ph.shot_path = shot_path
			add_child(ph)
	else:
		# Player session -> start in Simulator Main Menu with orbit camera
		state = "menu"
		_build_main_menu()
		_enter_menu_view()
		main_menu.focus_nav()
		_build_hud()
		_build_pause_menu()
		_build_results_screen()
		if menu_tab > 0 and main_menu:
			main_menu.show_page(["race", "garage", "settings"][clampi(menu_tab, 0, 2)])
		if show_pause:
			state = "racing"
			main_menu.visible = false
			_pause_session()
		if show_results_test:
			main_menu.visible = false
			results_screen.show_results(race, cars, names, player)
			results_screen.visible = true


# ---------------------------------------------------------------- Spawning
func _spawn_grid() -> void:
	var car_id := "vela_gt"
	if sm:
		car_id = sm.settings.garage.car
	for k in n_cars:
		var s := grid_s - k * 9.0
		var smp: Dictionary = route.sample(s)
		var lateral := 2.4 if k % 2 == 0 else -2.4
		var is_player := k == player_index
		var car: RSVehicle
		if is_player and not all_ai and sm:
			# Garage car: tuned physics copy + paint/wheels/glass overrides.
			car = CarFactory.spawn(Garage.CARS[Garage.car_index(car_id)].visual, Color(-1, 0, 0), true,
				Garage.tuned_config(car_id, sm.car_tune(car_id)))
			Garage.apply_look(car, sm.car_look(car_id))
		else:
			car = CarFactory.spawn("cars/vela_gt.visual.json", PAINTS[k % PAINTS.size()], is_player)
		add_child(car)
		var fwd: Vector3 = smp.forward
		var pos: Vector3 = smp.position + smp.left * lateral + Vector3.UP * 0.55
		car.global_transform = Transform3D(Basis.looking_at(-fwd, Vector3.UP), pos)
		CityLights.set_car_layer(car)
		if toggles.has("noheadlights") and not is_player:
			for l in car.find_children("Headlight", "SpotLight3D", true, false):
				l.queue_free()
		if rivals.is_empty():
			rivals = RSSetup.load_rivals(RIVALS_FILE)
		var rival: Dictionary = rivals[k % rivals.size()]
		names.append("You" if is_player else str(rival.name))
		if is_player and not all_ai:
			player = car
		else:
			var p: Dictionary = RSSetup.apply_difficulty(rival, difficulty)
			if is_player:
				p = {"skill": crash_skill if crash_skill > 0.0 else 0.95, "reaction_time": 0.4, "headway": 0.5, "aggression": 0.6, "lane_offset": 0.0}
				player = car
			car.set_ai(route, p)
		car.gear = 2
		cars.append(car)


func _spawn_parked_cars() -> void:
	var path := ProjectSettings.globalize_path("res://").path_join(CITY)
	var city: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(path))
	var vis := CarFactory.load_visual("cars/vela_gt.visual.json")
	var cg := Vector3(vis.cg_in_model_m[0], vis.cg_in_model_m[1], vis.cg_in_model_m[2])
	var rng := RandomNumberGenerator.new()
	rng.seed = 5
	var n := 0
	for spot in city.parking:
		if n >= 24:
			break
		n += 1
		var body := RigidBody3D.new()
		body.mass = 1450.0
		body.add_to_group("rs_obstacles")
		CarFactory.add_models(body, vis, Color.from_hsv(rng.randf(), rng.randf_range(0.0, 0.7), rng.randf_range(0.1, 0.7)))
		CarFactory.darken_lights(body)
		var cs := CollisionShape3D.new()
		cs.shape = CarFactory.body_hull(vis.collision_box)
		cs.position = Vector3(0, vis.collision_box.centre_in_model_m[1] - cg.y, 0)
		body.add_child(cs)
		add_child(body)
		var h: float = spot.heading
		var fwd := RSVehicle.core_to_godot(Vector3(cos(h), sin(h), 0))
		body.global_transform = Transform3D(Basis.looking_at(-fwd, Vector3.UP),
			RSVehicle.core_to_godot(Vector3(spot.x, spot.y, spot.z)) + Vector3.UP * (cg.y + 0.02))
		body.sleeping = true
		CityLights.set_car_layer(body)


# ---------------------------------------------------------------- HUD & Menus
func _build_hud() -> void:
	sim_hud = preload("res://scripts/sim_hud.gd").new()
	sim_hud.set_context(route, race, cars, player, names, cam, player_index)
	add_child(sim_hud)
	sim_hud.visible = (state != "menu")

	# Advanced Telemetry Overlay (toggleable with F1)
	debug_overlay = preload("res://scripts/debug_overlay.gd").new()
	debug_overlay.car_path = player.get_path()
	debug_overlay.visible = false
	add_child(debug_overlay)


func _build_main_menu() -> void:
	main_menu = preload("res://scripts/main_menu.gd").new()
	main_menu.start_race_requested.connect(_on_start_race_from_menu)
	main_menu.quit_requested.connect(func(): get_tree().quit())
	main_menu.car_changed.connect(func(_id): _respawn_session(); _enter_menu_view())
	main_menu.look_changed.connect(func(id): Garage.apply_look(player, sm.car_look(id)))
	main_menu.page_changed.connect(func(_p): _frame_menu_camera())
	add_child(main_menu)


## Menu: only the player car is shown (rivals hidden), orbiting on the right half of the screen.
func _enter_menu_view() -> void:
	for c in cars:
		c.visible = c == player
	cam.target = player
	cam.mode = 3
	_frame_menu_camera()
	_set_showroom_lights(true)


## Menu-only lights so the car reads against the dark street (removed when the race starts).
func _set_showroom_lights(on: bool) -> void:
	var old := get_node_or_null("ShowroomLights")
	if old:
		old.free()
	if not on or not player:
		return
	var rig := Node3D.new()
	rig.name = "ShowroomLights"
	add_child(rig)
	rig.global_position = player.global_position
	for spec in [[Vector3(0, 4.0, 0), 3.0, 9.0, Color(1.0, 0.97, 0.92)],
			[Vector3(4.5, 1.6, 3.5), 1.6, 9.0, Color(0.75, 0.85, 1.0)],
			[Vector3(-4.5, 1.2, -3.5), 2.2, 9.0, Color(1.0, 0.3, 0.45)]]:
		var l := OmniLight3D.new()
		l.position = spec[0]
		l.light_energy = spec[1]
		l.omni_range = spec[2]
		l.light_color = spec[3]
		l.shadow_enabled = false
		rig.add_child(l)


func _frame_menu_camera() -> void:
	var garage: bool = main_menu != null and main_menu._page == "garage"
	cam.orbit_radius = 7.2 if garage else 8.6
	cam.orbit_height = 1.3 if garage else 1.7
	cam.orbit_speed = 0.12 if garage else 0.18
	cam.h_offset = -2.0 if garage else -2.5


func _build_pause_menu() -> void:
	pause_menu = preload("res://scripts/pause_menu.gd").new()
	pause_menu.resume_requested.connect(_resume_session)
	pause_menu.restart_requested.connect(_restart_session)
	pause_menu.main_menu_requested.connect(_return_to_main_menu)
	pause_menu.quit_requested.connect(func(): get_tree().quit())
	add_child(pause_menu)
	pause_menu.visible = false


func _build_results_screen() -> void:
	results_screen = preload("res://scripts/results_screen.gd").new()
	results_screen.restart_requested.connect(_restart_session)
	results_screen.main_menu_requested.connect(_return_to_main_menu)
	results_screen.quit_requested.connect(func(): get_tree().quit())
	add_child(results_screen)
	results_screen.visible = false


# ---------------------------------------------------------------- Menu & Session Actions
func _on_start_race_from_menu(cfg: Dictionary) -> void:
	laps = cfg.get("laps", laps)
	n_cars = cfg.get("cars", n_cars)
	player_index = mini(cfg.get("player_index", player_index), n_cars - 1)
	difficulty = cfg.get("difficulty", 1)
	_respawn_session()
	main_menu.visible = false
	_set_showroom_lights(false)
	for c in cars:
		c.visible = true
	cam.mode = 0
	cam.h_offset = 0.0
	cam.target = player
	sim_hud._load_settings()
	sim_hud.set_context(route, race, cars, player, names, cam, player_index)
	sim_hud.visible = true
	countdown = 3.5
	race_time = 0.0
	state = "countdown"


func _pause_session() -> void:
	if state == "menu":
		return
	get_tree().paused = true
	if pause_menu:
		pause_menu.set_context(player, race, cars, names, player_index)
		pause_menu.visible = true


func _resume_session() -> void:
	get_tree().paused = false
	if pause_menu:
		pause_menu.visible = false


func _restart_session() -> void:
	get_tree().paused = false
	if pause_menu:
		pause_menu.visible = false
	if results_screen:
		results_screen.visible = false

	_respawn_session()

	if sim_hud:
		sim_hud.set_context(route, race, cars, player, names, cam, player_index)
		sim_hud.visible = true

	countdown = 3.5
	race_time = 0.0
	state = "countdown"
	cam.mode = 0
	cam.h_offset = 0.0
	cam.target = player


func _return_to_main_menu() -> void:
	get_tree().paused = false
	if pause_menu:
		pause_menu.visible = false
	if results_screen:
		results_screen.visible = false
	if sim_hud:
		sim_hud.visible = false

	if input_node:
		input_node.queue_free()
		input_node = null

	state = "menu"
	_respawn_session()
	_enter_menu_view()

	if main_menu:
		main_menu.visible = true
		main_menu.focus_nav()


func _respawn_session() -> void:
	for c in cars:
		if is_instance_valid(c):
			c.queue_free()
	cars.clear()
	names.clear()

	player_out = false
	spectate = -1
	_spawn_grid()

	race = RSRace.new()
	race.setup(route, laps)
	for c in cars:
		race.add_car(c)
		c.freeze = true

	cam.target = player
	if not all_ai:
		if input_node and is_instance_valid(input_node):
			input_node.queue_free()
		var inp := preload("res://scripts/player_input.gd").new()
		inp.car_path = player.get_path()
		inp.allow_reset = false
		add_child(inp)
		input_node = inp

	if sm:
		sm.apply_assists(player)
	if debug_overlay:
		debug_overlay.car = player


# ---------------------------------------------------------------- Lights & Headlights
func _update_rival_headlights() -> void:
	var mode := 0
	if sm:
		mode = sm.get_setting("graphics", "rival_headlights", 0)

	if mode == 2: # All Off
		for c in cars:
			if c == player: continue
			for l in c.find_children("Headlight", "SpotLight3D", true, false):
				l.visible = false
		return

	if mode == 1: # All On
		for c in cars:
			if c == player: continue
			for l in c.find_children("Headlight", "SpotLight3D", true, false):
				l.visible = true
		return

	# Mode 0: Nearest 2 rivals (Performance target)
	var near := []
	for c in cars:
		if c == player or not is_instance_valid(c):
			continue
		near.append([c.global_position.distance_squared_to(cam.global_position), c])
	near.sort_custom(func(a, b): return a[0] < b[0])
	for k in near.size():
		var on: bool = k < 2 and near[k][0] < 60.0 * 60.0
		for l in near[k][1].find_children("Headlight", "SpotLight3D", true, false):
			l.visible = on


# ---------------------------------------------------------------- Main Loop
func _process(dt: float) -> void:
	if Engine.get_process_frames() % 10 == 0:
		CityLights.update_near(car_lights, cam.global_position)
		_update_rival_headlights()

	if shot_path != "" and not stats.has("shot"):
		var should_shot := false
		if state == "menu" and not menu_start and Engine.get_process_frames() > shot_frame:
			should_shot = true
		elif pause_menu and pause_menu.visible and Engine.get_process_frames() > 25:
			should_shot = true
		elif results_screen and results_screen.visible and Engine.get_process_frames() > 25:
			should_shot = true
		elif state != "menu" and race_time > shot_t:
			should_shot = true
		if should_shot:
			stats.shot = true
			get_viewport().get_texture().get_image().save_png(shot_path)

	if state == "menu":
		if menu_start and Engine.get_process_frames() == 30:
			main_menu._on_start()
		return

	# Countdown -> Racing transition
	if state == "countdown":
		countdown -= dt
		if countdown <= 0.0:
			state = "racing"
			for c in cars:
				c.freeze = false

	var p: Dictionary = race.get_progress(cars.find(player)) if race and player else {}
	if p.is_empty():
		return

	if race.all_done() and state != "results":
		state = "results"
		if not all_ai and results_screen:
			results_screen.show_results(race, cars, names, player)
			results_screen.visible = true
			if sim_hud:
				sim_hud.visible = false
	elif p.get("finished", false) and state == "racing":
		state = "finished"

	if player_out:
		if spectate >= 0 and (race.get_progress(spectate).get("dnf", false) or race.get_progress(spectate).get("finished", false)):
			_spectate_next(1)

	if sim_hud:
		sim_hud.update_hud(dt, race_time, state, countdown, player_out, spectate)


func _physics_process(dt: float) -> void:
	if get_tree().paused or state == "menu":
		return
	if state != "countdown":
		race_time += dt
		race.update(race_time)
		for i in cars.size():
			var c := cars[i]
			if not is_instance_valid(c): continue
			var dm: Dictionary = c.get_telemetry().get("damage", {})
			if race.check_out(i, dm.get("totaled", false), dm.get("totaled_reason", ""), c.global_transform.basis.y.y < 0.3,
					c.linear_velocity.length(), dt, race_time):
				_on_out(i)
	if autotest_out != "":
		_autotest_tick()


func _on_out(i: int) -> void:
	var c := cars[i]
	if not is_instance_valid(c):
		return
	if c.is_ai():
		c.clear_ai()
	c.raw_throttle = 0.0
	c.raw_steer = 0.0
	if c == player:
		player_out = true
		if input_node:
			input_node.queue_free()
			input_node = null
		_spectate_next(1)


func _running() -> Array[int]:
	var out: Array[int] = []
	for i in cars.size():
		var p: Dictionary = race.get_progress(i)
		if not p.get("dnf", false) and not p.get("finished", false):
			out.append(i)
	out.sort_custom(func(a, b): return race.get_progress(a).get("position", 99) < race.get_progress(b).get("position", 99))
	return out


func _spectate_next(dir: int) -> void:
	var run := _running()
	if run.is_empty():
		return
	var k := run.find(spectate)
	spectate = run[0] if k < 0 else run[(k + dir + run.size()) % run.size()]
	cam.target = cars[spectate]


func _unhandled_input(e: InputEvent) -> void:
	if e is InputEventKey and e.pressed and not e.echo:
		if e.keycode == KEY_ESCAPE:
			if state == "menu":
				pass    # main menu handles Esc (back to the nav column); Quit is a menu entry
			elif results_screen and results_screen.visible:
				_return_to_main_menu()
			elif pause_menu:
				if pause_menu.visible and pause_menu.settings_open():
					pause_menu._close_settings()
				elif pause_menu.visible:
					_resume_session()
				else:
					_pause_session()
		elif e.keycode == KEY_H and sim_hud:
			sim_hud.hud_visible = not sim_hud.hud_visible
		elif player_out and e.keycode in [KEY_RIGHT, KEY_D]:
			_spectate_next(1)
		elif player_out and e.keycode in [KEY_LEFT, KEY_A]:
			_spectate_next(-1)


# ---------------------------------------------------------------- Automated Race Check
func _autotest_tick() -> void:
	if state == "countdown":
		return
	for c in cars if trace else []:
		var dd: Dictionary = c.get_telemetry().get("damage", {})
		if dd.get("impacts", 0) != c.get_meta("imp", 0):
			c.set_meta("imp", dd.get("impacts", 0))
			var cp := RSVehicle.godot_to_core(c.global_position)
			print("IMPACT t=%.2f car@(%.1f,%.1f) %dkmh  %.2f kJ" % [race_time, cp.x, cp.y, int(c.get_telemetry().get("speed_kmh", 0)), dd.get("last_kj", 0)])
	if shot_path != "" and race_time > shot_t and not stats.has("shot"):
		stats.shot = true
		get_viewport().get_texture().get_image().save_png(shot_path)
	if race_time < 75.0 * laps + 40.0 and not race.all_done():
		return
	var per_car := []
	for i in cars.size():
		var c := cars[i]
		var t: Dictionary = c.get_telemetry()
		var p: Dictionary = race.get_progress(i)
		var dmg: Dictionary = t.get("damage", {})
		per_car.append({
			"name": names[i], "dnf": p.get("dnf", false), "dnf_reason": p.get("dnf_reason", ""),
			"crush_m": dmg.get("crush", []), "position": p.get("position", 1), "laps": p.get("lap", 0),
			"distance_m": snappedf(float(p.get("distance", 0)), 0.1),
			"best_lap_s": snappedf(float(p.get("best_lap", 0)), 0.01), "impacts": dmg.get("impacts", 0),
			"crash_energy_kj": snappedf(float(dmg.get("total_kj", 0)), 0.1), "zones": dmg.get("zones", []),
			"engine": snappedf(float(dmg.get("engine", 0)), 0.01), "upright": c.global_transform.basis.y.y > 0.5
		})
	var res := {"race_time_s": snappedf(race_time, 0.01), "route_m": snappedf(route.get_length(), 0.1), "cars": per_car}
	var f := FileAccess.open(autotest_out, FileAccess.WRITE)
	if f:
		f.store_string(JSON.stringify(res, "  "))
	print(JSON.stringify(res, "  "))
	get_tree().quit()
