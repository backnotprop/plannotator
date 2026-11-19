## How the Inbox turns on

The owner's rule, in their words: "Installing Plannotator should not put the inbox on at all. You have to run inbox first. You have to purposely want to use inbox."

So the Plannotator Inbox is off on every computer until `plannotator inbox` is run there. Nothing tries to tell a person from an agent: the owner's ruling is that running `plannotator inbox` turns it on, whoever runs it, and that an agent running it is a different problem. What the rule guarantees is that nothing else turns it on, and that no agent-facing text tells an agent to run it.

### The record

The record is `state.json` → `inboxOn` in the data dir: `{ on, at, by, notes? }`.
- It is per computer: state.json, never config.json, which may roam with dotfiles.
- `inboxOn` is in `MACHINE_STATE_KEYS`. It is written by `updateMachineState` (config.ts): state.json only, under config.json's lock, as a compare-and-set, and never needing config.json, so a hand-broken config.json does not block it.
- The record is read only from state.json.
- `inbox-on-decided` beside state.json is rewritten with a copy of every record written, under config.json's lock right after state.json (one that cannot be written is removed, never left stale), and never removed otherwise (only `plannotator uninstall --purge` removes it, with state.json). When state.json is lost later (deleted, or set aside as corrupt), the copy comes back as it was, so an off stays off and an on stays on. A mark with no readable copy (written by an earlier build) reads the store again: the person's use keeps it on, else off, both `record-lost`, and no notes are removed.
- The shape and the pure reader are `inboxOnRecord` / `inboxOnFromState` in `packages/shared/inbox/inbox-on-contract.ts`. The Claude Code mod has a byte-for-byte copy in `apps/hook/hooks/mod/inbox-on-contract.ts`, and `inbox-on-contract.test.ts` keeps the two equal.

The one gate is **`isInboxOn(dataDir?, env?)`** in `@plannotator/shared/inbox/inbox-on`. Every gate calls it:
- the agents' tool on each host;
- the reminder;
- the MCP server's tools;
- every start of the Inbox.

The writers are `turnInboxOn(by)`, `recordInboxOff()` and `writeInboxOnRecord()` (with `ifAbsent` for the one-time decision, `ifCurrent` for a follow-up write) in the same file.

`by` says what last set the record:
- `command`: a run of `plannotator inbox` (`/plannotator-inbox` runs it).
- `settings`: the Settings switch.
- `off`: Turn the Inbox off.
- `update-used`, `update-ran`, `update-agent-only`, `update-slow`, `update-unreadable`: the one-time decision for an install from before the rule (below).
- `record-lost`: see the decided mark above.

`notes: 'remove'` means Plannotator's untouched notes in agents' instruction files are still to be removed. It is dropped after one try, whatever that removed: nothing retries by itself, the log names what stayed, and each `plannotator inbox off` tries again and names it.

### What turns it on

- **A run of `plannotator inbox`**: bare, `--no-open` or `--open`, whoever runs it (`inboxRunMayStart` in `apps/hook/server/inbox-on-command.ts`). `/plannotator-inbox` on every host just runs `plannotator inbox --open`, which also connects the agents it finds (as bare does) and returns. A record that cannot be written is said plainly (`INBOX_ON_NOT_SAVED`) and nothing starts.
- **Opening the window and pairing a phone** need a running Inbox, and an Inbox runs only while the record is on, so they need no write of their own.
- **The Settings switch** in plan review, code review and annotate (`POST /api/config { inboxOn: true }`, `turnInboxOn("settings")`, both runtimes). No guard, by the owner's ruling: anything that can reach the local server can already run `plannotator inbox`. The row is a plain on/off switch; it shows only to someone who had the Inbox on when the page loaded (`serverConfig.inboxOn`).

### What never turns it on

None of these sets the record, and while it is off none of them starts the Inbox:
- `--background`, a detached start (`PLANNOTATOR_INBOX_DETACHED` or an inherited start lock: an agent call's background start, the window's Restart, the linked-machine update restart), and `plannotator inbox restart`;
- the routines' start at login: it runs `plannotator inbox --no-open` with `PLANNOTATOR_INBOX_LOGIN_ITEM=1`, and `isOurLoginItem` makes it Plannotator's own start. One written before that variable (0.29) is still known: launchd's job `ai.plannotator.inbox` (`XPC_SERVICE_NAME`), or the main process of the systemd unit `plannotator-inbox.service` (its cgroup, and `SYSTEMD_EXEC_PID` or systemd as its parent; a process the Inbox starts shares the cgroup but is neither). `settleInboxOn` also gives such an item the marker while the Inbox is on (with a `daemon-reload`) and removes it while it is off. The run reads the markers once and drops them from its environment (`takeLoginItemMarker`), so nothing the Inbox starts inherits them;
- a hook, the MCP shim, a tool call, a send or read subcommand, an installer, an update;
- `inbox.json` or any other file existing.

### While it is off

The refusal is one line, `INBOX_OFF_AGENT_LINE` (the contract), everywhere: "The Plannotator Inbox is off on this computer: ask the person in the chat instead. Only the person can turn the Inbox on; do not try to turn it on yourself." It never names what turns the Inbox on. Hosts recognise it by `isInboxOffAnswer`.

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
  - `--background`, a detached start and the start at login.
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
3. The routines' start at login goes (`inbox-scheduled-login.ts`). It comes back when the Inbox is turned on and starts with routines on. A login item that cannot be removed is named in the answer with why, never swallowed. There is one per account (a fixed path), whatever data dir it names, so turning the Inbox off in one data dir also removes a login item written for another; that other data dir's record is untouched, and its next start with routines on writes the item again.
4. Plannotator's untouched notes go, each file judged on its own (`removeUntouchedInboxNote` in `inbox-agent-notes.ts`): only a block byte for byte as Plannotator wrote it, only the block, and a file only when Plannotator created it and nothing else is left. A note the person edited stays and is named.
5. The record drops `notes`.

Every decision and every Turn off leaves one line in `inbox/inbox.log` (`ev: "inbox_on"`, the paths removed and kept), always, where an Inbox ran. `plannotator inbox status` says on or off, why and since when (`inbox_on` in `--json`).

`off` leaves the MCP entries and `inboxTool` switches the connect step wrote: each agent session's `plannotator inbox mcp` then lists no tools and says why. Turning it on again needs nothing restored.

The answer starts "The Plannotator Inbox is off on this computer: agents lose it from their next session." and ends with "Turn it back on any time with plannotator inbox." There is no confirmation: turning it back on is one command. The removed agents leave `inboxAgentNotes.asked`, so turning the Inbox on again writes their notes back.

### The setup texts

Every setup text an agent follows has the same first Inbox step, `plannotator inbox --open` (`TURN_ON` in `apps/marketing/src/lib/inbox-agents.ts`): the setup script `/inbox/prompt.md`, the llms Inbox page's setup section, every `/llms/agents/<slug>.md`, the plannotator skill and `inbox --help`'s "Connecting yourself". It turns the Inbox on, starts it detached, opens it, connects the agents it finds, prints the URL and returns, with or without a screen. It comes before any connection, config edit, restart or "you should see": a host decides the tool at start, so a session started before the turn-on never gets it. No setup text gives an agent `--background` (refused while off) or bare `plannotator inbox` (it serves in the foreground when no Inbox runs, and never returns in an agent's shell).

Held by `apps/marketing/setup-order.test.ts` (every page, from `apps/marketing/src/lib/setup-texts.ts`), `apps/hook/server/inbox-help-setup.test.ts` (the guide, its usage and the skill) and the compiled-binary walk in `tests/e2e/inbox.spec.ts` ("First setup", Browser smoke: the script, the llms page, the Claude Code and Codex pages, with and without SSH).

Bare `plannotator plans` while off refuses with one line that says the Inbox is off and how to turn it on (`PLANS_INBOX_OFF_TEXT`), and saves nothing: Plans lives in the Inbox, and is not a way on.

The plan review / code review / annotate row shows only while `serverConfig.inboxOn` is true (`getServerConfig`), so it never pushes the Inbox at someone who did not turn it on. It is a new optional prop on `@plannotator/ui`'s Settings (`inboxOnSetting`, `onInboxOnChange`, `useInboxOnSetting`). A host that passes neither gets no row.

### Existing installs, decided once

An install from before the rule has no record. `isInboxOn` decides it once (`decideExistingInstall`), writes the record (a compare-and-set: a person's on or off written meanwhile stays), and logs `ev: "inbox_on"` to `inbox/inbox.log`. The store read stops after `INBOX_SCAN_BUDGET_MS` (5 s); a store not read by then is kept on as `update-slow`, so status does not claim the window was used. A store file or folder that is there but cannot be read (permissions, an I/O error, unparseable JSON) keeps it on as `update-unreadable` when nothing else shows use: in doubt, on, and status says the files could not be read. A decision whose write fails is kept in the process, so the store is not read again on every check.

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

  Gap: a person who ran it only with `PLANNOTATOR_INBOX_CONNECT=0` and never used the window reads as C. Nothing on disk shows such a run (0.29's start trace is written only with the debug log on, and opening the window writes nothing by itself), so status says only that nothing showed the person's use. They turn it on again with `plannotator inbox`. An agent whose bare `plannotator inbox` wrote `agents.json` reads as B ("keep on" when in doubt).
- **C, only agents started it: off,** with `notes: 'remove'`.
  - The CLI (`settleInboxOn` at every `plannotator inbox` command, and `plannotator inbox migrate`) stops an Inbox still running from before the update (as Turn off does), removes Plannotator's untouched notes in the same run, never an edited one, once, and removes the routines' start at login (it would start the Inbox again at the next login). An Inbox it could not stop shows in `plannotator inbox status` with the line to stop it.
  - The mod reads the decided mark's copy itself when state.json has no record (so a `plannotator` older than the rule cannot answer on for it); with no copy, it runs `plannotator inbox migrate` once when `inbox/inbox.json` or the mark exists; after that the record decides, so no later session start runs it.
- **D, never ran: off.** Nothing is written: the first record there is the person's own act.

### Version skew

- **A new mod with an old `plannotator`:**
  - The old binary answers `migrate` with "Unknown inbox option: migrate" (`isPreRuleCliAnswer`). It starts the Inbox for anyone and keeps no rule, so the mod keeps today's behaviour: the tool where an Inbox ran. Nothing is written; the gate applies once the binary updates.
  - With no `inbox/inbox.json`, it is off, with nothing run.
  - A `migrate` that failed or timed out (10 s): the cheap files decide that session (`inboxUseFromFiles`), nothing is written.
- **An old mod with a new `plannotator`:**
  - The old mod still registers its tool and reminder until the plugin updates.
  - Every start it asks for is refused with the line, and the off answer passes through `inboxEnsureFailedWords` unchanged.

### Tests

The tests and their scratch-only knob:
- **Unit tests:**
  - `packages/shared/inbox/inbox-on.test.ts`;
  - `packages/server/inbox-on-settle.test.ts`;
  - `apps/hook/server/inbox-on-command.test.ts` (the run kinds, the login item's marker, status, the shim under the MCP SDK client);
  - `apps/hook/hooks/mod/inbox-on-contract.test.ts`;
  - `apps/hook/server/plans-command.test.ts` (bare `plans` while off);
  - `apps/marketing/setup-order.test.ts` and `apps/hook/server/inbox-help-setup.test.ts` (the setup texts).
- **The engine harness:** the "Whether the person turned the Inbox on here" block in `apps/hook/tests/register.test.ts`. Its `world()` seeds an on record unless a test passes `inbox: 'off' | 'undecided'`.
- **Started-Inbox tests (CI):** `packages/server/inbox-off-route.test.ts`.
- **DOM tests:** `packages/ui/components/Settings.inboxOn.test.tsx` and `packages/inbox/inboxOffSetting.test.tsx`.

Host off proofs: `tests/inbox-off-hosts.test.ts` (OpenCode, DSH, Cline, OpenClaw, Hermes) and `apps/pi-extension/inbox-off.test.ts`. The CLI as a process: `apps/hook/server/inbox-off-cli.test.ts` (CI). The compiled binary with the real rule: the last tests of `tests/e2e/inbox.spec.ts` (Browser smoke), the first setup's walk among them.

**The test knob.** A test suite starts Inboxes in fresh scratch data dirs. An undecided scratch data dir counts as on only when a variable that only tests set says so: `PLANNOTATOR_TEST_INBOX_ON=1`, or the test sandbox marker `PLANNOTATOR_TEST_SANDBOX` (the unit preload and the import-time sandbox set it; nothing outside a test run does). Nothing else counts: a real machine with HOME or the data dir under `/tmp` (a container, a CI image) follows the real rule.
- `scratchEnv()` in `tests/e2e/inbox-scratch.ts`, every e2e spawn env (`tests/e2e-spawn-home.test.ts` checks it), `createFakeAgents().env` and `worldEnv` set `PLANNOTATOR_TEST_INBOX_ON=1`.
- A scratch dir means inside the OS temp folder, `/tmp` or `/private/tmp` (`isScratchFolder`).
- A record wins over the knob, and `PLANNOTATOR_TEST_INBOX_ON=0` gives the real rule.
