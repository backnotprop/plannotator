## Feedback Archive

Every review submitted through a Plannotator decision is durably archived at
decision-settlement time, so a submission survives an agent-side timeout, a
closed terminal, or a `planSave` setting the user turned off. One deliberate
exception: a review posted straight to GitHub, GitLab or Bitbucket with `POST
/api/pr-action` is delivered to the platform and is **not** archived locally
yet (a named follow-up). Layout, per project (same `{project}` key as
`history/`):

```
${PLANNOTATOR_DATA_DIR}/feedback/{project}/
  index.jsonl                                  # append-only, authoritative, schema v1
  records/2026-08-31T14-22-07-511Z-review-feedback.md   # human-readable sidecar
```

The JSONL line is self-contained (`v`, `ts`, `client`, `clientVersion?`,
`project`, `origin`, `surface`, `decision`, `target`, `feedback`,
`annotations`, `counts`, `recordFile`) so an analyzer never has to open a
sidecar; the markdown sidecar exists because the rest of the data dir is
greppable markdown and is written only for records that carry content. Bare
approvals, LGTMs, and dismissals are decision-only lines with no sidecar.

**This index is shared, not Plannotator-private.** Several tools that share the
data dir append to the SAME `feedback/{project}/index.jsonl`, separated by the
`client` field on each line rather than by separate files. Known writers today:
`plannotator` (this repo) and `plannotator-tui`, the Rust terminal client;
`herdr-annotate` is reserved for a possible future Lite writer. Treat `client`
as an open set, never an enum to validate against. Practical consequences: the
line shape is a cross-tool contract, so fields are **added, never repurposed**;
other clients suffix their id onto their sidecar filenames
(`{stamp}-{surface}-{decision}-plannotator-tui.md`), so the `records/`
directory holds more filename shapes than this repo writes and `recordFile` is
the only valid handle to a sidecar (nothing may parse the name); and unknown
fields must be ignored rather than rejected.

Two optional fields are declared in v1 but not populated here, so their names
are reserved across every client: `target.agent` (`{ host?, session?,
transcript? }`) is the provenance for surfaces whose subject is an agent
session rather than a file or a diff, such as annotate-last, and
`clientVersion` is the writing client's own version where it knows it
(`packages/shared` has no runtime-agnostic version constant, so this repo
leaves it unset rather than reading `package.json` from a vendored module).

Everything is written by one shared module, `packages/shared/feedback-archive.ts`
(vendored to Pi as `apps/pi-extension/generated/feedback-archive.ts`), which
resolves the data dir per call and **never throws**: a failed archive write is
logged, degrades silently for the user, and keeps the annotation draft as the
recovery copy. The append happens BEFORE `deleteDraft`, generalizing the #678
ordering to every surface. Call sites: `packages/server/index.ts`
(`/api/approve`, `/api/deny`), `packages/server/review.ts` (`/api/feedback`,
`/api/exit`), `packages/server/annotate.ts` (`persistSubmittedDecision`,
`/api/exit`), and the three Pi mirrors in `apps/pi-extension/server/`.

Invariants worth keeping: records never contain patch bytes or a second copy of
the plan (identity and a version-file reference instead); repeat decisions
append rather than overwrite (unlike the legacy `plans/` snapshot, which is
keyed by slug and status and is left alone); annotation `source` / `author`
provenance is preserved so external, agent, and WebMCP findings stay
distinguishable from the human's own comments; and `feedback` is listed in
`PURGE_OWNED_TOP_LEVEL` (`packages/server/uninstall.ts`) so uninstall purge
removes it. Controls and the privacy/retention note are in the
`PLANNOTATOR_FEEDBACK_HISTORY` row of the environment table above. The read
path in v1 is the files on disk (`jq` over `index.jsonl`, `grep` over
`records/`); there is no CLI reader or UI surface yet.

Details that surprise people:

- **Index durability is a practical guarantee, not a formal one.** One record
  is always exactly one line, and the whole line is handed to a single
  append-mode write. That write is not one syscall (`appendFileSync` loops
  internally until its buffer is drained); what holds in practice is that an
  `O_APPEND` write of a line-sized buffer completes without interleaving on a
  local filesystem. NFS and SMB do not promise even that, and a genuine
  interleave damages **both** records that raced, not just the later one. The
  backstop is the reader: unparsable lines are skipped, so everything else in
  the file still reads. With several clients writing one index, this caveat is
  worth knowing rather than assuming away.
- **Readers gate on structure, not version.** `parseFeedbackIndex` keeps any
  line that parses and carries a numeric `v`, so a newer writer's lines are
  still returned; an analyzer that depends on v1 semantics should filter
  `v <= 1` itself. Since fields are only added and never repurposed, a `v2`
  would signal a real shape change rather than the arrival of new keys.
- **Folder-session records name the folder, not the open document.** A folder
  annotate session submits one body of feedback for the session, so
  `target.filePath` is the session's folder. The record's `annotations` hold
  every document's comments (not only the open one's), and each comment made
  on a document other than the session's own target carries the additive
  `documentPath` field naming that document (absent means the session's own
  target or message; distinct from `file`, a code annotation's file).
- **Records of a review of several files name every file.** Surface
  `annotate-bundle` (additive), no `target.filePath`, and the additive
  `target.documents: [{ path, annotationCount }]` in review order; every
  comment on a file carries its `documentPath`.
- **URL-session records store the full URL, query string included**, because
  that is the page that was reviewed. A URL carrying a token in its query is
  therefore written to disk; the opt-out is the control for that.
- **`target.review.cwd` is provenance, not a durable handle.** A PR review
  started with `--local` records a per-PR pool checkout that is cleaned up when
  the session ends; `target.review.pr` plus `gitRef` are the identity that
  survives.
- **Project bucketing prefers the caller's `project` option** (the `project`
  field on `ReviewServerOptions`, mirroring the annotate server), falling back
  to deriving a name from the review cwd. The fallback is wrong in PR mode,
  where there is no `gitContext` and `--local` points `agentCwd` at
  `pool/pr-<n>`, so every CLI entry point passes `detectProjectName()`.
- **The test suite turns the archive off** through the `tests/setup/feedback-archive-off.ts`
  preload in `bunfig.toml`, because most server tests boot a real server
  without redirecting `PLANNOTATOR_DATA_DIR` and would otherwise write into the
  contributor's own data dir. Tests that need the archive opt back in inside
  their own test bodies.
