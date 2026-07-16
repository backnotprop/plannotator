# SPIKE: Live PR Context Updates

Date: 2026-06-30

## Question

How should Plannotator keep PR description, comments, review threads, checks, and merge state fresh without requiring manual refresh, while leaving a clean path toward bidirectional PR commenting?

## Findings

The current PR Overview reads context through one client hook: `packages/review-editor/hooks/usePRContext.ts`. That hook fetches `/api/pr-context` once per PR URL, stores the result in React state, and only retries after an error. It does not subscribe to updates.

Both review servers now have a warm PR context promise cache:

- `packages/server/review.ts`
- `apps/pi-extension/server/serverReview.ts`

The cache is keyed by PR URL, starts `fetchPRContext(prRef)` at startup and PR switch, and makes `/api/pr-context` wait on the cached promise instead of starting duplicate work. This removes duplicate fetches but still makes a successful context result session-stale.

The current `/api/pr-context` handler returns only a snapshot. There is no version field, stream, or server-side refresh loop for PR context.

The repo already has working SSE patterns:

- external annotations use `/api/external-annotations/stream` with a polling fallback in `packages/ui/hooks/useExternalAnnotations.ts`.
- agent jobs use `/api/agents/jobs/stream` with a polling fallback in `packages/ui/hooks/useAgentJobs.ts`.
- both main and Pi servers disable idle timeout for long-lived streams.

The PR write path is `/api/pr-action` in both review servers. It calls `submitPRReview(...)` and then returns `{ ok: true, prUrl }`. It does not refresh or broadcast PR context after a successful post.

Provider context cost is bounded but not free:

- GitHub context currently runs `gh pr view --json ...` and then one `gh api graphql` call for review threads. The explicit thread query caps at `reviewThreads(first: 100)` and `comments(first: 50)`.
- GitLab context currently runs five `glab api` calls in parallel for MR details, notes, approvals, pipelines, and linked issues. If a pipeline exists, it runs a sixth call for pipeline jobs.

Provider writes differ:

- GitHub review submission posts one review request that can include the body and inline comments together.
- GitLab submission posts the body as one note, then posts each inline file comment as a separate discussion.

Authentication is already delegated to the user's local provider CLI:

- GitHub uses `gh`.
- GitLab uses `glab`.

That means reads and writes run as the logged-in CLI user. No separate Plannotator OAuth flow is needed for this design.

## Rate Limit Notes

As of 2026-06-30, GitHub documents an authenticated primary REST limit of 5,000 requests per hour for ordinary user tokens and a GraphQL primary limit of 5,000 points per hour. GitHub also documents secondary limits such as concurrent request limits and content-creation limits. Source: https://docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api and https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api

As of 2026-06-30, GitLab.com documents 2,000 authenticated API requests per minute, 60 note creation requests per minute for issues and merge requests, and a project jobs endpoint limit. Self-managed GitLab instances can configure different limits. Source: https://docs.gitlab.com/user/gitlab_com/ and https://docs.gitlab.com/security/rate_limits/

A 30 second refresh interval is practical for normal use:

- GitHub: about 120 refreshes per hour, with about two provider operations per refresh. Actual GraphQL cost can vary by query shape, but this is far below normal primary limits for one watched PR.
- GitLab: about 10 to 12 provider requests per minute for one watched MR, which is far below the normal GitLab.com authenticated API limit.

The main rate-limit risk is not ordinary background reads. The realistic risks are many open PR sessions using the same token, a very large PR whose GitHub GraphQL queries cost more points, other tools consuming the same user token, and GitLab write bursts from many inline comments.

## SSE Notes

SSE does not call GitHub or GitLab. It only keeps a browser connection open to the local Plannotator server.

The practical browser/server concern is the number of open local streams per tab. Review mode can already open streams for external annotations and agent jobs. Adding one PR context stream is acceptable, but the implementation should not add separate streams for summary, comments, checks, and writes.

If stream count later becomes a problem, PR context events can be folded into a broader review event stream. That is not required for the first live-context implementation.

## Proposed Direction

Turn PR context into a server-owned live cache.

The server should keep one cache entry per PR URL. Each entry should store the latest context, the latest error if any, a version number, an in-flight refresh promise, watcher count, timer state, and any cooldown caused by rate limiting or provider errors.

Startup and PR switch should still warm the context once.

While at least one browser tab is watching a PR, the server should refresh that PR context on a fixed cadence. Start with 30 seconds. Do not refresh once per tab. Do not start a new refresh while one is already in flight.

After `/api/pr-action` posts successfully, the server should refresh the target PR context immediately and broadcast the result.

The client should subscribe automatically in PR mode. It should not require a manual refresh button for normal freshness. If SSE fails before a snapshot arrives, use a polling fallback like the existing external annotation and agent job hooks.

The server should stop recurring refreshes when there are no watchers for a PR URL. The successful context can remain cached for the rest of the review session.

Provider rate-limit handling should be conservative:

- If a provider command fails with an obvious rate-limit response, pause that PR entry before retrying.
- If a reset time or retry-after value is available, use it.
- If not, use a short conservative cooldown such as 60 seconds and keep showing the last successful context with a visible stale/error state.

## Open Questions

Should `/api/pr-context` add a `version` wrapper, or should only the stream use versioned envelopes while the existing snapshot endpoint remains raw `PRContext`? Keeping the existing endpoint raw avoids breaking the current API.

Should the stream be active whenever the app is in PR mode, or only while the PR Overview panel is open? For user experience, app-level PR mode is better because Overview is the default and context should already be fresh when opened.

Should the first implementation include provider-specific header parsing? With `gh` and `glab`, response headers are not always available through current command calls. The first implementation can handle obvious CLI rate-limit errors and add richer adapter metadata later.

Should GitLab inline comment writes get queueing or batching? GitLab currently posts each inline comment as a separate discussion. Queueing pending writes would be useful for future bidirectional commenting, but it is not required to keep remote context fresh.
