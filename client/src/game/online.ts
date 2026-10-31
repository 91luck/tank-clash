import { GAME_CONFIG, NEUTRAL_INPUT, type ServerMessage, type TankInput } from '@tankclash/shared';
import type { InputController } from '../input/input';
import type { Connection } from '../net/connection';
import { Predictor } from './predict';
import { Timeline } from './timeline';
import type { PlayerMeta } from './renderer';
import type { MatchView } from './view';

type MatchStart = Extract<ServerMessage, { t: 'matchStart' }>;
type Snap = Extract<ServerMessage, { t: 'snap' }>;

/**
 * One online match on the client: sends input intents at the sim tick rate, buffers snapshots for interpolation,
 * predicts the local tank's movement and renders every animation frame. The server stays the only authority.
 */
export class OnlineMatch {
  private readonly timeline = new Timeline();
  private readonly predictor: Predictor;
  private readonly tickMs: number;
  private readonly interpDelay: number;
  private raf = 0;
  private seq = 0;
  private acc = 0;
  private lastFrame = 0;
  private clockOffset: number | null = null;
  private running = false;
  private lastSent: TankInput = { ...NEUTRAL_INPUT };

  constructor(
    private readonly start: MatchStart,
    players: PlayerMeta[],
    private readonly view: MatchView,
    private readonly conn: Connection,
    private readonly input: InputController,
  ) {
    const me = players.find((p) => p.id === start.you);
    this.predictor = new Predictor(
      start.tickRate,
      me ?? { id: start.you, name: '?', team: 1, cls: 'assault' },
    );
    this.predictor.resetWalls(start.snap.wd ?? []);
    this.tickMs = 1000 / start.tickRate;
    // Render two snapshot intervals in the past so we nearly always have two snapshots to blend.
    this.interpDelay = (2 * start.snapshotEvery) / start.tickRate;
    view.begin(start.you, players, start.snap);
    this.ingest(start.snap, 0);
  }

  get meId(): string {
    return this.start.you;
  }

  get angle(): number {
    return this.predictor.angle;
  }

  /** Latest match phase from the server (debug/test hook). */
  phase(): string | null {
    return this.timeline.latest()?.phase ?? null;
  }

  /** Server-confirmed state of the local tank (debug/test hook; carries no authority). */
  self(): { x: number; y: number; a: number; alive: boolean } | null {
    const t = this.timeline.latest()?.tanks.find((k) => k.id === this.start.you);
    return t ? { x: t.x, y: t.y, a: t.a, alive: t.al === 1 } : null;
  }

  run(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  /** Release held controls on the server immediately (tab hidden, pause menu, etc.). */
  sendNeutral(): void {
    this.conn.send({ t: 'input', seq: ++this.seq, ...NEUTRAL_INPUT });
    this.lastSent = { ...NEUTRAL_INPUT };
  }

  onSnap(m: Snap): void {
    this.ingest(m.s, m.ack);
    this.view.onEvents(m.ev);
    for (const e of m.ev) if (e.e === 'wallDown') this.predictor.wallDown(e.wall);
  }

  private ingest(s: Snap['s'], ack: number): void {
    const serverTime = s.tick / this.start.tickRate;
    const now = performance.now() / 1000;
    const target = now - serverTime;
    // Packets that arrive "early" define the clock; jittery late ones only nudge it. This keeps the render
    // clock tracking the lowest-latency path instead of oscillating with network jitter.
    if (this.clockOffset === null || target < this.clockOffset) this.clockOffset = target;
    else this.clockOffset += (target - this.clockOffset) * 0.02;
    this.timeline.push(serverTime, s);
    const mine = s.tanks.find((t) => t.id === this.start.you);
    if (mine) this.predictor.reconcile(mine, ack);
  }

  private frame(nowMs: number): void {
    if (!this.running) return;
    const dtMs = Math.min(250, nowMs - this.lastFrame);
    this.lastFrame = nowMs;

    // Fixed-rate input sampling, decoupled from the display refresh rate.
    this.acc += dtMs;
    let n = 0;
    while (this.acc >= this.tickMs && n < 5) {
      this.acc -= this.tickMs;
      n++;
      this.sendInput();
    }
    if (n === 5) this.acc = 0;

    this.predictor.smooth(dtMs / 1000);
    const latest = this.timeline.latest();
    if (latest) {
      const renderT = nowMs / 1000 - (this.clockOffset ?? 0) - this.interpDelay;
      const frame = this.timeline.sample(renderT) ?? latest;
      const alive = latest.tanks.find((t) => t.id === this.start.you)?.al === 1;
      this.view.draw(frame, latest, nowMs, alive ? this.predictor.pose() : null, { rtt: this.conn.rttMs });
    }
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private sendInput(): void {
    const input = this.input.read();
    const idle = !input.throttle && !input.turn && !input.fire && !input.ability;
    const wasIdle =
      !this.lastSent.throttle && !this.lastSent.turn && !this.lastSent.fire && !this.lastSent.ability;
    // The server keeps the last input, so a stationary player needn't spam packets; send one neutral then a keep-alive.
    const keepAlive = this.seq % 15 === 0;
    if (idle && wasIdle && !keepAlive) {
      this.seq++;
      this.predictor.step(this.seq, input);
      return;
    }
    this.seq++;
    this.lastSent = input;
    const vt = this.viewTick();
    this.conn.send(
      vt === null ? { t: 'input', seq: this.seq, ...input } : { t: 'input', seq: this.seq, ...input, vt },
    );
    this.predictor.step(this.seq, input);
  }

  /**
   * The server tick currently on screen (interpolated world). Sent with each input so the server can judge this
   * player's shots against what they actually saw (lag compensation). Null until the clock is synchronised.
   */
  private viewTick(): number | null {
    if (this.clockOffset === null) return null;
    const renderT = performance.now() / 1000 - this.clockOffset - this.interpDelay;
    return Math.max(0, Math.floor(renderT * this.start.tickRate));
  }
}

export const INPUT_RATE_HZ = GAME_CONFIG.tickRate;
