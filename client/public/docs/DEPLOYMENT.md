# Deployment (₹0)

**Nothing has been deployed from this repository, and no public URL exists.** Every path below was verified as far as possible without a hosting account:

- The Cloudflare build was bundled by `wrangler deploy --dry-run` and run locally in `workerd` (Cloudflare's open-source runtime) via `wrangler dev`. The full browser test suite passed against it, in both development and production mode.
- The Node build was run in the exact runtime-image layout of the `Dockerfile` and passed the same suite.
- The Docker image itself could not be built here: Docker Hub is blocked from the build machine (re-checked 29 Oct 2026, `403 Forbidden` on `node:22-alpine`). Northflank and other Docker hosts build it on their side.
- The final upload to each host was not performed.

## Which free host? (checked 29 Oct 2026)

| Host                                             | Runs this game free?                                                | Catch                                                                                                                                                                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Cloudflare Workers + Durable Objects**         | **Yes.** Durable Objects are on the Free plan (SQLite-backed class) | Daily limits: 100,000 requests and 13,000 GB-s of Durable Object time; WebSocket messages count 1 request per 20. When a limit is hit, online play errors until 00:00 UTC. No sleep or cold-start problem.                                 |
| **Northflank (Sandbox plan)**                    | **Yes**, via the included `Dockerfile`                              | Official pricing page (checked 29 Oct 2026): free Sandbox, 2 services, "Always on, no sleeping", "No card needed". Compute is small and "Limited"; one third-party summary says a card is verified at sign-up, so expect that possibility. |
| **Render (free web service)**                    | **Yes**                                                             | Sleeps after 15 min without traffic; a WebSocket message on an open connection counts as traffic since 24 Feb 2026. The first visitor after a sleep waits for a cold start.                                                                |
| Koyeb                                            | No for new users                                                    | Free plan closed to new sign-ups in Feb 2026 (per several trackers; the official pricing page no longer lists a free compute instance)                                                                                                     |
| Fly.io                                           | No                                                                  | No plans or free allowances for new customers ([official](https://docs.fly.io/about/discontinued-plans))                                                                                                                                   |
| Hugging Face Spaces (Docker)                     | No                                                                  | Docker/Gradio Spaces on compute now need a paid plan ([official](https://huggingface.co/docs/hub/en/spaces-overview))                                                                                                                      |
| Railway                                          | Trial only                                                          | One-time credit, then paid (per third-party summaries)                                                                                                                                                                                     |
| Glitch, Heroku                                   | No                                                                  | App hosting / free dynos shut down                                                                                                                                                                                                         |
| GitHub Pages, Cloudflare Pages, Netlify (static) | Client only                                                         | Cannot run the WebSocket server; usable for Option D below                                                                                                                                                                                 |
| Oracle Cloud Always Free, Google Cloud Run       | Possibly                                                            | Need a credit card at sign-up; not evaluated here                                                                                                                                                                                          |

Free tiers change often; re-check the host's own pricing page before relying on any row.

**Recommendation:**

1. **Cloudflare Workers.** Best player experience: no sleeping, global edge close to Indian players, as long as traffic fits the daily limits.
2. **Northflank Sandbox.** An always-on normal Node server, with no daily request cap; it builds the `Dockerfile`. Good when Cloudflare's daily limits are too tight.
3. **Render.** Simplest Git-push setup (Blueprint), but it sleeps when idle.

---

## Option A: Cloudflare Workers (recommended)

What gets deployed (`wrangler.jsonc`):

- `client/dist` as static assets. These are free and served from the edge, and `/join/CODE` links open the app.
- `cloudflare/worker.ts`: `/ws` and `/health` go to one Durable Object, `TankClashServer`, which runs the same `GameCore` as the Node server.

### A1. From your computer (simplest)

```bash
npm install
npx wrangler login               # opens the browser; create/sign in to a free Cloudflare account
npm run deploy:cloudflare        # builds the client, bundles the worker, uploads
```

Wrangler prints your URL, e.g. `https://tank-clash.<your-subdomain>.workers.dev`. Open it, create a room, and send the link.

### A2. Deploy button (after pushing to your own public GitHub repo)

Use `https://deploy.workers.cloudflare.com/?url=https://github.com/<you>/tank-clash` (the README button). Cloudflare copies the repo into your GitHub account, provisions the Durable Object, builds with Workers Builds and deploys. If that build fails with "command not found" for `vite` or `tsc`, its build step ran before dependencies were installed. In the Worker's **Settings → Build**, set the build command to `npm ci` and keep the deploy command `npx wrangler deploy`. Not verified here.

### A3. Automatic deploy on every push (GitHub Actions)

`.github/workflows/deploy-cloudflare.yml` runs typecheck and tests, then `wrangler deploy`, on each push to `main`. It needs two repository secrets:

1. `CLOUDFLARE_API_TOKEN`: Cloudflare dashboard → My Profile → API Tokens → "Edit Cloudflare Workers" template.
2. `CLOUDFLARE_ACCOUNT_ID`: shown on the Workers overview page.

Without the secrets, the workflow skips itself.

### Settings

None are needed. Optional `vars` in `wrangler.jsonc`:

- `ALLOWED_ORIGINS`: only if the client is served from another domain.
- `LOG_LEVEL`
- `MAX_ROOMS`
- `MAX_CONNECTIONS_PER_IP`

A custom domain also works without changes, because the page's own origin is always allowed.

### Staying inside the free limits

Each player sends about 30 messages a second during a match, which counts as about 1.5 requests a second. That is roughly 18 player-hours of matches a day within 100,000 requests. Durable Object time is billed while anyone is connected; 13,000 GB-s is roughly 28 hours of "someone connected" per day. Watch usage in the dashboard. Practice mode costs nothing (it runs in the browser).

## Option B: Northflank (always-on, Docker)

1. Push the repo to GitHub (public or private).
2. Sign up at https://northflank.com with GitHub, create a **project** and pick the region closest to your players.
3. **Create new → Service → Combined**. Name it `tank-clash`.
4. **Repository:** your repo, branch `main`. **Build options:** **Dockerfile** (it is in the repo root).
5. **Networking:** the Dockerfile exposes port **8080**. Make sure it is **HTTP** and **Public**: Configure → Networking → the port → Protocol HTTP, Accessibility Public.
6. **Resources:** keep the default (Sandbox) plan. **Environment variables:** none are needed. The image sets `NODE_ENV=production`, `CLIENT_DIR`, `TRUST_PROXY`, and same-origin connections are allowed automatically.
7. **Create service.** Northflank builds the image and gives you a URL like `https://p01--tank-clash--abc123.code.run`.

Health check (optional, under Advanced): HTTP `GET /health` on port 8080. Every push to `main` rebuilds and redeploys automatically.

The UI labels above come from Northflank's own "build and deploy your code" docs (29 Oct 2026); I did not click through them with an account.

## Option C: Render (free web service)

1. Push the repo to GitHub.
2. In Render: **New → Blueprint**, choose the repo. `render.yaml` sets everything: the Node runtime, the free plan, the Singapore region, the build `npm ci --include=dev && npm run build`, the start `node server/dist/index.js` and the health check `/health`.
3. Open `https://<name>.onrender.com`.

No `ALLOWED_ORIGINS` is needed: the server allows its own origin and reads `RENDER_EXTERNAL_URL`. The client warms the server with a `/health` ping as soon as the menu loads. If the server is asleep, players see a "Starting the game server" screen with a timer, plus a button to practise while waiting.

## Option D: any Docker host, or static client + separate server

- **Docker:** `docker build -t tank-clash . && docker run -p 8080:8080 tank-clash`. The image serves the client and the game on `$PORT`, runs as a non-root user, and has a health check.
- **Split hosting:** build the client with `VITE_WS_URL=wss://<game-server>/ws VITE_PUBLIC_ORIGIN=https://<static-site> npm run build -w client`. Host `client/dist` anywhere static; `404.html` (GitHub Pages) and `_headers` are generated. On Netlify, add a `_redirects` file with `/*  /index.html  200` to `client/dist` yourself for `/join/CODE` links. It is deliberately **not** in `client/public`: Cloudflare Workers rejects that rule as an infinite loop (its `single-page-application` setting already handles those links). Then set `ALLOWED_ORIGINS=https://<static-site>` on the server.

## Environment variables (Node server)

See [`.env.example`](../.env.example). In production you normally set **nothing**: `NODE_ENV=production` is set by the Dockerfile and `render.yaml`, and same-origin connections are allowed automatically. The server refuses to start with `ALLOWED_ORIGINS=*` or `TIME_SCALE` in production.

## After deploying: 2-minute check

1. `https://<your-url>/health` returns `{"status":"ok",…}`.
2. On a laptop, open the site, then choose **Play with friends** and **Copy invite link**. Open the link on your phone and join. Start a match.
3. Check DevTools → Network → WS: the connection should use `wss://`, and the console should be clean.
4. Optional: on the phone, choose "Install app" (or "Add to Home screen").

## Operations notes

- One instance holds all rooms in memory. A redeploy ends running matches; players see "connection lost" and return to the menu.
- Logs are JSON lines: `wrangler tail` on Cloudflare, or the Logs tab on Render.
- 200 simulated players used about 15% of one core in a local load test (TESTING.md). Real hosts' CPUs are slower; watch the dashboard.

## Sources

- Northflank pricing (Sandbox plan): https://northflank.com/pricing, ports/WebSockets: https://northflank.com/docs/v1/application/network/configure-ports, build and deploy: https://northflank.com/docs/v1/application/getting-started/build-and-deploy-your-code

- Cloudflare Durable Objects pricing and limits: https://developers.cloudflare.com/durable-objects/platform/pricing, https://developers.cloudflare.com/durable-objects/platform/limits
- Deploy to Cloudflare button: https://developers.cloudflare.com/workers/configuration/deploy-button/
- Render changelog, WebSocket messages keep free services awake: https://render.com/changelog/free-web-services-now-remain-active-while-receiving-websocket-messages
- Fly.io discontinued plans: https://docs.fly.io/about/discontinued-plans
- Hugging Face Spaces overview: https://huggingface.co/docs/hub/en/spaces-overview
- Koyeb scale-to-zero docs: https://www.koyeb.com/docs/run-and-scale/scale-to-zero, and pricing: https://www.koyeb.com/pricing
- Third-party summaries: https://dev.to/karthik_yk/the-free-tier-graveyard-every-dev-free-tier-that-died-2022-2026-367a, https://snapdeploy.dev/blog/free-cloud-deployment-platforms-2026-comparison (vendor blog; possible bias)
