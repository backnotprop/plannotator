# Plannotator Inbox: the thread-state model

Date: 2026-10-12. This is the model of where a thread sits in the Inbox list and why it moves. It is written from the code, and the code is checked against it: `packages/shared/inbox/store.test.ts` ("the thread-state model") runs generated and hand-written event sequences against the real store and an independent model of the rules below, and checks every invariant after every step. The phone apps replay the trace fixtures in `packages/shared/inbox/fixtures/thread-state/v1/` (see "Trace fixtures").

Where the rules live: the store (`packages/shared/inbox/store.ts`: `listRow`, `readAt`, `markSeen`, `markRead`, `tellSetAside`, `markAgentChecked`, `resolveThread`, `sendMessage`, `sendReply`, `savePicks`), the sections (`packages/shared/inbox/list.ts`), the routes (`packages/server/inbox.ts`), the counts (`packages/inbox/held.ts` `waitingCount`, `packages/server/inbox-decisions.ts` `waitingDecisionCount`) and the wire (`adr/implementation/inbox-mobile.md`, section 2).

## Terms

- **Thread.** A row of the list. Its first message is the **root**; the root's record carries the thread's look, read, archive and agent-read fields.
- **Agent message.** A message an agent sent (`send_message`, `submit_guide`). It may ask questions (`:::question` blocks).
- **Person message.** The person's Send (a reply), or one of the Inbox's own **notes**: the set-aside note a Mark read sends to the asking agent, and the reopened note its late Undo sends. Notes are written as the person's messages, so they reach the agent like any reply (the wake, `wait_for_reply`, `read_thread`), but they are not the person's reply and not a look (`isInboxNote` in `@plannotator/core/inbox-types`). Everything the list derives reads past them: the look, `unseen`, `sent` (rule 7), "came back", `waiting_on_person`, and in the window the look boundary (`packages/inbox/folding.ts`), the "Saved for / Delivered to" line and the held list's agent activity (`last_agent_at`).
- **Seq.** One counter across the Inbox. Every line has one; "after" and "before" below mean seq order.
- **The look.** The person looked at the thread (`POST /api/inbox/threads/:id/seen`): the window records one when the thread opens, and again when an agent message that arrived while it was open has been seen on screen (seen on sight, `packages/inbox/seenOnSight.ts`). The root's `person_seen_seq` becomes the seq of the latest agent message, or, with the optional `through_seq` (the newest message the window showed), of the latest agent message at or below it: a message that landed after the window read the thread stays new. A look never goes back (a cap at or behind the recorded look writes nothing), and a cap past the newest message is the newest message. The person's own reply counts as a look at everything before it. The Inbox's notes are not the person's reply and not a look.
- **Mark read.** `POST /api/inbox/threads/:id/read`. It writes `person_read_seq` and `person_read_at` on the root, counts as a look, and closes every question still waiting on the person (open, or picked and not sent) as a skip with `set_aside`, which names that Mark read (`set_aside.read_seq`, its `person_read_seq`). It stands while no message but its own set-aside notes came after it.
- **Undo.** `POST /api/inbox/threads/:id/unread`. It clears the read fields, puts back the look Mark read counted, and reopens the questions that Mark read closed (the root's current `person_read_seq`), as they were (a saved pick included). A question an earlier Mark read closed stays closed (owner ruling 2026-10-12). A record older than `read_seq` is matched by time (`set_aside.at` equals the root's `person_read_at`). With no Mark read on the root (after an Undo, or an Unarchive that dropped it) Undo writes nothing.
- **Archive.** Resolve (`POST /api/inbox/messages/:id/resolve`, `resolved: true`). The root's `resolved_at` is set. **The archive line** is the seq of the root line that set the current `resolved_at`; it is derived from the log, never written. Messages before the line are **closed by the archive**: their questions read `closed`, and picks, Send and the decision switch on them are refused (`409 thread_resolved`).
- **Came back.** An agent wrote in an archived thread after the line (`agent_after_archive`), and something there still waits on someone (`back_from_archive`): an agent message after the line the person has not looked at, a live question open or picked, or the person's real reply after the line that no agent has read (notes do not count), unless a Mark read made after it still stands. A Mark read made after the latest post-archive agent message ends "came back": the thread is Archived again at once, even while the person's reply there waits on the agent. The thread stays resolved.
- **Agent read.** `read_thread` read the thread, or `wait_for_reply` returned the person's reply. The root's `agent_checked_seq` becomes the seq of the latest person message it covered.
- **Waiting on the person** (the summary's `waiting_on_person`, Workspaces' wire). The thread is not resolved, its last message (the Inbox's notes read past) is an agent's, and no Mark read stands: a standing Mark read means nothing waits on the person. The model checks it after every step.

## Question states

Derived, never stored, in this order:

| State | When |
|---|---|
| `superseded` | A later agent message in the thread replaced it (`superseded_by`) |
| `closed` | Its message is closed by the archive, or a Mark read set it aside (`set_aside`) |
| `open` | No answer |
| `sent` | The answer went out with a Send (`sent_revision` equals `revision`). A skip by the Send that skips is a sent answer |
| `picked` | An answer is saved and not sent |

## Sections

The six sections, shown in this fixed order: Stopped on you, Holding up work, Waiting on you, New since you looked, Sent, Quiet. A thread is in exactly one. The first rule that holds wins:

| # | Rule | Section |
|---|---|---|
| 1 | Archived: resolved and not came back | Quiet |
| 2 | Mark read stands (made after the archive line when the thread is resolved) | Quiet ("Read") |
| 3 | An open question carries `Stopped:` | Stopped on you |
| 4 | An open question carries `Holds up:` | Holding up work |
| 5 | Any other open question | Waiting on you |
| 6 | Picks saved and not sent, nothing open | New since you looked ("Answered, not sent") |
| 7 | The last message is the person's and no agent read it | Sent |
| 8 | Agent messages after the look | New since you looked |
| 9 | Anything else | Quiet |

Inside a section, newest first by the thread's latest message (`last_at`), ties on the thread id. A row moves within its section only when the thread gains a message; looks, picks, reads and archives move it between sections.

**Archived** is the seventh place (six sections plus Archived): resolved and not came back. A came-back thread is placed by rules 2 to 9 like an open thread.

## The two list views

| View | Route | Archived threads |
|---|---|---|
| Default | `GET /api/inbox/threads` (`archived=include`) | In Quiet, like any quiet thread. The phone's door forwards this route as it is, so a phone that draws the sections keeps every thread |
| The window's | `GET /api/inbox/threads?archived=exclude` plus `GET /api/inbox/threads/archived` | Out of every section; listed newest archived first (`resolved_at`, ties on the thread id) by the archived route, which Settings' Archived block reads |

A came-back thread is in the sections in both views and is not in the archived list.

## Events

| Event | Route (window) | What it writes |
|---|---|---|
| Agent message, new thread | `send_message` without `reply_to` | A root. Routing: with a `thread` name, the newest open thread of that name in the project, else a new thread. Without one, the newest unnamed thread the sender session started in the project, only while that one is open; it never falls back to an older open thread. Otherwise, and for a sender with no session, a new thread. An archived thread is never joined |
| Agent reply | `send_message` with `reply_to` | A message in that thread, archived or not. Archived: it lands after the line |
| Agent question | either of the above, with `:::question` blocks | The message and one question record per block |
| Supersede | `supersedes: [...]` or a `Replaces:` line | The message, then `superseded_by` on each named question that is open or picked. Anything else named refuses the whole send (`invalid_supersedes`) |
| Open (seen) | `POST /api/inbox/threads/:id/seen`, optional `through_seq` | `person_seen_seq` when an agent message (at or below `through_seq`, when given) is unseen; else nothing |
| Pick | `POST /api/inbox/messages/:id/picks` | The answer, revision + 1 |
| Send | `POST /api/inbox/messages/:id/reply` | The listed picks as sent, then one person reply. Idempotent on its key |
| The Send that skips | the same, `skip_unanswered: true` | Also every open question of that message without a pick, as a sent skip (`by_reply`). With Keep open the window sends `false` |
| Mark read | `POST /api/inbox/threads/:id/read` | The read fields and the look on the root; `set_aside` on each waiting question |
| Undo | `POST /api/inbox/threads/:id/unread` | The read fields cleared, the look put back while the read stood, the questions that Mark read closed restored; one reopened note per asking message for those of them the agent had been told about. Nothing when the root has no Mark read |
| Set-aside note | the server, 10 s after a Mark read (and after an Unarchive) | One person note per asking message naming the questions a Mark read closed and no note named yet, whatever happened since. None for a message closed by the archive |
| Archive | `POST /api/inbox/messages/:id/resolve` `{ resolved: true }` | `resolved_at`. No write when already resolved |
| Unarchive | the same, `{ resolved: false }` | `resolved_at` cleared; a Mark read made after the archive line is cleared in the same root line |
| Agent read your reply | `read_thread`, `wait_for_reply` | `agent_checked_seq` |

## Transition table

Columns are the state before the event: **Asks** (Stopped, Holding or Waiting), **New**, **Sent**, **Read** (Quiet by Mark read), **Quiet**, **Archived**, **Came back**. A cell names the state after it. "Asks" means the section of the strongest open question. **Archived** covers two cases that answer the person's writes differently: no agent wrote after the archive line (every write is refused, `409 thread_resolved`), and a thread that came back and returned to the archive once handled (its later messages behave as an open thread's; its earlier ones stay closed). An archived thread has no open or picked question, or it would have come back. The Archived cells are proved on a real store by "the Archived column" tests in `store.test.ts`.

| Event | Asks | New | Sent | Read | Quiet | Archived | Came back |
|---|---|---|---|---|---|---|---|
| Agent message, asks nothing | Asks (moves up) | New | New | New; the questions it closed stay closed | New | `reply_to`: Came back, New. Without it: a new thread starts; this one stays Archived | Came back |
| Agent question | Asks | Asks | Asks | Asks | Asks | `reply_to`: Came back, Asks | Came back, Asks |
| Supersede | Asks if anything is still open, else New | Asks or New | Asks or New | Asks or New | Asks or New | Refused (`invalid_supersedes`): nothing in it is open or picked | as for an open thread |
| Open (seen) | Asks | Quiet, or New while picks wait | Sent | Read | Quiet | Archived (no change of place) | Archived when only unseen news kept it back, else Came back |
| Pick | Asks while another question is open, else New | New | New (a pick on a sent question makes it picked again; the window does not offer it) | Refused for a question the Mark read closed (`question_set_aside`) | as Sent | No agent after the line: refused (`thread_resolved`). Came back and returned: a sent question of a later message takes a pick again (Came back, New); a question before the line is refused | after the line: as for an open thread; before it: refused |
| Send (Keep open) | Asks while a question stays open, else Sent | Sent | Sent | Sent; the closed questions stay closed | Sent | No agent after the line: refused (`thread_resolved`). Came back and returned: a Send on a later message is taken (Came back, Sent); on an earlier one, refused | Came back, Sent (or Asks) |
| The Send that skips | Sent, unless another message's question stays open | Sent | Sent | `nothing_to_send` unless words or picks go | Sent | No agent after the line: refused. Came back and returned: as Send; with no words, `nothing_to_send` (nothing there is open) | Came back, Sent |
| Mark read | Read | Read | Read (the store takes it; the window does not offer it) | No write unless a question waits | Read | No agent after the line: refused (`thread_resolved`). Came back and returned: taken, and it stays Archived (with the read) | Archived, also while the person's reply there waits on the agent; a reply the person sends after it brings it back (Sent) |
| Undo | Asks (only this Mark read's questions reopen) | Clears the read; a question an earlier Mark read closed stays closed | as New | What the messages and the restored questions say (often Asks) | as New | No agent after the line: refused (`thread_resolved`). Otherwise taken: when that Mark read had sent a came-back thread to the archive, it comes back as it was (for example Waiting, unseen put back); else it stays Archived | as New |
| Archive | Archived | Archived | Archived | Archived | Archived | no write | no write (Unarchive, then Archive, archives again) |
| Unarchive | no write | no write | no write | no write | no write | Placed as an open thread; a Mark read made before the archive is kept (Read) | Placed as an open thread; a Mark read made after the line is dropped |
| Agent read your reply | Asks | New | Quiet | Read | Quiet | Archived | Archived when the unread reply was all that kept it back |
| Set-aside note | Asks (an open question still places it; unseen unchanged) | New, unseen unchanged: the note is neither a reply nor a look | Sent | Read: the note never ends the read | Quiet | Archived; a note goes only for questions asked after the line | as for an open thread |

## Invariants

Checked after every step of every sequence, on the store's own output:

1. Every thread is in exactly one section, in each of the two list views.
2. No thread disappears: the default view holds every thread ever created; the window's view and the archived list together hold every thread, and never the same one twice.
3. A question still waiting on the person (`open`) keeps its thread in Stopped, Holding or Waiting.
4. Mark read then Undo, back to back, gives the thread back exactly as it was (section, unseen, questions, picks), whatever an earlier Mark read closed. Undo always clears the read fields; afterwards a question is set aside exactly when an earlier Mark read closed it.
5. Archive then Unarchive loses no message, question, pick or decision; the row comes back identical.
6. An agent message after the archive line brings the thread back into the list while something waits. Mark read on a came-back thread returns it to Archived. Unarchive clears a read made while archived.
7. Counts. The sidebar's waiting count (`waitingCount`) equals the rows in Stopped, Holding and Waiting, in both views and per project; the folders' unread count equals the rows in Stopped, Holding, Waiting and New; an archived row never counts. The Decisions count (`decisions_waiting`) equals the questions that record a decision once sent, open or picked, with no decision yet.
8. Replay: a store reopened from disk gives the same rows and threads.
9. Sort: the sections in the fixed order; newest first by `last_at` inside each, ties on the thread id; the archived list newest archived first, ties on the thread id. About one generated step in four shares the previous step's clock time, so `last_at` ties happen in the sections; a second property archives every open thread within one clock tick, so `resolved_at` ties happen in the archived list. Each fails if it met no tie. The trace fixtures keep one clock step per event: a thread id ends in random characters, so the order of a tie is not the same from one run to the next.

Invariant 7 is mostly circular for the first two counts: `waitingCount` counts the rows in Stopped, Holding and Waiting, and `unread` is defined from the section, so they check the counting code rather than the rules. The Decisions count is the real check: the model keeps its own account of which questions record a decision and which have one.

The model also predicts every event's outcome (written, nothing to do, a replayed key, or the refusal code), which thread every message lands in, every question's state and every row's section, unseen count, read and came-back flags, `last_at` and `last_agent_at`. The store must match it exactly on every field after every step. (Until A, B and C below were fixed, the model derived each row under two look rules, the store's and the intended one, and recorded the difference; they are one rule now.)

## Counts

- **Inbox and folder counts in the sidebar**: rows in Stopped, Holding and Waiting (`waitingCount` in `packages/inbox/held.ts`). New is bold but not counted there.
- **`projects[].unread`** in the list response: rows in Stopped, Holding, Waiting or New (`unread`, bold).
- **Decisions**: `decisions_waiting`, questions that record a decision once sent (`Decision: when answered`, or the card's switch), open or picked, with no decision recorded. A question the archive or a Mark read closed does not count. A Send of the pick records the decision and it stops counting.
- Questions are never counted one by one in the badge.

## What is window-only and never stored

- **Folding** (`packages/inbox/folding.ts`): which messages open, which fold to one line, and the "N earlier messages" runs. Decided when a thread opens, kept in memory.
- **The look boundary of the current visit** (`lookBoundary`): read from the thread before the window records the look, kept until the person leaves the thread, so "New since you looked" marks last through the visit.
- **Seen on sight** (`packages/inbox/seenOnSight.ts`): which messages that arrived during the visit have been on screen long enough (their first lines in the thread's view for 1 s, the window in front, nothing covering the thread). Only its result is stored, as a look capped with `through_seq`.
- **Held order** (`packages/inbox/held.ts`): the rows on screen change only on the person's action; agent activity waits behind "N new". While a thread is open, the person's own writes show in place and never reorder the list. The open thread is never held: its row takes its state in place (bold on an arrival, not bold once seen), it is never in "N new", and when the thread closes it settles where its state puts it, an unseen arrival included (New, or Waiting when it asks).
- Toasts, the sound's arming and burst state, the sidebar and list widths (cookies), the Grid or Clean look.

Stored, on disk: looks, reads, archives, picks, sends, decisions, annotations and settings.

## Fixed violations

Found by the model on main at `53a49c81e` and fixed since. Each has normal tests in `store.test.ts` ("the thread-state model: fixed violations") with the minimal sequences, and the trace fixtures that met them were regenerated (every `known_violations` list is empty now).

- **A. The Inbox's notes counted as the person's reply and as a look.** Rule: Mark read's set-aside note and a late Undo's reopened note are the Inbox's, not the person's: neither is a reply (rule 7) nor a look. The store still writes both as person messages (so the agent receives them exactly as before), and every derived field reads past them (`isInboxNote`). The shapes the generated runs met, each a test:
  - the agent asks; Mark read; the agent writes news inside the 10 s Undo window; the note goes: New, unseen 1 (it read Sent with nothing unseen; trace `hand-04-mark-read-racing-agent-message`, step 4);
  - the agent asks; Mark read; the agent asks a new question; the note goes: Waiting, unseen 1 (unseen dropped to 0);
  - the agent asks, never opened; Mark read; the note goes; Undo: Waiting with unseen 1, as before the Mark read (it read 0; trace `hand-03-mark-read-and-undo`, step 7);
  - after the news and the note, an agent reads the thread: New (it read Quiet);
  - the person opened the thread after the news, then the note goes: Quiet (it read Sent);
  - the agent asks again and the person picks before the note: New, unseen 1; and archived after the news and the note: unseen 1.
- **B. Mark read on a came-back thread could leave it in the list.** News; archive; the agent asks (came back, Waiting); the person replies with Keep open; Mark read. Rule: a Mark read made after the latest post-archive agent message, while it stands, ends "came back", so the thread is Archived at once, as the window's toast says. The person's reply that no agent had read used to keep `back_from_archive`, leaving it in Quiet ("Read") until the agent read it. Trace `hand-09-came-back-mark-read-with-unread-reply`, step 5; `hand-17-came-back-mark-read-then-reply` shows a reply after the Mark read bringing it back as Sent.
- **C. Undo reopened more than its own Mark read closed.** Ruled: Undo reopens only what its own Mark read closed. The agent asks; Mark read (the question closes); the agent writes news (New, the question stays closed); Mark read; Undo: New, the question still closed (it jumped to Waiting with the first Mark read's question reopened). Mark read again then Undo no longer reopens older set-aside questions: that path was accidental. Trace `hand-14-undo-after-an-earlier-mark-read`, step 5; `hand-16-undo-reopens-only-its-own-mark-read` shows the reopened note naming only the questions this Undo reopened.

Old stores replay unchanged: nothing already written is rewritten or read differently, except these derivations (A's look, `sent`, `unseen` and `waiting_on_person`; B's `back_from_archive` while a Mark read made after the agent's last message stands; `waiting_on_person` is also false while any Mark read stands). New fields are additive (`set_aside.read_seq` on a question record, `last_agent_at` on a list row).

## Trace fixtures

`packages/shared/inbox/fixtures/thread-state/v1/`: one JSON file per trace and `index.json`. The folder's README gives the format, the event vocabulary, the generator, the seeds and how to regenerate. The files are generated by `store.test.ts` through the same checked steps, and the test fails when they differ from what the store does, so they cannot drift from the code. A generated trace's events were drawn from its seed once and are kept in its file as data; the test replays them, so a new fast-check version changes nothing. A change of the format makes `v2`; a change of behaviour (a fixed violation) regenerates `v1` in place, as the fix of A, B and C did. The look's cap (`through_seq`) is additive: the `seen` event gained an optional `through`, `hand-18-look-capped-by-through` was added, and no existing trace changed; the format stays `v1`.
