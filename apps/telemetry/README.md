# Plannotator usage counts

A Cloudflare Worker in front of one D1 table. A Plannotator process sends it whole-number counts for one experimental feature and one complete UTC day. The Worker adds those numbers into daily totals across everyone. Agents read the totals over a token-guarded route. Approval record: `.product/approved/experimental-telemetry/` (counts default on with a notice, no install id, D1 behind this Worker).

The registry of counted features, the batch shape and the validator are in `@plannotator/core/usage-counts`. The client and this Worker import the same list.

## What it stores

`daily_totals(day, feature, rev, event, bucket, reports, total)`, one row per key (`migrations/0001_daily_totals.sql`). A batch adds 1 to `reports` and its value to `total`.

- The `_reports` row (bucket `""`) holds the number of batches for that day, i.e. reporting install-days.
- A count event is filed under the range its value falls in (`1`, `2-3`, `4-9`, `10-29`, `30-100`). The totals show the spread. A cell can still hold one install's number: when only one install's value fell in a range that day, that cell's `total` is that value. The read route never shows such a cell (see below). The raw table does, to anyone with the owner's Cloudflare account. Nothing in it says which install it was.
- A day event and `first_day` are filed under `1`.
- `days_last7` is filed under its bucket (`1`, `2-3`, `4-5`, `6-7`), with total 0.

Nothing else is stored: no IP address, no time beyond the day, no row per request, no country, no user agent, and no install id. The Worker reads `CF-Connecting-IP` only to give it to the rate limiter. It never reads `request.cf`. It logs nothing about a request; its only log lines are fixed codes. `wrangler.toml` turns off observability and Logpush. Never run `wrangler tail` against production.

## Routes

- `POST /v1/counts`. Checks, in this order:
  - an `Origin` header gets `403`;
  - a type other than JSON gets `415`;
  - a body over 1024 bytes gets `413`;
  - more than 60 a minute from one IP gets `429` with `Retry-After: 60`;
  - a batch the shared validator refuses gets `400 {"code":"invalid"}`;
  - otherwise the batch is added and the answer is `204` with no body.
- `GET /v1/totals?feature=decisionMode&from=YYYY-MM-DD&to=YYYY-MM-DD[&rev=N]` with `Authorization: Bearer <READ_TOKEN>`. The range is at most 400 days. What it serves:
  - Only days closed for good. A batch is accepted for 3 days after its day, so the route serves days up to `served_through` (today minus 4) and nothing newer. Nobody can read a total before and after one install's batch and subtract.
  - A `(day, rev)` with fewer than 5 reporting install-days is left out and counted in `suppressed_days`.
  - Inside a day that is shown, any `(event, bucket)` cell with fewer than 5 reports is left out and counted in `suppressed_cells`.
  - `totals` sums only the cells that are shown, so a hidden cell cannot be worked out by subtracting one figure from another.
- `GET /`: one sentence.
- The daily cron (`0 4 * * *`) removes three things:
  - a feature's rows 180 days after its `collectUntil`;
  - any day older than 400 days;
  - every feature no longer in the registry. Keep a feature listed until its totals are gone.

An agent asks:

```sh
curl -s "https://counts.plannotator.ai/v1/totals?feature=decisionMode&from=2026-11-01&to=2026-11-07" \
  -H "Authorization: Bearer $PLANNOTATOR_TELEMETRY_READ_TOKEN"
```

How to read it: the data holds install-days, not people. `_reports` per day is about how many installs had the feature on that day. `opened.reports / active_day.reports` is the share of on-days on which the feature was used.

## Database history (D1 Time Travel)

D1 keeps a point-in-time history of every database: 7 days on the Workers Free plan, 30 days on Paid. Any moment in that window can be restored (`wrangler d1 time-travel`). The history holds writes in order, so two states a moment apart show what one batch added. That is a per-batch view the table itself does not keep. It expires on its own. Use Time Travel only to undo a mistake, never to inspect single batches. The privacy text says this.

## Limits on data quality

These are accepted for phase 1 and listed so totals are read with care:

- **No authentication.** Anyone can POST a valid batch. The rate limit (60 a minute per IP) slows inflation but does not stop it, so totals can be inflated by a determined sender.
- **A lost 2xx is a double count.** When the Worker added a batch but the answer never reached the client, the client sends the batch again on its next attempt.
- **A 4xx drops a batch.** A batch the Worker refuses (for example after a registry change, or a day past the 3-day window) is dropped by the client and never counted.
- **Install-days, not people.** `_reports` counts one computer per day; one person on two computers counts twice.

## Deploy (owner only)

No workflow deploys this Worker, and no workflow holds a Cloudflare secret. From this folder:

```sh
wrangler d1 create plannotator-telemetry       # done 2026-10-24; its id is in wrangler.toml
wrangler d1 migrations apply COUNTS --remote   # 0001 applied 2026-10-24
wrangler secret put READ_TOKEN                 # a long random string; agents use it to read totals
wrangler deploy
```

`wrangler.toml` names the custom domain `counts.plannotator.ai` and turns off the `*.workers.dev` hostname and preview URLs (`workers_dev = false`, `preview_urls = false`). Its `database_id` names the database on the owner's account, made with the first two commands above on 2026-10-24. Without `READ_TOKEN`, every read answers `401`.

## The proof

`bun test` from this folder runs the Worker under `wrangler dev`. Everything is local: D1 is persisted under `.wrangler/proof`, the migration is applied with `wrangler d1 migrations apply --local`, and the cron is triggered through `--test-scheduled`. The proof checks:

- the refusals;
- the sums and buckets;
- that the table has only its columns and that storage holds no IP or request detail;
- the token guard;
- that only closed days are served;
- the small-day and small-cell suppression;
- retention;
- the rate limit.

The root `bun test` skips this folder.
