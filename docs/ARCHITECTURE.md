# Architecture

## Goals

Free to run, hard to cheat, easy to test. That led to three decisions: (1) one deterministic simulation shared by server and client, (2) a thin server that is the only authority, (3) a framework-free client.

## Packages (npm workspaces)

```
shared  ──►  server   (Node 20+, ws, zod)
   └─────►  client   (Vite, Canvas 2D, no UI framework)
```

`shared` has no DOM or Node dependency, so the exact same code runs in the server process, in browser practice mode, in the client's movement prediction, and in headless tests and balance runs.

| Module                  | Responsibility                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `shared/config.ts`      | Every tunable number (classes, timers, limits). Single source of truth.                                      |
| `shared/map.ts`         | Tile map, mirrored "Foundry" layout, spawns, power-up pads, `validateMap`.                                   |
| `shared/sim.ts`         | `Sim`: fixed-timestep simulation: movement, bullets, walls, damage, abilities, power-ups, phases, win.       |
| `shared/ai.ts`          | `BotBrain`/`BotController`: BFS pathfinding, line-of-sight, target leading, retreat, 3 difficulties.         |
| `shared/protocol.ts`    | Wire types, room-code rules, join-path helpers.                                                              |
| `shared/schemas.ts`     | zod strict schemas for client→server messages. Server-only entry point (keeps zod out of the client bundle). |
| `server/room.ts`        | `Room`: lobby/match/results lifecycle for one room. Knows nothing about sockets, so it is unit-testable.     |
| `server/game-server.ts` | HTTP + WebSocket upgrade, sessions, message pipeline, quick-match queue, sweeping, heartbeat.                |
| `server/security.ts`    | Token buckets, failure limiter, per-IP connection counter, crypto-random codes/tokens.                       |
| `server/static.ts`      | Optional static file server for the built client (traversal-safe, CSP, SPA fallback for `/join/CODE`).       |
| `client/main.ts`        | Screen state machine and wiring.                                                                             |
| `client/game/*`         | `OnlineMatch` (input loop, interpolation, prediction), `PracticeMatch`, `MatchView` (HUD/FX), `Renderer`.    |

## Simulation

- 30 ticks/s, fixed step, seeded `mulberry32` RNG. Same seed and same inputs give the same match (used by tests).
- Server tick order per `Sim.step()`: countdown handling → per-tank movement/ability/shooting → bullets → power-ups → respawns → match clock (time-up, overtime, win). Events (`shot`, `hit`, `kill`, `wallDown`, …) are queued and shipped with the next snapshot.
- Tank collision is circle-vs-tile with axis-separated sliding. Bullets advance in 2 sub-steps per tick (7 px each, against 32 px tiles and 16 px of tank hit radius), so they cannot tunnel through walls or tanks.

## Online data flow

```
client                                     server
  input @30 Hz {seq, throttle, turn, fire, ability} ─►  Room.handleInput  (validate, seq must increase)
                                                         Sim.step() @30 Hz   (authoritative)
  ◄── snap @15 Hz {s: Snapshot, ev: events, ack: lastSeq}
  Timeline (buffer) → render 2 snapshot-intervals in the past → interpolate others
  Predictor: own tank = server pos @ack + replay of unacked inputs; error smoothed away over ~0.3 s
```

What is **never** trusted from the client: position, velocity, damage, hits, kills, score, timers, power-up pickups, wall state, room membership of others, or which tank an input applies to (there is no target field; an input always drives the sender's own tank).

What **is** predicted client-side: only the local tank's movement, via `Sim.applyMovement` (the same function the server uses). Everything else, including your own shots hitting something, appears when the server says so.

**Lag compensation (favor the shooter, bounded).** Other tanks are drawn ~2 snapshot intervals in the past, plus network delay, so an online player aims at where enemies _were_. Measured with a perfect-aim shooter against a strafing target: hit rate falls from 33% (no lag) to 17% at 200 ms and 0% at 267 ms+. Each `input` therefore carries `vt`, the server tick the player is looking at. The server stores the view lag (`tick + 1 − vt`, clamped to 0..`maxRewindSec` = 0.4 s) on the tank. Each bullet records its shooter's lag at fire time and is hit-tested against targets' positions that many ticks ago, from a short per-tank position history. With this, the same shooter keeps the 33% no-lag hit rate up to the 400 ms cap. Trade-off: a target can occasionally be hit just after reaching cover, by at most 400 ms. Bots and practice mode use lag 0. Walls are not rewound.

Snapshots are plain JSON (~0.5 KB for 2 players, ~1.4 KB for 8). Walls are sent as events, with a full destroyed-wall list on `matchStart`/resume. JSON was chosen over a binary format for debuggability; measured bandwidth (≈21 KB/s per player at 8 players) is comfortably small, see TESTING.

## Sessions and reconnect

`hello` returns `{id, token}`. The token is 192 bits of `crypto.randomBytes`, stored in the browser's `sessionStorage` (never in URLs) and presented as `hello.resume`. A dropped socket keeps the seat for a grace period (8 s in lobby, 30 s in match/results), steering is neutralised immediately, and on resume the server replays `room` + `matchStart` (with the full wall list). A resumed session replaces the older socket.

## Room lifecycle

`lobby → match → results → (rematch → match | toLobby → lobby)`. Empty or idle rooms expire (10 min lobby, 5 min results). Joining is allowed in every phase. In the lobby/results the newcomer takes a seat (and sees the last result). During a match they **drop in**: `Room.pickSeat` puts them on the squad with fewer humans, removes that squad's newest bot if it is full (adding the human's tank before removing the bot, so a squad is never momentarily empty and forfeited), gives 2 s spawn protection and sends them `matchStart`; everyone else gets a `room` update and the client shows a one-line notice. If the host leaves, host transfers to a connected human. Quick match: a searcher is first dropped into a running _public_ room (`createRoom {open:true}`, used by the vs-bots fallback) that has a seat and a connected human; otherwise they queue, queued players are pulled into a public match the moment it starts, and when ≥2 players wait the server builds a balanced room.

## Client rendering

`Renderer` draws the static map (floor, steel walls, spawn pads, power-up pads) once into an offscreen canvas, then per frame draws destructible walls, power-ups, tanks, bullets and particles. All art is procedural (no image assets), so there are no licensing or loading concerns. Tank class is distinguishable by silhouette; team by colour **and** a ▲/■ icon on the turret, name tag, HUD and spawn pads.

## Two runtimes, one core

```
             ┌──────────── GameCore (rooms, sessions, rules, limits) ────────────┐
Node:  http + ws  ──► Transport{send, close, bufferedAmount, terminate} ◄── WebSocketPair + Durable Object  :Cloudflare
```

Everything that decides game outcomes lives in `shared/` and `server/src/{core,room,security,config}.ts`, which use only Web-standard APIs (Web Crypto, `console`, timers), so the identical code runs on Node and in `workerd`. The e2e suite runs against both (`E2E_TARGET=node|cloudflare`).

On Cloudflare a single Durable Object (`idFromName('global')`) hosts every room, so all players share one matchmaking queue, exactly like the single Node process. It uses standard (non-hibernating) WebSockets, because rooms live in memory and tick 30 times a second while anyone is connected.

## Bots in online rooms

The host can add or remove bots per squad, or "fill" to an even 2v2 or larger. Bots are server-side `BotBrain`s driving tanks through the same `Sim.setInput` path as humans. They are labelled `(bot)` with a badge everywhere, never count as humans for room lifetime (a room with only bots left is deleted), and are replaced automatically when a real player joins a full room. "Play now" offers a bot match when nobody else is queueing.

## Why not…

- **Socket.IO / frameworks:** raw `ws` + a 20-line protocol is smaller, easier to audit and cheaper on free tiers.
- **A database:** nothing needs to outlive a match; rooms are memory-only by design (and say so in the privacy notice).
- **Lockstep / client-authoritative:** trivially cheatable. Server authority was a hard requirement.
