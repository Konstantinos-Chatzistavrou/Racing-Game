// All game audio, synthesized with the Web Audio API (no sample files). One AudioContext; browsers
// only start it after a user gesture, so unlock() runs on the first key press / touch.
//
// Engine: pitch = firing frequency = rpm/60 * cylinders/2 (V8: 4 pulses per crank turn, 60 Hz at
//   idle -> 500 Hz at the 7500 rpm redline). Sawtooth + half-order rumble + square rasp + combustion
//   noise -> distortion and a low-pass whose cutoff opens with throttle (on power: raspy; lifting
//   off: muffled overrun). Cylinder count is an assumption (V8, like the C7 the handling matches).
// Tyres: band-passed noise once the core's slip angle passes ~6 deg or slip ratio ~12 %, scaled by
//   the tyre load; pitch rises with slip.
// Wind: noise, level ~ speed^2.
// Crashes: low thud + metal clanks + glass, scaled by crash energy from the core.
import { OUT } from './physics/core';

const CYLINDERS = 8;

export class GameAudio {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  private out: GainNode | null = null;
  private eng: {
    o1: OscillatorNode; o2: OscillatorNode; o3: OscillatorNode; nf: BiquadFilterNode; ng: GainNode;
    lp: BiquadFilterNode; shaper: WaveShaperNode; g: GainNode;
  } | null = null;
  private tyre: { f: BiquadFilterNode; g: GainNode } | null = null;
  private wind: { f: BiquadFilterNode; g: GainNode } | null = null;
  muted = false;

  unlock() {
    if (!this.ctx) this.prepare();
    if (this.ctx!.state !== 'running') void this.ctx!.resume();
  }

  /**
   * Builds the context and the synth graph. Called during loading: creating an AudioContext opens
   * the audio device synchronously (~170 ms of main thread measured), which used to freeze the
   * first frame after the first key press. Before a user gesture the context just stays
   * suspended (silent); unlock() resumes it.
   */
  prepare() {
    if (this.ctx) return;
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0.8;
    const comp = ctx.createDynamicsCompressor();   // big crashes stack layers: keep them from clipping
    comp.threshold.value = -12;
    this.out.connect(comp).connect(ctx.destination);
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.buildEngine();
    this.tyre = this.loopNoise('bandpass', 1100, 7);
    this.wind = this.loopNoise('lowpass', 500, 0.7);
  }

  private loopNoise(type: BiquadFilterType, freq: number, q: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(f).connect(g).connect(this.out!);
    src.start();
    return { f, g };
  }

  private buildEngine() {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 2.5;
    const shaper = ctx.createWaveShaper();
    shaper.curve = distortion(6);
    shaper.oversample = '2x';
    const mix = ctx.createGain();
    mix.gain.value = 0.35;
    const osc = (type: OscillatorType, level: number) => {
      const o = ctx.createOscillator();
      o.type = type;
      const og = ctx.createGain();
      og.gain.value = level;
      o.connect(og).connect(mix);
      o.start();
      return o;
    };
    const o1 = osc('sawtooth', 0.8);     // firing order
    const o2 = osc('sawtooth', 0.55);    // half order: the V8 burble/rumble
    const o3 = osc('square', 0.18);      // double order: rasp
    const n = ctx.createBufferSource();  // combustion roughness
    n.buffer = this.noise;
    n.loop = true;
    const nf = ctx.createBiquadFilter();
    nf.type = 'bandpass';
    nf.Q.value = 1.2;
    const ng = ctx.createGain();
    ng.gain.value = 0;
    n.connect(nf).connect(ng).connect(mix);
    n.start();
    mix.connect(shaper).connect(lp).connect(g).connect(this.out!);
    this.eng = { o1, o2, o3, nf, ng, lp, shaper, g };
  }

  /** Every frame with the core's output. */
  update(out: Float64Array, speed: number) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.eng) return;
    const t = ctx.currentTime, tc = 0.03;
    const rpm = Math.max(500, out[OUT.rpm]);
    const thr = out[OUT.throttle];
    const stalled = out[OUT.stalled] > 0.5;
    const f = (rpm / 60) * (CYLINDERS / 2);
    const jitter = 1 + (Math.random() - 0.5) * 0.006;   // a real engine never holds a pure tone
    const e = this.eng;
    e.o1.frequency.setTargetAtTime(f * jitter, t, tc);
    e.o2.frequency.setTargetAtTime(f * 0.5, t, tc);
    e.o3.frequency.setTargetAtTime(f * 2.01, t, tc);
    e.nf.frequency.setTargetAtTime(f * 3, t, tc);
    e.ng.gain.setTargetAtTime(0.15 + 0.5 * thr, t, tc);
    const load = 0.25 + 0.75 * thr;
    e.lp.frequency.setTargetAtTime(220 + f * (1.5 + 5 * load), t, tc);   // opens with throttle
    const master = this.muted || stalled ? 0 : 0.12 + 0.22 * load + 0.08 * Math.min(1, rpm / 7000);
    e.g.gain.setTargetAtTime(master, t, 0.05);

    // tyres: worst slipping wheel, weighted by its load
    let squeal = 0, slip = 0;
    for (let i = 0; i < 4; i++) {
      const o = OUT.wheel(i);
      if (out[o + 5] < 0.5) continue;
      const sa = Math.abs(out[o + 8]) * 57.3, sr = Math.abs(out[o + 7]);
      const s = Math.max((sa - 6) / 8, (sr - 0.12) / 0.25);
      const w = Math.min(1.3, out[o + 6] / 4000);
      if (s * w > squeal) { squeal = s * w; slip = s; }
    }
    squeal = Math.max(0, Math.min(1, squeal)) * Math.min(1, Math.abs(speed) / 4);
    this.tyre!.g.gain.setTargetAtTime(this.muted ? 0 : squeal * 0.35, t, 0.05);
    this.tyre!.f.frequency.setTargetAtTime(950 + 450 * Math.min(1.5, slip), t, 0.05);

    const v = Math.min(1, Math.abs(speed) / 70);
    this.wind!.g.gain.setTargetAtTime(this.muted ? 0 : v * v * 0.3, t, 0.2);
    this.wind!.f.frequency.setTargetAtTime(300 + 900 * v, t, 0.2);
  }

  /** kj: crash energy from the core's damage report; glass: a light or window just broke. */
  impact(kj: number, glass: boolean) {
    const ctx = this.ctx;
    if (!ctx || !this.out || ctx.state !== 'running' || this.muted) return;
    const s = Math.min(1, Math.sqrt(kj / 60));   // ~60 kJ (a 40 km/h wall hit) = full scale
    if (s < 0.05) return;
    const t = ctx.currentTime;
    this.burst(t, 0.45 * s + 0.15, 'lowpass', 160, 0.7, 0.9 * s);   // body thud
    const o = ctx.createOscillator();
    const og = ctx.createGain();
    o.frequency.setValueAtTime(70, t);
    o.frequency.exponentialRampToValueAtTime(32, t + 0.35);
    og.gain.setValueAtTime(0.8 * s, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    o.connect(og).connect(this.out);
    o.start(t);
    o.stop(t + 0.45);
    const clanks = 4 + Math.round(10 * s);                           // metal crunch
    for (let i = 0; i < clanks; i++) {
      this.burst(t + Math.random() * (0.08 + 0.25 * s), 0.05 + Math.random() * 0.12, 'bandpass', 500 + Math.random() * 2600, 4 + Math.random() * 8, 0.45 * s);
    }
    if (glass) {
      for (let i = 0; i < 26; i++) this.burst(t + 0.02 + Math.random() * 0.5, 0.02 + Math.random() * 0.05, 'bandpass', 4500 + Math.random() * 5000, 12, 0.22);
    }
  }

  private burst(at: number, len: number, type: BiquadFilterType, freq: number, q: number, gain: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, at + len);
    src.connect(f).connect(g).connect(this.out!);
    src.start(at, Math.random() * 1.5, len + 0.05);
  }
}

function distortion(k: number): Float32Array<ArrayBuffer> {
  const n = 1024, c = new Float32Array(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return c;
}
