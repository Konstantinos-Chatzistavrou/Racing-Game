// Menus without a mouse: D-pad / left stick / arrow keys move a focus ring between the buttons (spatial: the nearest
// button in that direction), A / Cross / Enter presses it, B / Circle / Backspace goes back (resume, back button).
// Works for every standard-mapping pad (Xbox, PlayStation, Switch Pro, generic) and the keyboard; touch and mouse
// keep working as before (the ring only shows after a pad / arrow key was used).
const SEL = 'button[data-act]:not([disabled]), a.source-link, input[type=text], input[type=range], label.sw';

export class MenuNav {
  private prev = new Map<number, boolean[]>();
  private repeatAt = 0;
  private held = '';
  private focused: HTMLElement | null = null;
  active = false;
  /** off while a wheel is being calibrated (its buttons are being captured) */
  paused = false;
  private shown = false;

  constructor(private root: HTMLElement) {
    addEventListener('keydown', (e) => {
      if (this.paused || this.root.hidden || (e.target as HTMLElement)?.tagName === 'INPUT' && !['ArrowUp', 'ArrowDown'].includes(e.code)) return;
      const d = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.code] as [number, number] | undefined;
      if (d) { this.move(d[0], d[1]); e.preventDefault(); }
      else if (e.code === 'Enter' && this.active && this.focused) { this.focused.click(); e.preventDefault(); }
      else if (e.code === 'Backspace' && this.active) { this.back(); e.preventDefault(); }
    });
    addEventListener('pointerdown', () => this.clear());
  }

  private visible(): HTMLElement[] {
    return [...this.root.querySelectorAll<HTMLElement>(SEL)].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    });
  }

  private setFocus(el: HTMLElement | null) {
    this.focused?.classList.remove('nav-focus');
    this.focused = el;
    if (!el) return;
    el.classList.add('nav-focus');
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  private clear() { this.active = false; this.setFocus(null); }

  /** Move toward (dx, dy): the closest button whose centre lies in that direction (along-axis distance + 2x sideways). */
  move(dx: number, dy: number) {
    const els = this.visible();
    if (!els.length) return;
    this.active = true;
    if (!this.focused || !this.root.contains(this.focused) || !els.includes(this.focused)) {
      this.setFocus(els.find((e) => e.classList.contains('primary')) ?? els[0]);
      return;
    }
    if (dx && this.focused instanceof HTMLInputElement && this.focused.type === 'range') {
      const r = this.focused, st = Number(r.step) || 1;
      r.value = String(Math.max(Number(r.min), Math.min(Number(r.max), Number(r.value) + dx * st)));
      r.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    const a = this.focused.getBoundingClientRect(), ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    let best: HTMLElement | null = null, bs = Infinity;
    for (const el of els) {
      if (el === this.focused) continue;
      const b = el.getBoundingClientRect(), bx = b.left + b.width / 2, by = b.top + b.height / 2;
      const along = (bx - ax) * dx + (by - ay) * dy, side = Math.abs((bx - ax) * dy) + Math.abs((by - ay) * dx);
      if (along <= 4) continue;
      const score = along + 2 * side;
      if (score < bs) { bs = score; best = el; }
    }
    if (best) this.setFocus(best);
  }

  /** B / Circle: resume, else the screen's back button. */
  back() {
    const els = this.visible();
    const pick = els.find((e) => e.dataset.act === 'resume') ?? els.find((e) => e.classList.contains('back-btn')) ?? els.find((e) => e.dataset.act === 'c-back');
    pick?.click();
  }

  /** Every frame while a menu is up. */
  update(now: number) {
    if (this.root.hidden || this.paused) {
      // keep the button state current so a button held while the menu opens (Start that paused) is not a press
      if (this.root.hidden) { this.focused = null; this.shown = false; }
      for (const p of navigator.getGamepads?.() ?? []) if (p) this.prev.set(p.index, p.buttons.map((x) => x.pressed));
      return;
    }
    if (!this.shown) {
      // the menu just opened (maybe by the very Start press that is still down): take the buttons as they are now
      this.shown = true;
      for (const p of navigator.getGamepads?.() ?? []) if (p) this.prev.set(p.index, p.buttons.map((x) => x.pressed));
      return;
    }
    if (this.focused && !this.root.contains(this.focused)) {
      // the menu re-rendered: find the same button again, or start over
      const act = this.focused.dataset.act, v = this.focused.dataset.v;
      this.focused = null;
      if (this.active && act) this.setFocus(this.visible().find((e) => e.dataset.act === act && e.dataset.v === v) ?? null);
    }
    for (const p of navigator.getGamepads?.() ?? []) {
      if (!p || !p.connected) continue;
      const prev = this.prev.get(p.index) ?? [];
      const now2 = p.buttons.map((b) => b.pressed);
      this.prev.set(p.index, now2);
      const edge = (i: number) => !!now2[i] && !prev[i];
      if (p.mapping === 'standard') {
        if (edge(0)) { if (this.active && this.focused) this.focused.click(); else this.move(0, 1); }
        if (edge(1)) this.back();
        if (edge(9)) this.visible().find((e) => e.dataset.act === 'resume')?.click();   // Start / Options / Menu: resume
      }
      // direction: D-pad (standard 12-15) or the left stick, with key-repeat
      const ax = p.axes[0] ?? 0, ay = p.axes[1] ?? 0;
      let dir = '';
      if (now2[12] || ay < -0.6) dir = 'u'; else if (now2[13] || ay > 0.6) dir = 'd';
      else if (now2[14] || ax < -0.6) dir = 'l'; else if (now2[15] || ax > 0.6) dir = 'r';
      if (p.mapping !== 'standard' && !now2.some(Boolean)) dir = dir && Math.abs(ax) + Math.abs(ay) > 1.2 ? dir : '';   // wheels: ignore the steering axis
      if (!dir) { if (this.held && this.held.startsWith(p.index + ':')) this.held = ''; continue; }
      const key = `${p.index}:${dir}`;
      if (key !== this.held || now >= this.repeatAt) {
        this.repeatAt = now + (key !== this.held ? 380 : 130);
        this.held = key;
        this.move(dir === 'l' ? -1 : dir === 'r' ? 1 : 0, dir === 'u' ? -1 : dir === 'd' ? 1 : 0);
      }
    }
  }
}
