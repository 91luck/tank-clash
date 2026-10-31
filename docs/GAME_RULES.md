# Game rules

All numbers live in `shared/src/config.ts` and are the single source of truth for server, client and tests.

## Match

| Rule             | Value                                                                                |
| ---------------- | ------------------------------------------------------------------------------------ |
| Teams            | Alpha (▲ cyan) vs Bravo (■ orange). Team is shown by icon and colour.                |
| Players          | 2–8 online (max 4 per team); practice is 1v1 or 2v2 with bots                        |
| Mode             | Team deathmatch: each enemy kill is +1 for the killer's team                         |
| Length           | 3:00 default; host can choose 1, 2, 3 or 5 minutes (server accepts 10–600 s)         |
| Countdown        | 3 s before play starts                                                               |
| Tie at time-up   | **Sudden-death overtime**, 60 s: the first kill wins. No kill in overtime = **draw** |
| Win              | Higher score when time ends; also immediately if a team has no players left          |
| Friendly fire    | Off (bullets pass through allies)                                                    |
| Respawn          | 3 s at one of that team's spawn pads, with 2 s spawn protection                      |
| Leaving mid-game | You are removed; if a whole team leaves, the other team wins                         |

## Tanks

| Class   | HP  | Speed (px/s) | Damage | Shot cooldown | Ability                                                     |
| ------- | --- | ------------ | ------ | ------------- | ----------------------------------------------------------- |
| Assault | 100 | 150          | 20     | 0.50 s        | **Rapid Fire**: ×0.4 cooldown for 3.5 s (14 s recharge)     |
| Heavy   | 145 | 105          | 20     | 0.65 s        | **Shield**: absorbs 60 damage for up to 4 s (16 s recharge) |
| Scout   | 90  | 195          | 18     | 0.40 s        | **Speed Boost**: ×1.6 speed for 2.5 s (11 s recharge)       |

Effects never stack past ×2 speed, and fire cooldown never drops below 0.15 s. Max 4 live bullets per tank.

## Map: "Foundry"

32×20 tiles (1024×640 px), four-way mirrored so neither side has a layout advantage; validated at load (symmetry, spawn clearance, every spawn and power-up pad reachable). Grey steel walls are indestructible. Brown brick walls take 3 hits and then disappear for the rest of the match.

## Power-ups

Up to 4 on the map, one spawns every 8 s at a fixed pad, expiring after 20 s: **Health** (+40 HP), **Speed** (×1.4, 5 s), **Rapid Fire** (×0.5 cooldown, 5 s), **Shield** (40 HP, 6 s).

## Balance evidence (bots, not humans)

`npm run balance -- --matches 200` (hard bots, 200 matches per pairing, run on this repo's final config):

| 1v1 win rate, row vs column | Assault | Heavy | Scout |
| --------------------------- | ------- | ----- | ----- |
| Assault                     | 50%     | 63%   | 48%   |
| Heavy                       | 37%     | 50%   | 48%   |
| Scout                       | 51%     | 64%   | 52%   |

Aggregate vs the other two classes: Assault 55%, Heavy 43%, Scout 57%. Mirror matches landed at 50–52%. 600 mirrored 2v2 matches: Alpha 48% / Bravo 52% (no significant side bias), 15% reached overtime, 0% ended without a kill, ~45 kills per match, first kill after ~8 s on average, 1% of kills happened within 3 s of respawn.

How to read this: the sampling error at 200 matches is roughly ±4 points, so only the Heavy-vs-others gap is clearly outside noise. Bots do not dodge, so Scout's real-player strength (speed) is under-represented and Heavy's is probably over-represented. **A first tuning pass moved Scout from 0% to ~57% against these bots.** A human playtest should drive the next pass. Heavy is the likely buff candidate.
