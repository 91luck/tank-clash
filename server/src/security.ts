import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '@tankclash/shared';

/** Classic token bucket. `refillPerSec` tokens are added continuously up to `capacity`. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    now: number,
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  take(now: number, cost = 1): boolean {
    const elapsed = Math.max(0, now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }
}

/**
 * Sliding-window counter of failures per key (e.g. failed room-code guesses per IP).
 * After `maxFailures` inside `windowMs` the key is blocked until the window clears.
 */
export class FailureLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly maxFailures: number,
    private readonly windowMs: number,
  ) {}

  isBlocked(key: string, now: number): boolean {
    const list = this.prune(key, now);
    return list.length >= this.maxFailures;
  }

  recordFailure(key: string, now: number): void {
    const list = this.prune(key, now);
    list.push(now);
    this.hits.set(key, list);
  }

  private prune(key: string, now: number): number[] {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length === 0) this.hits.delete(key);
    else this.hits.set(key, list);
    return list;
  }

  /** Drop stale keys (call occasionally). */
  sweep(now: number): void {
    for (const key of [...this.hits.keys()]) this.prune(key, now);
  }
}

/** Counts concurrent connections per IP. */
export class ConnectionCounter {
  private readonly counts = new Map<string, number>();

  constructor(private readonly max: number) {}

  tryAcquire(ip: string): boolean {
    const n = this.counts.get(ip) ?? 0;
    if (n >= this.max) return false;
    this.counts.set(ip, n + 1);
    return true;
  }

  release(ip: string): void {
    const n = (this.counts.get(ip) ?? 1) - 1;
    if (n <= 0) this.counts.delete(ip);
    else this.counts.set(ip, n);
  }
}

// ---------------------------------------------------------------- randomness
// Web Crypto (globalThis.crypto) exists in Node 20+ and in Cloudflare Workers, so the same code runs on both.

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

/** Unbiased random integer in [0, max) using rejection sampling. */
export function secureRandomInt(max: number): number {
  if (!Number.isInteger(max) || max <= 0 || max > 2 ** 32) throw new RangeError('max out of range');
  const limit = Math.floor(2 ** 32 / max) * max;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    const v = buf[0] as number;
    if (v < limit) return v % max;
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Cryptographically random, unpredictable room code. */
export function generateRoomCode(): string {
  let out = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++)
    out += ROOM_CODE_ALPHABET[secureRandomInt(ROOM_CODE_ALPHABET.length)];
  return out;
}

/** 192-bit session token (base64url, 32 chars). Never logged, never placed in URLs. */
export function generateToken(): string {
  return toBase64Url(randomBytes(24));
}

export function generatePlayerId(): string {
  return [...randomBytes(6)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
