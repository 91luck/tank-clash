import {
  BotController,
  GAME_CONFIG,
  Sim,
  TANK_CLASSES,
  type TankClass,
  type TeamId,
} from '@tankclash/shared';
import { Renderer, type PlayerMeta } from './renderer';
import { Timeline } from './timeline';

/**
 * Arcade "attract mode": a real bot match (same Sim and bot AI as the game) playing behind the main menu.
 * Pauses whenever the menu is hidden or the tab is in the background; with reduced motion it renders one
 * still frame of a match in progress instead of animating.
 */
export class AttractMode {
  private readonly renderer: Renderer;
  private sim!: Sim;
  private bots!: BotController;
  private players = new Map<string, PlayerMeta>();
  private readonly timeline = new Timeline();
  private raf = 0;
  private running = false;
  private acc = 0;
  private last = 0;
  private seed = (Math.random() * 1e9) | 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly reduceMotion: () => boolean,
  ) {
    this.renderer = new Renderer(canvas, new Sim().map, { fit: 'cover', maxDpr: 1.5 });
    this.reset();
    window.addEventListener('resize', () => this.renderer.resize());
  }

  private reset(): void {
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    // Short matches so the background keeps showing action, never a results screen.
    this.sim = new Sim({ seed: this.seed || 1, settings: { durationSec: 90 } });
    this.bots = new BotController(this.seed + 7);
    this.players.clear();
    for (let i = 0; i < 6; i++) {
      const team: TeamId = i % 2 === 0 ? 1 : 2;
      const cls = TANK_CLASSES[(this.seed + i) % TANK_CLASSES.length] as TankClass;
      const id = `a${i}`;
      this.sim.addTank({ id, name: '', team, cls });
      this.players.set(id, { id, name: '', team, cls });
      this.bots.addBot(id, i < 2 ? 'hard' : 'normal');
    }
    // Skip the countdown and the first quiet seconds so the scene opens mid-battle.
    for (let i = 0; i < GAME_CONFIG.tickRate * 9; i++) this.tick();
    this.timeline.clear();
    this.renderer.resetWalls([...this.sim.wallHp].flatMap((hp, id) => (hp <= 0 ? [id] : [])));
    this.timeline.push(this.sim.tick * this.sim.dt, this.sim.snapshot(false));
  }

  private tick(): void {
    this.bots.update(this.sim);
    this.sim.step();
    for (const ev of this.sim.drainEvents()) {
      if (ev.e === 'kill') this.renderer.explosion(ev.x, ev.y, true);
      else if (ev.e === 'wallHit') this.renderer.setWallHp(ev.wall, ev.hp);
      else if (ev.e === 'wallDown') this.renderer.setWallHp(ev.wall, 0);
      else if (ev.e === 'shot') this.renderer.muzzle(ev.x, ev.y, ev.a, true);
    }
    if (this.sim.phase === 'ended') this.reset();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.renderer.resize();
    this.last = performance.now();
    if (this.reduceMotion()) {
      this.drawOnce();
      this.running = false;
      return;
    }
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private drawOnce(): void {
    const s = this.sim.snapshot(false);
    this.renderer.draw(s, this.players, null, performance.now(), true);
  }

  private frame(now: number): void {
    if (!this.running) return;
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.acc += dt;
    let n = 0;
    while (this.acc >= this.sim.dt && n < 3) {
      this.acc -= this.sim.dt;
      this.tick();
      this.timeline.push(this.sim.tick * this.sim.dt, this.sim.snapshot(false));
      n++;
    }
    if (n === 3) this.acc = 0;
    const latest = this.timeline.latest();
    if (latest) {
      const t = this.sim.tick * this.sim.dt - this.sim.dt + this.acc;
      this.renderer.draw(this.timeline.sample(t) ?? latest, this.players, null, now, true);
    }
    this.raf = requestAnimationFrame((x) => this.frame(x));
  }
}
