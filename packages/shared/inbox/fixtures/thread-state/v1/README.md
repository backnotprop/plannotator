# Inbox thread-state traces, v1

Event sequences with the list state the Inbox gives after each step. A phone kit replays them in a unit test to check that its own handling of the list (placing rows, counts, optimistic updates after a look, Mark read or Archive) agrees with the Inbox. The model they follow is `adr/implementation/inbox-thread-state.md`.

`index.json` lists the trace files. Each trace is one JSON file:

| Field | Meaning |
|---|---|
| `format`, `version` | `"plannotator-inbox-thread-state"`, `1` |
| `name`, `description` | The trace and what it shows |
| `source`, `seed` | `"hand"` (seed `null`) or `"generated"` (the fast-check seed it came from) |
| `clock` | `start` and `step_ms`: everything written at step n is stamped `start + n * step_ms`. No two steps share a time, so no `last_at` or `resolved_at` ties: a thread id ends in random characters, and a tie's order would change from run to run. Break ties on the thread id yourself; the store's own test exercises that |
| `known_violations` | A list, empty when none: `{ step, kind, test, rule, spec, today }` for each step where the Inbox breaks a rule of the model (`kind` `A`, `B` or `C`, as in the model doc). `expect` records what it does then; `spec` says what the rule wants. A, B and C are fixed, so every list is empty now: every step's `expect` is the rule's answer. The field stays in the format for a violation found later |
| `steps` | One entry per event, in order |

## A step

| Field | Meaning |
|---|---|
| `event` | The input (below) |
| `outcome` | `"ok"`, or `"refused:<code>"` with the Inbox's error code (`thread_resolved`, `invalid_supersedes`, `validation_error`, `nothing_to_send`, `question_set_aside`, `question_superseded`). A refused event writes nothing |
| `created` | Labels of the messages the event wrote, in order (an agent message, the person's reply, or the Inbox's notes) |
| `lands_in` | For an `agent_message` that was written: the thread it landed in |
| `expect` | The state after the step (below) |

Labels: `m1`, `m2`, ... are messages in the order they were written; `t1`, `t2`, ... are threads in the order they started. A thread's first message is its root. A question is `<message>/<key>`, where the key is the Inbox's own question key (`q-` and 8 hex digits, from the question's kind and prompt).

## Events

| `type` | Fields | What it is |
|---|---|---|
| `agent_message` | `project` (`repo0` or `repo1`), `session` (roots only: `ses_a`, `ses_b` or `null`), `reply_to` (a message label or `null`), `supersedes` (optional, one entry: the replied-to message, or its first question), `body` | An agent's `send_message`. Without `reply_to` it joins the newest unnamed thread that session started in the project, only while that thread is open (never an older open one), else starts a thread; with no session it always starts one. `lands_in` says where it went. The body is Markdown with `:::question` blocks |
| `seen` | `thread`, `through` (optional, a message label) | The person looked at the thread (`POST /seen`). Without `through`: every agent message in it so far. With `through`: the look stops at that message's seq (`through_seq`), so an agent message written after it stays new; a cap at or behind the recorded look changes nothing, and one past the thread's newest message (it may name another thread's later message) covers all of it. Only `hand-18-look-capped-by-through` uses it; a kit that replays the field as the server does needs nothing else |
| `pick` | `message`, `key`, `choice` (a choice label) or `text` | The person saved an answer, not sent |
| `send` | `message`, `words`, `skip_unanswered` | The person's Send on that message: every picked question on it, plus the words; `skip_unanswered: true` also sends its open questions as skips (`false` is Keep open). Each Send uses its own idempotency key |
| `mark_read`, `unread` | `thread` | Mark read, and its Undo |
| `archive`, `unarchive` | `thread` | Resolve `true` and `false` |
| `agent_read` | `thread` | An agent read the thread (`read_thread`, or `wait_for_reply` handed it the reply) |
| `set_aside_note` | `thread` | The Undo window passed: the Inbox writes its set-aside notes to the asking agent (it does this by itself 10 s after a Mark read) |
| `person_thread` | `project`, `session` (`ses_a` or `ses_b`), `body` | The person starts a thread from the Inbox, addressed to that live session (compose, `POST /api/inbox/messages`). Its root is the person's message; it is in Sent until the session takes it. It is no session's default thread: an agent message without `reply_to` never joins it. Each uses its own idempotency key. Only `hand-19-person-started-thread` uses it |
| `delivered` | `thread` | The addressed session's connection delivered what the person sent it in that thread (bridge `delivered`): it counts as the agent having read the thread up to that message, so a Sent row moves to Quiet |

## expect

| Field | Meaning |
|---|---|
| `sections` | The default list (`GET /api/inbox/threads`): the six sections in order, each with its thread labels in order. Archived threads are in `quiet` |
| `sections_exclude_archived` | The window's list (`?archived=exclude`): archived threads are left out |
| `archived` | The archived list (`GET /api/inbox/threads/archived`), newest archived first |
| `counts` | `waiting`: the sidebar count (rows in Stopped, Holding, Waiting). `unread`: rows drawn bold (Stopped, Holding, Waiting, New). `decisions_waiting`: the Decisions count |
| `threads` | Per thread: `section`, `unread`, `unseen`, `read` (Mark read stands), `archived`, `agent_after_archive`, `back_from_archive`, `last` (its latest message) and `questions` (each question's state: `open`, `picked`, `sent`, `closed`, `superseded`) |

## Where they come from

`packages/shared/inbox/store.test.ts` writes and checks them (`buildTraceFiles`). Every step runs against the real store and the test's independent model, with every invariant checked, before it is recorded.

- `hand-*.json`: the hand-written edges (`HAND_TRACES`): Mark read racing a new agent message, archive then the agent writes again, supersede chains, the Send that skips with Keep open, the look capped by `through`, and the rest.
- `gen-seed-*.json`: generated sequences. Seeds 1001 to 1024; each began as `fc.sample(fc.array(traceOpArb, { minLength: 14, maxLength: 24 }), { seed, numRuns: 1 })` (fast-check 4.9.0) after one root message, with only the events that wrote something kept. Once written, a file's events are data: the test replays them from the file and never samples again, so a fast-check upgrade changes nothing here.

The test fails when a file differs from what the store does now. To regenerate after a change to the rules (from the repo root), keeping every trace's events:

```bash
PLANNOTATOR_INBOX_TRACES=write bun test packages/shared/inbox/store.test.ts
```

`PLANNOTATOR_INBOX_TRACES=resample` also draws the generated traces' events again from their seeds; use it only when `traceOpArb` itself changes.

A change of this format goes in a new `v2` folder; `v1` changes only when the Inbox's behaviour does. The fix of violations A, B and C (2026-10-12) was such a change: the format is the same, the files were regenerated in place (their `known_violations` emptied, the steps that met them now expecting the rule's answer), and `hand-16-undo-reopens-only-its-own-mark-read` and `hand-17-came-back-mark-read-then-reply` were added. A kit that skipped the steps listed in `known_violations` can stop skipping them.

The look's cap (`through_seq`, 2026-10-12, design record "inbox-new-in-open-thread") added the optional `through` field to the `seen` event and one trace, `hand-18-look-capped-by-through`. That is additive: the format stays `v1`, no existing file changed (a `seen` without `through` behaves exactly as before), and the generated traces never use the field.
