import { GAME_CONFIG, type PowerUpKind } from './config';
import { Rng } from './rng';
import { NEUTRAL_INPUT, Sim, normalizeAngle, type Tank, type TankInput } from './sim';

export type Difficulty = 'easy' | 'normal' | 'hard';
export const DIFFICULTIES: readonly Difficulty[] = ['easy', 'normal', 'hard'] as const;

interface DifficultyProfile {
  /** Ticks between a bot noticing an enemy and acting on it. */
  reactionTicks: number;
  /** Aim error (radians, std-dev-ish) applied whenever the bot re-aims. */
  aimError: number;
  /** Chance per tick to pull the trigger while aligned. */
  fireChance: number;
  detectRange: number;
  /** Retreat when hp fraction drops below this. */
  retreatHp: number;
  /** Chance per tick (when in a fight) to use the special ability. */
  abilityChance: number;
  /** Lead moving targets. */
  leadTargets: boolean;
  repathTicks: number;
}

export const DIFFICULTY_PROFILES: Record<Difficulty, DifficultyProfile> = {
  easy: {
    reactionTicks: 18,
    aimError: 0.35,
    fireChance: 0.35,
    detectRange: 220,
    retreatHp: 0.2,
    abilityChance: 0,
    leadTargets: false,
    repathTicks: 45,
  },
  normal: {
    reactionTicks: 9,
    aimError: 0.17,
    fireChance: 0.7,
    detectRange: 330,
    retreatHp: 0.3,
    abilityChance: 0.02,
    leadTargets: false,
    repathTicks: 25,
  },
  hard: {
    reactionTicks: 3,
    aimError: 0.06,
    fireChance: 0.95,
    detectRange: 480,
    retreatHp: 0.35,
    abilityChance: 0.08,
    leadTargets: true,
    repathTicks: 12,
  },
};

type Point = { x: number; y: number };

/**
 * A bot obeys exactly the same rules as a human: it can only produce a TankInput.
 * It reads world state (positions, walls) from the Sim but has no special access to damage/cooldowns.
 */
export class BotBrain {
  private readonly rng: Rng;
  private readonly profile: DifficultyProfile;
  private path: Point[] = [];
  private pathGoalKey = '';
  private pathAge = 1e9;
  private lastPos: Point = { x: 0, y: 0 };
  private stuckTicks = 0;
  private unstuckTicks = 0;
  private unstuckTurn = 1;
  private seenTicks = 0;
  private aimNoise = 0;
  private aimNoiseAge = 1e9;
  private prevTarget = new Map<string, Point>();
  private strafeDir = 1;
  private strafeAge = 0;

  constructor(
    readonly tankId: string,
    readonly difficulty: Difficulty,
    seed: number,
  ) {
    this.rng = new Rng(seed);
    this.profile = DIFFICULTY_PROFILES[difficulty];
  }

  think(sim: Sim): TankInput {
    const me = sim.tanks.get(this.tankId);
    if (!me || !me.alive || sim.phase === 'countdown' || sim.phase === 'ended') return { ...NEUTRAL_INPUT };
    const p = this.profile;

    // --- stuck detection (blocked by geometry or tanks) -------------------
    const moved = Math.hypot(me.x - this.lastPos.x, me.y - this.lastPos.y);
    this.lastPos = { x: me.x, y: me.y };
    if (moved < 0.4) this.stuckTicks++;
    else this.stuckTicks = Math.max(0, this.stuckTicks - 2);
    if (this.stuckTicks > 20 && this.unstuckTicks <= 0) {
      this.unstuckTicks = 14 + this.rng.int(10);
      this.unstuckTurn = this.rng.next() < 0.5 ? -1 : 1;
      this.stuckTicks = 0;
    }
    if (this.unstuckTicks > 0) {
      this.unstuckTicks--;
      // Back out while turning, and shoot whatever blocks us (destructible walls can be cleared).
      return { throttle: -1, turn: this.unstuckTurn, fire: this.unstuckTicks % 6 === 0, ability: false };
    }

    // --- target selection ---------------------------------------------------
    let target: Tank | null = null;
    let targetDist = Infinity;
    for (const o of sim.tanks.values()) {
      if (o.team === me.team || !o.alive) continue;
      const d = Math.hypot(o.x - me.x, o.y - me.y);
      if (d < targetDist) {
        targetDist = d;
        target = o;
      }
    }

    const visible =
      target !== null && targetDist <= p.detectRange && sim.lineOfSight(me.x, me.y, target.x, target.y);
    if (visible) this.seenTicks++;
    else this.seenTicks = 0;
    const engaged = visible && this.seenTicks >= p.reactionTicks;

    const lowHp = me.hp / me.maxHp < p.retreatHp;
    let throttle = 0;
    let turn = 0;
    let fire = false;
    let ability = false;

    if (engaged && target) {
      // Aim (re-roll noise periodically, scaled by difficulty).
      if (this.aimNoiseAge++ > 10) {
        this.aimNoise = (this.rng.next() + this.rng.next() - 1) * p.aimError * 2;
        this.aimNoiseAge = 0;
      }
      let tx = target.x;
      let ty = target.y;
      if (p.leadTargets) {
        const prev = this.prevTarget.get(target.id);
        if (prev) {
          const vx = (target.x - prev.x) / sim.dt;
          const vy = (target.y - prev.y) / sim.dt;
          const t = targetDist / GAME_CONFIG.bullet.speed;
          tx += vx * t * 0.8;
          ty += vy * t * 0.8;
        }
      }
      const desired = Math.atan2(ty - me.y, tx - me.x) + this.aimNoise;
      const diff = normalizeAngle(desired - me.angle);
      turn = clampUnit(diff * 4);
      const aligned = Math.abs(diff) < 0.12 + p.aimError * 0.5;
      fire = aligned && this.rng.next() < p.fireChance;

      // Positioning: keep a fighting distance, strafe a little, back off when hurt.
      if (lowHp) {
        throttle = Math.abs(diff) < 1.2 ? -1 : 0;
      } else if (targetDist > 220) throttle = Math.abs(diff) < 0.8 ? 1 : 0;
      else if (targetDist < 90) throttle = -0.8;
      else {
        if (this.strafeAge++ > 40) {
          this.strafeDir = this.rng.next() < 0.5 ? -1 : 1;
          this.strafeAge = 0;
        }
        throttle = 0.3 * this.strafeDir;
      }
      if (this.rng.next() < p.abilityChance && targetDist < 260) ability = true;
    } else {
      // Navigate: retreat -> useful pickup -> hunt the nearest enemy.
      const goal = this.chooseGoal(sim, me, target, lowHp);
      const wp = goal ? this.nextWaypoint(sim, me, goal) : null;
      if (wp) {
        const desired = Math.atan2(wp.y - me.y, wp.x - me.x);
        const diff = normalizeAngle(desired - me.angle);
        turn = clampUnit(diff * 4);
        throttle = Math.abs(diff) < 0.7 ? 1 : Math.abs(diff) < 1.4 ? 0.2 : 0;
      }
      // Clear a destructible wall that is right in front of us.
      const ts = sim.map.tileSize;
      const fx = me.x + Math.cos(me.angle) * (GAME_CONFIG.tank.radius + ts * 0.6);
      const fy = me.y + Math.sin(me.angle) * (GAME_CONFIG.tank.radius + ts * 0.6);
      const col = Math.floor(fx / ts);
      const row = Math.floor(fy / ts);
      if (
        sim.isBlockedTile(col, row) &&
        sim.map.wallIdAt[row * sim.map.cols + col]! >= 0 &&
        this.rng.next() < 0.5
      )
        fire = true;
    }

    for (const o of sim.tanks.values()) this.prevTarget.set(o.id, { x: o.x, y: o.y });
    return { throttle, turn, fire, ability };
  }

  private chooseGoal(sim: Sim, me: Tank, target: Tank | null, lowHp: boolean): Point | null {
    if (lowHp || sim.powerups.length > 0) {
      let best: { x: number; y: number } | null = null;
      let bestD = lowHp ? Infinity : 260;
      for (const pu of sim.powerups) {
        if (!this.isUseful(pu.kind, me, lowHp)) continue;
        const d = Math.hypot(pu.x - me.x, pu.y - me.y);
        if (d < bestD) {
          bestD = d;
          best = pu;
        }
      }
      if (best) return best;
    }
    if (lowHp) {
      // Fall back toward own spawn side.
      const sp = sim.map.spawns.filter((s) => s.team === me.team);
      if (sp.length > 0) return sp[this.rng.int(sp.length)] as Point;
    }
    if (target) return { x: target.x, y: target.y };
    return { x: sim.map.width / 2, y: sim.map.height / 2 };
  }

  private isUseful(kind: PowerUpKind, me: Tank, lowHp: boolean): boolean {
    if (kind === 'health') return lowHp || me.hp < me.maxHp * 0.7;
    return !lowHp || kind === 'shield';
  }

  private nextWaypoint(sim: Sim, me: Tank, goal: Point): Point | null {
    const ts = sim.map.tileSize;
    const goalKey = `${Math.floor(goal.x / ts)},${Math.floor(goal.y / ts)}`;
    this.pathAge++;
    if (goalKey !== this.pathGoalKey || this.pathAge > this.profile.repathTicks || this.path.length === 0) {
      this.path = findPath(sim, me.x, me.y, goal.x, goal.y);
      this.pathGoalKey = goalKey;
      this.pathAge = 0;
    }
    // Drop waypoints we've reached.
    while (this.path.length > 0) {
      const wp = this.path[0] as Point;
      if (Math.hypot(wp.x - me.x, wp.y - me.y) < ts * 0.45) this.path.shift();
      else break;
    }
    if (this.path.length === 0) return goal;
    return this.path[0] as Point;
  }
}

const clampUnit = (v: number): number => (v < -1 ? -1 : v > 1 ? 1 : v);

/** BFS over tile centres. Standing walls are obstacles, so bots route around them rather than through them. */
export function findPath(sim: Sim, fx: number, fy: number, tx: number, ty: number): Point[] {
  const m = sim.map;
  const ts = m.tileSize;
  const start = Math.floor(fy / ts) * m.cols + Math.floor(fx / ts);
  const goal = Math.floor(ty / ts) * m.cols + Math.floor(tx / ts);
  if (start === goal) return [];
  const prev = new Int32Array(m.cols * m.rows).fill(-2);
  prev[start] = -1;
  const queue: number[] = [start];
  let head = 0;
  let found = false;
  while (head < queue.length) {
    const cur = queue[head++] as number;
    if (cur === goal) {
      found = true;
      break;
    }
    const c = cur % m.cols;
    const r = Math.floor(cur / m.cols);
    for (const [dc, dr] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nc = c + dc;
      const nr = r + dr;
      if (sim.isBlockedTile(nc, nr)) continue;
      const ni = nr * m.cols + nc;
      if (prev[ni] !== -2) continue;
      prev[ni] = cur;
      queue.push(ni);
    }
  }
  if (!found) return [];
  const out: Point[] = [];
  for (let cur = goal; cur !== start && cur >= 0; cur = prev[cur] as number) {
    out.push({ x: (cur % m.cols) * ts + ts / 2, y: Math.floor(cur / m.cols) * ts + ts / 2 });
  }
  return out.reverse();
}

/** Drives any number of bots against one Sim. */
export class BotController {
  private readonly brains = new Map<string, BotBrain>();
  private seedCounter: number;

  constructor(seed = 1234) {
    this.seedCounter = seed;
  }

  addBot(tankId: string, difficulty: Difficulty): void {
    this.brains.set(tankId, new BotBrain(tankId, difficulty, this.seedCounter++));
  }

  removeBot(tankId: string): void {
    this.brains.delete(tankId);
  }

  has(tankId: string): boolean {
    return this.brains.has(tankId);
  }

  /** Call once per sim tick, before sim.step(). */
  update(sim: Sim): void {
    for (const [id, brain] of this.brains) sim.setInput(id, brain.think(sim));
  }
}
