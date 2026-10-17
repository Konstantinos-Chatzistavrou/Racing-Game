// Node check of the WASM core through the same bridge the game uses: flat ground, own rigid-body
// integrator (three axes, Y-up). 60-0 mph braking with ABS must match docs/handling_reference.md.
import fs from 'node:fs';
import * as THREE from 'three';
import createRsCore from '../src/physics/rs_core.js';
const M = await createRsCore({ wasmBinary: fs.readFileSync(new URL('../src/physics/rs_core.wasm', import.meta.url)) });
const json = fs.readFileSync(new URL('../../data/cars/vela_gt.json', import.meta.url), 'utf8');
const p = M.stringToNewUTF8(json); const id = M._rs_create(p); M._free(p);
if (id < 0) throw new Error(M.UTF8ToString(M._rs_last_error()));
const b = new Float64Array(M.HEAPF64.buffer, M._rs_buffer(id), 256);
M._rs_info(id); const mass = b[0], I = [b[1], b[2], b[3]], cg = b[4];
const pos = new THREE.Vector3(0, cg, 0), q = new THREE.Quaternion(), v = new THREE.Vector3(), w = new THREE.Vector3();
const dt = 1 / 240;
function tick(input) {
  b.set([pos.x, pos.y, pos.z, q.x, q.y, q.z, q.w, v.x, v.y, v.z, w.x, w.y, w.z], 0);
  M._rs_rays(id);
  for (let i = 0; i < 4; i++) {
    const fy = b[17 + 6 * i], ty = b[20 + 6 * i], o = 48 + 8 * i;
    if (fy > 0 && ty <= 0) { const t = fy / (fy - ty);
      b.set([1, b[16 + 6 * i] + (b[19 + 6 * i] - b[16 + 6 * i]) * t, 0, b[18 + 6 * i] + (b[21 + 6 * i] - b[18 + 6 * i]) * t, 0, 1, 0, 0], o);
    } else b[o] = 0;
  }
  b.set(input, 80); M._rs_step(id, dt);
  const F = new THREE.Vector3(b[96], b[97] - mass * 9.81, b[98]), T = new THREE.Vector3(b[99], b[100], b[101]);
  v.addScaledVector(F, dt / mass);
  // angular: body frame, I dw/dt = tau - w x Iw
  const qi = q.clone().invert(), wb = w.clone().applyQuaternion(qi), tb = T.applyQuaternion(qi);
  const Iw = new THREE.Vector3(I[0] * wb.x, I[1] * wb.y, I[2] * wb.z);
  const rhs = tb.sub(wb.clone().cross(Iw));
  wb.x += rhs.x / I[0] * dt; wb.y += rhs.y / I[1] * dt; wb.z += rhs.z / I[2] * dt;
  w.copy(wb).applyQuaternion(q);
  pos.addScaledVector(v, dt);
  const ang = w.length() * dt; if (ang > 0) q.premultiply(new THREE.Quaternion().setFromAxisAngle(w.clone().normalize(), ang)).normalize();
}
// settle, then 60-0 mph with ABS
for (let i = 0; i < 480; i++) tick([0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0]);
console.log('settled CG height', pos.y.toFixed(3), '(config', cg, ') pitch/roll deg',
  (new THREE.Euler().setFromQuaternion(q).x * 57.3).toFixed(2), (new THREE.Euler().setFromQuaternion(q).z * 57.3).toFixed(2));
const v0 = 26.8224; v.set(0, 0, v0); M._rs_reset_motion(id, v0, 4);
for (let i = 0; i < 72; i++) tick([0, 0, 0.3, 1, 0, 0, 0, 2, 1, 0, 0, 0]);   // native: settle(0.3) at speed, brake 0.3
v.set(0, 0, v0);
const z0 = pos.z; let t = 0;
while (v.length() > 0.05 && t < 10) { tick([0, 0, 1, 1, 0, 0, 0, 2, 1, 0, 0, 0]); t += dt; }
console.log('60-0 mph ABS:', (pos.z - z0).toFixed(1), 'm in', t.toFixed(2), 's  (native reference 31.7 m), lateral drift', pos.x.toFixed(3), 'm');
