// THE ONLY PLACE where core coordinates are converted to/from Godot's (see PORTING.md).
//
// World:  core is Z-up right-handed; Godot is Y-up right-handed. We use the same mapping as the
//         Blender glTF exporter, so track data (Blender coords) and imported meshes agree:
//             godot = (x, z, -y)            core = (x, -z, y)
// Body:   core body axes (ISO 8855) x = forward, y = left, z = up.
//         Godot car models face +Z, so local axes are X = left, Y = up, Z = forward.
// Both mappings are proper rotations (determinant +1), so they also apply to torques and
// angular velocities (pseudo-vectors) without sign flips.
#pragma once
#include <godot_cpp/variant/basis.hpp>
#include <godot_cpp/variant/vector3.hpp>
#include "rs/math.hpp"

namespace axes {

inline godot::Vector3 to_godot(const rs::Vec3& v) { return godot::Vector3(v.x, v.z, -v.y); }
inline rs::Vec3 to_core(const godot::Vector3& v) { return rs::Vec3(v.x, -v.z, v.y); }

// Godot basis (columns = local X/left, Y/up, Z/forward in Godot world) -> core orientation.
inline rs::Quat to_core(const godot::Basis& b) {
    rs::Vec3 fwd = to_core(b.get_column(2));
    rs::Vec3 left = to_core(b.get_column(0));
    rs::Vec3 up = to_core(b.get_column(1));
    return rs::Quat::from_axes(fwd, left, up);
}

// Core orientation -> Godot basis.
inline godot::Basis to_godot(const rs::Quat& q) {
    godot::Basis b;
    b.set_column(0, to_godot(q.rotate({0, 1, 0})));   // left
    b.set_column(1, to_godot(q.rotate({0, 0, 1})));   // up
    b.set_column(2, to_godot(q.rotate({1, 0, 0})));   // forward
    return b;
}

}  // namespace axes
