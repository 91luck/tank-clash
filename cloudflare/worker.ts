/**
 * Cloudflare Workers adapter.
 *
 * - Static client files are served by Workers Static Assets (free, not counted as Worker requests).
 * - `/ws` and `/health` go to ONE Durable Object ("global") that runs the exact same GameCore as the Node server,
 *   so every player shares one lobby/matchmaking space, and rooms tick in a single place.
 *
 * Deploy: `npm run deploy:cloudflare` (see docs/DEPLOYMENT.md).
 */
import { DurableObject } from 'cloudflare:workers';
import { GAME_CONFIG } from '@tankclash/shared';
import { isOriginAllowed, loadConfig, type ServerConfig } from '../server/src/config';
import { GameCore, type Client } from '../server/src/core';
import { createLogger } from '../server/src/logger';

interface Env {
  GAME: DurableObjectNamespace<TankClashServer>;
  ASSETS: Fetcher;
  NODE_ENV?: string;
  ALLOWED_ORIGINS?: string;
  LOG_LEVEL?: string;
  MAX_CONNECTIONS_PER_IP?: string;
  MAX_ROOMS?: string;
  QUICK_MATCH_WAIT_MS?: string;
  /** Local testing only (`wrangler dev --var NODE_ENV:development --var TIME_SCALE:4`); refused in production. */
  TIME_SCALE?: string;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

/** Close codes Workers accept for server-initiated closes; fall back to 1000 if the runtime refuses one. */
function safeClose(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason.slice(0, 120));
  } catch {
    try {
      ws.close(1000, 'closing');
    } catch {
      /* already closed */
    }
  }
}

export class TankClashServer extends DurableObject<Env> {
  private readonly cfg: ServerConfig;
  private readonly core: GameCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.cfg = loadConfig({
      NODE_ENV: env.NODE_ENV ?? 'production',
      ALLOWED_ORIGINS: env.ALLOWED_ORIGINS,
      LOG_LEVEL: env.LOG_LEVEL ?? 'info',
      MAX_CONNECTIONS_PER_IP: env.MAX_CONNECTIONS_PER_IP,
      MAX_ROOMS: env.MAX_ROOMS,
      QUICK_MATCH_WAIT_MS: env.QUICK_MATCH_WAIT_MS,
      TIME_SCALE: env.TIME_SCALE,
    });
    this.core = new GameCore(this.cfg, createLogger(this.cfg.logLevel));
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json(this.core.health());
    if (url.pathname !== '/ws') return new Response('Not found', { status: 404 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
      return new Response('Expected a WebSocket upgrade', { status: 426 });

    if (!isOriginAllowed(this.cfg, request.headers.get('Origin') ?? undefined, url.host)) {
      this.core.noteRejected();
      return new Response('Forbidden origin', { status: 403 });
    }
    // On Cloudflare this header is set by the edge and cannot be spoofed by the client.
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    if (!this.core.tryAcquireIp(ip)) {
      this.core.noteRejected();
      return new Response('Too many connections', { status: 429 });
    }

    const pair = new WebSocketPair();
    const [browserSide, serverSide] = Object.values(pair) as [WebSocket, WebSocket];
    // Standard (non-hibernating) accept: the game keeps rooms in memory and ticks 30x/s while anyone is connected.
    serverSide.accept();
    this.core.startLoops();

    let client: Client | null = null;
    const done = (): void => {
      if (client) this.core.disconnect(client);
      client = null;
    };
    client = this.core.connect(
      {
        send: (text) => serverSide.send(text),
        close: (code, reason) => safeClose(serverSide, code, reason),
        bufferedAmount: () => 0, // not exposed by Workers; the edge buffers for us
        terminate: () => {
          safeClose(serverSide, 1011, 'terminated');
          done();
        },
      },
      ip,
    );
    serverSide.addEventListener('message', (ev: MessageEvent) => {
      if (!client) return;
      const data: unknown = ev.data;
      if (typeof data === 'string') {
        this.core.receive(
          client,
          data.length > GAME_CONFIG.limits.maxMessageBytes * 4 ? data.slice(0, 4096) : data,
        );
      } else {
        this.core.receive(client, null);
      }
    });
    serverSide.addEventListener('close', done);
    serverSide.addEventListener('error', done);
    return new Response(null, { status: 101, webSocket: browserSide });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/ws' || pathname === '/health') {
      return env.GAME.get(env.GAME.idFromName('global')).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
