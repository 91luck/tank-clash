import { ClientMessageSchema } from '@tankclash/shared/schemas';
import {
  GAME_CONFIG,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ErrorCode,
  type ServerMessage,
  type TeamId,
} from '@tankclash/shared';
import type { ServerConfig } from './config';
import { createLogger, type Logger } from './logger';
import { Room, type Result } from './room';
import {
  ConnectionCounter,
  FailureLimiter,
  TokenBucket,
  generatePlayerId,
  generateRoomCode,
  generateToken,
} from './security';

/**
 * What the core needs from a connection. Implemented by the Node `ws` adapter and the Cloudflare adapter.
 */
export interface Transport {
  send(text: string): void;
  close(code: number, reason: string): void;
  /** Bytes queued but not yet flushed (0 when the runtime cannot tell). Used for slow-consumer protection. */
  bufferedAmount(): number;
  /** Hard-kill the connection without a close handshake. */
  terminate(): void;
}

export interface Client {
  transport: Transport;
  ip: string;
  session: Session | null;
  inputBucket: TokenBucket;
  msgBucket: TokenBucket;
  createBucket: TokenBucket;
  violations: number;
  inputDrops: number;
  badMessages: number;
  lastRateErrorAt: number;
}

interface Session {
  id: string;
  token: string;
  name: string;
  client: Client | null;
  roomCode: string | null;
  disconnectedAt: number | null;
}

export interface ServerStats {
  connections: number;
  sessions: number;
  rooms: number;
  roomsInMatch: number;
  ticks: number;
  tickMsTotal: number;
  tickMsMax: number;
  msgsIn: number;
  msgsOut: number;
  bytesOut: number;
  rejected: number;
}

const MAX_BUFFERED_BYTES = 1_000_000; // slow-consumer protection

/**
 * All multiplayer logic (sessions, rooms, matchmaking, validation, rate limits), independent of any
 * network library or runtime. Adapters feed it connections and messages.
 */
export class GameCore {
  private readonly log: Logger;
  private readonly clients = new Set<Client>();
  private readonly sessions = new Map<string, Session>();
  private readonly tokens = new Map<string, Session>();
  private readonly rooms = new Map<string, Room>();
  private readonly connCounter: ConnectionCounter;
  private readonly joinFailures = new FailureLimiter(8, 60_000);
  private queue: string[] = [];
  private quickTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly startedAt = Date.now();
  private readonly counters: ServerStats = {
    connections: 0,
    sessions: 0,
    rooms: 0,
    roomsInMatch: 0,
    ticks: 0,
    tickMsTotal: 0,
    tickMsMax: 0,
    msgsIn: 0,
    msgsOut: 0,
    bytesOut: 0,
    rejected: 0,
  };

  constructor(
    readonly cfg: ServerConfig,
    log?: Logger,
    private readonly opts: { manualTicks?: boolean } = {},
  ) {
    this.log = log ?? createLogger(cfg.logLevel);
    this.connCounter = new ConnectionCounter(cfg.maxConnectionsPerIp);
  }

  // ------------------------------------------------------------ lifecycle

  get running(): boolean {
    return this.sweepTimer !== null;
  }

  stop(): void {
    for (const t of [this.tickTimer, this.sweepTimer, this.quickTimer]) if (t) clearInterval(t);
    this.tickTimer = this.sweepTimer = this.quickTimer = null;
    for (const c of this.clients) c.transport.terminate();
    this.clients.clear();
  }

  /** Called by adapters; counts toward the HTTP /health response. */
  health(): Record<string, unknown> {
    return {
      status: 'ok',
      protocol: PROTOCOL_VERSION,
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      rooms: this.rooms.size,
      players: this.sessions.size,
    };
  }

  noteRejected(): void {
    this.counters.rejected++;
  }

  stats(): ServerStats {
    let inMatch = 0;
    for (const r of this.rooms.values()) if (r.phase === 'match') inMatch++;
    return {
      ...this.counters,
      connections: this.clients.size,
      sessions: this.sessions.size,
      rooms: this.rooms.size,
      roomsInMatch: inMatch,
    };
  }

  /** Exposed for tests. */
  getRoom(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  /** Exposed for tests: advance the simulation by one tick without waiting for the timer. */
  tickOnce(): void {
    this.tickAll();
  }

  /** Exposed for tests: run housekeeping with a chosen clock. */
  sweepNow(now: number): void {
    this.sweep(now);
  }

  startLoops(): void {
    if (this.sweepTimer) return;
    const stepMs = 1000 / this.cfg.tickRate;
    let last = performance.now();
    let acc = 0;
    const maxSteps = Math.max(5, this.cfg.timeScale * 2);
    if (!this.opts.manualTicks)
      this.tickTimer = setInterval(() => {
        const now = performance.now();
        acc += (now - last) * this.cfg.timeScale;
        last = now;
        let n = 0;
        while (acc >= stepMs && n < maxSteps) {
          this.tickAll();
          acc -= stepMs;
          n++;
        }
        if (n === maxSteps) acc = 0; // fell behind: drop the backlog instead of spiralling
      }, 5);
    this.sweepTimer = setInterval(() => this.sweep(Date.now()), 1000);
  }

  private tickAll(): void {
    const t0 = performance.now();
    for (const room of this.rooms.values()) {
      if (room.phase !== 'match') continue;
      try {
        room.tick();
      } catch (err) {
        // A bug in one room must not take the whole server down; log loudly and end that room's match.
        this.log.error('room tick failed', { room: room.code, err: String(err) });
        this.destroyRoom(room, 'internal', 'The match crashed unexpectedly and was closed.');
      }
    }
    const dt = performance.now() - t0;
    this.counters.ticks++;
    this.counters.tickMsTotal += dt;
    if (dt > this.counters.tickMsMax) this.counters.tickMsMax = dt;
  }

  // ------------------------------------------------------------ connections

  /** Per-IP connection cap; adapters call this before accepting the socket. */
  tryAcquireIp(ip: string): boolean {
    return this.connCounter.tryAcquire(ip);
  }

  /** Register an accepted connection (after tryAcquireIp succeeded). */
  connect(transport: Transport, ip: string): Client {
    const now = Date.now();
    const client: Client = {
      transport,
      ip,
      session: null,
      inputBucket: new TokenBucket(
        GAME_CONFIG.limits.inputsPerSecond / 2,
        GAME_CONFIG.limits.inputsPerSecond,
        now,
      ),
      msgBucket: new TokenBucket(12, 6, now),
      createBucket: new TokenBucket(4, 4 / 60, now),
      violations: 0,
      inputDrops: 0,
      badMessages: 0,
      lastRateErrorAt: 0,
    };
    this.clients.add(client);
    return client;
  }

  disconnect(client: Client): void {
    if (!this.clients.delete(client)) return;
    this.onClose(client);
  }

  private onClose(client: Client): void {
    this.connCounter.release(client.ip);
    const s = client.session;
    if (!s || s.client !== client) return; // replaced by a newer connection
    s.client = null;
    s.disconnectedAt = Date.now();
    this.removeFromQueue(s.id);
    const room = s.roomCode ? this.rooms.get(s.roomCode) : undefined;
    room?.setConnected(s.id, false);
  }

  // ------------------------------------------------------------ outbound

  private rawSend(client: Client, payload: string): void {
    if (!this.clients.has(client)) return;
    const t = client.transport;
    if (t.bufferedAmount() > MAX_BUFFERED_BYTES) {
      this.log.warn('dropping slow consumer');
      t.terminate();
      return;
    }
    try {
      t.send(payload);
    } catch {
      return; // socket closed between checks; its close event cleans up
    }
    this.counters.msgsOut++;
    this.counters.bytesOut += payload.length;
  }

  private send(client: Client, msg: ServerMessage): void {
    this.rawSend(client, JSON.stringify(msg));
  }

  private sendError(client: Client, code: ErrorCode, message: string): void {
    this.send(client, { t: 'error', code, message });
  }

  private sendToSession(sessionId: string, payload: ServerMessage | string): void {
    const c = this.sessions.get(sessionId)?.client;
    if (!c) return;
    this.rawSend(c, typeof payload === 'string' ? payload : JSON.stringify(payload));
  }

  private reply(client: Client, r: Result): void {
    if (!r.ok) this.sendError(client, r.code, r.message);
  }

  // ------------------------------------------------------------ inbound

  /** Feed one inbound frame. `text` is null for binary frames (always rejected). */
  receive(client: Client, text: string | null): void {
    this.counters.msgsIn++;
    const now = Date.now();
    if (text === null) {
      this.counters.rejected++;
      return this.badMessage(client, 'Binary messages are not supported.');
    }
    if (text.length > GAME_CONFIG.limits.maxMessageBytes) {
      this.counters.rejected++;
      return this.badMessage(client, 'Message too large.');
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      if (!client.msgBucket.take(now)) return this.rateLimited(client, now);
      this.counters.rejected++;
      return this.badMessage(client, 'Malformed message.');
    }

    // Rate limit by type *before* schema validation so floods are cheap to drop.
    const type = typeof json === 'object' && json !== null ? (json as { t?: unknown }).t : undefined;
    const cheap = type === 'input' || type === 'ping';
    const bucket = cheap ? client.inputBucket : client.msgBucket;
    if (!bucket.take(now)) {
      this.counters.rejected++;
      if (cheap) {
        client.inputDrops++;
        if (client.inputDrops > 600) client.transport.close(1008, 'rate limit');
        return; // silently drop excess inputs
      }
      return this.rateLimited(client, now);
    }

    // A hello from an incompatible client build gets a specific, actionable error instead of "invalid message".
    if (type === 'hello') {
      const v = (json as { v?: unknown }).v;
      if (typeof v === 'number' && Number.isInteger(v) && v !== PROTOCOL_VERSION) {
        this.counters.rejected++;
        return this.sendError(
          client,
          'bad_version',
          'This game version is out of date. Please reload the page.',
        );
      }
    }

    const parsed = ClientMessageSchema.safeParse(json);
    if (!parsed.success) {
      this.counters.rejected++;
      if (type === 'joinRoom') this.joinFailures.recordFailure(client.ip, now); // guessing garbage codes counts
      return this.badMessage(client, 'Invalid message.');
    }
    this.dispatch(client, parsed.data, now);
  }

  private rateLimited(client: Client, now: number): void {
    client.violations++;
    if (now - client.lastRateErrorAt > 1000) {
      client.lastRateErrorAt = now;
      this.sendError(client, 'rate_limited', 'You are sending messages too quickly.');
    }
    if (client.violations > 50) client.transport.close(1008, 'rate limit');
  }

  private badMessage(client: Client, message: string): void {
    client.badMessages++;
    this.sendError(client, 'bad_message', message);
    if (client.badMessages > 25) client.transport.close(1008, 'too many invalid messages');
  }

  private dispatch(client: Client, m: ClientMessage, now: number): void {
    if (m.t === 'hello') return this.onHello(client, m);
    if (m.t === 'ping') return this.send(client, { t: 'pong', ts: m.ts });
    const session = client.session;
    if (!session) return this.sendError(client, 'not_ready', 'Send "hello" first.');

    switch (m.t) {
      case 'createRoom':
        return this.onCreateRoom(client, session, m.settings, now, m.open === true);
      case 'joinRoom':
        return this.onJoinRoom(client, session, m.code, now);
      case 'leaveRoom':
        return this.onLeaveRoom(client, session);
      case 'quickMatch':
        return this.onQuickMatch(client, session);
      case 'cancelQuick':
        this.removeFromQueue(session.id);
        return this.send(client, { t: 'queue', status: 'cancelled', size: this.queue.length });
      default:
        break;
    }

    const room = session.roomCode ? this.rooms.get(session.roomCode) : undefined;
    if (!room) return this.sendError(client, 'not_in_room', 'You are not in a room.');

    switch (m.t) {
      case 'setTeam':
        return this.reply(client, room.setTeam(session.id, m.team));
      case 'setClass':
        return this.reply(client, room.setClass(session.id, m.cls));
      case 'setSettings':
        return this.reply(client, room.setSettings(session.id, m.settings));
      case 'startMatch':
      case 'rematch': {
        const r = room.start(session.id);
        if (r.ok && room.quick) this.drainQueueInto(room); // people already searching join this public match
        return this.reply(client, r);
      }
      case 'toLobby':
        return this.reply(client, room.toLobby(session.id));
      case 'addBot':
        return this.reply(client, room.addBot(session.id, m.team, m.difficulty));
      case 'removeBot':
        return this.reply(client, room.removeBot(session.id, m.id));
      case 'fillBots':
        return this.reply(client, room.fillBots(session.id, m.difficulty));
      case 'input':
        room.handleInput(session.id, m.seq, m);
        return;
      default:
        return;
    }
  }

  private onHello(client: Client, m: Extract<ClientMessage, { t: 'hello' }>): void {
    if (client.session) return this.sendError(client, 'bad_state', 'Already connected.');

    if (m.resume) {
      const existing = this.tokens.get(m.resume);
      if (existing) {
        const old = existing.client;
        existing.client = client;
        existing.disconnectedAt = null;
        client.session = existing;
        if (old && old !== client) {
          old.session = null;
          old.transport.close(4000, 'replaced by a new connection');
        }
        this.send(client, {
          t: 'welcome',
          v: PROTOCOL_VERSION,
          id: existing.id,
          token: existing.token,
          name: existing.name,
          resumed: true,
        });
        const room = existing.roomCode ? this.rooms.get(existing.roomCode) : undefined;
        if (room && room.players.has(existing.id)) {
          room.setConnected(existing.id, true);
          room.resync(existing.id);
        } else {
          existing.roomCode = null;
        }
        return;
      }
      // Unknown/expired token: fall through and create a fresh session (client learns via resumed:false).
    }

    const session: Session = {
      id: generatePlayerId(),
      token: generateToken(),
      name: m.name,
      client,
      roomCode: null,
      disconnectedAt: null,
    };
    this.sessions.set(session.id, session);
    this.tokens.set(session.token, session);
    client.session = session;
    this.send(client, {
      t: 'welcome',
      v: PROTOCOL_VERSION,
      id: session.id,
      token: session.token,
      name: session.name,
      resumed: false,
    });
  }

  // ------------------------------------------------------------ rooms

  private newRoom(host: Session, quick = false): Room {
    let code = generateRoomCode();
    while (this.rooms.has(code)) code = generateRoomCode();
    const room = new Room(
      code,
      host.id,
      host.name,
      {
        send: (id, payload) => this.sendToSession(id, payload),
        now: () => Date.now(),
        tickRate: this.cfg.tickRate,
        snapshotEvery: this.cfg.snapshotEvery,
      },
      quick,
    );
    this.rooms.set(code, room);
    host.roomCode = code;
    return room;
  }

  private onCreateRoom(
    client: Client,
    s: Session,
    settings: { durationSec?: number } | undefined,
    now: number,
    open = false,
  ): void {
    if (s.roomCode) return this.sendError(client, 'already_in_room', 'Leave your current room first.');
    if (this.rooms.size >= this.cfg.maxRooms)
      return this.sendError(client, 'server_busy', 'The server is full. Try again shortly.');
    if (!client.createBucket.take(now))
      return this.sendError(client, 'rate_limited', 'You are creating rooms too quickly.');
    this.removeFromQueue(s.id);
    const room = this.newRoom(s, open);
    if (settings) room.setSettings(s.id, settings);
    room.broadcastRoom();
    this.log.info('room created', { room: room.code, rooms: this.rooms.size });
  }

  private onJoinRoom(client: Client, s: Session, code: string, now: number): void {
    if (s.roomCode) return this.sendError(client, 'already_in_room', 'Leave your current room first.');
    if (this.joinFailures.isBlocked(client.ip, now)) {
      return this.sendError(client, 'rate_limited', 'Too many failed attempts. Please wait a minute.');
    }
    const room = this.rooms.get(code);
    if (!room) {
      this.joinFailures.recordFailure(client.ip, now);
      return this.sendError(
        client,
        'room_not_found',
        'No room with that code. Check the code and try again.',
      );
    }
    this.removeFromQueue(s.id);
    const r = room.addPlayer(s.id, s.name);
    if (!r.ok) return this.sendError(client, r.code, r.message);
    s.roomCode = code;
    // addPlayer broadcast the room to everyone already connected *including* the joiner (connected=true).
  }

  private onLeaveRoom(client: Client, s: Session): void {
    this.leaveRoom(s);
    this.send(client, { t: 'left' });
  }

  private leaveRoom(s: Session): void {
    this.removeFromQueue(s.id);
    const room = s.roomCode ? this.rooms.get(s.roomCode) : undefined;
    s.roomCode = null;
    if (!room) return;
    room.removePlayer(s.id);
    if (room.humanCount() === 0) this.rooms.delete(room.code);
  }

  private destroyRoom(room: Room, code: ErrorCode, message: string): void {
    for (const p of [...room.players.values()]) {
      const s = this.sessions.get(p.id);
      if (!s) continue;
      s.roomCode = null;
      const c = s.client;
      if (c) {
        this.sendError(c, code, message);
        this.send(c, { t: 'left' });
      }
    }
    this.rooms.delete(room.code);
  }

  // ------------------------------------------------------------ quick match

  /** A public match that is running and has a seat (a free one, or a bot to replace), fullest first. */
  private findDropInRoom(): Room | undefined {
    return [...this.rooms.values()]
      .filter((r) => r.quick && r.acceptsDropIn())
      .sort((a, b) => b.humanCount() - a.humanCount())[0];
  }

  private drainQueueInto(room: Room): void {
    for (const id of [...this.queue]) {
      const s = this.sessions.get(id);
      if (!s?.client || s.roomCode || !room.acceptsDropIn()) continue;
      if (room.addPlayer(s.id, s.name).ok) {
        s.roomCode = room.code;
        this.removeFromQueue(s.id);
      }
    }
  }

  private onQuickMatch(client: Client, s: Session): void {
    if (s.roomCode) return this.sendError(client, 'already_in_room', 'Leave your current room first.');
    // Prefer dropping into a public match already in progress: no waiting, and a human replaces a bot.
    const running = this.findDropInRoom();
    if (running && running.addPlayer(s.id, s.name).ok) {
      this.removeFromQueue(s.id);
      s.roomCode = running.code;
      return;
    }
    if (!this.queue.includes(s.id)) this.queue.push(s.id);
    this.notifyQueue();
    if (this.queue.length >= 4) this.formQuickMatch();
    else if (this.queue.length >= 2 && !this.quickTimer) {
      this.quickTimer = setTimeout(() => this.formQuickMatch(), this.cfg.quickMatchWaitMs);
    }
  }

  private removeFromQueue(id: string): void {
    const before = this.queue.length;
    this.queue = this.queue.filter((q) => q !== id);
    if (this.queue.length !== before) this.notifyQueue();
    if (this.queue.length < 2 && this.quickTimer) {
      clearTimeout(this.quickTimer);
      this.quickTimer = null;
    }
  }

  private notifyQueue(): void {
    for (const id of this.queue)
      this.sendToSession(id, { t: 'queue', status: 'queued', size: this.queue.length });
  }

  private formQuickMatch(): void {
    if (this.quickTimer) {
      clearTimeout(this.quickTimer);
      this.quickTimer = null;
    }
    // Only connected players can be matched.
    this.queue = this.queue.filter((id) => this.sessions.get(id)?.client);
    const n = this.queue.length >= 4 ? 4 : this.queue.length >= 2 ? 2 : 0;
    if (n === 0 || this.rooms.size >= this.cfg.maxRooms) return;
    const picked = this.queue.splice(0, n);
    const sessions = picked.map((id) => this.sessions.get(id)).filter((x): x is Session => !!x);
    const host = sessions[0];
    if (!host || sessions.length < 2) return;
    const room = this.newRoom(host, true);
    sessions.slice(1).forEach((s, i) => {
      const team: TeamId = i % 2 === 0 ? 2 : 1;
      room.addPlayer(s.id, s.name, team);
      s.roomCode = room.code;
    });
    this.log.info('quick match formed', { room: room.code, players: sessions.length });
    room.begin();
    this.notifyQueue();
    if (this.queue.length >= 2)
      this.quickTimer = setTimeout(() => this.formQuickMatch(), this.cfg.quickMatchWaitMs);
  }

  // ------------------------------------------------------------ housekeeping

  private sweep(now: number): void {
    // Sessions that stayed disconnected past their grace period are removed (and leave their room).
    for (const s of [...this.sessions.values()]) {
      if (s.disconnectedAt === null) continue;
      const room = s.roomCode ? this.rooms.get(s.roomCode) : undefined;
      const grace = room && room.phase !== 'lobby' ? this.cfg.reconnectGraceMs : this.cfg.lobbyGraceMs;
      if (now - s.disconnectedAt >= grace) {
        this.leaveRoom(s);
        this.sessions.delete(s.id);
        this.tokens.delete(s.token);
        this.log.debug('session expired', { sessions: this.sessions.size });
      }
    }
    // Empty or idle rooms are removed so abandoned rooms never run forever.
    for (const room of [...this.rooms.values()]) {
      if (room.humanCount() === 0) this.rooms.delete(room.code);
      else if (room.isExpired(now, this.cfg.roomIdleExpiryMs, this.cfg.resultsIdleExpiryMs)) {
        this.log.info('room expired', { room: room.code });
        this.destroyRoom(room, 'room_expired', 'This room expired because of inactivity.');
      }
    }
    this.joinFailures.sweep(now);
  }
}
