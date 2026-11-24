## Swarm

Several agents work on one Inbox thread as one team. Experimental, **off by default**: `PLANNOTATOR_EXPERIMENTAL=swarm` or config.json `{ "experimental": { "swarm": true } }`, with no Settings row (`resolveExperimental(config, "swarm")`). Off, nothing of it shows or answers: no `/swarm` skill in the catalog, no `swarm` on the thread read, `/api/inbox/swarm` answers `409 swarm_off`, `threads/:id/swarm` `404`, and `plannotator inbox --help` has no Swarm section.

Piece 1 (this): several agents in New message, the swarm record, the ghost thread, `plannotator inbox swarm`. Later pieces add the plan card, the task list (`swarm add`, `take`, `done`, `tasks`; until then the command refuses them with `not_available`) and Change plan.

### Starting a swarm

- The `/swarm` built-in skill (`packages/core/swarm-skill.ts`, the owner's approved text, pinned by `swarm-skill.test.ts`): the Swarm badge puts `/swarm` in the words, and the window pastes the text at Send like any human-only built-in.
- A person's message whose skills block names `swarm` (`inboxMessageStartsSwarm`, `packages/shared/inbox/swarm-start.ts`) starts the swarm of its thread when it is written (inbox.ts, beside the far tags' subscriber): the record and the ghost thread.
- New message to several agents: `to` is the first pick, the others ride `tags` (`startPersonThread`'s `tags`, resolved by the far tags' `targets`, so an agent on a linked computer can be picked). `tags` in a New message is refused while Swarm is off.
- What each agent is handed (`packages/server/inbox-swarm-wake.ts`): the message, then `swarmJoinLine(threadId)`. The stored body is unchanged.

### The record and the ghost thread

- One `swarm` record per thread (`InboxSwarmRecord`, `packages/core/inbox-swarm-types.ts`) in the project's `swarm.jsonl`, quiet like `steps` and `thread_pull`: `on`, `ghost_id`, `members` (each `session`, `host`, `name`, `machine?`, `machine_name?`, `for?`, `joined_at`, `doing?`), `person_seen_at`.
- The ghost thread is a real thread whose root (written by the Inbox, author `person`, empty body) carries `ghost_of: <thread id>`. The store keeps `ghostParents`; `listRow` answers null for it, so it is never in the list, a section, unread counts, notifications, the Board or Tidy; `threadsOf` skips it; search never indexes it; its messages are never a session's latest or first thread (sidebar, routing) and its person tags are not indexed.
- The wire: `InboxThread.swarm = { on, ghost_id, members, ghost_unread }` on `GET /api/inbox/threads/:id`. Members are the joined agents, then the agents the thread is addressed to (`to` and every person tag) that have not joined, `joined: false`. `state` is `working` / `idle` from the live connection (here or on a linked computer), `waiting` when the thread waits on the person after that agent's words, else null.

### Delivery inside a ghost thread

The only place an agent's words reach other agents. `store.isGhostSay(message)`: an agent message in a ghost thread with tags. `pendingReplies`, `pendingRepliesFor`, `pendingFor`, `recordDelivery` and `farSessions` accept it, for a tagged session that is a member of a swarm that is on, and only for a connection that words tags. Every other thread is exactly as before. A ghost message is handed as a notice (`moved` with its own `notice` line, `SWARM_WORDS.wake`), so it never reads as the person's reply. A far member's tag carries its `machine`; the far tags' `onPersonMessage` sends its wake there.

### `plannotator inbox swarm`

`apps/hook/server/inbox-swarm-command.ts`, a thin client over `POST /api/inbox/swarm` (`packages/server/inbox-swarm-route.ts`), with the capability command's guards: never through a device door, another site's page refused, a paired cloud agent through the agent door's `route`. `join <thread> [--as] [--for]` (idempotent; a name taken is refused; `--for` must name a member), `doing "<line>"` (control characters out, at most 200 characters), `status [<thread>]`, `say "<text>" [--to <name>]`, `leave`. Without `--thread`, `say`, `doing`, `status` and `leave` act in the one swarm the caller is in. The words agents read are `SWARM_WORDS` (`packages/shared/inbox/swarm.ts`), `INBOX_SWARM_USAGE` and `INBOX_SWARM_HELP_SECTION`.

### Linked computers

The swarm lives on the thread's computer. A linked computer's agent runs the command on its own computer; that Inbox finds the thread's computer (`placeOf`: a wake it holds, a listed row, else a read) and asks its door's `POST swarm` (a machine's token only; `farSwarmAnswer` refuses a session of the thread's computer's own). Answered now, never held: an away computer is refused with `machine_offline`. After a far join the asking Inbox remembers the swarm in memory so `say` needs no `--thread`; after its restart the agent passes `--thread`. The window's `threads/:id/swarm` is on the door's allowlist, so the phone and a linked computer's window reach it.
