// Physical Web Audio synthesizer for Open Grid:
// - Cross-plane V8 engine with custom Fourier blowdown PeriodicWave, dual-bank exhaust comb filter,
//   acoustic header/muffler formant resonators, intake induction roar, straight-cut GT gearbox whine,
//   upshift ignition-cut bark, and lift-off overrun exhaust crackles/pops.
// - Dedicated physical collision & destruction synthesizers:
//   * breakPoleSound(): hollow steel tube modal ringing + bolt shear snap + secondary asphalt clang & electric sparks
//   * breakGlassShopSound(): tempered plate-glass flex thump + wide-band shatter + 45+ crystalline shard chimes
//   * breakWallSound(): heavy structural masonry/concrete demolition + falling brick rubble + glass shatter
import { OUT } from './physics/core';

const CYLINDERS = 8;

export class GameAudio {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  private out: GainNode | null = null;
  private eng: {
    o1: OscillatorNode;
    oMain: OscillatorNode;
    oSub: OscillatorNode;
    oBank: OscillatorNode;
    oGear: OscillatorNode;
    gearGain: GainNode;
    combDelayL: DelayNode;
    combDelayR: DelayNode;
    formant1: BiquadFilterNode;
    formant2: BiquadFilterNode;
    formant3: BiquadFilterNode;
    intakeFilter: BiquadFilterNode;
    intakeGain: GainNode;
    exhaustFilter: BiquadFilterNode;
    exhaustGain: GainNode;
    lp: BiquadFilterNode;
    shaper: WaveShaperNode;
    g: GainNode;
  } | null = null;
  private tyre: { f: BiquadFilterNode; f2: BiquadFilterNode; g: GainNode } | null = null;
  private wind: { f: BiquadFilterNode; g: GainNode } | null = null;
  private lastGear = 1;
  private lastRpm = 800;
  private nextCrackleAt = 0;
  muted = false;

  unlock() {
    if (!this.ctx) this.prepare();
    if (this.ctx!.state !== 'running') void this.ctx!.resume();
  }

  prepare() {
    if (this.ctx) return;
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0.85;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.knee.value = 8;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.12;
    this.out.connect(comp).connect(ctx.destination);

    // 3-second pink-ish + white noise buffer for combustion, wind, tyre scrub, and debris
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.997 * b0 + w * 0.029;
      b1 = 0.985 * b1 + w * 0.032;
      b2 = 0.950 * b2 + w * 0.048;
      d[i] = Math.max(-1, Math.min(1, (w * 0.55 + (b0 + b1 + b2) * 0.45)));
    }
    this.buildEngine();
    this.tyre = this.buildTyreSynth();
    this.wind = this.loopNoise('lowpass', 420, 0.7);
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

  private buildTyreSynth() {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 980;
    f.Q.value = 5.5;
    const f2 = ctx.createBiquadFilter();
    f2.type = 'peaking';
    f2.frequency.value = 1850;
    f2.Q.value = 4.0;
    f2.gain.value = 8;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(f).connect(f2).connect(g).connect(this.out!);
    src.start();
    return { f, f2, g };
  }

  private buildEngine() {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.value = 0;

    // Custom Fourier PeriodicWave modeling a 4-stroke cylinder blowdown pressure pulse
    const nHarm = 24;
    const real = new Float32Array(nHarm);
    const imag = new Float32Array(nHarm);
    for (let k = 1; k < nHarm; k++) {
      // Exponentially decaying asymmetric exhaust pulse with strong even & 3rd/5th harmonics
      const env = Math.exp(-k * 0.115) * (1 + 0.35 * Math.sin(k * 1.1));
      real[k] = env * Math.cos(k * 0.42) * 0.6;
      imag[k] = env * Math.sin(k * 0.42 + 0.3);
    }
    const pulseWave = ctx.createPeriodicWave(real, imag, { disableNormalization: false });

    // Cross-plane V8 uneven firing order sub-harmonic wave (90-180-90-180 degree bank cadence)
    const subReal = new Float32Array(nHarm);
    const subImag = new Float32Array(nHarm);
    const weights = [0, 0.9, 1.0, 0.75, 0.6, 0.85, 0.45, 0.35, 0.5, 0.25, 0.2, 0.15];
    for (let k = 1; k < weights.length; k++) {
      subImag[k] = weights[k];
      subReal[k] = weights[k] * 0.35 * (k % 2 === 1 ? 1 : -1);
    }
    const v8Wave = ctx.createPeriodicWave(subReal, subImag, { disableNormalization: false });

    const preMix = ctx.createGain();
    preMix.gain.value = 0.42;

    const mkOsc = (wave: PeriodicWave, level: number) => {
      const o = ctx.createOscillator();
      o.setPeriodicWave(wave);
      const og = ctx.createGain();
      og.gain.value = level;
      o.connect(og).connect(preMix);
      o.start();
      return o;
    };

    const oMain = mkOsc(pulseWave, 0.78);  // Primary firing frequency (4 pulses/rev)
    const oSub = mkOsc(v8Wave, 0.68);      // Half-order cross-plane V8 burble (1x & 0.5x crank)
    const oBank = mkOsc(pulseWave, 0.36);  // Secondary bank slightly detuned (+1.5x harmonic)

    // Dual-exhaust pipe waveguide comb filter (left & right exhaust banks meeting at X-pipe)
    const combDelayL = ctx.createDelay(0.02);
    combDelayL.delayTime.value = 0.0024;
    const combDelayR = ctx.createDelay(0.02);
    combDelayR.delayTime.value = 0.0041;
    const combMix = ctx.createGain();
    combMix.gain.value = 0.75;
    preMix.connect(combDelayL).connect(combMix);
    preMix.connect(combDelayR).connect(combMix);
    preMix.connect(combMix);

    // Exhaust pulse turbulent gas flow noise
    const exNoise = ctx.createBufferSource();
    exNoise.buffer = this.noise;
    exNoise.loop = true;
    const exhaustFilter = ctx.createBiquadFilter();
    exhaustFilter.type = 'bandpass';
    exhaustFilter.Q.value = 1.6;
    const exhaustGain = ctx.createGain();
    exhaustGain.gain.value = 0;
    exNoise.connect(exhaustFilter).connect(exhaustGain).connect(combMix);
    exNoise.start();

    // Intake manifold induction roar (opens sharply above 50% throttle)
    const inNoise = ctx.createBufferSource();
    inNoise.buffer = this.noise;
    inNoise.loop = true;
    const intakeFilter = ctx.createBiquadFilter();
    intakeFilter.type = 'bandpass';
    intakeFilter.Q.value = 2.4;
    const intakeGain = ctx.createGain();
    intakeGain.gain.value = 0;
    inNoise.connect(intakeFilter).connect(intakeGain).connect(combMix);
    inNoise.start();

    // Acoustic exhaust & engine-bay formant filters (gives chesty real-car resonance instead of raw synth buzz)
    const formant1 = ctx.createBiquadFilter();
    formant1.type = 'peaking';
    formant1.frequency.value = 118;  // Deep exhaust muffler resonance
    formant1.Q.value = 2.2;
    formant1.gain.value = 7.5;

    const formant2 = ctx.createBiquadFilter();
    formant2.type = 'peaking';
    formant2.frequency.value = 340;  // V8 mid-range chest growl
    formant2.Q.value = 1.8;
    formant2.gain.value = 5.0;

    const formant3 = ctx.createBiquadFilter();
    formant3.type = 'peaking';
    formant3.frequency.value = 1280; // High-RPM header metallic rasp
    formant3.Q.value = 2.5;
    formant3.gain.value = 4.5;

    const shaper = ctx.createWaveShaper();
    shaper.curve = distortion(4.2);
    shaper.oversample = '2x';

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 1.4;

    // Straight-cut GT sequential transmission whine (audible inside/behind race cars as speed climbs)
    const oGear = ctx.createOscillator();
    oGear.type = 'triangle';
    const gearFilter = ctx.createBiquadFilter();
    gearFilter.type = 'bandpass';
    gearFilter.frequency.value = 1400;
    gearFilter.Q.value = 4.5;
    const gearGain = ctx.createGain();
    gearGain.gain.value = 0;
    oGear.connect(gearFilter).connect(gearGain).connect(g);
    oGear.start();

    combMix
      .connect(shaper)
      .connect(formant1)
      .connect(formant2)
      .connect(formant3)
      .connect(lp)
      .connect(g)
      .connect(this.out!);

    this.eng = {
      o1: oMain, oMain, oSub, oBank, oGear, gearGain,
      combDelayL, combDelayR,
      formant1, formant2, formant3,
      intakeFilter, intakeGain, exhaustFilter, exhaustGain,
      lp, shaper, g,
    };
  }

  /** Every frame with the core's output. */
  update(out: Float64Array, speed: number) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.eng) return;
    const t = ctx.currentTime, tc = 0.024;
    const rpm = Math.max(650, out[OUT.rpm]);
    const thr = out[OUT.throttle];
    const gear = Math.round(out[OUT.gear]);
    const stalled = out[OUT.stalled] > 0.5;
    const f = (rpm / 60) * (CYLINDERS / 2);

    // Idle lope & combustion cycle-to-cycle micro-instability
    const idleFactor = Math.max(0, 1 - (rpm - 650) / 900);
    const lope = 1 + Math.sin(t * 19.5) * 0.022 * idleFactor + (Math.random() - 0.5) * 0.008;
    const e = this.eng;
    e.oMain.frequency.setTargetAtTime(f * lope, t, tc);
    e.oSub.frequency.setTargetAtTime(f * 0.25 * lope, t, tc);
    e.oBank.frequency.setTargetAtTime(f * 0.75 * (2 - lope), t, tc);

    // Exhaust gas flow & intake induction roar
    const rpmNorm = Math.min(1, (rpm - 650) / 6850);
    const load = 0.18 + 0.82 * thr;
    e.exhaustFilter.frequency.setTargetAtTime(160 + f * 1.9, t, tc);
    e.exhaustGain.gain.setTargetAtTime(0.18 + 0.42 * load + 0.22 * rpmNorm, t, tc);

    e.intakeFilter.frequency.setTargetAtTime(280 + f * 2.8, t, tc);
    e.intakeGain.gain.setTargetAtTime(thr * thr * (0.28 + 0.35 * rpmNorm), t, tc);

    // Dynamic low-pass opens with throttle and RPM; closes on lift-off overrun for deep muffler burble
    const cutoff = 320 + f * (2.2 + 5.8 * load) + rpmNorm * 1800 * thr;
    e.lp.frequency.setTargetAtTime(cutoff, t, tc);

    // Subtle GT transmission gear whine proportional to wheel speed + engine load
    const absSpeed = Math.abs(speed);
    const gearFreq = Math.max(240, absSpeed * 28 + rpm * 0.12);
    e.oGear.frequency.setTargetAtTime(gearFreq, t, 0.03);
    const whineLevel = this.muted || stalled ? 0 : Math.min(0.038, (absSpeed / 65) * 0.026 * (0.4 + 0.6 * thr));
    e.gearGain.gain.setTargetAtTime(whineLevel, t, 0.04);

    const master = this.muted || stalled ? 0 : 0.16 + 0.24 * load + 0.10 * rpmNorm;
    e.g.gain.setTargetAtTime(master, t, 0.04);

    // Gearshift ignition-cut bark when shifting up or down under load
    if (gear !== this.lastGear && !this.muted && !stalled) {
      if (gear > this.lastGear && this.lastRpm > 3200) {
        this.shiftBark(t, Math.min(1, (this.lastRpm - 2500) / 4800));
      }
      this.lastGear = gear;
    }
    this.lastRpm = rpm;

    // Lift-off overrun exhaust pops & crackles when decelerating from high RPM
    if (!this.muted && !stalled && thr < 0.08 && rpm > 2900 && t > this.nextCrackleAt) {
      this.exhaustPop(t, Math.min(1, (rpm - 2600) / 4500));
      this.nextCrackleAt = t + 0.045 + Math.random() * 0.14;
    }

    // Tyres: dual-formant rubber scrub + tread squeal weighted by normal load
    let squeal = 0, slip = 0;
    for (let i = 0; i < 4; i++) {
      const o = OUT.wheel(i);
      if (out[o + 5] < 0.5) continue;
      const sa = Math.abs(out[o + 8]) * 57.3, sr = Math.abs(out[o + 7]);
      const s = Math.max((sa - 5.5) / 8, (sr - 0.11) / 0.25);
      const w = Math.min(1.3, out[o + 6] / 4000);
      if (s * w > squeal) { squeal = s * w; slip = s; }
    }
    squeal = Math.max(0, Math.min(1, squeal)) * Math.min(1, absSpeed / 3.5);
    this.tyre!.g.gain.setTargetAtTime(this.muted ? 0 : squeal * 0.28, t, 0.04);
    this.tyre!.f.frequency.setTargetAtTime(780 + 380 * Math.min(1.6, slip), t, 0.04);
    this.tyre!.f2.frequency.setTargetAtTime(1520 + 620 * Math.min(1.6, slip), t, 0.04);

    const v = Math.min(1, absSpeed / 70);
    this.wind!.g.gain.setTargetAtTime(this.muted ? 0 : v * v * 0.26, t, 0.18);
    this.wind!.f.frequency.setTargetAtTime(260 + 820 * v, t, 0.18);
  }

  /** Brief ignition-cut exhaust thump on high-RPM upshifts. */
  private shiftBark(t: number, intensity: number) {
    this.burst(t, 0.075, 'bandpass', 190 + Math.random() * 70, 1.4, 0.38 * intensity);
    this.tone(t, 0.065, 115, 48, 'sawtooth', 0.22 * intensity);
  }

  /** Exhaust header pop / burble on high-RPM throttle lift-off. */
  private exhaustPop(t: number, intensity: number) {
    const g = (0.14 + Math.random() * 0.18) * intensity;
    this.burst(t, 0.038 + Math.random() * 0.03, 'bandpass', 240 + Math.random() * 260, 1.8, g);
    this.tone(t, 0.04, 130 + Math.random() * 50, 42, 'triangle', g * 0.65);
  }

  /**
   * Breakable sound router & physical crash synthesizer:
   * - kind === 'pole' -> hollow steel streetlamp / signal pole shear + modal ringing + asphalt bounce
   * - kind === 'shop' -> tempered plate-glass storefront explosion + 45+ crystalline falling shards
   * - kind === 'wall' -> ground-floor masonry/concrete building wall breach + falling rubble + glass shatter
   */
  impact(kj: number, glass: boolean, kind?: 'pole' | 'shop' | 'wall') {
    const ctx = this.ctx;
    if (!ctx || !this.out || ctx.state !== 'running' || this.muted) return;
    const s = Math.min(1, Math.max(0.18, Math.sqrt(kj / 55)));
    const t = ctx.currentTime;

    if (kind === 'pole') {
      this.playPoleBreak(t, s);
      return;
    }
    if (kind === 'shop') {
      this.playStorefrontShatter(t, s);
      return;
    }
    if (kind === 'wall') {
      this.playWallBreach(t, s);
      return;
    }

    // Standard car-to-wall / car-to-car chassis impact
    this.tone(t, 0.32, 92, 26, 'sine', 0.75 * s);
    this.burst(t, 0.28 * s + 0.12, 'lowpass', 210, 0.9, 0.72 * s);
    // Sheet-metal crumple & suspension clang modes
    const modes = [310, 485, 760, 1180, 1840];
    for (let i = 0; i < modes.length; i++) {
      const d = i * 0.012 + Math.random() * 0.04;
      const f = modes[i] * (0.92 + Math.random() * 0.16);
      this.tone(t + d, 0.12 + Math.random() * 0.14, f, f * 0.86, 'triangle', 0.16 * s);
      this.burst(t + d, 0.06 + Math.random() * 0.08, 'bandpass', f * 1.4, 5.5, 0.24 * s);
    }
    if (glass) {
      this.playGlassShards(t + 0.015, s * 0.85, 22);
    }
  }

  /** Hollow cast-iron/steel pole sheared off its base + inharmonic tubular ringing + secondary road impact. */
  private playPoleBreak(t: number, s: number) {
    // 1. Cast-iron flange bolt snap & bumper thump
    this.tone(t, 0.24, 118, 34, 'sine', 0.72 * s);
    this.burst(t, 0.09, 'bandpass', 1450, 3.2, 0.58 * s);
    this.burst(t, 0.18, 'lowpass', 260, 1.1, 0.62 * s);

    // 2. Hollow steel cylinder modal ringing (inharmonic bending modes of a 6-9m tapered steel shaft)
    const tubeModes = [192, 338, 584, 945, 1490, 2260];
    for (let i = 0; i < tubeModes.length; i++) {
      const f0 = tubeModes[i] * (0.95 + Math.random() * 0.1);
      const decay = (0.48 - i * 0.055) * (0.8 + 0.3 * s);
      this.tone(t + 0.005 * i, Math.max(0.12, decay), f0, f0 * 0.985, i % 2 === 0 ? 'sine' : 'triangle', (0.22 / (1 + i * 0.35)) * s);
    }

    // 3. Secondary metallic clang & scrape when the tumbling pole hits the wet asphalt (~0.36s later)
    const tBounce = t + 0.34 + Math.random() * 0.12;
    this.tone(tBounce, 0.28, 225, 218, 'triangle', 0.24 * s);
    this.tone(tBounce, 0.22, 640, 620, 'sine', 0.18 * s);
    this.burst(tBounce, 0.16, 'bandpass', 1850, 4.0, 0.25 * s);
  }

  /** Plate-glass storefront window flexing inward, detonating, and raining 40+ crystalline shards onto the sidewalk. */
  private playStorefrontShatter(t: number, s: number) {
    // 1. Large tempered glass pane membrane flex & frame punch
    this.tone(t, 0.19, 138, 42, 'sine', 0.68 * s);
    this.burst(t, 0.14, 'bandpass', 620, 1.8, 0.52 * s);
    // 2. High-energy plate-glass fracture crack
    this.burst(t + 0.006, 0.11, 'highpass', 2800, 1.5, 0.65 * s);
    this.burst(t + 0.015, 0.22, 'bandpass', 5200, 2.2, 0.48 * s);
    // 3. Cascading crystalline glass shards bouncing on concrete sidewalk
    this.playGlassShards(t + 0.01, s, 44);
  }

  /** Full ground-floor building wall demolition: seismic masonry/brick collapse + steel mullion shear + glass shatter. */
  private playWallBreach(t: number, s: number) {
    // 1. Deep structural masonry & concrete wall punch
    this.tone(t, 0.48, 68, 20, 'sine', 0.92 * s);
    this.tone(t, 0.32, 125, 38, 'triangle', 0.65 * s);
    this.burst(t, 0.42, 'lowpass', 195, 0.85, 0.88 * s);
    this.burst(t + 0.02, 0.35, 'bandpass', 420, 1.4, 0.65 * s);

    // 2. Tumbling brick & concrete chunks slamming onto the floor over 0.06..0.75s
    for (let i = 0; i < 16; i++) {
      const dt = 0.05 + Math.random() * 0.68;
      const f = 140 + Math.random() * 380;
      const g = (0.18 + Math.random() * 0.22) * s * (1 - dt * 0.7);
      this.burst(t + dt, 0.055 + Math.random() * 0.07, 'bandpass', f, 2.6, g);
      this.tone(t + dt, 0.05, f * 0.75, f * 0.45, 'sine', g * 0.7);
    }

    // 3. Storefront plate glass & steel frame shattering simultaneously
    this.playStorefrontShatter(t + 0.01, s * 0.95);
  }

  /** Crystalline high-Q modal pings for individual tempered glass shards hitting pavement. */
  private playGlassShards(t0: number, s: number, count: number) {
    for (let i = 0; i < count; i++) {
      // Exponential distribution in time: dense burst immediately, trailing tinkles up to 0.95s
      const u = Math.random();
      const dt = u * u * 0.88 + Math.random() * 0.04;
      const freq = 3100 + Math.random() * 7800;
      const dur = 0.022 + Math.random() * 0.055;
      const amp = (0.045 + Math.random() * 0.065) * s * (1 - u * 0.55);
      this.tone(t0 + dt, dur, freq, freq * 0.97, 'sine', amp);
      if (i % 2 === 0) {
        this.burst(t0 + dt, dur * 0.7, 'bandpass', freq * 1.15, 14, amp * 0.85);
      }
    }
  }

  private tone(at: number, len: number, fStart: number, fEnd: number, type: OscillatorType, gain: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(16, fStart), at);
    o.frequency.exponentialRampToValueAtTime(Math.max(16, fEnd), at + len);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), at + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, at + len);
    o.connect(g).connect(this.out!);
    o.start(at);
    o.stop(at + len + 0.02);
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
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), at + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, at + len);
    src.connect(f).connect(g).connect(this.out!);
    src.start(at, Math.random() * 2.0, len + 0.05);
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
