# Game rules

All numbers live in `shared/src/config.ts` and are the single source of truth for server, client and tests.

## Match

| Rule             | Value                                                                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Teams            | Alpha (▲ cyan) vs Bravo (■ orange). Team is shown by icon and colour.                                                                                           |
| Players          | 2–8 online (max 4 per team); practice is 1v1 or 2v2 with bots                                                                                                   |
| Mode             | Team deathmatch: each enemy kill is +1 for the killer's team                                                                                                    |
| Length           | 3:00 default; host can choose 1, 2, 3 or 5 minutes (server accepts 10–600 s)                                                                                    |
| Countdown        | 3 s before play starts                                                                                                                                          |
| Tie at time-up   | **Sudden-death overtime**, 60 s: the first kill wins. No kill in overtime = **draw**                                                                            |
| Win              | Higher score when time ends; also immediately if a team has no players left                                                                                     |
| Friendly fire    | Off (bullets pass through allies)                                                                                                                               |
| Respawn          | 3 s at one of that team's spawn pads, with 2 s spawn protection                                                                                                 |
| Joining late     | Open the invite link any time, even mid-match: you drop in on the squad with fewer humans, with 2 s spawn protection, taking a bot's seat if that squad is full |
| Leaving mid-game | You are removed; if a whole team leaves, the other team wins                                                                                                    |

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

Up to 4 on the map, one spawns every 8 s at a fixed pad, expiring after 20 s. All effects end on death.

| Icon  | Pick-up     | Effect                                                                                    |
| ----- | ----------- | ----------------------------------------------------------------------------------------- |
| **+** | Repair      | +40 HP                                                                                    |
| **S** | Speed       | ×1.4 speed, 5 s                                                                           |
| **R** | Rapid fire  | ×0.5 shot cooldown, 5 s                                                                   |
| **O** | Shield      | absorbs 40 damage, 6 s                                                                    |
| **3** | Triple Shot | three shells per shot in a ±0.17 rad fan, 6 s (live-shell cap ×3)                         |
| **B** | Ricochet    | shells bounce off steel walls up to 2 times, 8 s (bricks still stop them and take damage) |
| **!** | Overcharge  | shells do ×1.5 damage, 6 s                                                                |

## Squads and joining

Humans are spread evenly: a newcomer goes to the squad with fewer humans (ties: fewer tanks), and bots only fill gaps. A full squad still takes a human by removing its newest bot. "Play now" first looks for a public match already running with at least one connected human and a seat, and drops you in. Otherwise you queue, and if nobody comes you can start a public bot match that later "Play now" players will join. Private rooms are never filled by matchmaking.

## Balance evidence (bots, not humans)

`npm run balance -- --matches 200` (hard bots, 200 matches per pairing, with all seven power-ups spawning; re-run 31 Oct 2026):

Aggregate vs the other two classes (200/pairing): Assault 58%, Heavy 47%, Scout 47%. 600 mirrored 2v2 matches: Alpha 47% / Bravo 53% (a 100-match run earlier leaned the other way, 55/44, so there is no consistent side bias), 16% reached overtime, 0% ended without a kill, ~43 kills per match, first kill after ~9 s, 1% of kills within 3 s of respawn.

A tried change, faster shells (500 px/s), was **rejected on this data**: it dropped Scout to 27–35%. Compensating with +2 Scout damage overshot to 95% against Assault, because duels are decided by hits-to-kill breakpoints (5 vs 6 hits). Shell speed stays 420 px/s. The hit-registration complaint that motivated it is fixed by lag compensation instead (see ARCHITECTURE).

How to read this: the sampling error at 200 matches is roughly ±4 points, so Assault's 58% is the one result clearly outside noise. Bots do not dodge, so Scout's real-player strength (speed) is under-represented. An earlier tuning pass moved Scout from 0% to ~50% against these bots. A human playtest should drive the next pass; a small Assault nerf is the likely candidate.
