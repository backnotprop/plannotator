## The Inbox for code review only

The owner's mocks, rounds 1 to 3 (2026-11-23; `.ops/keep/review-only-inbox-mocks-20261123*`, not in this repo; the words in round 2's `WORDS.md` and round 3's `FINAL-WORDS.md`). The public page's two promises: `plannotator inbox --review` opens the Inbox for code review, and "your agents hear about the Inbox only in the reviews you start".

**The agent rule is not approved yet.** `INBOX_REVIEW_ONLY_RULE` in `packages/shared/inbox/connection.ts` (and its byte-for-byte copy in `apps/hook/hooks/mod/inbox-contract.ts`) waits for the owner's approval: do not ship it before.

### The setting

One setting, config.json `inboxReviewOnly` (`true` / `false`, unset: the full Inbox). It takes effect only while Code review (`inboxCodeReview`) is on (`resolveInboxReviewOnly` in `packages/shared/config.ts`; the mod's `resolveInboxReviewOnlyEnabled` in `apps/hook/hooks/mod/enabled.ts` reads it the same way). Turning Code review off gives the full Inbox again. Hosts read it once per session start: a session already running keeps what it was told.

On the wire it is Settings' **Full Inbox** switch, `full_inbox: { on, chosen? }` (on = the full Inbox; `chosen`: the person chose either way at least once). It is in `GET /api/inbox/settings`, in the settings answer, and in `event: capabilities` once chosen. `POST /api/inbox/settings { full_inbox: { on } }` saves it. Going to code review only turns Code review on first, as its row does. Going back asks nothing and leaves Code review on. Server: `packages/server/inbox-review-only.ts` (`createReviewOnly`).

### What agents are told while code review only

- The agent tool's lead (`inboxAgentTool(tools, { reviewOnly: true })`; every host passes it: the mod, Pi, OpenCode 1 and 2, Cline, DSH, OpenClaw, and `plannotator inbox connection`) has `INBOX_REVIEW_ONLY_RULE` in place of the rules that ask for other traffic (`INBOX_USE_RULE`, `INBOX_THREAD_RULE`, `INBOX_CHANNEL_RULE`, `INBOX_FOLLOW_THROUGH_RULE`; `INBOX_SUBAGENT_RULE` stays: `INBOX_REVIEW_ONLY_AGENT_RULES`). The rest of the description, the actions and the schema are unchanged.
- The MCP server's instructions (`inboxMcpInstructions(reminder, tier, true)`) are `INBOX_MCP_INSTRUCTIONS` with the same swap, and carry none of the person's own reminder or rules.
- No session-start reminder (`resolveInboxReminder` is false), whatever `inboxReminder` says.
- No Inbox note in agents' instructions files. The start writes none by itself (`autoNotes` in `inbox.ts`). A switch to code review only takes the note out of every file where it is as Plannotator wrote it (`removeInboxNote`: only its own marked section; a section the person edited is theirs and stays) and keeps which agents had one (`inboxReviewOnlyNotes`, machine state). A switch back puts those back (`addInboxNote`), then writes what the full Inbox writes by itself (`autoAddInboxNotes`). `syncNotes` runs at start, on a Full Inbox save and on a Code review save. Module: `packages/server/inbox-review-only-notes.ts`.
- The window's agent note dialog does not open (`agentNoteReady`).

No word of the reminder or the note changes.

### `plannotator inbox --review`

`apps/hook/server/inbox-review-command.ts`. Where the Inbox was never turned on here (`isInboxTurnedOn`), it saves `inboxCodeReview: true`, `inboxReviewOnly: true` and `inboxReviewWelcome.dueAt` before it turns the Inbox on or starts it, so no session begins with the full Inbox's words. Then it connects the agents found, as the run that turns the Inbox on does. Where the Inbox was on already (a full-Inbox person), only Code review turns on when it was off (through the running Inbox, else config.json); the mode is never switched. Either way: it starts the Inbox detached when needed, shows Reviews in the window used last (`POST /api/inbox/control/show { page: "reviews" }`) or opens a new tab on `#reviews`, and prints the URL. Usage line in `INBOX_COMMAND_USAGE` (`apps/hook/server/cli.ts`). It takes no other flag.

### The window

`packages/inbox/reviewOnly.ts`. While code review only:

- Reviews is home: when the mode starts, a load on the Inbox (no thread) or on a page only the full Inbox has (Board, Artifacts, Routines, Plans, Grid, the tour) goes to Reviews in place.
- The sidebar (`drawnSidebarItems`, `reviewOnly`) keeps Search, Reviews, Drafts, Usage, Feedback, Settings and its icons. The Inbox row comes back while its count says something waits on the person.
- The tour's entry screen does not open.
- Settings → Capabilities hides Board, Checklist and Routines, and shows the **Full Inbox** row on top (`components/FullInboxRow.tsx`, `data-settings-full-inbox`) to anyone who chose either way once. Settings' back link reads "Reviews".

The welcome (`components/ReviewWelcome.tsx`, `dialog[data-dialog="review-welcome"]`) shows once, on the first load after `--review` asked for it (`review_welcome: true` in the settings while `inboxReviewWelcome.dueAt` is set and `shownAt` is not), and is claimed as it opens (`POST /api/inbox/settings { review_welcome: true }` stamps `shownAt`). It is Code review's offer shell (`.ib-cro`, the art, the four lines with their icons, `CodeReviewFeatures`), titled "Welcome to the code review Inbox", a switch row "The full Plannotator Inbox" (off, saves at once) and one button, "Start reviewing". Start reviewing, Escape and a click outside only close it. It adds no keyboard shortcut.

### Linked computers

`full_inbox` is one of the shared capability switches (`INBOX_CAPABILITY_SET_KEYS`, `INBOX_CAPABILITY_SWITCHES`). A flip on one linked computer applies on all of them. What is shared is the setting itself, not its effect with Code review. An older Plannotator does not know the key: it drops it from the set it reads, and its own set has none, so nothing is taken either way. `plannotator inbox capability full_inbox on|off` turns it.

### Tests

- `packages/server/inbox-review-only-words.test.ts`: the tool lead and the MCP instructions per mode, as exact strings; no reminder.
- `packages/server/inbox-review-only.test.ts`: notes out, back and never written, in a scratch home; the switch both ways; the welcome.
- `apps/hook/server/inbox-review-command.test.ts`: a first run against an existing user.
- `packages/server/inbox-capability-set.test.ts`: two computers, and an older one.
- `packages/inbox/reviewOnly.test.tsx` (DOM): the sidebar, home, the welcome and the Settings row.
- `tests/e2e/inbox-review-only.spec.ts`: the whole flow in a real browser, with pictures in `.local/proof/review-only/`.
