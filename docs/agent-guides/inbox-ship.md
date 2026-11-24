## Ship (Reviews)

Approval "inbox-ship-mode" (`.product/approved/inbox-ship-mode/`, look "Glint"). The owner's ask: "right-click or power-hold down the thread, and I get a ship option … launch an agent and have it get it all the way through. Like tell the agent your job's not done until it's merged". Ship sits behind Code review (`inboxCodeReview`), with no switch of its own. It adds no gates, caps, confirmations or settings. GitHub's own rules decide what can merge.

### Where the person ships

- **The row menu.** A Reviews row about exactly one open pull request has **Ship** first in its right-click menu (`pulls/ShipMenu.tsx`, inside `ReviewsMenu`). A stack's unfolded layer row has it too. A row about several PRs has none, because one ship is one pull request. On a desktop, Ship is a submenu trigger:
  - One click ships with the agent already on the review: the live agent of the row's link (`shipTarget`, `pulls/shipStart.ts`). With none, it ships with New review's choice (`pullThreadDefault`).
  - The item's end shows that agent's mark and a chevron.
  - The submenu lists the agents that can take it, in Start a thread's rows (`threadTo.ts`), with the default ticked (`shipOptions`; sections in `shipSections`, `ShipMenu.tsx`):
    - the live sessions of the thread's project (else the PR's projects), on the computer that holds the thread;
    - each other computer's live sessions and "New … session" rows in its projects on the PR's repository, under its name (approved shot 3, "Mac mini"): this computer's when the thread is on a linked one, and every online linked machine that takes ships (mark `ships`). Their sessions are read as New message reads them (`useMachineLaunches`); their projects by repository come from their ships read (`projects`);
    - then the thread's computer's "New … session" rows.
- **A phone.** A long press opens the same menu. Ship opens the agent sheet (`ShipAgentSheet`) on the default, with the same groups, and a tap ships with that agent.
- **While a row ships**, its menu has **Ship log** and **Stop shipping** instead of Ship.
- **The review thread's own view.** While the thread's pull request ships (in that thread, or on any computer for a PR in its `pull_keys`), the thread's ⋯ menu starts with **Ship log** and **Stop shipping** (`pulls/ThreadShip.tsx`, in `ThreadMore`). Ship log opens the same log by the ⋯ button, a sheet on a phone. A thread with no pull request reads no ships.

### What a press does

- **A row with a review thread.** The window sends `POST /api/inbox/ships` with `{ key, thread_id, to }` to the computer that holds the thread (`machineOf(thread)`, the forward). That Inbox:
  - sends the instruction (core `shipMessage`: the approved `SHIP_INSTRUCTION`, then the PR's facts fenced as untrusted data) into the thread as the person's reply to `to`;
  - for a live session, the reply reaches it on its usual path (bridge long-poll, `codex queue`, Pi, OpenCode);
  - for a new session (`to.launch`), it starts it as a reply's launch does (`launch.prepare`, then `sendReply` with `launch`).
  - It then makes the record and reads the PR at once. The record keeps the session the instruction went to and the message that carried it (`agent`, `instruction_id`): that session ships it, never the thread's latest agent (`inbox-ship-agent.ts` `shipShipper`). A new session's ship keeps the launch that message started (`launch_id`); its placeholder is replaced by the session that launch reports, or the session the message was delivered to (by that session's own read), whichever is known first (`shipBinds`). Until then its notes wait: the watch reads, but tells nothing and records nothing, so the bound session's first read tells it all. A ship that never binds is not left shipping: when its launch fails (or is removed) the row reads "Stuck: the agent didn't start" at once (the launch's change tells the watch, `watch.starting`), the log adding the launch's own words in brackets; with no failure and no session `INBOX_SHIP_START_MS` (90 s) after Ship, the watch's first tick does the same with "(no session started)". A session known after that binds it, the Stuck ends by itself, and the waiting notes go out once. Stop works on it as on any ship.
- **A PR with no thread, or an agent on another computer than the review's thread.** A thread lives on one computer and its agent works where it runs, so the ship goes in a new thread on the agent's computer (`shipPull`, through the forward for a linked one). The window asks that computer whether a thread there already owns the PR (`pulls/owner` `validate_only`); one that does ships in it. Else it starts a thread there with the instruction as its first message (`inboxApi.startThread`; a write the forward would hold is cancelled, "<name> cannot be reached now."), ties the PR to it (`pulls/owner`, ask `thread`; skipped when that computer's list does not have the PR), then sends `POST ships` `{ key, thread_id, started: true, to }`, which makes only the record, with `to`'s session as its agent (a new session: the one the thread's first message launched). That computer reads the PR itself when its list does not have it (`readUnlistedPull`).
- **Ship again** on a PR already shipping with another agent (another thread, or another session in the same one) stops the old ship first and tells its agent.
- **One ship per PR across computers.** Each Ship sends `POST ships/newer` `{ key, id, started_at, generation }` to every linked computer through the outbox (this Inbox's own write, held until it lands, so a computer asleep at the Ship hears it when it is back, after a restart too). The generation decides which ship is newer, not a clock: each Ship takes a `generation` one above the highest it knows of for that PR (its own record's, or one heard from a linked computer, kept in `ships.json` `heard`), so the last press wins by what each computer had heard when it was pressed (core `shipNewerWins`). A computer told of a winning ship stops its own, logs "Stopped: shipping on <computer>" and tells its agent the stop line (`watch.newer`); one whose own ship wins answers that computer with its own `ships/newer`, so the older ship there stops. Two presses that never heard of each other (both computers offline from each other) have the same generation; only then, as a last resort, the later press by the time each computer recorded (`started_at`) goes on, and the same time is settled by id, the same way on both. Two clocks decide that tie, so presses close together may go to the earlier one when a clock is off. The route refuses a `started_at` that is not a date and a `generation` that is not a whole number from 1. The window does nothing for it.
- **Forges.** Ship is offered for the forges whose PR state the Inbox reads (core `shipForge`): GitHub and GitLab. Any other is refused (`pull_not_shippable`) and the row has no Ship.

### The record and the watch (server)

- **The record.** `packages/server/inbox-ship-store.ts` writes `inbox/ships.json` as `{ v: 1, ships: { [pull key]: InboxShip } }`:
  - 0600, written to a temp file and renamed into place; an unreadable file is moved aside;
  - the newest 200 ended ships are kept, and each log is cut to 200 entries;
  - types and pure rules are in `packages/core/inbox-ship.ts`.
- **The watch.** `packages/server/inbox-ship-watch.ts` reads each active ship's PR every 2 minutes (`INBOX_SHIP_WATCH_MS`):
  - the timer runs only while a ship is active;
  - it reads sooner when a Reviews read sees its head or state move;
  - GitHub: each read is one `gh api graphql` (`inbox-ship-read.ts`, through the Inbox's RefRunner);
  - GitLab: each read is the Reviews list's own read of the merge request (its cache; `createShipReader`). That read does not name failed jobs or comments: a failed pipeline is named "pipeline", and comments do not wake the agent there. A merge request off the list is read for its state and head only, its pipeline taken as pending (never "merge it now");
  - a tick that changes nothing writes nothing to `ships.json`.
- **What a read tells the agent.** It wakes the agent once per change (`shipChanges`), never twice for the same signature:
  - checks failed on a head;
  - changes requested;
  - new comments that are not the agent's own (core `shipNewComments`; below);
  - conflicts with the base, else the base moved where the repository wants the branch up to date;
  - a new head the agent did not log (the person's own push with the same login too);
  - ready to merge, once per head.
- **What a read never tells.** The first read is a baseline and wakes nobody: the instruction is the agent's first turn. A head the agent logged with `thread_pulls` `ship` `sha` (`told`) is its own push and wakes nobody. A Reviews read can see the agent's push before the agent logs it, so a new head nobody logged is held one read (`seen.held`): that read tells nothing, and the next tells all of it in one note, the push too only if it is still nobody's. A hold is one read at most: a read that finds yet another new head after a held one tells it at once, so pushes that are never logged (one every read) still wake the agent.
- **The agent's own comments never wake it.** The read names every recent comment and code comment with its author, and the login `gh` is signed in as (`viewer`). A comment id wakes the agent at most once (`seen.comments`). A comment by anyone else is news. A comment by the signed-in login is the agent's own when a step it logged with `thread_pulls` `ship` is not yet covered by a read asked after it (`steps`, `seen.claimed`): each step reads the PR at once, and what that login wrote before the step is not news to the agent. One by that login after the agent's last step is news (the person commenting by hand with the same login). What is left, never a loop: the agent's own comment that a read sees before the agent logs its next step wakes it once; and the person's comment by the same login, posted between two steps and not read before the second, is taken as the agent's.
- **One note per read.** A read's changes go to the agent as one note, ending "You are still shipping #614." The note is the Inbox's own notice, stored as a person message marked `ship_note: { ship, kind: "watch" | "stop" }` (`isInboxNote`: never the person's reply, never Sent), addressed to the shipping session only. Its wake is a notice with no reply instruction (the command's `moved`), with its own first line (the command's `notice`, `SHIP_NOTE_WAKE_INSTRUCTION`, core `inboxNoticeOf`) in place of the moved note's `INBOX_MOVED_WAKE_INSTRUCTION`; a connection that does not know `notice` uses the moved line. A stop or closed line never starts a cloud agent's run; an update note wakes a shipping cloud agent as any reply would (`inbox-cloud-wake.ts`). The thread shows it as one quiet line, "Ship update sent to Claude Code · 2:47 PM" or "Stop shipping sent to Claude Code · 2:47 PM" (`pulls/ShipNote.tsx`); what it said is in the ship log. A watch note starts a stopped new session again (the job is not done); the stop and closed lines never do. The words are in `packages/core/inbox-ship-words.ts`.
- **Only the shipping session's calls.** `thread_pulls` `ship` changes the ship only when its `agent_session` is the shipping session; any other session's call logs nothing and is told "Another session is shipping this pull request; nothing was logged." A thread that ships nothing answers "Nothing is shipping in this thread; nothing was logged." A ship to a live session the person chose is settled (`bound`). A new session's binds only to the session its own launch reports or its instruction was delivered to; a `ship` call from any other session never binds it, so an agent that was shipping the PR in the same thread and logs a step before its stop note arrives cannot take the new ship. A session an earlier ship of the thread was given and that was stopped (Stop, another computer, or a Ship again to another session; `stopped_sessions`) is answered with the stop line instead of "Another session …".
- **Stuck.** Stuck is detection only; the watch goes on. The row reads Stuck when:
  - the agent says so (`thread_pulls` `ship` `{ kind: "stuck" }`), until it logs a step;
  - one check failed on 3 different heads (`INBOX_SHIP_STUCK_FAILS`), until it passes;
  - the shipping session ended with a ship note waiting for 10 minutes (`INBOX_SHIP_ENDED_MS`, `shipEndedWaiting`, `shipSessionEnded`);
  - the PR could not be read 3 times in a row (`INBOX_SHIP_READ_MISSES`: `gh` or `glab` missing, signed out, refused): "Stuck: can't read the pull request", with why in the log and on stderr, until a read works.
- **How a ship ends.**
  - Merged, by anyone: the record goes merged, with no wake. The row shows "Merged <time>" for 6 hours (`INBOX_SHIP_MERGED_SHOWN_MS`), then returns to normal. Meanwhile a thread on that PR keeps its Reviews row though its PR landed (by the PR's key, core `shipsMergedShown`: the ship's own thread, or this computer's thread on a PR shipped from a linked machine, below), its agent ended or not, once it owns no open PR (an open layer of its stack is that PR's own row) (core `inboxReviewRows` `shipMerged`; the row finds its ship by its landing's key, a ship that still draws before an older one). The ship's record is the PR's landing until a read records one (its key, link, number, title and merge time; no forge read): a teammate's PR leaves the list once merged (the list keeps only the person's own merged PRs), so a thread tied to it keeps its row by its tie (server `linkUnlistedPulls`), and a review thread on it says Merged at once. A PR the list saw land while its ship is still shipping or stuck (its watch has not marked it merged yet) keeps its row the same way (`shipActive`), and a window that sees a ship it drew turn merged reads Reviews once more at once (`pulls/shipMergedRead.ts`), so the row never drops in between. A row kept only for this never asks anything of the person: it is in the group it is in with its PRs landed (an approval stays Ready to land, an answered review With your agents, a thread with no review Open, not reviewed), and where that would be On you (its PRs gone, an answer posted on the forge no longer counts), Waiting on others, so it adds to no count of what needs the person. After that a landed thread leaves Reviews as any does.
  - Closed: the ship stops, and the agent gets the closed line.
  - Stop: the ship stops at once in the record, and the agent gets the stop line on its next turn.
- **The merge.** The merge is the agent's own `gh pr merge`. The Inbox never approves or merges.
- **Replies still reach the agent.** A review thread's replies reach the agent while it ships.

### The agent's side

- **Logging steps.** `thread_pulls` takes `ship: { kind: step | stuck | merged, text, sha? }` (`packages/server/inbox-mcp-pulls.ts`; schema copy in `apps/hook/hooks/mod/inbox-default-tools.ts`). The field carries no description in the schema, nor do its members: every agent carries that schema on every request, and only Ship, started from the window, uses the field (the owner: "Why would it go here when ship is only activated from the interface?"). The ship instruction (`SHIP_INSTRUCTION`) and the `--help` line (`SHIP_HELP_LINE`) teach it; `inbox-ship-mcp.test.ts` guards both the missing words and the field's shape. It logs a step of the thread's active ship. With no ship going, it says so and logs nothing. `merged` triggers a read at once.
- **Every host.** It works the same for Claude Code, Codex, OpenCode and Pi: the instruction and the notes are ordinary addressed messages, and the tool is the shared `plannotator_inbox` tool.

### The row (look "Glint")

- **Shipping and stuck.** The shipping row draws water behind its lines (`pulls/ShipRow.tsx`, `pulls/ship.css`):
  - a sea-and-sky tint, two slow radial pools, and a glint that crosses every 4.2 s;
  - the sail for its mark, rocking, and the agent's mark bobbing a beat behind;
  - on a ship started in the last 4 s, a launch that fills the row from the left once;
  - only transform and opacity move, and the water sits in the row's own box, so nothing shifts;
  - one shared IntersectionObserver marks an off-screen row `data-shp-off`, which holds it still;
  - under reduced motion, a still tinted row with the sail.

  Stuck brings sand over the water, stops the motion and shows "Stuck: <reason>" in sand ink.
- **Merged.** Merged has no water; "Merged <time>" takes the row's end, where the agent and the age were.
- **Rows that don't ship** draw none of this.
- **Reading the ships.** The window reads ships with `useShips` (`data/ships.ts`):
  - from this Inbox, each linked machine that takes ships (mark `ships`), and each that holds a row's thread; one read per computer at a time, shared by every view;
  - on each Reviews read, on `event: ships` (this Inbox's stream; `data/shipEvents.ts`) and on focus;
  - every 60 s while a linked machine's ship is active.

### The ship log

The ship log lists what the agent logged and what the Inbox saw, newest first, each with its time; a commit is drawn as code. It has **Stop** while the ship runs (`pulls/ShipLog.tsx`). It opens:

- from a shipping row's menu: a popover by the row, a sheet on a phone;
- from the review thread's ⋯ menu, the same;
- on the PR's page (the launchpad), while the PR ships (`PageShipLog`).

Its who line is the agent, the repository and, once a computer that ships is linked, the computer it ships on by name (`shipComputer`).

### Across computers and the phone

- **Linked machines.** A ship lives on the computer that holds its thread. A window on another linked computer reaches it through the forward, and offers that computer's agents for any PR (a new thread there). The list's mark `ships` says a machine takes them; an older machine is left out. `GET ships` also says that computer's projects by repository. The door rows are `machineOnly`:
  - `GET ships`
  - `GET ships/log`
  - `POST ships` (outbox kind `now`)
  - `POST ships/stop` (outbox kind `now`)
  - `POST ships/newer` (outbox kind `set`; only a linked computer's Inbox sends it, never a window)
- **A merge on a linked machine.** This Inbox's Reviews keeps its own row for a PR whose ship merged on a linked machine, as for one here: the Reviews read takes each linked machine's merged ships as last read (`GET ships` through the door, mark `ships`; `packages/server/inbox-machine-ships.ts`), never waited for, not again within 30 s, only the merged and active ones and only their PR's key, link, number, title and times (`farMergedShip`). A far merge's 6 hours run from when this computer first saw it merged (`farEndedAt`), so another computer's clock ahead or behind never stretches or cuts them. A machine with Code review off answers `409` and none of its ships count; an asleep one's stay as last read. A linked machine reading this list gets this machine's own ships only.
- **The phone.** The phone layout of the window ships as a desktop does. The native app has no pull routes (they are `machineOnly`), so its ledger row `ship-mode` is `later` (`L-size`).
- **What does not cross.** A linked machine that is offline or too old to take ships is left out of the list. The native iPhone app has no pull routes (above).

### Tests

- `packages/core/inbox-ship.test.ts`
- `packages/server/inbox-ship-watch.test.ts`
- `packages/server/inbox-ship-read.test.ts`
- `packages/server/inbox-ship-routes.test.ts`
- `packages/server/inbox-machine-ships.test.ts` (a linked machine's merged ships); the kept rows in `packages/core/inbox-reviews.test.ts` ("landed PRs")
- DOM: `packages/inbox/pulls/shipMode.test.tsx`, `packages/inbox/pulls/shipAcross.test.tsx` (another computer's agents, the thread's ⋯ menu)
- e2e: `tests/e2e/inbox-ship.spec.ts` (shots in `ship/`)
