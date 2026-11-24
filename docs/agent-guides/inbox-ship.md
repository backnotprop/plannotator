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
  - It then makes the record and reads the PR at once.
- **A PR with no thread, or an agent on another computer than the review's thread.** A thread lives on one computer and its agent works where it runs, so the ship goes in a new thread on the agent's computer (`shipPull`, through the forward for a linked one). The window asks that computer whether a thread there already owns the PR (`pulls/owner` `validate_only`); one that does ships in it. Else it starts a thread there with the instruction as its first message (`inboxApi.startThread`; a write the forward would hold is cancelled, "<name> cannot be reached now."), ties the PR to it (`pulls/owner`, ask `thread`; skipped when that computer's list does not have the PR), then sends `POST ships` `{ key, thread_id, started: true, to }`, which makes only the record, with `to`'s live session as its agent until the thread names one. That computer reads the PR itself when its list does not have it (`readUnlistedPull`).
- **Ship again** on a PR already shipping on another thread stops the old ship first and tells its agent. There is one ship per PR per computer; a window that ships a PR on one computer while it ships on another stops the other once the new one started.

### The record and the watch (server)

- **The record.** `packages/server/inbox-ship-store.ts` writes `inbox/ships.json` as `{ v: 1, ships: { [pull key]: InboxShip } }`:
  - 0600, written to a temp file and renamed into place; an unreadable file is moved aside;
  - the newest 200 ended ships are kept, and each log is cut to 200 entries;
  - types and pure rules are in `packages/core/inbox-ship.ts`.
- **The watch.** `packages/server/inbox-ship-watch.ts` reads each active ship's PR every 2 minutes (`INBOX_SHIP_WATCH_MS`):
  - the timer runs only while a ship is active;
  - it reads sooner when a Reviews read sees its head or state move;
  - each read is one `gh api graphql` (`inbox-ship-read.ts`, through the Inbox's RefRunner; GitLab is not read).
- **What a read tells the agent.** It wakes the agent once per change (`shipChanges`), never twice for the same signature:
  - checks failed on a head;
  - changes requested;
  - new comments by someone other than the person;
  - conflicts with the base, else the base moved where the repository wants the branch up to date;
  - someone else's commit;
  - ready to merge, once per head.
- **What a read never tells.** The first read is a baseline and wakes nobody: the instruction is the agent's first turn. The agent works as the person, so these are never a change:
  - its own pushes (a head commit authored by the signed-in login, or a sha it logged);
  - its own comments.

  This stops wake loops.
- **One note per read.** A read's changes go to the agent as one note, ending "You are still shipping #614." The note is a person message addressed to the shipping session, marked `ship_note: { ship, kind: "watch" | "stop" }` (an Inbox note, `isInboxNote`), and it wakes the agent through its usual path. The words are in `packages/core/inbox-ship-words.ts`.
- **Stuck.** Stuck is detection only; the watch goes on. The row reads Stuck when:
  - the agent says so (`thread_pulls` `ship` `{ kind: "stuck" }`), until it logs a step;
  - one check failed on 3 different heads (`INBOX_SHIP_STUCK_FAILS`), until it passes;
  - the agent's session ended with a ship note waiting for 10 minutes (`INBOX_SHIP_ENDED_MS`, `shipEndedWaiting`).
- **How a ship ends.**
  - Merged, by anyone: the record goes merged, with no wake. The row shows "Merged <time>" for 6 hours (`INBOX_SHIP_MERGED_SHOWN_MS`), then returns to normal.
  - Closed: the ship stops, and the agent gets the closed line.
  - Stop: the ship stops at once in the record, and the agent gets the stop line on its next turn.
- **The merge.** The merge is the agent's own `gh pr merge`. The Inbox never approves or merges.
- **Replies still reach the agent.** A review thread's replies reach the agent while it ships.

### The agent's side

- **Logging steps.** `thread_pulls` takes `ship: { kind: step | stuck | merged, text, sha? }` (`packages/server/inbox-mcp-pulls.ts`; schema copy in `apps/hook/hooks/mod/inbox-default-tools.ts`; `--help` line `SHIP_HELP_LINE`). It logs a step of the thread's active ship. With no ship going, it says so and logs nothing. `merged` triggers a read at once.
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
- **The phone.** The phone layout of the window ships as a desktop does. The native app has no pull routes (they are `machineOnly`), so its ledger row `ship-mode` is `later` (`L-size`).
- **What does not cross.** A linked machine that is offline or too old to take ships is left out of the list. The native iPhone app has no pull routes (above).

### Tests

- `packages/core/inbox-ship.test.ts`
- `packages/server/inbox-ship-watch.test.ts`
- `packages/server/inbox-ship-read.test.ts`
- `packages/server/inbox-ship-routes.test.ts`
- DOM: `packages/inbox/pulls/shipMode.test.tsx`, `packages/inbox/pulls/shipAcross.test.tsx` (another computer's agents, the thread's ⋯ menu)
- e2e: `tests/e2e/inbox-ship.spec.ts` (shots in `ship/`)
