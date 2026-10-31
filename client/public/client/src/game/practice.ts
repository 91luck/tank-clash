import {
  BotController,
  GAME_CONFIG,
  Sim,
  TANK_CLASSES,
  type BoardEntry,
  type Difficulty,
  type TankClass,
  type TeamId,
} from '@tankclash/shared';
import type { InputController } from '../input/input';
import type { PlayerMeta } from './renderer';
import { Timeline } from './timeline';
import type { MatchView } from './view';

export interface PracticeOptions {
  name: string;
  cls: TankClass;
  difficulty: Difficulty;
  /** 1 = 1v1, 2 = 2v2 with a computer ally. */
  perTeam: 1 | 2;
}

export interface PracticeResult {
  winner: 0 | TeamId;
  scores: [number, number];
  board: BoardEntry[];
  overtime: boolean;
}

const BOT_NAMES = ['Bolt', 'Rook', 'Gizmo', 'Ember', 'Nova', 'Tusk'];

/** Offline match: the very same `Sim` as the server runs locally, with bots driving the other tanks. */
export class PracticeMatch {
  readonly sim: Sim;
  readonly meId = 'me';
  readonly players: PlayerMeta[] = [];
  paused = false;
  private readonly bots: BotController;
  private readonly timeline = new Timeline();
  private raf = 0;
  private running = false;
  private acc = 0;
  private last = 0;
  private overtime = false;
  private finished = false;

  constructor(
    readonly opts: PracticeOptions,
    private readonly view: MatchView,
    private readonly input: InputController,
    private readonly onEnd: (r: PracticeResult) => void,
    seed = (Math.random() * 2 ** 31) | 0 || 1,
  ) {
    this.sim = new Sim({ seed, tickRate: GAME_CONFIG.tickRate });
    this.bots = new BotController(seed ^ 0x5bd1e995);
    const add = (id: string, name: string, team: TeamId, cls: TankClass, bot: boolean): void => {
      this.sim.addTank({ id, name, team, cls });
      this.players.push({ id, name, team, cls });
      if (bot) this.bots.addBot(id, opts.difficulty);
    };
    const pick = (i: number): TankClass => TANK_CLASSES[(seed + i * 7) % TANK_CLASSES.length] as TankClass;
    add(this.meId, opts.name, 1, opts.cls, false);
    if (opts.perTeam === 2) add('bot-ally', `${BOT_NAMES[0]} (ally)`, 1, pick(1), true);
    for (let i = 0; i < opts.perTeam; i++) add(`bot-e${i}`, BOT_NAMES[i + 1] as string, 2, pick(i + 2), true);
    this.record();
    view.begin(this.meId, this.players, this.sim.snapshot(true));
  }

  get angle(): number {
    return this.sim.tanks.get(this.meId)?.angle ?? 0;
  }

  phase(): string {
    return this.sim.phase;
  }

  self(): { x: number; y: number; a: number; alive: boolean } | null {
    const t = this.sim.tanks.get(this.meId);
    return t ? { x: t.x, y: t.y, a: t.angle, alive: t.alive } : null;
  }

  run(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  setPaused(p: boolean): void {
    this.paused = p;
    this.last = performance.now();
  }

  private record(): void {
    this.timeline.push(this.sim.tick * this.sim.dt, this.sim.snapshot(false));
  }

  private frame(nowMs: number): void {
    if (!this.running) return;
    const dtMs = Math.min(250, nowMs - this.last);
    this.last = nowMs;
    if (!this.paused && !this.finished) {
      this.acc += dtMs / 1000;
      let n = 0;
      while (this.acc >= this.sim.dt && n < 5) {
        this.acc -= this.sim.dt;
        n++;
        this.tickOnce();
        if (this.finished) break;
      }
      if (n === 5) this.acc = 0;
    }
    const latest = this.timeline.latest();
    if (latest) {
      // Render one tick behind real sim time so there is always a "next" snapshot to blend toward.
      const t = this.sim.tick * this.sim.dt - this.sim.dt + (this.paused ? 0 : this.acc);
      this.view.draw(this.timeline.sample(t) ?? latest, latest, nowMs, null, null);
    }
    if (this.running) this.raf = requestAnimationFrame((x) => this.frame(x));
  }

  private tickOnce(): void {
    this.sim.setInput(this.meId, this.input.read());
    this.bots.update(this.sim);
    this.sim.step();
    if (this.sim.phase === 'overtime') this.overtime = true;
    this.view.onEvents(this.sim.drainEvents());
    this.record();
    if (this.sim.phase === 'ended' && !this.finished) {
      this.finished = true;
      const board: BoardEntry[] = [...this.sim.tanks.values()].map((t) => ({
        id: t.id,
        name: t.name,
        team: t.team,
        cls: t.cls,
        kills: t.kills,
        deaths: t.deaths,
      }));
      // Let the final explosion play for a moment before the results screen.
      window.setTimeout(
        () =>
          this.onEnd({
            winner: this.sim.winner ?? 0,
            scores: [this.sim.scores[1], this.sim.scores[2]],
            board,
            overtime: this.overtime,
          }),
        1200,
      );
    }
  }
}
