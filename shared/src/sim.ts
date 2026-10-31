import {
  CLASS_ABILITY,
  GAME_CONFIG,
  POWERUP_KINDS,
  defaultMatchSettings,
  secondsToTicks,
  type AbilityKind,
  type ClassConfig,
  type MatchSettings,
  type PowerUpKind,
  type TankClass,
  type TeamId,
} from './config';
import { TILE_DESTRUCTIBLE, TILE_SOLID, getMap, type MapDef } from './map';
import { Rng } from './rng';

/** Player intent. Clients only ever send this; the server never trusts positions or hits. */
export interface TankInput {
  throttle: number; // -1 (reverse) .. 1 (forward)
  turn: number; // -1 (left / counter-clockwise) .. 1 (right / clockwise)
  fire: boolean;
  ability: boolean;
}

export const NEUTRAL_INPUT: TankInput = { throttle: 0, turn: 0, fire: false, ability: false };

export type Phase = 'countdown' | 'playing' | 'overtime' | 'ended';

export interface Tank {
  id: string;
  name: string;
  team: TeamId;
  cls: TankClass;
  x: number;
  y: number;
  angle: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  respawnTick: number;
  protectUntil: number;
  fireReadyTick: number;
  abilityActiveUntil: number;
  abilityReadyTick: number;
  speedBoostUntil: number;
  rapidUntil: number;
  shieldHp: number;
  shieldUntil: number;
  input: TankInput;
  prevAbility: boolean;
  kills: number;
  deaths: number;
}

export interface Bullet {
  id: number;
  owner: string;
  team: TeamId;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  expireTick: number;
  damage: number;
}

export interface PowerUp {
  id: number;
  kind: PowerUpKind;
  x: number;
  y: number;
  expireTick: number;
}

export type SimEvent =
  | { e: 'shot'; tank: string; x: number; y: number; a: number }
  | { e: 'wallHit'; wall: number; hp: number; x: number; y: number }
  | { e: 'solidHit'; x: number; y: number }
  | { e: 'wallDown'; wall: number }
  | { e: 'hit'; target: string; by: string; dmg: number; shield: boolean; x: number; y: number }
  | { e: 'kill'; victim: string; killer: string; x: number; y: number }
  | { e: 'respawn'; tank: string }
  | { e: 'ability'; tank: string; kind: AbilityKind }
  | { e: 'powerSpawn'; id: number; kind: PowerUpKind; x: number; y: number }
  | { e: 'powerTake'; id: number; tank: string; kind: PowerUpKind }
  | { e: 'powerExpire'; id: number }
  | { e: 'phase'; phase: Phase }
  | { e: 'end'; winner: 0 | TeamId };

export interface TankSnapshot {
  id: string;
  x: number;
  y: number;
  a: number;
  hp: number;
  al: 0 | 1;
  /** Spawn-protected. */
  pr: 0 | 1;
  /** Shield hit points remaining (0 = none). */
  sh: number;
  /** Ability active (0/1). */
  ab: 0 | 1;
  /** Ability cooldown remaining, seconds (1 decimal). */
  cd: number;
  /** Respawn countdown remaining, seconds (1 decimal), 0 when alive. */
  rs: number;
  /** Power-up effect bitmask: 1 = speed, 2 = rapid. */
  fx: number;
  k: number;
  d: number;
}

export interface Snapshot {
  tick: number;
  phase: Phase;
  /** Seconds left in the current phase window (countdown / match / overtime). */
  left: number;
  sc: [number, number];
  tanks: TankSnapshot[];
  bullets: { id: number; x: number; y: number; a: number; t: TeamId }[];
  pu: { id: number; k: PowerUpKind; x: number; y: number }[];
  /** Destroyed destructible wall ids; only included in full snapshots. */
  wd?: number[];
  winner?: 0 | TeamId;
}

export interface SimOptions {
  map?: MapDef;
  seed?: number;
  settings?: Partial<MatchSettings>;
  tickRate?: number;
}

export interface TankInit {
  id: string;
  name: string;
  team: TeamId;
  cls: TankClass;
}

const round = (v: number, d: number): number => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export class Sim {
  readonly map: MapDef;
  readonly settings: MatchSettings;
  readonly tickRate: number;
  readonly dt: number;
  tick = 0;
  phase: Phase = 'countdown';
  winner: 0 | TeamId | null = null;
  readonly tanks = new Map<string, Tank>();
  bullets: Bullet[] = [];
  powerups: PowerUp[] = [];
  /** Remaining hp per destructible wall id (<= 0 means destroyed). */
  readonly wallHp: Int8Array;
  readonly scores: Record<TeamId, number> = { 1: 0, 2: 0 };

  private events: SimEvent[] = [];
  private nextBulletId = 1;
  private nextPowerId = 1;
  private readonly rng: Rng;
  private countdownEnd: number;
  private matchEnd = 0;
  private overtimeEnd = 0;
  private nextPowerSpawn = 0;
  private readonly respawnTicks: number;
  private readonly protectTicks: number;

  constructor(opts: SimOptions = {}) {
    this.map = opts.map ?? getMap();
    this.settings = { ...defaultMatchSettings(), ...opts.settings };
    this.tickRate = opts.tickRate ?? GAME_CONFIG.tickRate;
    this.dt = 1 / this.tickRate;
    this.rng = new Rng(opts.seed ?? 1);
    this.wallHp = new Int8Array(this.map.walls.length).fill(GAME_CONFIG.walls.destructibleHp);
    this.countdownEnd = secondsToTicks(GAME_CONFIG.match.countdownSec, this.tickRate);
    this.respawnTicks = secondsToTicks(this.settings.respawnSec, this.tickRate);
    this.protectTicks = secondsToTicks(this.settings.spawnProtectSec, this.tickRate);
    this.nextPowerSpawn =
      this.countdownEnd + secondsToTicks(GAME_CONFIG.powerups.spawnIntervalSec / 2, this.tickRate);
  }

  // ---------------------------------------------------------------- setup

  addTank(init: TankInit): Tank {
    if (this.tanks.has(init.id)) throw new Error(`duplicate tank ${init.id}`);
    const cfg = GAME_CONFIG.classes[init.cls];
    const tank: Tank = {
      ...init,
      x: 0,
      y: 0,
      angle: 0,
      hp: cfg.health,
      maxHp: cfg.health,
      alive: true,
      respawnTick: 0,
      protectUntil: 0,
      fireReadyTick: 0,
      abilityActiveUntil: 0,
      abilityReadyTick: 0,
      speedBoostUntil: 0,
      rapidUntil: 0,
      shieldHp: 0,
      shieldUntil: 0,
      input: { ...NEUTRAL_INPUT },
      prevAbility: false,
      kills: 0,
      deaths: 0,
    };
    this.tanks.set(tank.id, tank);
    this.placeAtSpawn(tank);
    return tank;
  }

  /** Remove a tank (player left). Triggers an early win if a whole team is gone. */
  removeTank(id: string): void {
    this.tanks.delete(id);
    this.bullets = this.bullets.filter((b) => b.owner !== id);
    this.checkForfeit();
  }

  setInput(id: string, input: TankInput): void {
    const t = this.tanks.get(id);
    if (!t) return;
    t.input = {
      throttle: clamp(Number.isFinite(input.throttle) ? input.throttle : 0, -1, 1),
      turn: clamp(Number.isFinite(input.turn) ? input.turn : 0, -1, 1),
      fire: input.fire === true,
      ability: input.ability === true,
    };
  }

  // ---------------------------------------------------------------- queries

  teamSize(team: TeamId): number {
    let n = 0;
    for (const t of this.tanks.values()) if (t.team === team) n++;
    return n;
  }

  isBlockedTile(col: number, row: number): boolean {
    const m = this.map;
    if (col < 0 || row < 0 || col >= m.cols || row >= m.rows) return true;
    const idx = row * m.cols + col;
    const tile = m.tiles[idx];
    if (tile === TILE_SOLID) return true;
    if (tile === TILE_DESTRUCTIBLE) return (this.wallHp[m.wallIdAt[idx] as number] ?? 0) > 0;
    return false;
  }

  /** True if a straight line is not blocked by any (currently standing) wall. */
  lineOfSight(x1: number, y1: number, x2: number, y2: number): boolean {
    const ts = this.map.tileSize;
    const dist = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.max(1, Math.ceil(dist / (ts / 4)));
    for (let i = 1; i < steps; i++) {
      const f = i / steps;
      if (this.isBlockedTile(Math.floor((x1 + (x2 - x1) * f) / ts), Math.floor((y1 + (y2 - y1) * f) / ts)))
        return false;
    }
    return true;
  }

  timeLeftSec(): number {
    if (this.phase === 'countdown') return Math.max(0, (this.countdownEnd - this.tick) / this.tickRate);
    if (this.phase === 'playing') return Math.max(0, (this.matchEnd - this.tick) / this.tickRate);
    if (this.phase === 'overtime') return Math.max(0, (this.overtimeEnd - this.tick) / this.tickRate);
    return 0;
  }

  speedMultiplier(t: Tank): number {
    let m = 1;
    if (t.abilityActiveUntil > this.tick && CLASS_ABILITY[t.cls] === 'speed') {
      const cc: ClassConfig = GAME_CONFIG.classes[t.cls];
      m *= cc.ability.multiplier ?? 1;
    }
    if (t.speedBoostUntil > this.tick) m *= GAME_CONFIG.powerups.speedMultiplier;
    return Math.min(m, GAME_CONFIG.tank.maxSpeedMultiplier);
  }

  fireCooldownTicks(t: Tank): number {
    const cfg: ClassConfig = GAME_CONFIG.classes[t.cls];
    let mult = 1;
    if (t.abilityActiveUntil > this.tick && CLASS_ABILITY[t.cls] === 'rapid') {
      mult = Math.min(mult, cfg.ability.multiplier ?? 1);
    }
    if (t.rapidUntil > this.tick) mult = Math.min(mult, GAME_CONFIG.powerups.rapidMultiplier);
    const sec = Math.max(GAME_CONFIG.tank.minFireCooldown, cfg.fireCooldown * mult);
    return secondsToTicks(sec, this.tickRate);
  }

  // ---------------------------------------------------------------- stepping

  drainEvents(): SimEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  step(): void {
    if (this.phase === 'ended') return;
    this.tick++;

    if (this.phase === 'countdown') {
      if (this.tick >= this.countdownEnd) this.beginMatch();
      return;
    }

    for (const t of this.tanks.values()) this.stepTank(t);
    this.stepBullets();
    this.stepPowerups();
    this.stepRespawns();
    if ((this.phase as Phase) === 'ended') return;
    this.stepClock();
  }

  private beginMatch(): void {
    this.phase = 'playing';
    this.matchEnd = this.tick + secondsToTicks(this.settings.durationSec, this.tickRate);
    for (const t of this.tanks.values()) t.protectUntil = this.tick + this.protectTicks;
    this.events.push({ e: 'phase', phase: 'playing' });
  }

  private stepClock(): void {
    if (this.phase === 'playing' && this.tick >= this.matchEnd) {
      if (this.scores[1] !== this.scores[2]) {
        this.finish(this.scores[1] > this.scores[2] ? 1 : 2);
      } else {
        this.phase = 'overtime';
        this.overtimeEnd = this.tick + secondsToTicks(this.settings.overtimeSec, this.tickRate);
        this.events.push({ e: 'phase', phase: 'overtime' });
      }
    } else if (this.phase === 'overtime' && this.tick >= this.overtimeEnd) {
      // Overtime produced no score: defined draw.
      this.finish(0);
    }
  }

  private finish(winner: 0 | TeamId): void {
    if (this.phase === 'ended') return;
    this.phase = 'ended';
    this.winner = winner;
    for (const t of this.tanks.values()) t.input = { ...NEUTRAL_INPUT };
    this.bullets = [];
    this.events.push({ e: 'phase', phase: 'ended' }, { e: 'end', winner });
  }

  /** If an entire team has left, the remaining team wins immediately. */
  checkForfeit(): void {
    if (this.phase === 'ended') return;
    const s1 = this.teamSize(1);
    const s2 = this.teamSize(2);
    if (s1 === 0 && s2 === 0) this.finish(0);
    else if (s1 === 0) this.finish(2);
    else if (s2 === 0) this.finish(1);
  }

  /**
   * Rotation + movement for one tick. Speed is bounded by class config and the global multiplier cap, so it is
   * server-enforced. Public so the client can predict its own tank with exactly the same rules.
   */
  applyMovement(t: Tank): void {
    const cfg: ClassConfig = GAME_CONFIG.classes[t.cls];
    const inp = t.input;
    t.angle = normalizeAngle(t.angle + inp.turn * cfg.turnRate * this.dt);
    if (inp.throttle !== 0) {
      const base = inp.throttle > 0 ? cfg.speed : cfg.speed * cfg.reverseFactor;
      const v = inp.throttle * base * this.speedMultiplier(t);
      this.moveTank(t, Math.cos(t.angle) * v * this.dt, Math.sin(t.angle) * v * this.dt);
    }
  }

  private stepTank(t: Tank): void {
    if (!t.alive) return;
    const inp = t.input;
    this.applyMovement(t);

    // Ability (edge-triggered).
    if (inp.ability && !t.prevAbility) this.tryAbility(t);
    t.prevAbility = inp.ability;
    if (t.shieldHp > 0 && this.tick >= t.shieldUntil) t.shieldHp = 0;

    // Fire.
    if (inp.fire) this.tryFire(t);
  }

  private tryAbility(t: Tank): void {
    if (this.tick < t.abilityReadyTick) return;
    const cc: ClassConfig = GAME_CONFIG.classes[t.cls];
    const cfg = cc.ability;
    t.abilityActiveUntil = this.tick + secondsToTicks(cfg.duration, this.tickRate);
    t.abilityReadyTick = this.tick + secondsToTicks(cfg.cooldown, this.tickRate);
    const kind = CLASS_ABILITY[t.cls];
    if (kind === 'shield') {
      // Non-stacking: refreshes to the cap rather than adding on top.
      t.shieldHp = Math.max(t.shieldHp, cfg.shieldHp ?? 0);
      t.shieldUntil = Math.max(t.shieldUntil, t.abilityActiveUntil);
    }
    this.events.push({ e: 'ability', tank: t.id, kind });
  }

  private tryFire(t: Tank): void {
    if (this.tick < t.fireReadyTick) return;
    let live = 0;
    for (const b of this.bullets) if (b.owner === t.id) live++;
    if (live >= GAME_CONFIG.bullet.maxPerTank) return;
    t.fireReadyTick = this.tick + this.fireCooldownTicks(t);
    t.protectUntil = 0; // firing ends spawn protection (anti spawn-abuse)
    const cfg = GAME_CONFIG.classes[t.cls];
    const mx = t.x + Math.cos(t.angle) * (GAME_CONFIG.tank.radius + 4);
    const my = t.y + Math.sin(t.angle) * (GAME_CONFIG.tank.radius + 4);
    this.bullets.push({
      id: this.nextBulletId++,
      owner: t.id,
      team: t.team,
      x: mx,
      y: my,
      vx: Math.cos(t.angle) * GAME_CONFIG.bullet.speed,
      vy: Math.sin(t.angle) * GAME_CONFIG.bullet.speed,
      angle: t.angle,
      expireTick: this.tick + secondsToTicks(GAME_CONFIG.bullet.lifetimeSec, this.tickRate),
      damage: cfg.damage,
    });
    this.events.push({ e: 'shot', tank: t.id, x: round(mx, 1), y: round(my, 1), a: round(t.angle, 2) });
  }

  private circleHitsWall(x: number, y: number, r: number): boolean {
    const ts = this.map.tileSize;
    const c0 = Math.floor((x - r) / ts);
    const c1 = Math.floor((x + r) / ts);
    const r0 = Math.floor((y - r) / ts);
    const r1 = Math.floor((y + r) / ts);
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        if (!this.isBlockedTile(col, row)) continue;
        const nx = clamp(x, col * ts, (col + 1) * ts);
        const ny = clamp(y, row * ts, (row + 1) * ts);
        const dx = x - nx;
        const dy = y - ny;
        if (dx * dx + dy * dy < r * r) return true;
      }
    }
    return false;
  }

  private circleHitsTank(self: Tank, x: number, y: number): boolean {
    const r2 = GAME_CONFIG.tank.radius * 2;
    for (const o of this.tanks.values()) {
      if (o === self || !o.alive) continue;
      const dNew = Math.hypot(x - o.x, y - o.y);
      if (dNew < r2 && dNew < Math.hypot(self.x - o.x, self.y - o.y)) return true;
    }
    return false;
  }

  private moveTank(t: Tank, dx: number, dy: number): void {
    const r = GAME_CONFIG.tank.radius;
    // Axis-separated so tanks slide along walls instead of sticking.
    if (dx !== 0 && !this.circleHitsWall(t.x + dx, t.y, r) && !this.circleHitsTank(t, t.x + dx, t.y))
      t.x += dx;
    if (dy !== 0 && !this.circleHitsWall(t.x, t.y + dy, r) && !this.circleHitsTank(t, t.x, t.y + dy))
      t.y += dy;
  }

  private stepBullets(): void {
    const keep: Bullet[] = [];
    const SUB = 2;
    const br = GAME_CONFIG.bullet.radius;
    const tr = GAME_CONFIG.tank.radius;
    const ts = this.map.tileSize;
    for (const b of this.bullets) {
      let dead = this.tick >= b.expireTick;
      for (let s = 0; s < SUB && !dead; s++) {
        b.x += (b.vx * this.dt) / SUB;
        b.y += (b.vy * this.dt) / SUB;

        const col = Math.floor(b.x / ts);
        const row = Math.floor(b.y / ts);
        if (this.isBlockedTile(col, row)) {
          dead = true;
          const idx = row * this.map.cols + col;
          const wallId =
            col >= 0 && row >= 0 && col < this.map.cols && row < this.map.rows
              ? (this.map.wallIdAt[idx] ?? -1)
              : -1;
          if (wallId >= 0) this.damageWall(wallId, b.x, b.y);
          else this.events.push({ e: 'solidHit', x: round(b.x, 1), y: round(b.y, 1) });
          break;
        }

        for (const t of this.tanks.values()) {
          if (!t.alive || t.id === b.owner) continue;
          if (t.team === b.team && !this.settings.friendlyFire) continue; // passes through friends
          if (Math.hypot(b.x - t.x, b.y - t.y) < tr + br) {
            dead = true;
            this.damageTank(t, b);
            break;
          }
        }
      }
      if (!dead) keep.push(b);
    }
    this.bullets = keep;
  }

  private damageWall(wallId: number, x: number, y: number): void {
    const hp = (this.wallHp[wallId] ?? 0) - GAME_CONFIG.bullet.wallDamage;
    this.wallHp[wallId] = hp;
    this.events.push({ e: 'wallHit', wall: wallId, hp: Math.max(0, hp), x: round(x, 1), y: round(y, 1) });
    if (hp <= 0) this.events.push({ e: 'wallDown', wall: wallId });
  }

  private damageTank(t: Tank, b: Bullet): void {
    if (this.tick < t.protectUntil) {
      this.events.push({
        e: 'hit',
        target: t.id,
        by: b.owner,
        dmg: 0,
        shield: true,
        x: round(b.x, 1),
        y: round(b.y, 1),
      });
      return;
    }
    let dmg = b.damage;
    let shielded = false;
    if (t.shieldHp > 0 && this.tick < t.shieldUntil) {
      const absorbed = Math.min(t.shieldHp, dmg);
      t.shieldHp -= absorbed;
      dmg -= absorbed;
      shielded = true;
    }
    t.hp = Math.max(0, t.hp - dmg);
    this.events.push({
      e: 'hit',
      target: t.id,
      by: b.owner,
      dmg,
      shield: shielded,
      x: round(b.x, 1),
      y: round(b.y, 1),
    });
    if (t.hp <= 0 && t.alive) {
      // `alive` flips immediately, so a second bullet in the same tick cannot award a duplicate kill.
      t.alive = false;
      t.deaths++;
      t.respawnTick = this.tick + this.respawnTicks;
      t.input = { ...NEUTRAL_INPUT };
      const killer = this.tanks.get(b.owner);
      if (killer) killer.kills++;
      this.scores[b.team]++;
      this.events.push({ e: 'kill', victim: t.id, killer: b.owner, x: round(t.x, 1), y: round(t.y, 1) });
      if (this.phase === 'overtime') this.finish(b.team);
    }
  }

  private stepPowerups(): void {
    const cfg = GAME_CONFIG.powerups;
    // Expiry.
    this.powerups = this.powerups.filter((p) => {
      if (this.tick >= p.expireTick) {
        this.events.push({ e: 'powerExpire', id: p.id });
        return false;
      }
      return true;
    });

    // Collection: single-threaded & first-match-wins, so a pickup can never be claimed twice.
    for (const t of this.tanks.values()) {
      if (!t.alive) continue;
      for (let i = 0; i < this.powerups.length; i++) {
        const p = this.powerups[i] as PowerUp;
        if (Math.hypot(p.x - t.x, p.y - t.y) < GAME_CONFIG.tank.radius + cfg.radius) {
          this.powerups.splice(i, 1);
          this.applyPowerup(t, p.kind);
          this.events.push({ e: 'powerTake', id: p.id, tank: t.id, kind: p.kind });
          i--;
        }
      }
    }

    // Spawning.
    if (this.tick >= this.nextPowerSpawn) {
      this.nextPowerSpawn = this.tick + secondsToTicks(cfg.spawnIntervalSec, this.tickRate);
      if (this.powerups.length < cfg.maxActive) {
        const free = this.map.powerupPoints.filter(
          (pt) => !this.powerups.some((p) => p.x === pt.x && p.y === pt.y),
        );
        if (free.length > 0) {
          const pt = this.rng.pick(free);
          const kind = this.rng.pick(POWERUP_KINDS);
          const p: PowerUp = {
            id: this.nextPowerId++,
            kind,
            x: pt.x,
            y: pt.y,
            expireTick: this.tick + secondsToTicks(cfg.lifetimeSec, this.tickRate),
          };
          this.powerups.push(p);
          this.events.push({ e: 'powerSpawn', id: p.id, kind, x: p.x, y: p.y });
        }
      }
    }
  }

  private applyPowerup(t: Tank, kind: PowerUpKind): void {
    const cfg = GAME_CONFIG.powerups;
    // All effects refresh (never stack beyond their configured cap).
    if (kind === 'health') t.hp = Math.min(t.maxHp, t.hp + cfg.healAmount);
    else if (kind === 'speed')
      t.speedBoostUntil = this.tick + secondsToTicks(cfg.speedDuration, this.tickRate);
    else if (kind === 'rapid') t.rapidUntil = this.tick + secondsToTicks(cfg.rapidDuration, this.tickRate);
    else {
      t.shieldHp = Math.max(t.shieldHp, cfg.shieldHp);
      t.shieldUntil = Math.max(t.shieldUntil, this.tick + secondsToTicks(cfg.shieldDuration, this.tickRate));
    }
  }

  private stepRespawns(): void {
    for (const t of this.tanks.values()) {
      if (!t.alive && this.tick >= t.respawnTick) {
        t.alive = true;
        t.hp = t.maxHp;
        t.shieldHp = 0;
        t.speedBoostUntil = 0;
        t.rapidUntil = 0;
        t.abilityActiveUntil = 0;
        this.placeAtSpawn(t);
        t.protectUntil = this.tick + this.protectTicks;
        this.events.push({ e: 'respawn', tank: t.id });
      }
    }
  }

  /** Pick the team spawn farthest from living enemies (reduces spawn camping) that isn't occupied. */
  private placeAtSpawn(t: Tank): void {
    const r2 = GAME_CONFIG.tank.radius * 2;
    const candidates = this.map.spawns.filter((s) => s.team === t.team);
    let best = candidates[0];
    let bestScore = -Infinity;
    for (const s of candidates) {
      let occupied = false;
      let nearestEnemy = Infinity;
      for (const o of this.tanks.values()) {
        if (o === t || !o.alive) continue;
        const d = Math.hypot(o.x - s.x, o.y - s.y);
        if (o.team === t.team && d < r2 + 2) occupied = true;
        if (o.team !== t.team) nearestEnemy = Math.min(nearestEnemy, d);
      }
      const score = (occupied ? -10000 : 0) + Math.min(nearestEnemy, 2000) + this.rng.next();
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    if (!best) throw new Error('map has no spawn for team ' + t.team);
    t.x = best.x;
    t.y = best.y;
    t.angle = best.angle;
  }

  // ---------------------------------------------------------------- snapshots

  snapshot(full = false): Snapshot {
    const tanks: TankSnapshot[] = [];
    for (const t of this.tanks.values()) {
      const shieldOn = t.shieldHp > 0 && this.tick < t.shieldUntil;
      tanks.push({
        id: t.id,
        x: round(t.x, 1),
        y: round(t.y, 1),
        a: round(t.angle, 2),
        hp: Math.ceil(t.hp),
        al: t.alive ? 1 : 0,
        pr: this.tick < t.protectUntil ? 1 : 0,
        sh: shieldOn ? Math.ceil(t.shieldHp) : 0,
        ab: t.abilityActiveUntil > this.tick ? 1 : 0,
        cd: round(Math.max(0, t.abilityReadyTick - this.tick) / this.tickRate, 1),
        rs: t.alive ? 0 : round(Math.max(0, t.respawnTick - this.tick) / this.tickRate, 1),
        fx: (t.speedBoostUntil > this.tick ? 1 : 0) | (t.rapidUntil > this.tick ? 2 : 0),
        k: t.kills,
        d: t.deaths,
      });
    }
    const snap: Snapshot = {
      tick: this.tick,
      phase: this.phase,
      left: round(this.timeLeftSec(), 1),
      sc: [this.scores[1], this.scores[2]],
      tanks,
      bullets: this.bullets.map((b) => ({
        id: b.id,
        x: round(b.x, 1),
        y: round(b.y, 1),
        a: round(b.angle, 2),
        t: b.team,
      })),
      pu: this.powerups.map((p) => ({ id: p.id, k: p.kind, x: p.x, y: p.y })),
    };
    if (full) {
      const wd: number[] = [];
      this.wallHp.forEach((hp, id) => {
        if (hp <= 0) wd.push(id);
      });
      snap.wd = wd;
    }
    if (this.winner !== null) snap.winner = this.winner;
    return snap;
  }
}

export function normalizeAngle(a: number): number {
  const twoPi = Math.PI * 2;
  let r = a % twoPi;
  if (r > Math.PI) r -= twoPi;
  else if (r < -Math.PI) r += twoPi;
  return r;
}
