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
- `packages/inbox/components/ThroughCloudflare.tsx`: Settings → Remote devices, read only, rendered only once set up.

**Two names, one app.** Setup makes `host` (the Inbox) and `sessionHost` (`<label>-s.<zone>`, one level, so the free certificate covers it): one ingress rule each, both covered by the one Access app (`self_hosted_domains`, one AUD, one policy, one sign-in), two DNS records. Host decides the world before any path or Referer logic: the Inbox's name never reaches a session (`/s/…` there is `403 wrong_origin`), and the sessions' name never reaches the Inbox (an unattributed Inbox route is `403 wrong_origin`; anything else `410`). The two are same-site to each other, so the Inbox's `Sec-Fetch-Site` rule refuses a session page's requests; the Access cookie and the apps' storage are per name. Sessions share `sessionHost` among themselves: one session page's rendering bug could reach another open session (not the Inbox). A per-session name under a wildcard (`*.<label>-s.<zone>`) would close that, but needs Advanced Certificate Manager for a second-level certificate and a wildcard Access app and DNS record; it would be one more setup step on top of this one, with no change to the Inbox's name.

**One name only.** A config without `sessionHost` (last week's trial setup: `host`, `team`, `aud`, `allow`, `port`, `on`) runs the door for the Inbox alone; `--cloudflare-access` sessions then refuse at startup with one line. The checks match the trial's prototype exactly (a 26-case differential run found no difference).

**The door.** A second listener on `127.0.0.1:<inboxCloudflareAccess.port>`, the tunnel's only target. Every request passes these checks in order; the first failure answers JSON `{error, code}` on `/api/*` and `/mcp`, plain text elsewhere, `no-store`:
1. Host is one of the two names (`:443` or none): `403 forbidden_host`.
2. `Cf-Access-Jwt-Assertion` is present. The `CF_Authorization` cookie is never read: `403 access_token_required`.
3. The token is at most 16 KB, three parts, `alg` exactly `RS256`, a `kid`, no `crit`; otherwise `403 access_token_invalid`.
4. The `kid` is among the team's certs (`https://<team>/cdn-cgi/access/certs`: RSA, 2048-bit or more, kept 1 h; an unknown kid refetches at most once a minute; with no keys a fetch is tried at most every 5 s; no redirects, 10 s timeout). An unknown kid is `403 access_token_invalid`; no usable keys is `503 access_keys_unavailable`.
5. The signature, `iss` (the team), `aud` (the app's tag), and `exp`, `nbf`, `iat` with 60 s skew: `403 access_token_invalid`.
6. Not a service token (`common_name`), a non-empty `email`, on the allowlist (case-insensitive): `403 access_identity_refused`.
7. `Sec-Fetch-Site`: the tailnet's rule on the Inbox's name (so an attached page's folder loads cross-site there too, `/api/html-assets/` and a linked machine's `/api/inbox/m/<machine id>/html-assets/`); on the sessions' name, cross-site and same-site are refused except a top-level navigation to `/s/<key>/`: `403 cross_site`.

After the checks, `Cf-*`, `Tailscale-*`, `X-Forwarded-*`, `Plannotator-Door*` and the `CF_Authorization` cookie are dropped. The window's port refuses any request that carries `cf-access-jwt-assertion`, `cf-connecting-ip`, `cf-ray`, `cf-access-authenticated-user-email`, `cf-ipcountry` or `cf-visitor` (`403 local_only`).

**Routing.**
- `pickDoorRoute`, primary: `/s/<key>/…` strips the prefix and proxies the request to that live session's loopback port. It forwards the sessions' Host and adds `Plannotator-Door: <the session's secret>`.
- Fallback (not for navigations): a same-origin `Referer` under `/s/<key>/`. Each use is noted to the debug log as `door_referer_fallback`, with the route's first two segments only.
- On the Inbox's name every request goes to the Inbox, dispatched as `served(req, "tailnet")`, exactly the tailnet owner's path: no `/mcp`, no connection routes, no device door.
- On the sessions' name an unattributed request gets `403 wrong_origin` on an Inbox route and `410 session_ended` otherwise, as does a key with no live session: never the Inbox, never another session's data.
- Session HTML is asked for with identity encoding. Its root-absolute `<script src>` and `<link href>` gain the prefix, and the shim (one inline script, only in pages served through the door) prefixes root-absolute same-origin URLs given to fetch, XMLHttpRequest, EventSource, WebSocket and sendBeacon.
- WebSocket upgrades are not relayed (`501`): the agent terminal stays off for published sessions.

**Sessions.**
- `--cloudflare-access` on review, annotate and annotate-last/last is refused with `--tailscale`, and with live app annotation.
- It forces local mode, starts the Inbox in the background when needed (`ensureInboxRunning`), and writes `<dataDir>/cloudflare-access/sessions/<key>.json` (0600, `{key, port, pid, secret}`, deleted on exit; a dead pid is pruned by the door).
- It announces `https://<sessionHost>/s/<key>/` with a QR.
- The session counts as `tailnetPublished`, with the same restrictions as the tailnet owner. `sessionTailnetAudience` makes a request the owner only when the door header matches (constant time, never logged) and Host is the sessions' name. A request with edge headers but no header is a peer (refused); one with neither is local, exactly as before.
- Not set up, turned off, or the Inbox reporting an error is a startup failure with one line.

**Setup, teardown, tunnel.**
- `setup` checks for `cloudflared` first (otherwise the install hint and nothing is touched). It verifies the token and finds the account, the zone and the Zero Trust team domain. It then creates the one-time-PIN provider, the tunnel (token to `<dataDir>/cloudflare-access/tunnel-token`, 0600), the ingress (one hostname, Host pinned, `http_status:404`) and the Access app (24 h, PIN only, one allow policy for the typed e-mail), and only then the two proxied CNAMEs.
- It refuses a hostname that already has a record or another Access app. The ids go to config with `on: false`.
- The outside checks (a recording listener on the port, its own `cloudflared`) send to each name: no login (it must redirect to the team), a forged token, a forged cookie and a wrong Host. Any 2xx, any Plannotator-marked answer, or anything reaching the recorder keeps it off. Only then is `on: true` set and the running Inbox told.
- `teardown` turns it off, then deletes both DNS records, the app, the tunnel's connections and the tunnel, in that order; it stops at the first refusal and is safe to re-run. `--local-only` lists what is left.
- `cloudflared tunnel --no-autoupdate run` gets `TUNNEL_TOKEN` in its environment, restarts with backoff (1 s doubling to 60 s, reset after a minute up), and reads its health from `cloudflared`'s own `/ready` on a `--metrics 127.0.0.1:<free port>` listener, with the "Registered tunnel connection" log line as a fallback (`cf-ready.ts`). A failed outside check names what was seen (the status code and where a no-login visit went, or `cloudflared`'s last log line) and what to check.
- State: `inbox.json` `cloudflare_access` (`inbox status`, `--json`), Settings.

**Settings → Remote devices → Cloudflare** (`components/ThroughCloudflare.tsx`, `CloudflareSetup.tsx`, `data/cloudflareAccess.ts`, `cloudflare.css`), under "Over your tailnet", in that section's cards, rows, flow and checks:
- Not set up: what it needs, whether `cloudflared` was found (the install command if not), and Set up.
- The form: the e-mail (typed, never filled in), the token (a password field; cleared from the page's state the moment setup is sent), then Find domains, a domain to pick, and the two names it will create before anything exists.
- Setting up: the five steps tick as the server reports them; a failure names its step, says nothing was left behind (or what was), and offers Try again.
- On: Inbox and sessions addresses with Copy, a QR code of the Inbox's, the tunnel's health, who may sign in, Turn off / Turn on, and Remove (asks for a token again, and says so).
- A problem (the tunnel not connected, `cloudflared` missing, the door's error) is one line with the "Not working" chip.
- Through the Cloudflare door itself the block says to change it on the computer or over the tailnet; the routes refuse door requests.

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
