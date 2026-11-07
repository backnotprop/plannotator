# @plannotator/system

System is a drawing of a project's code that a person can zoom through: nested sheets, each part naming the files it
rests on. An agent draws it once from the real code into Plannotator's own folder on the Mac,
`<data dir>/system/<project key>/drawing/`. A gate compares what changed with the files the drawing cites and says
when the drawing may be out of date. System never commits, branches or pushes in the person's repo and writes nothing
in their checkout or its `.git`; it only reads the repo's history to see what merged. (Replaced 2026-11-06 by the
owner's ruling, row 7689, q-122e6577; the drawing was committed to the repo before.)

This package holds the format, its loader, the check of cited paths, the gate, the recipes agents follow, the
scheduled check that wakes an agent to redraw, and the drawing at rest as React components
(`@plannotator/system/react`). It has no Inbox wiring yet; the `plannotator system` command is its one door from a
shell.
This repo also keeps a drawing of Plannotator itself at [`.plannotator/system/`](../../.plannotator/system/), for its
own tests and CI; that copy is a developer file, not where System keeps a person's drawing.

## API

```ts
// @plannotator/system: pure, browser-safe
export const FORMAT = 1;
export const MAX_FILE_BYTES = 1048576; export const MAX_TOTAL_BYTES = 8388608; // the loader's caps
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

// the change on the drawing (step A5)
export type ChangeFile = { path: string; status?: 'A' | 'M' | 'D' | 'R'; from?: string; additions?: number; deletions?: number };
export function applyChange(model: SystemModel, change: Revision | GateResult, view: 'before' | 'after' | 'steps',
  files?: ChangeFile[]): SystemModel; // a new model with the change's marks; memoized per (model, change, view, files)
export function changeSummary(model: SystemModel, change: Revision | GateResult, files?: ChangeFile[]): ChangeSummary;
export type ChangeSummary = { sheet: string; added: number; changed: number; removed: number;
  parts: { id: string; name: string; is: 'added' | 'changed' | 'removed'; files: string[]; lines?: string }[];
  flows: { id: string; says: string; is: 'added' | 'changed' | 'removed' }[] };
export function changeWords(s: ChangeSummary): string; // '1 part added, 7 changed, 1 line removed'
export function hasSteps(change: Revision | GateResult | null): boolean;
export function isRevision(change: Revision | GateResult): change is Revision;
export function linesOf(files: ChangeFile[]): string | undefined; // 'inbox.ts and 2 more · +21 −1'
export const STEPS_CODE = '~steps'; // the sheet applyChange(..., 'steps') adds

// @plannotator/system/node: Bun or Node; reads disk and git, never the network
export function load(dir: string): Promise<LoadResult>;
export function readCommitted(o: { root: string; ref: string }): Promise<SystemFiles>; // the drawing's files at a commit
export function loadCommitted(o: { root: string; ref: string }): Promise<LoadResult>;  // the same, loaded
export function check(o: { dir: string; root: string; roots?: Record<string, string>; at?: string }):
  Promise<{ errors: LoadIssue[]; warnings: LoadIssue[]; missing: string[] }>;
export function gateRepo(o: { root: string; from: string; to: string; model: SystemModel }): Promise<GateResult>;
  // git diff --name-status -M <from> <to>, read only, then gate()
```

```ts
// @plannotator/system/react: React components that take props; no fetching, no routes, no storage; browser-safe
import '@plannotator/system/system.css'; // once: plain CSS, sys- classes, the Inbox's tokens, light and dark

export function SystemThumb(p: {
  model: SystemModel;
  sheet?: string;                 // default: the landing sheet
  revision?: Revision | GateResult; // drawn as After, on the sheet the change touches most when no sheet is given
  width: number;                  // px; the height follows the sheet
}): JSX.Element;                  // a still picture (role img), no controls

export function SystemView(p: {
  model: SystemModel;
  sheet?: string;                 // default (and when the drawing lacks it): the landing sheet; a new value travels there
  project?: string;               // the first crumb, the host's project name
  reading?: 'simple' | 'full';    // default full; a sheet with one reading draws it
  layout: 'pane' | 'window';      // pane: fits the width and grows down; window: fits the window
  revision?: Revision | GateResult; // the change drawn on the sheet; with no sheet, opens on the sheet it touches most
  view?: 'before' | 'after' | 'steps'; // default after; Before and Steps need a revision (Steps, its steps)
  mode?: 'review' | 'plan';       // plan: added and changed parts dashed, "As built" and "As planned"
  files?: ChangeFile[];           // the PR's files with their counts: they name each part's files
  pr?: { number?: number; title?: string; state?: 'open' | 'merged' | 'closed' }; // the PR chip in the bar
  keys?: boolean;                 // default true: + - F, 1 to 9 and N act with the drawing in focus (see Moving)
  onNavigate(sheet: string): void; // the sheet on screen changed: a dive landed, Esc or a crumb climbed, a chip turned
  onReading?(r: 'simple' | 'full'): void; // shows the Simple / Full switch on a sheet with both
  onView?(v: 'before' | 'after' | 'steps'): void; // shows Before / After / Steps; Esc in Steps asks for after
  onOpenFile?(path: string, part: string): void;   // in a window, shows the parts list with its diff links
  onOpenDetails?(): void;         // the PR chip becomes a button that opens the PR's details
  onOpenFull?(): void;            // shows Open full window, in the pane
  onClose?(): void;               // shows the close button
}): JSX.Element;

export function SystemChangePicture(p: { model: SystemModel; change: Revision | GateResult; files?: ChangeFile[];
  onOpen(): void }): JSX.Element; // the review card's picture: one button, the change's crop and its line
export function PartsList(p: { model: SystemModel; revision: Revision | GateResult; files?: ChangeFile[];
  onOpenFile(path: string, part: string): void; selected?: string | null; onSelect?(part: string): void;
  onHover?(part: string | null): void; summary?: ChangeSummary }): JSX.Element; // what SystemView draws beside the sheet
export function ChangeLine(p: { summary: ChangeSummary }): JSX.Element; // the change's line, each clause in its ink
export function changeCrop(L: SheetLayout): Rect; // the marked parts, their bands and the marked lines' labels

export function Sheet(p: { layout: SheetLayout; model: SystemModel; lod?: 0 | 1 | 2 | 3; live?: boolean;
  onNavigate?(sheet: string): void;  // a window's cue, when onEnter is not given: the first sheet inside
  onEnter?(part: string): void }): JSX.Element; // a window's cue: the host dives into that part
  // one laid-out sheet, in sheet units (1600 wide); live parts with sheets inside are Tab stops
export function layoutSheet(model: SystemModel, code: string, opts?: LayoutOpts): SheetLayout;
export function restLayout(model: SystemModel, code: string, o?: { simple?: boolean }): SheetLayout; // at rest
export function hasSimple(model: SystemModel, code: string): boolean;
export function setText(t: { type: number; sans: string; mono: string }): void; // what the layout measures with
export function fontsReady(): Promise<void>; // forgets widths measured before the faces loaded
```

- The components read the host's text size (`--ib-type`) and faces (`--font-sans`, `--font-mono`) from where they
  are drawn, and the layout measures with them, so a box fits its words at every Text size. Every font size in the
  sheet is `var(--ib-fs-N, Npx)`.
- At rest a sheet fits its pane or window, never past 1:1. Below 0.95 the quiet lines lose their words; below 0.3 every
  line does.
- A part that opens a scope with sheets is drawn as a plate with a "N sheets inside" cue.
- CI fetches the drawing's pinned commit (`sources.repos.self.at`) one commit deep before the tests, so the cited paths
  are checked offline. That fetch costs more as the pinned commit ages; a redraw that refreshes `at` keeps it cheap.
- `bun run --cwd packages/system demo` serves a page that draws this repo's drawing, for screenshots only:
  `?shot=thumb`, or `?shot=view&sheet=C-001&reading=simple&layout=window|pane`, with `&mode=light`. The change view:
  `?shot=card|change&pr=2543|2563` (with `&open=1` for PR 2563 as an open PR, `&gate=1` for the gate's result alone,
  `&removes=1` for an invented removal, `&view=before|after|steps`), and `?shot=plan`. `node scripts/shots-change.mjs`
  takes them all at 1440x900, light and dark; `CONTRAST=1` prints each ink's measured contrast.

### The change

- After: what the change adds is green, what it changes amber, what it removes grey, dashed and struck. Each marked
  part carries its number (the order of the parts list: added, changed, removed) and its line counts in mono. A line
  into or out of a removed part is removed with it.
- Before: the drawing without what the change added; nothing is marked. A merged PR's `~` entries are hidden; an open
  PR's full entries are not drawn. Steps: the revision's one sequence as its own sheet, each step in its ink.
- The gate's result alone (no revision yet, or one for an older head) marks the touched parts and lines amber, and has
  no Before and no Steps.
- A part's files are the PR's files its own cited paths in this repo cover; a test or doc counts only when cited by
  name. Its counts are those files' counts, so the list and the sheet never disagree. Without `files`, a part keeps
  the cited files its written counts name.
- The sheet a change opens on is the one that draws most of its parts (outer parts not counted), a banded sheet first.
- The card picture crops to the marked parts and their bands. When more than 16 lines cross that crop it draws the
  Simple reading.
- A plan (a revision with no `pr`) is drawn dashed, new parts washed green, with no numbers and no diff links.

### Moving

The view owns its camera and the sheet on screen; the host hears where it is through `onNavigate`. `sheet` is where to
start, and a new value travels there: a dive when it is inside, a climb when it is above, a turn when it is a sheet of
the same scope.

- The wheel and a pinch zoom about the pointer; in a pane the wheel scrolls the host and zooms only with Ctrl or ⌘ (a
  pinch always zooms). A drag moves the sheet and glides when let go.
- A window's cue, a double click on it, or Enter on it dives in: the camera flies into the box while the inside unrolls
  out of it, and lands on the inside sheet at rest. Zooming into a window does the same through its door. Esc, the
  wheel out, or a crumb above climbs. A second input during a dive turns it round from where it is.
- The chips name the sheets of the scope by kind ("Logical", "Data flow"); a chip or keys 1 to 9 turn to one. The
  parts both sheets draw travel to their new places, the rest fades.
- The Simple / Full switch moves the parts to the other reading's places: into Simple the lines and words fade first,
  into Full they come back after the parts land.
- The zoom group: zoom out, the percent (which fits), zoom in, and Key (the symbols, the line colours and the keys). N
  opens every note of the sheet. Esc closes a card before it climbs, and on the landing sheet calls `onClose`.
- Keys act only with focus in the drawing: Tab and the arrows move between parts, Enter opens, Esc climbs. `keys={false}`
  turns off + - F, 1 to 9 and N for a host that owns those keys; the Inbox needs the owner's approval for new
  shortcuts before it turns them on.
- Every move is a critically damped spring launched by the input (90% of the way in 250 ms for + and -, 375 ms for a
  fit or a turn, 700 ms for a dive). With reduced motion the camera cuts and the drawing fades up over 180 ms.
- `node scripts/measure.mjs` (with the demo running, `SYSTEM_URL` set) films every move and reports the step size per
  frame, dropped frames and long tasks.

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
  alias. Spans are a preference: a band whose written spans add up to more than 12 columns is clean, and the
  renderer narrows every part in it to fit.
- Limits: a drawing file is at most 1 MiB and a drawing at most 8 MiB; a file over either is an error, not read. A
  drawing file must be a plain file (not a symlink), UTF-8, and end in `.yaml` (a `.yml` file is an error that names
  the new name). The ids `__proto__`, `constructor` and `prototype` are refused. A ref that starts with `-` is refused
  before git runs.

## The gate

If every changed file is already named by the drawing and the change adds no process, store, host, route, connection
or switch, the drawing does not change. A script cannot read "adds a process", so the gate wakes on what stands for it:

- an added file, or a copy (`added`, the new path);
- a deleted or renamed file whose exact path a part or line cites (`cited-gone`, the old path);
- any other deleted or renamed file (`deleted`; `renamed`, the new path);
- a modified file that matches a `watch:` glob (`watched`): a top-level list in `system.yaml` of globs relative to
  the repo's root, `**` crossing folders and `*` and `?` staying inside one (`watch: [wrangler.toml, config/**/*.yaml]`).

Each file gets one reason at most: a deleted file a part cites by its own path is `cited-gone`, never also `deleted`.
Any other edit of a file that stays does not wake it, cited or not. Every part and line that cites a changed path (a
cited folder covers its files) is in `touched`, whether or not the gate wakes.

Ignored files never wake it and touch nothing, even inside a cited folder; only a file the drawing cites by its own
path counts, and a rename is ignored only when both its paths are. Ignored are: a test (a folder named `test`, `tests`,
`__tests__`, `e2e`, `fixtures`, `test-fixtures` or `__snapshots__` (`TEST_FOLDERS`) anywhere in the path, or a name ending `.test.` or `.spec.` then `js`, `jsx`, `ts` or `tsx` with an optional `c` or `m` first), a doc
(a name ending `.md` or `.mdx` in any case, or a folder named `docs` anywhere), a lockfile (a name in
`LOCKFILE_NAMES`, in any folder) and anything under `.plannotator/system/`. The patterns are fixed in the package
(`isIgnoredPath`), not settings, and the command's help is built from the same lists.

## Commands

`plannotator system` is the command agents and the launchd job call (`apps/hook/server/system-command.ts`, a thin
file over this package; `plannotator system --help` is its whole agent guide). Its subcommands and flags are exactly
`SYSTEM_COMMANDS`, which the recipes name too:

```sh
plannotator system check [--root <repo folder>] [--dir <drawing folder>] [--repo <alias>=<folder>]... [--at <commit>] [--json]
plannotator system gate [--project <repo folder>] [--dir <drawing folder>] --from <commit> --to <commit>
plannotator system tick --project <repo folder> --key <project key>
plannotator system revision --project <repo folder> --pr <host/owner/repo#n> --head <commit> -
plannotator system schedule install --project <repo folder> --key <project key> | remove --key <project key> | list
```

- stdout is the result (check prints one line per finding, or one JSON value with `--json`; the others one JSON value)
  and nothing on failure; stderr is one `<code>: <message>` line per problem; exit 0 ok, 1 failed, 2 bad usage. The
  codes: `usage`, `not_a_folder`, `no_drawing`, `drawing_broken`, `git_failed`, `tick_failed`, `revision_refused`,
  `not_installed`, `unsupported`, `launchctl_failed`, `failed`. check's findings are its result: printed on stdout,
  with one `not_clean: <counts>` line on stderr and exit 1. Each `missing:` line names the field that cites the path:
  `parts.<id>.code`, or `flows.<id>.code.from` or `.to` for a line's end.
- `check`, `gate` and `revision` read the drawing folder as it is on disk, so an edit counts at once; nothing is
  committed, branched or pushed. `--dir` names the drawing folder; without it, it is
  `<dataDir>/system/<key>/drawing` of the repo folder's project (the key as below). With no `--root` or `--project`,
  the repo is the one the current folder is in. The recipes run `check --dir <drawing folder> --root <source folder>`,
  `--root` being Plannotator's clone of the project (`<dataDir>/system/<key>/source`).
- `gate` diffs exactly the `--from` and `--to` it is given (a sha, a branch, a tag); it does not find a merge base.
  To gate a branch, pass `--from "$(git merge-base main <branch>)"`.
- `revision` loads the revision against the project's drawing folder, refuses it with one line per problem when it
  does not load or its `pr:` and `repo:` differ from `--pr`, and stores it as written under
  `<dataDir>/system/<key>/reviews/<host>/<owner>/<repo>/<n>@<sha7>.yaml`. The key is the Inbox's key for the folder
  (`inboxProjectKey` of its project root, as the Shape store files under it).
- `tick` prints the `TickResult`; a failed tick exits 1. `schedule install` writes a plist that runs the installed
  binary, so it refuses to run from a source checkout; launchd runs a first check as soon as it loads the job, then
  every 15 minutes. `list` prints the keys as one JSON array.
- The command is unreleased (`HIDDEN_SUBCOMMANDS`): it runs and has its help, but `plannotator --help` and the
  plannotator skill leave it out until the Inbox's System surfaces ship.

From a checkout, for this repo's own drawing:

```sh
bun run --cwd packages/system check              # the drawing of this repo: loader, then every cited path
bun run --cwd packages/system check -- --json    # one JSON value: { ok, errors, warnings, missing }
bun run --cwd packages/system check -- --at HEAD # cited paths at HEAD, not at sources.repos.self.at
bun src/node/check-cli.ts --dir <drawing> --root <repo>
bun run --cwd packages/system recipes            # write src/recipe/text.ts from recipe/*.md after an edit
bun test packages/system                         # the package's tests (sandboxed: temp folders, no network, no gh)
```

`check` exits 0 when clean, 1 when not, 2 on bad usage.

## The recipes and the scheduled check

Three jobs, each a recipe an agent reads: draw once, redraw when main moves, draw an open pull request's change. The
recipes are plain Markdown in [`recipe/`](recipe/), written so any agent (Claude Code, Pi, OpenCode) can follow them
with only that text:

- [`DRAW.md`](recipe/DRAW.md): the first drawing. Read the code in the source folder (Plannotator's clone of the
  project) and the doc sites, write `system.yaml` first in the drawing folder with every planned sheet under
  `wanted:`, draw the landing and then the deeper sheets, run `plannotator system check` until clean, and send two
  Inbox messages (starting, done). Nothing is committed, pushed or opened as a pull request.
- [`UPDATE.md`](recipe/UPDATE.md): an unattended redraw. Read the commits that landed, decide whether the shape moved
  (if not, change nothing), edit the drawing folder's copy, move `at`, check until clean, and write one sentence per
  changed sheet in the summary file. It never sends: the tick does.
- [`REVIEW.md`](recipe/REVIEW.md): an open pull request's change. Ask the gate first and stop when it does not wake,
  write the revision in the open form, and hand it to `plannotator system revision`, which refuses one that does not
  load.
- [`FORMAT.md`](recipe/FORMAT.md): format 1 for an agent. Its examples are one drawing a test loads clean.

The browser entry carries them as strings (`src/recipe/text.ts`, generated; a test keeps it in step).

```ts
// @plannotator/system (and /node): pure
export const recipes: { draw: string; update: string; review: string; format: string };
export function firstDrawPrompt(setup: Pick<SystemSetup, 'repos' | 'docs'> & { thread_message?: string | null },
  projectRoot: string, o?: { drawing?: string; source?: string; name?: string; repo?: string }): string;
                                                                       // facts, DRAW.md, FORMAT.md
export function updatePrompt(o: UpdatePromptInput): string;            // the tick's redraw prompt
export function reviewPrompt(o: { project: string; drawing: string; pr: string; head: string; base: string;
  name?: string }): string;
                                                                       // an open PR's change: facts, REVIEW.md, FORMAT.md
export type SystemSetup = { v: 1; repos: string[]; docs: string[]; agent: 'claude' | 'pi' | 'opencode';
  model: string | null; thread_message: string | null };
export function parseSetup(value: unknown): SystemSetup | null;
export function agentModel(agent: SystemAgent, model: string | null): string | null;
export function unattendedDocUrl(url: string): { ok: true; url: string } | { ok: false; url: string; reason: string };
export function unattendedDocs(docs: string[]): { allowed: string[]; refused: { url: string; reason: string }[] };
export function redrawCommand(setup: Pick<SystemSetup, 'agent' | 'model'>, prompt: string):
  { command: string[]; stdin: string | null };
export const SYSTEM_COMMANDS: Record<'check' | 'gate' | 'tick' | 'revision' | 'schedule', string>; // usage lines
// SYSTEM_COMMANDS and SYSTEM_TICK_INTERVAL_SECONDS are also @plannotator/system/commands, which loads no loader (the CLI's help)

// @plannotator/system/node
export function systemPaths(dataDir: string, key: string): { dir; setup; state; lock; drawing; source; redraw;
  previous; summary; reviews; changed; failed: string };              // <dataDir>/system/<key>/...
export function prepareSource(root: string, source: string, o?: { need?: (string | null)[]; aside?: string; stamp?: string }):
  Promise<{ main: string; tip: string; recloned?: string }>;
export function readSetup(dataDir: string, key: string): Promise<SystemSetup | null>;
export function readState(dataDir: string, key: string): Promise<TickState>;
export function tick(o: { root: string; dataDir: string; key: string; now?: Date; deps?: TickDeps }): Promise<TickResult>;
export const TICK_TIMEOUTS_MS: { agent: 2_700_000; git: 300_000; note: 120_000 };
export function runCommand(argv: string[], o: { cwd: string; timeoutMs: number; stdin?: string | null;
  env?: Record<string, string> }): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>;
export function plannotatorProgram(): Promise<string>;   // this binary when it is plannotator, else the first on PATH
export const SYSTEM_TICK_INTERVAL_SECONDS = 900;
export const schedule: {
  plist(o: ScheduleOptions): string;
  install(o: ScheduleOptions & { agentsDir?: string; run?: CommandRunner; uid?: number }): Promise<void>;
  remove(key: string, o?: { agentsDir?: string; run?: CommandRunner; uid?: number }): Promise<void>;
  list(o?: { agentsDir?: string }): Promise<string[]>;
};
```

- **The drawing's thread.** `firstDrawPrompt` names the Inbox thread in its facts: setup.json's `thread_message`
  when the Inbox started the thread (both of the agent's messages reply to it, as every redraw note does), else none,
  and the agent's first message starts one with the subject `System: <project>`.
- **Models.** setup.json may hold a model id bare (`claude-opus-5-5`) or in an agent's form. `agentModel` gives Claude
  Code the bare id and Pi and OpenCode `provider/model` (`anthropic/claude-opus-5-5`); an id with a `/` is kept, an
  unknown bare family is passed on. null is the agent's own default.
- **Doc sites.** A redraw hands its agent only `https` addresses that are not loopback, private, link-local or other
  non-public IP literals (in any spelling the URL parser takes), not `localhost`, `*.localhost`, `*.local` or a name
  with no dot, and with no sign-in in them. A public name that resolves to a private address is not caught here.
- **The agent.** A redraw runs the person's agent with its normal full tools, as they would run it themselves (the
  owner's ruling: no limits on agents). Claude Code runs `claude -p --permission-mode bypassPermissions
  --no-session-persistence`, Pi `pi --no-session -p`, OpenCode `opencode run`. Each loads the project's own settings
  and MCP servers as usual. It runs in the source clone, so what it changes there never reaches the person's repo.
- **Time bounds.** Every child the tick starts runs in its own process group and has a time bound
  (`TICK_TIMEOUTS_MS`, engineering defaults): the agent 45 minutes, git 5, the note 2. Past it the group gets
  SIGTERM, then SIGKILL 5 seconds later, and the tick records why in `state.json`. So a hung agent, a credential
  prompt or a stalled network never holds the lock for good. A child that ended returns at the latest 5 seconds
  later even when something that left its group still holds its output open. While a child runs, a SIGINT, SIGTERM
  or SIGHUP to the tick (Ctrl-C, `launchctl bootout`) goes on to every child's group the same way, and the groups are
  SIGKILLed when the tick exits, so a stopped tick leaves no agent running. On Windows the tree is stopped with
  `taskkill /T /F`.

### Where System keeps a project

Replaced 2026-11-06 by the owner's ruling (row 7689, q-122e6577). Everything is under `<dataDir>/system/<key>/` (`systemPaths`):

- `drawing/`: the drawing (`system.yaml`, `sheets/`, `revisions/`). `check` reads it here, and checks cited paths in
  the source clone at `sources.repos.self.at`, which still records the code commit the drawing was drawn at.
- `source/`: Plannotator's clone of the project for the agent to read main's code (`prepareSource`). Made with
  `git clone --reference <the repo's git folder> <its origin URL>`: the objects the person already has are borrowed,
  not copied, and each tick fetches the default branch from origin into it, so the tick sees what merged even when
  the person has not fetched. Toward the person's repo it only reads: the origin URL, the git folder and its objects.
  A plain `git clone --shared` from the person's repo would see only what they last fetched. Borrowed objects can go
  away (a `git gc`, a moved or deleted repo, a lost object file): a clone whose alternates folder is gone, or that
  cannot read the tip or the drawing's `at` whole, is moved to `failed/source-<time>/` and cloned again, once per tick,
  and with its own copy of every object when the person's repo lacks them too. The move is named in `set_aside`.
- `redraw/`: a redraw in progress, a copy of `drawing/` the agent edits. `previous/`: the drawing before the last
  redraw. `redraw-summary.txt`: the agent's sentences, read and deleted by the tick.
- `reviews/`: revisions of open pull requests (written by `plannotator system revision`). `changed/<commit>/`: files a
  redraw agent changed in the source clone. `failed/`: what a refused or cut-off redraw left.
- `setup.json`, `state.json`, `tick.lock`, `tick.err.log`.

### What a tick does

`tick({ root, dataDir, key })` is one run of `plannotator system tick --project <root> --key <key>`. It never throws.
Replaced 2026-11-06 by the owner's ruling (row 7689, q-122e6577): no branch, commit, push or pull request.

1. No setup.json: `nothing`. A live tick holds `tick.lock`: `nothing` (a dead pid's lock is taken over).
2. No drawing in `drawing/` yet: `nothing` (the first drawing is not done).
3. `prepareSource`: make the source clone when missing, then `git fetch origin <default>` into it with the person's
   own credentials; the default branch is the clone's `origin/HEAD`, else `main` or `master`.
4. From: the newer of `sources.repos.self.at` and `state.json`'s `gated`. If main has not moved past it: `nothing`.
   If the last redraw for this very commit failed: `nothing` until main moves (one model run per move, at most).
5. `gateRepo` in the source clone from there to the tip. No wake: `state.json` gets the tip as `gated`, and the tick
   ends: `gated`.
6. Wake. A redraw cut off before it ended (a reboot, a logout, a kill) left `redraw/` behind, or changes in the source
   clone: both are set aside under `failed/interrupted-<time>/` and named in `state.json`'s `set_aside`; the last good
   drawing stays, and the redraw goes on. The source clone is put at the tip, detached and clean, and `drawing/` is
   copied to `redraw/`.
7. Run the agent in the source clone with `updatePrompt`: the source folder, the drawing copy, the range, the merged
   pull requests that changed a woken file, the gate's reasons and touched parts, any stored reviews of those pull
   requests, the summary file and the allowed doc sites.
8. Files the agent changed in the source clone, its own commits included, are kept under `changed/<commit>/` and the
   clone is put back at the tip. Refuse the redraw (`failed`, the copy kept under `failed/<commit>/drawing/`, the
   drawing as it was) when the agent failed, threw or hit its time bound, or the copy does not check clean. If the
   copy is the drawing unchanged: `gated`. A failure before the agent ran (no network, no origin) marks nothing, so
   the next tick tries again.
9. Set `sources.repos.self.at` to the tip (only that value's text), move `drawing/` to `previous/` and the checked copy
   to `drawing/`, and send one note through `<plannotator> inbox call send_message` (`plannotatorProgram()` unless
   `deps.plannotator` names the program), as a reply to setup.json's `thread_message` ("Main moved to 9c41e07. PR 1335
   landed: <the agent's sentences> 1 part changed. This redraw also changed: src/main.ts."). `redrew`.

`state.json` is `{ v: 1, gated, gated_at, redrew_at, last_error, failed, set_aside }`; `failed` is the commit a
refused redraw was for, `set_aside` the last time a cut-off redraw's leftovers were moved aside and where to. Showing
`last_error` and `set_aside` in the Inbox is a later step. The agent and the note are `deps`, so the tests run the
whole path on temp repos with a scripted stand-in agent, no model and no network, and one test checks that a full
tick leaves the person's repo byte for byte as it was.

### The launchd job

One per drawn project: `~/Library/LaunchAgents/ai.plannotator.system.<key>.plist`, label
`ai.plannotator.system.<key>`, running `<plannotator> system tick --project <root> --key <key>` every
`SYSTEM_TICK_INTERVAL_SECONDS` (900: every 15 minutes while the Mac is awake, the owner's ruling) and at load, in the
background, with `PLANNOTATOR_DATA_DIR` and the given environment (PATH above all) and its errors in
`<dataDir>/system/<key>/tick.err.log`. `install` writes the plist, boots out any job under the label and bootstraps
it in `gui/<uid>`; `remove` boots it out and deletes the plist; `list` gives the keys that have one. launchctl runs
through an injectable runner, so the tests never load a job. macOS only. launchd skips a firing that falls while the
Mac sleeps and runs none at wake; the next firing catches up, because a tick diffs from the last commit it checked, not
from the time it missed.

## Format 1

A drawing is one folder. Nothing in it is a coordinate: a sheet says where a part belongs (band, order, span), never
where it sits.

```
<data dir>/system/<project key>/drawing/
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

A part's `code:` maps each path to what that file does for the part; a line's `code:` is `{ from, to }`, the file at
each end, either optional. A path with no prefix is in this repo; `<alias>:<path>` is in a repo `sources.repos` names. A path is relative to its
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
