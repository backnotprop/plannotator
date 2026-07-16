# Synthesis: Live PR Context Updates

Date: 2026-06-30

## Summary

The right model is server-owned freshness. The browser should not decide when to call GitHub or GitLab, and multiple tabs should not multiply provider traffic. The server should keep one live PR context cache entry per PR URL and publish updates to the UI.

The existing warm cache is a good base. It already makes startup and PR switch start provider work early and shares the in-flight promise with `/api/pr-context`. The next step is to turn that one-shot promise cache into a live cache with a latest value, a refresh loop, a version number, and subscribers.

## Recommended Behavior

Fetch once at startup and PR switch, as already implemented.

When a PR-mode browser tab is open, subscribe to PR context updates automatically. The stream should send an immediate snapshot if one exists, or a loading state if a refresh is in flight.

Refresh the watched PR on a fixed interval. Use 30 seconds as the starting default.

Only refresh once per PR URL. If three tabs are open on the same PR, they all receive the same result from one server refresh.

After Plannotator posts a review or comment through `/api/pr-action`, refresh that PR immediately and broadcast the result.

When nobody is watching a PR, stop the recurring timer. Keep the last successful value in the session cache.

If a provider fails, keep showing the last successful value when available, include an error/stale state in the stream, and retry automatically. If the error is a rate-limit response, wait before retrying.

## Why This Shape

This gives the user the desired experience: no manual refresh. New comments, review state, and checks show up automatically while the PR is open.

It avoids waste. Provider reads are centralized in the server, so browser tabs only watch local state.

It keeps rate-limit risk low. At 30 seconds, one watched GitHub PR performs about 120 refreshes per hour. One watched GitLab MR performs about 10 to 12 API requests per minute. Those are practical for normal authenticated users.

It fits the existing app. The review UI already uses SSE for live data and falls back to polling when streams fail.

It also creates the foundation for bidirectional commenting. Once the server owns the live context, write operations can optimistically add pending local entries, send provider writes, refresh remote context, and reconcile by provider IDs.

## What To Avoid

Do not let each browser tab poll GitHub or GitLab independently.

Do not create separate streams for summary, comments, checks, review threads, and merge state.

Do not refresh forever after all browser tabs close.

Do not make provider rate-limit handling depend on complicated activity guesses. Use simple lifecycle facts: watched means refresh, unwatched means stop, write means refresh now, provider says slow down means slow down.

Do not break the existing `/api/pr-context` snapshot response. Keep it returning raw `PRContext` for compatibility.

## Implementation Direction

Add a shared live-context manager shape to both review servers, or move the core state machine into shared code if doing so stays simple. The main and Pi servers still need runtime-specific HTTP/SSE glue.

The cache entry should track:

- `url`
- `ref`
- latest `context`
- latest `error`
- `version`
- `inflight`
- `watchers`
- refresh timer
- `nextAllowedRefreshAt`

Events should be small JSON envelopes:

- `snapshot`
- `updated`
- `loading`
- `error`

The existing `usePRContext` hook should become the live client hook. It can keep the current return shape so panels do not need large changes.

The polling fallback can call `/api/pr-context` on the same interval. The server-side cache still ensures this does not create one provider refresh per tab.
