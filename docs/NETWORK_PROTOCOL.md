# Network protocol (version 1)

Transport: one WebSocket per player at `/ws`, UTF-8 JSON text frames. Binary frames are rejected. Max client→server message: **2048 bytes**. Types live in `shared/src/protocol.ts`; the server validates every inbound message with strict zod schemas in `shared/src/schemas.ts` (unknown keys are rejected).

## Client → server

| `t`                          | Fields                                                                              | Notes                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `hello`                      | `v` (=1), `name` (1–16 chars: letters, digits, space `_.-`), `resume?`              | Must be first. `resume` = previous session token.                  |
| `createRoom`                 | `settings?: {durationSec}`                                                          | Creator becomes host. Rate limited (4 burst, then 4/minute).       |
| `joinRoom`                   | `code`                                                                              | 6 chars from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (case-insensitive). |
| `leaveRoom`                  |                                                                                     |                                                                    |
| `setTeam`                    | `team: 1 \| 2`                                                                      | Lobby only; max 4 per team.                                        |
| `setClass`                   | `cls: assault \| heavy \| scout`                                                    | Lobby only.                                                        |
| `setSettings`                | `settings: {durationSec: 10..600}`                                                  | Host only, lobby only.                                             |
| `startMatch`                 |                                                                                     | Host only; needs 2+ players and both teams non-empty.              |
| `addBot`                     | `team: 1 \| 2`, `difficulty: easy \| normal \| hard`                                | Host only, lobby only; respects team and room caps.                |
| `removeBot`                  | `id` (`bot-N`)                                                                      | Host only, lobby only.                                             |
| `fillBots`                   | `difficulty`                                                                        | Host only: evens squads with bots, at least 2 per side.            |
| `rematch`                    |                                                                                     | Host only, from results (same handler as `startMatch`).            |
| `toLobby`                    |                                                                                     | Host only, from results.                                           |
| `quickMatch` / `cancelQuick` |                                                                                     |                                                                    |
| `input`                      | `seq` (int, strictly increasing), `throttle` −1..1, `turn` −1..1, `fire`, `ability` | ≤60/s. Drives only the sender's tank.                              |
| `ping`                       | `ts` number                                                                         | Echoed in `pong` for RTT.                                          |

## Server → client

| `t`          | Fields                                                                 | Notes                                                                                                                                                                                                                                                            |
| ------------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `welcome`    | `v`, `id`, `token`, `name`, `resumed`                                  | `token` is private to this client and is never broadcast.                                                                                                                                                                                                        |
| `room`       | `room: RoomInfo` (code, hostId, phase, settings, players[], …)         | Sent on every membership/lobby change.                                                                                                                                                                                                                           |
| `left`       |                                                                        | You are no longer in a room.                                                                                                                                                                                                                                     |
| `matchStart` | `mapId`, `tickRate`, `snapshotEvery`, `you`, `snap` (full, incl. `wd`) | Also sent on resume during a match.                                                                                                                                                                                                                              |
| `snap`       | `s: Snapshot`, `ev: SimEvent[]`, `ack`                                 | Every 2 ticks (15 Hz). `ack` = last input `seq` processed for you.                                                                                                                                                                                               |
| `matchEnd`   | `winner` (0 = draw, 1, 2), `scores`, `board[]`, `overtime`             |                                                                                                                                                                                                                                                                  |
| `queue`      | `status: queued \| cancelled`, `size`                                  |                                                                                                                                                                                                                                                                  |
| `pong`       | `ts`                                                                   |                                                                                                                                                                                                                                                                  |
| `error`      | `code`, `message`                                                      | Codes: `bad_message, bad_version, rate_limited, not_ready, room_not_found, room_expired, already_in_room, room_full, match_in_progress, not_host, not_in_room, bad_state, team_full, need_players, too_many_connections, server_busy, session_expired, internal` |

### Snapshot

`{tick, phase, left, sc:[a,b], tanks:[{id,x,y,a,hp,al,pr,sh,ab,cd,rs,fx,k,d}], bullets:[{id,x,y,a,t}], pu:[{id,k,x,y}], wd?}` with positions rounded to 2 decimals. Short keys are deliberate (bandwidth). `wd` (destroyed wall ids) appears only in full snapshots.

### Events (`ev`)

`shot, wallHit, solidHit, wallDown, hit, kill, respawn, ability, powerSpawn, powerTake, powerExpire, phase, end`. Events are cosmetic/UI hints and authoritative for walls (`wallDown`); the world state itself always comes from `s`.

## Handshake and resume

```
C: {"t":"hello","v":1,"name":"Ace"}
S: {"t":"welcome","v":1,"id":"3fa9c1d27b40","token":"…","name":"Ace","resumed":false}
… connection drops …
C: {"t":"hello","v":1,"name":"Ace","resume":"<token>"}
S: {"t":"welcome",…,"resumed":true}  then  {"t":"room",…}  and, in a match, {"t":"matchStart",…}
```

If the grace period has passed the server answers `welcome` with `resumed:false` (a fresh identity) and the client returns to the menu with an explanation.

## Limits and failure behaviour

| Condition                                    | Result                                                         |
| -------------------------------------------- | -------------------------------------------------------------- |
| Frame > 2048 B                               | Connection closed (ws `maxPayload`)                            |
| Invalid JSON / schema / unknown type         | `error bad_message`; repeated offences → close 1008            |
| >60 inputs/s, or >6 other msgs/s (burst 12)  | Dropped / `rate_limited`                                       |
| Missing/old `seq`                            | Silently ignored                                               |
| Wrong `v` in `hello`                         | `error bad_version` (client tells the player to reload)        |
| Slow consumer (send buffer backs up)         | Connection terminated so one slow client cannot stall a room   |
| No input for 1 s during a match              | That tank's input is zeroed (a frozen tab cannot keep driving) |
| Origin not in `ALLOWED_ORIGINS` (production) | HTTP 403 on upgrade                                            |
