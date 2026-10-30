## Starting agents from the Inbox (launch)

The person picks **New Claude Code session** in compose's To, writes, and sends. Claude Code starts in the project with the person's own setup, and the thread is an ordinary thread with one quiet run line under the latest message. This is PR 1 of the launch plan: Claude Code only, project folders only.

**Behind a flag.** `inboxLaunch.enabled` in `~/.plannotator/config.json` (config only, default off; see `environment.md`). Off, every `/api/inbox/launch/*` route answers the unknown-route 404, `GET /api/inbox/sessions` carries no `launch` block, the `to.launch` form of `POST /api/inbox/messages` answers `404 launch_off`, list rows and thread reads carry no `run`, and the window draws nothing new. Existing users' UX is unchanged.

### Who hosts the agent

We start nothing that lives on its own. Claude's own supervisor hosts the session (`claude --bg`, Claude Code 2.1.314 or newer, `CLAUDE_LAUNCH_MIN_VERSION`), and messages move over the mod's existing bridge poll. The code:

- `packages/server/inbox-launch.ts`: the routes, the store glue, availability (cached 30 s, re-checked at once when the last check failed), the host read (`claude agents --json --all`, at most every 10 s and only while a launched thread needs it), respawn on reply, row decoration.
- `packages/server/inbox-launch-claude.ts`: the Claude CLI driver and its pure parsers (`parseBackgrounded`, `parseAgentsJson`, `agentByShort`, `startFailureOf`).
- `packages/server/inbox-launch-env.ts`: the login-shell env, the drop list, the settings-file env and the spawn env.
- `packages/core/inbox-run-line.ts`: `inboxRunOf`, the run line computed on read (never stored).

### The send

1. `prepare`: the project's folder must exist (`422 folder_missing`) and Claude Code must be available (`409 agent_unavailable`). Nothing is written when either fails.
2. Compose writes the thread to a placeholder recipient `{ claude-code, launch:<id> }` with `launch` on the root message (`InboxLaunchRecord`: id, agent, folder, project, full_permissions, key hash). No poll can claim a placeholder, and a replayed idempotency key answers the same thread without a second `--bg`.
3. `begin`, in the background (the Send answers at once with `launch: { id, state }`): write `<dataDir>/inbox/launch/<id>/settings.json` (mode 0600), then run `claude --bg --name <subject> --settings <file>` in the folder, adding `--permission-mode bypassPermissions` when full permissions is on. Nothing else goes on argv: no prompt, no secret. On success `store.settleLaunch` readdresses the root to the real session, whose mod takes it as its first turn through the existing new-thread wake. On failure it sets `launch.error` (`untrusted`, `failed`, or `missing`).

**The settings file** carries `env` and `permissions.allow: ["mcp__plannotator__plannotator_inbox"]` (the agent's own Inbox call never prompts). `env` is the person's login-shell `CLAUDE_*` values minus per-session ones, `PLANNOTATOR_DATA_DIR` when it is not the default, `PLANNOTATOR_LAUNCH` and `PLANNOTATOR_LAUNCH_KEY`, and `CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS=1` with full permissions. `inboxLaunch.extraSettings` (config only) is the base the file starts from: its keys pass through, its `env` and `permissions.allow` are merged under ours, and ours win. The real-CLI smoke uses it for `{ "model": "haiku" }`. The spawn env drops the Inbox's own per-session variables (the drop list in `inbox-launch-env.ts`). A sandboxed test Inbox (`PLANNOTATOR_TEST_SANDBOX`) reads no login shell.

### The run line

`inboxRunOf` maps the launch record, the mod's poll (`runStateOf` in `inbox-sessions.ts`: busy, busy since, poll count) and the host's status to one of:

| State | Line | Row word / tick |
| --- | --- | --- |
| `starting` | Starting Claude Code in <project>… (again… after a respawn) | Starting |
| `working` | Claude Code is working · N min, Stop | Working |
| `waiting_terminal` | Claude Code is waiting on a permission prompt · N min, Open in Terminal, the attach command, Stop (phone: no Open) | the row goes to Stopped on you, unread |
| `stopped` | You stopped Claude Code at <time>. Your reply starts it again. | none |
| `failed` | Claude Code didn't start. <cause> Your message is kept. Try again (Open in Terminal for an untrusted folder) | Not delivered |
| `missing` | Claude Code isn't on this computer any more. … plus Send to another session | Not delivered |
| `null` | no line: the agent rests | none |

After Stop or a respawn, the session's earlier polls would keep it "live"; it counts as live again only once it starts a poll past the count recorded at that moment (`Memo.quietPolls`). A reply to a launched session that is not live runs `claude respawn <short>` once; a failed respawn re-checks availability, so an uninstalled CLI shows `missing` at once.

### Window routes

Same origin and `serverSession`, like every window write. Open and the settings route are refused over the tailnet.

- `POST /api/inbox/launch/:id/stop`: `claude stop`.
- `POST /api/inbox/launch/:id/open`: macOS Terminal through `osascript`, running `claude attach <short>` in the folder (plain `claude` in an untrusted folder, so its trust prompt shows).
- `POST /api/inbox/launch/:id/delete`: stop, `claude rm`, and remove `launch/<id>/`. The thread stays. Never `claude purge` on a project folder.
- `POST /api/inbox/launch/:id/retry`: Try again after a failed start.
- `POST /api/inbox/launch/settings`: `{ full_permissions }`, Settings → Agents' "Start new sessions with full permissions" switch.

### The window

- Compose's To picker (`ToPicker.tsx`) lists start rows after the running sessions under the caption "Start a new session in <project>", one per available agent (`startBlock` in `compose/model.ts`). Picking one makes the To sentence "New Claude Code session ▾ in <project> ▾"; the folder button opens `FolderMenu.tsx` (recent projects; a missing folder is struck through). A missing folder shows a note and keeps Send off; Save draft keeps the words and the project.
- The thread header says "You started Claude Code in <project>" (and "Full permissions"). `RunLine.tsx` replaces the delivery line while `run` is not null. The thread ⋯ adds Open in Terminal, Copy attach command, Stop Claude Code, and Delete Claude Code session… (asks first, in the thread). A stopped session's reply head reads "Reply to Claude Code in <project> · starts it again".
- No new keyboard shortcuts.

### Tests

- E2E: `tests/e2e/inbox-launch-claude.spec.ts` drives the sandboxed compiled Inbox and the real compose UI against the real endpoint, with the fake CLI from `tests/helpers/fake-claude/` (`installFakeClaude`: a `claude` that follows the contract recorded for `--bg`, `agents --json`, `stop`, `respawn`, `rm`, `attach`; a logging `osascript`; a login shell). `LAUNCH_SHOTS_DIR` saves its screenshots.
- Unit: `packages/core/inbox-run-line.test.ts`, `packages/server/inbox-launch-env.test.ts`, `packages/server/inbox-launch-claude.test.ts`, the launch block of `packages/inbox/composeModel.test.ts`.
- Real CLI (manual, never in CI): `scripts/launch-smoke/`. It runs real `claude` sessions in a scratch folder against a test Inbox on its own data dir; read its header before running it.
