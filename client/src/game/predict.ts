import {
  CLASS_ABILITY,
  GAME_CONFIG,
  Sim,
  type Tank,
  type TankClass,
  type TankInput,
  type TankSnapshot,
  type TeamId,
} from '@tankclash/shared';

export interface PredictedPose {
  x: number;
  y: number;
  a: number;
}

interface Pending {
  seq: number;
  input: TankInput;
}

/**
 * Client-side prediction for the local tank's *movement only*.
 *
 * Shooting, damage, kills and power-ups are never predicted: they always come from the server. Movement uses the
 * exact same `Sim.applyMovement` as the server, so on an open field prediction and server agree to the pixel. When
 * the server disagrees (ran into another tank, a wall that the client thinks is still standing, lost packets),
 * the error is folded into a visual offset that decays smoothly instead of teleporting the tank.
 */
export class Predictor {
  private readonly sim: Sim;
  private readonly tank: Tank;
  private pending: Pending[] = [];
  private errX = 0;
  private errY = 0;
  private errA = 0;
  private synced = false;

  constructor(tickRate: number, me: { id: string; name: string; team: TeamId; cls: TankClass }) {
    this.sim = new Sim({ tickRate });
    this.tank = this.sim.addTank(me);
    this.sim.tick = 1000; // arbitrary base: only relative "until" comparisons matter
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** Mirror the server's wall state (full snapshot `wd` list on matchStart/resync). */
  resetWalls(destroyed: readonly number[]): void {
    this.sim.wallHp.fill(GAME_CONFIG.walls.destructibleHp);
    for (const id of destroyed) if (id >= 0 && id < this.sim.wallHp.length) this.sim.wallHp[id] = 0;
  }

  wallDown(id: number): void {
    if (id >= 0 && id < this.sim.wallHp.length) this.sim.wallHp[id] = 0;
  }

  /** Called once per client tick, right when the input is sent to the server. */
  step(seq: number, input: TankInput): void {
    if (!this.synced || !this.tank.alive) return;
    this.pending.push({ seq, input: { ...input } });
    if (this.pending.length > 90) this.pending.shift(); // 3 s of unacked input is already a dead connection
    this.advance(input);
  }

  /** Apply a server snapshot of our own tank plus the highest input seq the server has processed. */
  reconcile(server: TankSnapshot, ack: number): void {
    const before = this.pose();
    this.tank.alive = server.al === 1;
    this.syncEffects(server);
    this.pending = this.pending.filter((p) => p.seq > ack);
    this.tank.x = server.x;
    this.tank.y = server.y;
    this.tank.angle = server.a;

    if (!this.synced || !this.tank.alive) {
      this.synced = true;
      this.pending = [];
      this.errX = this.errY = this.errA = 0;
      return;
    }
    for (const p of this.pending) this.advance(p.input);

    const after = this.pose();
    const dx = before.x - after.x;
    const dy = before.y - after.y;
    // Big divergence (respawn, being rammed, teleport): snap instead of smoothing across the map.
    if (Math.hypot(dx, dy) > 60) {
      this.errX = this.errY = this.errA = 0;
    } else {
      this.errX += dx;
      this.errY += dy;
      this.errA += angleDiff(before.a, after.a);
    }
  }

  /** Decay the visual error. Call once per rendered frame. */
  smooth(dtSec: number): void {
    const k = Math.pow(0.0005, dtSec); // ~90% gone in 0.3 s
    this.errX *= k;
    this.errY *= k;
    this.errA *= k;
    if (Math.abs(this.errX) < 0.01) this.errX = 0;
    if (Math.abs(this.errY) < 0.01) this.errY = 0;
    if (Math.abs(this.errA) < 0.0005) this.errA = 0;
  }

  /** Where the tank should be drawn. */
  pose(): PredictedPose {
    return { x: this.tank.x + this.errX, y: this.tank.y + this.errY, a: this.tank.angle + this.errA };
  }

  /** Authoritative-ish heading (used by the touch joystick so steering feels responsive). */
  get angle(): number {
    return this.tank.angle;
  }

  private advance(input: TankInput): void {
    this.sim.tick += 1;
    this.tank.input = input;
    this.sim.applyMovement(this.tank);
  }

  private syncEffects(s: TankSnapshot): void {
    const far = this.sim.tick + 1_000_000;
    this.tank.speedBoostUntil = (s.fx & 1) !== 0 ? far : 0;
    this.tank.abilityActiveUntil = s.ab === 1 && CLASS_ABILITY[this.tank.cls] === 'speed' ? far : 0;
  }
}

function angleDiff(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
