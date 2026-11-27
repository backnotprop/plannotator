## The Inbox for code review only

The owner's mocks, rounds 1 to 3 (2026-11-23; `.ops/keep/review-only-inbox-mocks-20261123*`, not in this repo; the words in round 2's `WORDS.md` and round 3's `FINAL-WORDS.md`). The public page's two promises: `plannotator inbox --review` opens the Inbox for code review, and "your agents hear about the Inbox only in the reviews you start".

**The agent rule is not approved yet.** `INBOX_REVIEW_ONLY_RULE` in `packages/shared/inbox/connection.ts` (and its byte-for-byte copy in `apps/hook/hooks/mod/inbox-contract.ts`) waits for the owner's approval: do not ship it before.

### The setting

One setting, config.json `inboxReviewOnly` (`true` / `false`, unset: the full Inbox). `true` alone is the mode: it holds Code review on by itself (`codeReviewOn` in `inbox.ts`), so no second switch can end it. A Code review off while in it changes nothing; the Full Inbox switch is the one way out, and it leaves Code review on, stamped as the person's flip of it (`codeReviewFlipped`, inbox-capability-set.ts `flipped`), so a linked computer's flip of Code review made while this one was code review only is older and never turns it off here afterwards (and, being the newest, the linked computers take Code review on from it). Hosts read it once per session start: a session already running keeps what it was told.

It is this computer's own. It is not one of the shared capability switches (`INBOX_CAPABILITY_SET_KEYS`), `plannotator inbox capability` has no switch for it, and a linked computer's `POST capabilities` cannot set it (only `INBOX_CAPABILITY_SWITCH_KEYS`). While in the mode, Code review is not shared either (`reviewOnlyShares` in `packages/server/inbox-review-only.ts`): this computer neither gives its Code review to a linked computer nor takes theirs. So a `--review` laptop linked to a full-Inbox desktop changes nothing there, and nothing there ends the mode. Once the person switches back, Code review is one of the set again.

On the wire it is Settings' **Full Inbox** switch, `full_inbox: { on, chosen? }` (on = the full Inbox; `chosen`: `inboxReviewOnly` was ever set here, so the row stays for someone who switched back). It is in `GET /api/inbox/settings`, every settings answer and every `event: capabilities`. `POST /api/inbox/settings { full_inbox: { on } }` saves it with `inboxCodeReview: true`, reads it back (`500 config_not_saved` when it did not land), then runs the notes pass. Server: `createReviewOnly` in `packages/server/inbox-review-only.ts`.

### One resolver for what agents are told

`inboxAgentWords(config)` (`packages/shared/inbox/connection.ts`, in the contract section, so the mod has the same code) returns the whole profile: `lead`, `rules`, `reminder`, `personText`, `notes`, `helpLine`, `boardOffNote`, `reveal(id)` and `action(name)`. Every host builds the agent tool with it (`inboxAgentTool(tools, { words })`): the mod (`inboxAgentWordsOf` in `apps/hook/hooks/mod/enabled.ts`), Pi, OpenCode 1 and 2, Cline, DSH, OpenClaw and `plannotator inbox connection`. The server reads it for the MCP instructions, the reminder, the `card` and `steps` actions, the one-time dialogs and `--help`. A test fails when a host builds the tool without it or reads the setting itself.

While code review only:

- The agent tool's lead has `INBOX_REVIEW_ONLY_RULE` in place of the rules that ask for other traffic (`INBOX_USE_RULE`, `INBOX_THREAD_RULE`, `INBOX_CHANNEL_RULE`, `INBOX_FOLLOW_THROUGH_RULE`; `INBOX_SUBAGENT_RULE` stays). No `card` or `steps` action and no Board line (`INBOX_FULL_INBOX_ACTIONS`), even where the Board and the Checklist are on: their stored values are kept for the full Inbox.
- The MCP server's instructions are `INBOX_MCP_INSTRUCTIONS` with the same swap, and carry none of the person's own reminder or rules.
- No session-start reminder (`resolveInboxReminder` is false), whatever `inboxReminder` says. Settings → Agents hides the Reminder switch.
- `plannotator inbox --help` carries `INBOX_HELP_REVIEW_ONLY_LINE` (WORDS B3) right under "When to use it", and no Cards or Steps section.
- No one-time dialog offers a full-Inbox feature (`INBOX_FULL_INBOX_REVEALS`: Board, Checklist, Routines, Snooze, Priority, Personal agents, Bro): `revealState` holds them closed.
- No Inbox note in agents' instructions files (below).

No word of the reminder or the note changes.

### The notes

`createAgentNotes` (`packages/server/inbox-review-only-notes.ts`) is the one queue for every writer of agent notes: the automatic add, the mode's pass, Settings → Agents' switch and the note dialog. The automatic add asks again right before each write whether code review only began.

The pass records intent first (machine state `inboxReviewOnlyNotes: { for, back, out, edited? }`, read back before it goes on), then makes the files match. It runs at every start and every Full Inbox save, and while anything is left (a file kept read-only or hard-linked) on a timer: a minute, then twice as long each time up to an hour (`RETRY_MAX_MS`), back to a minute once the files match. It logs nothing.

- Out: the agents that have the note are saved as `back` and `out` before any file or any agent's record changes; a failed save stops the pass. Each note comes out with the automatic add's guards: a read-only or hard-linked file is skipped, one changed since it was read is not written, and `PLANNOTATOR_INBOX_NOTES=0` writes nothing. A section the person edited comes out as Settings' switch takes it, but only once its text is saved in `edited`, keyed by the file it came out of, resolved through links (`agentNoteFiles`): two agents sharing one file (Pi's AGENTS.md a link to Codex's, or both homes one folder) keep one text for it, and one agent with two edited files (AGENTS.md and AGENTS.override.md) keeps both.
- Back: each agent in `back` gets its note again: each edited text saved for one of its files goes back into that file (`addInboxNote` `block` + `path`), else Plannotator's note into its target. A text stays saved while another agent on the list reads the same file, so whichever agent comes first puts the person's text back, and the other only takes its record back (a section that is already there is never written over). An agent not installed now, or a write that fails, stays on the list. A note the person pasted by hand without markers counts as back: never a second, marked copy. The list goes once it is empty; then the automatic add runs.
- The person's own switch while either goes on: that agent leaves the list, so switching back gives what they last chose.

### `plannotator inbox --review`

`apps/hook/server/inbox-review-command.ts`. Where the Inbox was never turned on here (`isInboxTurnedOn`) and `inboxReviewOnly` was never set, it saves `inboxCodeReview: true`, `inboxReviewOnly: true`, `inboxReviewWelcome.dueAt` and Code review's flip stamp (`inboxCapabilityFlips.code_review`) before it turns the Inbox on or starts it, so no session begins with the full Inbox's words. It saves the welcome (state.json) first and the rest (config.json) after, reading each back; when the second does not land the welcome is put back as it was, so a failed save leaves the computer as it was (`config_not_saved: … nothing changed`). It checks that the Inbox's mark was written before it goes on. Then it connects the agents found. Where the Inbox was on already, or the person once switched back, only Code review turns on when it was off (through the running Inbox, else config.json, stamped the same way); the mode is never switched. Either way it starts the Inbox detached when needed, shows Reviews in the window used last (`POST /api/inbox/control/show { page: "reviews" }`) or opens a new tab on `#reviews`, and prints the URL. `--review` is not in the usage text.

### The window

`packages/inbox/reviewOnly.ts`. While code review only:

- Reviews is home: when the mode starts, a load on the Inbox (no thread) or on a page only the full Inbox has (Board, Artifacts, Routines, Plans, Grid, the tour) goes to Reviews in place.
- The sidebar (`drawnSidebarItems`, `FULL_INBOX_ITEMS` in `sidebarItems.ts`) hides Inbox, Artifacts, Agents, Projects, Board, Plans, Routines, New message and Copy prompt. The Inbox row comes back while its count says something waits on the person. Starred, Tags and Grid stay.
- The tour's entry screen does not open.
- Settings → Capabilities hides Code review, Board, Checklist and Routines, and shows the **Full Inbox** row on top (`components/FullInboxRow.tsx`, `data-settings-full-inbox`) while code review only or when `chosen`. Settings' back link reads "Reviews".

The welcome (`components/ReviewWelcome.tsx`, `dialog[data-dialog="review-welcome"]`) is the one-time dialog `review_welcome`, first in `INBOX_REVEALS`. It is open for the line while code review only and `inboxReviewWelcome.dueAt` is set, and it goes through the line's claim like every other dialog (`useReviewWelcome`, at once, only on Reviews), so it opens in one tab only, once, and is spaced from the others. It is Code review's offer shell (`.ib-cro`, the art, the four lines with their icons), titled "Welcome to the code review Inbox", with a switch row "The full Plannotator Inbox" (off, saves at once; a failed save puts it back and says "The setting was not saved.") and one button, "Start reviewing". Closing it is never a Not now. It adds no keyboard shortcut. The launch dialog (`packages/inbox/launchDialog.tsx`) goes after it: while the welcome is due and can still show (`reviewOnly.welcomeAhead`: a release build, unshown, and not past the line's patience as its next dialog, so someone who only opens thread links is not kept from the launch), the launch is neither due nor holding the line (`createInboxLaunchQueue`'s `after`, `packages/server/inbox-launch-queue.ts`). Once the welcome has had its turn the launch is due but holds the line no more on that run. In the window the launch waits while the welcome is claimed or open, and on the load that showed it until the line's gap has passed (`useLaunchAfterWelcome`, `REVEAL_TIMES.otherDialogMs`); the launch dialog opens only while the page is still ready (`useLaunchAnnouncement`), so the two never show at once.

### Tests

- `packages/server/inbox-review-only-words.test.ts`: the mode's difference in the tool, the MCP instructions, the reminder and `--help` (never a copy of the unchanged words); the mod's parity; the host guard.
- `packages/server/inbox-review-only.test.ts`: the notes pass (partial failure, a failed list save, put-backs that fail, edited sections, the person's switch, the guards, the queue's race); the switch; the welcome's line; two linked computers.
- `apps/hook/server/inbox-review-command.test.ts`: a first run, a failed save or mark, someone who switched back, an existing user.
- `packages/inbox/reviewOnly.test.tsx` (DOM): the sidebar, home, the welcome and the Settings rows.
- `tests/e2e/inbox-review-only.spec.ts`: the whole flow in a real browser, with pictures in `.local/proof/review-only/`.
