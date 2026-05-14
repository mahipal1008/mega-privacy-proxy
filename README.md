# mega-privacy-proxy

Personal-use MEGA download privacy proxy. Three layers:

1. **Orchestrator** — always-on Render service. Assigns workers, tracks bandwidth, spawns/kills disposable workers.
2. **Worker** — disposable Render service. Streams from MEGA, rotates IP every ~4 GB.
3. **Browser client** — vanilla HTML/JS. Optional in-browser AES-GCM re-encryption.

## Architecture

```
┌─────────┐   HTTPS    ┌──────────────┐  HTTPS  ┌──────────┐  HTTPS  ┌──────┐
│ Browser │ ────────► │ Orchestrator │ ──────► │  Worker  │ ──────► │ MEGA │
└─────────┘   token    └──────────────┘  spawn  └──────────┘  creds  └──────┘
     ▲                        │  via Render REST API           │
     │   stream bytes         │                                │
     └────────────────────────┴────────────────────────────────┘

• MEGA sees only the Worker's Render IP.
• Render sees only TLS-encrypted bytes (E2E from worker to browser).
• No logs, no disk writes, no DB. All state in worker/orchestrator RAM.
• Every ~4 GB a worker is permanently killed via Render API and a fresh one spawned.
```

## Privacy model

| Party        | Can see                                      | Cannot see                       |
| ------------ | -------------------------------------------- | -------------------------------- |
| MEGA         | Worker IP, that *some* account is downloading | Your real IP, what client used   |
| Render       | TLS bytes, env vars, service URLs            | File contents (encrypted on the wire) |
| ISP / network| You connect to Render                        | Files, MEGA links                |
| Orchestrator | Worker pool state, bandwidth totals          | File contents (never piped through) |

## Repo layout

```
orchestrator/   Fastify control plane (Render web service)
worker/         Fastify stream proxy (spawned via Render REST API)
client/         Vanilla HTML/JS/CSS, no framework
tests/          Jest unit + integration + edge + Playwright
render.yaml     Blueprint (orchestrator + static client)
```

## Environment variables (orchestrator)

| Name | Description |
| ---- | ----------- |
| `MEGA_EMAIL` | Your MEGA account email |
| `MEGA_PASSWORD` | Your MEGA password |
| `PERSONAL_TOKEN` | 32+ char random secret. Required on every `/api/*` call. |
| `RENDER_API_KEY` | From Render dashboard → Account Settings → API Keys |
| `RENDER_OWNER_ID` | `tea-XXX` (team) or `usr-XXX` (personal) |
| `RENDER_GITHUB_REPO` | `https://github.com/<you>/mega-privacy-proxy` |
| `ORCHESTRATOR_URL` | This service's public Render URL |
| `CLIENT_ORIGIN` | Client domain for CORS (e.g. `https://mega-privacy-client.onrender.com`) |
| `MIN_WORKERS` | Default `2` |
| `BW_LIMIT_BYTES` | Worker kill threshold (default 4 GB = `4294967296`) |
| `BW_WARN_BYTES` | Pre-warm threshold (default 3.8 GB = `4076863488`) |

Worker env vars (injected automatically at spawn): `SESSION_TOKEN`, `ORCHESTRATOR_URL`, `MEGA_EMAIL`, `MEGA_PASSWORD`.

## Deploy steps

1. **Push this repo to GitHub** (already done if you forked from this template).
2. **Render dashboard → New → Blueprint** → connect this GitHub repo → "Apply".
3. Render reads `render.yaml` and creates `mega-orchestrator` (web) + `mega-privacy-client` (static).
4. **Set all `sync: false` env vars** for the orchestrator in the Render dashboard:
   - Generate `PERSONAL_TOKEN`: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - Get `RENDER_API_KEY` from Account Settings → API Keys.
   - Get `RENDER_OWNER_ID` from the URL of your team/account page (`tea-…` or `usr-…`).
   - Set `RENDER_GITHUB_REPO` to your repo URL.
   - Once the service has a URL, set `ORCHESTRATOR_URL` to that URL and redeploy.
   - Set `CLIENT_ORIGIN` to the static-site URL Render assigned.
5. Open `mega-privacy-client` URL in browser. Paste orchestrator URL + personal token (stored only in `localStorage`).

The orchestrator auto-spawns workers on startup and replaces them at 4 GB.

## How worker lifecycle works

```
spawn → WARMING (provisioning on Render, polling status)
     → ACTIVE  (URL live, /health returns 200)
on /internal/bandwidth >= BW_WARN_BYTES   → background-spawn a fresh worker
on /internal/bandwidth >= BW_LIMIT_BYTES  → mark DRAINING, wait 30s, DELETE service
ensureMinWorkers runs every 60s to maintain MIN_WORKERS
```

## Running tests

```bash
npm install
(cd orchestrator && npm install)
(cd worker && npm install)
npm test                  # jest unit + integration + edge
npm run test:browser      # playwright (install browsers first: npx playwright install)
```

## Security guarantees (enforced in code)

- All Fastify loggers set to `false`. No request logging middleware.
- Tokens compared with `crypto.timingSafeEqual()`.
- No `fs.writeFile`/`createWriteStream`/`appendFile`/`mkdtemp` anywhere — checked by tests.
- No DB, no Redis, no temp files.
- CSP `default-src 'none'`, HSTS, no-referrer, no-store, frame-deny on every response.

## WARNING

**Personal use only.** Bypassing MEGA's free-tier bandwidth limits with a paid account may violate MEGA's Terms of Service. Use a paid MEGA account you own. You are responsible for compliance.

## License

UNLICENSED — Personal use by the owner only.
