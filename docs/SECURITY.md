# Security

Threat model: a public, free, anonymous game. Attackers are other players (cheating, griefing), bots (spam, room-code guessing, connection floods) and curious visitors (XSS, traversal). There are no accounts, payments or personal data beyond a chosen callsign, which keeps the blast radius small.

Every control below has a test unless noted. Test names refer to `server/tests/integration/security.test.ts` (S) and `multiplayer.test.ts` (M).

## Authority and anti-cheat

| Risk                                                  | Control                                                                                         | Test                                                                                                    |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Client claims positions, damage, kills, score, winner | Protocol has no such fields; strict schemas reject extras. Server computes everything.          | S "cannot claim damage, kills, scores, positions or victory"                                            |
| Speed hacks / input flooding                          | ≤60 inputs/s (excess dropped), per-class speed caps, `seq` must increase, throttle/turn clamped | S "drops excess input frequency and still bounds movement speed", "ignores stale and duplicated inputs" |
| Fire-rate hacks                                       | Cooldowns enforced in the sim (min 0.15 s even with every buff)                                 | S "enforces fire cooldown…", "…ability cooldown…"                                                       |
| Controlling someone else's tank                       | Inputs carry no target; they always apply to the sender's session                               | M "19. a player cannot control another player's tank"                                                   |
| Impersonation / session theft                         | 192-bit random token, never broadcast, never in URLs; resumed session kicks the old socket      | S "does not let a client impersonate…", "never leaks tokens…"                                           |
| Host-only actions by non-hosts                        | Server checks host on start/rematch/settings/toLobby and on adding/removing bots                | S "prevents unauthorized team changes and match starts"; bots "lets only the host add and remove…"      |

## Input validation

All inbound JSON is parsed in a try/catch, size-capped (2048 B at the socket), and validated against strict zod schemas (types, ranges, lengths, enums, no unknown keys). Names must match `^[\p{L}\p{N} _.-]+$`, 1–16 chars. Room codes must match the 6-char alphabet. Prototype-pollution style keys (`__proto__`) and server-only message types are rejected (S "rejects unexpected message types…"). Binary frames are rejected. Repeated garbage escalates to closing the socket (1008).

## Abuse and DoS controls

- Token buckets per connection: inputs 60/s, other messages burst 12 refilling 6/s, room creation burst 4 then 4/minute.
- Failed-join limiter (8 failures/min/IP) against room-code guessing; the code space is 31⁶ ≈ 887 M and codes are crypto-random.
- Per-IP connection cap (12 default; Node honours `X-Forwarded-For` only when `TRUST_PROXY=1`, Cloudflare uses the edge-set `CF-Connecting-IP`), global room cap (200).
- Slow-consumer termination; idle rooms and abandoned sessions are swept; heartbeat ping detects dead sockets.
- Stale inputs (>1 s) are zeroed so a frozen client can't keep driving.

## Transport and browser security

- **Origin check** on every WebSocket upgrade (protects against cross-site WebSocket hijacking). Production accepts: the page's own origin (the `Origin` host equals the request `Host`; a browser on another site cannot fake that), the public URL the hosting platform injects (`RENDER_EXTERNAL_URL` etc., validated as `https://host`), and anything in `ALLOWED_ORIGINS`. `*` is refused at startup. Requests without an `Origin` header (non-browser clients) are refused in production. Tested for Node (S "in production with no ALLOWED_ORIGINS accepts only the same origin", "rejects browser origins that are not on the allow-list") and manually against the Cloudflare build in `wrangler dev` (foreign origin → 403, no origin → 403, same origin → plays).
- Use **`wss://`** in production; free hosts terminate TLS for you. The client derives `wss` from `https` automatically.
- The static server sets `Content-Security-Policy` (`default-src 'self'; connect-src 'self' ws: wss:; script-src 'self'; object-src 'none'; frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`. If you host the client elsewhere (static host), add equivalent headers there; note `connect-src` must allow your game server's `wss://` origin.
- **XSS:** player names are untrusted. The client builds DOM with `textContent` only (no `innerHTML`), and names are also constrained by the regex above. The Playwright suite loads the app with a console-error check; there is no dedicated XSS payload e2e test beyond the schema rejecting `<script>` names (S).
- **Path traversal** in the static server: requests resolving outside the client directory are refused (manually verified with encoded and double-dot paths against the built server; not an automated test).
- Secrets: none exist in the client. The server needs no secrets; `.env*` is git-ignored except `.env.example`. `VITE_*` values are public by definition.

## Cloudflare-specific notes

- One Durable Object holds all rooms; the Worker forwards only `/ws` and `/health` to it, and static files never run code.
- Security headers for static files come from `client/public/_headers` (same CSP as the Node server).
- Free-plan daily limits act as a hard cost cap: when exceeded, requests fail instead of billing you.

## Privacy

Callsign is held in server memory for the life of a room (+ a short reconnect window) and in the browser's `localStorage`. Session token lives in `sessionStorage`. No analytics, cookies, accounts or third-party requests. IPs are used transiently for limits and written only to log lines for rejected origins/abuse (set `LOG_LEVEL=error` to minimise). A privacy notice is in the app.

## Dependencies

`npm audit` (all severities) reported **0 vulnerabilities** at the time of the last run (see TESTING). CI runs `npm audit --audit-level=high`. Dependencies are few: `ws`, `zod` on the server side; Vite/TypeScript/Vitest/Playwright/ESLint/Prettier/esbuild as dev tools.

## Not covered / known gaps

- No CAPTCHA, no account-level bans, no IP reputation: a determined attacker with many IPs can still fill rooms or connections up to the global caps.
- No lag compensation or server-side aim validation beyond physics: an aim-bot is not detectable here.
- Rate limits are per connection/IP in one process; they reset on restart and don't coordinate across instances.
- No third-party penetration test or fuzzing campaign has been done.
