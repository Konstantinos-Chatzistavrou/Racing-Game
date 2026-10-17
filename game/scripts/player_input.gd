extends Node
## Reads keyboard or gamepad and passes RAW values to the car. All shaping (ramps, deadzones,
## speed-sensitive steering) happens in the core (rs::Controls), not here.
## The active device switches automatically to whichever was used last.
##
## Keyboard: W/S or Up/Down throttle/brake, A/D or Left/Right steer, Space handbrake,
##           E/Q shift up/down, Shift clutch pedal (only with auto-clutch off), R reset
## Gamepad:  right trigger throttle, left trigger brake, left stick steer, A handbrake,
##           RB/LB shift up/down, Back/Select reset
## Assists:  1 ABS  2 TC  3 ESC  4 countersteer  5 auto gearbox  6 auto clutch  7 speed-sens. steering

const DEVICE_KEYBOARD := 0
const DEVICE_GAMEPAD := 1
const ASSIST_KEYS := {KEY_1: "abs", KEY_2: "tc", KEY_3: "esc", KEY_4: "countersteer",
	KEY_5: "auto_gearbox", KEY_6: "auto_clutch", KEY_7: "speed_sensitive_steering"}

@export var car_path: NodePath
@export var allow_reset := true      # races: false (no restarts, street-race rules)
var car: RSVehicle
var device := DEVICE_KEYBOARD
var spawn_transform: Transform3D


func _ready() -> void:
	car = get_node(car_path)
	spawn_transform = car.global_transform
	var sm = get_node_or_null("/root/SettingsManager")
	if sm:
		sm.apply_assists(car)
	else:
		for a in ["abs", "tc", "esc", "auto_gearbox", "auto_clutch", "speed_sensitive_steering"]:
			car.set_assist(a, true)
	car.gear = 2


func _input(e: InputEvent) -> void:
	if e is InputEventKey:
		device = DEVICE_KEYBOARD
	elif e is InputEventJoypadButton or (e is InputEventJoypadMotion and absf(e.axis_value) > 0.25):
		device = DEVICE_GAMEPAD
	if e is InputEventKey and e.pressed and not e.echo:
		match e.keycode:
			KEY_E: car.shift_up()
			KEY_Q: car.shift_down()
			KEY_R: if allow_reset: _reset()
		if ASSIST_KEYS.has(e.keycode):
			var a: String = ASSIST_KEYS[e.keycode]
			var new_val: bool = not car.get_assist(a)
			car.set_assist(a, new_val)
			var sm = get_node_or_null("/root/SettingsManager")
			if sm:
				sm.set_setting("assists", a, new_val)
	if e is InputEventJoypadButton and e.pressed:
		match e.button_index:
			JOY_BUTTON_RIGHT_SHOULDER: car.shift_up()
			JOY_BUTTON_LEFT_SHOULDER: car.shift_down()
			JOY_BUTTON_BACK: if allow_reset: _reset()


func _physics_process(_dt: float) -> void:
	car.input_device = device
	if device == DEVICE_KEYBOARD:
		var steer := 0.0
		if Input.is_key_pressed(KEY_A) or Input.is_key_pressed(KEY_LEFT): steer += 1.0
		if Input.is_key_pressed(KEY_D) or Input.is_key_pressed(KEY_RIGHT): steer -= 1.0
		car.raw_steer = steer
		car.raw_throttle = 1.0 if (Input.is_key_pressed(KEY_W) or Input.is_key_pressed(KEY_UP)) else 0.0
		car.raw_brake = 1.0 if (Input.is_key_pressed(KEY_S) or Input.is_key_pressed(KEY_DOWN)) else 0.0
		car.raw_handbrake = 1.0 if Input.is_key_pressed(KEY_SPACE) else 0.0
		car.raw_clutch = 1.0 if Input.is_key_pressed(KEY_SHIFT) else 0.0
	else:
		car.raw_steer = -Input.get_joy_axis(0, JOY_AXIS_LEFT_X)          # stick left = +steer (left)
		car.raw_throttle = Input.get_joy_axis(0, JOY_AXIS_TRIGGER_RIGHT)
		car.raw_brake = Input.get_joy_axis(0, JOY_AXIS_TRIGGER_LEFT)
		car.raw_handbrake = 1.0 if Input.is_joy_button_pressed(0, JOY_BUTTON_A) else 0.0
		car.raw_clutch = 0.0


func _reset() -> void:
	car.global_transform = spawn_transform
	car.linear_velocity = Vector3.ZERO
	car.angular_velocity = Vector3.ZERO
	car.gear = 2
