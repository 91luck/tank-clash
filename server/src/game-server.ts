import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { GAME_CONFIG } from '@tankclash/shared';
import { isOriginAllowed, type ServerConfig } from './config';
import { GameCore, type Client, type ServerStats } from './core';
import { createLogger, type Logger } from './logger';
import type { Room } from './room';
import { serveStatic } from './static';

export type { ServerStats } from './core';

/**
 * Node.js adapter: HTTP (health + optional static client) and WebSocket transport around GameCore.
 * Used for Render, Railway, Docker, VPS and local development.
 */
export class GameServer {
  readonly http: Server;
  readonly core: GameCore;
  private readonly wss: WebSocketServer;
  private readonly log: Logger;
  private readonly alive = new WeakMap<WebSocket, boolean>();
  private readonly sockets = new Set<WebSocket>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly cfg: ServerConfig,
    log?: Logger,
    opts: { manualTicks?: boolean } = {},
  ) {
    this.log = log ?? createLogger(cfg.logLevel);
    this.core = new GameCore(cfg, this.log, opts);
    this.http = createServer((req, res) => this.onHttp(req, res));
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: GAME_CONFIG.limits.maxMessageBytes,
      perMessageDeflate: false,
    });
    this.http.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.cfg.port, this.cfg.host, () => {
        this.http.off('error', reject);
        this.core.startLoops();
        this.heartbeatTimer = setInterval(() => this.heartbeat(), 15_000);
        const addr = this.http.address();
        const port = typeof addr === 'object' && addr ? addr.port : this.cfg.port;
        this.log.info('server listening', {
          port,
          tickRate: this.cfg.tickRate,
          production: this.cfg.production,
          origins: this.cfg.allowedOrigins.length ? this.cfg.allowedOrigins : 'same-origin only',
        });
        resolve(port);
      });
    });
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.core.stop();
    this.wss.close();
    await new Promise<void>((resolve) => {
      this.http.close(() => resolve());
      this.http.closeAllConnections();
    });
  }

  // Test hooks (delegate to the core).
  stats(): ServerStats {
    return this.core.stats();
  }
  getRoom(code: string): Room | undefined {
    return this.core.getRoom(code);
  }
  tickOnce(): void {
    this.core.tickOnce();
  }
  sweepNow(now: number): void {
    this.core.sweepNow(now);
  }

  private heartbeat(): void {
    for (const ws of this.sockets) {
      if (!this.alive.get(ws)) {
        ws.terminate();
        continue;
      }
      this.alive.set(ws, false);
      ws.ping();
    }
  }

  // ------------------------------------------------------------ HTTP

  private onHttp(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/health') {
      const origin = req.headers.origin;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      };
      if (origin && isOriginAllowed(this.cfg, origin, req.headers.host))
        headers['Access-Control-Allow-Origin'] = origin;
      res.writeHead(200, headers);
      res.end(JSON.stringify(this.core.health()));
      return;
    }
    if (this.cfg.clientDir && serveStatic(this.cfg.clientDir, req, res)) return;
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }

  private clientIp(req: IncomingMessage): string {
    if (this.cfg.trustProxy) {
      const xff = req.headers['x-forwarded-for'];
      const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = (req.url ?? '').split('?')[0];
    const reject = (status: string): void => {
      this.core.noteRejected();
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (path !== '/ws') return reject('404 Not Found');
    if (!isOriginAllowed(this.cfg, req.headers.origin, req.headers.host)) {
      this.log.warn('rejected websocket origin', { origin: req.headers.origin ?? null });
      return reject('403 Forbidden');
    }
    const ip = this.clientIp(req);
    if (!this.core.tryAcquireIp(ip)) return reject('429 Too Many Requests');
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, ip));
  }

  private onConnection(ws: WebSocket, ip: string): void {
    this.sockets.add(ws);
    this.alive.set(ws, true);
    const client: Client = this.core.connect(
      {
        send: (text) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(text);
        },
        close: (code, reason) => ws.close(code, reason),
        bufferedAmount: () => ws.bufferedAmount,
        terminate: () => ws.terminate(),
      },
      ip,
    );
    ws.on('pong', () => this.alive.set(ws, true));
    ws.on('message', (data, isBinary) => this.core.receive(client, isBinary ? null : data.toString()));
    ws.on('close', () => {
      this.sockets.delete(ws);
      this.core.disconnect(client);
    });
    ws.on('error', (err) => this.log.debug('socket error', { err: String(err) }));
  }
}
