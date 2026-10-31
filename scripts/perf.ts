/**
 * Load/performance probe. Spawns the *built* server (npm run build first) as a separate process, connects many
 * lightweight bot clients over real WebSockets and reports server CPU, memory, snapshot size and snapshot-gap jitter.
 * Usage: npm run perf [-- --seconds 10]
 * These are single-machine numbers (clients share the CPU with the server), so treat them as an upper bound on cost.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { WebSocket } from 'ws';

const arg = (name: string, def: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : def;
};
const SECONDS = arg('seconds', 10);
const PORT = 18080;
if (!existsSync('server/dist/index.js')) {
  console.error('server/dist/index.js not found. Run `npm run build` first.');
  process.exit(1);
}

const server = spawn('node', ['server/dist/index.js'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    NODE_ENV: 'development',
    LOG_LEVEL: 'error',
    MAX_CONNECTIONS_PER_IP: '1000',
    MAX_ROOMS: '200',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function procStats(pid: number): { cpuSec: number; rssMb: number } {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ');
  const cpuSec = (Number(stat[11]) + Number(stat[12])) / 100; // utime + stime in clock ticks (100 Hz)
  const rss = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
  return { cpuSec, rssMb: rss ? Number(rss[1]) / 1024 : 0 };
}

interface Bot {
  ws: WebSocket;
  lastSnapAt: number;
  gaps: number[];
  bytes: number;
  snaps: number;
  code?: string;
  seq: number;
  timer?: NodeJS.Timeout;
}

function open(name: string): Promise<Bot> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const bot: Bot = { ws, lastSnapAt: 0, gaps: [], bytes: 0, snaps: 0, seq: 0 };
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', v: 1, name })));
    ws.on('message', (d) => {
      const text = d.toString();
      if (text.startsWith('{"t":"welcome"')) return resolve(bot);
      if (text.startsWith('{"t":"snap"')) {
        const now = performance.now();
        if (bot.lastSnapAt) bot.gaps.push(now - bot.lastSnapAt);
        bot.lastSnapAt = now;
        bot.bytes += text.length;
        bot.snaps++;
      } else if (text.startsWith('{"t":"room"') && !bot.code) {
        bot.code = /"code":"([A-Z0-9]{6})"/.exec(text)?.[1];
      }
    });
    ws.on('error', reject);
  });
}

const pctl = (a: number[], p: number): number => {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] as number;
};

async function scenario(rooms: number, perRoom: number): Promise<void> {
  const bots: Bot[] = [];
  for (let r = 0; r < rooms; r++) {
    const host = await open(`h${r}`);
    host.ws.send(JSON.stringify({ t: 'createRoom' }));
    while (!host.code) await sleep(5);
    bots.push(host);
    for (let p = 1; p < perRoom; p++) {
      const b = await open(`p${r}_${p}`);
      b.ws.send(JSON.stringify({ t: 'joinRoom', code: host.code }));
      bots.push(b);
    }
    await sleep(30);
    host.ws.send(JSON.stringify({ t: 'startMatch' }));
    await sleep(30);
  }
  // Every bot drives randomly at the real input rate (30 Hz).
  for (const b of bots) {
    let throttle = 1;
    let turn = 0;
    let fire = true;
    let n = 0;
    b.timer = setInterval(() => {
      if (n++ % 15 === 0) {
        throttle = Math.random() < 0.7 ? 1 : -1;
        turn = Math.floor(Math.random() * 3) - 1;
        fire = Math.random() < 0.8;
      }
      if (b.ws.readyState === WebSocket.OPEN)
        b.ws.send(JSON.stringify({ t: 'input', seq: ++b.seq, throttle, turn, fire, ability: n % 90 === 0 }));
    }, 1000 / 30);
  }
  await sleep(3500); // let the countdown finish so we measure live play
  for (const b of bots) {
    b.gaps.length = 0;
    b.bytes = 0;
    b.snaps = 0;
  }
  const before = procStats(server.pid!);
  const t0 = performance.now();
  await sleep(SECONDS * 1000);
  const wall = (performance.now() - t0) / 1000;
  const after = procStats(server.pid!);

  const gaps = bots.flatMap((b) => b.gaps);
  const snaps = bots.reduce((s, b) => s + b.snaps, 0);
  const bytes = bots.reduce((s, b) => s + b.bytes, 0);
  const cpu = ((after.cpuSec - before.cpuSec) / wall) * 100;
  console.log(
    `${String(rooms).padStart(3)} rooms x ${perRoom} = ${String(bots.length).padStart(3)} players | ` +
      `server CPU ${cpu.toFixed(0).padStart(3)}% of 1 core | RSS ${after.rssMb.toFixed(0)} MB | ` +
      `snapshot ${(bytes / Math.max(1, snaps)).toFixed(0)} B avg | ` +
      `down ${(bytes / wall / bots.length / 1024).toFixed(1)} KB/s/player | ` +
      `snap gap p50 ${pctl(gaps, 50).toFixed(0)} ms p99 ${pctl(gaps, 99).toFixed(0)} ms (target 66.7)`,
  );
  for (const b of bots) {
    clearInterval(b.timer);
    b.ws.close();
  }
  await sleep(500);
}

async function main(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (res.ok) break;
    } catch {
      await sleep(100);
    }
  }
  console.log(
    `Perf probe: ${SECONDS}s per scenario, bots send inputs at 30 Hz, server tick 30 Hz / snapshots 15 Hz\n`,
  );
  for (const [rooms, per] of [
    [1, 2],
    [1, 4],
    [1, 8],
    [10, 8],
    [25, 8],
  ] as const)
    await scenario(rooms, per);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => server.kill());
