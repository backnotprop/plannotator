## Swarm

Several agents work on one Inbox thread as one team. Experimental, **off by default**: `PLANNOTATOR_EXPERIMENTAL=swarm` or config.json `{ "experimental": { "swarm": true } }`, with no Settings row (`resolveExperimental(config, "swarm")`). Off, nothing of it shows or answers: no `/swarm` skill in the catalog, no `swarm` on the thread read, `/api/inbox/swarm` answers `409 swarm_off`, `threads/:id/swarm` `404`, and `plannotator inbox --help` has no Swarm section.

Piece 1 (this): several agents in New message, the swarm record, the ghost thread, `plannotator inbox swarm`. Later pieces add the plan card, the task list (`swarm add`, `take`, `done`, `tasks`; until then the command refuses them with `not_available`) and Change plan.

### Starting a swarm

- The `/swarm` built-in skill (`packages/core/swarm-skill.ts`, the owner's approved text, pinned by `swarm-skill.test.ts`): the Swarm badge puts `/swarm` in the words, and the window pastes the text at Send like any human-only built-in.
- A person's message whose skills block names `swarm` (`inboxMessageStartsSwarm`, `packages/shared/inbox/swarm-start.ts`) starts the swarm of its thread when it is written (inbox.ts, beside the far tags' subscriber): the record and the ghost thread.
- New message to several agents: `to` is the first pick, the others ride `tags` (`startPersonThread`'s `tags`, resolved by the far tags' `targets`, so an agent on a linked computer can be picked). `tags` in a New message is refused while Swarm is off.
- What each agent is handed (`packages/server/inbox-swarm-wake.ts`): the message, then `swarmJoinLine(threadId)`. The stored body is unchanged. The join line is decided from the root itself (it names `/swarm`, and no swarm of it is turned off), never from whether the record is written yet: a held poll and the far tags build the wake inside the very write that starts the swarm. `joinSwarm` starts the swarm of such a root when its record is not there yet, so the join that line asks for always works.

### The record and the ghost thread

- One `swarm` record per thread (`InboxSwarmRecord`, `packages/core/inbox-swarm-types.ts`) in the project's `swarm.jsonl`, quiet like `steps` and `thread_pull`: `on`, `ghost_id`, `members` (each `session`, `host`, `name`, `machine?`, `machine_name?`, `for?`, `joined_at`, `doing?`), `person_seen_at`.
- The ghost thread is a real thread whose root (written by the Inbox, author `person`, empty body) carries `ghost_of: <thread id>`. The store keeps `ghostParents`; `listRow` answers null for it, so it is never in the list, a section, unread counts, notifications, the Board or Tidy; `threadsOf` skips it; search never indexes it; its messages are never a session's latest or first thread (sidebar, routing) and its person tags are not indexed.
- The wire: `InboxThread.swarm = { on, ghost_id, members, ghost_unread }` on `GET /api/inbox/threads/:id`. Members are the joined agents, then the agents the thread is addressed to (`to` and every person tag) that have not joined, `joined: false`. `state` is `working` / `idle` from the live connection (here or on a linked computer), `waiting` when the thread waits on the person after that agent's words, else null.

### Delivery inside a ghost thread

The only place an agent's words reach other agents. `store.isGhostSay(message)`: an agent message in a ghost thread with tags. `pendingReplies`, `pendingRepliesFor`, `pendingFor`, `recordDelivery`, `recordCloudWake`, `wakingSessionsOfHost` and `farSessions` accept it, for a tagged session that is a member of a swarm that is on, and only for a connection that words tags. The person's words from the ghost pane follow the same rule: a member only, while on. With the experimental switch off (`store.setSwarmSwitch`, set by inbox.ts) no ghost words wait for anyone. `store.ghostWaitsFor(message)` names the sessions they still wait for (never the author). Every other thread is exactly as before. A ghost message is handed as a notice (`moved` with its own `notice` line, `SWARM_WORDS.wake`, `swarmNoticeOf`), so it never reads as the person's reply. A far member's tag carries its `machine`; the far tags' `onPersonMessage` sends its wake there.

Only `swarm say` writes there: the store refuses an agent's `send_message` whose `reply_to` is in a ghost thread (`SWARM_GHOST_SEND_REFUSED`, `swarm-start.ts`; `sendProject` refuses it first, before any attachment is kept), and `writeGhostMessage` refuses an agent that is not a member. Turned back on (Turn on, or the experimental switch seen going from off to on), nothing said before is handed out: the record's `on_seq` (the store stamps it when a swarm turns on) and the switch's in-process mark (the store's seq the last time it was seen off, so the first words after it is back are handed even when nothing looked in between) leave older ghost words waiting for nobody. An Inbox restarted while the switch was off does not know it was off.

Delivery receipts stay in the ghost thread: a member's delivery is written on the ghost message's tag, never on the main thread, and the ghost thread is no row, so no unread, no "Delivered to …" line and no notification comes of it (`swarm-wakes.test.ts`).

### Who is woken how

Each member is woken by the channel its host's ordinary reply uses, once per message, by the command `replyCommand` makes (the notice):

| Host | How a ghost message reaches it | Proof |
|---|---|---|
| Claude Code (the mod), T3 Code's Claude with the mod, Pi, OpenCode 2, DeepSeek Harness, Cline, OpenClaw, Hermes | The bridge poll (`live.pendingOf` → `pendingReplies`); a held poll answers at once (inbox.ts, the poll's subscriber) | store: `swarm-wakes.test.ts` |
| Codex | The Codex wake: `codex queue`, or a launched thread's app-server; its subscriber looks at a ghost message's tags as at a person's | store test; the wake read only |
| Qwen Code | The Qwen wake's cross-session frame, same subscriber change | store test; read only |
| T3 Code (no mod) | The T3 wake, same subscriber change | store test; read only |
| Antigravity | The Antigravity wake's `agentapi send-message`, same subscriber change | `inbox-swarm-host-wakes.test.ts` |
| Paired cloud agent with a wake address | The cloud wake's webhook, the notice line first in the item's words; each member's own wake state on its tag (`InboxTag.cloud_wake`, `store.cloudWakeOf`), and its own gap and backoff, so no member's wake overwrites another's and none is woken twice | `inbox-swarm-host-wakes.test.ts` |
| Paired cloud agent that checks by itself | Its relay signal (`agentSignalsFor`): only the members the words wait for | read only |
| A launched session that rests | Started again (`maybeRespawn`), as the person's reply starts it (inbox-launch.ts, its subscriber) | read only |
| A member on a linked computer | `POST far-wake` through the outbox (the far tags); that computer keeps `moved` and `notice` (`farWakeCommand`), so its own poll, Codex, Qwen, T3, Antigravity or cloud wake hands it as a notice. With Swarm off this also hands a Ship note there as the notice it is on the thread's computer; its cloud item keeps the body alone, as that computer's own cloud wake sends it (`farWakeItem`, `inbox-far-host-wakes.test.ts`) | `inbox-swarm-far.test.ts` |
| No wake today (an MCP-only client, OpenCode 1, Claude Code with the mod off, Muse Code, Gemini CLI, Cursor) | Nothing wakes it: its next `swarm join` prints the ghost thread's latest words (`swarm status` lists the members only; the ghost thread is in no list or read) | — |

### The window

Approval `inbox-swarm-thread-ui`; all of it in `packages/inbox/swarm/` (styles `swarm.css`, `swarmBadge.css`), wired into ComposeDialog, Thread and App by single lines. The window learns the switch from `settings.experimental.swarm` (`useSwarmOn` in App, `useSwarmSwitch` anywhere); off, none of it renders and `thread.swarm` is absent anyway.

- New message (`useSwarmPicks`): after the first To, "Add an agent" picks more agents from any computer (`ToPicker` / `PhoneToSheet` with `checked`), each a chip; the Swarm badge at the row's end puts `/swarm` in the words. Send posts the others as `tags` (`machine` only when the pick is not on the thread's computer). The Swarm tip shows once across windows: `POST reveal` `{swarm_tip}` (`swarmTipClaim`, config `inboxReveals.swarm_tip`), refused while Swarm is off.
- A swarm thread (`useThreadSwarm`): the Ghost button first in the top bar (the Hug glyph, `ghost_unread` while above zero, no shortcut); the summary row in the meta line in place of "N sessions", whose chevron opens the status view (each member's computer, state as words, doing line; a sub-agent indented under its `for`; foot: Add an agent, Ghost thread, Turn off / Turn on).
- The ghost pane (`GhostPane`): local state of the thread pane, beside the thread the way a file is (the list column steps aside), covering it when the room is too narrow and on a phone, where its back button returns. Opening it posts `seen` when there is something unread; its box posts `say` (`GhostTo`: everyone or one joined member). A file opening closes it and opening it closes the file.
- The stream: a `swarm` line, and a ghost thread's message, go out as `{ kind: "swarm", id, thread_id: <swarm thread> }` (`eventPayload`), never as a message, so nothing notifies and the open thread re-reads (`threadOfRecord`, `applyRecord`).
- The window route checks the page's `serverSession` as every window write does (a tab from an earlier run: `409`), then takes it and `idempotency_key` off the body before it reads it. `{ on: true }` is Turn on for a swarm that exists (turned off); on any other thread it answers `409 not_a_swarm`: a swarm starts only from a message that names `/swarm`.
- The settings read carries `experimental.swarm` only while the switch is on.
- Escape: the status view's and the ghost box's lists close on it, never on an Escape pressed inside a modal dialog that does not hold them (New message; `swarm/escape.ts`); the Swarm tip, a note, closes on an Escape that goes on to New message, so one Escape closes that.
- A phone's New message: the other agents' marks, Add an agent's `+` and the badge sit inline after To's pill in the foot's row.
- Deleting a thread deletes its ghost thread with it (`deleteThread`); the swarm record goes with the thread's lines.

### `plannotator inbox swarm`

`apps/hook/server/inbox-swarm-command.ts`, a thin client over `POST /api/inbox/swarm` (`packages/server/inbox-swarm-route.ts`), with the capability command's guards: never through a device door, another site's page refused, a paired cloud agent through the agent door's `route`. `join <thread> [--as] [--for]` (idempotent; a name taken is refused; `--for` must name a member; a name, `--as` or the host's own, is one line of at most 60 characters, so the wake's notice names the agent who wrote and never falls back to the person's line), `doing "<line>"` (control characters out, at most 200 characters), `status [<thread>]`, `say "<text>" [--to <name>]`, `leave`. Without `--thread`, `say`, `doing`, `status` and `leave` act in the one swarm the caller is in. The words agents read are `SWARM_WORDS` (`packages/shared/inbox/swarm.ts`), `INBOX_SWARM_USAGE` and `INBOX_SWARM_HELP_SECTION`.

### Linked computers

The swarm lives on the thread's computer. A linked computer's agent runs the command on its own computer; that Inbox finds the thread's computer (`placeOf`: a wake it holds, a listed row, else a read) and asks its door's `POST swarm` (a machine's token only; `farSwarmAnswer`, as the far tags' `asSession`, refuses a session that is not the calling computer's: one live here, a member with no `machine` or another computer's, one a thread here is addressed to (`to` or a tag) with no `machine`, or one `sessionMachine` puts elsewhere, so a join never rewrites another computer's member). `say` to an away computer is held in the outbox as this Inbox's own write, as a far reply is (`packages/server/inbox-swarm-far.ts`, `holdSwarmSay`): the agent reads `FAR_REPLY_WORDS.held` ("Waiting for …"), and it goes once when that computer is back; its key (`swarm-say:<uuid>`) is written on the ghost message there, so a resend after a lost answer writes nothing more (`writeGhostMessage`). `join`, `status`, `doing` and `leave` are answered now; an away computer refuses them with `machine_offline`. A far join is kept in `swarm-far-joins.json` in the Inbox's data (0600; `createSwarmFarJoins`), so `say`, `doing` and `leave` need no `--thread` after a restart; `leave` forgets it. The window's `threads/:id/swarm` is on the door's allowlist, so the phone and a linked computer's window reach it.
