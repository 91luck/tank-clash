import { GAME_CONFIG } from '@tankclash/shared';

export interface ServerConfig {
  port: number;
  host: string;
  production: boolean;
  /** Allowed WebSocket `Origin` values. `*` is only permitted outside production. */
  allowedOrigins: string[];
  tickRate: number;
  snapshotEvery: number;
  /** Serve the built client (client/dist) from this server – optional single-host deployment. */
  clientDir: string | null;
  trustProxy: boolean;
  quickMatchWaitMs: number;
  reconnectGraceMs: number;
  lobbyGraceMs: number;
  roomIdleExpiryMs: number;
  resultsIdleExpiryMs: number;
  maxConnectionsPerIp: number;
  maxRooms: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  /** TEST ONLY: run the simulation faster than real time. Rejected in production. */
  timeScale: number;
}

export class ConfigError extends Error {}

function int(
  env: Record<string, string | undefined>,
  key: string,
  def: number,
  min: number,
  max: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${key} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return n;
}

/** Reads and validates configuration. Throws ConfigError with a human-readable message. */
export function loadConfig(
  env: Record<string, string | undefined> = (
    globalThis as { process?: { env: Record<string, string | undefined> } }
  ).process?.env ?? {},
): ServerConfig {
  const production = env.NODE_ENV === 'production';
  const origins = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, '')) // tolerate a pasted trailing slash
    .filter(Boolean);

  if (production && origins.includes('*')) {
    throw new ConfigError('ALLOWED_ORIGINS must not contain "*" in production.');
  }
  for (const o of origins) {
    if (o !== '*' && !/^https?:\/\/[^/\s]+$/.test(o)) {
      throw new ConfigError(
        `ALLOWED_ORIGINS entry "${o}" must look like https://host[:port] (no path, no trailing slash).`,
      );
    }
  }

  const level = (env.LOG_LEVEL ?? 'info') as ServerConfig['logLevel'];
  if (!['debug', 'info', 'warn', 'error', 'silent'].includes(level)) {
    throw new ConfigError(`LOG_LEVEL must be one of debug|info|warn|error|silent (got "${level}")`);
  }

  const timeScale = int(env, 'TIME_SCALE', 1, 1, 50);
  if (production && timeScale !== 1) throw new ConfigError('TIME_SCALE must not be set in production.');

  const l = GAME_CONFIG.limits;
  const explicitOrigins = [...new Set([...origins, ...platformOrigins(env)])];
  return {
    port: int(env, 'PORT', 8080, 0, 65535),
    host: env.HOST ?? '0.0.0.0',
    production,
    // Production default: same-origin only (plus the URL the hosting platform tells us about), which is
    // secure and needs zero configuration for single-host deployments. Development default: allow any origin.
    allowedOrigins: production || origins.length > 0 ? explicitOrigins : ['*'],
    tickRate: int(env, 'TICK_RATE', GAME_CONFIG.tickRate, 10, 60),
    snapshotEvery: int(env, 'SNAPSHOT_EVERY', GAME_CONFIG.snapshotEvery, 1, 6),
    clientDir: env.CLIENT_DIR && env.CLIENT_DIR !== '' ? env.CLIENT_DIR : null,
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    quickMatchWaitMs: int(env, 'QUICK_MATCH_WAIT_MS', 4000, 0, 60_000),
    reconnectGraceMs: int(env, 'RECONNECT_GRACE_MS', l.reconnectGraceSec * 1000, 0, 600_000),
    lobbyGraceMs: int(env, 'LOBBY_GRACE_MS', l.lobbyGraceSec * 1000, 0, 600_000),
    roomIdleExpiryMs: int(env, 'ROOM_IDLE_EXPIRY_MS', l.roomIdleExpirySec * 1000, 1000, 86_400_000),
    resultsIdleExpiryMs: int(env, 'RESULTS_IDLE_EXPIRY_MS', l.resultsIdleExpirySec * 1000, 1000, 86_400_000),
    maxConnectionsPerIp: int(env, 'MAX_CONNECTIONS_PER_IP', l.maxConnectionsPerIp, 1, 1000),
    maxRooms: int(env, 'MAX_ROOMS', l.maxRooms, 1, 10_000),
    logLevel: level,
    timeScale,
  };
}

/**
 * Public URLs that hosting platforms inject automatically, so one-click deploys need no ALLOWED_ORIGINS.
 * Only used to *add* allowed origins; never to widen to "*".
 */
export function platformOrigins(env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  const add = (v: string | undefined, prefix = ''): void => {
    if (!v) return;
    const url = (prefix + v).replace(/\/+$/, '');
    if (/^https:\/\/[^/\s]+$/.test(url)) out.push(url);
  };
  add(env.RENDER_EXTERNAL_URL); // Render: https://<name>.onrender.com
  add(env.RAILWAY_PUBLIC_DOMAIN, 'https://'); // Railway: <name>.up.railway.app
  add(env.KOYEB_PUBLIC_DOMAIN, 'https://'); // Koyeb: <name>.koyeb.app
  add(env.SPACE_HOST, 'https://'); // Hugging Face Spaces
  if (env.FLY_APP_NAME) add(`https://${env.FLY_APP_NAME}.fly.dev`);
  return out;
}

/**
 * WebSocket origin check (protects against cross-site WebSocket hijacking).
 * Allowed: explicit ALLOWED_ORIGINS / platform URLs, or the page's own origin (Origin host == request Host),
 * which is always safe because another site cannot send our Host with its own Origin from a browser.
 */
export function isOriginAllowed(cfg: ServerConfig, origin: string | undefined, host?: string): boolean {
  if (cfg.allowedOrigins.includes('*')) return true;
  // Non-browser clients (tests, curl) send no Origin; they are only accepted outside production.
  if (!origin) return !cfg.production;
  if (cfg.allowedOrigins.includes(origin)) return true;
  if (!host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}
