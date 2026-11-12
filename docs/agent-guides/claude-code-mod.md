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
skills run as they do without mods. (One gap: a `/rename` or `/clear` that beats
`session.start` to its decision still records the name; see "The session's name".)
See the env table row.

**Sessions the Inbox launched** carry a second PermissionRequest hook in their
`--settings` file (`plannotator inbox permission-hook`, `inbox-launch.md`,
"Permission prompts"). It prints nothing for ExitPlanMode, so plan review stays
with the mod or the classic hook exactly as above.

**Inert without mods.** Checked live: Claude Code 2.1.150 (no hooks modules)
validates and loads the plugin with the `modules` key, ignores it, and runs the
classic PermissionRequest command hook (the blocking review) exactly as before;
2.1.288 with modules on runs the mod and never reaches that command hook. The mod
also stands down by itself (every hook passes through) in `-p` / SDK sessions
(`isInteractive` false: a later plugin turn would have no session to land in)
and where it finds no shell for its scripts ("The shell" below), leaving the classic hook and the
`/plannotator-*` skills in charge. A mods-capable Claude Code whose rollout
switch is off could not be reproduced locally; the engine only inserts modules
into the hook chain when they load, so it should behave like 2.1.150.

**Files.** `register.ts` holds every `$` call (`claude plugin validate` follows
`$` only through top-level functions and inline hooks) and builds a `Host` of
closures; `controller.ts` (`PlannotatorMod`) is the per-session state machine;
`launch.ts` (detached launcher, launch-directory layout, command table, copy),
`delivery.ts` (turn vs log, 12 KB inline limit), `plan.ts` (ExitPlanMode
decisions and deny copy), `turns.ts` and `bridge.ts` (Ask this session),
`shell-words.ts` (argument splitting), `tool.ts` (the `plannotator` tool contract, a copy of `packages/shared/plannotator-tool.ts`), `take-over.ts` (agent-run Bash `plannotator` commands answered through the tool), `inbox.ts` and `inbox-contract.ts` (the Plannotator Inbox connection, below; the contract a copy of `packages/shared/inbox/connection.ts`), `shell.ts` (the shell the scripts run in, below) and `paths.ts` (absolute paths, Windows' included). The mod is self-contained: a plugin
installed from the marketplace is only `apps/hook/`, and a hooks module may
import only its own files.

**The shell.** `$.process.run` runs an argv with no shell, so each file
operation the engine has no call for (the `mkdir` claims, `rm`, the debug log's
append, `kill`, the detached launch) is a short script. Every argv builder
names its script (`ShellScriptId`) and gives its POSIX text, and `shellArgv`
turns that into the argv of the shell `resolveShell` picked at `session.start`:
`/bin/sh` on macOS and Linux. Windows has no `/bin/sh`: there it is Git Bash
where it is installed (`git-bash.ts`), else Windows PowerShell 5.1
(`powershell.ts`), which every Windows 10 and 11 has. `PLANNOTATOR_MOD_SHELL`
(`sh` or `powershell`) holds Windows to one of the two; `sh` without Git Bash
leaves the mod inert. Before using a Windows shell, `pickShell` runs one probe
script in it; a shell that fails (PowerShell under Constrained Language Mode, or
a security product that blocks a hidden `-EncodedCommand` run) gives way to the
next, and none leaves the mod off. The first process on a session records its
shell in `claude-code-mod/<session>/shell`, and every later process on that
session uses it over its own `PLANNOTATOR_MOD_SHELL`: the two shells claim a
decision differently and record different pids, so one session never mixes
them. macOS and Linux skip the probe and the pin. Git Bash is the standard name of the bash that ships with
Git for Windows, and Claude Code uses the same name and the same bash for its
own shell commands. The mod finds it through `CLAUDE_CODE_GIT_BASH_PATH`
(Claude Code's setting), then next to a `git.exe` on `PATH`, then under
`%PROGRAMFILES%` and `%LOCALAPPDATA%\Programs`, and finds PowerShell under
`%SYSTEMROOT%` or `%WINDIR%`; no drive or folder is fixed. Git Bash runs the
POSIX scripts as they are except where MSYS reports something differently: its `ps` has no `-o`, so
the stop check reads the pid's command line from `/proc`, and `pwd` prints
`/c/…`, so the scripts that print a folder use `pwd -W`. In PowerShell each
script has a twin with the same arguments, output and exit codes; it travels as
`-EncodedCommand` with each argument written in as base64 (PowerShell also ends
a string at `‘ ’ ‚ ‛`, so escaping `'` would not be enough), prints lines ending in `\n` alone, and reads stdin as bytes (with no console a
process decodes stdin in the system code page). Its launch hands the CLI to a
hidden watcher process that writes the CLI's (Windows) pid and exit code; the
watcher looks a bare CLI name up as an `.exe` on `PATH` only, since
`Process.Start` would search the session's folder first and run a
`plannotator.exe` committed to a repository. Its transcript peek prints no file id (NTFS's needs a compiled call per read).
Each bash call takes about 15 ms and each PowerShell call about 200 ms. The variables `resolveShell` reads are read in `register.ts`
(`shellEnvOf`), each named as a literal: Claude Code refuses to load a hooks
module whose `$.env.get` takes anything else (`env-get-literal.test.ts`).
Every check for an absolute path goes through `isAbsolutePath`, since Claude
Code gives a Windows session its folders as `C:\…`, and the home folder is
`USERPROFILE` on Windows (as the CLI's `homedir()` reads it), else `HOME`. Off
Windows a review's target and name keep a backslash as an ordinary character
in a file name. The
`claude-code-mod-windows` job of `windows.yml` runs the mod's Windows tests
(paths, Git Bash, the shell pick, every PowerShell twin, the compaction hook).

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
new one for the current id, restoring that session's open reviews. Only an end
of the session the instance serves disposes it (`disposesOnSessionEnd`,
`self-heal.ts`): no `agentId`, and a `sessionId` that is the instance's, the
one the process is in now (an instance still serving an older id is stale), or
none (an older engine). The event decides first, so the dispose (the lease
release, the hand-off writes) goes out inside the hook's time bound; the
process's id is asked only when the event names another session. `/clear`
(whose `session.end` names the id it leaves) and a quit still dispose. The
rule is defensive: on 2.1.318 `session.end` names this session and carries no
`agentId`. Seen live: an Inbox reply to an idle session did not go in until the
person typed, and a disposed instance is one way that happens (nothing polls
the Inbox). As a safety net, a 30 s `$.clock.every` (`MOD_HEAL_EVERY_MS`),
armed at the first `session.start` the mod runs in (after the commands and
the tool, never holding them), makes a missing or disposed instance again
(through `currentMod`, so never two; one disposed by this session's own
`session.end` is left for one whole period, since `/clear` moves the id just
after it). That instance is `healed`: its Inbox link starts without a touch,
so a live lease another process holds stands. A live instance's Inbox tick
that stopped firing (the engine ends an interval at a refused period) is
armed again at the next look, 30 to 60 s after it stopped
(`InboxLink.ensureTicking`). The self-heal's own timer, silent for two
periods, is armed again at the next `turn.complete` (one timer, the old one
cancelled). With `PLANNOTATOR_MOD_DEBUG=1` each `session.end` logs its
`sessionId`, `agentId`, reason and whether it disposed, a rebuild or re-arm
logs a `self-heal:` line, and each reason a waiting reply is not submitted
(`inbox: not delivering <id>: <reason>`, at most once a minute per reason)
is logged. The launch
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
- Data dir (#2305): a mod with the stray-folder rule (`resolveDataDir` in
  `launch.ts`) and a CLI from before it can disagree only on a machine where a
  stray `~/.plannotator` sits beside an XDG folder with data (the mod picks the
  XDG folder, the old CLI the stray one). It heals itself on the old CLI's first
  server run: that run writes `sessions/` into the stray folder, which then
  holds data, so the mod picks it too from its next session start.
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
- Inbox reply title (#2464): the title is the Inbox's call, not the mod's. A
  newer Inbox sends `subject: null` on a plain reply in a thread with no name,
  which every mod since the first Inbox connection words `a reply` (its notices
  `(a thread)`); an older Inbox sends the subject, and a newer mod prints it as
  before. Either way the reply is delivered. See "The title on the wake's first
  line" in `inbox-notifications-and-agents.md`.
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
expansion; on Windows a backslash and a single quote are plain characters and
only double quotes group, so `C:\Users\me\O'Brien\plan.md` stays one word, the
same argv under Git Bash and PowerShell) and passed to the same CLI parsers (`review`, `annotate`; `last`
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
knob not turned off, an interactive session, a shell found) and the agent tool
switch is on (on by default here; `PLANNOTATOR_AGENT_TOOL=0` / `{ "agentTool": false }` turn it off; `resolveAgentToolEnabled`
in `hooks/mod/enabled.ts`, read with the mod switch at the first `session.start`
of the process, never re-read); with either switch off, in `-p`/SDK runs and
where no shell is found nothing is registered and Claude keeps the CLI through the `plannotator`
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
runs and where no shell is found nothing is taken over. The CLI the mod launches runs in the
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
   `{ tool_name: "ExitPlanMode" }` (#2159), so without a guard the engine
   never runs it for another tool's permission prompt. Under a guard seated
   above (below) the matcher does NOT stop Claude Code printing "its
   classic.PermissionRequest hook was skipped" at the first permission prompt
   of a session, whatever the tool: the host trims only the plugins above the
   first one that matches, and the guard matches every event (checked with
   2.1.314's plugin test kit and in its host code; #2243). That line remains. A different plan opens a new
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

**The skip-rm-prompts variable (`skip-rm-prompts.ts`).** Claude Code's
`CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS` waives, in bypass
permissions mode, the prompts for removals it cannot prove safe
(`rm -rf logs/*/*`), but only while no PermissionRequest hook is installed, so
the plugin's ExitPlanMode hook (and the mod's own) turned it off for every
session. The plan hook stays; the mod gives the person's setting back instead:
a `tool.check` hook on Bash only watches each call's verdict, and a
`classic.PermissionRequest` hook matched on Bash answers the prompt `allow`
when all of these hold: the variable is on (`1`/`true`/`yes`/`on`), the
session is not nested (`CLAUDE_CODE_CHILD_SESSION`), the call's loop (main or
subagent, from the prompt's `permission_mode`) is in bypass mode, the call's
verdict (kept 5 seconds, read once, by loop and command) is the removal
check's ask alone (its message `Dangerous <cmd> operation…` or `This command
passes a shell -c script that runs rm…`, and no `rule`, `hook`, `setting` or
`plugin` on it, so any PreToolUse hook that asked, and any plugin beneath the
mod that made or joined the ask, keeps its prompt), `$.settings.read()`
(every source, managed included) holds no ask/deny rule on Bash, PowerShell,
Monitor or `rm`, no `blockReadsOutsideWorkingDirectories`, and no
PermissionRequest hook whose matcher could select Bash (absent, `*`, a
regex matching `Bash`, or one that does not compile), and no enabled plugin
holds such a hook either. A PreToolUse hook is no reason to step aside by
being there: it has run before the prompt whatever
the mod answers, Claude Code itself keeps the waiver on beside one (real
runs, 2.1.318 and 2.1.321: a no-op, allow or deny PreToolUse hook on Bash or
`*`, in settings or a plugin, leaves the removal unprompted with no
Plannotator), and its ask is on the verdict (`hook`). **A command of several
parts** (`cd /tmp/x && rm -rf logs/*/*`, two removals in one command, a
removal outside the working directories beside a `mkdir`) gets another
wording from Claude Code, `This Bash command contains multiple operations.
The following parts require approval: <part>, <part>`, which lists the parts
(allowed ones too) and never names the check that asked. The mod answers it
only when the verdict carries no `rule`, `hook`, `setting` or `plugin`, a
listed part runs `rm` or `rmdir`, and Claude Code's own verdict for each
listed part asked by itself (`$.tool.check`, which runs nothing and no classic
hook) is `allow` or a removal-check ask alone; a part that asks for any other
reason, or a query that fails, keeps the prompt. The mod answers without the
PermissionRequest hooks beneath it, so it
reads every plugin the settings' `enabledPlugins` turn on (anything but
`false`) from Claude Code's registry
(`<CLAUDE_CONFIG_DIR or ~/.claude>/plugins/installed_plugins.json`, every
record's `installPath`): its `hooks/hooks.json` and the `hooks` of its
`.claude-plugin/plugin.json` (inline, or the files it names). Plannotator's
own hooks are on EnterPlanMode and ExitPlanMode and never count. Anything
else, or anything unreadable (a registry or hooks file that does not parse, an
enabled plugin not in the registry, a hooks file the manifest names that is
not there), steps aside and the dialog shows as before. Without the variable
nothing changes, and the debug log gets no line for Bash asks. With it and
`PLANNOTATOR_MOD_DEBUG=1`, `<data dir>/claude-code-mod/debug.log` gets a
`Bash ask (main|subagent): <reason>` line for every Bash ask and a `removal
prompt (…): allowed, as the variable asks` or `left to the dialog: <what kept
it>` line for every Bash prompt (the rule kind, the settings hook, the
plugin's id, the mode, a part that asked for another reason). Plannotator
judges no removal itself. Not covered: `-p`/SDK runs and a mod turned off (the
mod is inert there); hooks the mod cannot see: those in an agent's or skill's
frontmatter (Claude Code keeps them in the session's hooks registry, which no
mod API reads), plugins loaded with `--plugin-dir` or from a session-only
source rather than the registry, and another plugin's hooks module with a
`classic.PermissionRequest` hook beneath the mod (the mod sees what such a
plugin put on the call's verdict, not what it would answer at the prompt); the waiver's own timing conditions, which Claude Code
checks and the mod cannot: managed settings sources still loading or failed
to load, settings changes not yet applied, hook registration still in flight;
Bash ask/deny rules given as CLI flags (`--disallowedTools` and the like, not
in `$.settings.read()`); a several-parts ask whose parts are each allowed by
themselves and which a check other than the removal check raised from the
parts together (none known in bypass mode); a plugin the registry lists but
`enabledPlugins` does not name (Claude Code 2.1.321 did not load such a
plugin's hooks in a real run); a built-in plugin named in `enabledPlugins`
(`<name>@builtin` is never in the registry, so the mod steps aside); and the
Monitor and PowerShell tools. Under a guard
that sends `classic.*` past the mod (`cc-plugin-sec-default`) the hook never
runs and the prompt stays. Tests: `skip-rm-prompts.test.ts` (through the real
hooks, with plugin registries and hooks files in temp folders).

**Plan review off (`PLANNOTATOR_PLAN_REVIEW=0` / `{ "planReview": false }`,
Claude Code only, #2299).** Read at the first `session.start` like the other
switches: the `tool.call` and `classic.PermissionRequest` hooks on
ExitPlanMode call `next(e)`, and the classic command hook exits 0 with no
decision, so Claude Code shows its own dialog ("Yes, clear context" only with
its `showClearContextOnPlanAccept` setting on). In `-p` / SDK runs there is no
dialog; the run's own permissions decide (see the env table row). Older Claude
Code: before 2.1.268 PermissionRequest hooks did not run in `-p` at all, and
before 2.1.287 (no mods) the command hook alone decides, with the same result.
Version skew: a binary older than the switch opens the blocking review from
the command hook, since the mod has already passed the call through.

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
A branched conversation has a new session id, and the Inbox routes a reply by
session id, so the branch's link says which session it continues on every poll
(`continues`, `INBOX_CONTINUES_POLL_FIELD`): `TranscriptForkedFrom` reads it
once per session in a process from the branch's own transcript, where Claude
Code writes `"forkedFrom":{"sessionId":…,"messageUuid":…}` on every row it
copies (read in the 2.1.321 binary's branch code; one `/bin/sh` or PowerShell
call over the file's first 8 MB, the transcript found as the title's is, looked
for again after 2 s doubling to 60 s while it is not there). The Inbox then
hands the branch what waits for the old id once that id no longer polls
("A conversation that goes on under a new session id" in
`inbox-notifications-and-agents.md`). A `--resume` or `--continue` that keeps
its id, and `/clear` (a new conversation), name nothing. Not checked on a live
Claude Code: whether `--fork-session` writes the same rows.
A conversation handed over to a new session is the other case, and the one the
report was: the new transcript has no `forkedFrom`. Claude Code instead ends
the OLD transcript with
`{"type":"continued-in","sessionId":<old>,"continuedInSessionId":<new>}` (read
in the 2.1.321 binary, where it is written when a conversation is moved to a
background session, which starts in another process from the old transcript;
seen in a real transcript about 2.5 minutes after a manual `/compact`, among
`/model` and `/login`, and which of the person's actions led to it is not
known). So the new session looks for the transcript that names it:
`TranscriptContinuedIn` looks through the transcripts in its own project folder
(one `/bin/sh` or PowerShell call for the folder; only the records come back)
and follows the records back, nearest first, up to 8 sessions (A handed to B
handed to C: C says `[B, A]`); a session is named once, so records that point
at each other end the line. A record counts wherever it is and whatever follows
it (a report of 2026-11-10: a conversation still listed as two agents; before,
only a record in a transcript's last 8 KB with no `user` or `assistant` row
after it counted, as Claude Code itself reads it). Whether the old session
still goes on is the Inbox's to judge: one that still polls keeps its own. A cut
or broken record is nothing. The work is capped: the last 64 MB of each
transcript (`TRANSCRIPT_CONTINUED_IN_READ_BYTES`), streamed through `grep` a
line at a time and never held whole, the 200 most recently written transcripts
of a folder (`TRANSCRIPT_CONTINUED_IN_FILES_MAX`), each file's last 4 records,
and 20 s a look (`TRANSCRIPT_CONTINUED_IN_TIMEOUT_MS`; a look that runs out
finds nothing). Looked for at the session's first poll in a process and, while
nothing is found, 5 more times over about a minute (the record is written just
after the new session starts), then once every 10 minutes
(`TRANSCRIPT_CONTINUED_IN_LOOK_AGAIN_MS`); once found, kept for the session in
that process; never at delivery. A session that was already running gets the
new read without a restart: after an update the Inbox reloads its module
("Plannotator reloads itself after an update"), and the new module looks at
its first poll. The poll
sends both cases' ids in the one `continues` list. Not checked: a hand-over
whose new transcript is in another project folder (a worktree move) is not
found.
Beside it, `exportSessionProject` (`controller.ts`) sets
`PLANNOTATOR_SESSION_PROJECT=claude-code:<session id>:<folder>`, the folder
the session's `plannotator_inbox` tool files under (`InboxLink.projectFolder()`,
the session root; with the tool off, `sessionProjectFolder` over the root, else
the cwd), so `plannotator inbox call` and `plannotator card` run from a
`cd`'d shell file under the same project. Set in `currentMod` (not awaited:
every hook, ExitPlanMode included, waits on that switch), at each top-level
`turn.start` and before each shell tool call (a `/cd` or a worktree move
between turns; each waited for at most `SESSION_PROJECT_EXPORT_MS`, 250 ms,
then left to finish behind the hook), written only when the value changes; a
failed write is retried at the next call. Wiring proof:
`inbox-session-project.test.ts` drives the real hooks. See "A session's project" in `inbox-foundation.md`.

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
aborts its turn the moment it starts. A question still queued when the process
moves to another session (`/clear` queued in the turn it waits behind, or an
in-process resume) is dropped the same way: a pending `$.prompt.submit` can't
be withdrawn, so `currentMod` calls `PlannotatorMod.carryQueued`, which hands
every question prompt that may still wait in the engine (a live question's not
started, one Stopped while queued, one carried from an earlier switch:
`TurnTracker.queuedPrompts` / `dropQueued`) to the new instance's tracker. That
tracker aborts the turn when it starts, so no answer runs in the new
conversation, but the aborted turn's user row (the framed question, with its
drafts and context) and an interrupted marker stay in the cleared conversation's
transcript, where the model sees them on the person's next prompt: nothing can
withdraw it (a question Stopped while queued leaves the same). Each carried
prompt follows its submit (`QueuedPrompt`): rejected, it is forgotten at once;
taken, at the next turn's end, so a prompt the engine never ran can't abort the
same words asked again. The window then sees `session_gone`, and Ask again sends
it once (`inbox-ask.test.ts` and `turns.test.ts`; `ClaudeSession.clear` calls
the same `carryQueued`). Claude Code never raises a plugin's own hooks
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
interrupt answers `ok: false`; Plannotator never aborts that turn. An interrupt
that arrives once the launch is not live here (a poll stays open past `/clear`
or a lease move) also answers `ok: false` and aborts nothing, as a question
there is refused `gone`. Plan review does not block the session
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
waits 10-14 s before polling again, instead of taking the server back at once
and starting a busy loop with the other client. It stays under the 15 s poll
wait, so two clients cannot line up. The Inbox's Ask AI runs the same client
(`InboxLink.startAskClient`; "Ask AI" in `inbox-messages.md`), started by a poll
answer that says a question waits, so a session with no question has none.

**The Plannotator Inbox (`plannotator_inbox` and the reply wake, `inbox.ts`).** Where `PLANNOTATOR_INBOX_TOOL` / `inboxTool` allows it at the first `session.start` (on by default here), `register.ts` reads the Inbox's tool list once (`discoverInboxTools`: `tools/list` on its `/mcp`; a stopped Inbox is described by the list it last answered with, kept in `$.store` as `inboxTools`; with neither, the list bundled with the mod, `INBOX_DEFAULT_TOOLS` in `inbox-default-tools.ts`, generated from a real Inbox by `bun run scripts/sync-mod-inbox-tools.ts` and pinned to one by `inbox-default-tools.test.ts`) and registers `plannotator_inbox` (`inboxAgentTool`), a SEPARATE tool, never actions on `plannotator`. So Claude Code has the tool before this computer ever ran the Inbox: the first call starts it. With no `inbox/inbox.json` the link stays silent: no HTTP request and no file (no lease, no claims folder) until a call starts the Inbox, and the wake polls from the next tick after. With the tool, `inbox/inbox.json` present at the first `session.start` (an Inbox has run here) and `inboxReminder` on (default), the conversation's first prompt carries the reminder (`inboxReminderFor`, the line naming the tool's registered full name) as `prompt.submit` `context`, once per conversation (see `inboxReminder` under Config-only settings): the first prompt that is not `isMeta` and not a slash command (`inboxFirstPromptContext`); it counts as reached only once the prompt entered (a dropped prompt does not). `prompt.submit` `context` exists on the mod's floor engine (checked in the 2.1.287 binary: it becomes a `hook_additional_context` row, `hookName: "prompt.submit"`). A **resumed** conversation (`--resume`, `--continue`, an in-process `/resume`, a fork: `$.session.messages()` already holds an assistant row when this process first sees the conversation, at its first `prompt.submit` or main-loop `turn.start` here, `conversationResumed`) gets the session's open Inbox threads on its first prompt here (`readSessionThreads`, bounded by 1.5 s, the Inbox never started; nothing when there is no open thread or no Inbox), and the Inbox is asked once per conversation, not on every prompt. The conversation is classed at that first sight whatever `session.start` has decided yet, so a first prompt that outwaits the gate below (and goes on with no context) still leaves it fresh, and the next prompt carries the reminder. Whether a resumed conversation also needs the reminder is the mod's record in `$.store` (`inboxReminderSessions`, `STORE_INBOX_REMINDER_SESSIONS`: session id to the time its first prompt entered with the reminder, the newest 500 kept), read when that first prompt is submitted: a session id in it gets only its threads; one without it (a conversation from an older mod, whose `prompt.context` block was never in the transcript, or from before the Inbox ran here, or with the reminder off then) gets the reminder too, once, and is recorded. A fork has a new id, so it gets the reminder again (a duplicate line, accepted). An in-process `/resume` back to a session id this process already saw gets its threads again. **Why not `prompt.context` or `classic.SessionStart` (#2243).** Before #2243 the reminder was a `prompt.context` block and the resume list a `classic.SessionStart` hook matched on `source: "resume"`. On Team/Enterprise accounts (and wherever managed settings seat it) Claude Code's built-in `cc-plugin-sec-default` runs in the `prepend` tier and sends events past every user-tier hook: in 2.1.314 `classic.*`, `prompt.context`, `prompt.section`, `prompt.attachment`, `prompt.compose`, `skill.prompt`, `attribution.text`, `session.compact` and `settings.read` (read from the binary). For every hook the engine passes by that way, Claude Code prints `plannotator: its <event> hook was skipped. "cc-plugin-sec-default" runs first and sent the event on past it.` once per session id (each startup and `/clear`), and queues the same line as a hidden note to the model. **A matcher does not prevent it:** the host trims only the plugins above the first one that matches the event, and the guard (outermost, unmatched) matches every one, so a hook of ours whose matcher does not match is still in the chain and still reported (the `{ source: "resume" }` hook printed at every startup). Registration cannot depend on what the machine learned either: `on()` runs only inside `register()`, which runs before `$` exists (an `engine.create` step runs after it, and `$.store` is refused there until the fold), and `on()` after `register()` returned throws. So neither hook is registered anywhere now, and the old learned store key `inboxReminderContextWorks` is no longer read or written (an older mod that finds it still works). **What the guard still makes Claude Code print:** "its classic.PermissionRequest hook was skipped" at the first permission prompt of a session (the hook is matched on ExitPlanMode, which does not stop it; see Plan review) and "its session.compact hook was skipped" at the first compaction, where guarded users also get the plain reminder without the thread list. Subagents: the old `prompt.context` block also reached subagents' first messages (the engine computes one context for both); `prompt.submit` runs only for the main conversation's prompts, so subagents no longer get the reminder, as on guarded machines before. **The engine may raise a conversation's first events before the mod's `session.start` finishes** (seen live on 2.1.310: the first `prompt.context` returned about 230 ms before `plannotator_inbox` was registered), so `session.start` settles a promise with its decision (`reminderGate` / `settleReminderGate`) once the switch, `inbox.json` and the tool's registered name are known, also on its early returns (`-p`, the mod off) and on a throw, before it goes on to the commands and the `plannotator` tool; the first prompt's context waits on it, at most 2.5 s (`REMINDER_GATE_WAIT_MS`, `reminderGateDecided`). (2) After compaction, for everyone: the mod sets `PLANNOTATOR_INBOX_REMINDER` (`INBOX_REMINDER_ENV`) to the text at its first `session.start` (unset when the gate is off; `env.set` is not guarded unless managed `env` names the variable), and `hooks.json` has one `SessionStart` command hook matched on `compact`, `set \' ; printf "%s\n" "$PLANNOTATOR_INBOX_REMINDER" ; : ' ; [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false ; [Console]::Out.Write($env:PLANNOTATOR_INBOX_REMINDER + [char]10) #'` (timeout 5 s). It never starts the `plannotator` binary; the engine trims hook stdout, so an unset variable (mod off, reminder off, `-p`) adds nothing, and a set one adds `SessionStart:compact hook success: <the reminder>` to the conversation after the compaction: the one copy the conversation holds after it (the summary replaced the first prompt's). The command is a sh / PowerShell polyglot, because Claude Code runs a command hook in Git Bash on Windows, else in PowerShell (`-NoProfile`), never cmd. sh runs `set \'` (sets `$1`, silent), then `printf "%s\n" "$X"`, which prints the value byte for byte (a custom text's backslashes, leading `-`, `%`, quotes and `$(...)` included; an expansion's result is never run), then `: '…'`, a no-op whose quoted argument holds the PowerShell half. PowerShell reads `\'` as `\` plus the start of a single-quoted string that ends at the `'` after `:`, so it runs `set` (Set-Variable) with that string as a name, silently, then switches its output to UTF-8 without a BOM and writes `$env:PLANNOTATOR_INBOX_REMINDER` and one newline with `[Console]::Out.Write`, byte for byte with nothing in it run; the closing `#'` is a comment. Both PowerShell 7 (`pwsh`, which Claude Code prefers) and Windows PowerShell 5.1 print it, exit 0 (Windows). Unset, sh prints only a newline, exactly as the earlier `echo "$X"` did, and with the built-in text the bytes are the same as `echo` printed. Proved under sh, bash and dash (and PowerShell when installed) by `inbox-reminder.test.ts`, with a hostile value whose command substitutions would leave marker files. The `plannotator` CLI removes the variable at startup (`scrubModSessionEnv`, `apps/hook/server/mod-session-env.ts`, beside the bridge token and the host result file), so nothing a CLI the mod started spawns inherits it (Claude agent jobs, `claude -p`, included). Before each compaction installs (`session.compact`, not `precompute` or a subagent's), the mod sets the variable again, to the reminder plus a blank line and the session's open Inbox threads (or the reminder alone when there are none or the Inbox did not answer within 1.5 s; never starting it), so the same command hook prints the list (its command unchanged; only `hooks.json`'s description mentions the list), and the variable goes back to the plain reminder at the next main-loop step or turn, keeping thread ids out of Bash children's environment (see "The session's open threads" in `inbox-notifications-and-agents.md`). Gaps: `disableAllHooks` / settings hooks off (no command hooks, so a guarded user has no reminder after compaction); a nested `claude` that Claude itself starts from Bash inherits the variable, and if that run is `-p` (mod inert, nothing set or cleared) and compacts, it prints the parent's line. Tests: `apps/hook/hooks/mod/inbox-reminder.test.ts` (the session record's bound; the hooks.json command run under `/bin/sh` and `/bin/bash`, and PowerShell when `pwsh` is installed) and the engine harness (`apps/hook/tests/register.test.ts`, with an inline `prepend`-tier stand-in for the guard that does `next.to(e, 'append')` on `classic.*`, `prompt.context` and `session.compact` and reports each link of ours the engine bypassed, the trace the transcript notice comes from). The session's `PlannotatorMod` owns an `InboxLink` (one per session id, so `/clear` and an in-process resume follow the new id: the old link is disposed at `session.end` and the next hook makes one for the new id). A call (`tool.call`, answered by the mod) re-reads the registry, checks health against its `serverSession`, starts a stopped Inbox with `plannotator inbox --background` (a one-shot that detaches the Inbox into its own session and waits for it; never a browser tab), and proxies to `/mcp` with `project_path` = `InboxLink.projectFolder()` (the session's start folder, its root, which a shell `cd` never moves; see "A session's project" in `inbox-foundation.md`), or the agent's optional `project_path`, resolved against `$.session.cwd()` by `INBOX_PROJECT_DIR_SCRIPT` and refused before the Inbox is reached when it is not an existing folder and `agent_session` = the host's real session id. The wake: a 1 s `$.clock.every` tick long-polls `/api/inbox/bridge/poll` (20 s) with a 5 to 60 s backoff that never gives up; a reply waits in the mod (unless the person pressed Send now: see "Questions and Send"; the mod then puts it into the running turn with `$.session.append`, unless another plugin's prompt started that turn) until the session has been idle for two ticks (a pending `$.prompt.submit` cannot be withdrawn, so a prompt the person typed, or a `/clear`, queued during a turn goes first), is checked once more with the Inbox (an agent may have read it meanwhile), claimed once across processes (`INBOX_CLAIM_SCRIPT`: mkdir of `claude-code-mod/<session>/inbox/claims/<reply id>`), submitted (`inboxWakeText`), and acknowledged (`delivered`, retried until the Inbox answers). A wake Claude Code drops is not delivered: `$.prompt.submit` does not reject a prompt it refuses, it resolves `{ drop: <reason> }` while it holds plugins' input until someone types (after the person stops the session, Esc or a remote interrupt: "the session was stopped and nobody has sent input since"; seen too after an idle compaction), and `register.ts` turns any `drop` (not `undefined`, `null` or `false`; only a string is kept as the reason) into `PromptDropped` (`submitOrThrow` in `host.ts`). The hold (`heldForInput`) is set first, then the claim is given back, so input that arrives during that release still clears it; the reply stays pending, with no `delivered` and no `reported`, and no delivery is tried until the person's next prompt or a main-loop turn start, so it goes in at the idle after their input. While held, the mod tells the Inbox with `held: true` (`INBOX_HELD_POLL_FIELD`) on every poll and a `state` event when the hold starts or lifts (`held: false`), so the window says "Stopped: goes in when you type in that session" for the waiting reply (approval "inbox-stopped-reply"; see `inbox-window.md`). A review decision, and the classic-plan retry, dropped the same way wait in `submitDecision` (`controller.ts`) for the next prompt or turn start and are tried again; a decision is marked `settled/delivered` only once it went in, so a session that ends while it waits leaves it for a restore to report. A dropped "Ask this session" question ends `failed` with the engine's reason (an empty one gets the server's own fallback, "The session could not answer.", `SESSION_COULD_NOT_ANSWER_TEXT` in `bridge.ts`). A prompt typed into the reply's own turn takes it over as Claude Code folds it in; the mod never aborts it and never delivers the reply again. Two processes on one session: the session's inbox lease (`claude-code-mod/<session>/inbox/watcher.json`, the rules of the review watcher lease: the person's last process wins, 20 s stale) picks the one that polls and delivers, and the claim makes a lease race harmless; a claimant writes `alive` while its turn waits, and a reply whose claimant stopped for 60 s without `delivered` is reported once with a toast (the only toast the connection raises); one marked `delivered` whose acknowledgement was lost is acknowledged by the other process. The Inbox server reads these claim files too (`inboxClaimAbandoned`, `packages/server/inbox-stuck-delivery.ts`): a claim with `reported` and no `delivered`, or, once the session is gone, one whose `alive` is `INBOX_UNDELIVERED_AFTER_MS` old (60 s, in the shared contract), is a stuck reply the person may move to another session. A change to the claim folder's path, its `alive`, `reported` or `delivered` markers, or that cadence changes the Inbox's reading too. Nothing touches the system prompt; the tool list is fixed per process. Version skew: an Inbox without the bridge route (404) just leaves the poll backing off; an action the running Inbox lost answers "update Plannotator"; a `plannotator` without the `inbox` subcommand answers that the binary has no Inbox. An older Inbox ignores `held` (the reply's line reads Sending or Queued as before); an older mod never sends it, and each of its polls clears it.

**A `plannotator-inbox` MCP entry beside the tool.** The mod reads no MCP settings and is unchanged by one. The T3 Code setup (`plannotator t3 --help`) adds `claude mcp add -s user plannotator-inbox -- plannotator inbox mcp --t3`, which interactive Claude Code loads too: there, with no `T3CODE_THREAD_ID`, the shim answers with no tools (`inboxT3EntryIdle`), so `/mcp` lists a `plannotator-inbox` server with no tools and the session has only the mod's `plannotator_inbox`. An entry without `--t3` (one a person added by hand) lists the Inbox's tools as before. See "T3 Code" in `inbox-notifications-and-agents.md`.

**The session's name in the Inbox's To picker (`noteSessionName`, `sessionNamesAfterCommand`).** A session named with `/rename` shows that name; an unnamed one reads as it always did (owner's decision on #2450, 2026-11-01). The engine gives a plugin no way to read a session's name: no `$` call has it, no module event carries it, and `session_title` is only on the classic inputs, whose hooks cost a "hook was skipped" line every session on a guarded account (#2243), so **never add a classic hook for it**. A second `command.run` hook, matched on `rename` and `clear` (aliases resolved: `/name`, `/reset`, `/new`), writes `$.store`'s `inboxSessionNames` (session id → name, newest 500, each name cut to its first 200 characters, `INBOX_SESSION_LABEL_INPUT_MAX`, the most the server reads), and each poll reads it, `""` for none. `$.store` and not `$.state`: `$.state` is held for the session, and a `--resume` is another process that has to find the name. A `--resume` reuses the session id (`--fork-session` is what makes a new one), so the entry is found again; the engine restores the name for itself from the transcript and tells no one.

The hook calls `next(e)` first and returns its answer untouched: a command that threw names nothing, and `/clear` has moved the session id by then. A real session on 2.1.316 showed no credit line (`plannotator: …`) on `/rename` or `/clear` with this hook in place; that is the one version it was watched on. The command never pays for the label: `$` failing before `next` only skips the name, and the write after it is bounded (`SESSION_NAME_WRITE_MS`, 500 ms), so a store that never settles leaves the name unkept and the answer on time. It writes only a change, because the record is read and written back whole and a write of nothing new could only undo another session's. It writes once `session.start` has decided the mod is on, or before it has decided, since a first `/rename` can beat it; a `/rename` in that gap with the mod off leaves an entry nothing reads, and after the decision the knob-off hook passes straight through. Read from the 2.1.316 binary, same shape in 2.1.312:

- `/rename <name>`: `e.args` is the name. `/rename` is `local-jsx`, so on every interactive path `next(e)` resolves with no `text`: `args` is all there is. Its final name can differ: if another live session on the machine holds it, the engine picks another, and the label still shows what was typed.
- Bare `/rename`: the model makes the name up, and neither `args` nor the answer has it. The session then reads as unnamed, since the name it had is no longer its name.
- `/clear`: the engine writes the name onto the new session id (`clearConversation`, `T` → `saveCustomTitle`), so the name goes with it. `/clear <name>` names the session it left and the new one has none. A new instance starts with the next event (`currentMod`), so the label follows then.
- Not seen, and showing no label: `claude --name`, a rename from a phone or the bridge (`saveCustomTitle` with source `remote`), the resume picker's rename, a fork, a name given before this version. A plan approval's "clear context" reaches the same clear with no command, so the engine keeps the name and the new id has no label until the next `/rename`.

**The transcript's title first (`TranscriptTitle`, `claudeTranscriptPaths`, issue #2450).** Most of the misses above are names the engine wrote to the transcript as a `custom-title` line (`{"type":"custom-title","customTitle":…,"sessionId":…}`): a bare `/rename`, `claude --name`, a rename from a phone, the resume picker's. So each poll's `label` asks the transcript first and falls back to the `/rename` store only when the transcript has no say (`sessionTitleOf` in `register.ts`). The transcript is `<CLAUDE_CONFIG_DIR, else $HOME/.claude>/projects/<folder with every character but letters and digits turned into "-">/<session id>.jsonl`, tried for the first root, the root and the cwd; a folder whose slug passes 200 characters is skipped (the engine adds a hash there), and a session id outside `[A-Za-z0-9._-]` is never a path. It stays cheap on every poll: a `$.fs.stat` per poll and nothing more while the size is unchanged; when it grew, one `/bin/sh` (5 s timeout) reads only the new bytes (`tail -c +offset | head -c length | LC_ALL=C awk`, `TRANSCRIPT_TITLE_SCRIPT`) and prints the `custom-title` lines plus an `end:` line, so a half-written last line is read again whole next time. The first read is the last 4 MiB at most, and so is any read past 4 MiB of new bytes (read from the end). A last line with no newline yet is read again whole once the file grows, never on every poll. The latest title of this session wins (another session's line, a quoted mention in a message and a line that does not parse are skipped; 200 characters at most); `""` is a title cleared. A file that shrinks is read from its end as new; another inode under the path (the script prints `ls -di`'s) is a rewrite at any size, so the old title is dropped and the new file's end is read; a transcript not found is looked for again after 60 s. A failed or timed-out run keeps the last title and the offset, waits 5 s before the next try, doubling with every failure in a row (a skip does not start it over; only a read that works does) up to 5 min, and the third failure in a row of one region skips it (`TRANSCRIPT_TITLE_FAILURES_MAX`). A rewrite to exactly the same size is seen only when the file next grows. The server refuses a title that reads as "You", since the session's own model can append the line. Limits: Windows (no `/bin/sh`), an over-long project path, and a title older than the last 4 MiB at the first read fall back to the store. A model could write a `custom-title` line with a tool, but the label is display only and routes nothing. Tests: `apps/hook/hooks/mod/inbox-session-title.test.ts` (real temp transcripts and a real `/bin/sh`; `CLAUDE_CONFIG_DIR` in a scratch folder, never the real `~/.claude`).

**Plannotator reloads itself after an update (`auto-reload.ts`, owner approval "cc-auto-reload", 2026-11-07, with its 19:00Z addendum).** One judge: the Inbox. The mod's Inbox link sends `auto_reload: true` on every bridge poll (`INBOX_AUTO_RELOAD_POLL_FIELD`), and while `claudeSessionOutdated` (the rule Settings → Agents and the sidebar show, from the poll's `plugin` field and Claude Code's plugin registry) says the session is outdated with fix `restart`, each poll answer carries `reload: { installed }` (`INBOX_RELOAD_FIELD`, `reloadOfferFor` in `inbox-sessions.ts`). No running Inbox, no offer: the session keeps today's manual `/reload-plugins` path. `fix: "update_plugin"` (the installed plugin is itself behind the Inbox) and a `--plugin-dir` or directory-marketplace session never get one. From the Inbox tick (a `$.clock` timer, never a hook a turn waits on; not awaited by the tick), `AutoReload` runs `$.command.run({ command: 'reload-plugins', args: 'plannotator' })` once per installed version per session, only when `reloadBusyReason()` is null (no main-loop turn or Ask question; no open review or decision waiting to go in; no Inbox reply handed out, being delivered or put into a turn, no Ask AI client: `InboxLink.hasWorkInFlight`), no prompt is on its way in (inside `prompt.submit` until the hooks beneath finish, with no time limit; then, for one that entered as a new turn, until its `turn.start`, or 30 ticks for one that starts none), and the prompt box is empty (`$.prompt.read()`, which never rejects and reads `''` where no box is mounted, such as under a full-screen panel). The record is `$.store` `autoReloads` (session id to `{ version, at, from, outcome, tried }`, newest 50; `tried` holds the session's last 10 versions, so an Inbox that names A, B, A, B runs twice, not four times), so it outlives the reload: a reload that loads nothing new is never tried again and the Inbox keeps the manual notice for that session (the fallback; no retry). Nothing runs until the store kept the `pending` record (written, then read back with the same `at`): a store that refuses (over 4 MiB in all) or fails means no reload, tried again 60 s later, never a loop. The module also keeps the versions it ran for in memory (shared by its instances, so a `/clear` does not run again), a backstop for a store that loses the record later. Background agents and subagents never hold it (follow-up approved 2026-11-07T21:09Z: the owner asked that it "never stop work", and a live `/reload-plugins` with a real module swap under a running two-step background agent left the agent finishing both steps on the new code): a turn with an agent id is not counted at all, neither as busy nor as the main turn, and `$.agent.list()` is not asked. After the store calls the box and every other gate are checked again, the last of them with no await before `run()`; when one fails then, the record is put back as it was (a put-back that fails leaves it `pending`: that version is not tried again in the session). Each reason a look stops is a debug line, once per change of reason. A run the engine refuses before it runs (after an Esc with no input since) is tried again only after the next main-loop turn starts, at most 3 times per version; the refusal is written only over that run's own `pending` record, never over what a newer module wrote. Never `--force`: Plannotator declares no MCP or LSP servers, so `/reload-plugins`' prompt-cache stop comes only from another plugin's pending change, and forcing would apply it and re-read the conversation uncached; the stop's text is shown and the fallback applies.

What the chat shows: the engine's echo, `❯ /reload-plugins plannotator` (the command reads only `--force`/`force`, read in the 2.1.319 binary; Claude Code skips a plugin's `ui.render` hook on rows its own code raised, "ui.render skipped: re-entry", seen live, and the owner accepted that line). The output row is hidden by a `ui.render` hook on `CommandOutput` / `reload-plugins` only when `hidesReloadOutput` reads our argument and a plain `Reloaded: …` with no error, warning, "not applied", `--force` or "could not"; anything else draws as always. The row carries no origin, so a `/reload-plugins plannotator` the person types is hidden the same way; a plain `/reload-plugins` (or any other argument) the person types draws as always. The row is drawn by the module the reload loaded, often before its `session.start` decided, so it is hidden until a decision says the mod is off.

After the run: the new module's first instance checks in (`checkInAfterReload`: the record is `pending`, this module loaded after the run was queued, at most 30 min after, since the engine runs it once the session is idle, and checks in within 60 s of loading) and records its version (`did_not_take` when it is not the version asked for: the reload loaded old code), then whether its tools registered (`plannotator`, and `plannotator_inbox` where on) and its Inbox link's first answered poll; its poll reports the new `plugin`, which ends the offer and takes the session off Settings → Agents' list and the Inbox's `/reload-plugins` prompts (no Inbox change needed for that). An old module still running 30 s after its run resolved (`AUTO_RELOAD_CHECK_IN_MS`) records `did_not_take`. Every step is a debug-log line (`PLANNOTATOR_MOD_DEBUG=1`).

What `/reload-plugins` touches (2.1.319 binary, `refreshActivePlugins`): it clears the plugin caches and re-reads every enabled plugin's commands, skills, agent definitions, plugin MCP/LSP config (behind the cache stop above) and hooks, applies staged installs of every plugin, and reloads the hooks modules that changed (each loses its timers and in-memory state; `$.state` and `$.store` stay). It does not touch the task list: background Bash tasks, Monitors, running subagents, `/loop`, ScheduleWakeup and cron keep running. So the gate does not wait for any of them; it waits for the main turn, a prompt being typed or submitted, and Plannotator's own work, the one state a module reload would drop. A new module restores open reviews from the store as on any `session.start`, but the gate keeps a reload away from them anyway. Tests: `apps/hook/hooks/mod/auto-reload.test.ts`, `apps/hook/hooks/mod/auto-reload-register.test.ts` (the gates wired through the real registered hooks), `packages/server/inbox-auto-reload.test.ts`. A live check on a real cache install (plugin from GitHub into Claude's cache) is still owed.

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
`claude-code-mod/debug.log` in the data dir. The Inbox connection is proved against a REAL Inbox in `apps/hook/hooks/mod/inbox.test.ts`: `plannotator inbox --background` under a temp data dir (the compiled binary when `PLANNOTATOR_INBOX_TEST_BINARY` names one, as `.github/workflows/inbox-claude-code.yml` runs it; the CLI from source otherwise) and the mod's own code on a Host of real processes, HTTP and files (`testing/claude-session.ts`, which simulates the conversation the way `register.ts` feeds it): with no registry the tool comes from the bundled list, nothing polls or writes, and the first call starts the Inbox and lands its message, after which the wake polls; the tool carries what the Inbox's `/mcp` offers, `send_message` lands a thread, the window's Send arrives once as a turn with the stable header and the reply verbatim (delivered, then replied), a typed prompt goes first and takes the reply's turn over, `/clear` follows the new id, two processes deliver once, and a dead Inbox is started by the first call with no browser tab. `apps/hook/hooks/mod/inbox-session-end.test.ts` (a real Inbox in process) proves that another session's or a subagent's `session.end` leaves an idle session's wake running, and that the self-heal makes a disposed instance again and the waiting reply goes in once; `register-self-heal.test.ts` drives the real registered hooks on a fake `$` (the dispose rule, the self-heal armed, rebuilding and armed again, a healed link leaving another process's lease alone), and `self-heal.test.ts` pins the rule and the tick re-arm. `INBOX_PROOF_DIR=<dir>` keeps a transcript per proof. The engine harness (`apps/hook/tests/register.test.ts`) covers the wiring with the engine's own `$`.
