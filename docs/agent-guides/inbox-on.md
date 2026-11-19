## How the Inbox turns on

The owner's rule, in their words: "Installing Plannotator should not put the inbox on at all. You have to run inbox first. You have to purposely want to use inbox."

So the Plannotator Inbox is off on every computer until the person turns it on there, and every way an agent could reach it or start it asks first.

### The record

The record is `state.json` → `inboxOn` in the data dir: `{ on, at, by, notes? }`.
- It is per computer: state.json, never config.json, which may roam with dotfiles.
- `inboxOn` is in `MACHINE_STATE_KEYS`, so `saveConfig` writes it to state.json under config.json's lock.
- The record is read only from state.json.
- The shape and the pure reader are `inboxOnRecord` / `inboxOnFromState` in `packages/shared/inbox/inbox-on-contract.ts`. The Claude Code mod has a byte-for-byte copy in `apps/hook/hooks/mod/inbox-on-contract.ts`, and `inbox-on-contract.test.ts` keeps the two equal.

The one gate is **`isInboxOn(dataDir?, env?)`** in `@plannotator/shared/inbox/inbox-on`. Every gate calls it:
- the agents' tool on each host;
- the reminder;
- the MCP server's tools;
- every start of the Inbox.

The only writers are `turnInboxOn(by)` and `recordInboxOff()` in the same file.

`by` says what last set the record:
- `command`: the person's own `plannotator inbox`.
- `slash-command`: `/plannotator-inbox`.
- `inbox-on`: `plannotator inbox on`.
- `settings`: a Settings switch.
- `off`: Turn the Inbox off.
- `update-used`, `update-ran`, `update-agent-only`, `update-never-ran`: the one-time decision for an install from before the rule (below).

`notes: 'remove'` means Plannotator's untouched notes in agents' instruction files are still to be removed. It is cleared once they are.

### What turns it on (the person's acts)

- **Their own `plannotator inbox` in a terminal.** This covers bare `plannotator inbox`, `--no-open` and `--open`, in a shell no agent started (`isPersonsInboxRun` in `apps/hook/server/inbox-on-command.ts`).
  - An agent's shell is known by any of `INBOX_AGENT_SHELL_MARKERS`: `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `PLANNOTATOR_SESSION_TAG`, `T3CODE_THREAD_ID`, `CODEX_THREAD_ID`, `PI_SESSION_ID`, `OMPCODE`, `OPENCODE`, `GEMINI_CLI`, `QWEN_CODE_SESSION_ID`, `QWEN_CODE`, `COPILOT_CLI`, `CURSOR_AGENT`, `DSH_SHELL`, `DSH_SESSION_ID`.
  - An agent this list does not know looks like the person. Its bare `plannotator inbox` then opens the window in front of the person, who sees the Inbox being turned on.
- **`/plannotator-inbox`.** Plannotator's own runners set `PLANNOTATOR_INBOX_SLASH_COMMAND=1` on the `plannotator inbox --open` they run, and that run counts even inside the agent. The runners are:
  - the Claude Code mod (`controller.ts`);
  - Pi and OpenCode (`openInboxInBrowser` in `agent-link.ts`);
  - Droid;
  - Amp;
  - Gemini's toml;
  - the Claude skill's `!` line.

  The agent-run `plannotator-inbox` core skill (Codex and others) does not carry it, because agents read that text. There, an off Inbox answers the refusal, and the agent tells the person to run `plannotator inbox`.
- **`plannotator inbox on`**, outside an agent's shell. In one, it answers the agents' refusal.
- **A Settings switch:** the plan review / code review / annotate Settings row, `POST /api/config { inboxOn: true }`.
- **Opening the window and pairing a phone** need a running Inbox, and an Inbox runs only while the record is on, so they need no write of their own.

### What never turns it on

None of these sets the record:
- anything an agent, a hook, the MCP shim, `--background`, a detached start, an installer, an update or a restart does;
- `inbox.json` or any other file existing.

The linked-machine update restart and the window's Restart start a detached `plannotator inbox`. That start passes only while the record says on, and never sets it.

### While it is off

The refusal is one line, `INBOX_OFF_AGENT_LINE` (the contract): "The Plannotator Inbox is off on this computer: ask the person in the chat instead, and do not turn the Inbox on yourself (only the person does, by running `plannotator inbox` in their own terminal)." Outside an agent's shell it is `INBOX_OFF_PERSON_LINE`: "The Plannotator Inbox is off on this computer. Run `plannotator inbox` to turn it on." Hosts recognise either by `isInboxOffAnswer`.

While it is off:
- **Claude Code mod:**
  - No `plannotator_inbox` and no reminder (`inboxOnAtStart` in `apps/hook/hooks/mod/inbox-on.ts`, read at the process's first `session.start`). This holds for interactive sessions, `claude -p`, the SDK and T3.
  - A call after it was turned off mid-session answers the line and starts nothing (`inboxTurnedOff` in the mod's `ensureRunning`).
- **The other hosts register no tool:**
  - Pi (`apps/pi-extension/inbox.ts`) and OMP;
  - OpenCode 1 and 2 (`findInboxConnection`);
  - DSH, Cline, OpenClaw (`switchOn`);
  - Hermes (`plannotator inbox connection`'s switch, which also sends a `switch` event when the person turns it on or off).
- **`plannotator inbox mcp`:** answers `initialize`, an empty `tools/list` and `ping`. Every other request gets the line (`inboxOff` in `inbox-mcp-shim.ts`), and nothing starts.
- **`ensureInboxRunning`:** throws the line first of all (`assertInboxOn`), so every CLI side-effect start prints it and exits 1. Those starts are:
  - `inbox call`, `card`, `plans`, `routine`, `pulls`, `steps`, `export-decisions`, `projects`, `rows`, `icon`, `link`, `cloudflare-access`;
  - `--background`;
  - an agent's `--open`.
- **`plannotator inbox restart`** and **`--notes`** refuse.
- **agent-link's `ensureRunning`** answers the line.
- **Notes:** no note is written or offered. `autoAddInboxNotes` runs only at an Inbox start.

### Turn the Inbox off

There are three ways:
- Inbox Settings → General, "This computer" (`components/InboxOffSetting.tsx`, `POST /api/inbox/off`);
- the plan review / code review / annotate Settings row (`POST /api/config { inboxOn: false }`; Bun in process, Pi through `plannotator inbox off`, `turnInboxOffWithCli`);
- `plannotator inbox off`.

All three run `turnInboxOff` in `packages/server/inbox-on-settle.ts`, in this order:
1. The record says off, with `notes: 'remove'`.
2. The Inbox stops. The window's route answers first, then stops itself.
3. Plannotator's untouched notes go (noteStatus `added`). A note the person edited stays and is named.
4. The record drops `notes` once none failed.

The answer ends with "Turn it back on any time with plannotator inbox." There is no confirmation: turning it back on is one command. The removed agents leave `inboxAgentNotes.asked`, so turning the Inbox on again writes their notes back.

The plan review / code review / annotate row shows only while `serverConfig.inboxOn` is true (`getServerConfig`), so it never pushes the Inbox at someone who did not turn it on. It is a new optional prop on `@plannotator/ui`'s Settings (`inboxOnSetting`, `onInboxOnChange`, `useInboxOnSetting`). A host that passes neither gets no row.

### Existing installs, decided once

An install from before the rule has no record. `isInboxOn` decides it once (`decideExistingInstall`), writes the record, and logs `ev: "inbox_on"` to `inbox/inbox.log` with the Inbox debug log on.

- **A, used the window: on.** Any one of these counts:
  - config.json `inboxNotifications`;
  - a Tour stamp;
  - `inbox.db`;
  - a paired device, a pin, a draft;
  - a thread's `person_seen_seq > 0` or a `person_read_seq`;
  - a message the person wrote (not one of the Inbox's own notes, an action report or a routine's line);
  - an answered question.

  The files are read by `inboxUseFromFiles`; the store, chunked with an early exit, by `storeShowsPersonUse`.
- **B, ran `plannotator inbox`: on.** Either of these counts:
  - `inbox/agents.json` exists. Only a person's non-detached run (its connect step), Settings → Agents and uninstall write it.
  - config.json `inboxTool` turns the tool on for a host.

  Gap: a person who ran it only with `PLANNOTATOR_INBOX_CONNECT=0` and never used the window reads as C. An agent whose bare `plannotator inbox` wrote `agents.json` reads as B ("keep on" when in doubt).
- **C, only agents started it: off,** with `notes: 'remove'`.
  - The CLI (`settleInboxOn` at every `plannotator inbox` command, and `plannotator inbox migrate`) removes Plannotator's untouched notes, never an edited one.
  - The mod runs `plannotator inbox migrate` once when it finds no record and `inbox/inbox.json` exists.
- **D, never ran: off.** Nothing to remove.

### Version skew

- **A new mod with an old `plannotator`:**
  - The old binary has no `migrate`, so the mod decides that session from the cheap files alone (`inboxUseFromFiles`: A's config stamps, B's `agents.json` / `inboxTool`) and writes nothing.
  - With no `inbox/inbox.json`, it is off, with nothing run.
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

**The test knob.** A test suite starts Inboxes in fresh scratch data dirs. An undecided scratch data dir counts as on under the test sandbox (`PLANNOTATOR_TEST_SANDBOX`, which the unit preload and every test sandbox set) or with `PLANNOTATOR_TEST_INBOX_ON=1`.
- `worldEnv` and the e2e global setup set `PLANNOTATOR_TEST_INBOX_ON=1`.
- A scratch dir means inside the OS temp folder, `/tmp` or `/private/tmp` (`isScratchFolder`). A person's real data dir never is, so the knob can never turn their Inbox on.
- A record wins over the knob, and `PLANNOTATOR_TEST_INBOX_ON=0` gives the real rule.
