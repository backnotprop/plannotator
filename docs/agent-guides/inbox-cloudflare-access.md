## Inbox: through Cloudflare Access

Opt-in reach for the Inbox and for `--cloudflare-access` sessions through the person's own Cloudflare account (Tunnel + Access), for people who do not use Tailscale. It follows the tailnet's model: one owner gets everything, and nobody else gets in. Off and invisible until `plannotator inbox cloudflare-access setup` runs. Bun only: the Inbox has no Pi twin, and Pi sessions have no `--cloudflare-access` (they have no `--tailscale` either).

**Files.**
- `packages/shared/inbox/cf-access.ts`: settings (config.json `inboxCloudflareAccess`, `PLANNOTATOR_INBOX_CF_ACCESS`), Host, edge headers, the door's `Sec-Fetch-Site` rule.
- `cf-access-verify.ts`: the token check.
- `cf-access-door.ts`: session registrations and routing.
- `door-base-shim.ts`: the base for a session page.
- `cf-access-api.ts`: setup and teardown calls.
- `packages/server/inbox-cf-access.ts`: the door listener.
- `packages/server/cf-tunnel.ts`: `cloudflared` as the Inbox's child.
- `packages/server/session-cf-access.ts`: the session side.
- `apps/hook/server/inbox-cf-access-command.ts` and `inbox-cf-access-checks.ts`: the command and the outside checks.
- `packages/inbox/components/ThroughCloudflare.tsx`: Settings → Devices, read only, rendered only once set up.

**The door.** A second listener on `127.0.0.1:<inboxCloudflareAccess.port>`, the tunnel's only target. Every request passes these checks in order; the first failure answers JSON `{error, code}` on `/api/*` and `/mcp`, plain text elsewhere, `no-store`:
1. Host is the configured hostname (`:443` or none): `403 forbidden_host`.
2. `Cf-Access-Jwt-Assertion` is present. The `CF_Authorization` cookie is never read: `403 access_token_required`.
3. The token is at most 16 KB, three parts, `alg` exactly `RS256`, a `kid`, no `crit`; otherwise `403 access_token_invalid`.
4. The `kid` is among the team's certs (`https://<team>/cdn-cgi/access/certs`: RSA, 2048-bit or more, kept 1 h; an unknown kid refetches at most once a minute; with no keys a fetch is tried at most every 5 s; no redirects, 10 s timeout). An unknown kid is `403 access_token_invalid`; no usable keys is `503 access_keys_unavailable`.
5. The signature, `iss` (the team), `aud` (the app's tag), and `exp`, `nbf`, `iat` with 60 s skew: `403 access_token_invalid`.
6. Not a service token (`common_name`), a non-empty `email`, on the allowlist (case-insensitive): `403 access_identity_refused`.
7. The tailnet's `Sec-Fetch-Site` rule, plus a top-level navigation to `/s/<key>/`: `403 cross_site`.

After the checks, `Cf-*`, `Tailscale-*`, `X-Forwarded-*`, `Plannotator-Door*` and the `CF_Authorization` cookie are dropped. The window's port refuses any request that carries `cf-access-jwt-assertion`, `cf-connecting-ip`, `cf-ray`, `cf-access-authenticated-user-email`, `cf-ipcountry` or `cf-visitor` (`403 local_only`).

**Routing.**
- `pickDoorRoute`, primary: `/s/<key>/…` strips the prefix and proxies the request to that live session's loopback port. It forwards the public Host and adds `Plannotator-Door: <the session's secret>`.
- Fallback: a same-origin `Referer` under `/s/<key>/`. Each use is noted to the debug log as `door_referer_fallback`, with the route's first two segments only.
- An unattributed request reaches the Inbox only on an Inbox route (`isInboxRoute`). The Inbox's requests are dispatched as `served(req, "tailnet")`, exactly the tailnet owner's path: no `/mcp`, no connection routes, no device door.
- Anything else, and any key with no live session, gets `410 session_ended`, never another session's data.
- Session HTML is asked for with identity encoding. Its root-absolute `<script src>` and `<link href>` gain the prefix, and the shim (one inline script, only in pages served through the door) prefixes root-absolute same-origin URLs given to fetch, XMLHttpRequest, EventSource, WebSocket and sendBeacon.
- WebSocket upgrades are not relayed (`501`): the agent terminal stays off for published sessions.

**Sessions.**
- `--cloudflare-access` on review, annotate and annotate-last/last is refused with `--tailscale`, and with live app annotation.
- It forces local mode, starts the Inbox in the background when needed (`ensureInboxRunning`), and writes `<dataDir>/cloudflare-access/sessions/<key>.json` (0600, `{key, port, pid, secret}`, deleted on exit; a dead pid is pruned by the door).
- It announces `https://<host>/s/<key>/` with a QR.
- The session counts as `tailnetPublished`, with the same restrictions as the tailnet owner. `sessionTailnetAudience` makes a request the owner only when the door header matches (constant time, never logged) and Host is the public name. A request with edge headers but no header is a peer (refused); one with neither is local, exactly as before.
- Not set up, turned off, or the Inbox reporting an error is a startup failure with one line.

**Setup, teardown, tunnel.**
- `setup` checks for `cloudflared` first (otherwise the install hint and nothing is touched). It verifies the token and finds the account, the zone and the Zero Trust team domain. It then creates the one-time-PIN provider, the tunnel (token to `<dataDir>/cloudflare-access/tunnel-token`, 0600), the ingress (one hostname, Host pinned, `http_status:404`) and the Access app (24 h, PIN only, one allow policy for the typed e-mail), and only then the proxied CNAME.
- It refuses a hostname that already has a record or another Access app. The ids go to config with `on: false`.
- The outside checks (a recording listener on the port, its own `cloudflared`) send: no login (it must redirect to the team), a forged token, a forged cookie and a wrong Host. Any 2xx, any Plannotator-marked answer, or anything reaching the recorder keeps it off. Only then is `on: true` set and the running Inbox told.
- `teardown` turns it off, then deletes the DNS record, the app, the tunnel's connections and the tunnel, in that order; it stops at the first refusal and is safe to re-run. `--local-only` lists what is left.
- `cloudflared tunnel --no-autoupdate run` gets `TUNNEL_TOKEN` in its environment, restarts with backoff (1 s doubling to 60 s, reset after a minute up), and counts connections from its log.
- State: `inbox.json` `cloudflare_access` (`inbox status`, `--json`), Settings.

**Tests.**
- `packages/shared/inbox/cf-access-verify.test.ts`: every refusal, the key cache, the settings.
- `cf-access-door.test.ts`: routing with two sessions, registrations, the secret.
- `door-base-shim.test.ts`.
- `cf-access-api.test.ts`: setup and teardown order against a stand-in API.
- `packages/server/inbox-cf-access.test.ts`: a real Inbox with local JWKS.
- `cf-tunnel.test.ts`: a fake `cloudflared`.
- `session-cf-access.test.ts`.
- `apps/hook/server/inbox-cf-access-command.test.ts`: setup with a stand-in API, edge and fake `cloudflared`.

No test calls Cloudflare.
