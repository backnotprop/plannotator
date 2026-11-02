# Plannotator daily ping

A Cloudflare Worker in front of one D1 table. Once a UTC day, a Plannotator install sends `POST /ping` with `{"version":"X.Y.Z","age":N}`. The Worker adds 1 to that day's total for that version and age bucket. The client is `packages/shared/daily-ping.ts`.

## What it stores

`daily(day, version, age, n)` (`migrations/0001_daily.sql`): one row per UTC day, version and age bucket, and `n`, how many installs sent that day. Nothing else: no IP address, no header, no `request.cf` field (country, city, network), no time finer than the day, no row per request, and no ID. The Worker never reads a request header and never logs. `wrangler.toml` turns off Workers Logs, observability and Logpush. Never run `wrangler tail` against production.

`age` is the Fedora countme bucket: 1 the install's first week, 2 weeks 2 to 4, 3 weeks 5 to 24, 4 older.

## Routes

- `POST /ping`: a body over 128 bytes gets `413`; a body that is not exactly `{"version":"X.Y.Z","age":1|2|3|4}` gets `400`; otherwise one upsert and `204`.
- `GET /totals`: `{"days":[{"day","n","age":{"1":..},"versions":{"0.28.46":..}}]}` for the last 400 days, public (`access-control-allow-origin: *`, cached 5 minutes).
- Anything else: `404`; a wrong method: `405`.

## Deploy (owner only, never from CI)

```sh
cd apps/telemetry
bunx wrangler d1 create plannotator-ping        # put the printed id in wrangler.toml database_id
bunx wrangler d1 migrations apply plannotator-ping --remote
bunx wrangler deploy                            # serves ping.plannotator.ai only
```

The tests (`test/`) run in the root `bun test` against a fake D1.
