@tool
extends EditorPlugin
## Godot 4.7 has no scripting API to bake a LightmapGI, only the editor's "Bake Lightmaps"
## toolbar button. This plugin presses that button so baking is a reproducible command:
##   godot --path game --editor -- --autobake=res://scenes/harbour_night.tscn
## Without the --autobake argument the plugin does nothing.


func _enter_tree() -> void:
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--autobake="):
			_run.call_deferred(a.get_slice("=", 1))


func _run(target: String) -> void:
	await get_tree().create_timer(4.0).timeout          # let the editor finish starting up
	EditorInterface.open_scene_from_path(target)
	EditorInterface.set_main_screen_editor("3D")
	await get_tree().create_timer(3.0).timeout
	var root := EditorInterface.get_edited_scene_root()
	var found := root.find_children("*", "LightmapGI", true, false)
	if found.is_empty():
		printerr("[autobake] no LightmapGI in ", target)
		get_tree().quit(1)
		return
	var lm: LightmapGI = found[0]
	EditorInterface.get_selection().clear()
	EditorInterface.get_selection().add_node(lm)
	EditorInterface.edit_node(lm)
	await get_tree().create_timer(1.0).timeout
	var btn := _find_button(EditorInterface.get_base_control())
	if btn == null:
		printerr("[autobake] 'Bake Lightmaps' button not found")
		get_tree().quit(1)
		return
	var t0 := Time.get_ticks_msec()
	print("[autobake] baking ", target, " ...")
	btn.pressed.emit()
	var waited := 0
	while lm.light_data == null and waited < 3600:
		await get_tree().create_timer(1.0).timeout
		waited += 1
		_answer_save_dialog(target)
	print("[autobake] done in %.1f s, light_data=%s" % [(Time.get_ticks_msec() - t0) / 1000.0, lm.light_data])
	EditorInterface.save_scene()
	await get_tree().create_timer(2.0).timeout
	get_tree().quit(0 if lm.light_data else 1)


## If Godot asks where to save the bake (it does when a stale .lmbake exists), answer it.
func _answer_save_dialog(target: String) -> void:
	for d in EditorInterface.get_base_control().find_children("*", "FileDialog", true, false):
		var fd := d as FileDialog
		if fd.visible and fd.title.contains("lightmap"):
			print("[autobake] answering save dialog")
			fd.hide()
			fd.file_selected.emit(target.get_basename() + ".lmbake")


func _find_button(n: Node) -> Button:
	if n is Button and (n as Button).text.contains("Bake Lightmap"):
		return n
	for c in n.get_children():
		var b := _find_button(c)
		if b:
			return b
	return null
