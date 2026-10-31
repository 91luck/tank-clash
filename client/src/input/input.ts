import { NEUTRAL_INPUT, normalizeAngle, type TankInput } from '@tankclash/shared';
import type { Settings } from '../settings';

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * Converts a touch-joystick vector into tank controls.
 * Tanks steer by rotating, which is awkward on a joystick, so the stick sets a *desired heading*: the tank turns
 * toward it and drives forward (or reverses when the stick points mostly backwards).
 * `vx, vy` are in [-1, 1] screen/world axes (y down), `angle` is the tank's current heading.
 */
export function joystickToInput(
  vx: number,
  vy: number,
  angle: number,
  sensitivity = 1,
): { throttle: number; turn: number } {
  const mag = Math.min(1, Math.hypot(vx, vy));
  const deadzone = 0.18;
  if (mag < deadzone) return { throttle: 0, turn: 0 };
  const strength = clamp(((mag - deadzone) / (1 - deadzone)) * sensitivity, 0, 1);
  const desired = Math.atan2(vy, vx);
  let diff = normalizeAngle(desired - angle);
  let dir = 1;
  if (Math.abs(diff) > 2.2) {
    // Stick points behind the tank: back up while turning the short way round.
    dir = -1;
    diff = normalizeAngle(desired + Math.PI - angle);
  }
  const turn = clamp(diff * 3.5 * sensitivity, -1, 1);
  const aligned = Math.abs(diff) < 0.9;
  return { throttle: aligned ? dir * strength : 0, turn: Math.abs(diff) < 0.04 ? 0 : turn };
}

const MOVE_UP = new Set(['KeyW', 'ArrowUp']);
const MOVE_DOWN = new Set(['KeyS', 'ArrowDown']);
const MOVE_LEFT = new Set(['KeyA', 'ArrowLeft']);
const MOVE_RIGHT = new Set(['KeyD', 'ArrowRight']);
const EXTRA_ABILITY = new Set(['ShiftLeft', 'ShiftRight']);
const EXTRA_FIRE = new Set(['KeyJ']);
const GAME_KEYS = new Set([
  ...MOVE_UP,
  ...MOVE_DOWN,
  ...MOVE_LEFT,
  ...MOVE_RIGHT,
  ...EXTRA_ABILITY,
  ...EXTRA_FIRE,
  'Space',
]);

export function isFormField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export interface InputOptions {
  settings: () => Settings;
  /** Current heading of the local tank (for joystick heading-follow). */
  getAngle: () => number;
  /** Keyboard game controls only work while a match is on screen and nothing modal is open. */
  isActive: () => boolean;
  onPause: () => void;
}

export class InputController {
  private keys = new Set<string>();
  private joy: { id: number; ox: number; oy: number; vx: number; vy: number } | null = null;
  private touchFire = new Set<number>();
  private touchAbility = new Set<number>();
  private captureNext: ((code: string) => void) | null = null;

  constructor(private readonly opts: InputOptions) {}

  attach(): void {
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.releaseAll();
    });
    this.attachTouch();
  }

  /** Used by the settings screen: the next key pressed is reported instead of being treated as game input. */
  captureKey(cb: (code: string) => void): void {
    this.captureNext = cb;
  }

  releaseAll(): void {
    this.keys.clear();
    this.touchFire.clear();
    this.touchAbility.clear();
    this.joy = null;
    document.getElementById('joy-base')?.classList.remove('active');
    document.getElementById('btn-touch-fire')?.classList.remove('down');
    document.getElementById('btn-touch-ability')?.classList.remove('down');
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (this.captureNext && down) {
      e.preventDefault();
      const cb = this.captureNext;
      this.captureNext = null;
      cb(e.code);
      return;
    }
    if (e.code === 'Escape' && down && !e.repeat) {
      this.opts.onPause();
      return;
    }
    // Never hijack typing in the name/room-code boxes or dropdowns.
    if (isFormField(e.target)) return;
    const s = this.opts.settings();
    const relevant = GAME_KEYS.has(e.code) || e.code === s.keyFire || e.code === s.keyAbility;
    if (!relevant || !this.opts.isActive()) {
      if (!down) this.keys.delete(e.code);
      return;
    }
    e.preventDefault(); // no page scrolling with arrows/space during play
    if (down) this.keys.add(e.code);
    else this.keys.delete(e.code);
  }

  private anyKey(codes: Iterable<string>): boolean {
    for (const c of codes) if (this.keys.has(c)) return true;
    return false;
  }

  /** Current intention, sampled once per client tick. */
  read(): TankInput {
    const s = this.opts.settings();
    let throttle = (this.anyKey(MOVE_UP) ? 1 : 0) - (this.anyKey(MOVE_DOWN) ? 1 : 0);
    let turn = (this.anyKey(MOVE_RIGHT) ? 1 : 0) - (this.anyKey(MOVE_LEFT) ? 1 : 0);
    const fire = this.keys.has(s.keyFire) || this.anyKey(EXTRA_FIRE) || this.touchFire.size > 0;
    const ability = this.keys.has(s.keyAbility) || this.anyKey(EXTRA_ABILITY) || this.touchAbility.size > 0;
    if (this.joy) {
      const j = joystickToInput(this.joy.vx, this.joy.vy, this.opts.getAngle(), s.touchSensitivity / 100);
      if (j.throttle !== 0 || j.turn !== 0) {
        throttle = j.throttle;
        turn = j.turn;
      }
    }
    if (!this.opts.isActive()) return { ...NEUTRAL_INPUT };
    return { throttle, turn, fire, ability };
  }

  // ------------------------------------------------------------ touch

  private attachTouch(): void {
    const zone = document.getElementById('joy-zone');
    const base = document.getElementById('joy-base');
    const knob = document.getElementById('joy-knob');
    if (zone && base && knob) {
      const R = 56;
      zone.addEventListener('pointerdown', (e) => {
        if (this.joy) return; // only one finger drives the stick; others stay free for the buttons
        e.preventDefault();
        zone.setPointerCapture(e.pointerId);
        const r = zone.getBoundingClientRect();
        const ox = e.clientX - r.left;
        const oy = e.clientY - r.top;
        this.joy = { id: e.pointerId, ox: e.clientX, oy: e.clientY, vx: 0, vy: 0 };
        base.style.left = `${ox}px`;
        base.style.top = `${oy}px`;
        base.classList.add('active');
        knob.style.transform = 'translate(0,0)';
      });
      zone.addEventListener('pointermove', (e) => {
        if (!this.joy || this.joy.id !== e.pointerId) return;
        e.preventDefault();
        let dx = e.clientX - this.joy.ox;
        let dy = e.clientY - this.joy.oy;
        const d = Math.hypot(dx, dy);
        if (d > R) {
          dx = (dx / d) * R;
          dy = (dy / d) * R;
        }
        this.joy.vx = dx / R;
        this.joy.vy = dy / R;
        knob.style.transform = `translate(${dx}px, ${dy}px)`;
      });
      const end = (e: PointerEvent): void => {
        if (!this.joy || this.joy.id !== e.pointerId) return;
        this.joy = null;
        base.classList.remove('active');
      };
      zone.addEventListener('pointerup', end);
      zone.addEventListener('pointercancel', end);
      zone.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    const bindButton = (id: string, set: Set<number>): void => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        set.add(e.pointerId);
        el.classList.add('down');
      });
      const up = (e: PointerEvent): void => {
        set.delete(e.pointerId);
        if (set.size === 0) el.classList.remove('down');
      };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('lostpointercapture', up);
      el.addEventListener('contextmenu', (e) => e.preventDefault());
    };
    bindButton('btn-touch-fire', this.touchFire);
    bindButton('btn-touch-ability', this.touchAbility);
  }
}
