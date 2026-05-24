# Session Persistence — Design Decisions

Tracking decisions made during PR #770 review and triage (2026-05-23).

## Decision 1: Remove persistence from code review

**Status:** Decided

Code review persistence (awaiting-resubmission + session matching + content refresh) is being removed. The plan review persistence model doesn't fit code review.

**Why:** Plan persistence is "same document, new version" — the agent revises a plan and the user reviews the revision in context. Code review is different — a diff is a snapshot of file changes. When the agent modifies code based on feedback, it produces an entirely new diff. Keeping the same session and "refreshing" it conflates two separate review rounds.

**What changes:**
- Review sessions complete normally on feedback (one-shot decision, not a cycle)
- Session stays alive in the browser after feedback is sent (not completed/closed)
- Annotations flush when feedback is sent
- The session becomes a live review workspace, not part of a decision loop

**Open question: what happens when diffs change?**

After feedback is sent, the agent makes code changes. The files on disk change. The user may want to see the updated diff. Options under consideration:

- **A.** Session becomes read-only after feedback. User runs `/plannotator-review` again for a fresh review. (Simplest, but friction.)
- **B.** Session has a "Refresh Diff" button. User pulls the latest diff on demand. Can annotate and send feedback again — but the agent isn't listening. Subsequent feedback needs a delivery mechanism. (Middle ground.)
- **C.** Session stays live and pushes feedback directly into the agent conversation via hook system, like external annotations. (Most ambitious, agent doesn't need to explicitly trigger review.)

**Open question: where does subsequent feedback go?**

Once the first feedback resolves the decision promise and the agent unblocks, there's no listener for more feedback. If the session stays alive and the user sends again:
- Write to a file the agent picks up?
- Push into the conversation via hooks?
- Just don't allow — one feedback per agent invocation?

---

## Decision 2: "Feedback sent" state should be calm, not loading

**Status:** Decided

After sending feedback (plan or code review), the UI should NOT show a spinner or "waiting" state. The session should feel settled — like archive mode. The user's annotations were sent. The plan/diff is still readable. The user can scroll, review what they wrote.

If a new version arrives (plan resubmission), the content refreshes and the session comes back to life.

**What this means for the current code:**
- Replace the amber spinner `CompletionBanner` awaiting variant with a calm "Feedback sent" banner
- Don't disable buttons during awaiting — the session is readable, not blocked
- The `onCancel` escape hatch becomes less urgent since the user isn't trapped behind a spinner

---

## Decision 3: Fix the hot loop for frontend-originated sessions

**Status:** Decided — will fix

When a session is created from the Plannotator dashboard (origin: `"plannotator-frontend"`), `resolveAndCycle` resolves the promise but doesn't start a new cycle. The `registerPersistentDecision` loop then spins on the already-resolved promise. Each iteration is a no-op (suspend guard catches it), but it burns CPU.

**Fix:** In `registerPersistentDecision`, if `suspend()` returns a record with status !== `"awaiting-resubmission"`, break the loop and complete.

---

## Decision 4: Clear external annotations on review resubmission

**Status:** Decided — will fix

`handleUpdateContent` in review.ts swaps the patch but keeps stale external annotations (lint results, agent comments) from the previous diff. Line numbers and file paths may no longer match.

**Fix:** Call `externalAnnotations.clear()` inside `handleUpdateContent`.

*Note: If we remove persistence from code review (Decision 1), this becomes moot — there's no resubmission path. Keeping this noted in case we preserve any refresh mechanism.*

---

## Decision 5: Wire the cancel escape hatch

**Status:** Deferred — depends on Decision 2

If the awaiting state becomes calm/archive-like (Decision 2), the urgency drops. The user isn't stuck behind a spinner. But we still need to handle session expiry gracefully — when the 10-minute TTL fires server-side, the frontend should know.

**Options:**
- Subscribe to `session-updated` daemon events (the expiry event family)
- Client-side timeout that matches server TTL
- Just let the session sit — user navigates away naturally

---

## Bugs confirmed from external review (PR #770)

| # | Finding | Severity | Action |
|---|---------|----------|--------|
| 1-2 | Frontend sessions spin in registerPersistentDecision | P1 | Fix (Decision 3) |
| 3+9 | --render-html resubmission shows stale content | P2 | Skip — narrow edge case |
| 4 | OpenCode folder annotation mislabeled after persistence | nit | Skip — cosmetic |
| 5 | Stale external annotations after review resubmission | P2 | Fix (Decision 4), possibly moot after Decision 1 |
| 6 | waitForResult doesn't short-circuit on awaiting | P2 | Skip — current behavior is correct |
| 7-8 | Actions not disabled during awaiting | P2 | Redesign (Decision 2 — calm state, not disabled) |
| 10 | onCancel never wired, stuck spinner | nit | Deferred (Decision 5) |
