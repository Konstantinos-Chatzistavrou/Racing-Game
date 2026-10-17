// Crash audio, synthesized (no sample files): a low body thud, a metal crunch made of short
// band-passed noise "clanks", and glass when lights break. Loudness and length scale with the
// crash energy the core reports. Browsers only allow audio after a user gesture: unlock() is
// called on the first key press / touch.
export class CrashAudio {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  private out: GainNode | null = null;

  unlock() {
    if (this.ctx) { void this.ctx.resume(); return; }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor();   // big crashes stack layers: keep them from clipping
    this.out.connect(comp).connect(ctx.destination);
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  /** kj: crash energy from the core's damage report; glass: a light or window just broke. */
  impact(kj: number, glass: boolean) {
    const ctx = this.ctx;
    if (!ctx || !this.out || ctx.state !== 'running') return;
    const s = Math.min(1, Math.sqrt(kj / 60));   // ~60 kJ (a 40 km/h wall hit) = full scale
    if (s < 0.05) return;
    const t = ctx.currentTime;
    // body thud: low-passed noise + a falling sine
    this.burst(t, 0.45 * s + 0.15, 'lowpass', 160, 0.7, 0.9 * s);
    const o = ctx.createOscillator();
    const og = ctx.createGain();
    o.frequency.setValueAtTime(70, t);
    o.frequency.exponentialRampToValueAtTime(32, t + 0.35);
    og.gain.setValueAtTime(0.8 * s, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    o.connect(og).connect(this.out);
    o.start(t);
    o.stop(t + 0.45);
    // metal crunch: clanks at random pitches over the first part of the hit
    const clanks = 4 + Math.round(10 * s);
    for (let i = 0; i < clanks; i++) {
      const at = t + Math.random() * (0.08 + 0.25 * s);
      this.burst(at, 0.05 + Math.random() * 0.12, 'bandpass', 500 + Math.random() * 2600, 4 + Math.random() * 8, 0.45 * s);
    }
    // glass: many tiny bright ticks
    if (glass) {
      for (let i = 0; i < 26; i++) {
        this.burst(t + 0.02 + Math.random() * 0.5, 0.02 + Math.random() * 0.05, 'bandpass', 4500 + Math.random() * 5000, 12, 0.22);
      }
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
    src.start(at, Math.random() * 0.5, len + 0.05);
  }
}
