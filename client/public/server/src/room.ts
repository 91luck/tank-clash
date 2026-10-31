import {
  BotController,
  GAME_CONFIG,
  NEUTRAL_INPUT,
  Sim,
  TANK_CLASSES,
  type Difficulty,
  defaultMatchSettings,
  type BoardEntry,
  type ErrorCode,
  type MatchSettings,
  type PlayerInfo,
  type RoomInfo,
  type RoomPhase,
  type ServerMessage,
  type TankClass,
  type TeamId,
} from '@tankclash/shared';
import { secureRandomInt } from './security';

export type Result = { ok: true } | { ok: false; code: ErrorCode; message: string };
const OK: Result = { ok: true };
const fail = (code: ErrorCode, message: string): Result => ({ ok: false, code, message });

export interface RoomPlayer {
  id: string;
  name: string;
  team: TeamId;
  cls: TankClass;
  connected: boolean;
  /** Set for computer-controlled tanks. */
  bot?: Difficulty;
}

const BOT_NAMES = ['Rook', 'Bolt', 'Ember', 'Nova', 'Tusk', 'Gizmo', 'Flint', 'Vex'];

export interface RoomDeps {
  /** Deliver a message (object or pre-serialised JSON string) to one player. */
  send(playerId: string, payload: ServerMessage | string): void;
  now(): number;
  tickRate: number;
  snapshotEvery: number;
}

/**
 * One match room: lobby -> match -> results -> (rematch | lobby).
 * Pure game logic; knows nothing about sockets, so it can be unit-tested directly.
 */
export class Room {
  phase: RoomPhase = 'lobby';
  hostId: string;
  settings: MatchSettings = defaultMatchSettings();
  readonly players = new Map<string, RoomPlayer>();
  sim: Sim | null = null;
  lastActivity: number;
  private lastSeq = new Map<string, number>();
  private lastInputAt = new Map<string, number>();
  private lastEnd: ServerMessage | null = null;
  private lastOvertime = false;
  private bots: BotController | null = null;
  private botSeq = 0;

  constructor(
    readonly code: string,
    hostId: string,
    hostName: string,
    private readonly deps: RoomDeps,
    readonly quick = false,
  ) {
    this.hostId = hostId;
    this.lastActivity = deps.now();
    this.players.set(hostId, { id: hostId, name: hostName, team: 1, cls: 'assault', connected: true });
  }

  // ------------------------------------------------------------ membership

  info(): RoomInfo {
    const players: PlayerInfo[] = [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      team: p.team,
      cls: p.cls,
      connected: p.connected,
      ...(p.bot ? { bot: p.bot } : {}),
    }));
    return {
      code: this.code,
      hostId: this.hostId,
      phase: this.phase,
      settings: { ...this.settings },
      maxPlayers: GAME_CONFIG.match.maxPlayers,
      quick: this.quick,
      players,
    };
  }

  teamCount(team: TeamId): number {
    let n = 0;
    for (const p of this.players.values()) if (p.team === team) n++;
    return n;
  }

  private humansOn(team: TeamId): number {
    let n = 0;
    for (const p of this.players.values()) if (!p.bot && p.team === team) n++;
    return n;
  }

  /** Newest bot on a team (the one a joining human replaces). */
  private botOn(team: TeamId): RoomPlayer | undefined {
    return [...this.players.values()].reverse().find((p) => p.bot && p.team === team);
  }

  /**
   * Seat for a newcomer. Humans are spread evenly across the two squads (bots only fill gaps): the side with fewer
   * humans wins, ties go to the side with fewer tanks. A full side still has a seat if a bot can make way.
   */
  private pickSeat(requested?: TeamId): { team: TeamId; replace?: RoomPlayer } | null {
    const perTeam = GAME_CONFIG.match.maxPlayers / 2;
    const hasSeat = (t: TeamId): boolean => this.teamCount(t) < perTeam || !!this.botOn(t);
    let team: TeamId =
      requested ??
      (this.humansOn(1) !== this.humansOn(2)
        ? this.humansOn(1) < this.humansOn(2)
          ? 1
          : 2
        : this.teamCount(1) <= this.teamCount(2)
          ? 1
          : 2);
    if (!hasSeat(team)) {
      const other: TeamId = team === 1 ? 2 : 1;
      if (requested !== undefined || !hasSeat(other)) return null;
      team = other;
    }
    return { team, replace: this.teamCount(team) >= perTeam ? this.botOn(team) : undefined };
  }

  /**
   * Join in any phase. In the lobby/results the newcomer just takes a seat; during a running match they drop straight
   * into the battle on the auto-balanced side (with spawn protection), replacing a bot if that side is full.
   */
  addPlayer(id: string, name: string, team?: TeamId): Result {
    if (this.players.has(id)) return fail('bad_state', 'Already in this room.');
    const seat = this.pickSeat(team);
    if (!seat) return fail('room_full', 'This room is full.');
    if (this.phase === 'match' && (!this.sim || this.sim.phase === 'ended'))
      return fail('match_in_progress', 'This match is just finishing. Try again in a moment.');
    this.players.set(id, { id, name, team: seat.team, cls: 'assault', connected: true });
    if (seat.replace) this.players.delete(seat.replace.id);
    if (this.phase === 'match' && this.sim) {
      // Add the human before removing the bot, so the side is never momentarily empty (which would forfeit).
      this.sim.addTank({ id, name, team: seat.team, cls: 'assault' });
      if (seat.replace) {
        this.bots?.removeBot(seat.replace.id);
        this.sim.removeTank(seat.replace.id);
      }
    }
    this.touch();
    this.broadcastRoom();
    if (this.phase === 'match' && this.sim) this.sendMatchStart(id);
    // Joining between matches (results screen): show the newcomer the last result; they play the rematch.
    if (this.phase === 'results' && this.lastEnd) this.deps.send(id, this.lastEnd);
    return OK;
  }

  removePlayer(id: string): void {
    if (!this.players.delete(id)) return;
    this.lastSeq.delete(id);
    this.touch();
    if (this.hostId === id) this.transferHost();
    if (this.phase === 'match' && this.sim) {
      this.sim.removeTank(id);
      if (this.sim.phase === 'ended') {
        this.sendSnapshot();
        this.finishMatch();
      }
    }
    this.broadcastRoom();
  }

  private transferHost(): void {
    const humans = [...this.players.values()].filter((p) => !p.bot);
    const next = humans.find((p) => p.connected) ?? humans[0];
    if (next) this.hostId = next.id;
  }

  setConnected(id: string, connected: boolean): void {
    const p = this.players.get(id);
    if (!p) return;
    p.connected = connected;
    this.touch();
    if (!connected) {
      this.sim?.setInput(id, NEUTRAL_INPUT); // a dropped connection stops steering immediately
      if (this.hostId === id) this.transferHost();
    } else {
      this.lastSeq.delete(id);
    }
    this.broadcastRoom();
  }

  /** Re-send whatever state a resuming player needs. */
  resync(id: string): void {
    this.deps.send(id, { t: 'room', room: this.info() });
    if (this.phase === 'match' && this.sim) this.sendMatchStart(id);
    else if (this.phase === 'results' && this.lastEnd) this.deps.send(id, this.lastEnd);
  }

  // ------------------------------------------------------------ lobby actions

  setTeam(id: string, team: TeamId): Result {
    const p = this.players.get(id);
    if (!p) return fail('not_in_room', 'You are not in this room.');
    if (this.phase !== 'lobby') return fail('bad_state', 'Teams can only be changed in the lobby.');
    if (p.team === team) return OK;
    if (this.teamCount(team) >= GAME_CONFIG.match.maxPlayers / 2)
      return fail('team_full', 'That team is full.');
    p.team = team;
    this.touch();
    this.broadcastRoom();
    return OK;
  }

  setClass(id: string, cls: TankClass): Result {
    const p = this.players.get(id);
    if (!p) return fail('not_in_room', 'You are not in this room.');
    if (this.phase !== 'lobby') return fail('bad_state', 'Tank class can only be changed in the lobby.');
    p.cls = cls;
    this.touch();
    this.broadcastRoom();
    return OK;
  }

  setSettings(id: string, patch: { durationSec?: number }): Result {
    if (!this.players.has(id)) return fail('not_in_room', 'You are not in this room.');
    if (id !== this.hostId) return fail('not_host', 'Only the host can change match options.');
    if (this.phase !== 'lobby') return fail('bad_state', 'Options can only be changed in the lobby.');
    if (patch.durationSec !== undefined) this.settings.durationSec = patch.durationSec;
    this.touch();
    this.broadcastRoom();
    return OK;
  }

  toLobby(id: string): Result {
    if (!this.players.has(id)) return fail('not_in_room', 'You are not in this room.');
    if (id !== this.hostId) return fail('not_host', 'Only the host can return the room to the lobby.');
    if (this.phase !== 'results') return fail('bad_state', 'The room is not showing results.');
    this.phase = 'lobby';
    this.lastEnd = null;
    this.touch();
    this.broadcastRoom();
    return OK;
  }

  /**
   * A running match that a "Play now" player can be dropped into: it has a seat and at least one human who is
   * actually connected (never drop someone into a room whose people have all left and only bots remain).
   */
  acceptsDropIn(): boolean {
    if (this.phase !== 'match' || !this.sim || this.sim.phase === 'ended' || this.pickSeat() === null)
      return false;
    for (const p of this.players.values()) if (!p.bot && p.connected) return true;
    return false;
  }

  humanCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (!p.bot) n++;
    return n;
  }

  addBot(id: string, team: TeamId, difficulty: Difficulty): Result {
    const guard = this.hostLobbyGuard(id, 'add bots');
    if (guard) return guard;
    if (this.players.size >= GAME_CONFIG.match.maxPlayers) return fail('room_full', 'This room is full.');
    if (this.teamCount(team) >= GAME_CONFIG.match.maxPlayers / 2)
      return fail('team_full', 'That team is full.');
    this.insertBot(team, difficulty);
    this.touch();
    this.broadcastRoom();
    return OK;
  }

  removeBot(id: string, botId: string): Result {
    const guard = this.hostLobbyGuard(id, 'remove bots');
    if (guard) return guard;
    if (!this.players.get(botId)?.bot) return fail('bad_state', 'No such bot.');
    this.players.delete(botId);
    this.touch();
    this.broadcastRoom();
    return OK;
  }

  /** Even out the teams with bots, at least 2 per side. */
  fillBots(id: string, difficulty: Difficulty): Result {
    const guard = this.hostLobbyGuard(id, 'add bots');
    if (guard) return guard;
    const perTeam = Math.min(
      GAME_CONFIG.match.maxPlayers / 2,
      Math.max(2, this.teamCount(1), this.teamCount(2)),
    );
    for (const team of [1, 2] as TeamId[]) {
      while (this.teamCount(team) < perTeam && this.players.size < GAME_CONFIG.match.maxPlayers) {
        this.insertBot(team, difficulty);
      }
    }
    this.touch();
    this.broadcastRoom();
    return OK;
  }

  private hostLobbyGuard(id: string, what: string): Result | null {
    if (!this.players.has(id)) return fail('not_in_room', 'You are not in this room.');
    if (id !== this.hostId) return fail('not_host', `Only the host can ${what}.`);
    if (this.phase !== 'lobby') return fail('bad_state', `You can only ${what} in the lobby.`);
    return null;
  }

  private insertBot(team: TeamId, difficulty: Difficulty): void {
    const n = this.botSeq++;
    const id = `bot-${n}`;
    const name = `${BOT_NAMES[n % BOT_NAMES.length] as string} (bot)`;
    const cls = TANK_CLASSES[secureRandomInt(TANK_CLASSES.length)] as TankClass;
    this.players.set(id, { id, name, team, cls, connected: true, bot: difficulty });
  }

  // ------------------------------------------------------------ match lifecycle

  /** Start (from lobby) or rematch (from results). Host only. */
  start(id: string): Result {
    if (!this.players.has(id)) return fail('not_in_room', 'You are not in this room.');
    if (id !== this.hostId) return fail('not_host', 'Only the host can start the match.');
    if (this.phase === 'match') return fail('bad_state', 'A match is already running.');
    return this.begin();
  }

  /** Used by matchmaking, which has no human host to press Start. */
  begin(): Result {
    if (this.players.size < GAME_CONFIG.match.minPlayers)
      return fail('need_players', 'At least 2 players are needed.');
    if (this.teamCount(1) === 0 || this.teamCount(2) === 0) {
      return fail('need_players', 'Both teams need at least one player.');
    }
    const sim = new Sim({
      seed: 1 + secureRandomInt(2 ** 31 - 2),
      settings: this.settings,
      tickRate: this.deps.tickRate,
    });
    for (const p of this.players.values()) sim.addTank({ id: p.id, name: p.name, team: p.team, cls: p.cls });
    const bots = [...this.players.values()].filter((p) => p.bot);
    this.bots = bots.length > 0 ? new BotController(1 + secureRandomInt(1_000_000)) : null;
    for (const b of bots) this.bots?.addBot(b.id, b.bot as Difficulty);
    this.sim = sim;
    this.lastSeq.clear();
    this.lastInputAt.clear();
    this.lastEnd = null;
    this.lastOvertime = false;
    this.phase = 'match';
    this.touch();
    this.broadcastRoom();
    for (const p of this.players.values()) if (p.connected) this.sendMatchStart(p.id);
    return OK;
  }

  private sendMatchStart(id: string): void {
    if (!this.sim) return;
    this.deps.send(id, {
      t: 'matchStart',
      mapId: this.sim.map.id,
      tickRate: this.deps.tickRate,
      snapshotEvery: this.deps.snapshotEvery,
      you: id,
      snap: this.sim.snapshot(true),
    });
  }

  /**
   * Accepts a *movement/fire intention* only. Stale or duplicated packets (seq not increasing) are dropped,
   * and everything is clamped again inside Sim.setInput.
   */
  handleInput(
    id: string,
    seq: number,
    input: { throttle: number; turn: number; fire: boolean; ability: boolean; vt?: number },
  ): void {
    if (this.phase !== 'match' || !this.sim) return;
    const p = this.players.get(id);
    if (!p || !p.connected) return;
    const last = this.lastSeq.get(id) ?? -1;
    if (seq <= last) return;
    this.lastSeq.set(id, seq);
    this.lastInputAt.set(id, this.sim.tick);
    this.sim.setInput(id, input);
    // Lag compensation: the input is applied on the next tick; the player was looking at tick `vt`.
    // Sim clamps this to [0, maxRewind], so an absurd or future `vt` cannot widen the rewind.
    if (input.vt !== undefined) this.sim.setViewLag(id, this.sim.tick + 1 - input.vt);
  }

  tick(): void {
    if (this.phase !== 'match' || !this.sim) return;
    this.dropStaleInputs(this.sim);
    this.bots?.update(this.sim);
    this.sim.step();
    if (this.sim.phase === 'overtime') this.lastOvertime = true;
    if (this.sim.phase === 'ended') {
      this.sendSnapshot();
      this.finishMatch();
      return;
    }
    if (this.sim.tick % this.deps.snapshotEvery === 0) this.sendSnapshot();
  }

  /** A client that stops sending (frozen/backgrounded tab) must not keep driving with its last input. */
  private dropStaleInputs(sim: Sim): void {
    const maxAge = this.deps.tickRate; // 1 second
    for (const [id, tick] of this.lastInputAt) {
      if (sim.tick - tick > maxAge) {
        sim.setInput(id, NEUTRAL_INPUT);
        this.lastInputAt.delete(id);
      }
    }
  }

  private sendSnapshot(): void {
    const sim = this.sim;
    if (!sim) return;
    const snapJson = JSON.stringify(sim.snapshot(false));
    const evJson = JSON.stringify(sim.drainEvents());
    for (const p of this.players.values()) {
      if (!p.connected) continue;
      const ack = this.lastSeq.get(p.id) ?? 0;
      this.deps.send(p.id, `{"t":"snap","ack":${ack},"s":${snapJson},"ev":${evJson}}`);
    }
  }

  private finishMatch(): void {
    const sim = this.sim;
    if (!sim) return;
    const board: BoardEntry[] = [...sim.tanks.values()].map((t) => ({
      id: t.id,
      name: t.name,
      team: t.team,
      cls: t.cls,
      kills: t.kills,
      deaths: t.deaths,
      ...(this.players.get(t.id)?.bot ? { bot: true } : {}),
    }));
    const end: ServerMessage = {
      t: 'matchEnd',
      winner: sim.winner ?? 0,
      scores: [sim.scores[1], sim.scores[2]],
      board,
      overtime: this.lastOvertime,
    };
    this.lastEnd = end;
    this.sim = null;
    this.bots = null;
    this.phase = 'results';
    this.touch();
    for (const p of this.players.values()) if (p.connected) this.deps.send(p.id, end);
    this.broadcastRoom();
  }

  // ------------------------------------------------------------ housekeeping

  touch(): void {
    this.lastActivity = this.deps.now();
  }

  hasConnectedPlayers(): boolean {
    for (const p of this.players.values()) if (p.connected && !p.bot) return true;
    return false;
  }

  isExpired(now: number, lobbyMs: number, resultsMs: number): boolean {
    if (this.phase === 'lobby') return now - this.lastActivity > lobbyMs;
    if (this.phase === 'results') return now - this.lastActivity > resultsMs;
    return false; // matches end on their own timer
  }

  broadcastRoom(): void {
    const msg: ServerMessage = { t: 'room', room: this.info() };
    for (const p of this.players.values()) if (p.connected && !p.bot) this.deps.send(p.id, msg);
  }

  broadcast(msg: ServerMessage): void {
    for (const p of this.players.values()) if (p.connected) this.deps.send(p.id, msg);
  }
}
