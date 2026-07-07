# 003. Live PR Context Updates

Date: 2026-06-30

## Status

Accepted

## Context

The PR Overview now shows description, comments, review threads, checks, and merge state in one panel. ADR 002 added a warm PR context cache so this data starts loading at server startup and PR switch, and `/api/pr-context` can wait on already-started work.

That cache is still a one-shot session cache. If comments or checks change while the user is reviewing the PR, the UI does not update automatically. The user also does not want to manually refresh.

The review app already uses SSE for live local data such as external annotations and agent jobs. The provider reads are handled through the user's authenticated `gh` or `glab` CLI, so provider traffic must stay centralized in the server and must not multiply per browser tab.

Normal rate limits make automatic refresh practical. A watched GitHub PR refreshed every 30 seconds is well below ordinary authenticated GitHub primary limits for one review session. A watched GitLab MR refreshed every 30 seconds is also well below GitLab.com authenticated API limits for ordinary use. The realistic risk cases are many open PR sessions, unusually expensive GitHub GraphQL queries, other tools sharing the same token, and large GitLab comment write bursts.

## Decision

Make PR context a server-owned live cache.

Both review server implementations will keep a cache entry per PR URL. Each entry will track the latest context, latest error, version, in-flight refresh, watcher count, refresh timer, and any cooldown caused by rate limiting.

The server will continue warming PR context at startup and PR switch without blocking those flows.

The client will subscribe to PR context updates automatically in PR mode through a new SSE endpoint:

```text
GET /api/pr-context/stream
```

The server will refresh watched PR context every 30 seconds. It will refresh once per PR URL, not once per tab, and it will never start a second refresh while one is already in flight.

When the last watcher for a PR URL disconnects, the server will stop the recurring refresh timer for that PR. The last successful value can remain cached for the review session.

After `/api/pr-action` successfully posts a review or comment, the server will refresh the target PR context immediately and broadcast the result.

`GET /api/pr-context` will remain compatible and continue returning raw `PRContext` on success. It can keep serving as the initial snapshot path and as a polling fallback when SSE is unavailable.

If GitHub or GitLab returns a rate-limit error, the server will keep the last successful context visible when available, mark the context stale/error in stream state, wait until the provider retry time or a conservative cooldown, and retry automatically.

Provider adapters must surface failed primary context reads as refresh errors. They must not broadcast blank context as a successful update when the provider command failed.

This decision does not implement full bidirectional commenting yet. It creates the base needed for it: one server-owned view of remote context, immediate reconciliation after writes, and a natural place to represent pending, posted, failed, and synced comment states later.

## Consequences

Users should not need to manually refresh PR Overview to see new comments, changed checks, or the result of a comment they posted through Plannotator.

Provider reads stay bounded because the server refreshes once per watched PR URL and shares the result across tabs.

The review UI gains one additional local SSE stream in PR mode. This is acceptable with the current app, but future live review features should avoid adding many separate streams. If stream count becomes a problem, PR context events can be folded into a broader review event stream.

The implementation must update both server runtimes and the shared review client hook.

The live refresh loop must handle provider errors without clearing useful cached data or forcing manual retry.

Future bidirectional commenting should build on this cache by adding provider-specific write endpoints, optimistic pending local comments, provider ID reconciliation, and thread actions such as reply and resolve where supported.
