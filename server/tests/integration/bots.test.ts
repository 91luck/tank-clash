import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GAME_CONFIG, type RoomInfo } from '@tankclash/shared';
import { TestClient, advance, createRoom, startTestServer, type TestServer } from '../helpers';

let ts: TestServer;
const open: TestClient[] = [];

beforeEach(async () => {
  ts = await startTestServer();
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
const lastRoom = (c: TestClient): RoomInfo => c.lastRoom() as RoomInfo;

describe('bots in online rooms', () => {
  it('lets only the host add and remove clearly labelled bots, in the lobby', async () => {
    const { clients } = await room(['Host', 'Guest']);
    const [host, guest] = clients as [TestClient, TestClient];
    guest.send({ t: 'addBot', team: 1, difficulty: 'easy' });
    expect((await guest.next('error')).code).toBe('not_host');

    host.send({ t: 'addBot', team: 1, difficulty: 'hard' });
    await host.sync();
    const bots = lastRoom(host).players.filter((p) => p.bot);
    expect(bots).toHaveLength(1);
    expect(bots[0]).toMatchObject({ team: 1, bot: 'hard', connected: true });
    expect(bots[0]!.name).toMatch(/\(bot\)$/);

    host.send({ t: 'removeBot', id: bots[0]!.id });
    await host.sync();
    expect(lastRoom(host).players.some((p) => p.bot)).toBe(false);
  });

  it('rejects malformed bot messages', async () => {
    const { clients } = await room(['Host']);
    const host = clients[0] as TestClient;
    host.send({ t: 'addBot', team: 3, difficulty: 'easy' });
    host.send({ t: 'addBot', team: 1, difficulty: 'godlike' });
    host.send({ t: 'removeBot', id: 'someone-else' });
    await host.sync();
    expect(host.all('error').map((e) => e.code)).toEqual(['bad_message', 'bad_message', 'bad_message']);
  });

  it('fillBots evens the teams to at least 2v2 and a solo player can start immediately', async () => {
    const { clients } = await room(['Solo']);
    const host = clients[0] as TestClient;
    host.send({ t: 'fillBots', difficulty: 'normal' });
    await host.sync();
    const r = lastRoom(host);
    expect(r.players.filter((p) => p.team === 1)).toHaveLength(2);
    expect(r.players.filter((p) => p.team === 2)).toHaveLength(2);
    expect(r.players.filter((p) => p.bot)).toHaveLength(3);

    host.send({ t: 'startMatch' });
    const start = await host.next('matchStart');
    expect(start.snap.tanks).toHaveLength(4);
  });

  it('bots actually play: they move and shoot under server control', async () => {
    const { code, clients } = await room(['Solo']);
    const host = clients[0] as TestClient;
    host.send({ t: 'addBot', team: 2, difficulty: 'hard' });
    host.send({ t: 'startMatch' });
    await host.next('matchStart');
    const sim = ts.server.getRoom(code)!.sim!;
    const bot = [...sim.tanks.values()].find((t) => t.id.startsWith('bot-'))!;
    const start = { x: bot.x, y: bot.y };
    await advance(ts, 90 + 30 * 8, [host]); // countdown + 8 s of play
    expect(Math.hypot(bot.x - start.x, bot.y - start.y)).toBeGreaterThan(20);
    // Whether the bot has line of sight within the first seconds depends on the random match seed, so keep
    // playing (up to 30 s more) until it fires. A bot that never shoots still fails the test.
    const botShot = (): boolean => host.events('shot').some((e) => e.tank === bot.id);
    for (let s = 0; s < 30 && !botShot(); s++) await advance(ts, 30, [host]);
    expect(botShot()).toBe(true);
  });

  it('a human joining a room that is full of bots replaces a bot', async () => {
    const { code, clients } = await room(['Host']);
    const host = clients[0] as TestClient;
    for (let i = 0; i < GAME_CONFIG.match.maxPlayers - 1; i++)
      host.send({ t: 'addBot', team: i % 2 === 0 ? 2 : 1, difficulty: 'easy' });
    await host.sync();
    expect(lastRoom(host).players).toHaveLength(GAME_CONFIG.match.maxPlayers);
    const late = await TestClient.join(ts.port, 'Late');
    open.push(late);
    late.send({ t: 'joinRoom', code });
    const r = (await late.next('room')).room as RoomInfo;
    expect(r.players).toHaveLength(GAME_CONFIG.match.maxPlayers);
    expect(r.players.some((p) => p.name === 'Late')).toBe(true);
  });

  it('removes the room when the last human leaves, even if bots remain (no zombie rooms)', async () => {
    const { code, clients } = await room(['Host']);
    const host = clients[0] as TestClient;
    host.send({ t: 'fillBots', difficulty: 'easy' });
    host.send({ t: 'startMatch' });
    await host.next('matchStart');
    host.send({ t: 'leaveRoom' });
    await host.next('left');
    expect(ts.server.getRoom(code)).toBeUndefined();
  });

  it('marks bots on the final scoreboard', async () => {
    const r = await createRoom(ts, ['Host']);
    open.push(...r.clients);
    const host = r.clients[0] as TestClient;
    host.send({ t: 'setSettings', settings: { durationSec: 10 } });
    host.send({ t: 'addBot', team: 2, difficulty: 'easy' });
    host.send({ t: 'startMatch' });
    await host.next('matchStart');
    await advance(ts, 30 * (3 + 10 + 61), [host]); // countdown + match + worst-case overtime
    const end = await host.next('matchEnd');
    expect(end.board.find((b: { id: string }) => b.id.startsWith('bot-')).bot).toBe(true);
    expect(end.board.find((b: { name: string }) => b.name === 'Host').bot).toBeUndefined();
  });
});
