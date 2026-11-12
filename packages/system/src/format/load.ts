import {
  ADDABLE, COORDS, KEYS, KIND_LETTER, KIND_ORDER, MAX_FILE_BYTES, MAX_TOTAL_BYTES, MOVES, REMOVED, RESERVED_IDS, SETTABLE,
  type EntryKind,
} from './keys.ts';
import {
  FORMAT, type AlgoStep, type Band, type Cell, type CodeRef, type Column, type Flow, type Hop, type LoadIssue, type LoadResult,
  type Part, type Payload, type Place, type Revision, type Sheet, type SideSection, type Sources, type StepHop,
  type SystemFiles, type SystemModel, type Wanted,
} from './types.ts';
import { readYaml } from './yaml.ts';

type Obj = Record<string, unknown>;
type At = { file: string; field: string };
type Issues = LoadIssue[];

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const asObj = (v: unknown): Obj => (isObj(v) ? v : {});
const asList = (v: unknown): unknown[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const str = (v: unknown): string => (v == null ? '' : String(v));
const strOrNull = (v: unknown): string | null => (v == null || v === '' ? null : String(v));
const strList = (v: unknown): string[] => asList(v).filter((x) => x != null).map(String);
const numOrNull = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const dict = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;
const has = (o: object, k: string) => Object.hasOwn(o, k);

const at = (file: string, field = ''): At => ({ file, field });
const sub = (a: At, k: string | number): At => ({ file: a.file, field: typeof k === 'number' ? `${a.field}[${k}]` : a.field ? `${a.field}.${k}` : k });
const err = (issues: Issues, a: At, message: string) => issues.push({ file: a.file, field: a.field, message });

export const formatIssue = (i: LoadIssue) => `${i.file}${i.field ? ` ${i.field}` : ''}: ${i.message}`;

const numberFormat = new Intl.NumberFormat('en-US');
export const fmtValue = (v: unknown): string => {
  if (typeof v === 'number') return Number.isFinite(v) ? numberFormat.format(v) : String(v);
  if (v == null) return '';
  return String(v).replace(/^(\d{5,})(?=\s|$)/, (m) => numberFormat.format(Number(m)));
};

const SHEET_CODE = /^[A-Z]-\d+$/;
const ALIAS = /^[a-z][a-z0-9_-]*$/;
const utf8Bytes = (t: string) => new TextEncoder().encode(t).length;

function checkKeys(kind: EntryKind, obj: unknown, a: At, issues: Issues): void {
  if (!isObj(obj)) return;
  const allowed = KEYS[kind] as readonly string[];
  for (const k of Object.keys(obj)) {
    if (allowed.includes(k) || COORDS.has(k)) continue;
    if (has(REMOVED, k)) err(issues, sub(a, k), `"${k}" is not in format 1 (${REMOVED[k]})`);
    else err(issues, sub(a, k), `unknown key "${k}" on a ${kind}${obj[k] === null ? ' (an unquoted comma inside { } splits a text; quote it)' : ''}`);
  }
}

function okId(id: string, a: At, issues: Issues): boolean {
  if (!RESERVED_IDS.has(id)) return true;
  err(issues, a, `"${id}" is a reserved name; pick another id`);
  return false;
}

function codeRef(raw: unknown, note: unknown, aliases: Set<string>, a: At, issues: Issues): CodeRef | null {
  let text = str(raw).trim();
  let repo = 'self';
  const m = /^([a-z][a-z0-9_-]*):(.+)$/.exec(text);
  if (m) {
    repo = m[1]!;
    text = m[2]!.trim();
    if (repo !== 'self' && !aliases.has(repo)) {
      err(issues, a, `"${str(raw)}" names the repo "${repo}", which sources.repos does not list`);
      return null;
    }
  }
  const path = text.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!path) {
    err(issues, a, 'an empty code path');
    return null;
  }
  if (path.startsWith('/') || path.startsWith('~') || /^[A-Za-z]:[\\/]/.test(path)) {
    err(issues, a, `"${str(raw)}" is not a path in a repo; cite it relative to the repo's root`);
    return null;
  }
  if (path.split(/[\\/]/).includes('..')) {
    err(issues, a, `"${str(raw)}" climbs out of the repo with ..`);
    return null;
  }
  return { repo, path, note: str(note) };
}

function normPart(id: string, raw: unknown, aliases: Set<string>, a: At, issues: Issues): Part {
  const p = asObj(raw);
  checkKeys('part', p, a, issues);
  const code: CodeRef[] = [];
  if (p.code != null) {
    if (!isObj(p.code)) err(issues, sub(a, 'code'), 'should map each file path to what it does for this part');
    else for (const [path, note] of Object.entries(p.code)) {
      const ref = codeRef(path, note, aliases, sub(a, 'code'), issues);
      if (ref) code.push(ref);
    }
  }
  if (p.facts != null && !isObj(p.facts)) err(issues, sub(a, 'facts'), 'should map a label to a value');
  if (p.card != null && !isObj(p.card)) err(issues, sub(a, 'card'), 'should be a map');
  const card = isObj(p.card) ? { ...p.card, ...(p.card.scale != null ? { scale: fmtValue(p.card.scale) } : {}) } : null;
  return {
    id,
    in: str(p.in) || 'root',
    name: str(p.name).trim() === '' ? id : str(p.name),
    kind: str(p.kind) || 'part',
    role: str(p.role),
    sub: str(p.sub),
    marks: strList(p.marks),
    wordmark: p.wordmark === true,
    child: strOrNull(p.child),
    facts: Object.entries(asObj(p.facts)).map(([k, v]) => [k, fmtValue(v)] as [string, string]),
    card,
    code,
    usedBy: [],
  };
}

function normFlow(id: string, raw: unknown, aliases: Set<string>, a: At, issues: Issues): Flow {
  const f = asObj(raw);
  checkKeys('flow', f, a, issues);
  const moves = f.moves == null ? null : str(f.moves);
  if (moves != null && !(MOVES as readonly string[]).includes(moves)) err(issues, sub(a, 'moves'), `"${moves}" is not ${MOVES.join(', ')}`);
  if (f.from == null || f.to == null) err(issues, a, 'a line needs from and to');
  const code: Flow['code'] = { from: null, to: null };
  if (f.code != null) {
    if (!isObj(f.code)) err(issues, sub(a, 'code'), 'should be { from: <path>, to: <path> }');
    else {
      checkKeys('flowcode', f.code, sub(a, 'code'), issues);
      if (f.code.from != null) code.from = codeRef(f.code.from, 'from', aliases, sub(a, 'code.from'), issues);
      if (f.code.to != null) code.to = codeRef(f.code.to, 'to', aliases, sub(a, 'code.to'), issues);
    }
  }
  return {
    id, from: strList(f.from), to: str(f.to), says: str(f.says), carries: str(f.carries), code,
    lands: strOrNull(f.lands), leaves: strOrNull(f.leaves), both: f.both === true, moves: moves as Flow['moves'],
  };
}

function parseCell(tok: unknown): Cell | { type: 'bad'; text: string } {
  if (Array.isArray(tok)) {
    const span = tok.find((t) => typeof t === 'number');
    const stack = tok.filter((t) => typeof t !== 'number').map(parseCell);
    const bad = stack.find((c) => c.type === 'bad');
    if (bad) return bad;
    return { type: 'stack', stack: stack as Cell[], span: typeof span === 'number' ? span : null };
  }
  if (tok == null) return { type: 'gap', span: 1, fixed: false };
  const s = String(tok).trim().replace(/^~(\d+)$/, '~ $1');
  const m = /^(~|[A-Za-z][\w-]*)(?:\s+(\d+))?$/.exec(s);
  if (!m) return { type: 'bad', text: s };
  if (m[1] === '~') return { type: 'gap', span: m[2] ? Number(m[2]) : 1, fixed: !!m[2] };
  return { type: 'part', id: m[1]!, span: m[2] ? Number(m[2]) : null };
}

const cellParts = (c: Cell, out: string[]) => {
  if (c.type === 'part') out.push(c.id);
  else if (c.type === 'stack') c.stack.forEach((x) => cellParts(x, out));
};

function payload(raw: unknown, a: At, issues: Issues): Payload | null {
  if (raw == null) return null;
  checkKeys('payload', raw, a, issues);
  const p = asObj(raw);
  return {
    name: str(p.name), title: str(p.title), lines: strList(p.lines),
    changed: asList(p.changed).map(Number).filter(Number.isFinite), by: str(p.by),
  };
}

function places(raw: unknown, a: At, issues: Issues): Place[] {
  return asList(raw).map((c, i) => {
    checkKeys('place', c, sub(sub(a, 'places'), i), issues);
    const p = asObj(c);
    return { label: str(p.label), means: str(p.means), tone: str(p.tone), marks: strList(p.marks), lanes: strList(p.lanes) };
  });
}

function normSheet(raw: Obj, file: string, issues: Issues): Sheet {
  const top = at(file);
  checkKeys('sheet', raw, top, issues);
  const bands: Band[] = asList(raw.bands).map((b, i) => {
    const o = asObj(b);
    const a = sub(sub(top, 'bands'), i);
    checkKeys('band', o, a, issues);
    if (o.split != null) checkKeys('split', o.split, sub(a, 'split'), issues);
    const row: Cell[] = [];
    for (const tok of asList(o.row)) {
      const c = parseCell(tok);
      if (c.type === 'bad') err(issues, sub(a, 'row'), `an unreadable cell "${c.text}"`);
      else row.push(c);
    }
    const split = isObj(o.split) ? { before: str(o.split.before), left: str(o.split.left), right: str(o.split.right) } : null;
    return {
      id: str(o.id) || `band${i}`, label: str(o.label), means: str(o.means), tone: str(o.tone), show: str(o.show),
      split, marks: strList(o.marks), row,
    };
  });
  const side = (list: unknown, s: 'left' | 'right'): SideSection[] =>
    asList(list).map((c, i) => {
      const o = asObj(c);
      checkKeys('side', o, sub(sub(top, s), i), issues);
      return {
        id: str(o.id) || `${s}${i}`, side: s, label: str(o.label), means: str(o.means), tone: str(o.tone),
        marks: strList(o.marks), beside: strOrNull(o.beside), stack: strList(o.stack),
      };
    });
  const brace = isObj(raw.brace) ? raw.brace : null;
  if (brace) checkKeys('brace', brace, sub(top, 'brace'), issues);
  const notes = Object.entries(asObj(raw.notes)).map(([l, n]) => {
    checkKeys('note', n, sub(sub(top, 'notes'), l), issues);
    return { l, on: str(asObj(n).on), text: str(asObj(n).text) };
  });
  const hops: Hop[] = asList(raw.hops).map((h, i) => {
    const o = asObj(h);
    const a = sub(sub(top, 'hops'), i);
    checkKeys('hop', o, a, issues);
    return {
      id: str(o.id) || `h${i + 1}`, from: strOrNull(o.from), to: strOrNull(o.to), on: strOrNull(o.on), do: str(o.do),
      says: str(o.says), flow: strOrNull(o.flow), at: str(o.at), reply: o.reply === true, payload: payload(o.payload, sub(a, 'payload'), issues),
    };
  });
  const steps: AlgoStep[] = asList(raw.steps).map((st, i) => {
    const o = asObj(st);
    const a = sub(sub(top, 'steps'), i);
    checkKeys('step', o, a, issues);
    return {
      id: str(o.id) || `s${i + 1}`, do: str(o.do), code: str(o.code), if: str(o.if), no: o.no ?? null, yes_says: str(o.yes_says),
      no_says: str(o.no_says), calls: strOrNull(o.calls), flow: strOrNull(o.flow), says: str(o.says), end: str(o.end),
      payload: payload(o.payload, sub(a, 'payload'), issues),
    };
  });
  const columns: Column[] = asList(raw.columns).map((c, i) => {
    const o = asObj(c);
    checkKeys('column', o, sub(sub(top, 'columns'), i), issues);
    return { label: str(o.label), means: str(o.means), tone: str(o.tone), marks: strList(o.marks), row: strList(o.row), says: str(o.says) };
  });
  if (raw.loads != null) checkKeys('loads', raw.loads, sub(top, 'loads'), issues);
  const loads = isObj(raw.loads) ? { what: str(raw.loads.what), cmd: str(raw.loads.cmd), size: str(raw.loads.size), when: str(raw.loads.when) } : null;
  const says = dict<string>();
  for (const [k, v] of Object.entries(asObj(raw.says))) says[k] = str(v);
  return {
    sheet: str(raw.sheet), scope: str(raw.scope), kind: str(raw.kind), title: str(raw.title), question: str(raw.question),
    bands, left: side(raw.left, 'left'), right: side(raw.right, 'right'),
    groups: asList(raw.groups).map((g, i) => {
      const o = asObj(g);
      checkKeys('group', o, sub(sub(top, 'groups'), i), issues);
      return { id: str(o.id) || `group${i}`, label: str(o.label), means: str(o.means), marks: strList(o.marks), around: strList(o.around) };
    }),
    callouts: asList(raw.callouts).map((c, i) => {
      checkKeys('callout', c, sub(sub(top, 'callouts'), i), issues);
      const o = asObj(c);
      return { to: str(o.to), side: str(o.side), title: str(o.title), text: str(o.text) };
    }),
    brace: brace ? { over: strList(brace.over), text: str(brace.text), marks: strList(brace.marks ?? brace.mark) } : null,
    show: raw.show === 'all' ? 'all' : strList(raw.show),
    quiet: strList(raw.quiet),
    says,
    notes,
    time: str(raw.time), lanes: strList(raw.lanes), places: places(raw.places, top, issues), hops,
    endpoint: strOrNull(raw.endpoint), route: str(raw.route), loads, steps,
    request: payload(raw.request, sub(top, 'request'), issues), response: payload(raw.response, sub(top, 'response'), issues),
    metric: str(raw.metric), columns,
  };
}

export function sheetParts(s: Sheet): string[] {
  const out: string[] = [];
  s.bands.forEach((b) => b.row.forEach((c) => cellParts(c, out)));
  [...s.left, ...s.right].forEach((c) => out.push(...c.stack));
  out.push(...s.lanes);
  s.columns.forEach((c) => out.push(...c.row));
  if (s.endpoint) out.push(s.endpoint);
  s.steps.forEach((st) => st.calls && out.push(st.calls));
  return out;
}

const rank = (k: string) => {
  const i = KIND_ORDER.indexOf(k);
  return i < 0 ? KIND_ORDER.length : i;
};
export const bySheetOrder = (sheets: Record<string, Sheet>) => (a: string, b: string) =>
  rank(sheets[a]!.kind) - rank(sheets[b]!.kind) || a.localeCompare(b, 'en', { numeric: true });

function readSources(raw: unknown, issues: Issues): Sources | null {
  if (raw == null) return null;
  const a = at('system.yaml', 'sources');
  checkKeys('sources', raw, a, issues);
  const s = asObj(raw);
  const repos = dict<{ repo: string; at: string }>();
  for (const [alias, r] of Object.entries(asObj(s.repos))) {
    const ra = sub(sub(a, 'repos'), alias);
    if (!ALIAS.test(alias)) err(issues, ra, `repo alias "${alias}" should be lower case letters, digits, - or _`);
    checkKeys('source', r, ra, issues);
    const o = asObj(r);
    const commit = str(o.at);
    if (!str(o.repo)) err(issues, sub(ra, 'repo'), 'no repo (host/owner/name)');
    if (typeof o.at === 'number') err(issues, sub(ra, 'at'), 'reads as a number; put the commit in quotes');
    else if (!/^[0-9a-f]{7,40}$/.test(commit)) err(issues, sub(ra, 'at'), `should be the commit it was drawn from (7 to 40 hex digits), not "${commit}"`);
    repos[alias] = { repo: str(o.repo), at: commit };
  }
  const docs = strList(s.docs);
  for (const d of docs) if (!/^https?:\/\//.test(d)) err(issues, sub(a, 'docs'), `"${d}" should be a URL`);
  return { repos, docs };
}

type Context = {
  parts: Record<string, Part>;
  flows: Record<string, Flow>;
  sheets: Record<string, Sheet>;
  scopes: Record<string, string>;
  aliases: Set<string>;
};

function buildRevision(doc: Obj, ctx: Context, file: string, issues: Issues): Revision {
  const top = at(file);
  checkKeys('revision', doc, top, issues);
  const id = str(doc.revision);
  if (!id) err(issues, sub(top, 'revision'), 'no revision id');
  else okId(id, sub(top, 'revision'), issues);
  const scope = str(doc.scope) || 'root';
  if (!has(ctx.scopes, scope)) err(issues, sub(top, 'scope'), `unknown scope "${scope}"`);
  const add = asObj(doc.add);
  checkKeys('revadd', add, sub(top, 'add'), issues);

  const addedParts = dict<Part | null>();
  for (const [pid, p] of Object.entries(asObj(add.parts))) {
    const a = sub(sub(top, 'add.parts'), pid);
    if (!okId(pid, a, issues)) continue;
    if (p == null) {
      if (!has(ctx.parts, pid)) err(issues, a, `is ~, but the drawing has no part "${pid}"`);
      addedParts[pid] = null;
    } else {
      if (has(ctx.parts, pid)) err(issues, a, `the drawing already has "${pid}"; write it as ${pid}: ~`);
      const part = normPart(pid, p, ctx.aliases, a, issues);
      if (!has(ctx.scopes, part.in)) err(issues, sub(a, 'in'), `unknown scope "${part.in}"`);
      addedParts[pid] = part;
    }
  }
  const known = (x: string) => has(ctx.parts, x) || !!addedParts[x];
  const addedFlows = dict<Flow | null>();
  for (const [fid, f] of Object.entries(asObj(add.flows))) {
    const a = sub(sub(top, 'add.flows'), fid);
    if (!okId(fid, a, issues)) continue;
    if (f == null) {
      if (!has(ctx.flows, fid)) err(issues, a, `is ~, but the drawing has no line "${fid}"`);
      addedFlows[fid] = null;
      continue;
    }
    if (has(ctx.flows, fid)) err(issues, a, `the drawing already has "${fid}"; write it as ${fid}: ~`);
    const flow = normFlow(fid, f, ctx.aliases, a, issues);
    for (const e of [...flow.from, flow.to]) if (e && !known(e)) err(issues, a, `names unknown part "${e}"`);
    addedFlows[fid] = flow;
  }
  const knownFlow = (x: string) => has(ctx.flows, x) || !!addedFlows[x];

  const place = dict<Record<string, { band: string; after: string | null; span: number | null }>>();
  for (const [key, raw] of [['add.place', add.place], ['place', doc.place]] as const) {
    for (const [code, list] of Object.entries(asObj(raw))) {
      const sheet = has(ctx.sheets, code) ? ctx.sheets[code] : null;
      if (!sheet) err(issues, sub(sub(top, key), code), `unknown sheet "${code}"`);
      const into = (place[code] ??= dict());
      for (const [pid, where] of Object.entries(asObj(list))) {
        const a = sub(sub(sub(top, key), code), pid);
        checkKeys('placement', where, a, issues);
        const o = asObj(where);
        if (!addedParts[pid]) err(issues, a, 'only a part this revision adds in full may be placed');
        if (sheet && !sheet.bands.some((b) => b.id === str(o.band))) err(issues, sub(a, 'band'), `sheet ${code} has no band "${str(o.band)}"`);
        into[pid] = { band: str(o.band), after: strOrNull(o.after), span: numOrNull(o.span) };
      }
    }
  }

  const change = dict<{ says: string; set: Record<string, string>; pr: number | null }>();
  for (const [cid, c] of Object.entries(asObj(doc.change))) {
    const a = sub(sub(top, 'change'), cid);
    if (!known(cid) && !knownFlow(cid)) err(issues, a, `names unknown part or line "${cid}"`);
    const o = isObj(c) ? c : { says: c };
    if (isObj(c)) checkKeys('change', c, a, issues);
    const set = dict<string>();
    for (const [path, v] of Object.entries(asObj(o.set))) {
      const [head, ...rest] = path.split('.');
      if (!(head === 'facts' && rest.length) && !(SETTABLE.includes(head!) && !rest.length)) {
        err(issues, sub(sub(a, 'set'), path), `a change sets facts.<label>, ${SETTABLE.join(', ')}`);
      }
      set[path] = fmtValue(v);
    }
    change[cid] = { says: str(o.says), set, pr: numOrNull(o.pr) };
  }

  const remove = dict<{ says: string; flow: Flow | null }>();
  for (const [rid, t] of Object.entries(asObj(doc.remove))) {
    const a = sub(sub(top, 'remove'), rid);
    if (isObj(t)) {
      checkKeys('removed', t, a, issues);
      if (t.flow != null) {
        const flow = normFlow(rid, t.flow, ctx.aliases, sub(a, 'flow'), issues);
        for (const e of [...flow.from, flow.to]) if (e && !known(e)) err(issues, sub(a, 'flow'), `names unknown part "${e}"`);
        remove[rid] = { says: str(t.says), flow };
        continue;
      }
    }
    if (!known(rid) && !knownFlow(rid)) err(issues, a, `names unknown "${rid}"`);
    remove[rid] = { says: str(isObj(t) ? t.says : t), flow: null };
  }

  const sheets = dict<{ set: Record<string, unknown>; add: Record<string, unknown[]> }>();
  for (const [code, sp] of Object.entries(asObj(doc.sheets))) {
    const a = sub(sub(top, 'sheets'), code);
    if (!has(ctx.sheets, code)) err(issues, a, `unknown sheet "${code}"`);
    checkKeys('patch', sp, a, issues);
    const o = asObj(sp);
    for (const k of Object.keys(asObj(o.set))) {
      if (!(KEYS.sheet as readonly string[]).includes(k) || ['sheet', 'scope', 'kind'].includes(k)) {
        err(issues, sub(sub(a, 'set'), k), 'a sheet does not have it, or a revision may not change it');
      }
    }
    const addTo = dict<unknown[]>();
    for (const [k, items] of Object.entries(asObj(o.add))) {
      if (!ADDABLE.includes(k)) err(issues, sub(sub(a, 'add'), k), `a revision adds to ${ADDABLE.join(', ')}`);
      addTo[k] = asList(items);
    }
    sheets[code] = { set: asObj(o.set), add: addTo };
  }

  const lines = dict<string>();
  for (const [pid, n] of Object.entries(asObj(doc.lines))) {
    if (!known(pid)) err(issues, sub(sub(top, 'lines'), pid), `names unknown part "${pid}"`);
    lines[pid] = str(n);
  }

  let steps: Revision['steps'] = null;
  if (doc.steps != null) {
    const st = asObj(doc.steps);
    const sa = sub(top, 'steps');
    checkKeys('steps', st, sa, issues);
    const lanes = strList(st.lanes);
    for (const l of lanes) if (!known(l)) err(issues, sub(sa, 'lanes'), `"${l}" is not a part`);
    const hops: StepHop[] = asList(st.hops).map((h, i) => {
      const o = asObj(h);
      const a = sub(sub(sa, 'hops'), i);
      checkKeys('stephop', o, a, issues);
      for (const e of [o.from, o.to, o.on].filter((x) => x != null).map(String)) {
        if (!lanes.includes(e)) err(issues, a, `names "${e}", which is not a lane`);
      }
      if (o.on == null && (o.from == null || o.to == null)) err(issues, a, 'needs from and to, or on');
      if (o.is != null && o.is !== 'added' && o.is !== 'changed') err(issues, sub(a, 'is'), `"${str(o.is)}"; a step is added or changed, or says nothing`);
      return {
        from: strOrNull(o.from), to: strOrNull(o.to), on: strOrNull(o.on), do: str(o.do), says: str(o.says), reply: o.reply === true,
        at: str(o.at), payload: payload(o.payload, sub(a, 'payload'), issues), is: (o.is as StepHop['is']) ?? null, note: str(o.note),
      };
    });
    steps = { title: str(st.title), question: str(st.question), time: str(st.time), lanes, places: places(st.places, sa, issues), hops };
  }

  return {
    id, scope, title: str(doc.title), pr: numOrNull(doc.pr), repo: str(doc.repo), merged: str(doc.merged), date: str(doc.date),
    add: { parts: addedParts, flows: addedFlows }, place, change, remove, sheets, lines, steps,
  };
}

function checkFormat(sys: Obj, issues: Issues): boolean {
  const a = at('system.yaml', 'format');
  if (sys.format == null) {
    err(issues, a, `this drawing has no format; this Plannotator reads format ${FORMAT}. Put "format: ${FORMAT}" at the top of system.yaml`);
    return false;
  }
  if (typeof sys.format !== 'number' || !Number.isInteger(sys.format) || sys.format < 1) {
    err(issues, a, `"${str(sys.format)}" is not a format number; this Plannotator reads format ${FORMAT}`);
    return false;
  }
  if (sys.format > FORMAT) {
    err(issues, at('system.yaml'), `this drawing is format ${sys.format}; this Plannotator reads format ${FORMAT}`);
    return false;
  }
  return true;
}

type SystemPart = Omit<SystemModel, 'sheets' | 'revisions' | 'byScope'>;

function buildSystem(sys: Obj, issues: Issues): SystemPart {
  const top = at('system.yaml');
  checkKeys('system', sys, top, issues);
  const name = str(sys.system);
  if (!name) err(issues, sub(top, 'system'), 'no display name');
  const root = str(sys.root);
  if (!root) err(issues, sub(top, 'root'), "no root (the landing sheet's code)");

  const scopes = dict<string>();
  for (const [k, v] of Object.entries(asObj(sys.scopes))) if (okId(k, sub(sub(top, 'scopes'), k), issues)) scopes[k] = str(v);
  if (!has(scopes, 'root')) err(issues, sub(top, 'scopes'), 'needs root, the landing scope, with its name');
  const sources = readSources(sys.sources, issues);
  const aliases = new Set(Object.keys(sources?.repos ?? {}));
  const watch = strList(sys.watch);

  const wanted: Wanted[] = asList(sys.wanted).map((w, i) => {
    const a = sub(sub(top, 'wanted'), i);
    checkKeys('wanted', w, a, issues);
    const o = asObj(w);
    if (!SHEET_CODE.test(str(o.code))) err(issues, sub(a, 'code'), `"${str(o.code)}" is not a sheet code like L-101`);
    return { code: str(o.code), kind: str(o.kind), question: str(o.question) };
  });

  const parts = dict<Part>();
  if (sys.parts != null && !isObj(sys.parts)) err(issues, sub(top, 'parts'), 'should map each part id to the part');
  const rawParts = asObj(sys.parts);
  for (const [id, p] of Object.entries(rawParts)) {
    const a = sub(sub(top, 'parts'), id);
    if (okId(id, a, issues)) parts[id] = normPart(id, p, aliases, a, issues);
  }
  for (const [id, t] of Object.entries(asObj(sys.stack))) {
    const a = sub(sub(top, 'stack'), id);
    if (!okId(id, a, issues)) continue;
    checkKeys('stack', t, a, issues);
    if (has(parts, id)) {
      err(issues, a, 'has the id of a part');
      continue;
    }
    const o = asObj(t);
    const usedBy = strList(o.used_by);
    for (const u of usedBy) if (!has(parts, u)) err(issues, sub(a, 'used_by'), `unknown part "${u}"`);
    const facts: Obj = {
      ...(o.version != null ? { Version: o.version } : {}),
      ...(usedBy.length ? { 'Used by': usedBy.map((u) => (has(parts, u) ? parts[u]!.name : u)).join(', ') } : {}),
      ...asObj(o.facts),
    };
    const part = normPart(id, {
      name: o.name, kind: 'technology', role: o.for ?? o.role ?? '', marks: o.mark ?? o.marks, wordmark: o.wordmark, facts,
    }, aliases, a, issues);
    part.usedBy = usedBy;
    parts[id] = part;
  }
  const flows = dict<Flow>();
  for (const [id, f] of Object.entries(asObj(sys.flows))) {
    const a = sub(sub(top, 'flows'), id);
    if (!okId(id, a, issues)) continue;
    if (has(parts, id)) err(issues, a, `has the id of a part; a line and a part need different ids`);
    const flow = normFlow(id, f, aliases, a, issues);
    for (const e of [...flow.from, flow.to]) if (e && !has(parts, e)) err(issues, a, `names unknown part "${e}"`);
    for (const key of ['lands', 'leaves'] as const) {
      const inner = flow[key];
      if (inner && !has(parts, inner)) err(issues, sub(a, key), `unknown part "${inner}"`);
    }
    flows[id] = flow;
  }

  // the scope tree: a scope is the inside of the one part that names it with
  // child:, and its parent is that part's own scope. Any depth; never itself.
  const owner = dict<string>();
  for (const [id, p] of Object.entries(parts)) {
    const a = sub(sub(top, 'parts'), id);
    if (!has(scopes, p.in)) err(issues, sub(a, 'in'), `unknown scope "${p.in}"`);
    if (!p.child) continue;
    if (!has(scopes, p.child)) err(issues, sub(a, 'child'), `unknown scope "${p.child}"`);
    else if (p.child === 'root') err(issues, sub(a, 'child'), 'opens root, the landing scope');
    else if (has(owner, p.child)) err(issues, sub(a, 'child'), `scope "${p.child}" is opened by both ${owner[p.child]} and ${id}`);
    else owner[p.child] = id;
  }
  const parentOf = dict<string>();
  for (const sc of Object.keys(scopes)) {
    if (sc === 'root') continue;
    if (!has(owner, sc)) err(issues, sub(sub(top, 'scopes'), sc), `no part opens this scope (a part with child: ${sc})`);
    parentOf[sc] = has(owner, sc) ? parts[owner[sc]!]!.in : 'root';
  }
  for (const sc of Object.keys(parentOf)) {
    const seen = new Set([sc]);
    for (let q = parentOf[sc]; q && q !== 'root' && has(parentOf, q); q = parentOf[q]) {
      if (seen.has(q)) {
        err(issues, sub(sub(top, 'scopes'), sc), 'is inside itself');
        break;
      }
      seen.add(q);
    }
  }
  return { format: FORMAT, name, root, scopes, parentOf, owner, parts, flows, wanted, sources, watch };
}

function checkSheet(s: Sheet, sys: SystemPart, file: string, issues: Issues): void {
  const top = at(file);
  const fileCode = file.slice('sheets/'.length, -'.yaml'.length);
  if (!s.sheet) err(issues, sub(top, 'sheet'), 'no sheet code');
  else {
    if (s.sheet !== fileCode) err(issues, sub(top, 'sheet'), `says ${s.sheet}; the file of sheet ${s.sheet} is sheets/${s.sheet}.yaml`);
    if (!SHEET_CODE.test(s.sheet)) err(issues, sub(top, 'sheet'), `"${s.sheet}" is not a sheet code like L-101`);
  }
  for (const k of ['scope', 'kind', 'title'] as const) if (!s[k]) err(issues, sub(top, k), `no ${k}`);
  if (s.kind && has(KIND_LETTER, s.kind) && s.sheet && s.sheet[0] !== KIND_LETTER[s.kind]) {
    err(issues, sub(top, 'sheet'), `a ${s.kind} sheet's code starts with ${KIND_LETTER[s.kind]}, not ${s.sheet[0]}`);
  }
  if (!s.bands.length && !s.lanes.length && !s.steps.length && !s.columns.length) {
    err(issues, top, 'draws nothing; a sheet needs bands (or lanes, steps or columns)');
  }
  if (s.scope && !has(sys.scopes, s.scope)) err(issues, sub(top, 'scope'), `unknown scope "${s.scope}"`);
  for (const id of sheetParts(s)) if (!has(sys.parts, id)) err(issues, top, `unknown part "${id}"`);
  const flows = sys.flows;
  const bandIds = new Set(s.bands.map((b) => b.id));
  s.hops.forEach((h, i) => {
    const a = sub(sub(top, 'hops'), i);
    for (const e of [h.from, h.to, h.on]) if (e && !s.lanes.includes(e)) err(issues, a, `names "${e}", which is not a lane`);
    if (!h.on && !(h.from && h.to)) err(issues, a, 'needs from and to, or on');
    if (h.flow && !has(flows, h.flow)) err(issues, sub(a, 'flow'), `unknown line "${h.flow}"`);
  });
  s.places.forEach((p, i) => {
    for (const l of p.lanes) if (!s.lanes.includes(l)) err(issues, sub(sub(top, 'places'), i), `names "${l}", which is not a lane`);
  });
  s.steps.forEach((st, i) => {
    if (st.flow && !has(flows, st.flow)) err(issues, sub(sub(sub(top, 'steps'), i), 'flow'), `unknown line "${st.flow}"`);
  });
  if (s.show !== 'all') for (const f of s.show) if (!has(flows, f)) err(issues, sub(top, 'show'), `unknown line "${f}"`);
  for (const f of s.quiet) if (!has(flows, f)) err(issues, sub(top, 'quiet'), `unknown line "${f}"`);
  for (const f of Object.keys(s.says)) if (!has(flows, f)) err(issues, sub(top, 'says'), `unknown line "${f}"`);
  s.callouts.forEach((c, i) => {
    if (!has(sys.parts, c.to)) err(issues, sub(sub(top, 'callouts'), i), `points to unknown part "${c.to}"`);
  });
  s.groups.forEach((g, i) => {
    for (const b of g.around) if (!bandIds.has(b)) err(issues, sub(sub(top, 'groups'), i), `is around unknown band "${b}"`);
  });
  for (const b of s.brace?.over ?? []) if (!bandIds.has(b)) err(issues, sub(top, 'brace'), `is over unknown band "${b}"`);
  for (const c of [...s.left, ...s.right]) if (c.beside && !bandIds.has(c.beside)) err(issues, sub(top, c.side), `column ${c.label} is beside unknown band "${c.beside}"`);
  const local = new Set([...s.hops.map((h) => h.id), ...s.steps.map((st) => st.id)]);
  for (const n of s.notes) {
    if (n.on && !has(sys.parts, n.on) && !has(flows, n.on) && !local.has(n.on)) err(issues, sub(sub(top, 'notes'), n.l), `is on unknown "${n.on}"`);
  }
}

function sortFiles(files: SystemFiles, errors: Issues, warnings: Issues) {
  const usable = dict<string>();
  let total = 0;
  for (const path of Object.keys(files).sort()) total += utf8Bytes(files[path]!);
  if (total > MAX_TOTAL_BYTES) {
    errors.push({ file: '', field: '', message: `the drawing is ${total} bytes; this Plannotator reads at most ${MAX_TOTAL_BYTES} bytes in one drawing` });
    return null;
  }
  for (const path of Object.keys(files).sort()) {
    const text = files[path]!;
    const isDrawing = path === 'system.yaml' || /^(sheets|revisions)\/[^/]+\.yaml$/.test(path);
    if (/\.yml$/.test(path)) {
      errors.push({ file: path, field: '', message: `a drawing file ends in .yaml: rename it ${path.replace(/\.yml$/, '.yaml')}` });
      continue;
    }
    if (!isDrawing) {
      if (/\.yaml$/.test(path)) warnings.push({ file: path, field: '', message: 'not read; a drawing is system.yaml, sheets/<CODE>.yaml and revisions/<id>.yaml' });
      continue;
    }
    const bytes = utf8Bytes(text);
    if (bytes > MAX_FILE_BYTES) {
      errors.push({ file: path, field: '', message: `is ${bytes} bytes; this Plannotator reads at most ${MAX_FILE_BYTES} bytes in one file` });
      continue;
    }
    usable[path] = text;
  }
  return usable;
}

export function loadFiles(files: SystemFiles): LoadResult {
  const errors: Issues = [];
  const warnings: Issues = [];
  if (!Object.keys(files).length) return { model: null, errors, warnings };
  const usable = sortFiles(files, errors, warnings);
  if (!usable) return { model: null, errors, warnings };
  if (!has(usable, 'system.yaml')) {
    if (!errors.some((e) => e.file === 'system.yaml' || e.file === 'system.yml')) errors.push({ file: 'system.yaml', field: '', message: 'is missing' });
    return { model: null, errors, warnings };
  }

  const sysIssues: Issues = [];
  const sysDoc = readYaml('system.yaml', usable['system.yaml']!, sysIssues, warnings);
  if (!sysDoc || !checkFormat(sysDoc, sysIssues)) return { model: null, errors: [...errors, ...sysIssues], warnings };
  const sys = buildSystem(sysDoc, sysIssues);
  if (sysIssues.length) return { model: null, errors: [...errors, ...sysIssues], warnings };

  const sheets = dict<Sheet>();
  const failed = new Set<string>();
  for (const path of Object.keys(usable).filter((p) => p.startsWith('sheets/'))) {
    const own: Issues = [];
    const doc = readYaml(path, usable[path]!, own, warnings);
    const code = path.slice('sheets/'.length, -'.yaml'.length);
    if (doc) {
      const s = normSheet(doc, path, own);
      // the code must match the file name, so no sheet is drawn twice
      checkSheet(s, sys, path, own);
      if (!own.length) {
        sheets[s.sheet] = s;
        continue;
      }
    }
    failed.add(code);
    errors.push(...own);
  }

  const top = at('system.yaml');
  for (const w of sys.wanted) if (has(sheets, w.code)) warnings.push({ file: 'system.yaml', field: 'wanted', message: `sheet ${w.code} is drawn; take it out of wanted` });
  const stillWanted = sys.wanted.some((w) => !has(sheets, w.code));
  if (!has(sheets, sys.root)) {
    if (failed.has(sys.root)) err(errors, sub(top, 'root'), `sheet ${sys.root} did not load (see sheets/${sys.root}.yaml)`);
    else if (!sys.wanted.some((w) => w.code === sys.root)) err(errors, sub(top, 'root'), `${sys.root} is neither drawn nor wanted`);
  } else if (sheets[sys.root]!.scope !== 'root') {
    err(errors, sub(top, 'root'), `${sys.root} is a sheet of scope "${sheets[sys.root]!.scope}", not of root`);
  }
  const within = (sc: string, wantTop: string) => {
    for (let q: string | undefined = sc, n = 0; q && n < 64; q = has(sys.parentOf, q) ? sys.parentOf[q] : undefined, n++) if (q === wantTop) return true;
    return false;
  };
  const drawnIn = (id: string, scopeTop: string) =>
    Object.values(sheets).some((sh) => within(sh.scope || 'root', scopeTop) && sheetParts(sh).includes(id));
  for (const f of Object.values(sys.flows)) {
    for (const [key, ends] of [['lands', [f.to, ...f.from]], ['leaves', f.from]] as const) {
      const inner = f[key];
      if (!inner) continue;
      const a = sub(sub(top, 'flows'), `${f.id}.${key}`);
      const wins = ends.filter((e) => sys.parts[e]?.child);
      if (!wins.length) err(errors, a, 'no end of this line opens a scope');
      else if (!wins.some((e) => drawnIn(inner, sys.parts[e]!.child!))) {
        const issue = { ...a, message: `"${inner}", which no sheet inside ${wins.map((e) => sys.parts[e]!.name).join(' or ')} draws` };
        (stillWanted ? warnings : errors).push(issue);
      }
    }
  }

  const ctx: Context = { parts: sys.parts, flows: sys.flows, sheets, scopes: sys.scopes, aliases: new Set(Object.keys(sys.sources?.repos ?? {})) };
  const revisions = dict<Revision>();
  for (const path of Object.keys(usable).filter((p) => p.startsWith('revisions/'))) {
    const own: Issues = [];
    const doc = readYaml(path, usable[path]!, own, warnings);
    if (doc) {
      const r = buildRevision(doc, ctx, path, own);
      const fileId = path.slice('revisions/'.length, -'.yaml'.length);
      if (r.id && r.id !== fileId) err(own, at(path, 'revision'), `says ${r.id}; the file of revision ${r.id} is revisions/${r.id}.yaml`);
      if (!own.length) {
        revisions[r.id] = r;
        continue;
      }
    }
    errors.push(...own);
  }

  const byScope = dict<string[]>();
  for (const code of Object.keys(sheets).sort(bySheetOrder(sheets))) (byScope[sheets[code]!.scope] ??= []).push(code);
  return { model: { ...sys, byScope, sheets, revisions }, errors, warnings };
}

/** Read one revision (a PR's change or a plan) against a loaded drawing. Refused, naming the field, unless it loads clean. */
export function parseRevision(model: SystemModel, yaml: string): { revision: Revision | null; errors: LoadIssue[] } {
  const errors: Issues = [];
  if (utf8Bytes(yaml) > MAX_FILE_BYTES) {
    return { revision: null, errors: [{ file: 'revision', field: '', message: `is more than ${MAX_FILE_BYTES} bytes` }] };
  }
  const doc = readYaml('revision', yaml, errors, []);
  if (!doc) return { revision: null, errors };
  const ctx: Context = { parts: model.parts, flows: model.flows, sheets: model.sheets, scopes: model.scopes, aliases: new Set(Object.keys(model.sources?.repos ?? {})) };
  const revision = buildRevision(doc, ctx, 'revision', errors);
  return { revision: errors.length ? null : revision, errors };
}
