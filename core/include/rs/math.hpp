// Minimal 3D math for the physics core. No engine types, no dependencies.
// Convention everywhere in the core: SI units, right-handed, Z up.
// Car body frame (ISO 8855): +X forward, +Y left, +Z up, origin at the centre of gravity.
#pragma once
#include <cmath>
#include <algorithm>

namespace rs {

constexpr double kPi = 3.14159265358979323846;
constexpr double kGravity = 9.80665;   // standard gravity, m/s^2

struct Vec3 {
    double x = 0, y = 0, z = 0;
    constexpr Vec3() = default;
    constexpr Vec3(double x_, double y_, double z_) : x(x_), y(y_), z(z_) {}
    Vec3 operator+(const Vec3& o) const { return {x + o.x, y + o.y, z + o.z}; }
    Vec3 operator-(const Vec3& o) const { return {x - o.x, y - o.y, z - o.z}; }
    Vec3 operator-() const { return {-x, -y, -z}; }
    Vec3 operator*(double s) const { return {x * s, y * s, z * s}; }
    Vec3 operator/(double s) const { return {x / s, y / s, z / s}; }
    Vec3& operator+=(const Vec3& o) { x += o.x; y += o.y; z += o.z; return *this; }
    Vec3& operator-=(const Vec3& o) { x -= o.x; y -= o.y; z -= o.z; return *this; }
    Vec3& operator*=(double s) { x *= s; y *= s; z *= s; return *this; }
};
inline Vec3 operator*(double s, const Vec3& v) { return v * s; }
inline double dot(const Vec3& a, const Vec3& b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
inline Vec3 cross(const Vec3& a, const Vec3& b) {
    return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x};
}
inline double length(const Vec3& v) { return std::sqrt(dot(v, v)); }
inline Vec3 normalized(const Vec3& v) {
    double l = length(v);
    return l > 1e-12 ? v / l : Vec3{};
}

// Unit quaternion for orientation (body -> world rotation).
struct Quat {
    double w = 1, x = 0, y = 0, z = 0;
    static Quat from_axis_angle(const Vec3& axis, double angle) {
        Vec3 a = rs::normalized(axis);
        double s = std::sin(angle * 0.5);
        return {std::cos(angle * 0.5), a.x * s, a.y * s, a.z * s};
    }
    // Rotation whose columns are the given orthonormal axes (body x, y, z expressed in world).
    // Standard rotation-matrix -> quaternion conversion (Shepperd's method, numerically safe).
    static Quat from_axes(const Vec3& X, const Vec3& Y, const Vec3& Z) {
        double m00 = X.x, m11 = Y.y, m22 = Z.z, tr = m00 + m11 + m22;
        Quat q;
        if (tr > 0) {
            double s = std::sqrt(tr + 1.0) * 2;
            q = {0.25 * s, (Y.z - Z.y) / s, (Z.x - X.z) / s, (X.y - Y.x) / s};
        } else if (m00 > m11 && m00 > m22) {
            double s = std::sqrt(1.0 + m00 - m11 - m22) * 2;
            q = {(Y.z - Z.y) / s, 0.25 * s, (Y.x + X.y) / s, (Z.x + X.z) / s};
        } else if (m11 > m22) {
            double s = std::sqrt(1.0 + m11 - m00 - m22) * 2;
            q = {(Z.x - X.z) / s, (Y.x + X.y) / s, 0.25 * s, (Z.y + Y.z) / s};
        } else {
            double s = std::sqrt(1.0 + m22 - m00 - m11) * 2;
            q = {(X.y - Y.x) / s, (Z.x + X.z) / s, (Z.y + Y.z) / s, 0.25 * s};
        }
        return q.normalized();
    }
    Quat operator*(const Quat& q) const {
        return {w * q.w - x * q.x - y * q.y - z * q.z, w * q.x + x * q.w + y * q.z - z * q.y,
                w * q.y - x * q.z + y * q.w + z * q.x, w * q.z + x * q.y - y * q.x + z * q.w};
    }
    Quat conj() const { return {w, -x, -y, -z}; }
    // Rotate a vector: v' = q v q*  (expanded form)
    Vec3 rotate(const Vec3& v) const {
        Vec3 u{x, y, z};
        Vec3 t = cross(u, v) * 2.0;
        return v + t * w + cross(u, t);
    }
    Vec3 inv_rotate(const Vec3& v) const { return conj().rotate(v); }
    Quat normalized() const {
        double n = std::sqrt(w * w + x * x + y * y + z * z);
        return {w / n, x / n, y / n, z / n};
    }
};

inline double clamp(double v, double lo, double hi) { return std::max(lo, std::min(hi, v)); }
inline double sign(double v) { return (v > 0) - (v < 0); }
inline double lerp(double a, double b, double t) { return a + (b - a) * t; }

}  // namespace rs
