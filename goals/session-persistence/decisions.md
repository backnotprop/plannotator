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

### Architecture

- The `plannotator` binary is the only server. There is one server, one frontend, many entry points.
- The daemon starts on install and is always running. Every CLI command assumes a daemon exists and talks to it. No lazy startup, no fallback to local file reads. If the daemon isn't there, it's a bug in the install — not something the CLI works around.
- The binary either starts a daemon or connects to one already running. The daemon serves the frontend. That's it.
- Claude Code calls the binary directly via hooks. OpenCode, Pi, Codex, Copilot, and Gemini CLI call it via thin extension/plugin wrappers that spawn the binary as a subprocess.
- Extensions and plugins have no server logic of their own. They translate "my host app wants to review a plan" into "shell out to the `plannotator` binary."
- The daemon server is the single source of truth for feedback prompt generation. When a user submits feedback (annotate, review), the server composes the final agent-ready prompt and returns it as `result.prompt`. Extensions and the CLI pipe it through — they do not rebuild or reformat the prompt. The only exception is plan mode prompts, which are host-specific (each extension has its own planning workflow).
- The new frontend (`apps/frontend/`) is the only UI going forward.

### Cross-Cutting

- Every annotate session lives forever once created — single file, folder, last message, URL. No one-shot sessions. The tab stays open and interactive after feedback is sent. There are no exceptions.
- Folder annotate sessions are reusable. If the user annotates the same folder twice, the daemon should find the existing session and reactivate it — not create a new one. The match key is the folder path. There's no content to update (it's a file browser), but the session is reused as-is.
- Annotate-last is not reusable — "last message" has no stable identity across invocations. Each annotate-last creates a new session. This is fine; the command is rarely run twice in a row.
- Annotate-last flow: caller captures the last assistant message → pipes it to the binary as `markdown` → the daemon holds the original message for the session lifetime → user annotates in the browser → server composes the final prompt including an excerpt of the original message → prompt returns through the CLI → back to the calling agent. The server always anchors annotate-last feedback to the original message because the conversation may have moved on by the time the user submits.
- Legacy tab mode is the only case where the tab closes after feedback — that's the full-screen overlay with countdown, and it's the expected legacy behavior.
- Sessions do not time out. A session, once created, lives until the daemon restarts. We do not kill sessions on a countdown. If a user submits feedback and the agent never comes back, that's for the user to see and decide — not for us to silently clean up.
- We should collect the right data (timestamps, feedback-sent-at, last-agent-contact) so we can eventually show the user: "you submitted feedback but it never came back." But that's a future UI concern, not a reason to expire sessions.
- When a revision arrives (plan, annotate, or review), any external annotations (lint results, agent comments) from the previous version must be cleared. They reference old content with wrong positions.
- `waitForResult` must return immediately if the result is already available — for both `idle` and `awaiting-resubmission` sessions. No consistency gaps.
- Plan/annotate actions (Approve, Deny, Send Feedback) must be disabled while awaiting resubmission. The agent already has the feedback — submitting again against stale content is wrong. Code review already handles this (buttons hidden when idle).
- Late WebSocket subscribers (tab refresh during awaiting) should receive the current state. The snapshot provider for `session-revision` must return the latest content, not null.
- HTML and markdown annotation should go through the same functional pipeline. The `--render-html` path diverges from markdown in a way that `updateContent` can't reach — `updateContent` must also update `rawHtml` for HTML sessions.
- PR review sessions that get reactivated need updated PR metadata (head SHA, etc.). The current implementation serves the correct diff but posts platform actions against the stale commit. Needs a bigger fix to make PR metadata updatable inside the session closure.
- Annotate history slug is computed once from the initial heading and doesn't update if the heading changes. Acceptable — versions stay intact, just filed under the old name on disk.
- The decision listener must stay alive after every user action — approve, deny, exit, send feedback. If the listener shuts down after approve/exit, the session looks alive but can't respond to future resubmissions. The agent hangs forever.
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
- Cleanup: idle sessions have no expiry. They live until daemon restart.

**Resolved questions:**
- Notification when diffs change: agent-triggered via `session-revision` event. No file watcher (user can manually switch diff type to refresh).
- Subsequent feedback without agent: not possible — submit buttons are hidden while idle.
- Cleanup: sessions persist until daemon restart (no TTL on non-terminal sessions).

### Decision 2: All annotate sessions are persistent

**Status:** Implemented

Every annotate session lives forever — single file, folder, URL, last message. No one-shot sessions. All annotate types use `registerPersistentDecision`, which never calls `store.complete()`. The session always suspends and the loop continues.

Single-file annotate is revisable: it has a matchKey, updateContent, and version history. The frontend shows "Waiting for agent to revise..." after feedback.

Folder annotate is reusable: it has a matchKey (`annotate:project:folder:path`) and updateContent. Running the same folder command reactivates the existing session. No content to push (it's a file browser), but the session reactivates and the frontend clears the "Feedback sent" state.

Annotate-last and URL annotate are non-reusable: no matchKey (no stable identity). The frontend shows "Feedback sent" after feedback. The session stays interactive — the user can keep browsing and send more feedback.

### Decision 3: "Feedback sent" state should be calm, not loading

**Status:** Implemented (code review), pending (plan/annotate)

**Code review:** After sending feedback, the `CompletionBanner` shows a green checkmark with "Feedback sent / Your annotations were delivered to the agent." The banner persists until the agent reactivates (no auto-dismiss). Submit buttons disappear. The session stays browsable.

**Plan/annotate:** Still uses the amber spinner "Waiting for agent to revise..." variant. This should eventually be made calmer, but it's lower priority because plan/annotate persistence works correctly (agent WILL resubmit).

**What this means for the current code:**
- Code review uses `'feedback-sent'` CompletionBanner variant (green checkmark, not spinner)
- Plan/annotate still uses `'awaiting'` variant (amber spinner) — acceptable for now
- For plan/annotate: actions should be disabled until the revision arrives (the agent already has the feedback and is working — re-submitting before the revision arrives doesn't make sense)
- For code review: different model, TBD based on Decision 1

### Decision 4: Hot loop prevention for non-agent origins

**Status:** Resolved

The `registerDecisionLoop` spin guard uses promise identity (`currentPromise === lastPromise`) to detect when no new cycle was started. When a non-agent origin calls `resolveAndCycle`, it resolves without calling `startNew()`, so the loop sees the same promise and exits cleanly. No hot loop.

### Decision 5: Clear external annotations on revision

**Status:** Implemented

All three `handleUpdateContent` functions (plan, annotate, review) call `externalAnnotations.clearAll()` before publishing the `session-revision` event.

### Decision 6: Session expiry

**Status:** Resolved — sessions don't expire

Non-terminal sessions (`awaiting-resubmission`, `idle`, `active` after first decision) have `expiresAt` deleted. `cleanupExpired()` skips them. Sessions live until daemon restart or explicit cancellation.

---

## Open Items

| Item | Severity | Status |
|------|----------|--------|
| External annotations not cleared on revision (all surfaces) | P2 | Fixed |
| Plan/annotate actions not disabled during awaiting | P2 | Fixed |
| `waitForResult` missing `awaiting-resubmission` short-circuit | P2 | Fixed |
| `session-revision` snapshot provider returns null | P2 | Fixed |
| `--render-html` resubmission shows stale HTML | P2 | Fixed — `handleUpdateContent` now accepts and updates `rawHtml` |
| PR reviews keep stale metadata on reuse | P1 | Deferred — needs PR metadata updatable in session closure |
| Gate flag not updated on resubmission | P2 | Deferred — if session was created ungated and agent resubmits with `--gate`, Approve button won't appear (user still sees Send Annotations + Close). Reverse also true: gated session stays gated even if agent resubmits without `--gate`. Fix: `updateContent` should accept and update the `gate` flag. |
| Provenance data for stale sessions | P3 | Deferred — collect timestamps (feedback-sent-at, last-agent-contact) so we can show "you submitted feedback but it never came back." Future UI concern. |
| `onCancel` never wired on awaiting banner | nit | Deferred |
| Session collisions across same-repo worktrees | nit | Accepted — local app, one daemon per machine |
| Annotate slug doesn't update on heading change | nit | Accepted — cosmetic, versions work correctly |
| VS Code editor annotations not cleared on revision | P2 | Fixed — `editorAnnotations.clearAll()` added to `handleUpdateContent` in plan and review servers |
| PR diff scope/baseline not reset on reuse | P2 | Deferred — part of the broader PR metadata staleness issue. `originalPRPatch`, `currentPRDiffScope` not updated in `handleUpdateContent`. |
| Remote share link stale on session reuse | P2 | Fixed — all three reuse paths regenerate `remoteShare` before returning the record |
| `sessionRefs` lazy cleanup | nit | Accepted — negligible memory |
