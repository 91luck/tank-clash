import { describe, expect, it } from 'vitest';
import {
  BotController,
  GAME_CONFIG,
  Sim,
  TILE_DESTRUCTIBLE,
  buildMap,
  getMap,
  MAP_SOURCES,
  POWERUP_KINDS,
  validateMap,
  secondsToTicks,
  type SimEvent,
  type Tank,
  type TeamId,
} from '../src';

const TPS = GAME_CONFIG.tickRate;

function makeSim(opts: ConstructorParameters<typeof Sim>[0] = {}) {
  const sim = new Sim({ seed: 7, ...opts });
  const a = sim.addTank({ id: 'a', name: 'Alpha', team: 1, cls: 'assault' });
  const b = sim.addTank({ id: 'b', name: 'Bravo', team: 2, cls: 'assault' });
  return { sim, a, b };
}

function startPlaying(sim: Sim): void {
  let guard = 0;
  while (sim.phase === 'countdown' && guard++ < 10_000) sim.step();
}

function place(t: Tank, x: number, y: number, angle = 0): void {
  t.x = x;
  t.y = y;
  t.angle = angle;
}

function stepN(sim: Sim, n: number): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < n; i++) {
    sim.step();
    events.push(...sim.drainEvents());
  }
  return events;
}

const fwd = { throttle: 1, turn: 0, fire: false, ability: false };
const idle = { throttle: 0, turn: 0, fire: false, ability: false };

describe('map', () => {
  it('builds a valid, symmetric map', () => {
    const map = getMap();
    expect(validateMap(map)).toEqual([]);
    expect(map.spawns.filter((s) => s.team === 1)).toHaveLength(
      map.spawns.filter((s) => s.team === 2).length,
    );
    expect(map.walls.length).toBeGreaterThan(10);
  });

  it('every registered map passes validation', () => {
    for (const src of MAP_SOURCES) expect(validateMap(buildMap(src))).toEqual([]);
  });

  it('validation catches a spawn placed inside a wall', () => {
    const map = buildMap(MAP_SOURCES[0]!);
    map.tiles[map.cols + 1] = 1; // tile under the first team-1 spawn
    expect(validateMap(map).some((e) => e.includes('spawn overlaps a wall'))).toBe(true);
  });

  it('validation catches an open boundary', () => {
    const map = buildMap(MAP_SOURCES[0]!);
    map.tiles[5] = 0;
    expect(validateMap(map).some((e) => e.includes('open boundary'))).toBe(true);
  });

  it('spawns never overlap solid or destructible tiles', () => {
    const map = getMap();
    for (const s of map.spawns) {
      const idx = Math.floor(s.y / map.tileSize) * map.cols + Math.floor(s.x / map.tileSize);
      expect(map.tiles[idx]).toBe(0);
    }
  });
});

describe('movement', () => {
  it('moves forward by speed * dt each tick and is deterministic', () => {
    const { sim, a, b } = makeSim();
    startPlaying(sim);
    place(a, 200, 48);
    place(b, 900, 600);
    sim.setInput('a', fwd);
    stepN(sim, TPS); // exactly one second
    expect(a.x).toBeCloseTo(200 + GAME_CONFIG.classes.assault.speed, 0);
    expect(a.y).toBeCloseTo(48, 3);
  });

  it('produces identical results for identical seeds and inputs', () => {
    const run = () => {
      const { sim, a, b } = makeSim();
      startPlaying(sim);
      place(a, 200, 300);
      place(b, 800, 300, Math.PI);
      sim.setInput('a', { throttle: 1, turn: 0.4, fire: true, ability: false });
      sim.setInput('b', { throttle: 1, turn: -0.2, fire: true, ability: false });
      stepN(sim, 200);
      return JSON.stringify(sim.snapshot(true));
    };
    expect(run()).toBe(run());
  });

  it('rotates at the class turn rate', () => {
    const { sim, a, b } = makeSim();
    startPlaying(sim);
    place(a, 200, 300, 0);
    place(b, 900, 600);
    sim.setInput('a', { ...idle, turn: 1 });
    stepN(sim, TPS / 2);
    expect(a.angle).toBeCloseTo(GAME_CONFIG.classes.assault.turnRate * 0.5, 2);
  });

  it('reverse is slower than forward', () => {
    const { sim, a, b } = makeSim();
    startPlaying(sim);
    place(a, 300, 48);
    place(b, 900, 600);
    sim.setInput('a', { ...idle, throttle: -1 });
    stepN(sim, TPS / 2);
    const cfg = GAME_CONFIG.classes.assault;
    expect(300 - a.x).toBeCloseTo(cfg.speed * cfg.reverseFactor * 0.5, 0);
  });

  it('cannot leave the map or pass through solid walls', () => {
    const { sim, a, b } = makeSim();
    startPlaying(sim);
    place(a, 100, 48, Math.PI); // facing the left boundary wall
    place(b, 900, 600);
    sim.setInput('a', fwd);
    stepN(sim, TPS * 3);
    expect(a.x).toBeGreaterThanOrEqual(GAME_CONFIG.tileSize + GAME_CONFIG.tank.radius - 0.01);
  });

  it('cannot pass through standing destructible walls', () => {
    const { sim, a, b } = makeSim();
    startPlaying(sim);
    const wall = sim.map.walls[0]!;
    place(a, (wall.col - 3) * sim.map.tileSize + 16, wall.row * sim.map.tileSize + 16, 0);
    place(b, 900, 600);
    sim.setInput('a', fwd);
    stepN(sim, TPS * 2);
    expect(a.x).toBeLessThan(wall.col * sim.map.tileSize);
  });

  it('tanks cannot drive through each other', () => {
    const { sim, a, b } = makeSim();
    startPlaying(sim);
    place(a, 300, 48, 0);
    place(b, 345, 48, Math.PI);
    sim.setInput('a', fwd);
    stepN(sim, TPS);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(GAME_CONFIG.tank.radius * 2 - 0.5);
  });

  it('clamps out-of-range and non-finite input values server-side', () => {
    const { sim, a, b } = makeSim();
    startPlaying(sim);
    place(a, 200, 48);
    place(b, 900, 600);
    sim.setInput('a', { throttle: 99, turn: Number.NaN, fire: false, ability: false });
    stepN(sim, TPS);
    expect(a.x - 200).toBeLessThanOrEqual(GAME_CONFIG.classes.assault.speed + 0.5);
    expect(Number.isFinite(a.angle)).toBe(true);
  });

  it('cannot move before the countdown finishes', () => {
    const { sim, a } = makeSim();
    const x0 = a.x;
    sim.setInput('a', fwd);
    stepN(sim, 10);
    expect(a.x).toBe(x0);
    expect(sim.phase).toBe('countdown');
  });
});

describe('shooting and projectiles', () => {
  it('enforces fire cooldown', () => {
    const { sim, a, b } = makeSim();
    startPlaying(sim);
    place(a, 200, 48, 0);
    place(b, 900, 600);
    sim.setInput('a', { ...idle, fire: true });
    const ev = stepN(sim, 31);
    const cd = secondsToTicks(GAME_CONFIG.classes.assault.fireCooldown);
    expect(ev.filter((e) => e.e === 'shot')).toHaveLength(Math.floor(30 / cd) + 1);
  });

  it('bullets travel at the configured speed', () => {
    const { sim, a, b } = makeSim();
    startPlaying(sim);
    place(a, 200, 48, 0);
    place(b, 900, 600);
    sim.setInput('a', { ...idle, fire: true });
    stepN(sim, 1);
    sim.setInput('a', idle);
    const x0 = sim.bullets[0]!.x;
    stepN(sim, 3);
    expect(sim.bullets[0]!.x - x0).toBeCloseTo((GAME_CONFIG.bullet.speed * 3) / TPS, 0);
  });

  it('limits live bullets per tank', () => {
    const { sim, a, b } = makeSim();
    startPlaying(sim);
    place(a, 100, 48, 0);
    place(b, 900, 600);
    a.fireReadyTick = 0;
    for (let i = 0; i < 20; i++) {
      a.fireReadyTick = 0;
      sim.setInput('a', { ...idle, fire: true });
      stepN(sim, 1);
    }
    expect(sim.bullets.filter((x) => x.owner === 'a').length).toBeLessThanOrEqual(
      GAME_CONFIG.bullet.maxPerTank,
    );
  });

  it('bullets are stopped by solid walls', () => {
    const { sim, a, b } = makeSim();
    startPlaying(sim);
    place(a, 60, 48, Math.PI); // fire at the boundary
    place(b, 900, 600);
    sim.setInput('a', { ...idle, fire: true });
    const ev = stepN(sim, 5);
    expect(ev.some((e) => e.e === 'solidHit')).toBe(true);
    expect(sim.bullets).toHaveLength(0);
  });

  it('destructible walls take 3 hits, then disappear and stop blocking', () => {
    const { sim, a, b } = makeSim();
    startPlaying(sim);
    const wall = sim.map.walls[0]!;
    const ts = sim.map.tileSize;
    const wy = wall.row * ts + ts / 2;
    place(a, wall.col * ts - 70, wy, 0);
    place(b, 900, 600);
    sim.setInput('a', { ...idle, fire: true });
    const ev = stepN(sim, TPS * 6);
    expect(ev.filter((e) => e.e === 'wallHit').length).toBeGreaterThanOrEqual(
      GAME_CONFIG.walls.destructibleHp,
    );
    expect(ev.some((e) => e.e === 'wallDown' && e.wall === wall.id)).toBe(true);
    expect(sim.isBlockedTile(wall.col, wall.row)).toBe(false);
    expect(sim.map.tiles[wall.row * sim.map.cols + wall.col]).toBe(TILE_DESTRUCTIBLE); // static map is untouched
    expect(sim.snapshot(true).wd).toContain(wall.id);
  });

  it('a destroyed wall no longer blocks movement', () => {
    const { sim, a, b } = makeSim();
    startPlaying(sim);
    const wall = sim.map.walls[0]!;
    const ts = sim.map.tileSize;
    sim.wallHp[wall.id] = 0;
    place(a, (wall.col - 2) * ts + 16, wall.row * ts + 16, 0);
    place(b, 900, 600);
    sim.setInput('a', fwd);
    stepN(sim, 20);
    expect(a.x).toBeGreaterThan(wall.col * ts);
  });
});

describe('damage, kills and respawn', () => {
  function shootAt(sim: Sim, shooter: Tank, victim: Tank) {
    place(shooter, 300, 48, 0);
    place(victim, 380, 48, Math.PI);
    victim.protectUntil = 0;
    sim.setInput(shooter.id, { ...idle, fire: true });
  }

  it('applies class damage on hit', () => {
    const { sim, a, b } = makeSim();
    startPlaying(sim);
    shootAt(sim, a, b);
    stepN(sim, 6);
    sim.setInput('a', idle);
    expect(b.hp).toBe(b.maxHp - GAME_CONFIG.classes.assault.damage);
  });

  it('does not damage spawn-protected tanks', () => {
    const { sim, a, b } = makeSim();
    startPlaying(sim);
    shootAt(sim, a, b);
    b.protectUntil = sim.tick + 1000;
    stepN(sim, 6);
    expect(b.hp).toBe(b.maxHp);
  });

  it('friendly fire is disabled: bullets pass through teammates', () => {
    const sim = new Sim({ seed: 1 });
    const a = sim.addTank({ id: 'a', name: 'A', team: 1, cls: 'assault' });
    const c = sim.addTank({ id: 'c', name: 'C', team: 1, cls: 'assault' });
    sim.addTank({ id: 'b', name: 'B', team: 2, cls: 'assault' });
    startPlaying(sim);
    place(a, 300, 48, 0);
    place(c, 380, 48, 0);
    c.protectUntil = 0;
    sim.setInput('a', { ...idle, fire: true });
    stepN(sim, 10);
    expect(c.hp).toBe(c.maxHp);
  });

  it('never awards duplicate kills when two bullets land on the same tick', () => {
    const { sim, a, b } = makeSim();
    const c = sim.addTank({ id: 'c', name: 'C', team: 1, cls: 'assault' });
    startPlaying(sim);
    place(a, 100, 100);
    place(c, 100, 200);
    place(b, 600, 300);
    b.hp = 5;
    b.protectUntil = 0;
    for (const owner of ['a', 'c'] as const) {
      sim.bullets.push({
        id: 900 + sim.bullets.length,
        owner,
        team: 1,
        x: b.x,
        y: b.y,
        vx: 0,
        vy: 0,
        angle: 0,
        expireTick: sim.tick + 50,
        damage: 20,
        lag: 0,
        bounces: 0,
      });
    }
    const ev = stepN(sim, 1);
    expect(ev.filter((e) => e.e === 'kill')).toHaveLength(1);
    expect(sim.scores[1]).toBe(1);
    expect(a.kills + c.kills).toBe(1);
    expect(b.deaths).toBe(1);
  });

  it('respawns after exactly the respawn delay, at full health, with spawn protection', () => {
    const { sim, a, b } = makeSim();
    startPlaying(sim);
    b.hp = 1;
    b.protectUntil = 0;
    place(a, 300, 48, 0);
    place(b, 380, 48, Math.PI);
    sim.setInput('a', { ...idle, fire: true });
    stepN(sim, 6);
    sim.setInput('a', idle);
    expect(b.alive).toBe(false);
    const delay = secondsToTicks(sim.settings.respawnSec);
    const killTick = b.respawnTick - delay;
    while (sim.tick < killTick + delay - 1) stepN(sim, 1);
    expect(b.alive).toBe(false);
    stepN(sim, 1);
    expect(b.alive).toBe(true);
    expect(b.hp).toBe(b.maxHp);
    expect(sim.tick).toBeLessThan(b.protectUntil);
  });

  it('dead tanks cannot move or shoot', () => {
    const { sim, a, b } = makeSim();
    startPlaying(sim);
    b.alive = false;
    b.respawnTick = sim.tick + 1000;
    place(b, 500, 300, 0);
    sim.setInput('b', { throttle: 1, turn: 0, fire: true, ability: true });
    const ev = stepN(sim, 10);
    expect(b.x).toBe(500);
    expect(ev.some((e) => e.e === 'shot')).toBe(false);
    expect(a.alive).toBe(true);
  });
});

describe('abilities', () => {
  it('Rapid Fire shortens the fire cooldown and then goes on cooldown', () => {
    const { sim, a, b } = makeSim();
    startPlaying(sim);
    place(a, 200, 48);
    place(b, 900, 600);
    const normal = sim.fireCooldownTicks(a);
    sim.setInput('a', { ...idle, ability: true });
    stepN(sim, 1);
    expect(sim.fireCooldownTicks(a)).toBeLessThan(normal);
    sim.setInput('a', { ...idle, ability: false });
    stepN(sim, 1);
    // re-pressing during cooldown does nothing
    const readyAt = a.abilityReadyTick;
    sim.setInput('a', { ...idle, ability: true });
    stepN(sim, 1);
    expect(a.abilityReadyTick).toBe(readyAt);
  });

  it('ability is edge-triggered and obeys its cooldown, then works again', () => {
    const { sim, b } = makeSim();
    startPlaying(sim);
    place(b, 900, 600);
    sim.setInput('a', { ...idle, ability: true });
    const first = stepN(sim, 5).filter((e) => e.e === 'ability');
    expect(first).toHaveLength(1); // holding the button does not retrigger
    sim.setInput('a', idle);
    stepN(sim, secondsToTicks(GAME_CONFIG.classes.assault.ability.cooldown) + 2);
    sim.setInput('a', { ...idle, ability: true });
    expect(stepN(sim, 1).filter((e) => e.e === 'ability')).toHaveLength(1);
  });

  it('Heavy shield absorbs damage before health and does not stack', () => {
    const sim = new Sim({ seed: 1 });
    const h = sim.addTank({ id: 'h', name: 'H', team: 1, cls: 'heavy' });
    const e = sim.addTank({ id: 'e', name: 'E', team: 2, cls: 'assault' });
    startPlaying(sim);
    place(h, 300, 48, 0);
    place(e, 900, 600);
    h.protectUntil = 0;
    sim.setInput('h', { ...idle, ability: true });
    stepN(sim, 1);
    const cap = GAME_CONFIG.classes.heavy.ability.shieldHp!;
    expect(h.shieldHp).toBe(cap);
    // two hits of 20 are absorbed by the 60-point shield
    for (let i = 0; i < 2; i++)
      sim.bullets.push({
        id: 700 + i,
        owner: 'e',
        team: 2,
        x: h.x,
        y: h.y,
        vx: 0,
        vy: 0,
        angle: 0,
        expireTick: sim.tick + 20,
        damage: 20,
        lag: 0,
        bounces: 0,
      });
    stepN(sim, 1);
    expect(h.hp).toBe(h.maxHp);
    expect(h.shieldHp).toBe(cap - 40);
    // picking up a shield power-up never exceeds max(cap, powerup shield)
    sim.powerups.push({ id: 1, kind: 'shield', x: h.x, y: h.y, expireTick: sim.tick + 100 });
    stepN(sim, 1);
    expect(h.shieldHp).toBeLessThanOrEqual(Math.max(cap, GAME_CONFIG.powerups.shieldHp));
  });

  it('Scout speed boost multiplies speed but never beyond the global cap', () => {
    const sim = new Sim({ seed: 1 });
    const s = sim.addTank({ id: 's', name: 'S', team: 1, cls: 'scout' });
    sim.addTank({ id: 'e', name: 'E', team: 2, cls: 'assault' });
    startPlaying(sim);
    s.abilityActiveUntil = sim.tick + 100;
    s.speedBoostUntil = sim.tick + 100;
    expect(sim.speedMultiplier(s)).toBe(GAME_CONFIG.tank.maxSpeedMultiplier);
  });

  it('fire cooldown never drops below the configured floor', () => {
    const { sim, a } = makeSim();
    startPlaying(sim);
    a.abilityActiveUntil = sim.tick + 100;
    a.rapidUntil = sim.tick + 100;
    expect(sim.fireCooldownTicks(a)).toBeGreaterThanOrEqual(secondsToTicks(GAME_CONFIG.tank.minFireCooldown));
  });
});

describe('power-ups', () => {
  it('are collected exactly once and apply their effect', () => {
    const { sim, a, b } = makeSim();
    startPlaying(sim);
    place(a, 300, 48);
    place(b, 300, 48 + 20); // overlapping the same pickup
    b.x = 300;
    a.hp = 50;
    sim.powerups.push({ id: 5, kind: 'health', x: 300, y: 60, expireTick: sim.tick + 500 });
    const ev = stepN(sim, 2);
    expect(ev.filter((e) => e.e === 'powerTake')).toHaveLength(1);
    expect(sim.powerups).toHaveLength(0);
    stepN(sim, 5);
    expect(sim.powerups).toHaveLength(0);
  });

  it('health recovery never exceeds max health', () => {
    const { sim, a, b } = makeSim();
    startPlaying(sim);
    place(a, 300, 48);
    place(b, 900, 600);
    a.hp = a.maxHp - 5;
    sim.powerups.push({ id: 5, kind: 'health', x: 300, y: 48, expireTick: sim.tick + 500 });
    stepN(sim, 1);
    expect(a.hp).toBe(a.maxHp);
  });

  it('speed and rapid boosts expire', () => {
    const { sim, a, b } = makeSim();
    startPlaying(sim);
    place(a, 300, 48);
    place(b, 900, 600);
    sim.powerups.push({ id: 1, kind: 'speed', x: 300, y: 48, expireTick: sim.tick + 500 });
    stepN(sim, 1);
    expect(sim.speedMultiplier(a)).toBeGreaterThan(1);
    stepN(sim, secondsToTicks(GAME_CONFIG.powerups.speedDuration) + 1);
    expect(sim.speedMultiplier(a)).toBe(1);
  });

  it('uncollected power-ups expire', () => {
    const { sim, a, b } = makeSim();
    startPlaying(sim);
    place(a, 100, 48);
    place(b, 900, 600);
    sim.powerups.push({ id: 9, kind: 'rapid', x: 600, y: 300, expireTick: sim.tick + 5 });
    const ev = stepN(sim, 6);
    expect(ev.some((e) => e.e === 'powerExpire' && e.id === 9)).toBe(true);
    expect(sim.powerups.find((p) => p.id === 9)).toBeUndefined();
  });

  it('spawn on the configured interval, only at map points, never above the max', () => {
    const { sim, a, b } = makeSim();
    startPlaying(sim);
    place(a, 100, 48);
    place(b, 900, 600);
    a.hp = b.hp = 9999; // irrelevant, just keep alive
    const ev = stepN(sim, TPS * 60);
    const spawns = ev.filter((e) => e.e === 'powerSpawn');
    expect(spawns.length).toBeGreaterThan(0);
    for (const s of spawns) {
      if (s.e === 'powerSpawn')
        expect(sim.map.powerupPoints.some((p) => p.x === s.x && p.y === s.y)).toBe(true);
    }
    expect(sim.powerups.length).toBeLessThanOrEqual(GAME_CONFIG.powerups.maxActive);
  });
});

describe('match flow', () => {
  const score = (sim: Sim, team: TeamId) => {
    sim.scores[team]++;
  };

  it('runs countdown then the timer and ends with the higher score', () => {
    const { sim } = makeSim({ settings: { durationSec: 10 } });
    expect(sim.phase).toBe('countdown');
    startPlaying(sim);
    expect(sim.phase).toBe('playing');
    expect(sim.timeLeftSec()).toBeCloseTo(10, 0);
    score(sim, 1);
    stepN(sim, TPS * 10 + 1);
    expect(sim.phase).toBe('ended');
    expect(sim.winner).toBe(1);
  });

  it('goes to overtime on a tie and the first score wins', () => {
    const { sim, a, b } = makeSim({ settings: { durationSec: 10, overtimeSec: 20 } });
    startPlaying(sim);
    stepN(sim, TPS * 10 + 1);
    expect(sim.phase).toBe('overtime');
    place(a, 300, 48, 0);
    place(b, 380, 48, Math.PI);
    b.protectUntil = 0;
    b.hp = 1;
    sim.setInput('a', { ...idle, fire: true });
    stepN(sim, 10);
    expect(sim.phase).toBe('ended');
    expect(sim.winner).toBe(1);
  });

  it('declares a draw when overtime produces no score', () => {
    const { sim } = makeSim({ settings: { durationSec: 10, overtimeSec: 10 } });
    startPlaying(sim);
    stepN(sim, TPS * 10 + 1);
    expect(sim.phase).toBe('overtime');
    stepN(sim, TPS * 10 + 1);
    expect(sim.phase).toBe('ended');
    expect(sim.winner).toBe(0);
  });

  it('ends immediately when a whole team leaves', () => {
    const { sim } = makeSim();
    startPlaying(sim);
    const events: SimEvent[] = [];
    sim.removeTank('b');
    events.push(...sim.drainEvents());
    expect(sim.phase).toBe('ended');
    expect(sim.winner).toBe(1);
    expect(events.some((e) => e.e === 'end' && e.winner === 1)).toBe(true);
  });

  it('stops simulating after the match ends', () => {
    const { sim, a, b } = makeSim();
    startPlaying(sim);
    sim.removeTank('b');
    void b;
    const x0 = a.x;
    sim.setInput('a', fwd);
    stepN(sim, 30);
    expect(a.x).toBe(x0);
  });

  it('snapshots are compact and contain no wall list unless full', () => {
    const { sim } = makeSim();
    startPlaying(sim);
    expect(sim.snapshot(false).wd).toBeUndefined();
    expect(sim.snapshot(true).wd).toEqual([]);
    expect(JSON.stringify(sim.snapshot(false)).length).toBeLessThan(900);
  });
});

describe('bots', () => {
  it('play a full 2v2 match without errors and actually fight', () => {
    const sim = new Sim({ seed: 3, settings: { durationSec: 60, overtimeSec: 10 } });
    const bots = new BotController(11);
    (
      [
        ['b1', 1, 'assault'],
        ['b2', 1, 'heavy'],
        ['b3', 2, 'scout'],
        ['b4', 2, 'assault'],
      ] as const
    ).forEach(([id, team, cls]) => {
      sim.addTank({ id, name: id, team, cls });
      bots.addBot(id, 'hard');
    });
    let shots = 0;
    let guard = 0;
    while (sim.phase !== 'ended' && guard++ < TPS * 200) {
      bots.update(sim);
      sim.step();
      for (const e of sim.drainEvents()) if (e.e === 'shot') shots++;
    }
    expect(sim.phase).toBe('ended');
    expect(shots).toBeGreaterThan(10);
    expect(sim.scores[1] + sim.scores[2]).toBeGreaterThan(0);
  });

  it('hard bots beat easy bots most of the time', () => {
    let hardWins = 0;
    let decided = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const sim = new Sim({ seed, settings: { durationSec: 90, overtimeSec: 20 } });
      const bots = new BotController(seed * 100);
      sim.addTank({ id: 'h', name: 'h', team: 1, cls: 'assault' });
      sim.addTank({ id: 'e', name: 'e', team: 2, cls: 'assault' });
      bots.addBot('h', 'hard');
      bots.addBot('e', 'easy');
      let guard = 0;
      while (sim.phase !== 'ended' && guard++ < TPS * 200) {
        bots.update(sim);
        sim.step();
        sim.drainEvents();
      }
      if (sim.winner === 1) hardWins++;
      if (sim.winner !== 0) decided++;
    }
    expect(decided).toBeGreaterThan(0);
    expect(hardWins / decided).toBeGreaterThanOrEqual(0.66);
  });
});

describe('lag compensation (favor the shooter, bounded)', () => {
  // Open arena: a straight, wall-free line between shooter and target.
  const arena = buildMap({
    id: 'arena',
    name: 'Arena',
    quadrant: [
      '################',
      ...Array.from({ length: 9 }, (_, i) => (i === 0 || i === 4 ? '#1' : '#.') + '..............'),
    ],
  });

  /** Shooter fires along y=320 at a target that steps out of the line `sidestepAt` ticks later (bullet lands ~21). */
  function shotAtTargetThatSidesteps(viewLag: number, sidestepAt = 15): { hits: number } {
    const sim = new Sim({ map: arena, seed: 3, settings: { durationSec: 600 } });
    const a = sim.addTank({ id: 'a', name: 'A', team: 1, cls: 'assault' });
    const b = sim.addTank({ id: 'b', name: 'B', team: 2, cls: 'heavy' });
    startPlaying(sim);
    place(a, 200, 320, 0);
    place(b, 520, 320);
    a.protectUntil = 0;
    b.protectUntil = 0;
    sim.setViewLag('a', viewLag);
    stepN(sim, 3); // some history with the target in the line of fire
    sim.setInput('a', { ...idle, fire: true });
    stepN(sim, 1);
    sim.setInput('a', idle);
    let hits = 0;
    for (let i = 0; i < 40; i++) {
      if (i === sidestepAt) place(b, 520, 380); // sidestep out of the bullet's path
      for (const e of stepN(sim, 1)) if (e.e === 'hit' && e.target === 'b' && e.by === 'a') hits++;
    }
    return { hits };
  }

  it('without lag a sidestepped shot misses (server truth)', () => {
    expect(shotAtTargetThatSidesteps(0).hits).toBe(0);
  });

  it("with the shooter's view lag the shot is judged where the target was on their screen", () => {
    expect(shotAtTargetThatSidesteps(10).hits).toBe(1);
  });

  it('clamps the rewind to the configured maximum, never negative', () => {
    const { sim, a } = makeSim();
    const max = Math.round(GAME_CONFIG.limits.maxRewindSec * GAME_CONFIG.tickRate);
    sim.setViewLag('a', 10_000);
    expect(a.viewLag).toBe(max);
    sim.setViewLag('a', -5);
    expect(a.viewLag).toBe(0);
    sim.setViewLag('a', Number.NaN);
    expect(a.viewLag).toBe(0);
  });

  it('a claimed lag beyond the cap cannot reach further back than the cap', () => {
    // Target leaves the line 3 ticks after the shot; the bullet lands ~21 ticks after it. Reaching it would need an
    // 18+ tick rewind, more than the 12-tick (400 ms) cap, so a client claiming 10,000 ticks still misses.
    expect(shotAtTargetThatSidesteps(10_000, 3).hits).toBe(0);
    // ...while within the cap the same mechanism works (sidestep at 15 needs a ~6+ tick rewind).
    expect(shotAtTargetThatSidesteps(10_000, 15).hits).toBe(1);
  });
});

describe('new power-ups: Triple Shot, Ricochet, Overcharge', () => {
  const arena = buildMap({
    id: 'arena2',
    name: 'Arena',
    quadrant: [
      '################',
      ...Array.from({ length: 9 }, (_, i) => (i === 0 || i === 4 ? '#1' : '#.') + '..............'),
    ],
  });
  function setup() {
    const sim = new Sim({ map: arena, seed: 5, settings: { durationSec: 600 } });
    const a = sim.addTank({ id: 'a', name: 'A', team: 1, cls: 'assault' });
    const b = sim.addTank({ id: 'b', name: 'B', team: 2, cls: 'heavy' });
    startPlaying(sim);
    a.protectUntil = 0;
    b.protectUntil = 0;
    return { sim, a, b };
  }
  function grab(sim: Sim, t: Tank, kind: 'triple' | 'bounce' | 'overcharge'): void {
    sim.powerups.push({ id: 99, kind, x: t.x, y: t.y, expireTick: sim.tick + 100 });
    stepN(sim, 1);
  }

  it('every power-up kind can spawn', () => {
    expect([...POWERUP_KINDS].sort()).toEqual([
      'bounce',
      'health',
      'overcharge',
      'rapid',
      'shield',
      'speed',
      'triple',
    ]);
  });

  it('Triple Shot fires three shells in a fan, and shows in the snapshot', () => {
    const { sim, a, b } = setup();
    place(a, 200, 320, 0);
    place(b, 800, 500);
    grab(sim, a, 'triple');
    expect(sim.snapshot(false).tanks.find((t) => t.id === 'a')!.fx & 4).toBe(4);
    sim.setInput('a', { ...idle, fire: true });
    stepN(sim, 1);
    const mine = sim.bullets.filter((x) => x.owner === 'a');
    expect(mine).toHaveLength(3);
    const angles = mine.map((x) => x.angle).sort((p, q) => p - q);
    expect(angles[0]).toBeCloseTo(-GAME_CONFIG.powerups.tripleSpreadRad, 5);
    expect(angles[2]).toBeCloseTo(GAME_CONFIG.powerups.tripleSpreadRad, 5);
  });

  it('Ricochet bounces shells off steel walls (and they can still hit after the bounce)', () => {
    const { sim, a, b } = setup();
    place(a, 200, 320, Math.PI); // facing the left steel wall
    place(b, 350, 320); // behind the shooter: only a ricochet can reach it within the shell's lifetime
    grab(sim, a, 'bounce');
    sim.setInput('a', { ...idle, fire: true });
    stepN(sim, 1);
    sim.setInput('a', idle);
    place(a, 200, 200); // step aside so the returning shell passes our old spot
    const shell = sim.bullets.find((x) => x.owner === 'a')!;
    expect(shell.vx).toBeLessThan(0);
    const events = stepN(sim, 40);
    expect(events.some((e) => e.e === 'hit' && e.target === 'b' && e.by === 'a')).toBe(true);
  });

  it('without Ricochet the same shell dies on the wall', () => {
    const { sim, a, b } = setup();
    place(a, 200, 320, Math.PI);
    place(b, 350, 320);
    sim.setInput('a', { ...idle, fire: true });
    stepN(sim, 1);
    sim.setInput('a', idle);
    place(a, 200, 200);
    const events = stepN(sim, 40);
    expect(events.some((e) => e.e === 'hit' && e.target === 'b')).toBe(false);
  });

  it('Overcharge multiplies shell damage', () => {
    const { sim, a, b } = setup();
    place(a, 200, 320, 0);
    place(b, 320, 320);
    grab(sim, a, 'overcharge');
    sim.setInput('a', { ...idle, fire: true });
    const events = stepN(sim, 10);
    const hit = events.find((e) => e.e === 'hit' && e.target === 'b');
    expect(hit && hit.e === 'hit' ? hit.dmg : 0).toBe(
      Math.round(GAME_CONFIG.classes.assault.damage * GAME_CONFIG.powerups.overchargeMultiplier),
    );
  });

  it('all power-up effects end on death', () => {
    const { sim, a, b } = setup();
    place(a, 200, 320, 0);
    place(b, 800, 500);
    for (const k of ['triple', 'bounce', 'overcharge'] as const) grab(sim, a, k);
    a.hp = 1;
    sim.bullets.push({
      id: 500,
      owner: 'b',
      team: 2,
      x: a.x + 20,
      y: a.y,
      vx: -400,
      vy: 0,
      angle: Math.PI,
      expireTick: sim.tick + 20,
      damage: 50,
      lag: 0,
      bounces: 0,
    });
    stepN(sim, 5 + secondsToTicks(GAME_CONFIG.match.respawnSec));
    expect(a.alive).toBe(true);
    expect([a.tripleUntil, a.bounceUntil, a.overchargeUntil]).toEqual([0, 0, 0]);
  });
});
