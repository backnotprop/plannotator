# Session Persistence — What You Need To Know

## The User Experience

### Before

You review a plan. You leave annotations. You click Deny. Your feedback gets sent to the agent. The session dies. Completion screen. Done.

The agent reads your feedback, revises the plan, and submits again. A completely new session appears — new tab or new sidebar entry. No connection to the one you just closed. No awareness that this is a revision of the same plan. You start from scratch every time.

Same story for code review and annotate. Send feedback, session dies, agent makes changes, new session. Every deny-resubmit cycle is a fresh start.

### After

You deny a plan. Instead of the completion screen, you see: **"Feedback sent — waiting for agent to revise..."** The session stays alive. Your browser tab stays open. The sidebar shows a pulsing amber indicator.

The agent revises the plan and submits again. The **same session** updates in place. You see the new plan with a diff showing what changed. Your annotations are cleared (the agent already has them). You review the fresh version. Approve or deny again. Repeat until you're satisfied.

This works for all three session types:
- **Plan review** — agent revises the plan, session updates with plan diff
- **Code review** — agent makes code changes, session refreshes with new diff
- **Annotate** — agent edits the file, session refreshes with updated content

### What stays the same

- Approve works exactly as before
- Exit works exactly as before
- Auto-close works exactly as before
- Sessions opened without an agent (standalone, demo) behave exactly as before — deny is still final
- The session expires after 10 minutes if the agent doesn't resubmit

---

## Why This Was Needed

Users and community members repeatedly asked for this. The linear "deny → wait → new session" flow was friction-heavy. Every cycle required the user to re-orient: find the new session, remember what they asked for, compare mentally against the previous version. The plan diff system already existed but couldn't show diffs across sessions — only within a session's version history.

The deny-resubmit cycle is the core feedback loop of plan-driven development. Making it seamless makes the entire product more useful.

---

## Technical Overview

### New Session Status: `awaiting-resubmission`

A non-terminal status in the daemon session lifecycle. The session stays alive — its HTTP handler keeps serving requests, the WebSocket connection stays open, and the frontend connection persists. After 10 minutes without resubmission, the session expires normally.

```
active → awaiting-resubmission → active → completed
                ↓
              expired (10 min TTL)
```

### Decision Cycle Model

Each server (plan, annotate, review) previously used a one-shot promise for the user's decision. Now they use a **cycle model**: each deny resolves the current cycle and starts a new one. The approve/exit path resolves the cycle as final.

Shared helper in `packages/server/session-handler.ts`:
- `createDecisionCycle<T>()` — creates a resolvable cycle with `promise()`, `resolve()`, `startNew()`
- `resolveAndCycle(cycle, result, origin)` — resolves current cycle, starts new one if agent-originated, returns `{ awaitingResubmission: true }` flag

### Session Matching

When the agent resubmits, the daemon matches the new request to the existing suspended session using a **match key**:

| Session Type | Match Key | Example |
|-------------|-----------|---------|
| Plan | `plan:${project}:${slug}` | `plan:plannotator:implementation-plan-2026-05-22` |
| Code Review | `review:${project}:${branch}` or `review:${prUrl}` | `review:plannotator:feat/session-persistence` |
| Annotate | `annotate:${filePath}` | `annotate:/path/to/README.md` |

If a match is found: the session's `updateContent` method pushes new content, the store reactivates the session, and a `session-revision` WebSocket event notifies the frontend.

If no match (different slug, different branch, different file): a new session is created as before.

### Content Update

Each server exposes a `handleUpdateContent` function that:
- Replaces the content in the server's closure (plan text, diff patch, markdown)
- Resets draft state
- Publishes a `session-revision` event to the frontend

### Frontend

All three surfaces (plan review, code review, annotate) handle the `awaitingResubmission` response from their feedback endpoints. When received:
- Show the "Feedback sent — waiting for agent to revise..." banner
- Subscribe to `session-revision` WebSocket events
- On revision: refresh content, clear annotations, reset awaiting state

### CLI

The CLI binary accepts `awaiting-resubmission` as a valid non-error status. It outputs the denial feedback and exits with code 0 — the agent reads the feedback and replans, same as always. The matching happens server-side; the agent doesn't know about session persistence.

---

## Files Changed

| File | What changed |
|------|-------------|
| `packages/shared/daemon-protocol.ts` | New `awaiting-resubmission` status, `session-revision` event family, protocol v2 |
| `packages/server/session-handler.ts` | `createDecisionCycle<T>()` and `resolveAndCycle()` shared helpers |
| `packages/server/daemon/session-store.ts` | `suspend()`, `reactivate()` methods, `matchKey` field |
| `packages/server/daemon/session-factory.ts` | `createDecisionScope`, `registerPersistentDecision`, `findAwaitingSession`, matching + reactivation for all three types |
| `packages/server/daemon/server.ts` | Skip deletion timer for awaiting-resubmission sessions |
| `packages/server/index.ts` | Cycle model, `handleUpdateContent`, slug/getSnapshot on session |
| `packages/server/annotate.ts` | Cycle model, `handleUpdateContent` for file-based modes |
| `packages/server/review.ts` | Cycle model, `handleUpdateContent(rawPatch, gitRef)` |
| `apps/hook/server/index.ts` | Accept `awaiting-resubmission` status (exit 0, not error) |
| `packages/plannotator-plan-review/App.tsx` | `awaitingResubmission` state, deny handler check, `session-revision` subscription |
| `packages/plannotator-code-review/App.tsx` | Same as plan review, adapted for diff refresh |
| `packages/ui/components/CompletionBanner.tsx` | `awaiting` variant with spinner and cancel button |
| `AGENTS.md` | Documentation for new status, event family, resubmission flow |

---

## What Does NOT Persist

- **URL-based annotations** — the source URL might change, can't refresh
- **"Annotate last message" sessions** — ephemeral, no persistent source
- **Archive sessions** — read-only, no feedback cycle
- **Goal setup sessions** — one-shot Q&A, not a review cycle
- **Standalone/demo sessions** — no agent to resubmit

---

## Recap

1. Denied sessions stay alive instead of dying
2. The agent resubmits → same session updates in place
3. Works for plan, code review, and file-based annotate
4. Matching is by project+slug (plan), project+branch (review), or filepath (annotate)
5. 10-minute timeout if the agent doesn't come back
6. Agent doesn't need to know — matching is server-side
7. Shared `createDecisionCycle` helper eliminates duplication across three servers
8. Frontend shows amber "waiting" banner with cancel option
9. No changes to approve, exit, or standalone flows

---

## Quiz

**1.** What happens to a denied session's HTTP handler?
> It stays alive. `suspend()` does NOT call `disposeResources()` or clear `handleRequest`.

**2.** How does the daemon know a new plan submission is a revision of an existing session?
> It computes a match key (`plan:${project}:${slug}`) and searches for an `awaiting-resubmission` session with the same key.

**3.** What happens if the agent changes the plan's heading when resubmitting?
> Different heading → different slug → no match → new session. The old session expires after 10 minutes.

**4.** Does the agent need to track session IDs or know about persistence?
> No. The CLI binary runs fresh each time. Matching is entirely server-side.

**5.** What's the difference between `suspend()` and `complete()`?
> `complete()` sets terminal status, disposes resources, clears the HTTP handler. `suspend()` sets `awaiting-resubmission`, resolves waiters (so the CLI gets feedback), but keeps everything alive.

**6.** How does the frontend know the content changed?
> A `session-revision` WebSocket event carrying the new content. The frontend subscribes when `awaitingResubmission` is true.

**7.** What happens to a URL annotation session when denied?
> It completes normally (no persistence). URL sources can't be refreshed, so no match key is set.

**8.** How long does the session wait for the agent to resubmit?
> 10 minutes. Then it expires via `cleanupExpired()`.
