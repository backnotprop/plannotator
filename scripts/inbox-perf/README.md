# Inbox performance harness

A repeatable baseline for the Plannotator Inbox: a data generator, a store-level benchmark that needs no server, and a live baseline that times one sandboxed Inbox over HTTP. Nothing here touches `~/.plannotator`, the real Inbox or an agent CLI.

## 1. Seed a world

```sh
bun scripts/inbox-perf/seed.ts --preset medium --out /tmp/inbox-perf/seed-medium
```

| preset | threads | messages | agents | projects |
|---|---|---|---|---|
| small | 200 | 2,000 | 5 | 4 |
| medium | 1,000 | 10,000 | 40 | 8 |
| large | 2,000 | 20,000 | 150 | 12 |
| huge | 5,000 | 60,000 | 400 | 20 |

`--out` must be a new folder in the OS temp dir or `/tmp`. Every line is written through the store's own code (`InboxStore`, `recordInboxAttachments`, `captureInboxInlineImages`). The world has:

- agent and person messages, questions and answers, replies (delivered and pending), tags and hand-offs;
- attachments (small files under `src/`) and images named by path, about a third of them missing;
- launched-agent threads (two agents in three), Board cards, initiatives, routines (all off), snoozes, pins and archived threads;
- projects whose folders do not exist on this machine (`/home/...`, another user's `/Users/...`);
- one 400-message thread.

The content is made up. `manifest.json` lists what was made, including every agent session (host, live or ended, launched, folder, loaded plugin). The same `--seed` always makes the same shape.

## 2. Store-level benchmark (no server)

```sh
bun scripts/inbox-perf/bench-store.ts --root /tmp/inbox-perf/seed-medium --runs 15 --label main --out results-medium-main.json
```

It copies the seeded data dir to a new scratch folder first, because the appends and the deletion write to it. It then times these, each repeated (median, p95, min, max):

- the open, and its memory in a fresh process;
- `listRows`: a full build and a memo hit, with no presence and with the server's presence;
- a 400-message thread read;
- `pendingReplies` once per session against `pendingRepliesFor` in one pass;
- the launch engine's `sweep`, `signature`, `agents` and `rowDecorator`, with fake agent hosts;
- the live sessions' restart judgment (`restartAgents`, `connectionOf`, `reloadOfferFor`), with polls fed in;
- a search index build and queries;
- appends, `diskUsage`, and a deletion (a full-file rewrite and a reload).

To time a branch, copy `scripts/inbox-perf/` into its worktree and run it there.

## 3. Live baseline (one sandboxed Inbox)

Build first (`bun run --cwd apps/review build && bun run build:hook`). Then run:

```sh
bun scripts/inbox-perf/live.ts --root /tmp/inbox-perf/seed-medium --port 47953 --label main --out results-medium-main-live.json
```

The script copies the data dir, turns launch and routines off, and pins the port: it seeds `inbox/inbox.json` with a dead pid and `--port`. The port must be free and never 59812, 58437 or 58455. It then:

1. Starts the Inbox through `live-inbox.sh`. The script uses `env -i` with every variable spelled out: a scratch `HOME`, `PATH` with only a link to bun plus the system folders (checked: no agent CLI), `PLANNOTATOR_TEST_SANDBOX=1` and `PLANNOTATOR_INBOX_DEBUG=1`.
2. Reads the Inbox's environment back with `ps eww` and checks it before the first request.
3. Starts the seed's live sessions polling `/api/inbox/bridge/poll`.
4. Times each route cold (the first read) and then warm (`--warm` repeats).
5. Samples CPU and RSS for `--idle` seconds (default 60): first with no window, then with one window's event stream open.
6. Stops the Inbox by its pid and collects the `loop_stall`, `slow_req` and `store_load` lines from the Inbox's `debug.log`.

Run one Inbox at a time.

## 4. Tables

```sh
bun scripts/inbox-perf/summary.ts <results dir> > summary.md
```

## A budget check in CI (not wired)

A CI job could seed `medium` (about 1 s), run `bench-store.ts --runs 9`, and compare chosen medians with a checked-in budget file. A job fails when a median is over its budget by more than a margin that covers shared-runner noise (for example 2x). The best candidates are the measurements that grow with sessions × messages:

- `pendingReplies x every session`
- `launch.signature()`
- `delivery tick`
- `list read`
- `listRows memo check (server presence)`

The cheap reads (thread read, `listRow`) are poor candidates because their noise is larger than their size. A second guard is the ratio `large / medium`. It does not depend on the runner's speed. On the first baseline it was about 2 for an O(messages) path and about 8 for an O(sessions × messages) path, because large has 2x the messages and 3.7x the launched agents of medium.
