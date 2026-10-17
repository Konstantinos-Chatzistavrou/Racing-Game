@tool
extends EditorScenePostImport
## Post-import for track_harbour.glb. Everything here is regenerable from the Blender source:
## it only maps glTF materials/lights onto Godot features glTF can't express.

const ROAD_SHADER := preload("res://shaders/wet_road.gdshader")
var _road_mat: ShaderMaterial


func _post_import(scene: Node) -> Object:
	_road_mat = ShaderMaterial.new()
	_road_mat.shader = ROAD_SHADER
	_road_mat.set_shader_parameter("albedo_tex", load("res://assets/textures/asphalt_albedo.png"))
	_road_mat.set_shader_parameter("normal_tex", load("res://assets/textures/asphalt_normal.png"))
	_road_mat.set_shader_parameter("rough_tex", load("res://assets/textures/asphalt_rough.png"))
	_road_mat.set_shader_parameter("puddle_tex", load("res://assets/textures/puddle_mask.png"))
	_walk(scene)
	return scene


func _walk(n: Node) -> void:
	if n is MeshInstance3D:
		_mesh(n)
	elif n is SpotLight3D and n.name.begins_with("lamp_light"):
		# Street lamp: fully baked (direct + indirect) into the lightmap. Values are physical-ish:
		# a ~100 W LED street lamp, 62.5 degree half-angle cone, light reaching the road 8 m below.
		n.light_bake_mode = Light3D.BAKE_STATIC
		n.light_energy = 9.0
		n.light_indirect_energy = 1.0
		n.spot_range = 26.0
		n.spot_attenuation = 1.2
		n.spot_angle = 62.0
		n.spot_angle_attenuation = 0.6
		n.light_size = 0.4            # soft baked shadow edges
		n.shadow_enabled = true       # the lightmapper only traces shadows for shadow-enabled lights
		n.light_color = Color(1.0, 0.86, 0.68)
	elif n is OmniLight3D and n.name.begins_with("neon_light"):
		n.light_bake_mode = Light3D.BAKE_STATIC
		n.light_energy = 2.5
		n.omni_range = 10.0
		n.omni_attenuation = 1.5
		n.shadow_enabled = false
	elif n is StaticBody3D:
		# Physics surface type for the (future) GDExtension wrapper, read from the Blender name.
		for t in ["asphalt", "kerb", "pavement", "wall"]:
			if String(n.name).contains("col_" + t):
				n.set_meta("surface", t)
	for c in n.get_children():
		_walk(c)


func _mesh(mi: MeshInstance3D) -> void:
	var nm := String(mi.name)
	mi.gi_mode = GeometryInstance3D.GI_MODE_STATIC
	for i in mi.mesh.get_surface_count():
		var m := mi.mesh.surface_get_material(i)
		if m == null:
			continue
		match m.resource_name:
			"road_asphalt":
				mi.mesh.surface_set_material(i, _road_mat)
			"fence":
				var f := m as StandardMaterial3D
				f.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA_SCISSOR
				f.alpha_scissor_threshold = 0.5
				f.cull_mode = BaseMaterial3D.CULL_DISABLED
				mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
				mi.gi_mode = GeometryInstance3D.GI_MODE_DISABLED
			"facade_office", "facade_brick":
				(m as StandardMaterial3D).emission_energy_multiplier = 1.3
			"kerb", "concrete", "barrier_concrete", "grass":
				(m as StandardMaterial3D).texture_filter = BaseMaterial3D.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS_ANISOTROPIC
	# Lightmap resolution per object type: buildings are huge and mostly lit by their own windows,
	# so they get fewer texels; the road gets the most (that's where the lamp pools matter).
	if nm.begins_with("bld_"):
		mi.gi_lightmap_texel_scale = 0.3
	elif nm.begins_with("lot_") or nm.begins_with("ground"):
		mi.gi_lightmap_texel_scale = 0.4
		mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	elif nm.begins_with("lamp_heads") or nm.begins_with("neon_") or nm.begins_with("gantry_lights"):
		mi.gi_mode = GeometryInstance3D.GI_MODE_DISABLED   # emissive, tiny: lit by themselves
		mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	elif nm.begins_with("road_") or nm.begins_with("runoff") or nm.begins_with("kerb"):
		mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF   # flat: casts nothing visible
