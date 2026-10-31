import { PROTOCOL_VERSION, isServerMessage, type ClientMessage, type ServerMessage } from '@tankclash/shared';
import { wsUrl } from '../env';

export type ConnState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'lost';

const TOKEN_KEY = 'tankclash.session';

function readToken(): string | undefined {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}
function writeToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* sessionStorage blocked: reconnect-resume simply won't survive a page reload */
  }
}

/** Backoff schedule for reconnect attempts (ms). Jitter is added so a server restart doesn't get a thundering herd. */
export function backoffMs(attempt: number): number {
  const base = Math.min(8000, 500 * 2 ** Math.min(attempt, 5));
  return base + Math.random() * 300;
}

export interface ConnectionEvents {
  onState(state: ConnState, attempt: number): void;
  onMessage(msg: ServerMessage): void;
  /** Fired once a hello has been answered; `resumed` says whether the server kept our old seat. */
  onWelcome(msg: Extract<ServerMessage, { t: 'welcome' }>): void;
}

/**
 * Thin WebSocket wrapper: hello/resume handshake, automatic reconnect with backoff, RTT measurement.
 * It never invents state: everything the UI shows comes from server messages.
 */
export class Connection {
  state: ConnState = 'idle';
  rttMs = 0;
  private ws: WebSocket | null = null;
  private attempt = 0;
  private retryTimer: number | undefined;
  private pingTimer: number | undefined;
  private wanted = false;
  private name = 'Player';
  // ~90 s of retries: enough for a sleeping free-tier server to cold-start.
  private maxAttempts = 14;

  constructor(private readonly ev: ConnectionEvents) {}

  get isOpen(): boolean {
    return this.state === 'open' && this.ws?.readyState === WebSocket.OPEN;
  }

  connect(name: string): void {
    this.name = name;
    this.wanted = true;
    this.attempt = 0;
    this.open();
  }

  /** User pressed "Retry" on the connection-lost screen. */
  retryNow(): void {
    if (!this.wanted) return;
    window.clearTimeout(this.retryTimer);
    this.attempt = 0;
    this.open();
  }

  close(forgetSession = true): void {
    this.wanted = false;
    window.clearTimeout(this.retryTimer);
    window.clearInterval(this.pingTimer);
    if (forgetSession) writeToken(null);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      ws.onerror = null;
      try {
        ws.close(1000);
      } catch {
        /* already closed */
      }
    }
    this.setState('idle');
  }

  send(msg: ClientMessage): boolean {
    if (!this.isOpen || !this.ws) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private setState(s: ConnState): void {
    this.state = s;
    this.ev.onState(s, this.attempt);
  }

  private open(): void {
    window.clearTimeout(this.retryTimer);
    const first = this.attempt === 0 && this.state !== 'reconnecting' && this.state !== 'lost';
    this.setState(first ? 'connecting' : 'reconnecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl());
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      const hello: ClientMessage = { t: 'hello', v: PROTOCOL_VERSION, name: this.name };
      const resume = readToken();
      if (resume) hello.resume = resume;
      ws.send(JSON.stringify(hello));
    };
    ws.onmessage = (e: MessageEvent) => {
      if (typeof e.data !== 'string') return;
      let msg: unknown;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return; // ignore garbage; never crash the UI on a bad frame
      }
      if (!isServerMessage(msg)) return;
      if (msg.t === 'welcome') {
        writeToken(msg.token);
        this.attempt = 0;
        this.setState('open');
        this.startPing();
        this.ev.onWelcome(msg);
        return;
      }
      if (msg.t === 'pong') {
        this.rttMs = Math.max(0, Math.round(performance.now() - msg.ts));
        return;
      }
      if (msg.t === 'error' && msg.code === 'session_expired') writeToken(null);
      this.ev.onMessage(msg);
    };
    ws.onclose = (e: CloseEvent) => {
      window.clearInterval(this.pingTimer);
      if (this.ws === ws) this.ws = null;
      if (!this.wanted) return;
      // 1008 = policy violation (origin rejected / abusive client): retrying would just repeat the failure.
      if (e.code === 1008) {
        this.attempt = this.maxAttempts;
      }
      this.scheduleRetry();
    };
    ws.onerror = () => {
      /* onclose follows; handled there */
    };
  }

  private scheduleRetry(): void {
    if (!this.wanted) return;
    if (this.attempt >= this.maxAttempts) {
      this.setState('lost');
      return;
    }
    this.setState('reconnecting');
    const delay = backoffMs(this.attempt++);
    this.retryTimer = window.setTimeout(() => this.open(), delay);
  }

  private startPing(): void {
    window.clearInterval(this.pingTimer);
    this.pingTimer = window.setInterval(() => {
      this.send({ t: 'ping', ts: performance.now() });
    }, 3000);
  }
}
