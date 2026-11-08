// The loading screen for everything after boot: starting a session, swapping the car in the garage.
// Smooth by construction: the spinner and the progress shimmer are CSS transform animations, which the browser runs
// on its compositor thread, so they keep moving even while the main thread is busy compiling shaders or uploading a
// model. The game waits behind it until frames are steady, then it fades out: the player sees a loading screen,
// never a frozen picture.
const TIPS = [
  'Assists can be changed any time from the pause menu.',
  'The driving line turns red where you need to brake from the speed you are doing.',
  'The Kestrel GT stops shortest and grips hardest in fast corners.',
  'The Harrier GT has 800 N m from 2500 rpm: easy on the throttle out of slow corners.',
  'Races pay by finishing position. Longer races pay more.',
  'Free roam pays for every kilometre you drive.',
  'Full Realism: a wreck, a rollover or 30 s stuck is a DNF.',
  'Controllers, wheels and phones all work: see Settings → Controls.',
];

export class Loader {
  private el: HTMLDivElement;
  private msg: HTMLElement;
  private tip: HTMLElement;
  private tipTimer = 0;
  private hideTimer = 0;
  shown = false;
  /** while set, hide() requests are ignored (the game is still warming up behind the screen) */
  hold = false;

  constructor() {
    this.el = document.createElement('div');
    this.el.id = 'loader';
    this.el.hidden = true;
    this.el.innerHTML = `<div class="load-box">
        <div class="load-brand">OPEN<span>GRID</span></div>
        <div class="ld-ring"><i></i></div>
        <div class="load-msg"></div>
        <div class="ld-bar"><i></i></div>
        <div class="ld-tip"></div>
      </div>`;
    document.body.appendChild(this.el);
    this.msg = this.el.querySelector('.load-msg')!;
    this.tip = this.el.querySelector('.ld-tip')!;
  }

  /** Show (or retitle) the screen. Resolves once it is on screen (two frames), so heavy work can start behind it. */
  show(text: string): Promise<void> {
    clearTimeout(this.hideTimer);
    this.msg.textContent = text;
    if (!this.shown) {
      this.shown = true;
      this.el.hidden = false;
      this.el.classList.remove('out');
      void this.el.offsetWidth;
      this.el.classList.add('in');
      this.nextTip();
      clearInterval(this.tipTimer);
      this.tipTimer = window.setInterval(() => this.nextTip(), 4500);
    }
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  }

  text(t: string) { this.msg.textContent = t; }

  private nextTip() { this.tip.textContent = 'Tip · ' + TIPS[Math.floor(Math.random() * TIPS.length)]; }

  /** Fade out (unless held). */
  hide() {
    if (!this.shown || this.hold) return;
    this.shown = false;
    clearInterval(this.tipTimer);
    this.el.classList.remove('in');
    this.el.classList.add('out');
    this.hideTimer = window.setTimeout(() => { this.el.hidden = true; }, 380);
  }
}

/**
 * Resolves when the game renders steadily again: `count` consecutive frames under `ms`, or after `maxMs`.
 * Used behind the loading screen so it lifts onto a smooth picture.
 */
export function steadyFrames(count = 6, ms = 70, maxMs = 8000): Promise<void> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let prev = t0, ok = 0;
    const f = (t: number) => {
      ok = t - prev < ms ? ok + 1 : 0;
      prev = t;
      if (ok >= count || t - t0 > maxMs) resolve(); else requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
}
