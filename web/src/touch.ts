// On-screen controls for phones and tablets (multi-touch, pointer events).
//   left half, bottom: steering pad - press anywhere, slide sideways (analog, relative to where
//                      the thumb landed; a knob shows the position)
//   right, bottom:     GAS and BRAKE pedals, handbrake (BRAKE held at a standstill = reverse:
//                      the core's pedal reverse, same as keyboard S)
//   top right:         reset, camera, gearbox auto/manual, fullscreen; shift up/down in manual
export interface TouchState {
  active: boolean;
  steer: number; throttle: number; brake: number; handbrake: number;
  shiftUp: boolean; shiftDown: boolean;
}

export interface TouchActions { reset(): void; camera(): void; toggleGearbox(): boolean; unlockAudio(): void; garage?(): void }

const STEER_RANGE_PX = 68;   // thumb travel for full lock (short enough for crisp, immediate response)

export class TouchControls {
  readonly state: TouchState = { active: false, steer: 0, throttle: 0, brake: 0, handbrake: 0, shiftUp: false, shiftDown: false };
  private root = document.createElement('div');

  constructor(private actions: TouchActions) {
    this.root.id = 'touch';
    this.root.innerHTML = `
      <div class="steer" data-c="steer"><div class="knob"></div><span class="hint">◀ steer ▶</span></div>
      <div class="pedals">
        <button class="pad hb" data-c="handbrake">HAND<br>BRAKE</button>
        <button class="pad brake" data-c="brake">BRAKE<br><small>hold: R</small></button>
        <button class="pad gas" data-c="gas">GAS</button>
      </div>
      <div class="shift" hidden>
        <button class="small" data-c="up">▲</button>
        <button class="small" data-c="down">▼</button>
      </div>
      <div class="top">
        <button class="small" data-c="garage" title="Back to Garage">← GARAGE</button>
        <button class="small" data-c="reset" title="Reset">⟲</button>
        <button class="small" data-c="camera" title="Camera">CAM</button>
        <button class="small" data-c="gearbox" title="Gearbox">AUTO</button>
        <button class="small" data-c="fullscreen" title="Fullscreen">⛶</button>
      </div>`;
    document.body.appendChild(this.root);
    const on = (c: string, f: (e: PointerEvent, el: HTMLElement) => void) => {
      const el = this.root.querySelector<HTMLElement>(`[data-c="${c}"]`)!;
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        this.state.active = true;
        this.actions.unlockAudio();
        f(e, el);
      });
      return el;
    };
    const hold = (c: string, set: (v: number) => void) => {
      const el = on(c, (_e, el) => { set(1); el.classList.add('down'); });
      const up = () => { set(0); el.classList.remove('down'); };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('lostpointercapture', up);
    };
    hold('gas', (v) => (this.state.throttle = v));
    hold('brake', (v) => (this.state.brake = v));
    hold('handbrake', (v) => (this.state.handbrake = v));
    on('up', () => (this.state.shiftUp = true));
    on('down', () => (this.state.shiftDown = true));
    on('garage', () => this.actions.garage?.());
    on('reset', () => this.actions.reset());
    on('camera', () => this.actions.camera());
    const gb = on('gearbox', (_e, el) => {
      const auto = this.actions.toggleGearbox();
      el.textContent = auto ? 'AUTO' : 'MAN';
      (this.root.querySelector('.shift') as HTMLElement).hidden = auto;
    });
    gb.textContent = 'AUTO';
    on('fullscreen', () => {
      const d = document.documentElement;
      if (document.fullscreenElement) void document.exitFullscreen();
      else d.requestFullscreen?.({ navigationUI: 'hide' }).then(() => {
        (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape').catch(() => {});
      }).catch(() => {});
    });

    // Steering pad: analog, relative to where the thumb first touched.
    const pad = this.root.querySelector<HTMLElement>('.steer')!;
    const knob = pad.querySelector<HTMLElement>('.knob')!;
    let id = -1, x0 = 0, lastDx = 0;
    pad.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (id !== -1) return;
      id = e.pointerId;
      pad.setPointerCapture(id);
      this.state.active = true;
      this.actions.unlockAudio();
      x0 = e.clientX;
      lastDx = 0;
      knob.style.left = `${e.clientX}px`;
      knob.style.top = `${e.clientY - (innerHeight - pad.offsetHeight)}px`;
      knob.style.transform = 'translate3d(-50%, -50%, 0)';
      knob.classList.add('on');
    });
    pad.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      const dx = Math.max(-STEER_RANGE_PX, Math.min(STEER_RANGE_PX, e.clientX - x0));
      this.state.steer = -dx / STEER_RANGE_PX;   // core: +1 = left
      if (Math.abs(dx - lastDx) >= 1) {
        lastDx = dx;
        knob.style.transform = `translate3d(calc(-50% + ${dx.toFixed(0)}px), -50%, 0)`;
      }
    });
    const release = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      id = -1;
      this.state.steer = 0;
      knob.style.transform = 'translate3d(-50%, -50%, 0)';
      knob.classList.remove('on');
    };
    pad.addEventListener('pointerup', release);
    pad.addEventListener('pointercancel', release);

    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Edge events are consumed once per physics tick. */
  takeShifts(): { up: boolean; down: boolean } {
    const r = { up: this.state.shiftUp, down: this.state.shiftDown };
    this.state.shiftUp = this.state.shiftDown = false;
    return r;
  }
}

/** Touch-first device (phone/tablet) or a touch actually used: show the on-screen controls. */
export function wantsTouch(): boolean {
  return matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 1 && !matchMedia('(pointer: fine)').matches;
}
