# Plannotator Inbox: the thread-state model

Date: 2026-10-12. This is the model of where a thread sits in the Inbox list and why it moves. It is written from the code, and the code is checked against it: `packages/shared/inbox/store.test.ts` ("the thread-state model") runs generated and hand-written event sequences against the real store and an independent model of the rules below, and checks every invariant after every step. The phone apps replay the trace fixtures in `packages/shared/inbox/fixtures/thread-state/v1/` (see "Trace fixtures").

Where the rules live: the store (`packages/shared/inbox/store.ts`: `listRow`, `readAt`, `markSeen`, `markRead`, `tellSetAside`, `markAgentChecked`, `resolveThread`, `sendMessage`, `sendReply`, `savePicks`), the sections (`packages/shared/inbox/list.ts`), the routes (`packages/server/inbox.ts`), the counts (`packages/inbox/held.ts` `waitingCount`, `packages/server/inbox-decisions.ts` `waitingDecisionCount`) and the wire (`adr/implementation/inbox-mobile.md`, section 2).

## Terms

- **Thread.** A row of the list. Its first message is the **root**; the root's record carries the thread's look, read, archive and agent-read fields.
- **Agent message.** A message an agent sent (`send_message`, `submit_guide`). It may ask questions (`:::question` blocks).
- **Person message.** The person's Send (a reply), or one of the Inbox's own **notes**: the set-aside note a Mark read sends to the asking agent, and the reopened note its late Undo sends. Notes are written as the person's messages.
- **Seq.** One counter across the Inbox. Every line has one; "after" and "before" below mean seq order.
- **The look.** The person opened the thread (`POST /api/inbox/threads/:id/seen`). The root's `person_seen_seq` becomes the seq of the latest agent message. The person's own reply counts as a look at everything before it. The Inbox's notes are not the person's reply and not a look (the store counts them as both today: known violation A).
- **Mark read.** `POST /api/inbox/threads/:id/read`. It writes `person_read_seq` and `person_read_at` on the root, counts as a look, and closes every question still waiting on the person (open, or picked and not sent) as a skip with `set_aside`. It stands while no message but its own set-aside notes came after it.
- **Undo.** `POST /api/inbox/threads/:id/unread`. It clears the read fields, puts back the look Mark read counted, and reopens every question a Mark read closed, as it was (a saved pick included).
- **Archive.** Resolve (`POST /api/inbox/messages/:id/resolve`, `resolved: true`). The root's `resolved_at` is set. **The archive line** is the seq of the root line that set the current `resolved_at`; it is derived from the log, never written. Messages before the line are **closed by the archive**: their questions read `closed`, and picks, Send and the decision switch on them are refused (`409 thread_resolved`).
- **Came back.** An agent wrote in an archived thread after the line (`agent_after_archive`), and something there still waits on someone (`back_from_archive`): an agent message after the line the person has not looked at, a live question open or picked, or the person's real reply after the line that no agent has read (notes do not count). The thread stays resolved.
- **Agent read.** `read_thread` read the thread, or `wait_for_reply` returned the person's reply. The root's `agent_checked_seq` becomes the seq of the latest person message it covered.

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
| Open (seen) | `POST /api/inbox/threads/:id/seen` | `person_seen_seq` when an agent message is unseen; else nothing |
| Pick | `POST /api/inbox/messages/:id/picks` | The answer, revision + 1 |
| Send | `POST /api/inbox/messages/:id/reply` | The listed picks as sent, then one person reply. Idempotent on its key |
| The Send that skips | the same, `skip_unanswered: true` | Also every open question of that message without a pick, as a sent skip (`by_reply`). With Keep open the window sends `false` |
| Mark read | `POST /api/inbox/threads/:id/read` | The read fields and the look on the root; `set_aside` on each waiting question |
| Undo | `POST /api/inbox/threads/:id/unread` | The read fields cleared, the look put back while the read stood, every set-aside question restored; one reopened note per asking message when the agent had been told |
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
| Mark read | Read | Read | Read (the store takes it; the window does not offer it) | No write unless a question waits | Read | No agent after the line: refused (`thread_resolved`). Came back and returned: taken, and it stays Archived (with the read) | Archived; but Read in the list while the person's reply waits on the agent (known violation B) |
| Undo | Asks; questions an earlier Mark read closed reopen too (known violation C) | No write, unless an earlier Mark read's questions are still set aside: then they reopen (known violation C) | as New | What the messages and the restored questions say (often Asks) | as New | No agent after the line: refused (`thread_resolved`). Otherwise taken: when that Mark read had sent a came-back thread to the archive, it comes back as it was (for example Waiting, unseen put back); else it stays Archived | as New |
| Archive | Archived | Archived | Archived | Archived | Archived | no write | no write (Unarchive, then Archive, archives again) |
| Unarchive | no write | no write | no write | no write | no write | Placed as an open thread; a Mark read made before the archive is kept (Read) | Placed as an open thread; a Mark read made after the line is dropped |
| Agent read your reply | Asks | New | Quiet | Read | Quiet | Archived | Archived when the unread reply was all that kept it back |
| Set-aside note | Asks (an open question still places it) | Sent, nothing unseen: the note reads as the person's reply and as a look (known violation A) | Sent | Read: the note never ends the read | Sent, for the same reason as New | Archived; a note goes only for questions asked after the line | as for an open thread |

## Invariants

Checked after every step of every sequence, on the store's own output:

1. Every thread is in exactly one section, in each of the two list views.
2. No thread disappears: the default view holds every thread ever created; the window's view and the archived list together hold every thread, and never the same one twice.
3. A question still waiting on the person (`open`) keeps its thread in Stopped, Holding or Waiting.
4. Mark read then Undo, back to back, gives the thread back exactly as it was (section, unseen, questions, picks), and Undo always clears the read fields and leaves no question set aside outside the archive's part.
5. Archive then Unarchive loses no message, question, pick or decision; the row comes back identical.
6. An agent message after the archive line brings the thread back into the list while something waits. Mark read on a came-back thread returns it to Archived. Unarchive clears a read made while archived.
7. Counts. The sidebar's waiting count (`waitingCount`) equals the rows in Stopped, Holding and Waiting, in both views and per project; the folders' unread count equals the rows in Stopped, Holding, Waiting and New; an archived row never counts. The Decisions count (`decisions_waiting`) equals the questions that record a decision once sent, open or picked, with no decision yet.
8. Replay: a store reopened from disk gives the same rows and threads.
9. Sort: the sections in the fixed order; newest first by `last_at` inside each, ties on the thread id; the archived list newest archived first, ties on the thread id. About one generated step in four shares the previous step's clock time, so ties happen, and the test fails if none were met. The trace fixtures keep one clock step per event: a thread id ends in random characters, so the order of a tie is not the same from one run to the next.

Invariant 7 is mostly circular for the first two counts: `waitingCount` counts the rows in Stopped, Holding and Waiting, and `unread` is defined from the section, so they check the counting code rather than the rules. The Decisions count is the real check: the model keeps its own account of which questions record a decision and which have one.

The model also predicts every event's outcome (written, nothing to do, a replayed key, or the refusal code), which thread every message lands in, every question's state and every row's section, unseen count, read and came-back flags.

## Counts

- **Inbox and folder counts in the sidebar**: rows in Stopped, Holding and Waiting (`waitingCount` in `packages/inbox/held.ts`). New is bold but not counted there.
- **`projects[].unread`** in the list response: rows in Stopped, Holding, Waiting or New (`unread`, bold).
- **Decisions**: `decisions_waiting`, questions that record a decision once sent (`Decision: when answered`, or the card's switch), open or picked, with no decision recorded. A question the archive or a Mark read closed does not count. A Send of the pick records the decision and it stops counting.
- Questions are never counted one by one in the badge.

## What is window-only and never stored

- **Folding** (`packages/inbox/folding.ts`): which messages open, which fold to one line, and the "N earlier messages" runs. Decided when a thread opens, kept in memory.
- **The look boundary of the current visit** (`lookBoundary`): read from the thread before the window records the look, kept until the person leaves the thread, so "New since you looked" marks last through the visit.
- **Held order** (`packages/inbox/held.ts`): the rows on screen change only on the person's action; agent activity waits behind "N new". While a thread is open, the person's own writes show in place and never reorder the list.
- Toasts, the sound's arming and burst state, the sidebar and list widths (cookies), the Grid or Clean look.

Stored, on disk: looks, reads, archives, picks, sends, decisions, annotations and settings.

## Known violations

Found by the model on main at `53a49c81e`. Each has `test.failing` tests in `store.test.ts` with the minimal sequences (they pass while the store breaks the rule and turn red once it is fixed). Every trace fixture lists the violations its steps meet in `known_violations`, detected by the same checks; the hand traces declare theirs and the test compares. The fix is a separate change: it flips the tests and regenerates the traces.

- **A. The Inbox's notes count as the person's reply and as a look.** Rule: Mark read's set-aside note and a late Undo's reopened note are the Inbox's, not the person's: neither is a reply (rule 7) nor a look. The model follows that rule; the store writes both notes as person messages and counts them as both. The generated runs meet six shapes of it, each pinned with its own case (`KNOWN_A_SIGNATURES`; a new shape fails the run):
  - the agent asks; Mark read; the agent writes news inside the 10 s Undo window; the note goes: Sent with nothing unseen, where the rule says New, unseen 1 (trace `hand-04-mark-read-racing-agent-message`, step 4);
  - the agent asks; Mark read; the agent asks a new question; the note goes: still Waiting, but unseen drops to 0;
  - the agent asks, never opened; Mark read; the note goes; Undo: Waiting with unseen 0, where it had 1 before the Mark read (trace `hand-03-mark-read-and-undo`, step 7);
  - after the news and the note, an agent reads the thread: Quiet with nothing unseen, where the rule says New;
  - the person opened the thread after the news, then the note goes: Sent, where the rule says Quiet;
  - the agent asks again and the person picks before the note: New either way, unseen 0 instead of 1; and archived after the news and the note: unseen 0 instead of 1.
- **B. Mark read on a came-back thread can leave it in the list.** News; archive; the agent asks (came back, Waiting); the person replies with Keep open; Mark read. Rule: Mark read on a came-back thread returns it to Archived, and the window's toast says so. Today the person's reply that no agent has read keeps `back_from_archive`, so the thread sits in Quiet ("Read") until the agent reads it. Trace `hand-09-came-back-mark-read-with-unread-reply`, step 5.
- **C. Undo reopens more than its own Mark read closed.** Ruled: Undo reopens only what its own Mark read closed. The agent asks; Mark read (the question closes); the agent writes news (New, the question stays closed); Mark read; Undo. The rule gives back New with the question still closed. Today Undo reopens every question any Mark read closed, and the thread jumps to Waiting. Trace `hand-14-undo-after-an-earlier-mark-read`, step 5.

## Trace fixtures

`packages/shared/inbox/fixtures/thread-state/v1/`: one JSON file per trace and `index.json`. The folder's README gives the format, the event vocabulary, the generator, the seeds and how to regenerate. The files are generated by `store.test.ts` through the same checked steps, and the test fails when they differ from what the store does, so they cannot drift from the code. A generated trace's events were drawn from its seed once and are kept in its file as data; the test replays them, so a new fast-check version changes nothing. A change of the format makes `v2`; a change of behaviour (a fixed violation) regenerates `v1` in place.
