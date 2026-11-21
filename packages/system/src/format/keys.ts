// The keys format 1 allows on each kind of entry, and the keys it dropped.
// An unknown key is an error, which also catches the YAML trap of an unquoted
// comma inside { } splitting one text into two keys.

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

/** A lookup table with no prototype, so a YAML key like "constructor" finds nothing. */
const table = <T>(o: Record<string, T>): Record<string, T> => Object.assign(Object.create(null) as Record<string, T>, o);

/** Ids that would collide with what every JavaScript object carries. A drawing may not use them as an id. */
export const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype']);

/** Engineering guards against a bad input, not limits on a drawing: one file, and the whole folder. */
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

/** Keys the prototype format had and format 1 dropped, with the reason the error gives. */
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

/** Keys that are coordinates. A drawing places parts by band, order and span, never by position. */
export const COORDS = new Set(['x', 'y', 'w', 'h', 'lx', 'ly', 'fx', 'fy', 'tx', 'ty', 'via', 'pts', 'px', 'left_px', 'top_px']);

/**
 * Maps whose keys are names the author chose (part, flow and stack ids, note
 * letters, fact labels, sheet codes), not format fields: a note `h`, a part
 * called `x` or a fact named `w` is not a coordinate. The number is how many
 * levels of names follow (place: a sheet code, then a part id).
 */
export const NAMED: Record<string, number> = table({
  notes: 1, parts: 1, flows: 1, stack: 1, says: 1, place: 2, change: 1, remove: 1, facts: 1, code: 1, scopes: 1, set: 1,
  sheets: 1, repos: 1, lines: 1, card: 1,
});

/** What a revision's change may set on a part: a fact (`facts.<label>`) or one of these fields. */
export const SETTABLE = ['role', 'sub', 'name'];
/** The lists a revision may add to on a sheet (`sheets: { CODE: { add: ... } }`). */
export const ADDABLE = ['hops', 'steps'];

/** The letter a sheet code starts with, per kind. A kind not listed here may use any letter. */
export const KIND_LETTER: Record<string, string> = table({
  conceptual: 'C', logical: 'L', deployment: 'D', service: 'S', flow: 'F', algorithm: 'A', landscape: 'T',
});

/** Sheets of a scope in pivot order: these kinds first in this order, then any other kind, then by code. */
export const KIND_ORDER = ['logical', 'deployment', 'service', 'flow', 'algorithm', 'landscape', 'conceptual'];

export const MOVES = ['data', 'people', 'money', 'energy'] as const;
