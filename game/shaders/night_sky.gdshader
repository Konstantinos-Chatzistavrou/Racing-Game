// Night city sky: dark zenith, warm light-pollution glow at the horizon, sparse stars, moon disc.
// Cheap: a few ALU ops per sky pixel; also feeds the (128 px) radiance map used for reflections.
shader_type sky;

uniform vec3 zenith_color : source_color = vec3(0.004, 0.006, 0.016);
uniform vec3 horizon_color : source_color = vec3(0.075, 0.05, 0.04);   // sodium-orange city glow
uniform vec3 ground_color : source_color = vec3(0.01, 0.01, 0.012);
uniform float glow_height = 0.35;        // how far the city glow reaches up (in EYEDIR.y)
uniform float star_density = 0.004;
uniform float star_brightness = 0.7;

float hash(vec3 p) {
	p = fract(p * 0.3183099 + 0.1);
	p *= 17.0;
	return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

void sky() {
	float h = EYEDIR.y;
	vec3 col = mix(horizon_color, zenith_color, smoothstep(0.0, glow_height, h));
	col = mix(ground_color, col, smoothstep(-0.05, 0.02, h));

	// Stars: hash a 3D grid of directions; only a few cells light up. Fade near the hazy horizon.
	if (!AT_CUBEMAP_PASS) {
		vec3 d = EYEDIR * 320.0;
		vec3 cell = floor(d);
		float r = hash(cell);
		float star = step(1.0 - star_density, r) * smoothstep(0.45, 0.0, length(fract(d) - 0.5));
		col += vec3(0.85, 0.9, 1.0) * star * star_brightness * (0.5 + 0.5 * hash(cell + 7.0)) * smoothstep(0.08, 0.35, h);
	}

	// Moon follows the directional light: sharp disc + soft halo in the haze.
	if (LIGHT0_ENABLED) {
		float md = dot(EYEDIR, LIGHT0_DIRECTION);
		col += vec3(0.9, 0.93, 1.0) * smoothstep(0.99955, 0.99975, md) * 4.0;
		col += vec3(0.25, 0.3, 0.42) * pow(max(md, 0.0), 300.0) * 0.5;
	}
	COLOR = col;
}
