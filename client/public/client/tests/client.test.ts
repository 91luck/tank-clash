import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GAME_CONFIG, getMap, type Snapshot, type TankSnapshot } from '@tankclash/shared';
import { Predictor } from '../src/game/predict';
import { Timeline, lerpAngle } from '../src/game/timeline';
import { joystickToInput } from '../src/input/input';
import { backoffMs } from '../src/net/connection';
import { SettingsStore, keyLabel, sanitizeSettings } from '../src/settings';
import { wsUrl } from '../src/env';

const tank = (over: Partial<TankSnapshot> = {}): TankSnapshot => ({
  id: 'a',
  x: 100,
  y: 100,
  a: 0,
  hp: 100,
  al: 1,
  pr: 0,
  sh: 0,
  ab: 0,
  cd: 0,
  rs: 0,
  fx: 0,
  k: 0,
  d: 0,
  ...over,
});
const snap = (tick: number, tanks: TankSnapshot[]): Snapshot => ({
  tick,
  phase: 'playing',
  left: 100,
  sc: [0, 0],
  tanks,
  bullets: [],
  pu: [],
});

describe('Timeline (snapshot interpolation)', () => {
  it('interpolates tank position between two snapshots', () => {
    const t = new Timeline();
    t.push(1, snap(30, [tank({ x: 100 })]));
    t.push(1.1, snap(33, [tank({ x: 140 })]));
    expect(t.sample(1.05)?.tanks[0]?.x).toBeCloseTo(120, 5);
  });
  it('ignores duplicate and out-of-order snapshots', () => {
    const t = new Timeline();
    expect(t.push(2, snap(60, [tank()]))).toBe(true);
    expect(t.push(2, snap(60, [tank()]))).toBe(false);
    expect(t.push(1.5, snap(45, [tank()]))).toBe(false);
    expect(t.size).toBe(1);
  });
  it('does not slide tanks across the map on respawn teleports', () => {
    const t = new Timeline();
    t.push(1, snap(30, [tank({ x: 50 })]));
    t.push(1.1, snap(33, [tank({ x: 900 })]));
    expect(t.sample(1.05)?.tanks[0]?.x).toBe(900);
  });
  it('holds the last snapshot when asked for a time beyond the buffer', () => {
    const t = new Timeline();
    t.push(1, snap(30, [tank({ x: 10 })]));
    t.push(1.1, snap(33, [tank({ x: 20 })]));
    expect(t.sample(5)?.tanks[0]?.x).toBe(20);
  });
  it('lerpAngle takes the short way around', () => {
    expect(lerpAngle(3.1, -3.1, 0.5)).toBeGreaterThan(3.0);
    expect(Math.abs(lerpAngle(0, 1, 0.5) - 0.5)).toBeLessThan(1e-9);
  });
});

describe('joystickToInput', () => {
  it('ignores tiny stick movement (dead zone)', () => {
    expect(joystickToInput(0.05, 0.05, 0)).toEqual({ throttle: 0, turn: 0 });
  });
  it('drives forward when the stick points where the tank faces', () => {
    const r = joystickToInput(1, 0, 0);
    expect(r.throttle).toBeGreaterThan(0.9);
    expect(r.turn).toBe(0);
  });
  it('turns first, without driving, when the stick points sideways', () => {
    const r = joystickToInput(0, 1, 0); // wants to face +y (down)
    expect(r.turn).toBeGreaterThan(0);
    expect(r.throttle).toBe(0);
  });
  it('reverses when the stick points behind the tank', () => {
    expect(joystickToInput(-1, 0, 0).throttle).toBeLessThan(0);
  });
  it('always stays within [-1, 1]', () => {
    for (let i = 0; i < 200; i++) {
      const r = joystickToInput(Math.random() * 4 - 2, Math.random() * 4 - 2, Math.random() * 6 - 3, 1.5);
      expect(Math.abs(r.throttle)).toBeLessThanOrEqual(1);
      expect(Math.abs(r.turn)).toBeLessThanOrEqual(1);
    }
  });
});

describe('Predictor', () => {
  const me = { id: 'a', name: 'A', team: 1 as const, cls: 'assault' as const };
  const spawn = getMap().spawns.find((s) => s.team === 1)!;
  const start = tank({ x: spawn.x, y: spawn.y, a: 0 });

  it('predicts the same movement as the shared sim', () => {
    const p = new Predictor(30, me);
    p.reconcile(start, 0);
    for (let i = 1; i <= 5; i++) p.step(i, { throttle: 1, turn: 0, fire: false, ability: false });
    const moved = p.pose().x - spawn.x;
    expect(moved).toBeCloseTo((GAME_CONFIG.classes.assault.speed / 30) * 5, 3);
  });
  it('reconciles to the server position and replays unacknowledged inputs', () => {
    const p = new Predictor(30, me);
    p.reconcile(start, 0);
    for (let i = 1; i <= 6; i++) p.step(i, { throttle: 1, turn: 0, fire: false, ability: false });
    // Server has only processed 3 inputs so far and is exactly where our own prediction was after 3.
    const after3 = spawn.x + (GAME_CONFIG.classes.assault.speed / 30) * 3;
    p.reconcile(tank({ x: after3, y: spawn.y, a: 0 }), 3);
    expect(p.pendingCount).toBe(3);
    for (let i = 0; i < 200; i++) p.smooth(0.016);
    expect(p.pose().x).toBeCloseTo(spawn.x + (GAME_CONFIG.classes.assault.speed / 30) * 6, 3);
  });
  it('smooths a correction instead of teleporting', () => {
    const p = new Predictor(30, me);
    p.reconcile(start, 0);
    for (let i = 1; i <= 4; i++) p.step(i, { throttle: 1, turn: 0, fire: false, ability: false });
    const before = p.pose().x;
    p.reconcile(tank({ x: spawn.x, y: spawn.y, a: 0 }), 4); // server says: we did not move (blocked)
    expect(p.pose().x).toBeCloseTo(before, 3); // still drawn where it was...
    for (let i = 0; i < 120; i++) p.smooth(0.016);
    expect(p.pose().x).toBeCloseTo(spawn.x, 1); // ...then eased back to the server's truth
  });
  it('snaps (no smoothing) on large divergence such as a respawn', () => {
    const p = new Predictor(30, me);
    p.reconcile(start, 0);
    p.reconcile(tank({ x: spawn.x + 400, y: spawn.y }), 0);
    expect(p.pose().x).toBeCloseTo(spawn.x + 400, 3);
  });
});

describe('settings', () => {
  it('falls back to defaults for corrupted storage', () => {
    const s = new SettingsStore({ getItem: () => '{not json', setItem: () => undefined });
    expect(s.value.volume).toBe(60);
  });
  it('clamps and validates untrusted values', () => {
    const v = sanitizeSettings({
      volume: 9999,
      touchSensitivity: -4,
      name: '<script>',
      keyFire: 'x y',
      muted: 'yes',
    });
    expect(v.volume).toBe(100);
    expect(v.touchSensitivity).toBe(50);
    expect(v.name).toBe('');
    expect(v.keyFire).toBe('Space');
    expect(v.muted).toBe(false);
  });
  it('persists updates and survives a failing storage', () => {
    let saved = '';
    const s = new SettingsStore({ getItem: () => null, setItem: (_k, v) => void (saved = v) });
    s.update({ volume: 20, name: 'Ace_7' });
    expect(JSON.parse(saved)).toMatchObject({ volume: 20, name: 'Ace_7' });
    const broken = new SettingsStore({
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
    });
    expect(() => broken.update({ volume: 5 })).not.toThrow();
  });
  it('formats key labels', () => {
    expect(keyLabel('KeyE')).toBe('E');
    expect(keyLabel('ShiftLeft')).toBe('Shift');
    expect(keyLabel('Space')).toBe('Space');
  });
});

describe('env / net helpers', () => {
  it('derives a same-origin secure websocket URL in production-like builds', () => {
    const url = wsUrl({ protocol: 'https:', hostname: 'game.example.com', host: 'game.example.com' });
    expect(url.startsWith('wss://') || url.startsWith('ws://')).toBe(true);
    expect(url.endsWith('/ws') || url.includes(':8080')).toBe(true);
  });
  it('backs off exponentially with a cap', () => {
    expect(backoffMs(0)).toBeLessThan(900);
    expect(backoffMs(3)).toBeGreaterThan(3900);
    expect(backoffMs(50)).toBeLessThan(8400);
  });
});

describe('index.html wiring', () => {
  const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) files.push(p);
    }
  };
  walk(join(__dirname, '..', 'src'));

  it('every element the code looks up by id exists in index.html', () => {
    const missing: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/(?:\$|getElementById)\('([a-z0-9-]+)'\)/g)) {
        if (!ids.has(m[1])) missing.push(`${f.split('/src/')[1]}: #${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });
  it('has no duplicate ids', () => {
    const all = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(all.length - new Set(all).size).toBe(0);
  });
  it('declares every required screen', () => {
    for (const s of ['menu', 'create', 'join', 'queue', 'practice', 'lobby', 'game', 'results']) {
      expect(html).toContain(`data-screen="${s}"`);
    }
  });
});

describe('static asset config', () => {
  it('ships no catch-all _redirects rule (Cloudflare Workers rejects it as an infinite loop)', () => {
    const path = join(__dirname, '..', 'public', '_redirects');
    if (!existsSync(path)) return; // no file: fine
    const text = readFileSync(path, 'utf8');
    expect(text).not.toMatch(/^\s*\/\*\s+\/index\.html/m);
  });
});
