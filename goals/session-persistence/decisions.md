# Session Persistence — Design Decisions

Tracking decisions made during PR #770 review and triage (2026-05-23).

---

## Product Facts

### Annotate Mode

- A user can annotate a document.
- A user can annotate a URL.
- A user can annotate a folder.
- A user can annotate any of the above asynchronously across multiple docs/agents.
- A user can submit/flush annotations through to the agent.
- An agent can, but may not, create new versions of the document.
- If an agent does, a user should be notified.
- Agent revisions may change the state of a document. If it does, a user is notified.
- The user should be able to see those new document versions. Diff mode should allow them to see previous.
- Annotation mode has a gating process, by default it is not used. If it is used, we should assume the agent will iterate with the user until an approval.
- The gating process is similar to the planning flow.
- If an agent gates a document the user already has open, the gate buttons would appear.
- Otherwise, the normal button set appears.

### Code Review Mode

- A code review session can be associated with a project (local dir) or GitHub PR or GitLab MR.
- In local mode, there is the possibility of the diffs changing under the session.
- When I review code, I can make annotations.
- I want to send/flush the annotations to the agent, or I can publish to GitHub/GitLab comments (if in PR mode).
- Code review no longer needs to end.
- If an agent session initiates a new code review session from same directory, ideally it would open in the existing session.
- But I would need to be notified of this.
- I would need to be notified if diffs change.
- In legacy tab mode, code review should show the full-screen completion overlay (countdown + close tab) after sending feedback, same as plan review. The inline banner is for embedded mode only.
- When a new diff arrives, files I've already viewed should stay hidden — unless the file actually changed in the new diff. Only show it again if the content is different.

### Cross-Cutting

- When a revision arrives (plan, annotate, or review), any external annotations (lint results, agent comments) from the previous version must be cleared. They reference old content with wrong positions.
- `waitForResult` must return immediately if the result is already available — for both `idle` and `awaiting-resubmission` sessions. No consistency gaps.
- Plan/annotate actions (Approve, Deny, Send Feedback) must be disabled while awaiting resubmission. The agent already has the feedback — submitting again against stale content is wrong. Code review already handles this (buttons hidden when idle).
- Late WebSocket subscribers (tab refresh during awaiting) should receive the current state. The snapshot provider for `session-revision` must return the latest content, not null.
- HTML and markdown annotation should go through the same functional pipeline. The `--render-html` path diverges from markdown in a way that `updateContent` can't reach. This is an architectural gap, not a quick fix.
- PR review sessions that get reactivated need updated PR metadata (head SHA, etc.). The current implementation serves the correct diff but posts platform actions against the stale commit. Needs a bigger fix to make PR metadata updatable inside the session closure.
- Annotate history slug is computed once from the initial heading and doesn't update if the heading changes. Acceptable — versions stay intact, just filed under the old name on disk.
- Session collisions across worktrees of the same repo are not a real concern. This is a local app — one daemon per machine.

---

## Decisions

### Decision 1: Code review sessions are long-lived

**Status:** Implemented

Code review sessions use a new `"idle"` daemon status. The flow:

```
agent → plannotator review (CLI opens, blocks) → session active
session → user annotates → sends feedback → submit (CLI closes)
session → idle (user can browse and annotate, but no submit buttons — nobody is listening)
agent → plannotator review again (CLI opens) → reactivates the idle session
(repeats indefinitely)
```

Key behaviors:
- After feedback: session transitions to `idle` via `store.idle()`. The HTTP handler stays alive, resources stay alive. The user can browse the diff and make annotations, but Send Feedback / Approve buttons are hidden (no agent to receive them).
- On reactivation: agent triggers `plannotator review` from the same directory/branch. The daemon finds the idle session by matchKey, pushes the new diff via `updateContent`, and calls `store.reactivate()`. The frontend receives a `session-revision` WebSocket event, updates the diff, and re-shows the submit buttons.
- Infinite cycle: this repeats as many times as needed. No counter, no limit.
- Cleanup: idle sessions use the original session TTL (hours, not the 10-minute awaiting TTL). They expire via normal TTL cleanup or daemon restart.

**Resolved questions:**
- Notification when diffs change: agent-triggered via `session-revision` event. No file watcher (user can manually switch diff type to refresh).
- Subsequent feedback without agent: not possible — submit buttons are hidden while idle.
- Cleanup: normal TTL expiry.

### Decision 2: Annotate sessions keep persistence

**Status:** Decided

Annotate mode is similar to plan mode. Agent revisions may change the document. The user should be notified and see new versions. Diff mode should show previous versions. The gating process (when used) iterates until approval, same as planning.

Persistence stays as-is for annotate. The awaiting-resubmission model fits because the document is an iterative artifact.

**Open question: folder annotation with multiple file changes.** Currently `updateContent` takes a single markdown string and the matchKey is `annotate:${filePath}` (the folder path). If the agent edits multiple files in the folder, we need a way to push per-file updates or trigger a re-fetch of the file list. Current design doesn't handle this.

### Decision 3: "Feedback sent" state should be calm, not loading

**Status:** Implemented (code review), pending (plan/annotate)

**Code review:** After sending feedback, the `CompletionBanner` shows a green checkmark with "Feedback sent / Your annotations were delivered to the agent." The banner persists until the agent reactivates (no auto-dismiss). Submit buttons disappear. The session stays browsable.

**Plan/annotate:** Still uses the amber spinner "Waiting for agent to revise..." variant. This should eventually be made calmer, but it's lower priority because plan/annotate persistence works correctly (agent WILL resubmit).

**What this means for the current code:**
- Code review uses `'feedback-sent'` CompletionBanner variant (green checkmark, not spinner)
- Plan/annotate still uses `'awaiting'` variant (amber spinner) — acceptable for now
- For plan/annotate: actions should be disabled until the revision arrives (the agent already has the feedback and is working — re-submitting before the revision arrives doesn't make sense)
- For code review: different model, TBD based on Decision 1

### Decision 4: Fix the hot loop for frontend-originated sessions

**Status:** Decided — will fix

When a session is created from the Plannotator dashboard (origin: `"plannotator-frontend"`), `resolveAndCycle` resolves the promise but doesn't start a new cycle. The `registerPersistentDecision` loop then spins on the already-resolved promise. Each iteration is a no-op (suspend guard catches it), but it burns CPU.

**Fix:** In `registerPersistentDecision`, if `suspend()` returns a record with status !== `"awaiting-resubmission"`, break the loop and complete.

### Decision 5: Clear external annotations on review resubmission

**Status:** Decided — will fix (if any refresh mechanism is kept for reviews)

`handleUpdateContent` in review.ts swaps the patch but keeps stale external annotations (lint results, agent comments) from the previous diff. Line numbers and file paths may no longer match.

**Fix:** Call `externalAnnotations.clear()` inside `handleUpdateContent`.

*May become moot depending on how Decision 1's refresh mechanism works.*

### Decision 6: Cancel / session expiry handling

**Status:** Deferred — depends on Decision 3

If the feedback-sent state is calm (Decision 3), the user isn't trapped. But we still need to handle session expiry gracefully for plan/annotate — when the 10-minute TTL fires server-side, the frontend should know.

For code review (Decision 1), sessions live indefinitely, so expiry is a different question (idle cleanup, not agent-didn't-resubmit).

---

## Open Items

| Item | Severity | Status |
|------|----------|--------|
| External annotations not cleared on revision (all surfaces) | P2 | Must fix — stale line numbers |
| Plan/annotate actions not disabled during awaiting | P2 | Must fix — stale content submission |
| `waitForResult` missing `awaiting-resubmission` short-circuit | P2 | Must fix — consistency with idle |
| `session-revision` snapshot provider returns null | P2 | Must fix — tab refresh during awaiting loses content |
| `registerPersistentDecision` hot loop for non-agent origins | P1 | Must fix — currently unreachable but latent |
| `--render-html` resubmission shows stale HTML | P2 | Deferred — architectural gap (HTML/markdown pipeline divergence) |
| PR reviews keep stale metadata on reuse | P1 | Deferred — needs PR metadata updatable in session closure |
| `onCancel` never wired on awaiting banner | nit | Deferred (Decision 6) |
| Session collisions across same-repo worktrees | nit | Not a concern — local app, one daemon per machine |
| Annotate slug doesn't update on heading change | nit | Accepted — cosmetic, versions work correctly |
| `sessionRefs` lazy cleanup | nit | Accepted — negligible memory |
