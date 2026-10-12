# Inbox thread-state traces, v1

Event sequences with the list state the Inbox gives after each step. A phone kit replays them in a unit test to check that its own handling of the list (placing rows, counts, optimistic updates after a look, Mark read or Archive) agrees with the Inbox. The model they follow is `adr/implementation/inbox-thread-state.md`.

`index.json` lists the trace files. Each trace is one JSON file:

| Field | Meaning |
|---|---|
| `format`, `version` | `"plannotator-inbox-thread-state"`, `1` |
| `name`, `description` | The trace and what it shows |
| `source`, `seed` | `"hand"` (seed `null`) or `"generated"` (the fast-check seed it came from) |
| `clock` | `start` and `step_ms`: everything written at step n is stamped `start + n * step_ms` |
| `known_violation` | `null`, or `{ step, rule, spec, today, test }`: at that step the Inbox breaks a rule of the model. `expect` records what it does today; `spec` says what the rule wants. Skip the trace, or assert today's answer, until the fix lands |
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
| `agent_message` | `project` (`repo0` or `repo1`), `session` (roots only: `ses_a`, `ses_b` or `null`), `reply_to` (a message label or `null`), `supersedes` (optional, one entry: the replied-to message, or its first question), `body` | An agent's `send_message`. Without `reply_to` it routes to the session's newest open unnamed thread in the project, else starts a thread; `lands_in` says where it went. The body is Markdown with `:::question` blocks |
| `seen` | `thread` | The person opened the thread |
| `pick` | `message`, `key`, `choice` (a choice label) or `text` | The person saved an answer, not sent |
| `send` | `message`, `words`, `skip_unanswered` | The person's Send on that message: every picked question on it, plus the words; `skip_unanswered: true` also sends its open questions as skips (`false` is Keep open). Each Send uses its own idempotency key |
| `mark_read`, `unread` | `thread` | Mark read, and its Undo |
| `archive`, `unarchive` | `thread` | Resolve `true` and `false` |
| `agent_read` | `thread` | An agent read the thread (`read_thread`, or `wait_for_reply` handed it the reply) |
| `set_aside_note` | `thread` | The Undo window passed: the Inbox writes its set-aside notes to the asking agent (it does this by itself 10 s after a Mark read) |

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

- `hand-*.json`: the hand-written edges (`HAND_TRACES`): Mark read racing a new agent message, archive then the agent writes again, supersede chains, the Send that skips with Keep open, and the rest.
- `gen-seed-*.json`: generated sequences. Seeds 1001 to 1024; each is `fc.sample(fc.array(traceOpArb, { minLength: 14, maxLength: 24 }), { seed, numRuns: 1 })` (fast-check 4.9.0), with only the events that wrote something kept, then replayed from a fresh store.

The test fails when a file differs from what the store does now. To regenerate after a change to the rules (from the repo root):

```bash
PLANNOTATOR_INBOX_TRACES=write bun test packages/shared/inbox/store.test.ts
```

A change of this format goes in a new `v2` folder; `v1` changes only when the Inbox's behaviour does.
