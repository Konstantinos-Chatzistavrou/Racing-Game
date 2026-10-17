import { OUT, type AssistToggles, type CarInfo } from './physics/core';

const $ = (id: string) => document.getElementById(id)!;

export class Hud {
  private frames: number[] = [];
  private last = 0;
  extra = '';

  show() { ($('hud') as HTMLElement).hidden = false; $('loading').remove(); }
  toggle() { const h = $('hud') as HTMLElement; h.hidden = !h.hidden; }

  update(now: number, out: Float64Array, info: CarInfo, assists: AssistToggles) {
    this.frames.push(now);
    while (this.frames.length && this.frames[0] < now - 1000) this.frames.shift();
    if (now - this.last < 100) return;   // DOM updates at 10 Hz
    this.last = now;
    const fps = this.frames.length;
    const worst = this.frames.reduce((m, t, i, a) => (i ? Math.max(m, t - a[i - 1]) : m), 0);
    $('perf').textContent = `${fps} fps   worst ${worst.toFixed(1)} ms\n${this.extra}`;
    $('speed').textContent = Math.round(Math.abs(out[OUT.speed]) * 3.6).toString();
    const g = out[OUT.gear];
    $('gear').textContent = g === 0 ? 'R' : g === 1 ? 'N' : String(g - 1);
    const f = Math.min(1, out[OUT.rpm] / info.redline);
    const fill = $('rpmfill');
    fill.style.width = `${(f * 100).toFixed(1)}%`;
    fill.classList.toggle('red', f > 0.92);
    const on = (n: string, v: boolean, act = false) => (v ? `<b>${act ? '● ' : ''}${n}</b>` : n);
    $('assists').innerHTML = [
      on('ABS', assists.abs, out[OUT.abs] > 0), on('TC', assists.tc, out[OUT.tc] > 0.01),
      on('ESC', assists.esc, out[OUT.esc] !== 0), on('AUTO', assists.autoGearbox),
    ].join(' · ');
  }
}
