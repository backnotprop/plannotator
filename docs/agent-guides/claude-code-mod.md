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
A gated launch (`deliverApproval`: the tool's or a taken-over command's
`gate: true`, annotate or review) still delivers a `noop` approval; a review
LGTM record's `message` is the configured approved prompt for that (a CLI
before #1907 wrote `""`, and the turn is then the heading alone). `plannotator
review --gate` is accepted by the shared `parseReviewArgs` (`gate: true`) and
changes nothing in the CLI, whose approval is printed anyway.
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
(annotate and review), options?: { base? (review --base), markdown? (annotate
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
for the sign-off; the slash command's bare gated approval still only logs. This
holds for code review too (#1907, gate only, the owner's call: an ungated
review's LGTM still only logs): `{ action: "review", gate: true }` delivers a
bare Approve as `Plannotator: <subject> (pn-…) — Approved.` plus the configured
approved prompt (the host record of a review LGTM is still `noop` but now
carries that prompt as its `message`, as an annotate approval does), and a
gated review posted straight to the PR platform is a turn too,
`Plannotator: <subject> (pn-…) — Review posted.` plus the status line (an
ungated one still only logs and suggests the follow-up). A review's
gate is the HOST's alone: `plannotatorToolArgs` never passes it to the CLI (the
review page always has Approve, and a CLI older than `review --gate` would
refuse the flag), so it works against any CLI. Done
and Close send nothing, as for the commands. **`tailscale: true`** (annotate,
review, last; #2166) opens the review with the CLI's `--tailscale`
(`plannotatorToolArgs`; `last` runs `annotate-last --stdin --tailscale`), so
the reviewer reads it on their phone or another device of their tailnet while
"Ask this session" keeps answering for the Tailscale login that owns this
machine (see "Tailnet sessions"). The option is an opt-in of the shared
contract: the mod registers `PLANNOTATOR_TOOL_TAILSCALE_INPUT_SCHEMA` /
`_DESCRIPTION` and parses with `{ tailscale: true }`; Pi, OpenCode 2 and T3
keep the plain schema and description byte for byte (pinned by a sha256 in
`packages/shared/plannotator-tool-tailscale.test.ts`) and refuse the field as
unknown, as before. The opened text adds one line saying it is served over the
tailnet and who gets Ask this session (`plannotatorTailnetOpenedLine`). Version
skew: a tool call with `tailscale` whose ready line carries no `tailnet` field
(a CLI from before #2166, which drops the bridge, or one that ignored the flag)
is stopped (`STOP_SCRIPT`) and answered `PLANNOTATOR_TOOL_TAILSCALE_UNAVAILABLE_TEXT`
("update Plannotator"); an older CLI's refusal of the flag itself
(`isOlderCliTailscaleRefusal`: `File not found: … --tailscale`, "only supported
with", an unknown option) gets the same answer, while a current CLI's publish
failure (it starts with `--tailscale:`: Tailscale not running, signed out, the
port routed) is shown as it is. A launch that answered "starting" and came up
later without the field is reported to the session with a log line and toast
(`TAILSCALE_LATE_OLDER_CLI_TEXT`; the review stays open). The slash commands pass `--tailscale` through as before (now for
`/plannotator-last` too) and check nothing. A subagent may call the tool (its
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
`annotate` (one target, or several that all read as file paths, `looksLikeFilePath`: a separator, a leading `~` `.` `@`, or a file extension; they become `target: [...]`, a review of several files; plus `--gate`, `--markdown`), `review` (at most one target, `--base <ref>`, `--gate`),
or `annotate-last` / `last` (no arguments); on any of the three `--tailscale` too (`tailscale: true`, the mod passes `{ tailscale: true }` to `plannotatorCommandToToolInput`; #2166); `--json` is accepted and dropped
(the decision arrives as a message), and the result must pass
`parsePlannotatorToolInput`. Everything else runs as written: other
subcommands, every other flag (`--require-approval`, `--result-file`, `--hook`,
`--static`, `--app`, `--no-jina`, `--render-html`,
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
   revisionFile, projectRoot? }`, `projectRoot` the session's `$.session.root()`
   read once per session, under whose project an existing plan history chain is also looked for (#2197, see
   "Plan Version History"); the plan server with `planRevisions: true`) and answers
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
   command hook never runs: no second review. The mod's
   `classic.PermissionRequest` hook is registered with the matcher
   `{ tool_name: "ExitPlanMode" }` (#2159), so the engine never selects it for
   another tool's permission prompt; unmatched, a guard seated above made
   Claude Code print "its classic.PermissionRequest hook was skipped" at the
   first permission prompt of every session. A different plan opens a new
   review instead. **When a plugin seated above sends
   `classic.PermissionRequest` past the mod** (Claude Code's built-in guard
   `cc-plugin-sec-default` does on Team/Enterprise accounts, #2007; the
   transcript says "its classic.PermissionRequest hook was skipped"), the
   plugin's command hook IS reached. So while the approved call is in flight
   the mod also writes the approval (`{ v: 1, hash, plan, permissionMode?, at }`)
   to `<data dir>/claude-code-mod/<session>/plan-approvals/<tool use id>.json`
   (owner-only folder; plan.ts `PLAN_APPROVALS_DIR`, launch.ts
   `planApprovalPathOf`) and removes it when the call settles. The classic hook
   (`apps/hook/server/mod-plan-approval.ts`, `takeModPlanApproval`, before
   anything else in the Claude Code plan path) takes a record for this
   `session_id` whose hash matches the requested plan (the #1667 file rule,
   or the inline plan), at most 10 minutes old, never for a subagent, deletes
   it (answers once) and prints the same allow (`updatedInput.plan`, `setMode`)
   without starting a server. Without the guard the record is written and
   removed and nothing else changes. A CLI older than this ignores the record
   (the double approval remains until the binary is updated).
   `mod-plan-approval.test.ts` keeps the mod's copy of the names equal and
   runs the hook as a process.
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
`busy` = a MAIN-LOOP turn is running (pushed on `turn.start` / `turn.complete`, not only
at the next poll; a subagent's `turn.start`, which every hook hears, is ignored by `onTurnStart`: its end is never counted, so counting it left the session busy for good after a background subagent started, and the Inbox wake never delivered); `interrupt` aborts the running turn (`$.turn.abort`), except a turn another plugin's prompt started (below), which it refuses with `ok: false` and `OTHER_PLUGIN_INTERRUPT_TEXT` ("The session is answering a message from another plugin, so Plannotator will not stop it. Ask when it finishes instead.", `bridge.ts`);
cancel aborts our own turn, or, while it is still queued, confirms at once and
aborts its turn the moment it starts. Claude Code never raises a plugin's own hooks
for a prompt its code submitted (the debug log says "skipped: re-entry"), so the
mod's `prompt.submit` hook sees every OTHER prompt (the user's Enter, a
notification, another plugin); a turn whose text is exactly one of those is
never claimed, so a prompt the user typed can neither be streamed to
Plannotator nor aborted by a cancel, whatever it says. Another plugin's prompt
reaches `turn.start` inside the engine's "The <name> plugin sent a message:"
frame while `prompt.submit` saw it bare, so the match also strips that frame.
**Another plugin's turns are left alone:** a turn whose prompt `prompt.submit` saw with `origin.kind` `plugin` (any plugin but this one: ours never reach our hook and `fromUs` drops them), or a running turn such a prompt was delivered into (`turnId`), is recorded per turn id (`TurnTracker.isOtherPluginTurn`, cleared at its `turn.complete`), because that plugin (a connector that delivers its own messages as turns, such as Workspaces' BYOA) may read the turn's answer as the answer to its message. The mod never aborts it ("Interrupt and ask now" answers `ok: false`; a reviewer's Stop on our own Ask question whose turn such a prompt joined closes the question only, like a take-over) and never puts an Inbox reply into it (`steerableTurn` is null, so the poll's `send_now` is false while it runs: the window shows that the reply cannot go in sooner and the Inbox does not start the 5-minute auto-send for it; a reply the person or the Inbox marked Send now just before the turn started still waits, and the window may briefly read "Sending … now" until the mod's next `state` report (its 1 s tick says `send_now: false`, and the line then reads queued), as it can with our own Ask turn; either way the reply goes in once, as a turn, when the session is idle). Attribution comes only from `prompt.submit`'s origin: a turn nothing attributes to another plugin (the frame alone is not read, since it could be our own) and every turn the person or the engine started (`composer`, `bridge`, `task-notification`, `scheduled-trigger`, `peer`, ...) behaves exactly as before.
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

**The Plannotator Inbox (`plannotator_inbox` and the reply wake, `inbox.ts`).** Where `PLANNOTATOR_INBOX_TOOL` / `inboxTool` allows it at the first `session.start` (on by default here), `register.ts` reads the Inbox's tool list once (`discoverInboxTools`: `tools/list` on its `/mcp`; a stopped Inbox is described by the list it last answered with, kept in `$.store` as `inboxTools`; with neither, the list bundled with the mod, `INBOX_DEFAULT_TOOLS` in `inbox-default-tools.ts`, generated from a real Inbox by `bun run scripts/sync-mod-inbox-tools.ts` and pinned to one by `inbox-default-tools.test.ts`) and registers `plannotator_inbox` (`inboxAgentTool`), a SEPARATE tool, never actions on `plannotator`. So Claude Code has the tool before this computer ever ran the Inbox: the first call starts it. With no `inbox/inbox.json` the link stays silent: no HTTP request and no file (no lease, no claims folder) until a call starts the Inbox, and the wake polls from the next tick after. With the tool, `inbox/inbox.json` present at the first `session.start` (an Inbox has run here) and `inboxReminder` on (default), a `prompt.context` hook adds the `plannotatorInbox` block (`withInboxReminder`, the line naming the tool's registered full name) to the conversation's first message, once per conversation (see `inboxReminder` under Config-only settings). **Guarded sessions (#2159).** On Team/Enterprise accounts (and wherever managed settings seat it) Claude Code's built-in `cc-plugin-sec-default` runs in the `prepend` tier and sends `prompt.context` (and every `classic.*` event) past every user-tier hook, so that block never reaches the model there (the engine prints "its prompt.context hook was skipped"; the line stays, since the mod cannot register `prompt.context` conditionally). **The engine runs `prompt.context` before the mod's `session.start` finishes** (seen live on 2.1.310: the hook returned about 230 ms before `plannotator_inbox` was registered), so a hook that read the module state at once added nothing to every process's first conversation (true on main before #2167 too). `session.start` therefore settles a promise with its decision (`reminderGate` / `settleReminderGate`) once the switch, `inbox.json` and the tool's registered name are known, also on its early returns (`-p`, the mod off) and on a throw, before it goes on to the commands and the `plannotator` tool; `prompt.context` and the `prompt.submit` fallback wait on it, at most 2.5 s (`REMINDER_GATE_WAIT_MS`, `reminderGateDecided`). A `prompt.context` that outwaits it adds no block but still records that it ran, so the machine is never taken for a guarded one. Two additions, both under the same gate (`reminderOn` in `register.ts`): (1) the learned fallback: `$.store` key `inboxReminderContextWorks` (`STORE_INBOX_REMINDER_CONTEXT_WORKS`, read once per process) is written `true` the first time the mod's `prompt.context` hook runs and `false` when a conversation's first main-loop `turn.complete` (not aborted, not a session started by an earlier process: `$.session.usage().startedAt` over a minute before this process's first `session.start`, `reminderSessionResumed`) went by without it. While it is not `true`, the conversation's first prompt that is not `isMeta` and not a slash command carries the same text as `prompt.submit` `context` (`inboxReminderSubmitCopy`); it counts as reached only once the prompt entered (a dropped prompt does not), and a conversation reached by either path gets no second copy. So a standard user gets one duplicate, in the first conversation after the update, then today's path alone; a guarded user gets it on every conversation's first prompt; a machine that becomes guarded later gets it from the second prompt of its first guarded conversation. `prompt.submit` `context` exists on the mod's floor engine (checked in the 2.1.287 binary: it becomes a `hook_additional_context` row, `hookName: "prompt.submit"`). Known limits: a resumed guarded conversation gets the copy again (one duplicate); the transcript notice stays. (2) After compaction, for everyone: the mod sets `PLANNOTATOR_INBOX_REMINDER` (`INBOX_REMINDER_ENV`) to the text at its first `session.start` (unset when the gate is off; `env.set` is not guarded unless managed `env` names the variable), and `hooks.json` has one `SessionStart` command hook matched on `compact`, `set \' ; printf "%s\n" "$PLANNOTATOR_INBOX_REMINDER" ; : ' #'` (timeout 5 s). It never starts the `plannotator` binary; the engine trims hook stdout, so an unset variable (mod off, reminder off, `-p`, Windows) adds nothing, and a set one adds `SessionStart:compact hook success: <the reminder>` to the conversation after the compaction (standard users then hold the re-made block and this line: one duplicate per compaction, accepted). The command is a sh / PowerShell polyglot, because Claude Code runs a command hook in Git Bash on Windows, else in PowerShell (`-NoProfile`), never cmd. sh runs `set \'` (sets `$1`, silent), then `printf "%s\n" "$X"`, which prints the value byte for byte (a custom text's backslashes, leading `-`, `%`, quotes and `$(...)` included; an expansion's result is never run), then `: ' #'`. PowerShell reads `\'` as `\` plus the start of a single-quoted string that ends at the `'` before ` #`, so it runs `set` (Set-Variable) with that string as a name, silently, and the rest is a comment: no printf, no output, exit 0, even where no `printf` exists (Windows). Unset, sh prints only a newline, exactly as the earlier `echo "$X"` did, and with the built-in text the bytes are the same as `echo` printed. Proved under sh, bash and dash (and PowerShell when installed) by `inbox-reminder.test.ts`, with a hostile value whose command substitutions would leave marker files. The `plannotator` CLI removes the variable at startup (`scrubModSessionEnv`, `apps/hook/server/mod-session-env.ts`, beside the bridge token and the host result file), so nothing a CLI the mod started spawns inherits it (Claude agent jobs, `claude -p`, included). Before each compaction installs (`session.compact`, not `precompute` or a subagent's), the mod sets the variable again, to the reminder plus a blank line and the session's open Inbox threads (or the reminder alone when there are none or the Inbox did not answer within 1.5 s; never starting it), so the same command hook prints the list (its command unchanged; only `hooks.json`'s description mentions the list), and the variable goes back to the plain reminder at the next main-loop step or turn, keeping thread ids out of Bash children's environment; and a resume (`classic.SessionStart`, matched on `source: "resume"`) gets the list as `additionalContext` (see "The session's open threads" in `inbox-notifications-and-agents.md`). Gaps: `disableAllHooks` / settings hooks off (no command hooks, so a guarded user has no reminder after compaction); a nested `claude` that Claude itself starts from Bash inherits the variable, and if that run is `-p` (mod inert, nothing set or cleared) and compacts, it prints the parent's line. Tests: `apps/hook/hooks/mod/inbox-reminder.test.ts` (the decision table; the hooks.json command run under `/bin/sh` and `/bin/bash`, and PowerShell when `pwsh` is installed) and the engine harness (`apps/hook/tests/register.test.ts`, with an inline `prepend`-tier stand-in for the guard that does `next.to(e, 'append')` on `prompt.context` and `classic.*`). The session's `PlannotatorMod` owns an `InboxLink` (one per session id, so `/clear` and an in-process resume follow the new id: the old link is disposed at `session.end` and the next hook makes one for the new id). A call (`tool.call`, answered by the mod) re-reads the registry, checks health against its `serverSession`, starts a stopped Inbox with `plannotator inbox --background` (a one-shot that detaches the Inbox into its own session and waits for it; never a browser tab), and proxies to `/mcp` with `project_path` = `InboxLink.projectFolder()` (the session's start folder, its root, which a shell `cd` never moves; see "A session's project" in `inbox-foundation.md`), or the agent's optional `project_path`, resolved against `$.session.cwd()` by `INBOX_PROJECT_DIR_SCRIPT` and refused before the Inbox is reached when it is not an existing folder and `agent_session` = the host's real session id; `wait_for_reply` is held to 25 s through the tool (`$.http.fetch` gives up at 30 s). The wake: a 1 s `$.clock.every` tick long-polls `/api/inbox/bridge/poll` (20 s) with a 5 to 60 s backoff that never gives up; a reply waits in the mod (unless the person pressed Send now: see "Questions and Send"; the mod then puts it into the running turn with `$.session.append`, unless another plugin's prompt started that turn) until the session has been idle for two ticks (a pending `$.prompt.submit` cannot be withdrawn, so a prompt the person typed, or a `/clear`, queued during a turn goes first), is checked once more with the Inbox (an agent may have read it meanwhile), claimed once across processes (`INBOX_CLAIM_SCRIPT`: mkdir of `claude-code-mod/<session>/inbox/claims/<reply id>`), submitted (`inboxWakeText`), and acknowledged (`delivered`, retried until the Inbox answers). A prompt typed into the reply's own turn takes it over as Claude Code folds it in; the mod never aborts it and never delivers the reply again. Two processes on one session: the session's inbox lease (`claude-code-mod/<session>/inbox/watcher.json`, the rules of the review watcher lease: the person's last process wins, 20 s stale) picks the one that polls and delivers, and the claim makes a lease race harmless; a claimant writes `alive` while its turn waits, and a reply whose claimant stopped for 60 s without `delivered` is reported once with a toast (the only toast the connection raises); one marked `delivered` whose acknowledgement was lost is acknowledged by the other process. Nothing touches the system prompt; the tool list is fixed per process. Version skew: an Inbox without the bridge route (404) just leaves the poll backing off; an action the running Inbox lost answers "update Plannotator"; a `plannotator` without the `inbox` subcommand answers that the binary has no Inbox.

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
