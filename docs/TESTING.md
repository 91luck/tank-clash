# Testing

Everything below was run in this repository's development container (Linux, Node 22, Chromium via Playwright 1.63). Numbers are from the last full run, not estimates.

## Last results (29 Oct 2026)

| Layer                                                                                                   | Command                                                                                 | Result                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lint + Prettier                                                                                         | `npm run lint`                                                                          | clean                                                                                                                                                                              |
| Typecheck (shared, server, client, cloudflare; strict)                                                  | `npm run typecheck`                                                                     | clean                                                                                                                                                                              |
| Unit + integration + security                                                                           | `npm test`                                                                              | **146 passed, 0 failed** (6 files)                                                                                                                                                 |
| Browser e2e, Node server (dev mode, `TIME_SCALE=4`)                                                     | `npm run test:e2e`                                                                      | **12 passed, 0 failed**                                                                                                                                                            |
| Browser e2e, Cloudflare Worker + Durable Object in local `workerd`                                      | `npm run test:e2e:cloudflare`                                                           | **12 passed, 0 failed**                                                                                                                                                            |
| Browser e2e, Docker runtime layout (only `ws` + the two bundles, `NODE_ENV=production`, image env vars) | built server started by hand, then `playwright test --grep-invert "private room"`       | **11 passed, 0 failed**. The skipped test needs `TIME_SCALE`, which production refuses; it passed on the other two targets. Same-origin WebSocket → `101`, foreign origin → `403`. |
| Docker image build                                                                                      | `docker build .`                                                                        | **not run**: Docker Hub is blocked from this machine (`403 Forbidden` pulling `node:22-alpine`)                                                                                    |
| Production build                                                                                        | `npm run build`                                                                         | client 77 kB JS (≈26 kB gzip) + fonts, server bundle 0.8 MB                                                                                                                        |
| Dependency audit                                                                                        | `npm audit`                                                                             | 0 vulnerabilities                                                                                                                                                                  |
| Visual review                                                                                           | Playwright screenshots of every screen, desktop 1280×720 and Pixel 7 portrait/landscape | reviewed by eye; fixes listed below                                                                                                                                                |
| Balance (bots)                                                                                          | `npm run balance`                                                                       | see GAME_RULES.md                                                                                                                                                                  |
| Performance                                                                                             | `npm run perf`                                                                          | table below                                                                                                                                                                        |

Vitest breakdown: shared simulation **44**, server multiplayer integration **33**, server security **27**, server bots-in-rooms **7**, server units **12**, client **23**.

## What each suite proves

- **`shared/tests/sim.test.ts`**: map validity/symmetry/reachability; movement and wall collision; shooting and cooldowns; destructible walls (3 hits, stays down); damage, shields, kills, respawn and spawn protection; all three abilities and power-ups; friendly fire off; match phases (countdown → play → overtime → draw); forfeit; bots (win/lose behaviour, pathfinding, no wall-clipping). Selected tests were mutation-checked (break the rule, confirm the test fails).
- **`server/tests/integration/multiplayer.test.ts`**: real WebSocket clients against a real `GameServer` with a manual tick clock for determinism. Covers room create/join/leave/full/expired, team and class selection, host-only actions, start rules, movement/projectile/damage/wall/power-up replication, score and winner, rematch/lobby return, reconnect within and past grace, room isolation, quick-match queue.
- **`server/tests/integration/security.test.ts`**: malformed/binary/oversized frames, schema violations, prototype pollution, input flooding, stale/duplicate input, cooldown abuse, forged results, room-code guessing, creation limits, per-IP caps, token handling, origin allow-list, production config refusal.
- **`server/tests/unit/units.test.ts`**: token bucket, failure limiter, connection counter, code/token generation, config parsing.
- **`client/tests/client.test.ts`**: snapshot interpolation, prediction/reconciliation (smooth vs snap), joystick mapping, settings sanitising, reconnect backoff, and a static check that every element id the code looks up exists in `index.html` (this caught a real bug, below).
- **`e2e/game.spec.ts`** (Playwright, real Chromium, server + built client): menu and a clean console; invalid and unknown room codes; a full practice match (countdown → play → pause actually freezes the timer → resume → quit); **two separate browsers** create a room, join via invite link, switch teams, choose a class, play a real match through overtime to the results screen with both scoreboards, then return to the lobby; a forced socket drop reconnects and resumes the same seat; touch controls render under a mobile profile. The e2e server runs with `TIME_SCALE=4` (rejected in production) so a 60 s match takes ~15 s.

## Bugs the tests/runs found (and fixed)

1. `zod` was imported but never declared as a dependency; a clean install could not build the server. Found by the e2e build step.
2. Screen switcher hid the whole `<body>` (it shared the `data-screen` attribute with the screens), giving a blank page after the first navigation. Found by e2e.
3. The e2e build ran Vite in development mode (inherited `NODE_ENV`), baking in the dev WebSocket URL and breaking CSP. Fixed in the Playwright config.
4. The code looked up `#timer` and `#result-title`, which don't exist (the real ids differ): the match HUD threw every frame and the results screen never appeared. Found by e2e; now prevented by the client unit test above.
5. Scout class was unplayable against bots (0% win rate) in the first balance run; retuned (see GAME_RULES).
6. The server never actually sent `bad_version` for incompatible clients; now it does, with a test.
7. Visual review: the three tank classes looked identical at icon size (the Scout's wedge hull was hidden under a rectangular outline). Each class now has its own silhouette: bevelled Assault, twin-barrel Heavy with a box turret, wedge-shaped Scout with fins.
8. Visual review: the stencil display font drew the HUD score `0` like `()`; scores now use the UI font with tabular digits.
9. Visual review: in the lobby the **Start match** button sat below the fold on laptops and phones; lobby actions now live in a sticky bottom dock.
10. Visual review: the first-match control hint covered the player's own tank at bottom spawns; it now sits under the scoreboard.
11. The menu said "Offline" before any connection attempt, which read like an error. It now reports the real server state from a `/health` probe: checking, waking up, ready, or offline (Practice still works). Covered by a new e2e test.
12. Touch play was only checked as "buttons render". New phone tests drive the joystick and FIRE with real two-finger touch events (Chrome DevTools protocol, Pixel 7 profile, landscape). They assert the tank travels over 100 px and fires several shots, both offline and online, where the position comes from server snapshots, proving the server applied the touch input.
13. On a phone in landscape, the "Drag to drive" ring sat on top of the player's own spawn; it now fades out after the first touch.
14. Phones now try fullscreen + landscape lock on the tap that starts or joins a match (Android browsers allow this; iPhone Safari does not, so iPhones get an "Add to Home Screen" tip and no useless button).
15. A 0–0 draw after overtime said "(decided in overtime)"; it now says no kill was scored in sudden-death overtime.

## Performance (`npm run perf -- --seconds 8`)

Server spawned as its own process; bots send real inputs at 30 Hz over loopback WebSockets on the same machine as the server, so server CPU figures include contention and are an upper bound.

| Load               | Server CPU (% of 1 core) | RSS    | Snapshot size | Downstream/player | Snapshot gap p50 / p99 (target 66.7 ms) |
| ------------------ | ------------------------ | ------ | ------------- | ----------------- | --------------------------------------- |
| 1 room × 2 players | 3%                       | 87 MB  | 494 B         | 7.2 KB/s          | 67 / 71 ms                              |
| 1 room × 4         | 4%                       | 83 MB  | 786 B         | 11.5 KB/s         | 67 / 71 ms                              |
| 1 room × 8         | 4%                       | 85 MB  | 1425 B        | 20.9 KB/s         | 67 / 71 ms                              |
| 10 rooms × 8 (80)  | 8%                       | 91 MB  | 1452 B        | 21.3 KB/s         | 66 / 71 ms                              |
| 25 rooms × 8 (200) | 15%                      | 100 MB | 1463 B        | 21.4 KB/s         | 67 / 71 ms                              |

Takeaway: a single small instance should hold well over the 200 concurrent players tested. This does **not** measure real internet latency, packet loss, mobile CPUs or a real free-tier host's CPU throttling, which are typically much weaker than a dev container.

## Not tested (be honest about it)

- Firefox, Safari, Edge; **real iOS/Android devices**. Touch was tested with emulated multi-touch on a Pixel 7 profile in Chromium. Fullscreen/orientation-lock behaviour on real phones and iPhone Safari specifics are untested.
- Real network conditions (latency/jitter/loss shaping); long soak tests (hours); memory-leak profiling beyond the short perf runs.
- Audio output (headless); screen-reader and keyboard-only audits beyond semantic markup and focus styles.
- The GitHub Actions workflows (`ci.yml`, `deploy-cloudflare.yml`): written, never executed on GitHub.
- The Docker image build (blocked here; see the table) and the Deploy-to-Cloudflare / Deploy-to-Render buttons.
- Any actual deployment.

## Running things

```bash
npm test                         # all Vitest suites
npm run test:unit                # shared + server unit
npm run test:integration         # server integration + security
npx playwright install chromium  # once
npm run test:e2e                 # builds, starts the server, runs browsers
PWDEBUG=1 npx playwright test -g "private room"   # step through a test
```
