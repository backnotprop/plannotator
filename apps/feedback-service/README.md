# @plannotator/feedback-service

Cloudflare Worker + D1 that collects product feedback from the Plannotator
Inbox (sidebar → Feedback) and from `plannotator feedback --stdin`.

The public endpoint can only submit. It never reads, and it never changes or
removes a stored row. There is no admin route, no list route and no key.

## Layout

```
core/
  handler.ts      # The one route, body cap, limits, origin rule
  validation.ts   # Strict field validation (unknown fields refused)
  cors.ts         # Browser origins: none unless listed in ALLOWED_ORIGINS
  ip.ts           # The limit key: the IP, an IPv6 address by its /64
  throttle.ts     # Per-caller throttle in isolate memory (never stored)
  storage.ts      # FeedbackStore: one method, insert
stores/
  d1.ts           # The one statement: a parameterised INSERT
targets/
  cloudflare.ts   # Worker entry point
schema.sql        # The append-only `feedback` table (+ triggers)
test/             # Handler, source guard and limits tests (in-memory store)
wrangler.toml
```

## The endpoint

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/feedback` | JSON body, at most 16 KB. Answer: `201 {"ok":true}`, nothing echoed. |
| OPTIONS | `/feedback` | CORS preflight, only for an origin listed in `ALLOWED_ORIGINS` (none by default). |

Every other path is `404`, every other method on `/feedback` is `405`.

Body fields (any other field is refused with `400`):

| Field | Required | Rule |
| --- | --- | --- |
| `message` | yes | 1–4,000 characters after trimming |
| `category` | no | `bug`, `idea` or `other` |
| `contact` | no | free text the person typed (an email or handle), at most 200 characters |
| `version` | no | the Plannotator version, a short label, at most 40 characters |
| `os` | no | the OS name (`macOS`, `Linux`, `Windows`), at most 40 characters |
| `surface` | no | `inbox`, `plan-review`, `code-review`, `annotate` or `cli` |

Errors: `400` bad JSON or a bad field, `403` an Origin that is not allowed,
`413` a body over 16 KB, `415` not `application/json`, `429` over a limit,
`500` the insert failed.

### Fallback for agents without the CLI

An agent that cannot run `plannotator feedback` can send the same request
itself, after the person has seen the exact text and said yes:

```bash
curl -sS -X POST https://plannotator-feedback.plannotator.workers.dev/feedback \
  -H 'Content-Type: application/json' \
  --data-binary @- <<'PLANNOTATOR_FEEDBACK_END'
{"message":"<the person's words, JSON-escaped>","category":"idea","surface":"cli"}
PLANNOTATOR_FEEDBACK_END
```

The body goes through a quoted heredoc (`<<'PLANNOTATOR_FEEDBACK_END'`, quotes
included), so the shell expands nothing in it: no `$VAR`, no backticks, no
`$(…)`, and a `'` in the words needs no escaping. Only JSON's own escapes apply
(`\"`, `\\`, `\n` for a line break), so the body is one line and can never be
exactly the end word. Never put the words in a double-quoted shell string.

## What is stored

Only: the message, the category, the contact the person chose to type, the
Plannotator version, the OS name, the surface and the time it arrived. No IP,
user agent, country, machine ID or anything else that identifies a person.
The per-IP limits read the caller's IP in memory only.

## Abuse limits (the owner's call)

All values are starting points; change them to taste.

Every per-caller limit counts an IPv4 address as itself and an IPv6 address by
its /64 (one host usually holds a whole /64).

1. **Cloudflare rate limiting, per caller** (`FEEDBACK_RATE_LIMITER` in
   `wrangler.toml`): 5 submissions per caller per 60 seconds. Cloudflare counts
   it per location (each data centre keeps its own count, eventually
   consistent), not once across the whole network.
2. **Cloudflare rate limiting, a ceiling for everyone** (`FEEDBACK_GLOBAL_LIMITER`):
   30 submissions per 60 seconds under one shared key, also per location. It
   caps a flood spread over many IPs; while it holds, real feedback waits too.
3. **Per-caller throttle** (`targets/cloudflare.ts`): 10 submissions per
   caller per 10 minutes, in one Worker isolate's memory. Soft: Cloudflare
   spreads a caller over many isolates and recycles them, so it only slows a
   burst that lands on one warm isolate.
4. **Body cap**: 16 KB; the message cap is 4,000 characters.

There is no daily or total cap: rows from a slow, distributed flood stay
until the owner removes them ("Removing a row").

There is no key: anything shipped in the client would be public. No browser
page may submit: a request with an `Origin` header is refused with `403`
(preflight included) unless that exact origin is in `ALLOWED_ORIGINS` (none
by default). The Inbox sends from its own server and the CLI from the
command line, neither with an Origin. CORS limits what a browser page can do;
it does not stop a script, which the limits above are for.

## Deployment

Deployed 2026-10-27 at `https://plannotator-feedback.plannotator.workers.dev/feedback`
(the default `PRODUCT_FEEDBACK_URL`), with its D1 database `plannotator-feedback`
(id in `wrangler.toml`). A change to the Worker ships with `bun run deploy`; a
change to `schema.sql` with `bun run db:migrate` first.

## First-time setup (owner only)

Nothing in CI creates, migrates or deploys this Worker. These are the steps
that were run once; a new account repeats them.

```bash
cd apps/feedback-service

# 1. Create the D1 database, then paste the printed database_id into wrangler.toml.
bun run db:create

# 2. Apply the schema.
bun run db:migrate

# 3. Deploy.
bun run deploy
```

Local development:

```bash
bun run db:migrate:local
bun run dev                 # http://localhost:8787/feedback
```

Then point Plannotator at it: `PLANNOTATOR_FEEDBACK_URL=http://localhost:8787/feedback`.
The default URL is `PRODUCT_FEEDBACK_URL` in `packages/core/product-feedback.ts`;
change it there if the Worker is deployed under another name.

## Reading feedback

Reading is the owner's, never through the Worker. Use the Cloudflare
dashboard (Workers & Pages → D1 → `plannotator-feedback` → Console) or:

```bash
bun run db:read            # the latest 100 rows, as JSON
```

Or any query:

```bash
bunx wrangler d1 execute plannotator-feedback --remote \
  --command="SELECT created_at, category, message FROM feedback WHERE category = 'bug' ORDER BY id DESC LIMIT 50"
```

### Removing a row

The table is append-only at the database too (`schema.sql` triggers). To
delete spam on purpose, drop the trigger, delete, and put it back:

```bash
bunx wrangler d1 execute plannotator-feedback --remote --command="DROP TRIGGER feedback_append_only_delete"
bunx wrangler d1 execute plannotator-feedback --remote --command="DELETE FROM feedback WHERE id = 123"
bun run db:migrate   # re-creates the trigger (IF NOT EXISTS)
```

## Tests

```bash
bun test apps/feedback-service
```

The handler runs against an in-memory store; no wrangler, no Cloudflare
account and no network. `test/source-guard.test.ts` fails if the Worker's
source gains any SQL but the one INSERT, any D1 read method, a second route
or a cookie.
