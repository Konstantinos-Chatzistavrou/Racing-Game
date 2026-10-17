@tool
extends EditorScenePostImport
## Post-import for car glb files: material features glTF (as exported by Blender) doesn't carry.

func _post_import(scene: Node) -> Object:
	_walk(scene)
	return scene


func _walk(n: Node) -> void:
	if n is MeshInstance3D:
		var mi := n as MeshInstance3D
		mi.gi_mode = GeometryInstance3D.GI_MODE_DYNAMIC    # cars move: lit by lightmap probes
		for i in mi.mesh.get_surface_count():
			var m := mi.mesh.surface_get_material(i) as StandardMaterial3D
			if m == null:
				continue
			match m.resource_name:
				"paint":
					# Two-layer car paint: metallic base + clear lacquer coat on top.
					m.metallic = 0.55
					m.roughness = 0.32
					m.clearcoat_enabled = true
					m.clearcoat = 1.0
					m.clearcoat_roughness = 0.04
				"glass":
					m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
					m.albedo_color = Color(0.01, 0.012, 0.015, 0.78)
					m.roughness = 0.02
					m.metallic_specular = 1.0
					mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
				"interior", "underbody":
					if String(mi.name) in ["interior_shell", "dashboard", "steering_rim"] or String(mi.name).begins_with("seat"):
						mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
				"light_drl", "light_beam", "light_tail":
					mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	for c in n.get_children():
		_walk(c)
