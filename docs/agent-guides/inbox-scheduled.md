## Scheduled threads

A scheduled thread is a saved prompt with a name, a schedule, a folder, an agent and an on/off switch. Each run starts the agent the way New message does and works in one Inbox thread: every run replies there, and the person replies there to that run. Code: `packages/core/inbox-scheduled.ts` (the pure schedule rules, croner 11.0.0), `packages/server/inbox-scheduled.ts` (records, clock, runs), `inbox-scheduled-routes.ts` (the switch and the window's routes), `inbox-scheduled-login.ts` (start at login), `inbox-mcp-scheduled.ts` (the agents' tool). Types: `packages/core/inbox-scheduled-types.ts`.

A scheduled thread is managed on the computer that made it, and its runs' thread works from linked machines like any thread.

### The switch

Settings → Capabilities, config.json `inboxScheduledThreads` (`true`, else off). Not offered on Windows. Off: no timer, no run, no write, no `scheduled_thread` tool in tools/list, every `/api/inbox/scheduled…` route answers `404 scheduled_threads_off`, and a tool call from a session that listed it before answers `scheduled_threads_off` with nothing written. Records on disk are kept. Turning it on starts every scheduled thread that is on from the next due time, with no catch-up. "Start agents from New message" (`inboxLaunch.enabled`) must be on too: a run is a launch.

On also adds a start-at-login item, removed when it goes off and by `plannotator uninstall`: on macOS `~/Library/LaunchAgents/ai.plannotator.inbox.plist` (launchd reads it at the next login; it runs `plannotator inbox --no-open` for this data dir, no window); on Linux a systemd user unit `~/.config/systemd/user/plannotator-inbox.service`, enabled, only when `systemctl --user` answers (else none, and the switch reads `login: "unavailable"`).

### The record and the runs

Records live in `<dataDir>/inbox/scheduled.jsonl` (kind `scheduled`, one file for every project, last line per id wins, a delete is a tombstone). A run is a person-authored divider message in the thread (`scheduled_run: { scheduled_id, name, run, due_at, by, late?, missed_before?, failed? }`) whose body is the prompt (plus the late line, "This run was due Mon 9:00 AM and started Mon 11:14 AM."), carrying that run's own `launch` record and `to` its session. The first run (or skip line) starts the thread, named after the scheduled thread; later dividers take the thread over (`took_over`), so the person's plain reply goes to the newest run. A skip line is its own message, `scheduled_run` with `skipped` and no `run`: an Inbox note, sent to nobody ("Skipped Mon 9:00 AM · this computer was asleep").

One session per launched root is unchanged for every other thread: the store indexes only a scheduled thread's later run dividers beside the launched roots (`scheduledRunLaunches`), and the launcher's thread reads (run line, row, respawn, attach) follow the thread's newest run. Starting a run lets go of the previous run's session when it is idle. A reply to an earlier run (its divider or its session's message) is refused, `409 scheduled_run_ended`: "Run 3 has ended, so your reply was not sent. Reply to the latest run (Run 4) instead."

A run's outcome is read, never stored: `didnt_start` (no launch, or `failed`), `running`, `replied` (its session wrote after the divider), `didnt_finish`.

### The clock

One check when the switch is on or the Inbox starts, then every 30 seconds. A check that finds more than 2 minutes since the last one reads as the computer having slept (`asleep`); the first check after a start reads as the Inbox not running (`not_running`). Per scheduled thread that is on, approved and has a schedule: nothing due, wait; a run still going, skip (`still_running`); due more than 2 minutes ago and `if_missed: "skip"` or the next due time under 15 minutes away, one skip line for all of them; else one run for the newest due time (`late`, `missed_before`). `handled_through` moves to that due time. The run key `sch:<id>:<due_at>` is the divider's idempotency key, so a restart in the middle of a check answers the same run and never starts a second. A one-time schedule is Done after its run or skip.

The only limit is the 15-minute rule: a schedule whose runs come closer than 15 minutes apart is refused (`422 schedule_too_frequent`, "Scheduled threads run at least 15 minutes apart. This one runs every 5 minutes.", with `every_minutes`). Daylight saving: a time that does not exist runs at the next one; a time that happens twice runs once.

### Agents

The `scheduled_thread` tool (also `plannotator_inbox` action `scheduled_thread`; the shim fills it like `card`): `op` create, list, get, update, on, off, run, delete. Paired cloud agents (the agent door) do not get it.

- A scheduled thread an agent creates arrives off. The person turns it on the first time, in the Inbox (`approved_at` on the record); before that the agent's `on` and `run` answer `scheduled_not_approved` and change nothing. After that the agent may update, turn it on or off, run it and delete it.
- Each change posts one line, as the agent, in the thread the call names (`thread_id`), with `scheduled_change: { scheduled_id, name, op, fields?, turned_off? }` and a link `[Name](#scheduled=<id>)` that opens the editor. An edit says old and new: the schedule and folder in words, the prompt as a `diff` block.
- An agent's folder change turns it off and clears the approval; the line says so. Prompt and schedule edits apply at once.
- Runs start in the person's own permission mode, exactly as New message does.

### Routes (Bun only)

`GET /api/inbox/scheduled` → `{ scheduled: InboxScheduledRow[], launch_on }`. `GET /api/inbox/scheduled/:id` → `{ scheduled, runs }` (the newest 20). Writes are the window's only (same origin and `serverSession`; else `403 window_only`): `POST /api/inbox/scheduled` (create, `201`; `enabled: true` turns it on and approves it), `POST /:id` (update), `/:id/on`, `/:id/off`, `/:id/run` (`202`; `409 scheduled_running`), `/:id/stop`, `/:id/delete` → `{ deleted: true }` (its thread and past runs stay). `POST /api/inbox/scheduled/preview { schedule }` → `InboxScheduledPreview` (words, zone, next run, or the refusal). The settings read carries `scheduled_threads: { on, login? }` (absent on Windows); `POST /api/inbox/settings { scheduled_threads: { on } }` writes it and sends `event: capabilities`. A change to a record sends `event: record` with `{ seq, kind: "scheduled", id }` only.

### Linked machines

The record stays on the computer that made it: no door route and no list field carry it. Its runs' thread is an ordinary thread, so a linked machine shows it, replies in it and stops its run like any launched thread; the reply goes through the forward to this computer, where the same rules apply (the newest run takes it, an earlier one says it ended). Every divider keeps `name` on `scheduled_run`, so a linked machine's list shows the sender.
