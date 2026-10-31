import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, type ClientMessage, type RoomInfo } from '@tankclash/shared';
import { loadConfig, type ServerConfig } from '../src/config';
import { GameServer } from '../src/game-server';

export interface TestServer {
  server: GameServer;
  port: number;
  cfg: ServerConfig;
  stop(): Promise<void>;
}

export async function startTestServer(
  env: Record<string, string> = {},
  opts: { manualTicks?: boolean } = { manualTicks: true },
): Promise<TestServer> {
  const cfg = loadConfig({ PORT: '0', HOST: '127.0.0.1', LOG_LEVEL: 'silent', ...env } as NodeJS.ProcessEnv);
  const server = new GameServer(cfg, undefined, opts);
  const port = await server.start();
  return { server, port, cfg, stop: () => server.stop() };
}

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Thin WebSocket client that records every server message and lets tests wait for sequences. */
export class TestClient {
  readonly messages: Any[] = [];
  private cursor = 0;
  private waiters: (() => void)[] = [];
  closed: { code: number; reason: string } | null = null;
  id = '';
  token = '';
  private pingSeq = 1;

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      this.messages.push(JSON.parse(data.toString()));
      for (const w of this.waiters.splice(0)) w();
    });
    ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      for (const w of this.waiters.splice(0)) w();
    });
  }

  static connect(port: number, origin?: string): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, origin ? { origin } : {});
      const c = new TestClient(ws);
      ws.once('open', () => resolve(c));
      ws.once('error', reject);
      ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
  }

  /** Connect and complete the hello handshake. */
  static async join(port: number, name: string, resume?: string): Promise<TestClient> {
    const c = await TestClient.connect(port);
    await c.hello(name, resume);
    return c;
  }

  async hello(name: string, resume?: string): Promise<Any> {
    this.send({ t: 'hello', v: PROTOCOL_VERSION, name, ...(resume ? { resume } : {}) });
    const w = await this.next('welcome');
    this.id = w.id;
    this.token = w.token;
    return w;
  }

  send(msg: ClientMessage | unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  sendRaw(data: string | Buffer): void {
    this.ws.send(data);
  }

  /** Wait for the next message (after the cursor) matching a type or predicate; advances the cursor. */
  async next(match: string | ((m: Any) => boolean), timeoutMs = 4000, consume = true): Promise<Any> {
    const test = typeof match === 'string' ? (m: Any) => m.t === match : match;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (let i = this.cursor; i < this.messages.length; i++) {
        if (test(this.messages[i] as Any)) {
          if (consume) this.cursor = i + 1;
          return this.messages[i] as Any;
        }
      }
      if (this.closed) throw new Error(`socket closed (${this.closed.code}) while waiting`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `timeout waiting for message; got: ${
            this.messages
              .slice(this.cursor)
              .map((m) => m.t)
              .join(',') || '(none)'
          }`,
        );
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  /** Round-trip barrier: once the pong arrives, every earlier server message has been received. */
  async sync(): Promise<void> {
    const ts = this.pingSeq++;
    this.send({ t: 'ping', ts });
    // Peek without consuming, so earlier unread messages stay available to `next()`.
    await this.next((m) => m.t === 'pong' && m.ts === ts, 4000, false);
  }

  skip(): void {
    this.cursor = this.messages.length;
  }

  /** All messages of a type received so far (ignores the cursor). */
  all(type: string): Any[] {
    return this.messages.filter((m) => m.t === type);
  }

  last(type: string): Any | undefined {
    return this.all(type).at(-1);
  }

  lastRoom(): RoomInfo | undefined {
    return this.last('room')?.room as RoomInfo | undefined;
  }

  /** Last snapshot received. */
  snap(): Any | undefined {
    return this.last('snap')?.s;
  }

  events(type?: string): Any[] {
    return this.all('snap')
      .flatMap((m) => m.ev as Any[])
      .filter((e) => !type || e.e === type);
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}

/** Advance the server's simulation by n ticks, then wait until every client has received the results. */
export async function advance(ts: TestServer, n: number, clients: TestClient[]): Promise<void> {
  // Barrier first: make sure everything the clients just sent has been processed before ticking.
  await Promise.all(clients.map((c) => c.sync()));
  for (let i = 0; i < n; i++) ts.server.tickOnce();
  await Promise.all(clients.map((c) => c.sync()));
}

/** Create a room with host + guests, balanced across teams (host=1, first guest=2, ...). */
export async function createRoom(
  ts: TestServer,
  names: string[],
): Promise<{ code: string; clients: TestClient[] }> {
  const clients: TestClient[] = [];
  for (const n of names) clients.push(await TestClient.join(ts.port, n));
  const host = clients[0] as TestClient;
  host.send({ t: 'createRoom' });
  const room = (await host.next('room')).room as RoomInfo;
  for (const c of clients.slice(1)) {
    c.send({ t: 'joinRoom', code: room.code });
    await c.next('room');
  }
  await Promise.all(clients.map((c) => c.sync()));
  return { code: room.code, clients };
}

/** Start the match from the host and run the countdown so the sim is in the `playing` phase. */
export async function startMatch(ts: TestServer, clients: TestClient[]): Promise<void> {
  const host = clients[0] as TestClient;
  host.send({ t: 'startMatch' });
  await Promise.all(clients.map((c) => c.next('matchStart')));
  await advance(ts, 100, clients); // countdown = 3s = 90 ticks
}
