## Inbox: Plans

Plans keeps every plan plan review handled, with its versions and decisions, in one library on the person's computer. It lives in the Inbox (the same server and window); there is no separate Plans window. This guide covers the parts with no screens: the records, the library on disk, the import from today's stores, the switch, the routes and the command. The Plans page in the window, comments, sending a plan to an agent and an agent tool come later.

On screen and in every word an agent may read, it is "Plans", one item "a plan". The words Space, Spaces, Groups and Loops are never used.

### The switch

- config.json `inboxPlans` (`true` / `false`, unset is off): `plansOn()` / `setPlansSwitch()` in `packages/shared/plans/switch.ts`, read on every request.
- On only by the person: `plannotator plans` (no gate: running it is the opt-in, from any shell), or `POST /api/inbox/settings` `{ plans: { on } }` from the window. No agent tool, agent text, skill or `--help` names it (the subcommand is in `HIDDEN_SUBCOMMANDS`; its help is the usage line only).
- `plannotator plans off` (or the settings switch) turns it off and keeps `plan-library/`.

### Off costs nothing

`packages/server/plans-capability.test.ts` holds all of it:

- Every `/api/plans` path is the Inbox's unknown-route `404`, as if absent (as Shape's).
- The library is not opened, read or imported; no file appears under the data dir.
- `GET /api/inbox/settings` has no `plans` key (it is present only while on, as `plans: { on: true }`; today's window reads no such key, so nothing is drawn).
- Plan review writes exactly what it wrote before (it does not know Plans: `history/` stays the source).
- The Inbox's agent tools, their text and the served tool list are unchanged; only the capability seam and the command reach Plans' modules (a source scan in the same test).
- `plannotator plans …` other than `plans` and `plans off` prints `PLANS_OFF_TEXT` (one line naming `plannotator plans`) and exits 1, starting nothing.

### The records (`packages/core/plans.ts`)

Browser-safe types, id prefixes, pure checks and the version id; no I/O. Field names are snake_case, as stored.

| Record | Id | Notes |
| --- | --- | --- |
| Plan | `pln_<ulid>` | `name` (the primary document's first heading), `project_name` (the `history/{project}` folder), `project_id` / `project_root` (an Inbox project, later), `primary_doc_id`, `status`, `thread_id` (its Inbox thread, made on the first send, later), `created_by`, `legacy` (the chains and snapshots it was built from) |
| Document | `doc_<ulid>` | `kind` (markdown, html, mermaid, graphviz), `title`, `head_version` |
| Version | the git blob SHA-1 (`gitBlobSha`) | `version_number` 1, 2, 3… with no gaps, `file` (`docs/<doc>/<n>.md`), `committed_at`, `source`, author fields, `legacy` (the file it came from) |
| Decision | (inside a `decision` event) | `decision` (approved, approved-with-notes, denied, feedback), `version_number`, `feedback`, `feedback_record`, `snapshot` |
| Event | `actev_<ulid>` | the plan's activity; `legacy` names the line or file an imported one came from |
| Look | (looks.json) | per plan `looked_at`, per document the newest version seen |
| Artifact, Comment `anno_`, Reply `reply_` | | types only: not written yet |

Rules the records keep, so a later copy kept elsewhere stays possible (nothing leaves the computer today):

- A version's author is a display name only (`author_label`, with `author_via` and the agent fields): never an email or a user id. The import writes none.
- Events and Looks are local-only: they never go with a plan; a copy kept elsewhere writes its own.
- Of the decisions, only "approved" (and "approved-with-notes") maps to a document approval at a version. "denied" and "feedback", with the person's notes, stay local-only.

### The library on disk (`packages/shared/plans/store.ts`)

```
<dataDir>/plan-library/
  index.jsonl              one line per plan change (the last line per id wins), for a fast list
  looks.json               the person's looks (written whole)
  legacy-map.json          what the import took from where (written whole)
  <pln_id>/
    plan.jsonl             the plan record, one snapshot per change
    docs.jsonl             documents and versions ({ kind: "document" | "version", record })
    docs/<doc_id>/<n>.md   each version as a plain file, readable without Plannotator
    events.jsonl           decisions and activity
```

Not under `plans/`, which holds decision snapshots (and may be a person's custom folder). The Inbox store's rules (`packages/shared/inbox/store-log/jsonl-log.ts`): one writer (the Inbox server; `plans list` only reads), one line per change in one append-mode write, a torn line skipped on read and never glued to the next one, whole files through a temp file and a rename, folders 0700 and files 0600. A version's file is written before the line naming it; the head is the newest version line, so a crash between lines never reuses a number; `repairIndex()` writes again an index line a crash left behind. Opening the store reads and writes nothing.

### The import (`packages/shared/plans/import.ts`)

Read-only: it reads `history/`, `plans/` and `feedback/` and writes only under `plan-library/`; it calls no writer of those stores (`getPlanDir` creates its folder). It runs as often as asked and never takes anything twice: each record it writes names its source (`legacy`), checked before every add; `legacy-map.json` only makes a second run fast and is rebuilt from the records when lost. The odd cases:

- A `history/{project}/{slug}/` folder with `NNN.md` files is one plan: its files in number order are versions 1, 2, 3…, dated by each file's modified time; the plan's name is the newest version's first heading.
- Chains are never joined. A heading change (a new slug) or the same heading after two quiet days (a new dated slug) is a second plan; two projects with the same slug are two plans. Joining is the person's later merge.
- Missing numbers (001, 002, 004): imported in order and numbered without a gap; each keeps its file name; the chain is listed in the report's `gaps`.
- A file plan review may still be writing (it truncates, then writes: modified less than `PLAN_IMPORT_SETTLE_MS`, 2 s, ago, or a different size or time after the read than before) is not read yet: its chain stops there (`unsettled`), is not marked read, and a later run takes the whole file. The same for a snapshot. An empty `NNN.md` is no version (`empty_files`).
- An unreadable file stops its chain there (`unreadable`); the next run goes on from it, in order.
- A folder with no `NNN.md` is no plan yet; annotate's chains (`annotate-…-<8 hex>`), `submissions/` and other files are left out.
- A feedback line of plan review (`surface: "plan"`) is a decision on the version it names (`target.slug`, `target.planVersion`), with the person's notes. A line with nothing to land on yet (its chain is not in the library, or the version it names is on disk but not imported yet) waits, counted in `orphan_feedback`; the map keeps the file's size, the offset after its last whole line read and the waiting lines' byte ranges, so the file is not read again until it grows (then only its new lines), and the waiting lines are tried again only after a run that added versions. A line still being appended (no newline yet) waits for the next run. Other surfaces and torn lines are skipped.
- A decision snapshot is matched by its text (the version's text, or it followed by `\n\n---\n\n` and the notes) to a version of a chain with the same heading. If a feedback line already gave that decision on that version, it is not kept twice (`duplicate_snapshots`); otherwise it is a decision. A snapshot written over by a later decision is a new decision. Feedback lines are read before snapshots; plan review writes the snapshot a moment before its line, so a pickup landing exactly between the two would keep both.
- A snapshot with no matching history (a decision without history) is a plan of its own: the snapshot file as its one version (the plan text and the notes cannot be told apart), its decision, no project. The plan's `legacy.snapshots` names the snapshot (`plans/<file>#<blob sha>`) from its first record, and it counts as done only once it holds its decision: a run after a crash between its steps finishes that plan rather than making a second one.
- Snapshots saved to a custom folder (a browser setting the server never keeps) are not found.
- New versions plan review writes while Plans is on are picked up by the same function: the Inbox runs it in the background once it is up and when the switch turns on, and a request to `/api/plans` runs it again at most every 2 seconds (`packages/server/plans-capability.ts`). There is no file watch. The import yields after each chain, snapshot and feedback file, every 10 versions and 25 feedback lines, and after each plan while it repairs the index and rebuilds the map, so a first import of a long history does not hold the Inbox.
- Not yet: `index.jsonl` only grows (one line per change); compacting it (written whole when it holds many more lines than plans) is a follow-up.

### The capability seam (`packages/server/inbox-capability.ts`)

`InboxCapability` (`key`, `on`, `save`, `prefix`, `route`, `settingsWire`, `started`) and `InboxCore` (only `dataDir` and `changed` for now). `inbox.ts` routes (`routeInboxCapabilities`), answers the settings (`capabilitiesWire`, `checkInboxCapabilities`, `answerInboxCapabilities`) and starts (`startInboxCapabilities`, after listen) through the list, and never imports Plans. The route guard is Shape's: off, or reached any way but the owner's window on this computer (the tailnet, a phone's door, a linked machine), `404`; another site `403`; a POST with another page's `serverSession` `409`. Plans is not on any door route. Plans is the only capability on the seam; Shape, Routines, the Board and code review stay wired by hand. A capability's agent tool and the window's capability rows come with the first capability that has them.

### The command (`apps/hook/server/plans-command.ts`)

- `plannotator plans`: on, then the Inbox started detached or found (`ensureInboxRunning`), its Plans page (`<url>#plans`) opened as `plannotator inbox --open` opens a window, and printed. Until the Plans page lands, the window opens on its usual page.
- `plannotator plans off`: off.
- `plannotator plans list`: one line per plan (id, last change, project, head version, decision, "changed, you saw vN", name) from the running Inbox (waiting out its import), else read from the library on disk. Never starts the Inbox, never writes.

### Pi

Nothing: Plans lives in the Inbox, which is Bun-only. No module is vendored (`apps/pi-extension/vendor.sh` lists its modules by name, and none of Plans' is listed). The one shared file touched, `packages/shared/config.ts`, gained a type field only.

### Tests

`packages/core/plans.test.ts` (the version id against `git hash-object`, the ids, the checks), `packages/shared/plans/store.test.ts` (round trips, the list, looks, modes, every crash window), `packages/shared/plans/import.test.ts` (a fixture tree with every odd case above, source files byte-identical, idempotence and a lost map, the pickup, an unreadable file, files caught mid-write, waiting feedback lines, both crash windows of a decision without history, the steps), `packages/shared/plans/switch.test.ts`, `packages/shared/plans/routes.test.ts` (the handler with no server), `packages/server/plans-capability.test.ts` (off costs nothing, the guards, the settings switch, the background import), `apps/hook/server/plans-command.test.ts` (on, off, list, the off line, no terminal gate).
