// The model a format 1 drawing loads into. Plain data, JSON-safe: the Inbox
// server may load a drawing and send the model to a window as JSON.

/** The format number this package reads and writes. */
export const FORMAT = 1;

/** A drawing's files by their path inside the drawing folder: 'system.yaml', 'sheets/C-001.yaml', 'revisions/PR-2543.yaml'. */
export type SystemFiles = Record<string, string>;

/** One problem in one file. `field` is where in the file (`parts.api.in`, `bands[0].row`), or '' for the whole file. */
export type LoadIssue = { file: string; field: string; message: string };

export type LoadResult = {
  /**
   * The model, or null when there is nothing to load (no files) or system.yaml itself does not load. When system.yaml
   * loads, the model holds every sheet and revision that loaded clean; a file with errors is left out and its errors
   * are listed, so a half-written sheet in the middle of a draw leaves the rest usable.
   */
  model: SystemModel | null;
  errors: LoadIssue[];
  warnings: LoadIssue[];
};

/** One file a part or a line rests on. `repo` is the alias in `sources.repos` (`self` for this repo). */
export type CodeRef = { repo: string; path: string; note: string };

export type Part = {
  id: string;
  /** The scope the part sits in ('root' when the YAML says no `in:`). */
  in: string;
  name: string;
  kind: string;
  role: string;
  sub: string;
  marks: string[];
  wordmark: boolean;
  /** The scope this part opens (drawn as a window), or null. */
  child: string | null;
  facts: [string, string][];
  card: Record<string, unknown> | null;
  code: CodeRef[];
  /** Technology parts (from `stack:`) only: the parts built on it. */
  usedBy: string[];
};

export type Flow = {
  id: string;
  from: string[];
  to: string;
  says: string;
  carries: string;
  code: { from: CodeRef | null; to: CodeRef | null };
  lands: string | null;
  leaves: string | null;
  both: boolean;
  moves: 'data' | 'people' | 'money' | 'energy' | null;
};

/** A cell in a band's row: a part with an optional span of 12 columns, a gap, or a stack of parts sharing one cell. */
export type Cell =
  | { type: 'part'; id: string; span: number | null }
  | { type: 'gap'; span: number; fixed: boolean }
  | { type: 'stack'; stack: Cell[]; span: number | null };

export type Band = {
  id: string;
  label: string;
  means: string;
  tone: string;
  show: string;
  split: { before: string; left: string; right: string } | null;
  marks: string[];
  row: Cell[];
};

export type SideSection = {
  id: string;
  side: 'left' | 'right';
  label: string;
  means: string;
  tone: string;
  marks: string[];
  beside: string | null;
  stack: string[];
};

export type Group = { id: string; label: string; means: string; marks: string[]; around: string[] };
export type Callout = { to: string; side: string; title: string; text: string };
export type Note = { l: string; on: string; text: string };
export type Payload = { name: string; title: string; lines: string[]; changed: number[]; by: string };

export type Hop = {
  id: string;
  from: string | null;
  to: string | null;
  on: string | null;
  do: string;
  says: string;
  flow: string | null;
  at: string;
  reply: boolean;
  payload: Payload | null;
};

export type Place = { label: string; means: string; tone: string; marks: string[]; lanes: string[] };

export type AlgoStep = {
  id: string;
  do: string;
  code: string;
  if: string;
  no: unknown;
  yes_says: string;
  no_says: string;
  calls: string | null;
  flow: string | null;
  says: string;
  end: string;
  payload: Payload | null;
};

export type Column = { label: string; means: string; tone: string; marks: string[]; row: string[]; says: string };

export type Sheet = {
  sheet: string;
  scope: string;
  /** conceptual, logical, deployment, service, flow, algorithm, landscape; any other word draws as bands. */
  kind: string;
  title: string;
  question: string;
  bands: Band[];
  left: SideSection[];
  right: SideSection[];
  groups: Group[];
  callouts: Callout[];
  brace: { over: string[]; text: string; marks: string[] } | null;
  show: 'all' | string[];
  quiet: string[];
  says: Record<string, string>;
  notes: Note[];
  // flow sheets
  time: string;
  lanes: string[];
  places: Place[];
  hops: Hop[];
  // algorithm sheets
  endpoint: string | null;
  route: string;
  loads: { what: string; cmd: string; size: string; when: string } | null;
  steps: AlgoStep[];
  request: Payload | null;
  response: Payload | null;
  metric: string;
  // landscape sheets
  columns: Column[];
};

export type Wanted = { code: string; kind: string; question: string };

export type Sources = {
  /** Alias to repo. The project's own repo is `self`. `at` is the commit last drawn or checked against. */
  repos: Record<string, { repo: string; at: string }>;
  docs: string[];
};

export type StepHop = {
  from: string | null;
  to: string | null;
  on: string | null;
  do: string;
  says: string;
  reply: boolean;
  at: string;
  payload: Payload | null;
  /** Added or changed by this PR; null when the step was there before. */
  is: 'added' | 'changed' | null;
  note: string;
};

export type Revision = {
  id: string;
  scope: string;
  title: string;
  /** The pull request number; null for a plan. */
  pr: number | null;
  repo: string;
  /** The merge commit, for a merged PR kept in the repo. */
  merged: string;
  date: string;
  add: {
    /** null: the drawing already has it (a merged PR's review). A part: new in this revision (an open PR or a plan). */
    parts: Record<string, Part | null>;
    flows: Record<string, Flow | null>;
  };
  /** Where each added part goes: sheet code, then part id. */
  place: Record<string, Record<string, { band: string; after: string | null; span: number | null }>>;
  change: Record<string, { says: string; set: Record<string, string>; pr: number | null }>;
  /** A removed part or line; `flow` carries a removed line's old ends so Before can draw it. */
  remove: Record<string, { says: string; flow: Flow | null }>;
  /** Patches to one sheet's own drawing: `set` replaces keys, `add` inserts hops or steps. */
  sheets: Record<string, { set: Record<string, unknown>; add: Record<string, unknown[]> }>;
  /** Per part, its line counts from the diff ("index.ts · +8"). */
  lines: Record<string, string>;
  steps: { title: string; question: string; time: string; lanes: string[]; places: Place[]; hops: StepHop[] } | null;
};

export type SystemModel = {
  format: typeof FORMAT;
  name: string;
  /** The landing sheet's code. */
  root: string;
  /** Scope id to display name. `root` is the landing scope. */
  scopes: Record<string, string>;
  /** Scope id to the scope it sits in (every scope but root). */
  parentOf: Record<string, string>;
  /** Scope id to the part that opens it. */
  owner: Record<string, string>;
  /** Sheet codes per scope, in pivot order (logical first, conceptual last, then by code). */
  byScope: Record<string, string[]>;
  parts: Record<string, Part>;
  flows: Record<string, Flow>;
  sheets: Record<string, Sheet>;
  revisions: Record<string, Revision>;
  wanted: Wanted[];
  sources: Sources | null;
  /** Path globs in this repo whose modification counts as a shape change. */
  watch: string[];
};
