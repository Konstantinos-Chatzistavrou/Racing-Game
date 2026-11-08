// The driver in the seat (no cockpit view, so a figure seen through the glass is enough): suit, gloves, helmet with a
// design and a visor. Skins are bought in the Shop, equipped in the Garage, and are the player's avatar in
// multiplayer (lobby list as an SVG helmet, and in their car on everyone else's screen).
// Low poly (~2k triangles) and three materials whose looks are uniforms: changing skin never compiles a shader.
import * as THREE from 'three/webgpu';
import { Fn, abs, float, mix, positionLocal, smoothstep, uniform, vec3 } from 'three/tsl';
/** a colour uniform as an rgb node (the typings keep 'color' and 'vec3' apart; the shader does not) */
const rgb = (u: THREE.UniformNode<'color', THREE.Color>) => u as unknown as THREE.Node<'vec3'>;

export interface Skin {
  id: string; name: string; price: number;
  helmet: string; accent: string; visor: string; suit: string; gloves: string;
  /** helmet design: 0 solid, 1 centre stripe, 2 split crown, 3 chevron, 4 halves, 5 band */
  design: number;
}
export const SKINS: Skin[] = [
  { id: 'classic', name: 'Classic', price: 0, helmet: '#f4f4f6', accent: '#c0160f', visor: '#1a1d24', suit: '#e9e9ec', gloves: '#15171c', design: 1 },
  { id: 'midnight', name: 'Midnight', price: 2_500, helmet: '#15171c', accent: '#9aa0aa', visor: '#0c0e14', suit: '#202328', gloves: '#15171c', design: 5 },
  { id: 'rosso', name: 'Rosso', price: 4_000, helmet: '#c0160f', accent: '#f4f4f6', visor: '#1a1d24', suit: '#b3140e', gloves: '#f4f4f6', design: 2 },
  { id: 'volt', name: 'Volt', price: 6_000, helmet: '#e6c619', accent: '#15171c', visor: '#30260a', suit: '#15171c', gloves: '#e6c619', design: 3 },
  { id: 'glacier', name: 'Glacier', price: 6_000, helmet: '#f4f4f6', accent: '#2a9dff', visor: '#5a8fd0', suit: '#1d4ed8', gloves: '#f4f4f6', design: 4 },
  { id: 'neon', name: 'Neon', price: 9_000, helmet: '#d946a8', accent: '#14b8a6', visor: '#3a1550', suit: '#2b1838', gloves: '#14b8a6', design: 3 },
  { id: 'apex', name: 'Apex', price: 12_000, helmet: '#ff6a00', accent: '#1d4ed8', visor: '#1a1d24', suit: '#ff6a00', gloves: '#1d4ed8', design: 1 },
  { id: 'jade', name: 'Jade', price: 12_000, helmet: '#1f9d55', accent: '#f4f4f6', visor: '#0e2a1c', suit: '#14532d', gloves: '#f4f4f6', design: 2 },
  { id: 'royal', name: 'Royal', price: 18_000, helmet: '#6d28d9', accent: '#c8a24a', visor: '#c8a24a', suit: '#2e1065', gloves: '#c8a24a', design: 5 },
  { id: 'gold', name: 'Gold Rush', price: 25_000, helmet: '#c8a24a', accent: '#15171c', visor: '#6b4a10', suit: '#15171c', gloves: '#c8a24a', design: 4 },
];
export const skinOf = (id?: string) => SKINS.find((s) => s.id === id) ?? SKINS[0];

/** Side view of the helmet as inline SVG (lobby avatars, shop cards). */
export function helmetSvg(s: Skin, size = 34) {
  const d = s.design;
  const deco = d === 1 ? `<path d="M19 4 Q8 6 5 20" stroke="${s.accent}" stroke-width="4" fill="none"/>`
    : d === 2 ? `<path d="M4 15 Q6 4 20 3 Q31 4 33 14 Z" fill="${s.accent}"/>`
    : d === 3 ? `<path d="M7 11 L17 17 L28 9" stroke="${s.accent}" stroke-width="4" fill="none"/>`
    : d === 4 ? `<path d="M19 2 A16 16 0 0 1 35 18 L19 18 Z" fill="${s.accent}"/>`
    : d === 5 ? `<path d="M3 17 Q19 9 35 17" stroke="${s.accent}" stroke-width="4" fill="none"/>` : '';
  return `<svg class="helmet" viewBox="0 0 38 38" width="${size}" height="${size}" aria-hidden="true">
    <clipPath id="hc-${s.id}"><path d="M3 22 Q3 3 20 2 Q36 3 36 20 L36 31 Q30 35 20 35 L8 35 Q3 33 3 26 Z"/></clipPath>
    <g clip-path="url(#hc-${s.id})"><rect width="38" height="38" fill="${s.helmet}"/>${deco}</g>
    <path d="M14 17 Q24 13 36 16 L36 26 Q26 27 15 25 Q12 21 14 17 Z" fill="${s.visor}" stroke="#000" stroke-opacity=".35"/>
    <path d="M3 22 Q3 3 20 2 Q36 3 36 20 L36 31 Q30 35 20 35 L8 35 Q3 33 3 26 Z" fill="none" stroke="#000" stroke-opacity=".4"/></svg>`;
}

const capsule = (a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material) => {
  const len = a.distanceTo(b);
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(0.01, len), 3, 8), mat);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  return m;
};

export class Driver {
  readonly root = new THREE.Group();
  private arms = new THREE.Group();
  private head = new THREE.Group();
  private u = { helmet: uniform(new THREE.Color()), accent: uniform(new THREE.Color()), design: uniform(0) };
  private suit: THREE.MeshStandardMaterial;
  private gloves: THREE.MeshStandardMaterial;
  private visor: THREE.MeshPhysicalMaterial;
  private steer = 0;
  private roll = 0;

  /** seat: hip point in the car's model space (x = left, y = up, z = forward). */
  constructor(seat: THREE.Vector3) {
    this.root.name = 'wheel_driver';   // 'wheel_' prefix: the damage code never dents it
    this.root.position.copy(seat);
    this.suit = new THREE.MeshStandardMaterial({ color: 0xe9e9ec, roughness: 0.85, metalness: 0, name: 'driver_suit' });
    this.gloves = new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.7, metalness: 0, name: 'driver_gloves' });
    this.visor = new THREE.MeshPhysicalMaterial({ color: 0x1a1d24, roughness: 0.04, metalness: 0.9, clearcoat: 1, envMapIntensity: 1.6, name: 'driver_visor' });
    const helmet = new THREE.MeshPhysicalMaterial({ roughness: 0.25, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.05, name: 'driver_helmet' });
    const u = this.u;
    helmet.colorNode = Fn(() => {
      const p = positionLocal;
      const ax = abs(p.x);
      const is = (k: number) => float(1).sub(smoothstep(0.4, 0.6, abs(u.design.sub(k))));
      const stripe = float(1).sub(smoothstep(0.022, 0.03, ax)).mul(smoothstep(-0.02, 0.0, p.y));
      const crown = smoothstep(0.035, 0.045, p.y);
      const chev = smoothstep(0.0, 0.012, p.y.sub(ax.mul(0.55)).sub(0.01)).mul(float(1).sub(smoothstep(0.03, 0.042, p.y.sub(ax.mul(0.55)))));
      const halves = smoothstep(-0.005, 0.005, p.x);
      const band = smoothstep(0.0, 0.008, p.y).mul(float(1).sub(smoothstep(0.022, 0.03, p.y)));
      const mask = stripe.mul(is(1)).add(crown.mul(is(2))).add(chev.mul(is(3))).add(halves.mul(is(4))).add(band.mul(is(5))).clamp(0, 1);
      return mix(rgb(u.helmet), rgb(u.accent), mask);
    })();
    // torso, reclined like a sports-car seat; shoulders, neck
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, 0.3, 3, 10), this.suit);
    torso.position.set(0, 0.29, -0.06); torso.rotation.x = -0.38; torso.scale.set(1.15, 1, 0.8);
    const neck = capsule(new THREE.Vector3(0, 0.5, -0.14), new THREE.Vector3(0, 0.58, -0.13), 0.05, this.suit);
    // head: helmet (slightly long front to back) and visor
    const shell = new THREE.Mesh(new THREE.SphereGeometry(0.13, 20, 14), helmet);
    shell.scale.set(0.95, 1, 1.08);
    const visor = new THREE.Mesh(new THREE.SphereGeometry(0.133, 18, 8, -Math.PI * 0.32, Math.PI * 0.64, Math.PI * 0.36, Math.PI * 0.22), this.visor);
    visor.scale.set(0.96, 1, 1.09);
    visor.rotation.y = Math.PI / 2;   // the sphere's phi = 0 faces +x: turn the visor window to face +z (forward)
    this.head.add(shell, visor);
    this.head.position.set(0, 0.7, -0.11);
    // thighs toward the pedals (mostly hidden below the dash)
    const legs = [-1, 1].map((sx) => capsule(new THREE.Vector3(sx * 0.1, 0.06, 0.02), new THREE.Vector3(sx * 0.12, 0.12, 0.42), 0.075, this.suit));
    // arms to a wheel 0.42 m ahead of the chest; they turn with the steering (this.arms pivots at the wheel centre)
    const wheel = new THREE.Vector3(0, 0.4, 0.33);
    this.arms.position.copy(wheel);
    for (const sx of [-1, 1]) {
      const sh = new THREE.Vector3(sx * 0.19, 0.47, -0.12).sub(wheel), el = new THREE.Vector3(sx * 0.23, 0.31, 0.1).sub(wheel), ha = new THREE.Vector3(sx * 0.17, 0.0, 0);
      this.arms.add(capsule(sh, el, 0.05, this.suit), capsule(el, ha, 0.045, this.suit));
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), this.gloves);
      hand.position.copy(ha);
      this.arms.add(hand);
    }
    this.root.add(torso, neck, this.head, this.arms, ...legs);
    this.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = false; o.receiveShadow = true; } });
    this.setSkin(SKINS[0]);
  }

  setSkin(s: Skin) {
    this.u.helmet.value.set(s.helmet);
    this.u.accent.value.set(s.accent);
    this.u.design.value = s.design;
    this.suit.color.set(s.suit);
    this.gloves.color.set(s.gloves);
    this.visor.color.set(s.visor);
  }

  /** Every frame: steering (-1..1, + left) turns the arms; lateral g (m/s², + left) leans the head. */
  update(steer: number, latAccel: number, dt: number) {
    const k = Math.min(1, dt * 12);
    this.steer += (steer - this.steer) * k;
    this.roll += (Math.max(-1, Math.min(1, latAccel / 12)) - this.roll) * Math.min(1, dt * 5);
    this.arms.rotation.z = -this.steer * 0.9;   // wheel turned left: the left hand (+x) goes down
    this.head.rotation.z = this.roll * 0.18;    // cornering left: the head leans right (-x)
  }
}
