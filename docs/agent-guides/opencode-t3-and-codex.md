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
bare gated approval still sends nothing. A code review's bare Approve was
always delivered here (and on Pi), so a review's `gate` changes nothing on
OpenCode or Pi; it is accepted because the contract is shared. A list of files (two or more after the
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

### OpenCode 2: sessions the Inbox starts

In a server the Inbox started (`PLANNOTATOR_INBOX_LAUNCHED=1`), the plugin's wake watches each root session as it is created (`session.created`), not only once it ran, so the Inbox's first message reaches a session that has had no turn; with `PLANNOTATOR_INBOX_LAUNCHED_SESSION` it watches that session from the start (a restart). The rest is "OpenCode" in `inbox-launch.md`. Test: `inbox-v2-wake.test.ts` "OpenCode 2 started by the Inbox".

### OpenCode 2: a prompt waiting in the terminal (Inbox)

The plugin's Inbox link says `blocked: { kind }` on its polls and in a `state`
event while a session waits on the person in OpenCode (`noteOpenCodePrompt`,
`openCodeBlocked` in `apps/opencode-plugin/inbox.ts`): `permission.asked`
holds a `permission` until `permission.replied` for that request;
`question.asked` holds a `question` until `question.replied` or
`question.rejected` for that request (`requestID`; the names in the installed
SDK's v2 types, 1.19.3); `form.created` holds one until any later `form.*`
event for that form. A permission wins over a question. Everything clears when
the turn ends (`session.execution.succeeded` / `failed` / `interrupted`),
whenever the plugin finds the session not running by any other way (a lost end
event found by the idle cross-check, the event stream gone, the session
deleted: `endOpenCodePrompts`), and nothing is said for a session it does not
think is running. The Inbox's 45 s expiry does not bound a stale word: it
guards only against a plugin that stops polling, so the plugin itself must stop
saying it. Only the kind leaves the plugin, never the action, patterns or the
question's words. Which question events a real OpenCode 2 raises is not yet
proved on one. The Inbox side: "Status marks for every agent" in
[inbox-notifications-and-agents.md](inbox-notifications-and-agents.md). Tests:
`apps/opencode-plugin/inbox-blocked.test.ts`.

### OpenCode 2: the installer updates a running service's plugin

The OpenCode 2 service keeps the plugin it loaded. When it is running with an
unpinned `@plannotator/opencode` spec, `install.sh` runs `opencode2 plugin
update <spec>` (`update_opencode2_service_plugin`), which loads the new plugin
without cancelling a turn, a pending permission, a question form or an open
Plannotator review (measured on OpenCode 2.0.22, 5 of 5; `opencode2 reload`
cancels the permission and the form, so nothing automatic uses it). The step
only asks the service, bounds every call, reads the result back from `plugin
list`, never fails the install, and keeps the OpenCode 2 cache while the
service has the plugin. There is no "reload when every session is idle"
action in the Inbox: idleness cannot be held between the check and the
reload, and `plugin update` needs no idle gate. Details and knobs:
`PLANNOTATOR_OPENCODE2_TIMEOUT` in [environment.md](environment.md).
`install.ps1` / `install.cmd` have no OpenCode 2 step yet.

### OpenCode: in-process servers in `plannotator sessions` (#1567)

The plugin's own servers (submit_plan's plan review, `/plannotator-review`,
`/plannotator-annotate`, `/plannotator-last`) run inside OpenCode's process, so
the plugin lists them itself (`apps/opencode-plugin/session-registry.ts`):
`registerInProcessSession` in `packages/server/sessions.ts` writes
`sessions/opencode/<pid>-<port>.json` with `host: "opencode"`, and the
`plannotator sessions` table marks the row `(in OpenCode)` (`--json`: `host`).
They do not run the binary, so they must never hold back its update: the
entries live in a subfolder that `listSessions` / `listLiveSessions` never
read, as no released binary does (every reader lists only the top folder's
`*.json`), and `otherOpenSessions` and the Inbox update dialog also skip any
entry with `host`. Removal: the decision or a throw (`decideListed`, before
`stop()`), submit_plan's abort and timeout (`finally`), and process exit. No
SIGINT/SIGTERM listener is added (it would change OpenCode's own signal
handling); instead each registration deletes entries whose pid is dead, and
`listInProcessSessions` drops and deletes an entry whose pid is dead, whose
loopback port no longer accepts a connection, or that cannot be read. Commands
list the project they detected (or `unknown`); only the plan review detects it.

### OpenCode: which reply `last` opens (#3312)

`/plannotator-last` and the tool's `last`, on OpenCode 1 (embedded runtime and
CLI bridge) and OpenCode 2, read the session through one function,
`pickRecentAssistantMessages` (`apps/opencode-plugin/recent-messages.ts`). It
opens the newest reply to a prompt the person wrote, not a reply to an
injected prompt (an OpenCode 2 `synthetic` row, or an OpenCode 1 user message
whose parts are all synthetic) that OpenCode or a plugin added; such a reply
opens only when there is no other. A reply belongs to its turn's prompt.
OpenCode 1's `parentID` counts only when it names a prompt the person wrote,
since OpenCode 1 parents the rest of a turn on the injected rows it adds inside
it (the "Continue…" row after an auto-compaction, a subtask command's
"Summarize the task tool output…" row). Otherwise the newest prompt row starts
the turn, and an assistant step ends it unless it called a tool the host runs
(not a provider-hosted one, as OpenCode's own `needsContinuation` decides) or
stopped at the output limit (`finish: "length"`); a failed step always ends
it. An injected row stored after a step or a compaction of a running turn, or
OpenCode 2's Plan-mode reminder right after the prompt (entry, or exit after
a revert across a Plan→Build switch; `isOpenCode2PlanReminder`,
`isOpenCode2PlanExitReminder`), stays in that turn: Plannotator's session-URL
notice, OpenCode's continuation rows. Any other injected row right after a
prompt starts its own turn (that prompt got no reply). Known limit: another
plugin that stores a row from a context hook, before the first step as the
Plan plugin does, demotes the person's answer. Compaction rows do not
change the turn, and a compaction summary (`summary: true`) is listed but
opens only when nothing else can. One injected row counts as the person's: an
OpenCode 2 background subagent result (`<subagent sessionID="…">`, from
`SubagentCompletion.deliver`) whose child session is named by a `subagent`
tool call in one of the person's turns, so the reply to that result opens. A
result for a subagent that a wake's turn started, or that no turn here names,
stays injected. A subagent command (`subtask` in the command config) starts
its child with no tool call in the parent, so its result stays injected. Not
handled: the retry row after an incomplete stream follows a failed step, so its reply counts as injected. The
picker lists the reply that opens first (★), then the rest newest first,
capped at 25; the one that opens is kept even when 25 newer replies to
injected prompts exist. `toBridgeMessages` carries a V2 step's `error` and
`finish`, and a row's `text` as a text part. Pi and Claude Code still open the
newest reply with text. Tests: `apps/opencode-plugin/recent-messages.test.ts`.

### T3 Code: Ask this session through an optional Claude hook (opt-in)

`packages/t3-code` (user notes in its README). T3 Code runs Claude through the
Agent SDK, which loads `~/.claude/settings.json` hooks, so a Claude Bash hook
connects ordinary `plannotator review` / `annotate` / `last` commands in a T3
conversation to that conversation: Ask this session becomes a T3 turn, and the
decision arrives as a T3 message. It uses T3's existing MCP API as a client
(no T3 change, no provider-side MCP server, no skill change). Nothing of it
runs for anyone who did not opt in.

The same grant (`plannotator t3 login`) also lets the Plannotator Inbox put a
reply into a T3 Claude thread as a turn, with a `plannotator inbox mcp --t3`
entry: see "T3 Code" in `inbox-notifications-and-agents.md`. That is why
`plannotator t3` is listed (`plannotator --help` points at it, the skill
documents it); its help leads with that setup.

On the machine that runs T3 no grant is needed: the Inbox sends a reply into
a T3 thread, Claude or Codex, with T3's own `t3 thread send`, and a Codex
thread T3 runs is never `codex queue`d ("A thread T3 Code runs" and "T3 Code"
in `inbox-notifications-and-agents.md`). The grant is for a T3 on another
machine. Not on Windows yet: there the local route is off, and a reply goes
in under a grant or waits for the agent's next read.

Where Claude Code runs hooks modules, the Claude Code mod runs in a T3
thread's Claude by itself (T3 0.1.7 and later; "A T3 Code thread" in
`claude-code-mod.md`): it gives the thread `plannotator_inbox` filed as the
thread, puts the Inbox's reply in as a turn while T3 keeps that Claude (only
the process that shows T3's own `t3-code` tools polls; no grant needed), and answers
`plannotator review` / `annotate` / `last` itself. The hook then stands aside
(`claudeModServesThread` in `prepareT3Hook`: the mod's tag `t3:<thread>` in
`PLANNOTATOR_SESSION_TAG`), so no command is acted on twice; it stays for a
Claude Code without hooks modules or with the mod off. The grant remains the
Inbox's way into a thread once T3 released its Claude.

- **Opt in / out:** `install.sh --with-t3` writes one `PreToolUse` `Bash` hook
  into `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json` (`t3-hook install`,
  `packages/t3-code/install-hook.ts`: other hooks and settings kept, a
  `.plannotator-t3.bak` backup before the first change); `--without-t3`
  removes only it. Both are remembered in `install-flags.json` (`with-t3`,
  `without-t3`; POSIX only, no PowerShell spelling) and skipped by
  `--minimal`; a failing step warns and never aborts the install. Without a
  flag the installer touches nothing T3. `plannotator t3 login --url <T3 MCP
  URL>` authorizes once (OAuth, PKCE); `plannotator t3 logout --url …` stops
  that endpoint's workers and deletes the saved grant. `t3-hook` is in
  `HIDDEN_SUBCOMMANDS`; `t3` is not.
- **The gate (per Bash call cost):** the hook runs on every Bash call of every
  Claude session that loads the settings file. The command is
  `case "$CLAUDE_CODE_ENTRYPOINT" in sdk*|t3-code) PLANNOTATOR_DATA_DIR=… '<binary>' t3-hook;; esac`
  (`t3HookCommand`, `packages/shared/t3-hook-command.ts`): only an Agent SDK
  session (T3 names itself `t3-code`; other SDK apps report `sdk-ts`, …)
  starts the binary; an interactive `claude` (`cli`)
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
  logged (a gated approval, annotate or review, is sent; `t3 review --gate`), over 12 KB written to the
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

### Codex PostToolUse hook and steering: a reply into a running turn

The owner (2026-11-24): "I think what we typically want is a way to like inject it as like steering." A person's
reply to a Codex thread that is in a turn goes into that turn; everything this cannot do still goes as the next turn
through `codex queue`, so no reply goes worse than before. One switch, `INBOX_CODEX_BUSY_REPLY`
(`packages/server/inbox-codex-steer.ts`): `"steer"` (the owner's pick, option a) or `"next_turn"` (as before). The
code: `inbox-codex-steer.ts` (routes and policy), `inbox-codex-control.ts` (the socket client),
`packages/shared/inbox/codex-hook-mailbox.ts` (the hook's mailbox and claim), `packages/shared/codex-hook-command.ts`
(the hook's command), `apps/hook/server/codex-hook.ts` (the hook), `packages/server/inbox-codex-sight.ts` (the proof it
arrived). Proof: `packages/server/inbox-codex-steer.test.ts` (fake socket, fake `codex`, scratch rollout and
hooks.json), `packages/shared/codex-hook-command.test.ts` (the gate under sh and zsh, the installer's string, merge and
removal), the launch cases in `packages/server/inbox-launch-codex.test.ts`, and the uninstall cases in
`packages/server/uninstall.test.ts`. None of it was run against a real, signed-in Codex.

- **Delivered only on evidence.** A reply handed into a turn (by the hook, the socket or a launched thread's host)
  reads "Handed to Codex; it takes this at its next step." until its words show in the thread's rollout after the
  offset taken when it was handed (`inbox-codex-sight.ts`: a `response_item` message or `user_message` event holding
  the text). Seen before any turn boundary: delivered with `into_turn: true`; seen after one: delivered as a new turn.
  The turn ended (`task_complete` / `turn_complete` / `turn_aborted`, Esc included) with the words not seen, the
  file read to its end and untouched for 10 s (`CODEX_SIGHT_QUIET_MS`): the claim is dropped and `codex queue` gives
  it as the next turn, never into a turn again (`nextTurnOnly`). The proof survives a restart (`hooked.json` /
  `steered.json` keep the rollout, offset and turn). A steer with no rollout found is recorded delivered as before
  and logged (it cannot be checked). Assumed, not seen live: that Codex writes the hook's `additionalContext` and a
  steer's input into the rollout as a message holding the text; if it does not, a reply could come twice (once in
  the turn, once as the next turn).

- **The Codex app (and any Codex the socket cannot reach): the hook.** The app runs its own app-server over stdio
  (`initialize_processor.rs` names the host `Codex Desktop` on a stdio connection; openai/codex#48928), so no other
  process can reach its threads. It runs the same hooks as the CLI (`$CODEX_HOME/hooks.json`, Settings → Hooks in
  the app). While the thread's rollout (`$CODEX_HOME/sessions/…/rollout-…-<thread>.jsonl`, the last `event_msg`
  `task_started` vs `task_complete` / `turn_aborted`, read from its last 512 KiB; a file untouched for 20 minutes is
  not believed) says a turn runs, the PostToolUse hook is in that `hooks.json` and this Codex has run our hook since
  `hooks.json` last changed (below), the wake does not queue the reply: it writes it to
  `<data dir>/inbox/codex-hook/<thread>.<item>.json` (thread lowercased; handed, see above). After the turn's next
  successful tool call Codex runs the hook, which claims the item with the wake's own mkdir claim
  (`inbox/codex-queue/<item>.<thread>/`, plus `hooked.json`, written before it answers) and answers
  `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":<the wake text>}}`; Codex adds it to the
  turn as a developer message before its next model request (`core/src/tools/registry.rs`, `hook_runtime.rs`). The
  wake looks every 2 s while it holds or watches anything; a turn that ended before the claim (or a hold older than
  30 minutes) releases the hold and `codex queue` gives it as the next turn. Whoever makes the claim sends it, never
  both. A claim the hook made without `hooked.json` for 30 s (the hook died before answering) is dropped and queued.
  The hook takes only its own root thread's reply: a payload with `agent_id` (a subagent; its `session_id` is the
  root's), or whose `transcript_path` is not `rollout-*-<session_id>.jsonl`, takes nothing. A reply over 8 KiB
  (`CODEX_HOOK_CONTEXT_MAX_BYTES`, and replies taken together stay under it) is never held: it goes by `codex queue`
  as the next turn, so Codex never spills it to a file (`hooks/src/output_spill.rs`). Held files no claim waits for
  (a crash, a reply taken back or read) are cleared at startup and each sweep.
- **Reviewed hook only.** Codex runs a new or changed hook only after the person reviews it. The hook records each run
  in `<data dir>/inbox/codex-hook-ran` (the gate touches it, the binary too); the wake holds a reply only when that
  note is newer than `hooks.json`. Until then every reply to a busy Codex goes as its next turn, and the server logs
  once: "Plannotator's Codex hook has not run yet: Codex runs it once you review it (Settings → Hooks, or /hooks).
  Until then a reply to a busy Codex goes as its next turn." A person-facing line for this is proposed, not shown:
  `CODEX_HOOK_REVIEW_TEXT` in `packages/core/inbox-delivery-line.ts` (with the owner).
- **The hook's command and cost.** Codex runs a hook with the person's shell (`<shell> -c`, zsh on a Mac, where an
  empty glob is an error), so the command is `/bin/sh -c '<gate>'` (`codexHookCommand`, with the binary and the
  `hooks.json` path baked in): a missing binary exits 0 at once, silent; the binary starts only while a file for this
  payload's thread (`session_id` read from the first 512 bytes with `dd`, passed on in
  `PLANNOTATOR_CODEX_HOOK_HEAD`) waits in `~/.plannotator/inbox/codex-hook/` or
  `$XDG_DATA_HOME/plannotator/inbox/codex-hook/`, or when PLANNOTATOR_DATA_DIR is set; otherwise one `sh`, a `dd` and
  a few globs per tool call, no output (no effect in Codex). `plannotator codex-hook` is not a listed subcommand; it
  answers before any startup work and never fails a tool call.
- **Install.** `scripts/install.sh` writes it beside the Stop hook, in the same `hooks.json`, under the same rules
  (`--skip-codex` and `skipInstall.codex` skip both; a custom Plannotator Stop hook it leaves alone means it adds no
  PostToolUse hook either): its own `PostToolUse` group, no matcher, `timeout: 10`, updated in place on a reinstall
  (its position kept, so the trust of other hooks holds), never touching another hook. `plannotator update` runs the
  installer, so existing installs get it, and it prints "Codex: review Plannotator's new hook in Codex (Settings >
  Hooks, or /hooks) so an Inbox reply can reach a running turn." Once written it notes `<config dir>/codex-hook-installed`;
  a later run that finds the hook gone (the person removed it) leaves it out and says so. Without node the fallback
  text names both hooks. Windows installs write no Codex hooks (as before). Uninstall removes both hooks and the note;
  its leftover check sees the binary inside `/bin/sh -c '…'`.
- **A terminal Codex on the background server (0.157+): the socket. Off** (`INBOX_CODEX_STEER_SOCKET = false`; the tests
  turn it on with `socket: true`). Its `initialize` changes the background server's user-agent suffix for other
  clients, it does not check the thread belongs to this person's Codex beyond the socket path, and its `turn/steer`
  input was never seen in a real rollout; turn it on only once a real Codex proves it free of side effects. When on,
  tried first. `$CODEX_HOME/app-server-control/app-server-control.sock`,
  WebSocket over a Unix socket (`GET /rpc`, plain text frames, no `jsonrpc` field): `initialize`,
  `thread/loaded/list` (only a thread that server holds; never loads one), `thread/read` (status `active`),
  `thread/turns/list { limit: 1 }` (else `thread/read { includeTurns: true }`) for the `inProgress` turn, then
  `turn/steer { threadId, expectedTurnId, input: [{ type: "text", text, text_elements: [] }] }`. "no active turn to
  steer" or "expected active turn id … but found …" reads again once; idle, not loaded, no socket, a refusal (a review
  or compact turn) or an older server: the hook or `codex queue`. A steer written and not answered is uncertain, never
  sent again. The connection does not subscribe, so no approval comes to the Inbox; its `initialize` sets the
  background server's user-agent suffix to Plannotator's until another client initializes (Codex's own behaviour).
  Codex drops steered input the turn had not read yet when the person presses Esc (`tasks/mod.rs`
  `handle_task_abort`): the words never show in the rollout, so the reply goes as the next turn (see "Delivered only
  on evidence").
- **What does not steer.** A turn that makes no tool call after the reply (it only thinks or writes) fires no hook:
  the reply goes as the next turn, as before. Nothing reaches a single model response while it runs. `codex exec`
  is never woken.
- **The line.** Delivered into the turn: "Delivered to Codex, <time> · went into its running turn"
  (`INTO_RUNNING_TURN_TEXT`, from the delivery's `into_turn: true` with no mark). A new turn and the fallback keep
  their words.
- **Linked computers.** Each Inbox delivers to its own Codex: a reply written on another computer is forwarded to the
  thread's home Inbox and takes the same route there (test: "a reply sent from the linked computer").
