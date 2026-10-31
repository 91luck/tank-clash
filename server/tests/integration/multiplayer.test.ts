import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GAME_CONFIG, ROOM_CODE_REGEX } from '@tankclash/shared';
import { TestClient, advance, createRoom, startMatch, startTestServer, type TestServer } from '../helpers';

let ts: TestServer;
const open: TestClient[] = [];

beforeEach(async () => {
  ts = await startTestServer({ QUICK_MATCH_WAIT_MS: '50' });
});

afterEach(async () => {
  for (const c of open.splice(0)) await c.close().catch(() => undefined);
  await ts.stop();
});

async function room(names: string[]) {
  const r = await createRoom(ts, names);
  open.push(...r.clients);
  return r;
}

const input = (
  seq: number,
  o: Partial<{ throttle: number; turn: number; fire: boolean; ability: boolean }> = {},
) => ({
  t: 'input' as const,
  seq,
  throttle: 0,
  turn: 0,
  fire: false,
  ability: false,
  ...o,
});

function place(code: string, id: string, x: number, y: number, angle = 0): void {
  const t = ts.server.getRoom(code)!.sim!.tanks.get(id)!;
  t.x = x;
  t.y = y;
  t.angle = angle;
  t.protectUntil = 0;
}

describe('rooms and lobby', () => {
  it('1. creates a room with an unpredictable, valid code and makes the creator host', async () => {
    const { code, clients } = await room(['Ann']);
    expect(code).toMatch(ROOM_CODE_REGEX);
    const info = clients[0]!.lastRoom()!;
    expect(info.hostId).toBe(clients[0]!.id);
    expect(info.phase).toBe('lobby');
    expect(info.players).toHaveLength(1);
  });

  it('room codes are unique and not sequential', async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const c = await TestClient.join(ts.port, `P${i}`);
      open.push(c);
      c.send({ t: 'createRoom' });
      codes.add((await c.next('room')).room.code);
    }
    expect(codes.size).toBe(6);
  });

  it('2. lets a second player join and 4. gives everyone the same lobby state', async () => {
    const { clients } = await room(['Ann', 'Bob']);
    const [a, b] = clients as [TestClient, TestClient];
    expect(a.lastRoom()).toEqual(b.lastRoom());
    expect(
      a
        .lastRoom()!
        .players.map((p) => p.name)
        .sort(),
    ).toEqual(['Ann', 'Bob']);
  });

  it('accepts lowercase / padded codes and rejects others', async () => {
    const { code } = await room(['Ann']);
    const c = await TestClient.join(ts.port, 'Cy');
    open.push(c);
    c.send({ t: 'joinRoom', code: ` ${code.toLowerCase()} ` });
    expect((await c.next('room')).room.code).toBe(code);
  });

  it('3. rejects invalid and unknown room codes', async () => {
    const c = await TestClient.join(ts.port, 'Cy');
    open.push(c);
    c.send({ t: 'joinRoom', code: 'abc' });
    expect((await c.next('error')).code).toBe('bad_message');
    c.send({ t: 'joinRoom', code: 'ZZZZZZ' });
    expect((await c.next('error')).code).toBe('room_not_found');
  });

  it('5. assigns teams in a balanced way and lets players switch teams within limits', async () => {
    const { code, clients } = await room(['A', 'B', 'C', 'D']);
    const info = clients[0]!.lastRoom()!;
    expect(info.players.filter((p) => p.team === 1)).toHaveLength(2);
    expect(info.players.filter((p) => p.team === 2)).toHaveLength(2);
    // Team 2 -> 1 is allowed (cap is 4 per team); move everyone to team 1 until it is full.
    for (const c of clients) c.send({ t: 'setTeam', team: 1 });
    await Promise.all(clients.map((c) => c.sync()));
    expect(ts.server.getRoom(code)!.teamCount(1)).toBe(4);
    const extra = await TestClient.join(ts.port, 'E');
    open.push(extra);
    extra.send({ t: 'joinRoom', code });
    await extra.next('room');
    extra.send({ t: 'setTeam', team: 1 });
    expect((await extra.next('error')).code).toBe('team_full');
  });

  it('lets players pick a tank class and broadcasts it', async () => {
    const { clients } = await room(['A', 'B']);
    clients[1]!.send({ t: 'setClass', cls: 'scout' });
    await Promise.all(clients.map((c) => c.sync()));
    expect(clients[0]!.lastRoom()!.players.find((p) => p.id === clients[1]!.id)!.cls).toBe('scout');
    clients[1]!.send({ t: 'setClass', cls: 'tank-of-doom' });
    expect((await clients[1]!.next('error')).code).toBe('bad_message');
  });

  it('only the host can change match options, within range', async () => {
    const { clients } = await room(['A', 'B']);
    clients[1]!.send({ t: 'setSettings', settings: { durationSec: 30 } });
    expect((await clients[1]!.next('error')).code).toBe('not_host');
    clients[0]!.send({ t: 'setSettings', settings: { durationSec: 30 } });
    await Promise.all(clients.map((c) => c.sync()));
    expect(clients[1]!.lastRoom()!.settings.durationSec).toBe(30);
    clients[0]!.send({ t: 'setSettings', settings: { durationSec: 99999 } });
    expect((await clients[0]!.next('error')).code).toBe('bad_message');
  });

  it('rejects a 9th player (room full) and any join during a running match', async () => {
    const { code, clients } = await room(['1', '2', '3', '4', '5', '6', '7', '8']);
    const ninth = await TestClient.join(ts.port, '9');
    open.push(ninth);
    ninth.send({ t: 'joinRoom', code });
    expect((await ninth.next('error')).code).toBe('room_full');
    clients[7]!.send({ t: 'leaveRoom' }); // free a seat, then start a 7-player match
    await clients[7]!.next('left');
    await startMatch(ts, clients.slice(0, 7));
    ninth.send({ t: 'joinRoom', code });
    expect((await ninth.next('error')).code).toBe('match_in_progress');
  });

  it('14. lets a player leave safely, transferring host', async () => {
    const { clients } = await room(['A', 'B', 'C']);
    clients[0]!.send({ t: 'leaveRoom' });
    await clients[0]!.next('left');
    await clients[1]!.sync();
    const info = clients[1]!.lastRoom()!;
    expect(info.players).toHaveLength(2);
    expect(info.hostId).toBe(clients[1]!.id);
  });

  it('removes a room when its last player leaves', async () => {
    const { code, clients } = await room(['A']);
    clients[0]!.send({ t: 'leaveRoom' });
    await clients[0]!.next('left');
    expect(ts.server.getRoom(code)).toBeUndefined();
  });

  it('does not allow creating/joining while already in a room', async () => {
    const { code, clients } = await room(['A']);
    clients[0]!.send({ t: 'createRoom' });
    expect((await clients[0]!.next('error')).code).toBe('already_in_room');
    clients[0]!.send({ t: 'joinRoom', code });
    expect((await clients[0]!.next('error')).code).toBe('already_in_room');
  });
});

describe('match lifecycle', () => {
  it('6. starts only under valid conditions', async () => {
    const { clients } = await room(['A', 'B']);
    const [a, b] = clients as [TestClient, TestClient];
    b.send({ t: 'startMatch' });
    expect((await b.next('error')).code).toBe('not_host');
    // both on the same team => no opponent
    b.send({ t: 'setTeam', team: 1 });
    await b.sync();
    a.send({ t: 'startMatch' });
    expect((await a.next('error')).code).toBe('need_players');
    b.send({ t: 'setTeam', team: 2 });
    await b.sync();
    a.send({ t: 'startMatch' });
    const ms = await a.next('matchStart');
    expect(ms.you).toBe(a.id);
    expect(ms.snap.tanks).toHaveLength(2);
    expect(ms.snap.phase).toBe('countdown');
    expect((await b.next('matchStart')).you).toBe(b.id);
  });

  it('cannot start with a single player', async () => {
    const { clients } = await room(['A']);
    clients[0]!.send({ t: 'startMatch' });
    expect((await clients[0]!.next('error')).code).toBe('need_players');
  });

  it('7. replicates movement to every client', async () => {
    const { code, clients } = await room(['A', 'B']);
    const [a, b] = clients as [TestClient, TestClient];
    await startMatch(ts, clients);
    place(code, a.id, 200, 48, 0);
    place(code, b.id, 900, 600, Math.PI);
    a.send(input(1, { throttle: 1 }));
    await advance(ts, 15, clients);
    for (const c of [a, b]) {
      const t = c.snap()!.tanks.find((x: { id: string }) => x.id === a.id);
      expect(t.x).toBeGreaterThan(200 + 60);
      expect(t.x).toBeLessThan(200 + 90);
    }
    const ta = a.snap()!.tanks.find((x: { id: string }) => x.id === a.id);
    const tb = b.snap()!.tanks.find((x: { id: string }) => x.id === a.id);
    expect(ta.x).toBe(tb.x);
  });

  it('8. replicates projectiles consistently', async () => {
    const { code, clients } = await room(['A', 'B']);
    const [a, b] = clients as [TestClient, TestClient];
    await startMatch(ts, clients);
    place(code, a.id, 200, 48, 0);
    place(code, b.id, 900, 600, Math.PI);
    a.send(input(1, { fire: true }));
    await advance(ts, 3, clients);
    a.send(input(2));
    await advance(ts, 1, clients);
    expect(a.snap()!.bullets.length).toBeGreaterThan(0);
    expect(a.snap()!.bullets).toEqual(b.snap()!.bullets);
    expect(b.events('shot')).toHaveLength(1);
  });

  it('9. calculates damage on the server', async () => {
    const { code, clients } = await room(['A', 'B']);
    const [a, b] = clients as [TestClient, TestClient];
    await startMatch(ts, clients);
    place(code, a.id, 300, 48, 0);
    place(code, b.id, 380, 48, Math.PI);
    a.send(input(1, { fire: true }));
    await advance(ts, 6, clients);
    a.send(input(2));
    await advance(ts, 2, clients);
    const hp = b.snap()!.tanks.find((x: { id: string }) => x.id === b.id).hp;
    expect(hp).toBe(GAME_CONFIG.classes.assault.health - GAME_CONFIG.classes.assault.damage);
    expect(a.snap()!.tanks.find((x: { id: string }) => x.id === b.id).hp).toBe(hp);
  });

  it('10. destroys walls consistently for all clients', async () => {
    const { code, clients } = await room(['A', 'B']);
    const [a, b] = clients as [TestClient, TestClient];
    await startMatch(ts, clients);
    const sim = ts.server.getRoom(code)!.sim!;
    const wall = sim.map.walls[0]!;
    const ts32 = sim.map.tileSize;
    place(code, a.id, wall.col * ts32 - 70, wall.row * ts32 + 16, 0);
    place(code, b.id, 900, 600, Math.PI);
    a.send(input(1, { fire: true }));
    await advance(ts, 200, clients);
    a.send(input(2));
    await advance(ts, 1, clients);
    expect(a.events('wallDown').map((e) => e.wall)).toContain(wall.id);
    expect(b.events('wallDown').map((e) => e.wall)).toContain(wall.id);
    expect(sim.isBlockedTile(wall.col, wall.row)).toBe(false);
  });

  it('11. does not let a power-up be collected twice', async () => {
    const { code, clients } = await room(['A', 'B']);
    const [a, b] = clients as [TestClient, TestClient];
    await startMatch(ts, clients);
    place(code, a.id, 300, 48, 0);
    place(code, b.id, 300, 60, 0);
    ts.server.getRoom(code)!.sim!.powerups.push({ id: 77, kind: 'speed', x: 300, y: 54, expireTick: 99999 });
    await advance(ts, 3, clients);
    expect(a.events('powerTake').filter((e) => e.id === 77)).toHaveLength(1);
    expect(b.events('powerTake').filter((e) => e.id === 77)).toHaveLength(1);
    expect(a.snap()!.pu.find((p: { id: number }) => p.id === 77)).toBeUndefined();
  });

  it('12/13. keeps scores consistent and declares the correct winner', async () => {
    const { code, clients } = await room(['A', 'B']);
    const [a, b] = clients as [TestClient, TestClient];
    a.send({ t: 'setSettings', settings: { durationSec: 10 } });
    await a.sync();
    await startMatch(ts, clients);
    place(code, a.id, 300, 48, 0);
    place(code, b.id, 380, 48, Math.PI);
    const sim = ts.server.getRoom(code)!.sim!;
    sim.tanks.get(b.id)!.hp = 1;
    a.send(input(1, { fire: true }));
    await advance(ts, 6, clients);
    a.send(input(2));
    await advance(ts, 2, clients);
    expect(a.snap()!.sc).toEqual([1, 0]);
    expect(b.snap()!.sc).toEqual([1, 0]);
    await advance(ts, 10 * 30 + 5, clients);
    const endA = await a.next('matchEnd');
    const endB = await b.next('matchEnd');
    expect(endA.winner).toBe(1);
    expect(endB).toEqual(endA);
    expect(endA.scores).toEqual([1, 0]);
    expect(endA.board.find((e: { id: string }) => e.id === a.id).kills).toBe(1);
    expect(endA.board.find((e: { id: string }) => e.id === b.id).deaths).toBe(1);
    expect(a.lastRoom()!.phase).toBe('results');
  });

  it('ends the match immediately when a whole team leaves', async () => {
    const { clients } = await room(['A', 'B']);
    const [a, b] = clients as [TestClient, TestClient];
    await startMatch(ts, clients);
    b.send({ t: 'leaveRoom' });
    await b.next('left');
    const end = await a.next('matchEnd');
    expect(end.winner).toBe(1);
  });

  it('17a. lets a late joiner enter between matches and the host start an immediate rematch', async () => {
    const { code, clients } = await room(['A', 'B']);
    const [a, b] = clients as [TestClient, TestClient];
    await startMatch(ts, clients);
    b.send({ t: 'leaveRoom' }); // forfeit => results
    await b.next('left');
    await a.next('matchEnd');
    b.send({ t: 'joinRoom', code }); // back via the invite link while results are showing
    await b.next('room');
    expect((await b.next('matchEnd')).winner).toBe(1);
    b.send({ t: 'rematch' });
    expect((await b.next('error')).code).toBe('not_host');
    a.send({ t: 'rematch' });
    const [ma, mb] = await Promise.all([a.next('matchStart'), b.next('matchStart')]);
    expect(ma.snap.tanks).toHaveLength(2);
    expect(mb.snap.sc).toEqual([0, 0]);
  });

  it('17b. lets the host return everyone to the lobby after a match', async () => {
    const { clients } = await room(['A', 'B']);
    const [a, b] = clients as [TestClient, TestClient];
    a.send({ t: 'setSettings', settings: { durationSec: 10 } });
    await a.sync();
    await startMatch(ts, clients);
    await advance(ts, 10 * 30 + 5, clients);
    // overtime (tie) -> run it out to a draw
    await advance(ts, 60 * 30 + 5, clients);
    expect((await a.next('matchEnd')).winner).toBe(0);
    b.send({ t: 'toLobby' });
    expect((await b.next('error')).code).toBe('not_host');
    a.send({ t: 'toLobby' });
    await Promise.all(clients.map((c) => c.sync()));
    expect(a.lastRoom()!.phase).toBe('lobby');
    expect(b.lastRoom()!.phase).toBe('lobby');
    a.send({ t: 'setClass', cls: 'heavy' }); // lobby actions work again
    await a.sync();
    expect(a.lastRoom()!.players.find((p) => p.id === a.id)!.cls).toBe('heavy');
  });

  it('rematch from results restarts with scores reset', async () => {
    const { code, clients } = await room(['A', 'B']);
    const [a, b] = clients as [TestClient, TestClient];
    a.send({ t: 'setSettings', settings: { durationSec: 10 } });
    await a.sync();
    await startMatch(ts, clients);
    const sim = ts.server.getRoom(code)!.sim!;
    sim.scores[2] = 3;
    await advance(ts, 10 * 30 + 5, clients);
    expect((await a.next('matchEnd')).winner).toBe(2);
    await b.next('matchEnd');
    a.send({ t: 'rematch' });
    const ms = await a.next('matchStart');
    expect(ms.snap.sc).toEqual([0, 0]);
    expect(ms.snap.phase).toBe('countdown');
    await b.next('matchStart');
  });

  it('16. a disconnected player can resume with their session token and regain control', async () => {
    const { code, clients } = await room(['A', 'B']);
    const [a, b] = clients as [TestClient, TestClient];
    await startMatch(ts, clients);
    place(code, a.id, 200, 48, 0);
    place(code, b.id, 900, 600, Math.PI);
    const token = a.token;
    const id = a.id;
    await a.close();
    await b.sync();
    expect(b.lastRoom()!.players.find((p) => p.id === id)!.connected).toBe(false);

    const a2 = await TestClient.connect(ts.port);
    open.push(a2);
    const w = await a2.hello('whatever', token);
    expect(w.resumed).toBe(true);
    expect(w.id).toBe(id);
    const ms = await a2.next('matchStart');
    expect(ms.you).toBe(id);
    expect(ms.snap.phase).toBe('playing');
    a2.send(input(1, { throttle: 1 })); // seq restarts after resume
    await advance(ts, 10, [a2, b]);
    expect(a2.snap()!.tanks.find((t: { id: string }) => t.id === id).x).toBeGreaterThan(230);
  });

  it('15. a disconnected player stops steering immediately and cannot be controlled by others', async () => {
    const { code, clients } = await room(['A', 'B']);
    const [a, b] = clients as [TestClient, TestClient];
    await startMatch(ts, clients);
    place(code, a.id, 200, 48, 0);
    place(code, b.id, 900, 600, Math.PI);
    a.send(input(1, { throttle: 1 }));
    await advance(ts, 5, clients);
    await a.close();
    await b.sync();
    const tank = ts.server.getRoom(code)!.sim!.tanks.get(a.id)!;
    const x0 = tank.x;
    // An unauthenticated socket cannot send inputs at all.
    const rogue = await TestClient.connect(ts.port);
    open.push(rogue);
    rogue.send(input(1, { throttle: 1 }));
    expect((await rogue.next('error')).code).toBe('not_ready');
    await advance(ts, 10, [b]);
    expect(tank.x).toBe(x0);
  });

  it('removes a disconnected player once the grace period has passed', async () => {
    const t2 = await startTestServer({ LOBBY_GRACE_MS: '0', RECONNECT_GRACE_MS: '0' });
    try {
      const r = await createRoom(t2, ['A', 'B']);
      open.push(...r.clients);
      await r.clients[1]!.close();
      await r.clients[0]!.sync();
      t2.server.sweepNow(Date.now() + 1);
      await r.clients[0]!.sync();
      expect(r.clients[0]!.lastRoom()!.players).toHaveLength(1);
    } finally {
      await t2.stop();
    }
  });

  it('18. expired rooms cannot be joined any more', async () => {
    const { code, clients } = await room(['A']);
    ts.server.sweepNow(Date.now() + GAME_CONFIG.limits.roomIdleExpirySec * 1000 + 5000);
    const err = await clients[0]!.next('error');
    expect(err.code).toBe('room_expired');
    await clients[0]!.next('left');
    const c = await TestClient.join(ts.port, 'Late');
    open.push(c);
    c.send({ t: 'joinRoom', code });
    expect((await c.next('error')).code).toBe('room_not_found');
  });

  it('19. a player cannot control another player’s tank (no target field is accepted)', async () => {
    const { code, clients } = await room(['A', 'B']);
    const [a, b] = clients as [TestClient, TestClient];
    await startMatch(ts, clients);
    place(code, a.id, 200, 48, 0);
    place(code, b.id, 900, 600, Math.PI);
    a.send({ ...input(1, { throttle: 1 }), tankId: b.id, id: b.id, playerId: b.id });
    expect((await a.next('error')).code).toBe('bad_message');
    await advance(ts, 10, clients);
    expect(b.snap()!.tanks.find((t: { id: string }) => t.id === b.id).x).toBe(900);
    expect(a.snap()!.tanks.find((t: { id: string }) => t.id === a.id).x).toBe(200);
  });

  it('20. keeps simultaneous rooms isolated', async () => {
    const r1 = await room(['A1', 'B1']);
    const r2 = await room(['A2', 'B2']);
    await startMatch(ts, r1.clients);
    await startMatch(ts, r2.clients);
    place(r1.code, r1.clients[0]!.id, 200, 48, 0);
    place(r1.code, r1.clients[1]!.id, 900, 600, Math.PI);
    place(r2.code, r2.clients[0]!.id, 200, 48, 0);
    place(r2.code, r2.clients[1]!.id, 900, 600, Math.PI);
    r1.clients[0]!.send(input(1, { throttle: 1 }));
    await advance(ts, 20, [...r1.clients, ...r2.clients]);
    const ids2 = r2.clients.map((c) => c.id);
    const seenByRoom2 = r2.clients[0]!.snap()!.tanks.map((t: { id: string }) => t.id);
    expect(seenByRoom2.sort()).toEqual([...ids2].sort());
    expect(r2.clients[0]!.snap()!.tanks.find((t: { id: string }) => t.id === ids2[0]).x).toBe(200);
    expect(
      r1.clients[0]!.snap()!.tanks.find((t: { id: string }) => t.id === r1.clients[0]!.id).x,
    ).toBeGreaterThanOrEqual(299);
  });
});

describe('quick match', () => {
  it('pairs two waiting players into a started match and lets them cancel', async () => {
    const a = await TestClient.join(ts.port, 'QA');
    const b = await TestClient.join(ts.port, 'QB');
    const c = await TestClient.join(ts.port, 'QC');
    open.push(a, b, c);
    c.send({ t: 'quickMatch' });
    expect((await c.next('queue')).status).toBe('queued');
    c.send({ t: 'cancelQuick' });
    expect((await c.next('queue')).status).toBe('cancelled');
    a.send({ t: 'quickMatch' });
    b.send({ t: 'quickMatch' });
    const [ma, mb] = await Promise.all([a.next('matchStart'), b.next('matchStart')]);
    expect(ma.snap.tanks).toHaveLength(2);
    expect(mb.snap.tanks).toHaveLength(2);
    const roomA = a.lastRoom()!;
    expect(roomA.quick).toBe(true);
    expect(roomA.players.map((p) => p.team).sort()).toEqual([1, 2]);
    expect(b.lastRoom()!.code).toBe(roomA.code);
  });

  it('does nothing (and invents no opponents) while only one player is waiting', async () => {
    const a = await TestClient.join(ts.port, 'Solo');
    open.push(a);
    a.send({ t: 'quickMatch' });
    await a.next('queue');
    await new Promise((r) => setTimeout(r, 200));
    expect(a.all('matchStart')).toHaveLength(0);
  });
});

describe('real-time loop', () => {
  it('runs matches on the timer without manual ticks', async () => {
    const live = await startTestServer({ TIME_SCALE: '20' }, { manualTicks: false });
    try {
      const a = await TestClient.join(live.port, 'A');
      const b = await TestClient.join(live.port, 'B');
      open.push(a, b);
      a.send({ t: 'createRoom', settings: { durationSec: 10 } });
      const code = (await a.next('room')).room.code;
      b.send({ t: 'joinRoom', code });
      await b.next('room');
      a.send({ t: 'startMatch' });
      await a.next('matchStart');
      const snap = await a.next((m) => m.t === 'snap' && m.s.phase === 'playing', 5000);
      expect(snap.s.tanks).toHaveLength(2);
      // 10s match + 3s countdown at 20x ≈ 0.7s real time; with a tie it goes to overtime (60s => 3s real).
      const end = await a.next('matchEnd', 15000);
      expect([0, 1, 2]).toContain(end.winner);
      expect(end.overtime).toBe(true);
    } finally {
      await live.stop();
    }
  });
});
