# @plannotator/system

System is a drawing of a project's code that a person can zoom through: nested sheets, each part naming the files it
rests on. An agent draws it once from the real code and commits it to the project's repo in `.plannotator/system/`. A
gate compares what changed with the files the drawing cites and says when the drawing may be out of date.

This package holds the format, its loader, the check of cited paths and the gate. It has no UI yet and no Inbox wiring.
Plannotator's own drawing is at [`.plannotator/system/`](../../.plannotator/system/).

## API

```ts
// @plannotator/system: pure, browser-safe
export const FORMAT = 1;
export type SystemFiles = Record<string, string>; // 'system.yaml', 'sheets/C-001.yaml', 'revisions/PR-2543.yaml'
export type LoadIssue = { file: string; field: string; message: string }; // field: a dotted path, 'parts.api.in', 'bands[0].x'
export type LoadResult = { model: SystemModel | null; errors: LoadIssue[]; warnings: LoadIssue[] };
export function loadFiles(files: SystemFiles): LoadResult;
export function parseRevision(model: SystemModel, yaml: string): { revision: Revision | null; errors: LoadIssue[] };
export function formatIssue(issue: LoadIssue): string; // 'sheets/L-101.yaml bands[0].x: coordinates are not allowed; ...'
export function drawingStatus(result: LoadResult | null):
  { state: 'none' | 'drawing' | 'drawn' | 'broken'; sheets: number; wanted: number; drawnAt: string | null };
export function drawingProgress(model: SystemModel):
  { sheets: { code: string; title: string; kind: string; drawn: boolean }[] };
export function citations(model: SystemModel): Citation[]; // every cited path, with the part or line citing it
export type ChangedFile = { path: string; status: 'A' | 'M' | 'D' | 'R'; from?: string };
export type GateResult = {
  touched: { parts: string[]; flows: string[] }; // cite a changed path: amber in a PR, "may be stale" on main
  wake: boolean;                                 // the shape may have moved: run the agent
  why: { path: string; reason: 'added' | 'deleted' | 'renamed' | 'watched' | 'cited-gone' }[];
  ignored: string[];                             // tests, docs, lockfiles, the drawing itself
};
export function gate(input: { files: ChangedFile[]; model: SystemModel; repo?: string /* alias, default 'self' */ }): GateResult;

// @plannotator/system/node: Bun or Node; reads disk and git, never the network
export function load(dir: string): Promise<LoadResult>;
export function readCommitted(o: { root: string; ref: string }): Promise<SystemFiles>; // the drawing's files at a commit
export function loadCommitted(o: { root: string; ref: string }): Promise<LoadResult>;  // the same, loaded
export function check(o: { dir: string; root: string; roots?: Record<string, string>; at?: string }):
  Promise<{ errors: LoadIssue[]; warnings: LoadIssue[]; missing: string[] }>;
export function gateRepo(o: { root: string; from: string; to: string; model: SystemModel }): Promise<GateResult>;
  // git diff --name-status -M <from> <to>, read only, then gate()
```

`SystemModel` and `Revision` are plain JSON-safe data (`src/format/types.ts`), so a server may load a drawing and send
the model, or send the files and let the window call `loadFiles()`.

- Every error and warning names its file and field. No files at all gives `model: null` and no errors: no drawing.
- `system.yaml` must load clean for there to be a model. A sheet or a revision with errors is left out of the model on
  its own, with its errors, so a half-written sheet in the middle of a draw leaves the rest usable. A line whose
  `lands` part only that sheet drew, or a `root` that names it, gets an error of its own.
- The model's maps (`parts`, `flows`, `sheets`, `scopes`, `revisions` and the rest) are keyed by ids the drawing
  chose, and ids like `toString` are allowed. The loader builds them with no prototype, but a model that went through
  JSON comes back as plain objects: look an id up with `Object.hasOwn(model.parts, id)`, never `model.parts[id]` alone
  or `id in model.parts`.
- `drawingStatus`: `none` (no drawing), `drawing` (sheets still under `wanted:` and not loaded, even with errors in
  them), `drawn` (nothing wanted, no errors), `broken` (`system.yaml` does not load, or errors with nothing wanted).
  `sheets` counts the sheets that load clean. `drawnAt` is `sources.repos.self.at`.
- `check` is clean when all three lists are empty. In a git repo a cited path counts only if it is in the tree of the
  commit the drawing was drawn from (`sources.repos.<alias>.at`; `at` overrides it for this repo, for a CI checkout of
  one commit), so an untracked, ignored or symlinked file does not count. Outside git it reads the disk, and a symlink
  anywhere on the path does not count. Paths are matched with their exact case, so a check on macOS agrees with one
  on Linux. Paths in another repo alias are checked only when `roots` gives a checkout of it, else a warning names the
  alias.
- Limits: a drawing file is at most 1 MiB and a drawing at most 8 MiB; a file over either is an error, not read. A
  drawing file must be a plain file (not a symlink), UTF-8, and end in `.yaml` (a `.yml` file is an error that names
  the new name). The ids `__proto__`, `constructor` and `prototype` are refused. A ref that starts with `-` is refused
  before git runs.

## The gate

If every changed file is already named by the drawing and the change adds no process, store, host, route, connection
or switch, the drawing does not change. A script cannot read "adds a process", so the gate wakes on what stands for it:

- an added, deleted or renamed file (`added`, `deleted`, `renamed`);
- a modified file that matches a `watch:` glob (`watched`);
- a cited path that is gone, deleted or renamed away (`cited-gone`).

A modified file that no part cites does not wake it. Every part and line that cites a changed path (a cited folder
covers its files) is in `touched`, whether or not the gate wakes. Tests, docs, lockfiles and `.plannotator/system/`
itself are ignored and never wake it, even inside a cited folder; only a file the drawing cites by its own path counts.
The patterns are fixed in the package (`isIgnoredPath`), not settings.

## Commands

```sh
bun run --cwd packages/system check              # the drawing of this repo: loader, then every cited path
bun run --cwd packages/system check -- --json    # one JSON value: { ok, errors, warnings, missing }
bun run --cwd packages/system check -- --at HEAD # cited paths at HEAD, not at sources.repos.self.at
bun src/node/check-cli.ts --dir <drawing> --root <repo>
bun test packages/system                         # the package's tests (sandboxed: temp folders, no network, no gh)
```

`check` exits 0 when clean, 1 when not, 2 on bad usage.

## Format 1

A drawing is one folder. Nothing in it is a coordinate: a sheet says where a part belongs (band, order, span), never
where it sits.

```
<repo>/.plannotator/system/
  system.yaml            required: the model, each fact once
  sheets/<CODE>.yaml     one file per sheet; at least the root sheet once drawing is done
  revisions/<id>.yaml    optional: reviews of merged PRs (PR-<n>.yaml)
```

`system.yaml` starts with `format: 1`. The loader refuses a folder with no `format` or a higher number ("this drawing is
format 2; this Plannotator reads format 1"). A new optional key keeps the number; a removed or renamed key, or a changed
meaning, takes the next one. Sheets and revisions carry no version of their own.

The loader rejects coordinate keys (`x`, `y`, `w`, `h`, `lx`, `ly`, `fx`, `fy`, `tx`, `ty`, `via`, `pts`, `px`) and
any unknown key, and checks every reference. Keys that are names you chose (part, line and stack ids, note letters,
fact labels, sheet codes) are never read as coordinates.

### `system.yaml`

```yaml
format: 1
system: Plannotator                 # display name
root: C-001                         # the landing sheet
sources:                            # what the agent read
  repos:
    self: { repo: github.com/backnotprop/plannotator, at: 0a684262f... }   # at: the commit drawn or checked
  docs: [https://example.com/docs]
watch: [apps/*/wrangler.toml]       # globs: a modified file here counts as a shape change
scopes: { root: Plannotator, inbox: The Inbox }   # a scope is what a dive enters
wanted:                             # sheets planned, not drawn yet
  - { code: F-201, kind: flow, question: "One question, hop by hop." }
parts:
  iserver:
    in: inbox                       # its scope (root if absent)
    name: Inbox server
    kind: Bun server
    role: One per computer.
    sub: optional mono line under the name
    marks: [mcp]                    # logos; an unknown name draws as a text tag
    wordmark: false                 # draw the first mark instead of the name
    child: inbox                    # this part opens a scope (drawn as a window)
    facts: { MCP tools: send_message, read_thread }
    card: { runtime: Bun }
    code:                           # file path to what it does for this part; the gate reads this
      packages/server/inbox.ts: startInboxServer
      other:src/app.ts: a path in the repo named "other" in sources.repos
stack:                              # technology tiles for a landscape sheet; each becomes a part
  t-bun: { name: Bun, mark: bun, for: The binary, used_by: [cli] }
flows:
  ask:
    from: agents                    # one part, or a list
    to: inbox
    says: questions and finished work
    carries: the longer text
    code: { from: apps/hook/hooks/mod/inbox.ts, to: packages/server/inbox-mcp.ts }
    lands: iserver                  # when an end opens a scope: the part inside the line reaches
    leaves: iclaude                 # the same for the from end, when it differs
    both: false                     # arrowheads at both ends
    moves: data                     # data, people, money or energy
```

A path with no prefix is in this repo; `<alias>:<path>` is in a repo `sources.repos` names. A path is relative to its
repo's root: absolute paths and `..` are refused. A cited folder covers every file in it. A part with no code (a
person, an outside product) has no `code:`.

Scopes: `scopes:` names every scope and must have `root`. A part opens a scope with `child:`, and every scope but
`root` is opened by exactly one part. A scope's parent is the scope of the part that opens it, at any depth; a scope
may not contain itself.

### `sheets/<CODE>.yaml`

Required: `sheet`, `scope`, `kind`, `title`, and `bands` (or `lanes`, `steps`, `columns`). The file is named after its
code. The code's letter is its kind's letter: C conceptual, L logical, D deployment, S service, F flow, A algorithm, T
landscape; any other kind draws as bands and may use any letter.

```yaml
sheet: L-201
scope: inbox
kind: logical
title: The Inbox
question: How a question reaches you.
bands:                              # top to bottom
  - id: core
    label: The Inbox
    means: one per computer
    tone: stone                     # sand, mist, stone, sage
    row: [iwindow 4, iserver 4, ~ 2, [istore, iregistry, 2]]   # id, "id N" spans N of 12, "~" a gap, a list a stack
    split: { before: idoor, left: on disk, right: "for phones, off" }
left: []                            # side columns: { label, means, tone, marks, beside: <band>, stack: [ids] }
right: []
groups: []                          # { label, marks, around: [band ids] }
callouts: []                        # { to: <part>, side, title, text }
brace: { over: [core], text: Bun, marks: [bun] }
show: [i_page, i_store]             # lines drawn here, or all
quiet: [i_store]                    # labels shown on hover or at high zoom only
says: { i_store: appends }          # reword a line's phrase on this sheet
notes:
  a: { on: iserver, text: "The only writer of the store." }   # on a part, a line, a hop or a step
```

Flow sheets add `time`, `lanes` (parts, left to right), `places` (bands over lanes) and `hops` (`id`, `from` and `to`
or `on`, `do`, `says`, `flow`, `at`, `reply`, `payload: { name, title, lines, changed, by }`). Algorithm sheets add
`endpoint`, `route`, `loads`, `steps` (`id`, `do`, `code`, `if`, `no`, `yes_says`, `no_says`, `calls`, `flow`, `says`,
`end`), `request`, `response` and `metric`. Landscape sheets add `columns` (`label`, `means`, `tone`, `row` of stack
ids, `says`).

### `revisions/<id>.yaml`

One schema for a merged PR kept in the repo, an open PR's change (kept outside the repo) and a plan:

```yaml
revision: PR-2563
scope: root
title: The Inbox wakes T3 Code threads
pr: 2563                            # none for a plan
repo: github.com/backnotprop/plannotator
merged: ab70b560b
date: "2026-11-03"
add:
  parts: { it3: ~ }                 # ~: the drawing already has it (a merged PR). A full entry: new (an open PR or a plan)
  flows: { i_wt3: ~ }
  place: { L-201: { newpart: { band: agents, after: iqwen, span: 2 } } }   # where a full entry goes
change:
  iserver: Adds t3 to the hosts it wakes.               # a sentence, or { says, set: { facts.<label>: v, role: v }, pr }
remove:
  oldline: { says: "Gone.", flow: { from: a, to: b } }  # a sentence, or the old line's ends so Before can draw it
sheets: { F-201: { add: { hops: [{ id: n, on: iserver, do: wakes T3, after: store }] } } }
lines: { iserver: "inbox-t3-wake.ts and 3 more · +509 −9" }
steps:                              # the one sequence the PR changes, on its own lanes
  title: A reply wakes a T3 thread
  lanes: [it3, iserver]
  hops:
    - { from: iserver, to: it3, says: t3_thread_send, is: added }   # is: added or changed, or nothing
```

### Removed from the prototype format

The loader rejects these and says why: `sample` and `record` (process residue; `sources.repos.<alias>.at` replaces
`record.checked`), `history`, `prs`, `issues` and `threads` (the Inbox owns that data), `charts` and `figures` (invented
numbers), `rate` (a performance number belongs in an overlay), and on a revision `state`, `author`, `age`, `workspace`
and `by` (the forge and the Inbox know those).
