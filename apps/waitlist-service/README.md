# @plannotator/waitlist-service

Cloudflare Worker + D1 backend for the Plannotator Workspaces waitlist signup
form on `plannotator.ai/workspaces/`.

## Layout

```
core/
  cors.ts         # CORS allowlist + headers
  handler.ts      # Routing + rate limit + signup handler
  storage.ts      # WaitlistStore interface + SignupRow type
  validation.ts   # Field normalization + freemail detection + honeypot
stores/
  d1.ts           # D1Database-backed WaitlistStore
targets/
  cloudflare.ts   # Worker entry point
schema.sql        # D1 schema (waitlist + rate_limit tables)
wrangler.toml
```

## Endpoints

| Method | Path           | Notes                                              |
| ------ | -------------- | -------------------------------------------------- |
| POST   | `/signup`      | Public. Body: `{ name, email, company?, role?, team_size?, tools?, use_cases?, turnstile_token?, website? }`. `website` is a honeypot. |
| GET    | `/health`      | Public liveness probe.                             |
| GET    | `/admin/count` | Requires `Authorization: Bearer $ADMIN_TOKEN`.     |
| GET    | `/admin/list?limit=500` | Requires `Authorization: Bearer $ADMIN_TOKEN`. |

Defenses (all layered):

1. **Cloudflare Turnstile** — when `TURNSTILE_SECRET_KEY` is set, every signup
   must include a valid token verified via `siteverify`. The marketing page
   renders the widget in invisible/interaction-only mode, so legitimate
   visitors see nothing.
2. **Honeypot** — a hidden `website` field. If a bot fills it, we return a
   fake success without writing to D1.
3. **Per-IP rate limit** — 20 signups / UTC day, stored in the `rate_limit`
   table.

If you skip step 1 (don't set the secret), Turnstile verification is bypassed
and only steps 2 and 3 apply — useful for local development.

## First-time setup

```bash
cd apps/waitlist-service
bun install   # if you haven't already at the repo root

# 1. Create the D1 database.
bun run db:create
# Copy the printed `database_id` into wrangler.toml.

# 2. Apply the schema (remote = production D1 instance).
bun run db:migrate

# 3. Set the admin token used by /admin/* endpoints.
bunx wrangler secret put ADMIN_TOKEN

# 4. Create a Cloudflare Turnstile widget at
#    https://dash.cloudflare.com/?to=/:account/turnstile and store the secret.
#    Widget mode: "Managed". Appearance: "Interaction-only".
bunx wrangler secret put TURNSTILE_SECRET_KEY

# 5. Deploy.
bun run deploy
```

For local dev:

```bash
bun run db:migrate:local    # apply schema to wrangler's local SQLite
bun run dev                 # localhost:8787
```

## Exporting signups

```bash
bun run db:export | jq '.[0].results'
```

Or query directly:

```bash
bunx wrangler d1 execute plannotator-waitlist --remote \
  --command="SELECT email, name, company, created_at FROM waitlist ORDER BY created_at DESC LIMIT 50"
```

## Marketing site wiring

The Astro page reads two `PUBLIC_*` env vars at build time:

| Var | Default | What it does |
| --- | --- | --- |
| `PUBLIC_WAITLIST_URL` | `https://plannotator-waitlist.plannotator.workers.dev` | Base URL of this worker. |
| `PUBLIC_TURNSTILE_SITEKEY` | _(unset)_ | Cloudflare Turnstile sitekey. When unset, the widget is not rendered and the worker (if also unconfigured) accepts signups without verification. |

Override at build time:

```bash
PUBLIC_WAITLIST_URL=https://your-worker.example.com \
PUBLIC_TURNSTILE_SITEKEY=0x4AAAAAAA… \
  bun run --filter @plannotator/marketing build
```

For production, put these in your CI / Cloudflare Pages env. The Turnstile
sitekey is safe to commit / expose; the secret key stays in the worker.
