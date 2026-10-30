## Starting agents from the Inbox (launch)

The person picks **New Claude Code session** in compose's To, writes, and sends. Claude Code starts in the project with the person's own setup, and the thread is an ordinary thread with one quiet run line under the latest message. This is PR 1 of the launch plan: Claude Code only, project folders only.

**Behind a flag.** `inboxLaunch.enabled` in `~/.plannotator/config.json` (config only, default off; see `environment.md`). Off, every `/api/inbox/launch/*` route answers `404 { code: "launch_off" }`, `GET /api/inbox/sessions` carries no `launch` block, the `to.launch` form of `POST /api/inbox/messages` answers `404 launch_off`, list rows and thread reads carry no `run`, and the window draws nothing new. Existing users' UX is unchanged.

### Who hosts the agent

We start nothing that lives on its own. Claude's own supervisor hosts the session (`claude --bg`, Claude Code 2.1.314 or newer, `CLAUDE_LAUNCH_MIN_VERSION`), and messages move over the mod's existing bridge poll. The code:

- `packages/server/inbox-launch.ts`: the routes, the store glue, availability (cached 30 s, re-checked at once when the last check failed), the host read, respawn on reply, row decoration.
- `packages/server/inbox-launch-claude.ts`: the Claude CLI driver and its pure parsers (`parseBackgrounded`, `parseAgentsJson`, `agentByShort`, `startFailureOf`).
- `packages/server/inbox-launch-env.ts`: the login-shell env, the drop list, the settings-file env and the spawn env.
- `packages/core/inbox-run-line.ts`: `inboxRunOf`, the run line computed on read (never stored).

### The send

1. `prepare`: the project's folder must exist (`422 folder_missing`) and Claude Code must be available (`409 agent_unavailable`). Nothing is written when either fails.
2. Compose writes the thread to a placeholder recipient `{ claude-code, launch:<id> }` with `launch` on the root message (`InboxLaunchRecord`: id, agent, session_ref, folder, scratch, started_at, full_permissions, error, deleted_at). No poll can claim a placeholder, and a replayed idempotency key answers the same thread without a second `--bg`.
3. `begin`, in the background (the Send answers at once with `launch: { id, state }`): write `<dataDir>/inbox/launch/<id>/settings.json` (mode 0600), then run `claude --bg --name <thread name, else subject> --settings <file>` in the folder, adding `--permission-mode bypassPermissions` when full permissions is on. Nothing else goes on argv: no prompt, no secret. On success `store.settleLaunch` readdresses the root to the real session, whose mod takes it as its first turn through the existing new-thread wake. On failure it sets `launch.error` (`untrusted`, `failed`, or `missing`).

**The settings file** carries `env`, `permissions.allow: ["mcp__plannotator__plannotator_inbox"]` (the agent's own Inbox call never prompts) and `hooks.PermissionRequest`: one `*` command hook, `<plannotator> inbox permission-hook`, with the longest timeout Claude allows (see "Permission prompts"). `env` is the person's login-shell `CLAUDE_*` values minus per-session ones and minus `CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS`, `PLANNOTATOR_DATA_DIR` when it is not the default, `PLANNOTATOR_LAUNCH` and `PLANNOTATOR_LAUNCH_KEY`; `CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS=1` is added only when the full-permissions switch is on. `model` is set only from `inboxLaunch.model` (config only, a plain model name; the real-CLI smoke sets `haiku`).

**Envs.** One filter (`launchSpawnEnv`) drops every `PLANNOTATOR_*` name, Claude's per-session names (CLAUDECODE, CLAUDE_PID, CLAUDE_CODE_SESSION_*, CLAUDE_CODE_MESSAGING_*, CLAUDE_CODE_CHILD_SESSION, CLAUDE_CODE_ENTRYPOINT, CLAUDE_CODE_EXECPATH, CLAUDE_JOB_DIR, CLAUDE_PROJECT_DIR) and the skip-permissions export; the person's own settings (CLAUDE_CONFIG_DIR, SSH_AUTH_SOCK, proxies, LC_*) stay. The login shell (`$SHELL -ilc`, 5 s at most) is read for a start only, starting from the Inbox's env through that filter. The `--bg` call runs with its result through the filter, plus `CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS=1` only when the full-permissions switch is on. Every other call (`--version`, `agents`, stop, respawn, rm, osascript) runs with the Inbox's own env through the filter, its PATH followed by the last start's login PATH and `~/.local/bin`, `~/.claude/local`; availability looks for `claude` there (before any start, without the login PATH). No `claude` call is ever killed with its process group: any of them may start the person's shared supervisor. A sandboxed test Inbox (`PLANNOTATOR_TEST_SANDBOX`) reads no login shell and searches no install folder.

### The run line

`inboxRunOf` maps the launch record, the mod's poll (`runStateOf` in `inbox-sessions.ts`: busy, busy since, poll count) and the host's status to one of:

| State | Line | Row word / tick |
| --- | --- | --- |
| `starting` | Starting Claude Code in <project>… (again… after a respawn) | Starting |
| `working` | Claude Code is working · N min, Stop | Working |
| `waiting_terminal` | Claude Code is waiting on a permission prompt · N min, Open in Terminal, the attach command, Stop (phone: no Open) | the row goes to Stopped on you, unread |
| `waiting_answer` | Claude Code is waiting on your answer · N min, Stop (a permission question is open in the thread) | the row goes to Stopped on you, unread |
| `stopped` | You stopped Claude Code at <time>. Your reply starts it again. | none |
| `failed` | Claude Code didn't start. <cause> Your message is kept. Try again (Open in Terminal for an untrusted folder) | Not delivered |
| `missing` | Claude Code isn't on this computer any more. … plus Send to another session | Not delivered |
| `null` | no line: the agent rests | none |

`starting` holds from Send until the session polls busy or answers: the mod takes the turn one poll before it reports busy, and the line must not blink out in between (`Memo.busySeen`, reset at each start and respawn). `waiting_terminal` needs the session not to be live and idle: once the person answers in Terminal and the turn ends, the line goes even before the next host read.

After Stop or a respawn, the session's earlier polls would keep it "live"; it counts as live again only once it starts a poll past the count recorded at that moment (`Memo.quietPolls`). A reply to a launched session that is not live runs `claude respawn <short>` once per reply. A respawn that exits non-zero, or never polls within a minute, reads `failed` with Try again (`missing` when the CLI is gone, which a failed respawn re-checks at once); it is never retried by itself. Try again respawns an existing session and runs a new `--bg` only after a failed start.

**When the CLI is read.** Only while a window watches (`sweep(watched)`): availability every 30 s while a launched thread exists, and `claude agents --json --all` at most every 10 s while a launched session works or the host last said it waits on a prompt. With no window open, nothing runs but a respawn a reply asks for.

**Delete and Try again during a start.** Try again is refused while a start or respawn runs. Delete during a start marks the launch deleted; when `--bg` answers, the session it made is stopped and removed and the thread is left as it is. A session `--bg` started but the supervisor never listed is stopped and removed before the start is marked failed.

### Permission prompts

A launched session asks its permission prompts in the thread, not only in Terminal. The code:

- `packages/core/inbox-permission.ts` (pure, browser-safe): the question's body and choices from the hook's event, the decision from the person's answer, the hook's output.
- `packages/server/inbox-launch-permission.ts`: the long-poll route, the question's lease and its withdrawal.
- `apps/hook/server/inbox-permission-hook.ts`: `plannotator inbox permission-hook`, the hook the settings file names.

**The hook.** Claude runs it for every prompt with the event on stdin. ExitPlanMode prints nothing at once (plan review keeps it, through the plugin's own hook), and so does a session without `PLANNOTATOR_LAUNCH` and `PLANNOTATOR_LAUNCH_KEY`. Otherwise it posts `{ key, request_id, event }` to `POST /api/inbox/launch/:id/permission` and long-polls (about 25 s a call, `message_id` after the first) until the person decides. It prints nothing when the question is withdrawn, so Claude's own dialog decides. While the Inbox is down (no `inbox.json`, a refused connection, `5xx`, `401` after a restart) it reads `inbox.json` again and retries every 2 s. Printing nothing never blocks the session: the Terminal dialog is always there too.

**The route.** Guarded like the bridge (loopback Host, no Origin, the Inbox's Bearer token), and then the launch's key: it must match `env.PLANNOTATOR_LAUNCH_KEY` in `launch/<id>/settings.json` (`403 wrong_key`; `410 launch_gone` for a deleted launch, `404 launch_off` while launch is off). The first call asks: one `:::question` message in the launch thread, authored by `{ claude-code, perm:<session>, "Claude Code" }` so the person's words never go to it and it wakes no one (`wakes: false`), keyed `perm-<request_id>` so a replayed call finds it. Answers: `{ status: "waiting" | "decided" | "withdrawn", message_id, decision? }`.

**The question.** "Claude Code wants to run a command" (edit, write or read a file, open a web page, search the web, use a tool from a server), the command or path in a code block, "in <folder>", and three choices: Allow once, Allow <the first suggestion> for this session (a rule like `bun run`, file edits, a folder, a site; only when Claude suggests one, never bypass mode, always `destination: "session"`), and Deny. The card's eyebrow reads "Permission" and its Other field "Deny, and tell it why…" (the `questionChrome` seam on `QuestionBlock`). The person picks and sends as with any question; the foot says "1 permission waiting". Allow returns the tool's input unchanged; Deny tells Claude not to retry, with the person's words as the reason. Skip or a free answer is a deny.

**The lease.** A question lives while its hook holds a call, and 60 s after the last one ends. It is withdrawn (a follow-up from the same author that `supersedes` it, so the card reads "No longer applies") with "Answered in Terminal." when the host says the session went on (a fresh `claude agents` read after the question: not waiting, not stopped), or with "No longer waiting." when the lease runs out otherwise (after one more host read). Stop and Delete withdraw at once. An Inbox restart adopts open questions and gives them a new lease.

### Window routes

Same origin and `serverSession`, like every window write. Open and the settings route are refused over the tailnet.

- `POST /api/inbox/launch/:id/stop`: `claude stop`.
- `POST /api/inbox/launch/:id/open`: macOS Terminal through `osascript`, running `claude attach <short>` in the folder (plain `claude` in an untrusted folder, so its trust prompt shows).
- `POST /api/inbox/launch/:id/delete`: stop, `claude rm`, and remove `launch/<id>/`. The thread stays. Never `claude purge` on a project folder. Not offered on a phone.
- `POST /api/inbox/launch/:id/retry`: Try again after a failed start (a new `--bg`), a failed respawn (`claude respawn` again), or a start that never connected (`claude respawn`, or a new `--bg` when no session was made).
- `POST /api/inbox/launch/settings`: `{ full_permissions }`, Settings → Agents' "Start new sessions with full permissions" switch.

### The window

- Compose's To picker (`ToPicker.tsx`) lists start rows after the running sessions under the caption "Start a new session in <project>", one per available agent (`startBlock` in `compose/model.ts`). Picking one makes the To sentence "New Claude Code session ▾ in <project> ▾"; the folder button opens `FolderMenu.tsx` (recent projects; a missing folder is struck through). A missing folder shows a note and keeps Send off; Save draft keeps the words and the project.
- The thread header says "You started Claude Code in <project>" (and "Full permissions"). `RunLine.tsx` replaces the delivery line while `run` is not null. The thread ⋯ adds Open in Terminal, Copy attach command, Stop Claude Code, and Delete Claude Code session… (asks first, in the thread). A phone gets Copy attach command and Stop only. A stopped session's reply head reads "Reply to Claude Code in <project> · starts it again".
- No new keyboard shortcuts.

### Tests

- E2E: `tests/e2e/inbox-launch-claude.spec.ts` drives the sandboxed compiled Inbox and the real compose UI against the real endpoint, with the fake CLI from `tests/helpers/fake-claude/` (`installFakeClaude`: a `claude` that follows the contract recorded for `--bg`, `agents --json`, `stop`, `respawn`, `rm`, `attach`; a logging `osascript`; a counted login shell). `LAUNCH_SHOTS_DIR` saves its screenshots.
- Permission prompts: `tests/e2e/inbox-launch-permission.spec.ts` (allow once, allow for this session, deny with a reason, answered in Terminal, Stop while waiting, the Inbox stopping mid-wait, ExitPlanMode). The fake `claude` plays `prompts` through the real hook from the settings file. `LAUNCH_PR2_SHOTS_DIR` saves its screenshots. Unit: `packages/core/inbox-permission.test.ts`, `packages/server/inbox-launch-permission.test.ts`, `apps/hook/server/inbox-permission-hook.test.ts`.
- Unit: `packages/core/inbox-run-line.test.ts`, `packages/server/inbox-launch-env.test.ts`, `packages/server/inbox-launch-claude.test.ts`, the launch block of `packages/inbox/composeModel.test.ts`.
- Real CLI (manual, never in CI): `scripts/launch-smoke/`. It runs real `claude` sessions in a scratch folder against a test Inbox on its own data dir; read its header before running it.
