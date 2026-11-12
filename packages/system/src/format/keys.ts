export const KEYS = {
  system: ['format', 'system', 'root', 'scopes', 'parts', 'flows', 'stack', 'wanted', 'sources', 'watch'],
  sources: ['repos', 'docs'],
  source: ['repo', 'at'],
  wanted: ['code', 'kind', 'question'],
  part: ['in', 'name', 'kind', 'role', 'sub', 'marks', 'wordmark', 'child', 'facts', 'card', 'code'],
  stack: ['name', 'mark', 'marks', 'wordmark', 'version', 'for', 'role', 'used_by', 'facts'],
  flow: ['from', 'to', 'says', 'carries', 'code', 'lands', 'leaves', 'both', 'moves'],
  flowcode: ['from', 'to'],
  note: ['on', 'text'],
  callout: ['to', 'side', 'title', 'text'],
  band: ['id', 'label', 'means', 'tone', 'show', 'split', 'marks', 'row'],
  split: ['before', 'left', 'right'],
  side: ['id', 'label', 'means', 'tone', 'marks', 'beside', 'stack'],
  group: ['id', 'label', 'means', 'marks', 'around'],
  brace: ['over', 'text', 'marks', 'mark'],
  sheet: [
    'sheet', 'scope', 'kind', 'title', 'question', 'bands', 'left', 'right', 'groups', 'callouts', 'brace', 'show', 'quiet',
    'says', 'notes', 'time', 'lanes', 'places', 'hops', 'endpoint', 'route', 'loads', 'steps', 'request', 'response',
    'metric', 'columns',
  ],
  place: ['label', 'means', 'tone', 'marks', 'lanes'],
  hop: ['id', 'from', 'to', 'on', 'do', 'says', 'flow', 'at', 'reply', 'payload'],
  payload: ['name', 'title', 'lines', 'changed', 'by'],
  step: ['id', 'do', 'code', 'if', 'no', 'yes_says', 'no_says', 'calls', 'flow', 'says', 'end', 'payload'],
  loads: ['what', 'cmd', 'size', 'when'],
  column: ['label', 'means', 'tone', 'marks', 'row', 'says'],
  revision: ['revision', 'scope', 'title', 'pr', 'repo', 'merged', 'date', 'add', 'change', 'remove', 'place', 'sheets', 'lines', 'steps'],
  revadd: ['parts', 'flows', 'place'],
  placement: ['band', 'after', 'span'],
  change: ['says', 'set', 'pr'],
  removed: ['says', 'flow'],
  steps: ['title', 'question', 'time', 'lanes', 'places', 'hops'],
  stephop: ['from', 'to', 'on', 'do', 'says', 'reply', 'at', 'payload', 'is', 'note'],
  patch: ['set', 'add'],
} as const satisfies Record<string, readonly string[]>;

export type EntryKind = keyof typeof KEYS;

const table = <T>(o: Record<string, T>): Record<string, T> => Object.assign(Object.create(null) as Record<string, T>, o);

export const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype']);

export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

export const REMOVED: Record<string, string> = table({
  sample: 'process residue, not a fact of the system',
  record: 'process residue; sources.repos.<alias>.at names the commit a repo was drawn from',
  history: 'the Inbox owns pull request, issue and thread data',
  prs: 'the Inbox owns pull request, issue and thread data',
  issues: 'the Inbox owns pull request, issue and thread data',
  threads: 'the Inbox owns pull request, issue and thread data',
  charts: 'invented numbers; a drawing made from code has none',
  figures: 'invented numbers; a drawing made from code has none',
  rate: 'a performance number; an overlay carries it, never the drawing',
  state: 'whether a pull request is open or merged comes from the forge, not the file',
  author: 'the Inbox knows who wrote a revision',
  age: 'the Inbox knows when a revision was written',
  workspace: 'the Inbox knows where a revision lives',
  by: 'process residue, not a fact of the change',
});

export const COORDS = new Set(['x', 'y', 'w', 'h', 'lx', 'ly', 'fx', 'fy', 'tx', 'ty', 'via', 'pts', 'px', 'left_px', 'top_px']);

export const NAMED: Record<string, number> = table({
  notes: 1, parts: 1, flows: 1, stack: 1, says: 1, place: 2, change: 1, remove: 1, facts: 1, code: 1, scopes: 1, set: 1,
  sheets: 1, repos: 1, lines: 1, card: 1,
});

export const SETTABLE = ['role', 'sub', 'name'];
export const ADDABLE = ['hops', 'steps'];

export const KIND_LETTER: Record<string, string> = table({
  conceptual: 'C', logical: 'L', deployment: 'D', service: 'S', flow: 'F', algorithm: 'A', landscape: 'T',
});

export const KIND_ORDER = ['logical', 'deployment', 'service', 'flow', 'algorithm', 'landscape', 'conceptual'];

export const MOVES = ['data', 'people', 'money', 'energy'] as const;
