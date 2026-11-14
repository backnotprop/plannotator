## Inbox preferences: one list, one way to set them

Every setting a person changes in the Inbox window that the Inbox keeps has one short dotted key (`appearance.theme`, `sidebar.hidden`, `agents.codex.reach`) in one list, `packages/core/inbox-prefs.ts`. `GET /api/inbox/prefs` lists the keys with their values now; `POST /api/inbox/prefs` sets or resets several at once (the Server API table in `server-and-storage.md`). A key never changes once shipped. Bun only, like the rest of the Inbox.

### The list

Each entry has its key, type and allowed values, default (what `reset` writes), `stored` (a config.json path, or `file:<name>` in the data dir), and scope: `person` (the person's choice wherever they use the Inbox) or `device` (about this computer: its agents' files, a folder path, the doors it opens). The words (label, meaning, where) live in `packages/core/inbox-prefs-words.ts`, pending the owner's approval; no other file holds them.

- `noReset`: no default to put back (connecting an agent, an agent's note); `reset` refuses it and `reset: "all"` leaves it.
- `secret` (`voice.api_key`, `cloud_agents.<id>.wake`): set like any other key, never read back. Reads, answers and refusals say `"set"` or `"not set"`; a refusal never repeats the value; `event: prefs` carries keys only; `reset: "all"` leaves secrets (naming one removes it).
- `cloud_agents.<id>.wake` is one key per cloud agent whose preset wakes (`inboxCloudWakePref`); its value is `{ url, key }`.
- `nextStart`: read by the Inbox at its next start only (`general.plannotator_localhost`).

Not in the list: one-time stamps (the tour, intros, the update reminder's snooze, the star ask), the group C settings the window keeps in the browser, per-record values (a thread's, a project's), and actions (pair a phone, pair or re-pair a cloud agent, switch the Claude account, delete a session, a thread or a project).

### How a write runs

`packages/server/inbox-prefs.ts` reads from what the window's own routes answer this caller (the settings answer, config.json, Settings → Agents, the phones' doors, the cloud agents) and writes through those routes, one in-process request each, with the caller's own headers. So a key has one stored value, one check and one guard: its route's. Nothing is looser than the route.

1. Every key and value is checked against the list (`inboxPrefsChange`): one unknown key or bad value refuses the call, naming the key and what it takes.
2. A key not offered now (a held switch, launch while off, risk rules while Code review is off, a door this Inbox does not serve): `409 pref_unavailable`.
3. The routes run in order: the tailnet logins, settings (it checks all its fields before it writes one), launch (its switch before its folder), each agent, Post decisions, risk rules, the voice key, This Wi-Fi, the phones' tailnet door, each cloud agent's wake. A refusal answers the route's status and body with `keys` and `saved` (keys an earlier route already wrote).
4. The answer lists `{ key, from, to }` for each value that moved.

The guard each call goes through is its route's: the general write guard on every POST (same origin, or no Origin: the command line), `serverSession` when sent, and over the tailnet the tailnet gate (only the account that owns this computer gets past it). Phones reach none of it: the device door's allowlist does not name these routes.

### Live

Every save of a key, from the prefs route, Settings in any window, or Settings → Agents, Post decisions, risk rules, launch and the tailnet logins, sends windows one `event: prefs` `{ keys, by }` (a prefs call sends one for the whole call, not one per route). A window reads its settings again and takes the theme, text size, tab icon, diff settings, rows, sidebar, reactions and voice at once (`takeSaved*` in `packages/inbox/`); before this event an open window took config.json only at its first read.

### Keeping it whole

`packages/server/inbox-prefs-coverage.test.ts` fails when the settings route reads a body field that is neither a key's nor on `INBOX_SETTINGS_NOT_PREFS` with its reason, when Settings → Agents' or launch's routes take a field no key writes, when a diff field has no key, when a key's `stored` names a config.json field that is gone, and when the agent hosts or tool defaults drift from `packages/shared/config.ts`. `packages/server/inbox-prefs-route.test.ts` writes keys through the real routes and reads them back. A new Settings control that saves a value gets an entry in the list, its words, and a binding in `inbox-prefs.ts`.
