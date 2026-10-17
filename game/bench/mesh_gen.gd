class_name MeshGen
## Procedural stand-in meshes with controllable triangle counts.
## Benchmark only: GPU cost depends on triangle/vertex/draw-call counts, not on how pretty the
## mesh is, so these predict real-asset cost. Real art replaces them in Phase 4.
##
## Winding: Godot treats CLOCKWISE (seen from outside) as front-facing. Every triangle goes
## through _tri(), which flips it if its geometric normal disagrees with the wanted normal, so
## we never have to reason about winding per shape.

static func _tri(idx: PackedInt32Array, v: PackedVector3Array, a: int, b: int, c: int, want: Vector3) -> void:
	# (b-a)x(c-a) points TOWARD the viewer for counter-clockwise, AWAY for clockwise.
	# Front-facing (clockwise) therefore needs the cross product opposite to the outward normal.
	var n := (v[b] - v[a]).cross(v[c] - v[a])
	if n.dot(want) > 0.0:
		idx.append_array([a, c, b])
	else:
		idx.append_array([a, b, c])


static func _commit(v: PackedVector3Array, n: PackedVector3Array, uv: PackedVector2Array,
		tg: PackedFloat32Array, idx: PackedInt32Array) -> ArrayMesh:
	var arr := []
	arr.resize(Mesh.ARRAY_MAX)
	arr[Mesh.ARRAY_VERTEX] = v
	arr[Mesh.ARRAY_NORMAL] = n
	arr[Mesh.ARRAY_TEX_UV] = uv
	arr[Mesh.ARRAY_TANGENT] = tg
	arr[Mesh.ARRAY_INDEX] = idx
	var m := ArrayMesh.new()
	m.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arr)
	return m


## Ellipsoid with ~`tris` triangles. Triangles = 2 * lon * (lat-1), lon = 2*lat.
static func blob(tris: int, radii: Vector3) -> ArrayMesh:
	var lat := maxi(3, int(sqrt(tris / 4.0)) + 1)
	var lon := lat * 2
	var v := PackedVector3Array()
	var n := PackedVector3Array()
	var uv := PackedVector2Array()
	var tg := PackedFloat32Array()
	for i in lat + 1:
		var th := PI * i / lat
		for j in lon + 1:
			var ph := TAU * j / lon
			var d := Vector3(sin(th) * cos(ph), cos(th), sin(th) * sin(ph))
			v.append(d * radii)
			n.append((d / radii).normalized())
			uv.append(Vector2(float(j) / lon, float(i) / lat))
			tg.append_array([-sin(ph), 0.0, cos(ph), 1.0])
	var idx := PackedInt32Array()
	for i in lat:
		for j in lon:
			var a := i * (lon + 1) + j
			var b := a + lon + 1
			_tri(idx, v, a, a + 1, b, n[a])
			_tri(idx, v, a + 1, b + 1, b, n[a])
	return _commit(v, n, uv, tg, idx)


## Axis-aligned box, each face subdivided n x n. Triangles = 12 * n^2.
static func box(size: Vector3, n: int) -> ArrayMesh:
	var v := PackedVector3Array()
	var nr := PackedVector3Array()
	var uv := PackedVector2Array()
	var tg := PackedFloat32Array()
	var idx := PackedInt32Array()
	var h := size * 0.5
	# [normal, u axis, v axis] with cross(u, v) == normal
	var faces := [
		[Vector3.RIGHT, Vector3.UP, Vector3.BACK],
		[Vector3.LEFT, Vector3.BACK, Vector3.UP],
		[Vector3.UP, Vector3.BACK, Vector3.RIGHT],
		[Vector3.DOWN, Vector3.RIGHT, Vector3.BACK],
		[Vector3.BACK, Vector3.RIGHT, Vector3.UP],
		[Vector3.FORWARD, Vector3.UP, Vector3.RIGHT],
	]
	for f in faces:
		var nrm: Vector3 = f[0]
		var u: Vector3 = f[1]
		var w: Vector3 = f[2]
		var base := v.size()
		var origin: Vector3 = nrm * h - u * h - w * h
		var ul: Vector3 = u * size * 1.0
		var wl: Vector3 = w * size * 1.0
		for i in n + 1:
			for j in n + 1:
				v.append(origin + wl * (float(i) / n) * 1.0 + ul * (float(j) / n))
				nr.append(nrm)
				uv.append(Vector2(float(j) / n, float(i) / n))
				tg.append_array([u.x, u.y, u.z, 1.0])
		for i in n:
			for j in n:
				var a := base + i * (n + 1) + j
				var b := a + n + 1
				_tri(idx, v, a, a + 1, b, nrm)
				_tri(idx, v, a + 1, b + 1, b, nrm)
	return _commit(v, nr, uv, tg, idx)


## Flat ring road in the XZ plane, centre-line radius `radius`, width `width`.
## `seg` slices around, `lat` strips across. uv_len = metres of road per texture repeat.
static func ring(radius: float, width: float, seg: int, lat: int, uv_len: float) -> ArrayMesh:
	var v := PackedVector3Array()
	var n := PackedVector3Array()
	var uv := PackedVector2Array()
	var tg := PackedFloat32Array()
	for i in seg + 1:
		var th := TAU * i / seg
		var c := cos(th)
		var s := sin(th)
		for k in lat + 1:
			var r := radius + (float(k) / lat - 0.5) * width
			v.append(Vector3(r * c, 0.0, r * s))
			n.append(Vector3.UP)
			uv.append(Vector2(TAU * radius * i / seg / uv_len, float(k) / lat * width / uv_len))
			tg.append_array([-s, 0.0, c, 1.0])
	var idx := PackedInt32Array()
	for i in seg:
		for k in lat:
			var a := i * (lat + 1) + k
			var b := a + lat + 1
			_tri(idx, v, a, a + 1, b, Vector3.UP)
			_tri(idx, v, a + 1, b + 1, b, Vector3.UP)
	return _commit(v, n, uv, tg, idx)


## Big flat ground quad grid (for grass/terrain), n x n quads.
static func plane(size: float, n: int) -> ArrayMesh:
	var v := PackedVector3Array()
	var nr := PackedVector3Array()
	var uv := PackedVector2Array()
	var tg := PackedFloat32Array()
	for i in n + 1:
		for j in n + 1:
			v.append(Vector3((float(j) / n - 0.5) * size, 0.0, (float(i) / n - 0.5) * size))
			nr.append(Vector3.UP)
			uv.append(Vector2(float(j) / n, float(i) / n) * (size / 8.0))
			tg.append_array([1.0, 0.0, 0.0, 1.0])
	var idx := PackedInt32Array()
	for i in n:
		for j in n:
			var a := i * (n + 1) + j
			var b := a + n + 1
			_tri(idx, v, a, a + 1, b, Vector3.UP)
			_tri(idx, v, a + 1, b + 1, b, Vector3.UP)
	return _commit(v, nr, uv, tg, idx)
