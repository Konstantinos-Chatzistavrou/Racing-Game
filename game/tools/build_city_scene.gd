extends SceneTree
## Builds res://scenes/city_night.tscn: city + night environment + LightmapGI + reflection
## probes. The scene is GENERATED (regenerable), lighting values live here, not hand-edited.
## Run: tools/godot/godot --path game --headless --script res://tools/build_city_scene.gd
## Then bake: tools/godot/godot --path game --editor -- --autobake=res://scenes/city_night.tscn

const TRACK_JSON := "../data/tracks/city_route.json"
const OUT := "res://scenes/city_night.tscn"
const CAR_LAYER := 2          # cars render on visual layer 2 so probes don't bake them in


func _init() -> void:
	var root := Node3D.new()
	root.name = "CityNight"

	var track: Node3D = load("res://assets/city/city.glb").instantiate()
	track.name = "City"
	_add(root, track)

	var we := WorldEnvironment.new()
	we.name = "WorldEnvironment"
	we.environment = _environment()
	_add(root, we)

	var moon := DirectionalLight3D.new()
	moon.name = "Moon"
	moon.light_color = Color(0.62, 0.72, 1.0)
	moon.light_energy = 0.12
	moon.rotation_degrees = Vector3(-38, 140, 0)
	# Moon shadows measured at 1.6 ms GPU (Phase 4 profile) and are nearly invisible at this
	# energy, so they are off. Cars get contact shadows from decals instead.
	moon.shadow_enabled = false
	moon.directional_shadow_mode = DirectionalLight3D.SHADOW_PARALLEL_2_SPLITS
	moon.directional_shadow_max_distance = 60.0
	moon.light_bake_mode = Light3D.BAKE_DYNAMIC     # direct light realtime (car shadows), bounce baked
	_add(root, moon)

	var lm := LightmapGI.new()
	lm.name = "LightmapGI"
	lm.quality = LightmapGI.BAKE_QUALITY_LOW
	lm.bounces = 2
	lm.use_denoiser = true
	lm.directional = false
	lm.interior = false
	lm.environment_mode = LightmapGI.ENVIRONMENT_MODE_SCENE
	lm.generate_probes_subdiv = LightmapGI.GENERATE_PROBES_SUBDIV_8
	lm.max_texture_size = 4096
	lm.texel_scale = 1.0
	_add(root, lm)

	# Reflection probes every ~190 m along the track (wet road + car paint reflections).
	var samples: Array = _load_samples()
	var probes := Node3D.new()
	probes.name = "ReflectionProbes"
	_add(root, probes)
	var step := int(ceil(samples.size() / 8.0))   # exactly 8 probes: matches the reflection atlas size
	for i in range(0, samples.size(), step):
		var s: Dictionary = samples[i]
		var rp := ReflectionProbe.new()
		rp.name = "Probe_%02d" % (i / step)
		rp.position = RSVehicle.core_to_godot(Vector3(s.x, s.y, s.z + 4.0))
		rp.size = Vector3(130, 45, 130)
		rp.box_projection = true
		rp.update_mode = ReflectionProbe.UPDATE_ONCE
		rp.max_distance = 220.0
		rp.intensity = 1.0
		rp.ambient_mode = ReflectionProbe.AMBIENT_DISABLED   # ambient comes from the lightmap
		rp.cull_mask = 0xFFFFF & ~(1 << (CAR_LAYER - 1))
		probes.add_child(rp)
		rp.owner = root

	var ps := PackedScene.new()
	var err := ps.pack(root)
	assert(err == OK)
	DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path("res://scenes"))
	err = ResourceSaver.save(ps, OUT)
	print("[build] saved ", OUT, " err=", err, " probes=", probes.get_child_count())
	root.free()
	quit()


func _add(root: Node, n: Node) -> void:
	root.add_child(n)
	n.owner = root


func _load_samples() -> Array:
	var path := ProjectSettings.globalize_path("res://").path_join(TRACK_JSON)
	var data: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(path))
	return data.samples


func _environment() -> Environment:
	var env := Environment.new()
	var sky := Sky.new()
	var sm := ShaderMaterial.new()
	sm.shader = load("res://shaders/night_sky.gdshader")
	sky.sky_material = sm
	sky.radiance_size = Sky.RADIANCE_SIZE_128
	env.background_mode = Environment.BG_SKY
	env.sky = sky
	env.ambient_light_source = Environment.AMBIENT_SOURCE_SKY
	env.ambient_light_energy = 0.6
	env.reflected_light_source = Environment.REFLECTION_SOURCE_SKY
	# Filmic tonemapping: AgX rolls bright neon/lamp colours off to white gracefully.
	env.tonemap_mode = Environment.TONE_MAPPER_AGX
	env.tonemap_exposure = 1.1
	# Bloom: lamps, neon and lit windows bleed light like a real camera lens.
	env.glow_enabled = true
	env.glow_intensity = 0.7
	env.glow_strength = 1.0
	env.glow_bloom = 0.03
	env.glow_hdr_threshold = 1.0
	env.glow_blend_mode = Environment.GLOW_BLEND_MODE_SOFTLIGHT
	for lvl in 7:
		env.set_glow_level(lvl, 1.0 if lvl in [2, 3, 4] else 0.0)
	# Depth fog: humid night air; distant lamps and windows fade into the haze.
	env.fog_enabled = true
	env.fog_mode = Environment.FOG_MODE_EXPONENTIAL
	env.fog_light_color = Color(0.05, 0.05, 0.065)
	env.fog_density = 0.0035
	env.fog_sky_affect = 0.2
	env.adjustment_enabled = true
	env.adjustment_contrast = 1.08
	env.adjustment_saturation = 1.08
	return env
