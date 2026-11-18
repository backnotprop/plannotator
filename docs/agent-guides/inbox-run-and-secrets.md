## Run and Secret: commands the person runs, secrets they keep

Two Inbox-only blocks an agent writes in a message (owner's picks, 2026-11-17: "Run here and the Secret box together"; "anywhere I am signed in to my own Inbox"; "never burden me … no unnecessary barriers"). No switch, no confirmation, no Steps list: a card per block, one press. Bun only: the Pi server has no Inbox, so there is nothing to mirror there.

### The blocks

- `:::run` (`packages/core/inbox-run-blocks.ts`, `parseInboxRunBlocks`): first non-empty line the title, optional `Folder: <path>` (relative to the message's project folder; `~/…` under home; absolute as written), every other line outside the fence the why, and exactly one fenced code block, the command byte for byte. No fence, or two, and it is not a run block: plan review and the window draw it as a callout, each fence with its Copy, which is also how a viewer that does not know the block shows it. Key `r-` + hash8 of the command (`-2`… for a repeat in one message).
- `:::secret`: first line the name (`^[A-Z][A-Z0-9_]{1,63}$`, backticks or a `$` around it dropped), optional `Where: <url or place>` (a URL becomes "Find it on <host>"), other lines the why.
- Hidden characters (`inboxRunHiddenChar`): a command may hold line breaks, tabs and plain spaces; any other control, format (bidi, zero-width, BOM, tag characters), odd space, private-use, unassigned character, variation selector or filler refuses it. The card shows the command with each one as `⟨U+202E⟩`, says what and where in plain words, and has no Run, no Copy and no Open in terminal. The route refuses it too (`422 run_hidden_char`).

### What Run does

- The press sends `{ key, op: "start", command }`; the server parses the stored message (never the request's text) and runs that block only when `command` is its exact bytes (`409 run_changed` otherwise: a stale or forged page).
- `packages/server/inbox-run.ts`: the person's shell (`$SHELL` from the login env, else `/bin/sh`; Windows: `powershell.exe -NoProfile -NonInteractive -Command`) with `-c <command>`, in the block's folder, with the login-shell env (`createLoginEnv`, the launch's own reader; a sandboxed test Inbox: its sandbox env) plus every saved secret of the message's project as `$NAME`. Its own process group (POSIX `detached`; Windows `taskkill /T`), stdin a pipe held open.
- Output: stdout and stderr interleaved as they arrive, ANSI codes stripped, a `\r` progress line kept at its last state, every saved value of 4+ characters replaced by `••••` before it is kept, lines capped at 2,000 characters, the last 500 lines kept ("Showing the last N of M lines").
- Waiting for typing: quiet 2 s on a prompt-like last line (ends in `:`/`?`/`>`, or says password, y/n, press enter…) sets `waiting_for_input`; the card says so and makes Open in terminal primary. A run that fails saying it needs a terminal (`no tty present`, `a terminal is required`…) sets `needs_terminal`. No terminal emulator.
- Stop: TERM to the group, KILL after 2 s. When the command exits, what it left in its group is killed. A message gone (thread or project deleted, any path) stops its runs within a second (a sweep while anything runs) and sends nothing. The Inbox's stop (and its process `exit`) kills every group. One run per block at a time (`409 run_running`); Run again after it ends.
- Open in terminal (`op: "terminal"`): Open in's launcher (`openWithApp`) opens the first installed of Ghostty, iTerm2, Warp, Terminal, PowerShell in the folder; the window copies the command first and says "The command is copied: paste it there." Never types into the terminal.
- The result goes to the agent at once: `store.appendPersonNote` writes a person reply to the run's message (`inboxRunReportText`: "Command you asked the person to run: …", how it ended, the last 60 lines in a fence the output cannot close), delivered like any reply (the wake). The thread shows it, so the person sees what the agent got.
- Run state lives in the Inbox's memory: after a restart the card is idle again; the report in the thread keeps the result.

### Secrets

- Values: `packages/server/inbox-secret-vault.ts`, one interface (`get`, `set`, `remove`) and a `VaultRun` seam: macOS `security -i` with `add-generic-password -U -s plannotator-inbox -a <project id>:<NAME> -X <hex>` on stdin (read with `find-generic-password -w`); Linux `secret-tool store/lookup/clear` with the value on stdin, only with `DBUS_SESSION_BUS_ADDRESS` and `secret-tool` on PATH, falling back to the file when the keyring refuses; Windows DPAPI for the account through PowerShell (value on stdin, the protected blob in `inbox/secrets/<account>.dpapi`); elsewhere `inbox/secrets/<account>` (folder 0700, file 0600, "saved to a file only you can read"). A sandboxed test Inbox always uses the file in its own data dir. No value on a command line; errors are scrubbed of the value (and its hex).
- Index: `inbox/secrets.json` (0600), per project id: `{ name, saved_at, last4, store }`. `last4` only for a value of 16+ characters, else null. No value is ever in it, in the store, in a note, a log line or a read.
- Save writes a person note "Saved NAME on this computer. Every :::run in this project now has it as $NAME; its value is never shown to you." (Replace: "Replaced …"); Remove writes none.
- A run card shows the field inline ("Needs NAME") for each `$NAME` the command uses that an agent asked for in a `:::secret` block of the thread and the person has not saved.
- The field: `type="password"`, `autocomplete="current-password"` so a password manager fills it, cleared after Save; nothing kept in the window.

### Who may press

`packages/server/inbox-run-routes.ts`, `pressed()`: this computer's window or the owner's over the tailnet (`isWindowRequest`: the page's Origin, this Host, this run's serverSession; the tailnet gate already refused every other account), a paired phone through the device door, a linked machine's press in a window there (`door.window`). An agent's MCP connection, its `plannotator inbox` calls and a bare curl get `403 window_only`. No route answers a value. Both POSTs are rule 8 `now` writes: forwarded to a linked machine at once from a window there or not at all, never held in the outbox (a value is never written to it). The door records a POST's answer, never its body, and these answers are `{ ok: true }`.

### The window

- `packages/inbox/parts/RunBlocks/` (`RunCard`, `SecretCard`, `SecretField`, `RunOutput`, `RunBlock`), CSS `runBlocks.css`. Drawn through MessageBody's `renderRunBlock` (agent messages only), found by the block's opening line.
- State: `packages/inbox/data/runStore.ts` reads `GET …/run` once per message, every 500 ms while a run starts or runs, and on focus; a phone or a linked machine reads the same route on the owning machine, so it sees the same live card.
- Desktop, 390 px phone (44 px targets, a 16 px field so the phone does not zoom), dark and light by the theme's tokens. No new keyboard shortcuts.

### What agents are told

`INBOX_RUN_GUIDE`, `INBOX_RUN_EXAMPLE`, `INBOX_SECRET_EXAMPLE` (`packages/core/inbox-run-guide.ts`): send_message's `body` description (inbox-mcp.ts), `plannotator inbox --help` ("Commands the person runs, and secrets"), and `/llms/inbox.md`.

### Accepted, not defended

A program running as the person on this computer can read the keychain item or the file as the Inbox does, and can imitate a window (as for every window-only write, see `inbox-launch.md`). An agent with its own shell can run commands without the Inbox; Run is for what it cannot or should not.

Tests: `packages/core/inbox-run-blocks.test.ts`, `packages/server/inbox-run.test.ts` (real `/bin/sh` in a temp folder), `packages/server/inbox-run-routes.test.ts`, `packages/server/inbox-secret-vault.test.ts` (a fake `VaultRun`), `packages/inbox/runCards.test.tsx`.
