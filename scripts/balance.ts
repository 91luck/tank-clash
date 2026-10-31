/**
 * Balance harness: plays headless bot-vs-bot matches with the *same* Sim the server runs and prints
 * class win rates, team-side bias, stalemate rate and spawn-kill rate. Usage: npm run balance [-- --matches 40]
 * Results are statistical evidence from bots, not human playtests; see docs/GAME_RULES.md.
 */
import {
  BotController,
  GAME_CONFIG,
  Sim,
  TANK_CLASSES,
  type Difficulty,
  type TankClass,
  type TeamId,
} from '@tankclash/shared';

const arg = (name: string, def: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : def;
};
const MATCHES = arg('matches', 40);
const DIFFICULTY: Difficulty = 'hard';

interface Outcome {
  winner: 0 | TeamId;
  overtime: boolean;
  kills: number;
  firstKillSec: number | null;
  spawnKills: number;
  seconds: number;
}

function play(seed: number, teams: { team: TeamId; cls: TankClass }[]): Outcome {
  const sim = new Sim({ seed });
  const bots = new BotController(seed * 31 + 7);
  teams.forEach((t, i) => {
    const id = `b${i}`;
    sim.addTank({ id, name: id, team: t.team, cls: t.cls });
    bots.addBot(id, DIFFICULTY);
  });
  const respawnAt = new Map<string, number>();
  let kills = 0;
  let firstKill: number | null = null;
  let spawnKills = 0;
  let overtime = false;
  const maxTicks =
    (GAME_CONFIG.match.durationSec + GAME_CONFIG.match.overtimeSec + 10) * GAME_CONFIG.tickRate;
  while (sim.phase !== 'ended' && sim.tick < maxTicks) {
    bots.update(sim);
    sim.step();
    if (sim.phase === 'overtime') overtime = true;
    for (const ev of sim.drainEvents()) {
      if (ev.e === 'respawn') respawnAt.set(ev.tank, sim.tick);
      if (ev.e === 'kill') {
        kills++;
        firstKill ??= sim.tick / GAME_CONFIG.tickRate;
        const born = respawnAt.get(ev.victim) ?? 0;
        // "Spawn kill": victim died within 3 s of (re)spawning, i.e. right after the protection ended.
        if (sim.tick - born < 3 * GAME_CONFIG.tickRate && born > 0) spawnKills++;
      }
    }
  }
  return {
    winner: sim.winner ?? 0,
    overtime,
    kills,
    firstKillSec: firstKill,
    spawnKills,
    seconds: sim.tick / GAME_CONFIG.tickRate,
  };
}

const pct = (n: number, d: number): string => (d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(0)}%`);

console.log(
  `Balance run: ${MATCHES} matches per pairing, ${DIFFICULTY} bots, ${GAME_CONFIG.match.durationSec}s matches\n`,
);

// 1v1 class matrix (each pairing played from both sides to cancel spawn-side bias).
console.log('1v1 win rate of ROW class vs COLUMN class (draws count as half):');
console.log(['        ', ...TANK_CLASSES.map((c) => c.padEnd(8))].join(' '));
const classScore: Record<string, { w: number; n: number }> = Object.fromEntries(
  TANK_CLASSES.map((c) => [c, { w: 0, n: 0 }]),
);
let seed = 1;
for (const a of TANK_CLASSES) {
  const row: string[] = [a.padEnd(8)];
  for (const b of TANK_CLASSES) {
    let score = 0;
    let n = 0;
    for (let i = 0; i < MATCHES; i++) {
      const aFirst = i % 2 === 0;
      const o = play(
        seed++,
        aFirst
          ? [
              { team: 1, cls: a },
              { team: 2, cls: b },
            ]
          : [
              { team: 1, cls: b },
              { team: 2, cls: a },
            ],
      );
      const aTeam: TeamId = aFirst ? 1 : 2;
      score += o.winner === 0 ? 0.5 : o.winner === aTeam ? 1 : 0;
      n++;
    }
    row.push(pct(score, n).padEnd(8));
    if (a !== b) {
      (classScore[a] as { w: number; n: number }).w += score;
      (classScore[a] as { w: number; n: number }).n += n;
    }
  }
  console.log(row.join(' '));
}
console.log('\nOverall (excluding mirror matches):');
for (const c of TANK_CLASSES)
  console.log(
    `  ${c.padEnd(8)} ${pct((classScore[c] as { w: number }).w, (classScore[c] as { n: number }).n)}`,
  );

// 2v2 mixed squads: side bias, stalemates, pacing, spawn kills.
let t1 = 0;
let t2 = 0;
let draws = 0;
let ot = 0;
let kills = 0;
let spawnKills = 0;
let firstKillSum = 0;
let firstKillN = 0;
let noKill = 0;
const total = MATCHES * 3;
for (let i = 0; i < total; i++) {
  const squad = (k: number): TankClass => TANK_CLASSES[(i + k) % 3] as TankClass;
  const o = play(seed++, [
    { team: 1, cls: squad(0) },
    { team: 1, cls: squad(1) },
    { team: 2, cls: squad(0) },
    { team: 2, cls: squad(1) },
  ]);
  if (o.winner === 1) t1++;
  else if (o.winner === 2) t2++;
  else draws++;
  if (o.overtime) ot++;
  kills += o.kills;
  spawnKills += o.spawnKills;
  if (o.firstKillSec === null) noKill++;
  else {
    firstKillSum += o.firstKillSec;
    firstKillN++;
  }
}
console.log(`\n2v2 mirrored squads, ${total} matches:`);
console.log(
  `  team side bias:      Alpha ${pct(t1, total)}  Bravo ${pct(t2, total)}  draws ${pct(draws, total)}`,
);
console.log(`  went to overtime:    ${pct(ot, total)}`);
console.log(`  matches with 0 kills (stalemate): ${pct(noKill, total)}`);
console.log(`  avg kills per match: ${(kills / total).toFixed(1)}`);
console.log(`  avg time to first kill: ${(firstKillN ? firstKillSum / firstKillN : 0).toFixed(1)} s`);
console.log(`  spawn kills (died <3 s after respawn): ${pct(spawnKills, kills)} of kills`);
