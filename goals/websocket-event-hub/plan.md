# WebSocket Event Hub Plan

## Solution Approach

Add a daemon-owned WebSocket event hub and make it the only persistent browser event transport. Each browser frontend instance opens one WebSocket connection, sends connection-local subscription messages, receives an immediate snapshot for each subscribed scope, then receives filtered deltas. The daemon does not model tabs or coordinate connections. Session-scoped producers such as external annotations and agent jobs publish upward into the daemon hub instead of maintaining their own persistent subscriber sets.

HTTP remains the transport for snapshots, mutations, uploads, large payloads, and AI query token streaming. The old persistent SSE routes are removed or made nonfunctional for runtime use.

## Ordered Steps

1. Define the WebSocket protocol contract.

   Touch:
   - `packages/shared/daemon-protocol.ts`
   - `packages/shared/daemon-protocol.test.ts`
   - `apps/debug-frontend/src/daemon/contracts.ts`

   Work:
   - Add typed client messages: `subscribe`, `unsubscribe`, `action`, `ping`.
   - Add typed server messages: `snapshot`, `event`, `action-result`, `error`, `pong`.
   - Model subscription scopes as `{ sessionId?: string, family: "daemon" | "external-annotations" | "agent-jobs" }`.
   - Keep AI query token streaming out of this protocol.
   - Preserve normal HTTP response types for snapshots and mutations.

   Verification:
   - Unit tests validate accepted and rejected message shapes.
   - Protocol tests confirm event families and action correlation IDs serialize predictably.

2. Add a daemon event hub module.

   Touch:
   - `packages/server/daemon/event-hub.ts` (new)
   - `packages/server/daemon/server.ts`
   - `packages/server/daemon/runtime.ts`
   - `packages/server/daemon/server.test.ts`
   - `packages/server/daemon/runtime.test.ts`

   Work:
   - Create a connection registry keyed by WebSocket object.
   - Store only connection-local subscription state; do not create tab IDs or shared tab state.
   - Authenticate WebSocket upgrades with the existing daemon auth cookie/token model.
   - Add a daemon WebSocket endpoint such as `/daemon/ws`.
   - Send heartbeats and drop subscriptions when a socket closes or fails.
   - Move current daemon lifecycle/debug broadcasting from the SSE subscriber map into the hub.
   - Remove the persistent `/daemon/events` SSE stream.
   - Keep nonpersistent debug POST behavior, but publish those events into the WebSocket hub.

   Verification:
   - Server tests reject unauthenticated WebSocket upgrades.
   - Server tests accept authenticated upgrades.
   - Server tests prove subscribe sends a daemon snapshot before lifecycle deltas.
   - Server tests prove closed sockets are removed and no longer receive events.

3. Lift session-scoped event production into the daemon hub.

   Touch:
   - `packages/server/session-handler.ts`
   - `packages/server/daemon/server.ts`
   - `packages/server/daemon/session-factory.ts`
   - `packages/server/index.ts`
   - `packages/server/review.ts`
   - `packages/server/annotate.ts`
   - `packages/server/external-annotations.ts`
   - `packages/server/agent-jobs.ts`
   - `packages/server/external-annotations.test.ts`

   Work:
   - Extend daemon session context with a session event publisher and snapshot-provider registration.
   - Pass that context into plan, review, and annotate session creation.
   - Keep the boundary as callbacks, not hub imports: session handlers receive a bound publisher such as `(family, event) => publishSessionEvent(sessionId, family, event)`.
   - Keep snapshot access as registered callbacks: session handlers register providers such as `registerSnapshotProvider(sessionId, "external-annotations", () => store.getAll())`.
   - Do not let session handlers know about WebSocket connections, subscription registries, other sessions, or the daemon hub implementation.
   - Change `createExternalAnnotationHandler` so store mutations publish `{ family: "external-annotations", sessionId, event }` to the daemon hub.
   - Change `createAgentJobHandler` so job state/log events publish `{ family: "agent-jobs", sessionId, event }` to the daemon hub.
   - Expose snapshot provider functions for external annotations and agent jobs so new subscribers can receive current state before deltas.
   - Remove per-session persistent subscriber sets from these handlers.
   - Remove or make nonfunctional `/api/external-annotations/stream` and `/api/agents/jobs/stream`.
   - Keep `/api/external-annotations`, `/api/agents/jobs`, and related mutation endpoints intact for resync and writes.

   Verification:
   - External annotation tests assert POST/PATCH/DELETE still mutate state and publish hub events.
   - Agent job tests assert started/log/completed events publish through the hub.
   - Route tests assert old stream endpoints no longer return `text/event-stream`.
   - Integration tests assert subscription filtering prevents one session from receiving another session's annotation/job events.

4. Add WebSocket session actions for the approval loop.

   Touch:
   - `packages/server/daemon/event-hub.ts`
   - `packages/server/daemon/server.ts`
   - `apps/debug-frontend/src/daemon/api/client.ts`
   - `apps/debug-frontend/src/debug/SessionDebugPanel.tsx`
   - `apps/debug-frontend/src/debug/SessionDebugPanel.browser.tsx`

   Work:
   - Add an `action` client message with `requestId`, `sessionId`, method, path, and optional JSON body.
   - Restrict actions to the target session's `/api/*` surface and dispatch through the owning `DaemonSessionRecord.handleRequest`.
   - Return `action-result` or `error` messages with the same `requestId`.
   - Replace debug frontend approval/deny/feedback action probes that currently POST directly over HTTP when they are part of the approval loop.
   - Keep normal HTTP APIs available for large payloads and compatibility with nonpersistent writes.

   Verification:
   - Server tests cover action success, session-not-found, invalid path, handler error, and correlated replies.
   - Browser tests cover approve/deny buttons receiving action replies.

5. Replace frontend EventSource transports with one WebSocket transport.

   Touch:
   - `apps/debug-frontend/src/daemon/events/event-stream.ts`
   - `apps/debug-frontend/src/daemon/events/use-daemon-events.ts`
   - `apps/debug-frontend/src/daemon/events/event-store.ts`
   - `apps/debug-frontend/src/daemon/api/client.ts`
   - `packages/ui/hooks/useExternalAnnotations.ts`
   - `packages/ui/hooks/useAgentJobs.ts`
   - `packages/ui/utils/api.ts`
   - Browser tests under `apps/debug-frontend/src/**/*.browser.tsx`

   Work:
   - Replace `connectDaemonEvents` with a WebSocket client that owns one socket per mounted frontend instance.
   - Maintain connection state, subscriptions, request correlation, reconnect backoff, and resubscribe-on-open.
   - Feed daemon events into the existing debug/session store.
   - Update external annotation and agent job hooks to subscribe through the hub instead of constructing `EventSource`.
   - On reconnect, fetch/apply snapshots before applying new deltas.
   - Remove runtime EventSource usage for daemon events, external annotations, and agent jobs.
   - Keep the daemon shell's fetch URL rewrite shim for session-scoped API calls.
   - Remove only the EventSource URL rewrite portion of the daemon shell injection after daemon events, external annotations, and agent jobs no longer use EventSource.

   Verification:
   - Unit tests cover reconnect, resubscribe, snapshot-before-delta ordering, and malformed message handling.
   - Browser tests stub `WebSocket` and assert one connection is created while multiple session subscriptions are active.
   - Browser tests assert `EventSource` is not constructed for daemon events, external annotations, or agent jobs.

6. Update debug harness and developer docs.

   Touch:
   - `apps/debug-tui/src/daemon/client.ts`
   - `apps/debug-tui/src/scenarios/run-scenario.ts`
   - `apps/debug-frontend/README.md`
   - `apps/debug-tui/README.md`
   - `AGENTS.md`
   - `CLAUDE.md`
   - Marketing/API docs that list `/daemon/events`, `/api/external-annotations/stream`, or `/api/agents/jobs/stream`

   Work:
   - Update debug TUI log publishing only if endpoint names change.
   - Update docs to describe the daemon WebSocket hub and the fact that snapshot/mutation HTTP endpoints remain.
   - Remove documentation that presents the old persistent SSE routes as active runtime APIs.

   Verification:
   - `rg "EventSource|text/event-stream|/daemon/events|external-annotations/stream|agents/jobs/stream"` should only show AI query streaming, historical notes, or tests that intentionally assert old routes are gone.

## Full Verification

- `bun test packages/shared/daemon-protocol.test.ts`
- `bun test packages/server/daemon/server.test.ts packages/server/daemon/runtime.test.ts`
- `bun test packages/server/external-annotations.test.ts`
- Agent job handler tests added or expanded for WebSocket publication.
- `bun run check:debug-frontend`
- `bun run --cwd apps/debug-frontend test:browser`
- `bun run typecheck`
- `bun run build:hook`
- Manual: run `bun run dev:debug-stack`, start multiple simulator sessions, verify the frontend maintains one WebSocket connection while daemon, external annotation, and agent job events update live.

## Risks And Open Questions

- The hardest part is not the WebSocket upgrade itself; it is lifting per-session event producers into the daemon hub without leaking session internals or creating cross-session event bleed.
- Browser WebSocket constructors cannot set arbitrary Authorization headers. The browser path should rely on the existing daemon auth cookie set during URL bootstrap; non-browser tooling can use token-bearing URLs or headers where available.
- Removing SSE immediately means any lingering direct frontend code path that still expects `EventSource` must be migrated in the same change. The verification grep should be treated as a release gate.
- AI query token streaming is intentionally excluded. If we later want AI tokens on the hub, that should be a separate goal because it changes request lifecycle and backpressure behavior.
