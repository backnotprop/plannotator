## How the Inbox turns on

The owner's rule, in their words: "Installing Plannotator should not put the inbox on at all. You have to run inbox first. You have to purposely want to use inbox."

So the Plannotator Inbox is off on every computer until the person turns it on there, and every way an agent could reach it or start it asks first.

### The record

The record is `state.json` → `inboxOn` in the data dir: `{ on, at, by, notes? }`.
- It is per computer: state.json, never config.json, which may roam with dotfiles.
- `inboxOn` is in `MACHINE_STATE_KEYS`. It is written by `updateMachineState` (config.ts): state.json only, under config.json's lock, as a compare-and-set, and never needing config.json, so a hand-broken config.json does not block it.
- The record is read only from state.json.
- `inbox-on-decided` beside state.json is written with the first record and never removed. A record that is lost later (state.json deleted or set aside as corrupt) reads as off (`record-lost`), so the evidence never decides again and never undoes the person's off.
- The shape and the pure reader are `inboxOnRecord` / `inboxOnFromState` in `packages/shared/inbox/inbox-on-contract.ts`. The Claude Code mod has a byte-for-byte copy in `apps/hook/hooks/mod/inbox-on-contract.ts`, and `inbox-on-contract.test.ts` keeps the two equal.

The one gate is **`isInboxOn(dataDir?, env?)`** in `@plannotator/shared/inbox/inbox-on`. Every gate calls it:
- the agents' tool on each host;
- the reminder;
- the MCP server's tools;
- every start of the Inbox.

The writers are `turnInboxOn(by)`, `recordInboxOff()` and `writeInboxOnRecord()` (with `ifAbsent` for the one-time decision, `ifCurrent` for a follow-up write) in the same file.

`by` says what last set the record:
- `command`: the person's own `plannotator inbox`.
- `slash-command`: `/plannotator-inbox`.
- `inbox-on`: `plannotator inbox on`.
- `settings`: not written any more (no page turns the Inbox on; see below). Kept for records from earlier builds.
- `off`: Turn the Inbox off.
- `update-used`, `update-ran`, `update-agent-only`: the one-time decision for an install from before the rule (below).
- `record-lost`: see the decided mark above.

`notes: 'remove'` means Plannotator's untouched notes in agents' instruction files are still to be removed. It is cleared once they are, in the same run. `notes: 'left'` means some could not be removed (a damaged or read-only file): nothing retries by itself, `plannotator inbox status` says so, and `plannotator inbox off` tries again.

### What turns it on (the person's acts)

- **Their own `plannotator inbox` in their own terminal.** This covers bare `plannotator inbox`, `--no-open` and `--open` (`isPersonsInboxRun` and `personsTerminal` in `apps/hook/server/inbox-on-command.ts`). "Their own terminal" means all three:
  - none of `INBOX_AGENT_SHELL_MARKERS`: `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `PLANNOTATOR_SESSION_TAG`, `T3CODE_THREAD_ID`, `CODEX_THREAD_ID`, `PI_SESSION_ID`, `OMPCODE`, `OPENCODE`, `GEMINI_CLI`, `QWEN_CODE_SESSION_ID`, `QWEN_CODE`, `COPILOT_CLI`, `CURSOR_AGENT`, `DSH_SHELL`, `DSH_SESSION_ID`;
  - none of `INBOX_HOST_START_MARKERS`: `PLANNOTATOR_INBOX_LOGIN_ITEM` (the routines' start at login sets it) and `XPC_SERVICE_NAME=ai.plannotator.inbox` (a login item written before that);
  - a terminal on both stdin and stdout.

  An agent's shell tool runs commands without a terminal, and so do launchd and systemd. So an agent the list does not know (Amp, Droid, Kiro, Windsurf, Cline, Hermes, OpenClaw, Goose, ...) is refused like one it knows. The gap left: an agent with no marker that types into a real terminal (an IDE agent in the integrated terminal) looks like the person; its `plannotator inbox` then opens the window in front of them. A person's own `! plannotator inbox` inside Claude Code carries `CLAUDECODE` and cannot be told apart from Claude's own run, so it is refused; the person uses their terminal or `/plannotator-inbox`.
- **`/plannotator-inbox`.** Plannotator's own runners pass the hidden flag `--from-slash-command` (`INBOX_SLASH_COMMAND_FLAG`) to the `plannotator inbox --open` they run, and that run counts even inside the agent. A flag, not an environment variable, so it works in PowerShell and cmd. The runners, and why each is the person's:
  - the Claude Code mod (`controller.ts` `openInbox`): only for a command whose origin is the person (`commandByPerson` in `enabled.ts`: `composer`, `bridge`, a panel's `sdk`); one the model invoked, or with no origin, gets the plain open, which an off Inbox refuses;
  - Pi and OpenCode (`openInboxInBrowser` in `agent-link.ts`): their slash commands are the person's only;
  - Droid and Amp: their commands are the person's;
  - Gemini's toml (`!{...}`): custom commands are typed by the person;
  - the Claude skill's `!` line and the core `plannotator-inbox` skill (Codex `$plannotator-inbox`): both skills are model-disabled (`disable-model-invocation: true`; Codex `allow_implicit_invocation: false`). The core skill is read by the agent, which then runs the flag; an agent that read it once in a session knows the flag. Hosts that read the core skill but may not honour model-disabled skills (Copilot CLI, Cursor CLI, Qwen) are the open question in the PR.

  Each code runner retries without the flag when an older `plannotator` answers "Unknown inbox option: --from-slash-command" (it keeps no rule anyway).
- **`plannotator inbox on`**, in the person's own terminal. Anywhere else it answers the agents' refusal.
- **Opening the window and pairing a phone** need a running Inbox, and an Inbox runs only while the record is on, so they need no write of their own.
- **No page turns it on.** `POST /api/config { inboxOn: true }` answers 403 ("The Inbox turns on only from your own terminal: run plannotator inbox there."): an agent's `curl` to the local review server looks like the page's request, and nothing an HTTP request carries proves a click. The Settings row turns it off only; once off, its switch is disabled.

### What never turns it on

None of these sets the record:
- anything an agent, a hook, the MCP shim, `--background`, a detached start, an installer, an update or a restart does;
- the routines' start at login (it starts the Inbox only while the record says on);
- `inbox.json` or any other file existing.

The linked-machine update restart and the window's Restart start a detached `plannotator inbox`. That start passes only while the record says on, and never sets it.

### While it is off

The refusal is one line, `INBOX_OFF_AGENT_LINE` (the contract): "The Plannotator Inbox is off on this computer: ask the person in the chat instead. Only the person can turn the Inbox on; do not try to turn it on yourself." It never names what turns the Inbox on. Only in the person's own terminal (above) it is `INBOX_OFF_PERSON_LINE`: "The Plannotator Inbox is off on this computer. Run `plannotator inbox` to turn it on." Hosts recognise either by `isInboxOffAnswer`.

While it is off:
- **Claude Code mod:**
  - No `plannotator_inbox` and no reminder (`inboxOnAtStart` in `apps/hook/hooks/mod/inbox-on.ts`, read at the process's first `session.start`). This holds for interactive sessions, `claude -p`, the SDK and T3.
  - A call after it was turned off mid-session answers the line and starts nothing (`inboxTurnedOff` in the mod's `ensureRunning`).
- **The other hosts register no tool:**
  - Pi (`apps/pi-extension/inbox.ts`) and OMP;
  - OpenCode 1 and 2 (`findInboxConnection`);
  - DSH, Cline, OpenClaw (`switchOn`);
  - Hermes (`plannotator inbox connection`'s switch, which also sends a `switch` event when the person turns it on or off).
- **`plannotator inbox mcp`:** answers `initialize` (with the line as its `instructions`), an empty `tools/list` and `ping`. Every other request gets the line (`inboxOff` in `inbox-mcp-shim.ts`), and nothing starts.
- **`plannotator inbox call`:** refused as `inbox_off: <the line>`, never `inbox_not_running` (which invites a start).
- **`ensureInboxRunning`:** throws the line first of all (`assertInboxOn`), so every CLI side-effect start prints it and exits 1. Those starts are:
  - `inbox call`, `card`, `plans`, `routine`, `pulls`, `steps`, `export-decisions`, `projects`, `rows`, `icon`, `link`, `cloudflare-access`;
  - `--background`;
  - an agent's `--open`.
- **`plannotator inbox restart`** and **`--notes`** refuse.
- **agent-link's `ensureRunning`** answers the line.
- **Notes:** no note is written or offered. `autoAddInboxNotes` and `refreshInboxNotes` check `isInboxOn` themselves, whatever started the process.

### Turn the Inbox off

There are three ways:
- Inbox Settings → General, "This computer" (`components/InboxOffSetting.tsx`, `POST /api/inbox/off`);
- the plan review / code review / annotate Settings row (`POST /api/config { inboxOn: false }`; Bun in process, Pi through `plannotator inbox off`, `turnInboxOffWithCli`);
- `plannotator inbox off`.

All three run `turnInboxOff` in `packages/server/inbox-on-settle.ts`, in this order:
1. The record says off, with `notes: 'remove'`.
2. The Inbox stops. The window's route answers first, then stops itself.
3. The routines' start at login goes (`inbox-scheduled-login.ts`). It comes back when the person turns the Inbox on and it starts with routines on.
4. Plannotator's untouched notes go, each file judged on its own (`removeUntouchedInboxNote` in `inbox-agent-notes.ts`): only a block byte for byte as Plannotator wrote it, only the block, and a file only when Plannotator created it and nothing else is left. A note the person edited stays and is named.
5. The record drops `notes`, or says `left` when some could not go.

Every decision and every Turn off leaves one line in `inbox/inbox.log` (`ev: "inbox_on"`, the paths removed and kept), always, where an Inbox ran. `plannotator inbox status` says on or off, why and since when (`inbox_on` in `--json`).

`off` leaves the MCP entries and `inboxTool` switches the connect step wrote: each agent session's `plannotator inbox mcp` then lists no tools and says why. Turning it on again needs nothing restored.

The answer ends with "Turn it back on any time with plannotator inbox." There is no confirmation: turning it back on is one command. The removed agents leave `inboxAgentNotes.asked`, so turning the Inbox on again writes their notes back.

The plan review / code review / annotate row shows only while `serverConfig.inboxOn` is true (`getServerConfig`), so it never pushes the Inbox at someone who did not turn it on. It is a new optional prop on `@plannotator/ui`'s Settings (`inboxOnSetting`, `onInboxOnChange`, `useInboxOnSetting`). A host that passes neither gets no row.

### Existing installs, decided once

An install from before the rule has no record. `isInboxOn` decides it once (`decideExistingInstall`), writes the record (a compare-and-set: a person's on or off written meanwhile stays), and logs `ev: "inbox_on"` to `inbox/inbox.log`. The store read stops after `INBOX_SCAN_BUDGET_MS` (5 s); a store not read by then counts as used (kept on when in doubt). A decision whose write fails is kept in the process, so the store is not read again on every check.

- **A, used the window: on.** Any one of these counts:
  - config.json `inboxNotifications`;
  - a Tour stamp;
  - `inbox.db`;
  - a paired device, a pin, a draft, a linked machine (`machines.json`), the relay (`relay.json`), a snooze, a recent search;
  - a thread's `person_seen_seq > 0` or a `person_read_seq`;
  - a message the person wrote (not one of the Inbox's own notes, an action report or a routine's line);
  - an answered question.

  The files are read by `inboxUseFromFiles`; the store, chunked with an early exit, by `storeShowsPersonUse`.
- **B, ran `plannotator inbox`: on.** Either of these counts:
  - `inbox/agents.json` exists. Only a person's non-detached run (its connect step), Settings → Agents and uninstall write it.
  - config.json `inboxTool` turns the tool on for a host.

  Gap: a person who ran it only with `PLANNOTATOR_INBOX_CONNECT=0` and never used the window reads as C. An agent whose bare `plannotator inbox` wrote `agents.json` reads as B ("keep on" when in doubt).
- **C, only agents started it: off,** with `notes: 'remove'`.
  - The CLI (`settleInboxOn` at every `plannotator inbox` command, and `plannotator inbox migrate`) removes Plannotator's untouched notes in the same run, never an edited one, once.
  - The mod runs `plannotator inbox migrate` once when it finds no record and `inbox/inbox.json` exists; after that the record decides, so no later session start runs it.
- **D, never ran: off.** Nothing is written: the first record there is the person's own act.

### Version skew

- **A new mod with an old `plannotator`:**
  - The old binary answers `migrate` with "Unknown inbox option: migrate" (`isPreRuleCliAnswer`). It starts the Inbox for anyone and keeps no rule, so the mod keeps today's behaviour: the tool where an Inbox ran. Nothing is written; the gate applies once the binary updates.
  - With no `inbox/inbox.json`, it is off, with nothing run.
  - A `migrate` that failed or timed out (10 s): the cheap files decide that session (`inboxUseFromFiles`), nothing is written.
  - `/plannotator-inbox`'s flag to an old binary: the mod, Pi, OpenCode, Droid and Amp retry without it. Gemini's toml and the skills cannot; the installer updates them with the binary.
- **An old mod with a new `plannotator`:**
  - The old mod still registers its tool and reminder until the plugin updates.
  - Every start it asks for is refused with the line, and the off answer passes through `inboxEnsureFailedWords` unchanged.

### Tests

The tests and their scratch-only knob:
- **Unit tests:**
  - `packages/shared/inbox/inbox-on.test.ts`;
  - `packages/server/inbox-on-settle.test.ts`;
  - `apps/hook/server/inbox-on-command.test.ts` (the markers, the run check, `on`, the shim under the MCP SDK client);
  - `apps/hook/hooks/mod/inbox-on-contract.test.ts`.
- **The engine harness:** the "Whether the person turned the Inbox on here" block in `apps/hook/tests/register.test.ts`. Its `world()` seeds an on record unless a test passes `inbox: 'off' | 'undecided'`.
- **Started-Inbox tests (CI):** `packages/server/inbox-off-route.test.ts`.
- **DOM tests:** `packages/ui/components/Settings.inboxOn.test.tsx` and `packages/inbox/inboxOffSetting.test.tsx`.

Host off proofs: `tests/inbox-off-hosts.test.ts` (OpenCode, DSH, Cline, OpenClaw, Hermes) and `apps/pi-extension/inbox-off.test.ts`. The CLI as a process: `apps/hook/server/inbox-off-cli.test.ts` (CI). The compiled binary with the real rule: the last test of `tests/e2e/inbox.spec.ts` (Browser smoke).

**The test knob.** A test suite starts Inboxes in fresh scratch data dirs. An undecided scratch data dir counts as on under the test sandbox (`PLANNOTATOR_TEST_SANDBOX`, which the unit preload and every test sandbox set), with `PLANNOTATOR_TEST_INBOX_ON=1`, or when HOME is a scratch folder too (the browser specs give the binary their own env, always with a scratch HOME).
- `worldEnv` and the e2e global setup set `PLANNOTATOR_TEST_INBOX_ON=1`.
- A scratch dir means inside the OS temp folder, `/tmp` or `/private/tmp` (`isScratchFolder`). A person's real data dir and home never are, so the knob can never turn their Inbox on, write their agents' notes or connect their agents.
- A record wins over the knob, and `PLANNOTATOR_TEST_INBOX_ON=0` gives the real rule.
