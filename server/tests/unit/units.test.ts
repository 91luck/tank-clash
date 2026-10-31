import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, afterAll } from 'vitest';
import { ROOM_CODE_REGEX, type ServerMessage } from '@tankclash/shared';
import { Room } from '../../src/room';
import {
  ConnectionCounter,
  FailureLimiter,
  TokenBucket,
  generatePlayerId,
  generateRoomCode,
  generateToken,
} from '../../src/security';
import { serveStatic } from '../../src/static';

describe('TokenBucket', () => {
  it('allows a burst, then refills over time', () => {
    const b = new TokenBucket(3, 1, 0);
    expect([b.take(0), b.take(0), b.take(0), b.take(0)]).toEqual([true, true, true, false]);
    expect(b.take(500)).toBe(false);
    expect(b.take(1000)).toBe(true);
  });
  it('never exceeds capacity', () => {
    const b = new TokenBucket(2, 100, 0);
    expect([b.take(10_000), b.take(10_000), b.take(10_000)]).toEqual([true, true, false]);
  });
});

describe('FailureLimiter', () => {
  it('blocks after N failures in the window and recovers after it', () => {
    const l = new FailureLimiter(3, 1000);
    for (let i = 0; i < 3; i++) l.recordFailure('ip', i);
    expect(l.isBlocked('ip', 10)).toBe(true);
    expect(l.isBlocked('other', 10)).toBe(false);
    expect(l.isBlocked('ip', 2000)).toBe(false);
  });
});

describe('ConnectionCounter', () => {
  it('caps concurrent connections per key', () => {
    const c = new ConnectionCounter(2);
    expect([c.tryAcquire('a'), c.tryAcquire('a'), c.tryAcquire('a')]).toEqual([true, true, false]);
    c.release('a');
    expect(c.tryAcquire('a')).toBe(true);
  });
});

describe('generators', () => {
  it('create valid, unique, unpredictable values', () => {
    const codes = new Set(Array.from({ length: 500 }, generateRoomCode));
    expect(codes.size).toBeGreaterThan(495);
    for (const c of codes) expect(c).toMatch(ROOM_CODE_REGEX);
    expect(generateToken()).toHaveLength(32);
    expect(generateToken()).not.toBe(generateToken());
    expect(generatePlayerId()).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('Room housekeeping', () => {
  const mk = (now: () => number) => {
    const sent: { id: string; msg: ServerMessage | string }[] = [];
    const room = new Room('ABCDEF', 'h', 'Host', {
      send: (id, msg) => sent.push({ id, msg }),
      now,
      tickRate: 30,
      snapshotEvery: 2,
    });
    return { room, sent };
  };

  it('expires idle lobbies and results screens, never running matches', () => {
    let t = 0;
    const { room } = mk(() => t);
    expect(room.isExpired(100, 1000, 500)).toBe(false);
    expect(room.isExpired(1001, 1000, 500)).toBe(true);
    room.addPlayer('g', 'Guest');
    room.setClass('g', 'heavy');
    room.setTeam('g', 2);
    t = 50;
    room.start('h');
    expect(room.phase).toBe('match');
    expect(room.isExpired(10_000_000, 1000, 500)).toBe(false);
  });

  it('activity refreshes the expiry timer', () => {
    let t = 0;
    const { room } = mk(() => t);
    t = 900;
    room.setClass('h', 'scout');
    expect(room.isExpired(1500, 1000, 500)).toBe(false);
    expect(room.isExpired(1901, 1000, 500)).toBe(true);
  });

  it('transfers host when the host leaves and reports empty rooms', () => {
    const { room } = mk(() => 0);
    room.addPlayer('g', 'Guest');
    room.removePlayer('h');
    expect(room.hostId).toBe('g');
    room.removePlayer('g');
    expect(room.players.size).toBe(0);
  });

  it('assigns teams to the smaller side', () => {
    const { room } = mk(() => 0);
    for (const id of ['a', 'b', 'c']) room.addPlayer(id, id);
    expect(room.teamCount(1)).toBe(2);
    expect(room.teamCount(2)).toBe(2);
  });

  it('ignores inputs from disconnected players and stale sequence numbers', () => {
    const { room } = mk(() => 0);
    room.addPlayer('g', 'Guest');
    room.start('h');
    const sim = room.sim!;
    room.handleInput('g', 5, { throttle: 1, turn: 0, fire: false, ability: false });
    expect(sim.tanks.get('g')!.input.throttle).toBe(1);
    room.handleInput('g', 4, { throttle: -1, turn: 0, fire: false, ability: false });
    expect(sim.tanks.get('g')!.input.throttle).toBe(1);
    room.setConnected('g', false);
    expect(sim.tanks.get('g')!.input.throttle).toBe(0);
    room.handleInput('g', 99, { throttle: 1, turn: 0, fire: false, ability: false });
    expect(sim.tanks.get('g')!.input.throttle).toBe(0);
  });
});

describe('static file server', () => {
  const root = mkdtempSync(join(tmpdir(), 'tc-static-'));
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'index.html'), '<html>app</html>');
  writeFileSync(join(root, 'assets', 'app-abcdefgh12.js'), 'console.log(1)');
  writeFileSync(join(tmpdir(), 'tc-secret.txt'), 'secret');
  const srv = createServer((req, res) => {
    if (!serveStatic(root, req, res)) res.writeHead(405).end();
  });
  const ready = new Promise<number>((r) =>
    srv.listen(0, '127.0.0.1', () => r((srv.address() as { port: number }).port)),
  );
  afterAll(() => new Promise<void>((r) => srv.close(() => r())));

  const get = async (path: string) => {
    const port = await ready;
    return fetch(`http://127.0.0.1:${port}${path}`);
  };

  it('serves files, an SPA fallback for /join/CODE, and cache headers', async () => {
    expect((await get('/')).status).toBe(200);
    const join_ = await get('/join/ABCDEF');
    expect(join_.status).toBe(200);
    expect(await join_.text()).toContain('app');
    const asset = await get('/assets/app-abcdefgh12.js');
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect(asset.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect((await get('/assets/missing.js')).status).toBe(404);
  });

  it('blocks path traversal attempts', async () => {
    const port = await ready;
    for (const p of [
      '/../tc-secret.txt',
      '/%2e%2e/tc-secret.txt',
      '/..%2ftc-secret.txt',
      '/assets/..%2f..%2ftc-secret.txt',
      '/%00',
    ]) {
      const res = await fetch(`http://127.0.0.1:${port}${p}`);
      const body = await res.text();
      expect(body).not.toContain('secret');
      expect([200, 400, 403, 404]).toContain(res.status);
    }
  });
});
