# TANK CLASH: Squad Wars

Free team tank battles in the browser. Send a link on WhatsApp and your friends are in the fight: no download, no sign-up. Two squads, three tank classes, breakable walls, power-ups, bots to fill empty seats, and an offline practice mode. Works with keyboard and with phone touch controls, and can be installed as an app.

> **Honest status:** a working, tested game that has **not been deployed by me**. No public URL exists yet. Deploying it on your own free account takes a few minutes; see [Deploy for ₹0](#deploy-for-0) and the step-by-step guide in Hinglish: [docs/DEPLOY_GUIDE_HINGLISH.md](docs/DEPLOY_GUIDE_HINGLISH.md).

## Play locally (2 minutes)

Needs Node 20+.

```bash
npm install
npm run dev            # open http://localhost:5173 in two tabs
```

**Practice** works without any server. **Play with friends** needs the dev server, which `npm run dev` starts for you.

## Get it online in 3 steps

```bash
npm install
npm run publish:github     # creates YOUR public GitHub repo and pushes (uses GitHub CLI, browser login)
```

Then open one of the two deploy links it prints (Cloudflare recommended, Render as backup), log in with GitHub, and share the URL. Full walkthrough in Hinglish: [docs/PUBLISH_AND_DEPLOY_HINGLISH.md](docs/PUBLISH_AND_DEPLOY_HINGLISH.md).

## Play on your phone

Runs in the phone's browser (Chrome, Safari, Samsung Internet): touch joystick + FIRE button, multi-touch, landscape fullscreen on Android, "Add to Home Screen" on iPhone.

- **Same Wi-Fi, right now:** `npm run phone` builds the game, serves it on your network and prints a link and a **QR code**. Scan it with the phone camera. Friends on the same Wi-Fi can join from the invite link.
- **From anywhere:** deploy it (below), then open your URL on any phone.

Step by step in Hinglish: [docs/PLAY_ON_PHONE_HINGLISH.md](docs/PLAY_ON_PHONE_HINGLISH.md). To check any running copy (your deployment or the Wi-Fi one) in desktop and phone browsers: `npm run test:url -- <url>`.

## Deploy for ₹0

Three free paths. The Cloudflare and Node/Docker builds were run end to end in a real browser **locally**; the actual upload to each host was not done from here.

|                          | **Cloudflare Workers** (recommended)                                                                                                                                                                | **Northflank** (Sandbox)                                                                     | **Render** (free)                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Server sleeps when idle? | No                                                                                                                                                                                                  | No ("always on", per its pricing page)                                                       | Yes, after 15 min idle; the first visitor waits for a cold start (the game shows a "waking up" screen) |
| Card needed?             | No                                                                                                                                                                                                  | "No card needed" per pricing page (a third-party summary says a card is verified at sign-up) | No                                                                                                     |
| Free limits that matter  | 100,000 requests and 13,000 GB-s of Durable Object time **per day** ([official](https://developers.cloudflare.com/durable-objects/platform/pricing)): plenty for friends, not for a big public game | Small, "Limited" compute; 2 services                                                         | 750 instance hours/month                                                                               |
| How                      | `npx wrangler login` then `npm run deploy:cloudflare`, or the button below                                                                                                                          | Create a Combined service from your GitHub repo, build type Dockerfile, port 8080 public     | Push to GitHub, then **New → Blueprint**, or the button below                                          |

After you push this project to **your own public GitHub repo**, run `npm run personalize` once: it fills your repo into these buttons (or replace `YOUR_GITHUB_USERNAME` by hand). Then commit and push:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/YOUR_GITHUB_USERNAME/tank-clash)
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/YOUR_GITHUB_USERNAME/tank-clash)

**No environment variables are required.** The server accepts connections from its own address automatically, and picks up the URL Render injects. The `Dockerfile` is what Northflank (or any other container host) builds. Everything, including what "free" really means today and which hosts are no longer free, is in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

Optional automation: add a `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secret to your GitHub repo, and every push to `main` is tested and deployed by `.github/workflows/deploy-cloudflare.yml`.

## What's in the game

- **Look:** pixel-art tanks drawn by code (three distinct silhouettes, animated treads, team colours plus ▲/■ icons), industrial arena with raised steel and breakable crates, tread marks and scorch marks, glowing shells and layered explosions, a bold game UI. On phones the camera zooms in and follows your tank, with a minimap.

- **Play now:** quick match with whoever is online. If nobody is around, it offers an instant match against bots.
- **Play with friends:** private room, invite link, WhatsApp share button, host picks match length, and adds or removes bots (easy, normal or hard) for either squad.
- **Practice:** 1v1 or 2v2 against bots, fully offline once the page has loaded.
- Assault, Heavy and Scout tanks, each with a special ability; destructible walls; seven power-ups (including Triple Shot, Ricochet and Overcharge); sudden-death overtime.
- **Drop-in:** friends can open the invite link even mid-match and land on the squad with fewer players (taking a bot's seat if needed). "Play now" drops you into public matches already running.
- **Lag compensation:** your shots are judged against what you saw on screen (bounded to 400 ms), so online aiming feels fair.
- Damage numbers, kill banners, first-match control hints, reconnect after a dropped connection, a pause menu, rebindable keys, a reduced-motion mode, and an installable app.

## Scripts

| Command                                            | What it does                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `npm run dev`                                      | Game server + Vite client with hot reload                                                        |
| `npm run phone`                                    | Build and serve on your Wi-Fi; prints a link + QR code for your phone                            |
| `npm run test:url -- <url>`                        | Desktop + phone browser tests against any running copy (deployed or Wi-Fi)                       |
| `npm run publish:github`                           | Create your GitHub repo, push (with your private noreply email), print deploy links              |
| `npm run personalize`                              | Fill your GitHub repo into the Deploy buttons                                                    |
| `npm run dev:cloudflare`                           | The Cloudflare build, running locally in `workerd`                                               |
| `npm run check`                                    | Lint + format check, strict typecheck (4 projects), all unit/integration tests, production build |
| `npm run test:e2e` / `npm run test:e2e:cloudflare` | Real-browser tests against the Node server / the Cloudflare runtime                              |
| `npm run deploy:cloudflare`                        | Deploy to your Cloudflare account                                                                |
| `npm run balance` / `npm run perf`                 | Bot balance report / load test (see docs)                                                        |

## How it works

The browser sends only **intentions** (drive, turn, fire, ability) 30 times a second. The server owns the simulation: movement, hits, damage, kills, score, power-ups, walls, timer and winner. It sends compact snapshots 15 times a second. Your own tank's movement is predicted locally so it feels instant; everything else is server truth. The same game logic (`shared/`) runs on the server, in practice mode, in bots and in tests. The multiplayer core (`server/src/core.ts`) is runtime-independent, with two thin adapters: Node (`ws`) and Cloudflare (Durable Object). Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Docs

[Zip → live (Hinglish)](docs/PUBLISH_AND_DEPLOY_HINGLISH.md) · [Play on phone (Hinglish)](docs/PLAY_ON_PHONE_HINGLISH.md) · [Hinglish deploy guide](docs/DEPLOY_GUIDE_HINGLISH.md) · [Deployment](docs/DEPLOYMENT.md) · [Architecture](docs/ARCHITECTURE.md) · [Game rules](docs/GAME_RULES.md) · [Network protocol](docs/NETWORK_PROTOCOL.md) · [Testing](docs/TESTING.md) · [Security](docs/SECURITY.md) · [Troubleshooting](docs/TROUBLESHOOTING.md)

## Known limitations

- **Not deployed by me;** the hosting steps were verified only up to a local build and a local run of each runtime (see TESTING).
- **Cloudflare free limits are daily.** Heavy use can hit them; online play then fails until 00:00 UTC (5:30 AM IST). Practice keeps working.
- **One server instance holds all rooms in memory.** A redeploy or restart ends running matches.
- Only **Chromium** is tested automatically; phones were tested by emulation, not on a physical device.
- Sound could not be listened to in the test environment.
- Bots don't dodge, so balance numbers come from bots, not people.
- The GitHub Actions workflows were written but have never run on GitHub.

## Roadmap

Hindi UI · spectator mode · more maps · quick chat/emotes · gamepad support · optional accounts and stats · a balance pass based on human playtests.
