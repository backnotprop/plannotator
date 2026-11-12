export const FORMAT = 1;

export type SystemFiles = Record<string, string>;

export type LoadIssue = { file: string; field: string; message: string };

export type LoadResult = {
  model: SystemModel | null;
  errors: LoadIssue[];
  warnings: LoadIssue[];
};

export type CodeRef = { repo: string; path: string; note: string };

export type Part = {
  id: string;
  in: string;
  name: string;
  kind: string;
  role: string;
  sub: string;
  marks: string[];
  wordmark: boolean;
  child: string | null;
  facts: [string, string][];
  card: Record<string, unknown> | null;
  code: CodeRef[];
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
  time: string;
  lanes: string[];
  places: Place[];
  hops: Hop[];
  endpoint: string | null;
  route: string;
  loads: { what: string; cmd: string; size: string; when: string } | null;
  steps: AlgoStep[];
  request: Payload | null;
  response: Payload | null;
  metric: string;
  columns: Column[];
};

export type Wanted = { code: string; kind: string; question: string };

export type Sources = {
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
  is: 'added' | 'changed' | null;
  note: string;
};

export type Revision = {
  id: string;
  scope: string;
  title: string;
  pr: number | null;
  repo: string;
  merged: string;
  date: string;
  add: {
    parts: Record<string, Part | null>;
    flows: Record<string, Flow | null>;
  };
  place: Record<string, Record<string, { band: string; after: string | null; span: number | null }>>;
  change: Record<string, { says: string; set: Record<string, string>; pr: number | null }>;
  remove: Record<string, { says: string; flow: Flow | null }>;
  sheets: Record<string, { set: Record<string, unknown>; add: Record<string, unknown[]> }>;
  lines: Record<string, string>;
  steps: { title: string; question: string; time: string; lanes: string[]; places: Place[]; hops: StepHop[] } | null;
};

export type SystemModel = {
  format: typeof FORMAT;
  name: string;
  root: string;
  scopes: Record<string, string>;
  parentOf: Record<string, string>;
  owner: Record<string, string>;
  byScope: Record<string, string[]>;
  parts: Record<string, Part>;
  flows: Record<string, Flow>;
  sheets: Record<string, Sheet>;
  revisions: Record<string, Revision>;
  wanted: Wanted[];
  sources: Sources | null;
  watch: string[];
};
