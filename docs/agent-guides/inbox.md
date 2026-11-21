## Plannotator Inbox

The Inbox details are split by topic. Read the foundation guide for command, server, storage, and list behavior, then follow the links for the window, messages, files, notifications, or phone behavior relevant to your change.

- [`inbox-foundation.md`](inbox-foundation.md) — command (with `plannotator inbox call`, the scripting command, and who a script is per host), local and tailnet reach, registry, store, threads, and list.
- [`inbox-window.md`](inbox-window.md) — main window, questions, and send behavior.
- [`inbox-messages.md`](inbox-messages.md) — drafts, replies, thread actions, and project menu.
- [`inbox-run-and-secrets.md`](inbox-run-and-secrets.md) — `:::run` (a command the person runs with one press, on the computer that owns the thread, the result sent to the agent) and `:::secret` (a value kept in the keychain, given only to a run that names it); who may press, storage per OS.
- [`inbox-compose.md`](inbox-compose.md) — composing messages and routing them to agents.
- [`inbox-launch.md`](inbox-launch.md) — starting Claude Code, Pi or Codex from New message (on by default; Settings → Agents' switch, `inboxLaunch.enabled`), the run line, Stop, Open and Delete.
- [`inbox-routines.md`](inbox-routines.md) — routines: a saved prompt an agent runs on a schedule, every run in one thread (Settings → Capabilities, `inboxScheduledThreads`, off by default); the clock, missed runs, the agents' `routine` tool, start at login, linked machines.
- [`inbox-files-and-guides.md`](inbox-files-and-guides.md) — attachments, annotations, images, and guided reviews.
- [`inbox-notifications-and-agents.md`](inbox-notifications-and-agents.md) — search, event streams, notifications, Board, and agent connections.
- [`inbox-phones-and-security.md`](inbox-phones-and-security.md) — phone pairing and surface, security boundaries, and proofs.
- [`inbox-cloudflare-access.md`](inbox-cloudflare-access.md) — reach through the person's own Cloudflare Tunnel and Access: the door's checks, session routing, setup and teardown.
- [`inbox-machines.md`](inbox-machines.md) — linked machines: one Inbox across machines, the link, the merged view, the forward and the outbox.
- [`inbox-accounts.md`](inbox-accounts.md) — Settings → Accounts: the Claude accounts and usage of this computer and its linked machines, read through claude-swap.
- [`inbox-plans.md`](inbox-plans.md) — Plans: the library of every plan plan review handled (config.json `inboxPlans`, off by default; `plannotator plans` turns it on); its records, the library on disk, the read-only import from `history/`, `plans/` and `feedback/`, the capability seam, the `/api/plans` routes and the Plans page in the window.
- [`inbox-system.md`](inbox-system.md) — System: a drawing of each project's code (config.json `inboxSystem`, hidden in 0.29; Settings → Capabilities → System, only with Code review on); the switch, the Reviews System button and a project's drawing, the project setup dialog and its `setup.json`.
