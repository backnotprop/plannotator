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
