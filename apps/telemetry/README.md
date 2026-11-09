# Plannotator daily ping

A Cloudflare Worker in front of three D1 tables of daily totals. Once a UTC day, each Plannotator tool a computer uses sends `POST /ping` with `{"version":"X.Y.Z","age_week":N,"tool":"plan","first":0|1,"favicon":"glass"}`. The Worker adds 1 to that day's total for that version, age bucket and tool, and, when `first` is 1 (the computer's first ping of the day), to the day's user total and to the day's count for that favicon. Releases before the `favicon` field send the same body without it; the Worker accepts that body for ever and counts no favicon for it. The client is `packages/shared/daily-ping.ts`.

## What it stores

`migrations/0001_daily.sql`:

- `daily(day, version, age_week, tool, n)`: one row per UTC day, version, age bucket and tool, and `n`, how many computers used that tool that day.
- `daily_total(day, version, age_week, n)`: one row per UTC day, version and age bucket, and `n`, how many computers used Plannotator at all that day.

`migrations/0002_daily_favicon.sql`:

- `daily_favicon(day, favicon, n)`: one row per UTC day and favicon, and `n`, how many computers had that favicon set that day (counted on the `first: 1` ping only). It is kept on its own, never next to the version, age bucket or tool.

Nothing else: no IP address, no header, no `request.cf` field (country, city, network), no time finer than the day, no row per request, and no ID. The Worker never reads a request header and never logs. `wrangler.toml` turns off Workers Logs, observability and Logpush, and serves only the custom domain (`workers_dev = false`, `preview_urls = false`). Never run `wrangler tail` against production.

`age_week` is the Fedora countme bucket: 1 the computer's first week, 2 weeks 2 to 4, 3 weeks 5 to 24, 4 older. `tool` is one of `inbox`, `plan`, `review`, `annotate`, `last`. `favicon` is the favicon set in Settings (config.json `favicon`): `glass`, `yellow`, `face` (the `totman` setting), or `none` when it was never picked (or holds anything else).

## Routes

- `POST /ping`: a body over 160 bytes gets `413`, by its Content-Length before any byte is read, or once the read passes 160 bytes; a body that is not exactly those four keys (`version` X.Y.Z, `age_week` 1-4, `tool` one of the five, `first` 0 or 1), or those four and `favicon` (one of `glass`, `yellow`, `face`, `none`), gets `400`; otherwise the upserts and `204`.
- `GET /totals`: `{"days":[{"day","users","age_week":{"1":..},"versions":{"0.28.46":..},"tools":{"plan":..},"favicon":{"glass":..}}]}` for the last 90 days, public (`access-control-allow-origin: *`). Served from the Cache API (`caches.default`) for 5 minutes, so repeated GETs do not read D1. `users`, `age_week` and `versions` count computers (from `daily_total`); `tools` counts computers per tool (from `daily`); `favicon` counts computers per favicon (from `daily_favicon`), only from releases that send it, so it adds up to less than `users` while older releases still ping.
- Anything else: `404`; a wrong method: `405`.

## Abuse

The Worker keeps no per-isolate rate limit: isolates are many and short-lived, so a counter in one would bound nothing. If counts are ever inflated on purpose, add a Cloudflare rate-limiting rule for `/ping` at the zone; it stores nothing in this app.

## Deploy (owner only, never from CI)

```sh
cd apps/telemetry
bunx wrangler d1 create plannotator-ping        # put the printed id in wrangler.toml database_id
bunx wrangler d1 migrations apply plannotator-ping --remote
bunx wrangler deploy                            # serves ping.plannotator.ai only
```

A new migration (such as `0002_daily_favicon.sql`) is applied with the same `migrations apply` before the `deploy`. A change to the body ships Worker first: the deployed Worker must accept a body before any released client sends it.

The tests (`test/`) run in the root `bun test` against a fake D1.
