## Plan Review Flow

```
Claude calls ExitPlanMode
        ↓
PermissionRequest hook fires
        ↓
Bun server reads plan from stdin JSON (tool_input.plan)
        ↓
Server starts on random port, opens browser
        ↓
User reviews plan, optionally adds annotations
        ↓
Approve → stdout: {"hookSpecificOutput":{"decision":{"behavior":"allow"}}}
Deny    → stdout: {"hookSpecificOutput":{"decision":{"behavior":"deny","message":"..."}}}
```

### Pi plan review does not block

On Pi, `plannotator_submit_plan` returns as soon as the review server is up
("submitted for review … end your turn and wait", `terminate: true`) instead of
holding the tool call until the reviewer decides, so the session stays usable
during review and "Ask this session" works there. The decision is delivered
later by `deliverPlanDecision` (`apps/pi-extension/index.ts`) as a
`pi.sendUserMessage(..., { deliverAs: "followUp" })`, the same delivery review
and annotate feedback use: approval switches to the executing phase first
(tools, model, `plannotator-execute` entry) and sends the approved /
approved-with-notes prompt, which starts the execution turn and its framing;
deny and answers-only send `composePlanDeniedMessage`; external execution mode
hands off and records a non-triggering `plannotator-handoff` message. Nothing
is implemented before approval because the phase stays `planning` while the
review is open, so the planning write gate still holds. The open review is
closed (and its decision dropped) when plan mode is left, when a `/tree` path is
not planning, and on `session_shutdown`; a plan decision is never re-targeted to
a replacement session. The Esc-aborts-the-review behavior of the old blocking
tool is gone: leaving plan mode is how to abandon a review. Closing it first
calls the plan server's in-process `closeKeepingDraft()` (never reachable over
HTTP, where a plan review stays unclosable): open tabs get the `session-closed`
event with `by: "session"` (the tab shows "Review Closed", not "Closed by the
Agent", which stays for `by: "agent"` host closes), and a late approve/deny
answers `409`. The saved draft survives the close, but the server stops right
after, so the last unsaved keystrokes (the draft autosave's debounce window)
may be lost. The same close runs when planning ended while a review was still
starting. Reviews opened through the `plannotator:request` event API
(`plannotator-events.ts`) deliberately do NOT close on `session_shutdown`: the
README promises `review-status` lets a caller recover across session restarts,
so a decision made in that tab after `/reload` is recorded for `review-status`
and never emitted (the replaced runtime's bus is gone). That status file is
written atomically (temp file + rename), and one that cannot be parsed is left
untouched (logged, the write skipped) rather than restarted from `{}`.
Decision listeners run on a microtask (`publishDecision` in `serverPlan.ts`),
because a replaced runtime's `pi.events.emit` throws Pi's stale-ctx error
synchronously and an escape inside the HTTP handler ends the Pi process
(#1864). In `plannotator-events.ts` the review-result emit, `request.respond`
and the status writes are each wrapped in try/catch; `index.ts`'s
`handoffApprovedPlan` emit is not wrapped itself: it runs either inside the
submit tool call (auto-approve, a live session) or behind
`deliverPlanDecision`'s liveness check inside a caught promise chain.

**Revisions while a review is open update the same tab**: a resubmission while a review is pending calls the Pi plan
server's `updatePlan`, which saves a new history version (slug from the revised
heading, `previousPlan` from that slug's prior version) and bumps a revision
counter. `/api/plan` carries `planRevision`; the plan editor polls
`/api/plan/revision` every 2s only when that field is present
(`packages/editor/hooks/usePlanRevisions.ts`) and loads the revision in place
through `applyEditedDocument` (annotations re-anchor by text, the diff base
re-seeds through `usePlanDiff`'s docKey). It waits while Edit Mode is open or
holds direct edits, or a linked document is open. Approve/deny bodies echo
`planRevision`, and the server answers `409 { code: "plan_revised" }` to a stale
one, so a reviewer cannot approve text the agent replaced; the tab then loads
the revision and the reviewer decides again. Both plan servers implement it (`updatePlan` on the
server result, `/api/plan/revision`, the 409) but advertise `planRevision` only
when the caller passes `planRevisions: true`; today only Pi's
`plannotator_submit_plan` and the Claude Code mod's `claude-mod-plan` do, so
classic Claude Code, OpenCode and the Pi event-API `plan-review` action keep a
tab that never polls and sends unchanged bodies.
A decision claims the review right after the revision check (before the note
integrations are awaited), so `updatePlan` refuses from then on; a Pi
resubmission that hits that refusal tells the agent to wait for the decision
instead of opening a second review. The tab also holds a revision while a
comment composer or annotation popover is open.

**Execution works from the approved text, not the file.** The Pi plan
server's approve decision carries `plan`, the exact text on screen when the
reviewer approved. `deliverPlanDecision` appends it to the approval message
under "## Approved plan", records it on the `plannotator-execute` entry
(`approvedPlan`), and executes from it: the checklist, the per-turn framing
and resume (`resyncPhaseFromSession`) read the snapshot instead of re-reading
the plan file, and checkmarks are written back to the file only while its
checklist still matches the approved one. If the file differs from the
approved text at approval, the message says so and tells the agent not to
execute the unreviewed edits (to keep them, the user returns to plan mode and
the agent resubmits). Auto-approved plans (no UI) keep the file as their
source.

### Pi: the `plannotator` tool

The extension registers the shared tool contract
(`packages/shared/plannotator-tool.ts`, vendored as
`generated/plannotator-tool.ts`) with `pi.registerTool`: name, description,
validation (`parsePlannotatorToolInput`), argument mapping and result text all
come from it, and `parameters` is `PLANNOTATOR_TOOL_INPUT_SCHEMA` itself
(plain JSON Schema, which Pi validates without a TypeBox Kind since 0.79.1,
the peer floor; `plannotator-tool.test.ts` runs the installed Pi's
`validateToolArguments` against it). `executionMode: "sequential"` (#1622: an
"edit, then open" batch opens the edited file).

**Registration and activation are decided once per session.** The tool is
OFF by default on Pi and registered only when the agent tool switch turns it on
(`PLANNOTATOR_AGENT_TOOL=1` / `{ "agentTool": true }`, `resolveAgentTool(...,
host)` read once when the extension instance loads; Pi builds a new instance
per session and per `/reload`). Inside Oh My Pi (`detectPiHost(pi)` in
`pi-host.ts` answers `oh-my-pi`) the host is `oh-my-pi` and the tool is ON by
default, because OMP lists an extension tool as one short `xd://plannotator`
line instead of sending its definition; `PLANNOTATOR_AGENT_TOOL=0` /
`{ "agentTool": false }` keep it out there. `setPiHost` records the host for
the extension's review servers, whose `serverConfig` then advertises
`agentToolHost: "oh-my-pi"`. `omp.test.ts` (opt-in, the real `omp`) proves the
default on, the one line and no tool-list entry. Off, nothing is registered and the slash
commands are unchanged. It is registered with
`defaultActive: false` (Pi 0.99+ then leaves it inactive; older Pi ignores the
key and activates every registered tool), and the first `session_start`
(`settleAgentToolActivation`) makes it active when `ctx.hasUI`, inactive in
print/JSON mode, before the session's first request, and never touches it
again. Plan mode's `setActiveTools` calls add and release only the tools they
own, so `plannotator` stays in the tool list (and the prompt prefix) through
planning, execution, completion, leaving plan mode, `/tree` and `/reload`:
`agent-tool-stability.test.ts` drives that whole lifecycle over a fake Pi that
models both activation rules and fails on any request without the tool or any
`setActiveTools` that flips it after the start; it also pins the registered
description/parameters to the shared constants, no `promptSnippet` /
`promptGuidelines` on any Plannotator tool, and no `systemPrompt` from
`before_agent_start`.

**The bundled knowledge skill is user-invoked only.** `vendor.sh` adds
`disable-model-invocation: true` to the vendored copy's frontmatter (the
source `apps/skills/core/plannotator` stays model-invocable for the installers
that ask, #1377), so an npm-only Pi install keeps the #842 promise of no
Plannotator skill in Pi's system prompt; `/skill:plannotator` still loads it,
and the model learns the tool from the tool's own description. A CLI install's
`~/.agents/skills` copy still wins when present (#1642) and carries the
installer's model-invocation choice.

**One launch path.** `/plannotator-review`, `/plannotator-annotate`,
`/plannotator-last` and the tool share `launchCodeReview` / `launchAnnotate` /
`launchLastMessage` in `apps/pi-extension/index.ts` (in-process server,
"Ask this session" bridge, decision as a `followUp` message). The commands
notify a launch error; the tool throws it, which Pi reports as an error
result. Tool differences: the annotate target is ONE argument, so the #1182
tolerant word split never runs on it (`tolerant: false`); an opened review
returns `plannotatorToolOpenedText` with `terminate: true`, so the turn ends
and the session is idle for Ask; a gated session the tool opened delivers a
bare Approve as a message (`deliverApproval`, the mod's rule). The tool's
`last` skips the assistant entry holding the calling tool call
(`isAssistantEntryForToolCall` in `assistant-message.ts`): Pi saves an
assistant message at message_end, before its tools run, so otherwise the
agent's own "opening it now" message would open, and would head the picker.
On one fixed port (remote mode or a single `PLANNOTATOR_PORT`, read from
`getServerPorts`) a second open is refused while any review is open
(`fixedPortBusyText` names it), because the new server would otherwise
self-preempt the open one silently. A list target opens ONE `annotate-bundle`
review through the same `launchAnnotate` the slash command uses: the list goes
to the shared `selectAnnotateTokenTarget` as pre-split tokens (paths with
spaces survive), only the `bundle` selection opens (a missing entry answers
`buildMissingAnnotateFilesMessage`; a folder, URL or bare name refuses, so the
tool never opens fewer files than named), `resolveAnnotateBundleFiles` checks
types and size, and the subject is `plannotatorBundleSubject` (`2 files:
spec.md, notes.md`) in the result, list, close and decision heading; feedback
names every file (`Files:` + `annotateBundleTargetText`). A session without
UI (print/JSON mode) never has the tool active (see above), and a call that
reaches it anyway is refused, since nothing could deliver the decision later.

**Sessions, list and close.** Every review the extension opens (tool,
commands, `plannotator_submit_plan`) is recorded in ONE process-wide registry
(`getProcessPiReviewRegistry` in `apps/pi-extension/plannotator-tool-host.ts`,
on `globalThis`) with a `pn-` id until its decision settles. Process-wide
because Pi builds a new extension instance on `/reload` and `/resume`, and a
per-instance map would forget the open reviews of a session that merely
reloaded. `list` and `close` see only entries whose owner is the calling ctx's
`sessionManager.getSessionId()`, so another session's reviews (including the
previous one after `/new`) are never in reach; the global `sessions/` registry
is never read. `unsent` and `decided` come from the server's
in-process `hostControl.status()`; `close` calls `hostControl.close()` (the
reviewer's Close marked `closedBy: "agent"`, draft kept, tab told), so it
works in remote mode too, where the HTTP endpoints are off. A review the agent
closed delivers nothing: its decision handler notifies "the agent closed …"
instead (user-facing notices name a last-message review "the agent's last
message"; agent-facing texts say "your last message"). Plan reviews are listed
as `Plan vN` (the history version, read from `updatePlan`'s no-op answer for
the same text, and from each revision) and never closed.
Review, annotate and last decisions (commands included) now start with
`plannotatorDecisionHeading` (`Plannotator: notes.md (pn-3f2a9c) — Feedback ·
2 comments.`); outcomes follow the mod: a code review that is not an approval
is `Changes requested` (` · N comments` when it carries annotations), and the
PR-platform status post, which the review server marks `platform: true`
(#1719, `classifyReviewOutcome` in `apps/pi-extension/review-outcome.ts`), is
`Review posted` (`PLANNOTATOR_OUTCOME_REVIEW_POSTED`, shared with OpenCode 2) and delivered verbatim, without the verification
suffix. Every review decision whose feedback has content is delivered,
zero annotations included (PR description, PR comment and editor notes ride
only in the feedback text); nothing is inferred from the annotation count.
Plan decisions are unchanged. Pi cannot take over an agent's
shell `plannotator` command: its `tool_call` event can only block a call, which
the model reads as an error, so the skill's "use the tool" line is what steers
it.

### Claude Code mod: non-blocking plan review, annotate, review and last

Where Claude Code runs hooks modules ("Claude Mods": function hooks, CLI only,
2.1.287+), the plugin's `hooks/hooks.json` also loads `apps/hook/hooks/mod/register.ts`
(`"modules": ["./mod/register.ts"]`). No Plannotator session then holds a tool
call open: the mod starts the CLI detached, returns at once, and delivers the
reviewer's decision later as a plugin turn (`$.prompt.submit`, read by Claude
as a message from the `plannotator` plugin). The UX spec is an
owner-reviewed draft (design record, not in this repo); its open questions
are not answered yet, and the conservative choices below are the ones taken.

**On by default; opt out with `PLANNOTATOR_CLAUDE_MOD=0` or `{ "claudeCodeMod": false }`.**
The owner's call: every Claude Code that runs hooks modules (current Claude Code
loads them even with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` unset) gets the
non-blocking flows, the `plannotator` tool and the Bash take-over of
agent-run `plannotator` commands (below). With the knob off `session.start` stops before doing
anything (no `$.command.register` or `$.tool.register`, no `$.env.set`, no
`$.store`, no process) and every other hook passes straight through with
`next(e)`, so the classic PermissionRequest hook and the `/plannotator-*`
skills run as they do without mods. See the env table row.

**Inert without mods.** Checked live: Claude Code 2.1.150 (no hooks modules)
validates and loads the plugin with the `modules` key, ignores it, and runs the
classic PermissionRequest command hook (the blocking review) exactly as before;
2.1.288 with modules on runs the mod and never reaches that command hook. The mod
also stands down by itself (every hook passes through) in `-p` / SDK sessions
(`isInteractive` false: a later plugin turn would have no session to land in)
and where `/bin/sh` is missing (Windows), leaving the classic hook and the
`/plannotator-*` skills in charge. A mods-capable Claude Code whose rollout
switch is off could not be reproduced locally; the engine only inserts modules
into the hook chain when they load, so it should behave like 2.1.150.

**Files.** `register.ts` holds every `$` call (`claude plugin validate` follows
`$` only through top-level functions and inline hooks) and builds a `Host` of
closures; `controller.ts` (`PlannotatorMod`) is the per-session state machine;
`launch.ts` (detached launcher, launch-directory layout, command table, copy),
`delivery.ts` (turn vs log, 12 KB inline limit), `plan.ts` (ExitPlanMode
decisions and deny copy), `turns.ts` and `bridge.ts` (Ask this session),
`shell-words.ts` (argument splitting), `tool.ts` (the `plannotator` tool contract, a copy of `packages/shared/plannotator-tool.ts`), `take-over.ts` (agent-run Bash `plannotator` commands answered through the tool), `inbox.ts` and `inbox-contract.ts` (the Plannotator Inbox connection, below; the contract a copy of `packages/shared/inbox/connection.ts`). The mod is self-contained: a plugin
installed from the marketplace is only `apps/hook/`, and a hooks module may
import only its own files.

**Detached launch.** `$.process.run` is one-shot (10 minutes at most) and a hook
has a 10 s budget of its own time, so the mod runs a tiny `/bin/sh` wrapper
(`LAUNCH_SCRIPT`) that starts `plannotator <subcommand> <args>` in the
background with stdin/stdout/stderr on files and returns in milliseconds. The
launch directory is `${PLANNOTATOR_DATA_DIR or ~/.plannotator}/claude-code-mod/<session id>/<launch id>/`:
`stdin`, `ready` (`PLANNOTATOR_READY_FILE`), `result.json`
(`PLANNOTATOR_HOST_RESULT_FILE`), `stdout`, `stderr`, `pid`, `exit` (written
after the CLI exits), `revision.json` + `.ack` (plan revisions),
`messages.json` (`PLANNOTATOR_HOST_MESSAGES_FILE`, `last`'s picker list),
`watcher.json` and `settled/by` (see "Two processes on one session" below) and
`feedback.md` (oversized feedback). Waiting inside a hook (for the ready file, a
revision ack) happens in a `$.process.run` shell loop (`waitForAny`), never a
`$.clock` wait, which would spend the hook's budget and let the engine run the
call on without the mod. Once a review is open, a 1 s `$.clock.every` timer
(the mod has no listener) reads `result.json`, notices an `exit` with no result
("the review server stopped … your draft is saved"), and every 15 s checks the
pid with `kill -0`. Open launches and a pending plan approval persist in
`$.store` and reattach on `session.start` for the same session id
(`--resume`, `--continue`, a restart; on 2.1.290 `--continue` keeps the session
id). The fork paths do NOT reattach: `--fork-session` and `/clear` start a new
session id, so the reviews stay with the old id and come back only when that
session is resumed (re-adopting them across a fork is a follow-up).
`session.start` does not fire for
`/clear` or an in-process resume (the process goes on under another session
id), so `session.end` disposes the instance (timer and bridges stop; nothing is
delivered into the next session) and the next hook that needs the mod makes a
new one for the current id, restoring that session's open reviews. The launch
directory is created owner-only (`umask 077`, `chmod 700`) before `stdin` is
written; once a decision is delivered its files are removed (`cleanupArgv`),
except `feedback.md`, which Claude reads afterwards. A launch whose server
crashed keeps its directory (its `stderr` explains why). Servers outlive Claude Code on purpose:
the wrapper ignores SIGHUP and starts the CLI under `nohup` (a closing terminal
otherwise took the server with it), so closing the terminal does not lose a
review; verified live, `claude --continue` reattached and delivered it.

*Two processes on one session.* `claude --continue` while the first process
still runs gives two Claude Code processes the same session id, and both
reattach the same launches. One of them watches each launch: `watcher.json` in
the launch directory is a lease (`{ owner, at, touchedAt }`, the owner a random
id per mod instance) renewed every 5 s. The process the person works in wins
it: restoring a launch, a prompt typed in that process (origin `composer`), a
slash command, Claude's `plannotator` tool and ExitPlanMode all touch that
process's launches and take the lease at once; a live holder keeps it against
an older or equal touch, and anyone takes it once it is 20 s old
(`LEASE_STALE_MS`: the holder exited, slept or hung). A disposed instance
(`session.end`) releases it at once. Only the watcher runs the bridge (so the
two never supersede each other) and delivers, re-reading the lease right
before it settles, so a decision follows the person within a tick. Plan
approvals live in `$.store` and every ExitPlanMode re-reads them, so an
approval received (or already used) by the other process is honored once;
ExitPlanMode and the tool also adopt this session's launches the other process
started, so a revision goes into the open review instead of opening a new one.
Delivery is claimed once per launch, whichever file settles it (`result.json`,
`exit` with an older CLI's stdout, or a dead `pid`): `claimArgv` makes the
launch's `settled/` directory (mkdir has exactly one winner) and writes the
claimant's id to `settled/by`, so a claimant whose process call timed out wins
again on the next tick, while every other process loses. A process that loses,
or finds a `settled/` claim naming someone else or the launch's `stdin` gone
(cleaned up after the other delivered), forgets the launch quietly, so its
status line no longer says "waiting for you". A per-launch in-flight flag keeps
the 1 s timer, which never waits for a slow check, from checking one launch
twice at once. Residual window: `$.prompt.submit` resolves only once Claude
is idle, so a claimed decision can wait for the whole of Claude's current turn,
and a process that quits or dies in that time takes the delivery with it
(nobody else delivers a claimed launch: the claimant may still be waiting to
deliver it, so a second delivery could never be ruled out). It is not lost
silently: the claimant keeps the launch's record in the store and renews its
lease while it waits, writes `settled/delivered` once `$.prompt.submit`
returns, and releases the lease at `session.end`. A restore of the session
(and any process that watched the launch and saw the claim) checks a claimed,
undelivered launch whose decision is still on disk: while its claimant's lease
is fresh it waits; once the lease is released or 60 s stale
(`UNDELIVERED_AFTER_MS`) it logs once, with a toast, "A decision for <subject>
arrived but wasn't delivered — it's saved in <dir>/result.json" (`stdout` for an
older CLI) and writes `settled/reported`, so it is said once.
`cleanupArgv` removes `stdin` first and keeps `settled/` while `feedback.md`
keeps the directory, so a claim made after cleanup started loses.
`persist` keeps this session's records it does not know (the other process
launched them) unless it settled them. After restore, off the session-start
path (5 s cap), the stored launch records older than a minute are pruned
(`pruneArgv`): any cleaned up (no `stdin`) or settled for good (`settled/`
marked delivered or reported, or with no decision on disk; a claimed,
undelivered decision stays for its session to report); for other
sessions, any whose server died without a decision (`kill -0` fails, no
`result.json`, no `exit`); and for other sessions older than 14 days
(`LAUNCH_EXPIRED_MS`, a session nobody resumed), any whose server is gone, decision
or not. A live server always keeps its record; this session's dead servers are
left to the timer, which reports them. The store is read again before the
write, so a record another process added meanwhile is kept.
The debug log (`PLANNOTATOR_MOD_DEBUG=1`) is appended (`debugAppendArgv`,
O_APPEND) with a per-process tag on every line, because rewriting the whole
file from each process's own buffer clobbered the other's lines and left NUL
bytes. Past 1 MiB it is rotated to `debug.log.1` under a lock
(`debug.log.rotating`, mkdir; one older than a minute is a dead writer's) with
the size checked again inside it, so two writers never rotate twice and move a
fresh log over the old one.

**Host result file (`PLANNOTATOR_HOST_RESULT_FILE`).** New CLI side channel
(`apps/hook/server/host-result.ts`), taken from the env at startup and scrubbed
like the bridge token: when a review, annotate, annotate-last or
`claude-mod-plan` session settles, the CLI writes ONE JSON record there
atomically (temp + rename): `{ v: 1, surface, decision, message, noop,
annotationCount?, platform?, withNotes?, approvedPlan?, permissionMode?,
documents?, target? }` (`documents`: a review of several files names each file with its
comment count, in review order).

**Decision targets.** Every decision a host delivers names its FULL target, as
the server that took the decision resolved it, never the words the agent typed
(a real report: a bare approval headed only `QUESTIONS.md` was acted on as an
earlier decision about a different `QUESTIONS.md`). The CLI writes `target`
(absolute file or folder path, URL, a bundle's files in order, the reviewed
directory, patch file or PR URL, the plan file; none for annotate-last) into
the host result record, the ready line (`ServerReadyMetadata.target`, set once
per process by `setServerReadyTarget`), the `--json` annotate record and the
`opencode-review` record (additive), and the `sessions/` registry
(`apps/hook/server/decision-target.ts`). Hosts put it on the line after the
heading (`plannotatorDecisionHeading(subject, id, outcome, target)` →
`Target: <path>` / `Targets:` + `- <path>` lines; `plannotatorTargetLines`), and
the tool's opened text carries the same line. The mod stores the target on its
`LaunchRecord` (from the ready line, else its own resolution of the words
against the session directory, for a CLI older than the field), names the
record's target when there is one, and logs a line when the two differ. Pi sets
it from its in-process resolution; the OpenCode bridge reads the ready line and
the JSON records, and uses the CLI's resolved path in its `File:` line too.
Same-named open reviews are told apart in headings, status and toasts by
`plannotatorDistinctSubjects` (shortest distinct path tail:
`releases-2026-10-04/QUESTIONS.md`). Plain CLI stdout ("The user approved.")
and the strict-gate record are unchanged. A code review's target is taken at DECISION time,
not at launch: both review servers put `target` on the decision (the active PR's URL after an
in-place `/api/pr-switch`, the workspace root, or the working tree the active diff reads), and the
CLI record, the `opencode-review` record and Pi use it (a static patch keeps the patch file the CLI
named); a decision about a different PR than the launch opened is headed with that PR
(`plannotatorDecisionSubject`). The mod's own fallback for an older CLI never guesses: only a URL or
PR URL, an absolute path, or a review with no words (the session directory) counts; a bare or
relative name, or review prose, gets no Target line rather than a confidently wrong one.
`message` is composed from the configured prompts exactly as other hosts do
(review: the CLI's own output; annotate: the file/message feedback and
approved-with-notes prompts OpenCode and Pi use; plan: `composePlanDeniedMessage`
/ the approved prompts), so the mod never re-implements prompts. Stdout is
unchanged for every caller. `noop` marks what never starts a turn: Done with
nothing to send, review LGTM, Close, a truly empty review submit (no feedback
text and no annotations), and a review posted straight to the PR platform
(`platform: true`, logged plus a `$.prompt.suggest` to address the comments).
**The platform post is marked explicitly, never inferred from zero
annotations:** the review editor puts only code comments in `annotations`, while
PR description comments, PR comment notes and VS Code editor comments ride only
in the feedback markdown, so a review made only of those has an empty
`annotations` and is ordinary feedback (delivered, `noop: false`,
`annotationCount: 0`, and given the request-changes suffix). The platform path's
status post sends `platform: true` in its `/api/feedback` body; both review
servers carry it onto the decision only when it is boolean `true`, and every
consumer decides on that flag: `reviewHostResult` (noop + `platform`),
`buildReviewOutput` (CLI stdout and `--json`, which Amp reads; the status line
gets no suffix), OpenCode's embedded `/plannotator-review`, the OpenCode CLI
bridge (`opencode-review` always emits `platform` as a boolean; a missing field
means an older CLI and falls back to the old `isPRMode` rule), Pi
(`classifyReviewOutcome`, `apps/pi-extension/review-outcome.ts`; the event API's
`code-review` result carries the same field). Client and server ship together
in each binary and package, so the flag is always present where it is needed.
The mod's `legacyResult` (an older CLI's stdout) never inferred the platform
post; there a status line arrives as a feedback turn, as before. The feedback
archive does not classify the platform post either: its decision comes from
`approved` and whether the body has content. Introduced in 0.28.0, where zero
annotations read as the platform post and the mod sent nothing (fixed 0.28.4;
the mod also guards records from those CLIs, see "Version skew").
An annotate Done with nothing to send still posts the legacy
zero-state sentence ("User reviewed the document and has no feedback.") as
`feedback`, because plain stdout, `--json` and the OpenCode/Pi consumers print
or deliver those bytes; the editor additionally marks that body
`nothingToSend: true`, which both annotate servers carry onto the decision only
alongside empty `annotations`/`codeAnnotations` (`isNothingToSendFeedbackBody`,
`packages/shared/annotate-decision.ts`), and `annotateHostResult` turns it into
a `noop` record. Every plugin host that turns a decision into an agent message
skips it the same way: Pi's
`classifyAnnotateOutcome` reads it as "Annotation closed (no feedback).", the
OpenCode embedded handlers (`commands.ts`) send no prompt (on OpenCode 1 the
command's own message still runs its one empty turn, the known OC1 limit; no
second turn is added), and the OpenCode CLI bridge (OpenCode 1 CLI runtime and
OpenCode 2 native commands) reads the additive `nothingToSend: true` the CLI
adds to its `--json` / `opencode-annotate-last` record in that case only, as do
the Amp plugin (`formatAnnotationFeedback`) and the Droid plugin
(`emitAnnotateDecision`), which also read `annotate --json`. Skill-run hosts
(the classic Claude Code skill, Codex, Gemini, Copilot, Vibe, Kiro) still hand
the model the plain-stdout sentence, which is the unchanged stdout contract. The
feedback archive still records a bare Done as `feedback` with the sentence.
Multi-message annotate-last merges SSE external (agent / WebMCP) comments into
the current message's entry (`mergeExternalsIntoMessageEntries`), so they reach
the exported feedback, the submit body and the nothing-to-send check. The mod's `legacyResult` recognizes the two zero-state
sentences printed by a CLI older than the result file (#1701). The submit
body's `annotations` carries every document's comments (folder sessions,
linked documents, every message in multi-message annotate-last;
`collectSubmittedAnnotations` in `packages/editor/feedbackDocuments.ts`), so
`annotationCount` matches the feedback text.

**Version skew.** The plugin installs from the repo's main branch and the
binary updates separately, so with the mod on by default it routinely runs
against an older CLI. Verified by running the real mod controller against the
released 0.27.25 and 0.27.10 binaries as processes:
- ExitPlanMode: an old CLI has no `claude-mod-plan` (0.27.11+ prints `Unknown
  command: claude-mod-plan`; older CLIs read the unknown subcommand as the
  classic hook and print `No plan content in hook event`), exit 1 within
  ~0.3 s. The mod recognizes either (`cliLacksModPlan` in `plan.ts`), lets the
  call through to Claude Code's own flow, where the plugin's classic
  PermissionRequest hook runs the familiar blocking review, logs ONE line
  telling the user to update the CLI, removes the launch directory, and sends
  every later ExitPlanMode straight to the classic flow without probing again.
  The flag lives on the mod instance, not in `$.store`, so a restart or
  `--resume` probes once more (and picks up a CLI updated in between). An old
  CLI that refuses only after the hook stopped waiting (15 s) is caught by the
  timer: same fallback, plus a plugin turn asking Claude to call ExitPlanMode
  again, since it was told a review was open. While the hook waits, the timer
  leaves the launch alone (`starting`), so only one of the two reports it. Any
  other startup failure also falls back, with the CLI's error logged. Plan
  review is therefore blocking, not broken.
- Review, annotate, last, the `plannotator` tool and taken-over Bash runs (the
  same launch as the tool): work. The old CLI writes
  the ready file (0.19.24+) and no result record; a decision that exits 0 is
  delivered from its stdout (`legacyResult` in `delivery.ts`), with the default
  review approval prompt read as an LGTM (logged, no turn) and the
  approved-with-notes prompt as "Approved with notes" (a user-customized
  approved prompt cannot be told apart and arrives as feedback). Close and an
  empty Done log only.
- Review platform flag (0.28.0 to 0.28.3 CLIs): those CLIs wrote `platform:
  true, noop: true` for ANY request-changes review with zero code annotations,
  so feedback made only of PR description, PR comment or editor comments would
  be logged and never delivered. The mod carries a narrow old-CLI guard
  (`misreadAsPlatformPost` in `delivery.ts`): a review record is treated as the
  real platform post only when its message is one of the editor's status lines
  (`isPlatformStatusLine`: `Pull request|Merge request approved|reviewed on …`
  or `Changes requested on …`, the shapes `statusMessage` in
  `packages/review-editor/App.tsx` builds); any other non-empty `platform`
  record is delivered as review feedback (without the request-changes suffix,
  which those CLIs never added to it). A fixed CLI sets `platform` only on the
  real status post, which always matches, so it never takes this path. If the
  editor's status-line wording changes, update the pattern and its test.
- `last`: the old CLI ignores `PLANNOTATOR_HOST_MESSAGES_FILE` and opens the
  newest message from stdin (no picker), though the command line still says
  "N messages, newest first".
- Ask this session: the old server answers `404` on `/api/ai/bridge/poll`, the
  mod's bridge stops, and Ask AI offers only its providers.
- A CLI before 0.19.24 writes no ready file: commands wait their full 45 s /
  15 s and say "Starting…", and decisions still arrive at exit.
- The tool's `list` and `close` (contract v2): a CLI without
  `/api/host/status` lists its reviews with `unsent: unknown`. `close` counts as
  closed ONLY a JSON answer with a numeric `unsentAnnotations`
  (`classifyHostCloseAnswer` in `controller.ts`): 0.24–0.28.3 answer a JSON
  `404` and 0.19.24–0.23.x (before the `/api/*` 404 guard, #748) their app page
  with `200 text/html`, and both read as "an older Plannotator", never as
  closed. A CURRENT CLI with host control turned off (remote mode) answers
  `404 { code: "host_control_disabled" }` instead, which the mod never TERMs:
  the close reports that the review runs in remote mode and should be closed
  from the tab. Only for an older CLI does the mod TERM the process
  (`STOP_SCRIPT`), and only if the launch's `result.json` / `exit` is still
  absent and the pid still names a `plannotator` process (`ps -o args=`);
  nothing answering on the port (a stale or reused pid after a reboot) is never
  signalled, and where `ps` cannot verify a pid (missing, as on Debian slim
  without procps, or without `-p`, as BusyBox's) the script signals nothing
  and the close says the review was left running. In every such case the close
  reports failure. After a TERM close, a decision record without `closedBy` (or an
  older CLI's exit 0) is the reviewer's and is delivered as usual. **Remaining
  window:** these CLIs publish a decision only after a 1.5 s post-decision
  sleep and nothing on their HTTP surface says a decision is pending, so a
  decision the reviewer makes in the ~1.5 s before the TERM is lost (and those
  CLIs had already deleted the draft on submit; the feedback archive record
  survives where it is on). A CLI with the endpoint has no such window: its
  close is refused with `409` once the reviewer decided.

**Commands.** `/plannotator-review`, `/plannotator-annotate` and
`/plannotator-last` keep their names (spec open question 7, conservative): when
the user's core skills hold the names (Claude Code refuses
`$.command.register` for a user skill's name), the mod's `command.run` hook
answers the skill's command itself, so the skill's blocking bang line never
runs; a name nobody holds is registered (`immediate: true`). Arguments are split
like the skill's shell line (`splitShellWords`: quotes and backslashes, no
expansion) and passed to the same CLI parsers (`review`, `annotate`; `last`
runs `annotate-last --stdin`, see the next paragraph). The command returns
"Opened <subject> in Plannotator · <url>" once the ready file appears (up to
45 s for review, 15 s otherwise), or the CLI's own startup error. Under the mod
the CLI's tolerant annotate handoff (several unresolvable words) is shown to
the user as that error, not handed to Claude.

**`last` and its message picker.** The classic path reads up to 25 recent
assistant messages from the transcript file and shows a picker (newest open by
default). The mod has no transcript file to hand over, so it builds the same
list from `$.session.messages()` (`recentAssistantTexts` in `launch.ts`: newest
first, at most 25, text-less rows skipped, consecutive assistant rows joined as
one response, the way the transcript path groups chunks by message id) and,
when there is more than one, writes `messages.json` `{ v: 1, messages:
[{ messageId, text }] }` and sets `PLANNOTATOR_HOST_MESSAGES_FILE` to it. stdin
still carries the newest text. `$.session.messages()` rows carry no id or
timestamp, so ids are derived from the text (`cc-` + 16 hex of its SHA-256, a
`-n` suffix for repeats), stable as newer messages arrive; there is no
timestamp. The CLI (`apps/hook/server/host-messages.ts`) honors the variable
only with `--stdin`, only for a `messages.json` under the data dir's
`claude-code-mod/`, takes it at startup and scrubs it from the env, and
validates fail-closed (v 1, 1..25 entries, string fields, unique ids, 2 MiB per
message, 8 MiB file); a malformed file is a startup error (exit 1). The mod
(`pickerFile`) budgets the SERIALIZED file, 256 KiB under that cap, because
JSON escaping inflates text (ESC becomes `\u001b`): older messages that do not
fit are left out, and when the newest alone does not fit no file is written
(stdin only). Why a
variable and not a flag: a CLI that predates it ignores the variable and opens
the stdin text exactly as before, while an unknown flag to `annotate-last` is
silently ignored (it would fall through to the transcript lookup) and a changed
`--stdin` payload would be shown as the message. Old mod + new CLI: no
variable, `--stdin` unchanged. With a picker the subject is "Claude's recent
messages" (status line, open text, the plugin turn's first line), since the
feedback may be about an older message; the feedback itself carries an excerpt
of each message it covers. What `$.session.messages()` returns is the engine's
live conversation: after `/rewind` that is the rewound conversation (inferred
from the API docs, not checked live), and after `/compact` only the
post-compaction messages, so the picker can be shorter there than on the
classic path, which falls back to the pre-compaction file.

**The `plannotator` tool (agent-initiated opens).** When the user tells Claude
"open this in plannotator", Claude used to run the CLI through Bash, which
blocks and gives Ask AI a separate AI. The mod registers a real tool instead:
`$.tool.register({ name: "plannotator", description, inputSchema })` at
`session.start`, right after the commands, and only when the mod is on (the
knob not turned off, an interactive session, `/bin/sh` present) and the agent tool
switch is on (on by default here; `PLANNOTATOR_AGENT_TOOL=0` / `{ "agentTool": false }` turn it off; `resolveAgentToolEnabled`
in `hooks/mod/enabled.ts`, read with the mod switch at the first `session.start`
of the process, never re-read); with either switch off, in `-p`/SDK runs and on
Windows nothing is registered and Claude keeps the CLI through the `plannotator`
skill. With only the agent tool off, the rest of the mod runs: the slash
commands, non-blocking ExitPlanMode, Ask this session, and the Bash take-over
below, which stays because it adds nothing to Claude's context (it changes only
what a `plannotator` command Claude already chose to run does). The engine names it `mcp__plannotator__plannotator`
(the register call returns the full name, which `register.ts` keeps) and serves
it through a loopback MCP server; the mod's `tool.call` hook answers every call
itself (`{ result }` / `{ deny }`), so no other hook or permission prompt runs
for it. Input: `{ action: "annotate" | "review" | "last", target?, gate?
(annotate only), options?: { base? (review --base), markdown? (annotate
--markdown) } }`, validated strictly (unknown keys, a target or base that would
read as a flag, control characters, a field the action does not take; a `false`
default is tolerated). The call becomes the words the slash command would carry
(`plannotatorToolArgs`, one argument per element, never re-split) and goes
through the SAME launch as the commands (`PlannotatorMod.open`: detached CLI,
result file, bridge token, session tag, cleanup), so Ask this session works and
the decision arrives later as a plugin turn. The tool result returns at once
("Opened <subject> in Plannotator: <url> … End your turn now and wait"); a bad
call or a CLI startup error is an error result. A gated tool session
(`gate: true`) is the one delivery difference: a bare Approve is submitted as a
turn (`deliverApproval` on the launch record), because Claude was told to wait
for the sign-off; the slash command's bare gated approval still only logs. Done
and Close send nothing, as for the commands. A subagent may call the tool (its
decision lands in the main session as a plugin turn), except `action: "last"`,
which is refused there because it reads the main session's transcript. The contract (name, schema,
description, validation, argument mapping, result text) lives once in
`packages/shared/plannotator-tool.ts` for every host; the mod keeps a byte-for-byte
copy of its CONTRACT section in `hooks/mod/tool.ts` and `tool.test.ts` fails
when they differ (edit the shared file, then paste). The core `plannotator`
skill carries one host-neutral line: use a `plannotator` tool when the agent has
one. Plan review stays on ExitPlanMode. Checked live on 2.1.288: the tool is DEFERRED behind tool
search (no `alwaysLoad` is possible through `$.tool.register`), so Claude sees
only its name until it searches; with the updated skill it searched and called
the tool for "open notes.md in plannotator", while a profile still holding the
older installed skill text loaded that skill and ran the CLI instead.

**Contract v2: session ids, `list` and `close` (agent sessions, 0.29).** Every
review the mod opens has a session id, `pn-` + the six hex digits that end its
launch id (`sessionIdOf` in `controller.ts`; unique among the session's open
launches). The tool result's first line is `Session: pn-3f2a9c`, and every
decision turn's first line names it (`plannotatorDecisionHeading`:
`Plannotator: notes.md (pn-3f2a9c) — Feedback · 3 comments.`); slash-command
output is unchanged. `action: "list"` reports the reviews opened in THIS Claude
session, by the tool or by the user's `/plannotator-*` commands (the launch
store is already per session id; the global `sessions/` registry is never
read): id, kind, subject, url, age, state and `unsent: N` from the server's
`GET /api/host/status` (`unknown` for an older CLI). `unsent` counts only the
reviewer's own draft comments (`countUnsentDraftComments`: entries without a
`source`, so review-agent, WebMCP and linter findings are not counted, plus
code review's PR description and PR comment notes).
`action: "close"` takes `session: "pn-…"` or `"all"` and calls
`POST /api/host/close` (see "Host session control" under Server API): the
reviewer's Close, marked `closedBy: "agent"`, with the draft KEPT and the open
tab told over the external-annotation SSE (`session-closed`, which the editor
and review app show as "Closed by the Agent" with the unsent count). The result
reports how many unsent comments stay saved as a draft. The copy promises no
restore beyond each surface's own draft key (`agentClosedSubtitle`: annotate
drafts come back for the same unchanged document, code review drafts for the
same changes; path-keyed annotate drafts are #1710). Nothing is delivered for
that review afterwards (the launch is marked `closedByAgent` and settles with
one log line), except a decision record WITHOUT `closedBy`, which is the
reviewer's and is delivered. Plan reviews are listed but never closed (`close
all` skips them, a plan id is refused). An id this session did not open is "not
found". Against an older CLI the mod falls back to `TERM` under the checks
described in "Version skew" above (`stopArgv`), which ends the server without a
decision and never deletes a draft. The contract also
accepts `target` as a list for annotate (validated, duplicates dropped, a
one-item list is the plain call): a review of several files (a bundle, see
"Several files in one review" under the Annotate Flow). `plannotatorToolArgs`
passes the paths as the CLI's arguments, one each, in order (a bare list entry
such as `README` is passed as `./README`, so a missing one fails the whole list
instead of being read as prose), and the session is
named `plannotatorBundleSubject` ("3 files: spec.md, mock.html, notes.md"), in
the opened text, the session list and the decision heading. The tool
description says "Pass a list as `target` to review several files together, in
the order you want them read." Version skew: a CLI that predates bundles answers
several paths with its ambiguity error WITHOUT the bundle hint line
(`isOlderCliBundleRefusal`, which compares against `PLANNOTATOR_BUNDLE_HINT_LINE`,
a copy of `ANNOTATE_BUNDLE_HINT` pinned equal by `annotate-target.test.ts`); the
mod then answers `PLANNOTATOR_TOOL_BUNDLE_UNAVAILABLE_TEXT` ("update Plannotator
to open several files at once") for the tool, and for `/plannotator-annotate`
when every word reads as a file path (`isSeveralFilePaths`). There is no
`reply` action: it was reserved for live comments and always errored, so it
was taken out of the schema; it comes back with the comment loop. (The design
record is not in this repo; what matters is written here.)

**Agent-run CLI commands are taken over (Bash).** Because the tool is deferred
and the skill also documents the CLI, Claude sometimes runs
`plannotator annotate x.html --gate --json` in Bash anyway; that blocked the
session and started a server with no bridge token, so Ask AI offered separate
SDK agents instead of "Ask this session". With the mod on, the `tool.call` hook
on the MAIN LOOP's `Bash` parses the command with the host-neutral
`plannotatorCommandToToolInput` (CONTRACT section of
`packages/shared/plannotator-tool.ts`, so it is in the mod's copy too) and, when
it returns a tool input, answers the call itself through the SAME `runTool` →
`open` launch the tool uses (`hooks/mod/take-over.ts`): the command never runs,
the Bash result is the Bash tool's own record `{ stdout: <the tool's opened
text>, stderr: "", interrupted: false }` (a startup error is a `deny`), and a
gated take-over delivers its bare approval as a turn exactly like a gated tool
call. A subagent's Bash command always runs as written: a subagent may work in
its own cwd or worktree, while the mod launches in the session's cwd, so its
`review` or `annotate notes.md` would open the wrong diff or file. Taken over: ONE simple command (no
`; & | < > ( )`, line break, `$`, backtick, unquoted glob/brace, comment, `~user`, unterminated
quote; quoting follows `splitShellWords`, nothing is expanded) whose program is
exactly `plannotator` (the binary on PATH; a path such as `./plannotator` or
`/tmp/dev/plannotator` is a dev build and runs for real), subcommand
`annotate` (one target, or several that all read as file paths, `looksLikeFilePath`: a separator, a leading `~` `.` `@`, or a file extension; they become `target: [...]`, a review of several files; plus `--gate`, `--markdown`), `review` (at most one target, `--base <ref>`),
or `annotate-last` / `last` (no arguments); `--json` is accepted and dropped
(the decision arrives as a message), and the result must pass
`parsePlannotatorToolInput`. Everything else runs as written: other
subcommands, every other flag (`--require-approval`, `--result-file`, `--hook`,
`--tailscale`, `--static`, `--app`, `--no-jina`, `--render-html`,
`--diff-type`, `--local`, `--patch-file`, `--stdin`, `--help`, ...), repeated
flags, several targets that are not all file paths (prose, which the CLI's
tolerant resolution reads) or several review targets, environment prefixes, and any compound command
(`cd x && plannotator ...`, pipes, redirects, substitutions), so scripted
strict gates keep the real CLI and its exit codes. With the mod off, in `-p`/SDK
runs and on Windows nothing is taken over. The CLI the mod launches runs in the
session's cwd (`$.process.run`'s default), the same as for the tool. Pi and
OpenCode do not take over shell runs: there an agent-run `plannotator` command
still runs the CLI (Pi registers the tool itself; see "Pi: the `plannotator`
tool").

**Plan review.** The `tool.call` hook on the main loop's ExitPlanMode resolves
the plan (the plan file when it is an absolute `.md` regular file within the
2 MB cap, else the inline `plan`: the #1667 rule), then:
1. no review open: starts `plannotator claude-mod-plan` (internal subcommand,
   `apps/hook/server/claude-mod-plan.ts`; stdin `{ plan, planFilePath,
   revisionFile }`; the plan server with `planRevisions: true`) and answers
   `{ deny }` with the waiting text (`waitingDenyText`). ExitPlanMode never runs,
   so plan mode stays on.
2. a review open: writes `revision.json` `{ seq, plan }`; the subcommand polls it
   every 500 ms, pushes it with `updatePlan` and acks; the deny text says
   "Plan vN replaced vN-1" (or, when a decision is already being recorded,
   to wait for it). Spec open question 2 resolved like Pi: revisions go into the
   same tab.
3. the plan's SHA-256 (trailing whitespace ignored) equals an approval's: the
   call passes (`next(e)`), and `classic.PermissionRequest` answers `allow`
   with `updatedInput.plan` = the approved text (#1670's "execute what was
   approved") and `setMode` to the reviewer's permission mode. Modules sit above
   the settings hooks in that chain, so the plugin's own PermissionRequest
   command hook never runs: no second review. A different plan opens a new
   review instead.
Decisions: deny and answers-only submit the denied / answered prompt; approval
submits the approved (or approved-with-notes) prompt plus
`PLAN_APPROVAL_NEXT_STEP` ("Call ExitPlanMode once more …"), the two-hop
approval of spec open question 1 (the one-hop `$.tool.call` path is untested).
The claim the subcommand records (`currentPlan` after each accepted revision) is
what `approvedPlan` carries. If the plan server cannot start, the call falls
back to Claude Code's own flow (and the classic hook). A subagent's
ExitPlanMode keeps the classic flow. Not built: the edit guard (spec: deny
Edit/Write while a plan is in review after the user leaves plan mode), the
`AbovePrompt` band with Send now / Hold, the `/plannotator` sessions pane, the
`UserMessage` / `ToolUse` render hooks, and `tab-closed` detection; a decision
is always sent (`$.prompt.submit` waits for idle; draft text in the composer
is left alone).

**Delivery.** Each decision is one plugin turn, in arrival order, prefixed
`Plannotator: <subject> — <outcome>.`; a message over 12 KB is written in full
to the launch's `feedback.md` and Claude is told to Read it (the feedback
archive may be off, so the mod writes its own copy). Status line
(`$.ui.status`): `<subject> · waiting for you` / `N open · …`; toasts for a plan
waiting or replaced and for feedback received; `$.ui.log` for no-op decisions,
stopped servers and reattachment.

**Session tag.** `session.start` sets `PLANNOTATOR_SESSION_TAG=claude-code:<session id>`
with `$.env.set`, so every process the session starts (Bash calls, hooks, the
detached servers) inherits it; `registerCliSession` records it as
`hostSession` in the `sessions/` registry, and `plannotator inbox mcp` sends
as this session (the `plannotator_inbox` tool's author, so the reply wakes it).
The tag follows `/clear` and an in-process resume: `currentMod` sets it again
for the new id, at the latest on the next `turn.start`.

**Ask this session.** Every launched server gets a 32-byte hex token
(`PLANNOTATOR_SESSION_BRIDGE_TOKEN`, `_HOST=claude-code`, `_MODES=turn`). Once
the ready file names the port, the timer starts `createBridge` (`bridge.ts`, the
pull-bridge client over `$.http.fetch` to `http://127.0.0.1:<port>`, no Origin):
an `ask` is submitted as a real turn (`$.prompt.submit`), identified at
`turn.start` by its header and last line (Claude Code frames a plugin prompt as
"The plannotator plugin sent a message: …", seen live), streamed back from
`turn.step` text/tool chunks, and finished from `turn.complete`'s `answer`.
`busy` = a turn is running (pushed on `turn.start` / `turn.complete`, not only
at the next poll); `interrupt` aborts the running turn (`$.turn.abort`);
cancel aborts our own turn, or, while it is still queued, confirms at once and
aborts its turn the moment it starts. Claude Code never raises a plugin's own hooks
for a prompt its code submitted (the debug log says "skipped: re-entry"), so the
mod's `prompt.submit` hook sees every OTHER prompt (the user's Enter, a
notification, another plugin); a turn whose text is exactly one of those is
never claimed, so a prompt the user typed can neither be streamed to
Plannotator nor aborted by a cancel, whatever it says. Another plugin's prompt
reaches `turn.start` inside the engine's "The <name> plugin sent a message:"
frame while `prompt.submit` saw it bare, so the match also strips that frame.
**Take-over** (`turns.ts`): a prompt typed or delivered while a turn runs fires
`prompt.submit` at Enter with that turn's `turnId`, and the engine folds it
into the turn's next model request. When that turn is our question's and the
origin is on an ALLOWLIST of messages the model must now answer (`composer`,
`bridge`, `slack-ping`, `channel`; never `peer` (owner's call: a peer
session's reply streaming into the panel is better than losing the reviewer's
answer), `task-notification`, `peer-send-message`, `scheduled-trigger`,
`observer*`, `coordinator`,
`projects-relay`, `auto-continuation`, `unclassified` or a kind added later),
streaming stops the moment the prompt reaches the mod's `prompt.submit` hook,
BEFORE `next(e)` runs the hooks beneath (a slow one cannot let the next step
through); the take-over is confirmed when `next(e)` resolves with the prompt,
and a prompt a hook beneath drops releases the hold. The step in flight was
requested before their prompt, so its output is held and released when the
question settles: at the turn's next `turn.step` (that request carries their
prompt) as `done` when the response before it ended the answer (`stop` chunk
`end_turn`, no tool call) and some answer text was shown, else as `taken_over`
(a thinking-only final response would otherwise settle an empty answer); or at `turn.complete` when no
step followed, as `done` with the turn's answer (their prompt then runs as a
turn of its own). The note reads "You typed into this session…" for
`composer` / `bridge` and the neutral "Another message entered this session…"
otherwise. From the take-over on, a cancel closes only the question and an
interrupt answers `ok: false`; Plannotator never aborts that turn. Plan review does not block the session
under the mod, so the status is never `blocked` and plan review gets real turns
too (verified live). Polls ask for 15 s (750 ms while our question streams, so
deltas flush), and stop for good on 401/403/404/405/503 (`404` = an older CLI
without the bridge), `closing`, or once the review settles. A loop that stops
because the server stopped answering (six failures in a row; `$.http.fetch`
gives up after 30 s, so a sleeping laptop or a paused server gets there in
about three minutes) is not the end: `run()` reports why it ended
(`BridgeEnd`), the controller clears the handle, and the timer starts a new
loop with the same token after 5 s, doubling to 60 s while the server stays
silent (`BRIDGE_RETRY_MS`), so Ask AI comes back once the server answers again.
A poll answered `superseded: true` (another client polled the server after us)
waits 10-15 s before polling again, instead of taking the server back at once
and starting a busy loop with the other client.

**The Plannotator Inbox (`plannotator_inbox` and the reply wake, `inbox.ts`).** Where `PLANNOTATOR_INBOX_TOOL` / `inboxTool` allows it at the first `session.start` (on by default here), `register.ts` reads the Inbox's tool list once (`discoverInboxTools`: `tools/list` on its `/mcp`; a stopped Inbox is described by the list it last answered with, kept in `$.store` as `inboxTools`; with neither, the list bundled with the mod, `INBOX_DEFAULT_TOOLS` in `inbox-default-tools.ts`, generated from a real Inbox by `bun run scripts/sync-mod-inbox-tools.ts` and pinned to one by `inbox-default-tools.test.ts`) and registers `plannotator_inbox` (`inboxAgentTool`), a SEPARATE tool, never actions on `plannotator`. So Claude Code has the tool before this computer ever ran the Inbox: the first call starts it. With no `inbox/inbox.json` the link stays silent: no HTTP request and no file (no lease, no claims folder) until a call starts the Inbox, and the wake polls from the next tick after. With the tool, `inbox/inbox.json` present at the first `session.start` (an Inbox has run here) and `inboxReminder` on (default), a `prompt.context` hook adds the `plannotatorInbox` block (`withInboxReminder`, the line naming the tool's registered full name) to the conversation's first message, once per conversation (see `inboxReminder` under Config-only settings). The session's `PlannotatorMod` owns an `InboxLink` (one per session id, so `/clear` and an in-process resume follow the new id: the old link is disposed at `session.end` and the next hook makes one for the new id). A call (`tool.call`, answered by the mod) re-reads the registry, checks health against its `serverSession`, starts a stopped Inbox with `plannotator inbox --background` (a one-shot that detaches the Inbox into its own session and waits for it; never a browser tab), and proxies to `/mcp` with `project_path` = `$.session.cwd()` (or the agent's optional `project_path`, resolved against it by `INBOX_PROJECT_DIR_SCRIPT` and refused before the Inbox is reached when it is not an existing folder) and `agent_session` = the host's real session id; `wait_for_reply` is held to 25 s through the tool (`$.http.fetch` gives up at 30 s). The wake: a 1 s `$.clock.every` tick long-polls `/api/inbox/bridge/poll` (20 s) with a 5 to 60 s backoff that never gives up; a reply waits in the mod until the session has been idle for two ticks (a pending `$.prompt.submit` cannot be withdrawn, so a prompt the person typed, or a `/clear`, queued during a turn goes first), is checked once more with the Inbox (an agent may have read it meanwhile), claimed once across processes (`INBOX_CLAIM_SCRIPT`: mkdir of `claude-code-mod/<session>/inbox/claims/<reply id>`), submitted (`inboxWakeText`), and acknowledged (`delivered`, retried until the Inbox answers). A prompt typed into the reply's own turn takes it over as Claude Code folds it in; the mod never aborts it and never delivers the reply again. Two processes on one session: the session's inbox lease (`claude-code-mod/<session>/inbox/watcher.json`, the rules of the review watcher lease: the person's last process wins, 20 s stale) picks the one that polls and delivers, and the claim makes a lease race harmless; a claimant writes `alive` while its turn waits, and a reply whose claimant stopped for 60 s without `delivered` is reported once with a toast (the only toast the connection raises); one marked `delivered` whose acknowledgement was lost is acknowledged by the other process. Nothing touches the system prompt; the tool list is fixed per process. Version skew: an Inbox without the bridge route (404) just leaves the poll backing off; an action the running Inbox lost answers "update Plannotator"; a `plannotator` without the `inbox` subcommand answers that the binary has no Inbox.

**Tests.** Bun: `apps/hook/hooks/mod/*.test.ts` (controller flows over an
in-memory `Host`, delivery, shell words, and `bridge.test.ts` against the REAL
server half `createPullSessionBridge`), `apps/hook/server/host-result.test.ts`,
`apps/hook/server/claude-mod-plan.test.ts` (the subcommand as a process:
revision → tab → approval carries the revised text; answers-only),
`apps/hook/server/host-messages.test.ts` (`annotate-last --stdin` as a process:
the messages file yields the picker, a malformed one exits 1, plain `--stdin`
unchanged). Engine
harness: `apps/hook/tests/register.test.ts` via `scripts/test-claude-code-mod.sh`
(stages the plugin without the CLI, whose bun tests `claude plugin test` would
otherwise try to load; bun skips `apps/hook/tests/` through `pathIgnorePatterns`).
Typecheck: `apps/hook/hooks/mod/tsconfig.json` (no DOM, no Node; `globals.d.ts`
declares the few web APIs a hooks module has). `PLANNOTATOR_MOD_DEBUG=1` writes
`claude-code-mod/debug.log` in the data dir. The Inbox connection is proved against a REAL Inbox in `apps/hook/hooks/mod/inbox.test.ts`: `plannotator inbox --background` under a temp data dir (the compiled binary when `PLANNOTATOR_INBOX_TEST_BINARY` names one, as `.github/workflows/inbox-claude-code.yml` runs it; the CLI from source otherwise) and the mod's own code on a Host of real processes, HTTP and files (`testing/claude-session.ts`, which simulates the conversation the way `register.ts` feeds it): with no registry the tool comes from the bundled list, nothing polls or writes, and the first call starts the Inbox and lands its message, after which the wake polls; the tool carries what the Inbox's `/mcp` offers, `send_message` lands a thread, the window's Send arrives once as a turn with the stable header and the reply verbatim (delivered, then replied), a typed prompt goes first and takes the reply's turn over, `/clear` follows the new id, two processes deliver once, and a dead Inbox is started by the first call with no browser tab. `INBOX_PROOF_DIR=<dir>` keeps a transcript per proof. The engine harness (`apps/hook/tests/register.test.ts`) covers the wiring with the engine's own `$`.

### OpenCode 2: the `plannotator` tool

The OpenCode 2 plugin (`apps/opencode-plugin/server.ts`, `registerPlannotatorTool`)
registers the same `plannotator` tool the Claude Code mod does, through
`ctx.tool.transform` → `tools.add`, with the shared contract itself
(`PLANNOTATOR_TOOL_NAME` / `_DESCRIPTION` / `_INPUT_SCHEMA` and
`parsePlannotatorToolInput` from `packages/shared/plannotator-tool.ts`, never a
copy; `plannotator-tool.test.ts` checks the registered schema IS the shared
object). It is OFF by default on OpenCode 2; turned on (`PLANNOTATOR_AGENT_TOOL=1`
/ `{ "agentTool": true }`, `resolveAgentTool(loadConfig(), process.env,
"opencode")`, read once at plugin setup; a change applies when OpenCode
restarts) it is registered for every workflow (`manual` included), and not at
all where the decision could never come back: a tool draft without `add` (an
older V2 host, probed inside the callback like the native commands' draft) or
a session domain without `prompt`. OpenCode 1 gets no tool in 0.29 (design
decision; its `plugin.tool` route is feasible).

**Open (annotate, review, last).** Each call runs the SAME launch the native
slash commands use (`runNativeCommand` → `handleCliCommand`: a `plannotator`
CLI child, the pull-bridge token so "Ask this session" works, the ready file,
the decision delivered later to the calling session with `session.prompt`),
and the tool returns as soon as the ready file names the url (up to 45 s for
review, 15 s otherwise, then the "starting" text): `Session: pn-…` plus
`plannotatorToolOpenedText`. A refused argument or the CLI's startup error is
the result text (`Plannotator could not start: …`; results are always text,
since the promise adapter turns a rejected `execute` into a defect). The
annotate target is passed as ONE argument (`toolLaunchRequest` builds
`ParsedAnnotateArgs` instead of re-parsing a string, so `my notes.md` stays one
path); review words are quoted for `parseReviewArgs`' string form
(`quoteReviewWord`). A gated tool session delivers its bare approval
(`Plannotator: notes.md (pn-…) — Approved.`), like the mod; a slash command's
bare gated approval still sends nothing. A list of files (two or more after the
contract drops duplicates) opens ONE bundle review through the same launch:
`handleCliCommand`'s `annotateBundle` passes each entry as its own CLI argument
in the agent's order (never re-split, and a single tool target is never read as
several words), the subject is `plannotatorBundleSubject` (`2 files: a.md,
b.html`) in the result, `list` and the decision heading, and the feedback is
framed under `Files: …` as the slash command's bundle is. An older CLI's
several-paths ambiguity error (`isOlderCliBundleRefusal`) makes the result
`PLANNOTATOR_TOOL_BUNDLE_UNAVAILABLE_TEXT`. When a launch
answered "starting" and its CLI then fails before the page opens, the session
gets one message (`plannotatorLateFailureText`: `Plannotator: notes.md (pn-…) —
Did not open.` plus the CLI's error), delivered with `session.prompt`
(`queue`), so neither the agent nor the person waits for a decision that never
comes; OpenCode 2's plugin context has no toast surface, so that transcript
message is the visible signal. A command that merely ends without a ready file
sends nothing (a CLI older than 0.19.24 writes none and delivers its decision
at exit). Subagents work as on the mod: a subagent's (child) session resolves
to its root session (`resolveRootSession` walks `parentID`), which owns the
review, gets its decision and lists or closes it; only `last` is refused from a
subagent (`PLANNOTATOR_TOOL_SUBAGENT_LAST_TEXT`, the mod's wording), since it
reads the main session's messages. Ask this session for such a review asks the
root session. Not verified live: delivery to the root while it still waits on
the subagent relies on `queue` delivery. A tool launch posts its session-URL
notice into the CALLING session (a subagent's own session, never the root that
receives the decision) and only while the tool call is still open
(`createV2BridgeClient`'s `notice: { sessionID, open }`, closed the moment
`runPlannotatorTool` answers), so the notice is always promoted inside the
caller's running turn; the tool's answer already carries the URL, and a server
that comes up after a "starting" answer posts no notice (the URL is in `list`
and the log). Posting it into the root was a leak (0.28.5 smoke, live on
2.0.22): a background subagent's root, or the parent of an API-created child
session, is idle, so the pending steer sat there and was promoted ALONE as a
model turn when the root next woke (the queued decision promotes one row at a
time), and the model answered "Plannotator session ready: <url>". With the
notice always inside a running turn, tool launches always queue their decision
(`alwaysQueue`; co-promotion is also only attempted for a notice in the
decision's own session), since the slash commands' co-promoting steer (#1515)
would push a late decision into a running turn. No
shell take-over: nothing in the OpenCode 2 plugin API can answer a shell call.

**Session ids, list and close.** `OpenCodeLaunchRegistry` (one per plugin
instance) records every review a session opens: tool calls, its slash commands
(`runNativeCommand` with `launches`), and its `submit_plan` review (listed,
never closable). Every recorded launch's decision message starts with
`plannotatorDecisionHeading` (`withDecisionHeading` in `cli-bridge.ts`), slash
commands included, so `list` and the decision name the same id. Its outcome
uses the mod's words: `Feedback · N comments`, `Approved with notes · N
comments`, `Approved`, and for code review (local or PR) `Changes requested ·
N comments`. The count comes from the CLI's additive `annotationCount` on the
`annotate --json`, `opencode-annotate-last` and `opencode-review` records (an
older CLI omits it and the heading has no count). A PR-platform status post
reads `Review posted` (`PLANNOTATOR_OUTCOME_REVIEW_POSTED`, the same words as Pi) and is decided by the record's `platform` flag (#1719;
`isPlatformPost`, falling back to `isPRMode` only for a CLI without the flag),
never inferred from zero annotations, so description-only PR feedback is
`Changes requested`. `list` and
`close` see only the calling OpenCode session's launches (never the global
`sessions/` registry; another session's id is "not found"). `list` reads
`GET /api/host/status` with the launch's token for `unsent` and `decided`
(`readHostStatusAnswer`; `unknown` for an older CLI). `close` posts
`POST /api/host/close` and reads the answer with `classifyHostCloseAnswer`
(`packages/shared/host-control.ts`, the mod's rule): closed (draft kept, the
tab told, nothing delivered, since the CLI's record is then `dismissed`),
decided (the reviewer's decision is on its way), refused, turned off (left
running; the text says remote mode only when the ready file did, and otherwise
names a server started without a host token), or not answering (left
running). `close all` skips plan reviews silently; only an explicit plan id
gets the "not closable" line. A close that stopped an older CLI is logged as
the agent's close, not as a CLI failure (`isClosedByAgent`). Only a server that
answered as an older Plannotator without the endpoint (an uncoded JSON `404`
or its app page) is stopped instead: SIGTERM to the plugin's own child process
(`terminate` from `runPlannotatorCli`'s observer), which never deletes a
draft; a decision such a CLI is still publishing is lost, as on the mod.

Tests: `apps/opencode-plugin/plannotator-tool.test.ts` (registration against
older drafts and without `prompt`, refusals, and the real launch path against a
stub CLI that serves the real host-control guards: open → url and id → list →
decision heading in the right session, gated bare approval, close with the
token, turned-off close leaves the server up, older CLI stopped, startup
error, a slash command listed). Checked live on OpenCode 2.0.22 with a fake
model: the model's tool call opened annotate and review, `list` showed the
server's count, the reviewer's feedback and a gated approval arrived as new
turns headed with the id, `close all` closed a review holding 2 draft comments
with no turn delivered, and Ask AI showed "Ask this session". A list target
(`["notes.md", "mock.html"]`) opened one `annotate-bundle` session in that
order, `list` named it `2 files: notes.md, mock.html`, its feedback arrived
headed `— Feedback · 2 comments.` under `Files: notes.md, mock.html`, and
`close all` closed a second bundle.

### T3 Code: Ask this session through an optional Claude hook (opt-in, unreleased)

`packages/t3-code` (user notes in its README). T3 Code runs Claude through the
Agent SDK, which loads `~/.claude/settings.json` hooks, so a Claude Bash hook
connects ordinary `plannotator review` / `annotate` / `last` commands in a T3
conversation to that conversation: Ask this session becomes a T3 turn, and the
decision arrives as a T3 message. It uses T3's existing MCP API as a client
(no T3 change, no provider-side MCP server, no skill change). Nothing of it
runs for anyone who did not opt in.

- **Opt in / out:** `install.sh --with-t3` writes one `PreToolUse` `Bash` hook
  into `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json` (`t3-hook install`,
  `packages/t3-code/install-hook.ts`: other hooks and settings kept, a
  `.plannotator-t3.bak` backup before the first change); `--without-t3`
  removes only it. Both are remembered in `install-flags.json` (`with-t3`,
  `without-t3`; POSIX only, no PowerShell spelling) and skipped by
  `--minimal`; a failing step warns and never aborts the install. Without a
  flag the installer touches nothing T3. `plannotator t3 login --url <T3 MCP
  URL>` authorizes once (OAuth, PKCE); `plannotator t3 logout --url …` stops
  that endpoint's workers and deletes the saved grant. `t3` and `t3-hook` are
  in `HIDDEN_SUBCOMMANDS`.
- **The gate (per Bash call cost):** the hook runs on every Bash call of every
  Claude session that loads the settings file. The command is
  `case "$CLAUDE_CODE_ENTRYPOINT" in sdk*) PLANNOTATOR_DATA_DIR=… '<binary>' t3-hook;; esac`
  (`t3HookCommand`, `packages/shared/t3-hook-command.ts`): only an Agent SDK
  session (`sdk-ts`, …) starts the binary; an interactive `claude` (`cli`)
  is answered by the shell with no output (~3 ms instead of ~290 ms of CLI
  startup). The binary repeats the check as the first statement of
  `apps/hook/server/index.ts` and in `prepareT3Hook`. Inside an SDK session
  the hook routes only when a saved grant exists and T3 shows the exact
  running tool call (`toolu_…`, Bedrock/Vertex ids included) owned by one
  conversation in the same folder; otherwise, and on any error, it answers
  `{}` (the command runs as written) and logs to `t3-code/hook.log`. The
  whole lookup, connecting included, is bounded at 6.5 s, under Claude's
  10 s hook timeout.
  Limits: the gate opens for EVERY Agent SDK session, not only T3's:
  `claude -p` (`sdk-cli`), other SDK apps, and Plannotator's own Claude
  review-agent jobs (which load user settings). There an opted-in user pays
  the binary's start (~320 ms) per Bash call, and the hook then finds no T3
  owner and answers `{}`. A Claude whose cwd is below the thread's root (it
  `cd`'d into a subfolder) is not routed: the command runs as the ordinary,
  blocking CLI. Claude Code matches permission rules against the rewritten
  command (`plannotator t3-hook open …`), not what Claude typed (from the
  hooks contract; not checked live).
  The launch file under `t3-code/hooks/` is removed after one use, whether
  the open succeeds or fails.
- **Worker:** one detached `plannotator t3 serve` per thread (registry
  `t3-code/<endpoint>/threads/<thread>/daemon.json`, token-guarded loopback
  routes `/health`, `/review`, `/stop`) launches the review CLI with a pull
  bridge (`PLANNOTATOR_SESSION_BRIDGE_HOST=t3`), long-polls it, and delivers
  the host result record. It exits after 10 min with no open review, no
  pending delivery and no review request (`PLANNOTATOR_T3_WORKER_IDLE_MS`);
  the next command starts a new one (a request that meets one that just
  exited is retried once). The OAuth token is read per request and a refused
  MCP session is reopened, so a new login applies without a restart; only a
  delivery already attempted under the old grant is refused (T3's idempotency
  namespace changed). A review whose server died without a decision, a
  launch that never came up (no ready line within 60 s, or its CLI gone,
  e.g. the worker was killed while opening it), or a refused delivery stops
  being waited on, so no later worker inherits it. A settled review drops its
  bridge token from `launch.json` at once; its folder is pruned on worker
  start and idle exit after 24 h (7 days for failed or refused ones).
- **Decisions** (`packages/t3-code/decision.ts`) are worded exactly as the
  Claude Code mod words them (`decision.test.ts` compares against the mod's
  `deliveryFor`): `Changes requested · N comments`, LGTM / Done / Close only
  logged (a gated annotate approval is sent), over 12 KB written to the
  review's `feedback.md` and named in the message (T3 caps a message at
  120,000 characters). One deliberate difference: a review posted to the PR
  platform is sent as `Review posted` with its status line. `last` skips
  messages from runs still going (the run that called it).
- **UI:** the bridge advertises `interruptible: false` (pull poll body →
  `sessionBridge.interruptible` on `/api/ai/capabilities`; absent for every
  other host and older servers), and the Ask AI panels then offer no
  "Interrupt and ask now" and label Stop as "Stop listening".
- **Data:** `<data dir>/t3-code/` (grants, hook launches, review results,
  pending deliveries, `feedback.md`, logs; feedback and conversation text,
  nothing pruned). `isAllowedHostResultPath` accepts `result.json` under it.
  Uninstall stops running workers (dry run lists them), removes the hook for
  the installed binary and the `settings.json.plannotator-t3.bak` backup the
  hook install made; `--purge` deletes `t3-code/`.
- **Tests:** `bun test packages/t3-code` (unit); with
  `T3_TEST_EXECUTABLE=<compiled binary>` also the end-to-end proof against a
  scripted T3 MCP server (`connected-session.test.ts`, run on the compiled
  binary in `test.yml`); `scripts/install.test.ts` ("optional T3 hook"),
  `packages/server/uninstall.test.ts`, `packages/ai/session-bridge-pull.test.ts`.

### Codex Stop hook: which turn the plan belongs to

Codex has no `ExitPlanMode`, so plan review rides its experimental `Stop` hook:
the hook reads the session rollout and returns the plan **the turn that just
stopped** produced. Anchoring on a turn is what keeps an older, already-decided
`<proposed_plan>` from being reopened (#1169), and the turn is resolved in
`resolveCodexStopPlan` (`apps/hook/server/codex-session.ts`) in two tiers:

1. **The payload's own `turn_id`** when the Stop JSON carries the field.
2. **The rollout's own turn markers** when it does not: the id of the LAST
   id-carrying `turn_context` / `task_started` marker in the newest rollout
   segment. A turn still in flight owns the last markers by construction, and
   when Stop fires at turn end the last marker is that turn's own, so one rule
   covers both shapes. The scan then still anchors on that turn's **first**
   marker, so a mid-turn compaction (which re-emits `turn_context` with the same
   id) cannot hide a plan the turn produced before it.

Tier 2 exists because `StopCommandInput.turn_id` only landed in Codex
**rust-v0.117.0** (`rust-v0.116.0-alpha.12`), while the hooks engine itself
shipped in **rust-v0.114.0**: stable `rust-v0.114.0`, `v0.115.0` and `v0.116.0`
fire the Stop hook with no `turn_id` at all. Their rollouts do record the id on
every turn marker (`TurnContext::to_turn_context_item` writes
`turn_id: Some(sub_id)`), which is what the fallback reads. Using it writes one
unconditional line to **stderr** (`logCodexStopTurnIdFallback`; stdout is the
hook's JSON decision channel, and Codex only reads a Stop hook's stderr on
exit code 2, which this hook never uses).

Fail-closed cases are unchanged: a payload that carries `turn_id` as a blank
string — or as anything that is not a string — is truncated or foreign, not an
old Codex, and is refused **before the rollout is read**; a rollout with no
id-carrying turn marker at all skips too. Both skips stay silent unless
`PLANNOTATOR_DEBUG` is set.

The deny→resubmit guard follows the same two shapes. When `stop_hook_active` is
set, the plan is served only if it changed across the boundary the previous
blocking Stop left in the turn. Codex >= 0.117 records that boundary as a
`<hook_prompt>` **user** message (`build_hook_prompt_message`); `rust-v0.114.0`,
`v0.115.0` and `v0.116.0` record it as a **developer** message
(`DeveloperInstructions::new(continuation_prompt)`), so the rollout-fallback
path — and only that path, which keeps every `turn_id`-carrying Codex
byte-identical — also accepts the last developer message in the turn as the
boundary. Without it the guard is inert on exactly the versions the fallback
enables, and an unrevised denied plan is re-served on every Stop of the turn.
