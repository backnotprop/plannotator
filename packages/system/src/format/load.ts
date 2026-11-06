// Format 1: reads a drawing's files into a model. system.yaml holds each fact
// once (parts, lines, the stack); sheets/<CODE>.yaml are views; revisions/
// are changes. The loader checks every reference, rejects coordinates, unknown
// keys and the keys format 1 dropped, and refuses any other format number.
import {
  ADDABLE, COORDS, KEYS, KIND_LETTER, KIND_ORDER, MOVES, REMOVED, SETTABLE, type EntryKind,
} from './keys.ts';
import {
  FORMAT, type AlgoStep, type Band, type Cell, type CodeRef, type Column, type Flow, type Hop, type LoadResult, type Part,
  type Payload, type Place, type Revision, type Sheet, type SideSection, type Sources, type StepHop, type SystemFiles,
  type SystemModel, type Wanted,
} from './types.ts';
import { readYaml } from './yaml.ts';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const asObj = (v: unknown): Obj => (isObj(v) ? v : {});
const asList = (v: unknown): unknown[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const str = (v: unknown): string => (v == null ? '' : String(v));
const strOrNull = (v: unknown): string | null => (v == null || v === '' ? null : String(v));
const strList = (v: unknown): string[] => asList(v).filter((x) => x != null).map(String);
const numOrNull = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

const numberFormat = new Intl.NumberFormat('en-US');
/** A value from YAML as text: numbers get separators (1284003 reads 1,284,003); a leading run of five or more digits too. */
export const fmtValue = (v: unknown): string => {
  if (typeof v === 'number') return Number.isFinite(v) ? numberFormat.format(v) : String(v);
  if (v == null) return '';
  return String(v).replace(/^(\d{5,})(?=\s|$)/, (m) => numberFormat.format(Number(m)));
};

const SHEET_CODE = /^[A-Z]-\d+$/;
const ALIAS = /^[a-z][a-z0-9_-]*$/;

function checkKeys(kind: EntryKind, obj: unknown, where: string, errors: string[]): void {
  if (!isObj(obj)) return;
  const allowed = KEYS[kind] as readonly string[];
  for (const k of Object.keys(obj)) {
    // a coordinate is reported once, by the lint
    if (allowed.includes(k) || COORDS.has(k)) continue;
    if (REMOVED[k]) errors.push(`${where}: "${k}" is not in format 1 (${REMOVED[k]})`);
    else errors.push(`${where}: unknown key "${k}" on a ${kind}${obj[k] === null ? ' (an unquoted comma inside { } splits a text; quote it)' : ''}`);
  }
}

/** Reads `path`, `self:path` or `<alias>:path`. A path is relative to its repo's root. */
function codeRef(raw: unknown, note: unknown, aliases: Set<string>, where: string, errors: string[]): CodeRef | null {
  let text = str(raw).trim();
  let repo = 'self';
  const m = /^([a-z][a-z0-9_-]*):(.+)$/.exec(text);
  if (m) {
    repo = m[1]!;
    text = m[2]!.trim();
    if (repo !== 'self' && !aliases.has(repo)) {
      errors.push(`${where}: "${raw}" names the repo "${repo}", which sources.repos does not list`);
      return null;
    }
  }
  const path = text.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!path) {
    errors.push(`${where}: an empty code path`);
    return null;
  }
  if (path.startsWith('/') || path.startsWith('~') || /^[A-Za-z]:[\\/]/.test(path)) {
    errors.push(`${where}: "${raw}" is not a path in a repo; cite it relative to the repo's root`);
    return null;
  }
  if (path.split('/').includes('..')) {
    errors.push(`${where}: "${raw}" climbs out of the repo with ..`);
    return null;
  }
  return { repo, path, note: str(note) };
}

function normPart(id: string, raw: unknown, aliases: Set<string>, where: string, errors: string[]): Part {
  const p = asObj(raw);
  checkKeys('part', p, where, errors);
  const code: CodeRef[] = [];
  if (p.code != null) {
    if (!isObj(p.code)) errors.push(`${where}: code should map each file path to what it does for this part`);
    else for (const [path, note] of Object.entries(p.code)) {
      const ref = codeRef(path, note, aliases, `${where} code`, errors);
      if (ref) code.push(ref);
    }
  }
  if (p.facts != null && !isObj(p.facts)) errors.push(`${where}: facts should map a label to a value`);
  if (p.card != null && !isObj(p.card)) errors.push(`${where}: card should be a map`);
  const card = isObj(p.card) ? { ...p.card, ...(p.card.scale != null ? { scale: fmtValue(p.card.scale) } : {}) } : null;
  return {
    id,
    in: str(p.in) || 'root',
    // a part with no name shows its id
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

function normFlow(id: string, raw: unknown, aliases: Set<string>, where: string, errors: string[]): Flow {
  const f = asObj(raw);
  checkKeys('flow', f, where, errors);
  const moves = f.moves == null ? null : str(f.moves);
  if (moves != null && !(MOVES as readonly string[]).includes(moves)) errors.push(`${where}: moves "${moves}" is not ${MOVES.join(', ')}`);
  if (f.from == null || f.to == null) errors.push(`${where}: a line needs from and to`);
  const code: Flow['code'] = { from: null, to: null };
  if (f.code != null) {
    if (!isObj(f.code)) errors.push(`${where}: code should be { from: <path>, to: <path> }`);
    else {
      checkKeys('flowcode', f.code, `${where} code`, errors);
      if (f.code.from != null) code.from = codeRef(f.code.from, 'from', aliases, `${where} code`, errors);
      if (f.code.to != null) code.to = codeRef(f.code.to, 'to', aliases, `${where} code`, errors);
    }
  }
  return {
    id,
    from: strList(f.from),
    to: str(f.to),
    says: str(f.says),
    carries: str(f.carries),
    code,
    lands: strOrNull(f.lands),
    leaves: strOrNull(f.leaves),
    both: f.both === true,
    moves: moves as Flow['moves'],
  };
}

/** A row token: "api", "api 5", "~", "~ 2", or a nested list (a stack of parts sharing one cell). */
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

function payload(raw: unknown, where: string, errors: string[]): Payload | null {
  if (raw == null) return null;
  checkKeys('payload', raw, where, errors);
  const p = asObj(raw);
  return {
    name: str(p.name), title: str(p.title), lines: strList(p.lines),
    changed: asList(p.changed).map(Number).filter(Number.isFinite), by: str(p.by),
  };
}

function places(raw: unknown, where: string, errors: string[]): Place[] {
  return asList(raw).map((c, i) => {
    checkKeys('place', c, `${where} place ${str(asObj(c).label) || i + 1}`, errors);
    const p = asObj(c);
    return { label: str(p.label), means: str(p.means), tone: str(p.tone), marks: strList(p.marks), lanes: strList(p.lanes) };
  });
}

function normSheet(raw: Obj, where: string, errors: string[]): Sheet {
  checkKeys('sheet', raw, where, errors);
  const bands: Band[] = asList(raw.bands).map((b, i) => {
    const o = asObj(b);
    checkKeys('band', o, `${where} band ${str(o.id) || i + 1}`, errors);
    if (o.split != null) checkKeys('split', o.split, `${where} band ${str(o.id) || i + 1} split`, errors);
    const row: Cell[] = [];
    for (const tok of asList(o.row)) {
      const c = parseCell(tok);
      if (c.type === 'bad') errors.push(`${where}: band ${str(o.id) || i + 1} has an unreadable cell "${c.text}"`);
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
      checkKeys('side', o, `${where} ${s} column ${str(o.label) || i + 1}`, errors);
      return {
        id: str(o.id) || `${s}${i}`, side: s, label: str(o.label), means: str(o.means), tone: str(o.tone),
        marks: strList(o.marks), beside: strOrNull(o.beside), stack: strList(o.stack),
      };
    });
  const brace = isObj(raw.brace) ? raw.brace : null;
  if (brace) checkKeys('brace', brace, `${where} brace`, errors);
  const notes = Object.entries(asObj(raw.notes)).map(([l, n]) => {
    checkKeys('note', n, `${where} note ${l}`, errors);
    return { l, on: str(asObj(n).on), text: str(asObj(n).text) };
  });
  const hops: Hop[] = asList(raw.hops).map((h, i) => {
    const o = asObj(h);
    const w = `${where} hop ${str(o.id) || i + 1}`;
    checkKeys('hop', o, w, errors);
    return {
      id: str(o.id) || `h${i + 1}`, from: strOrNull(o.from), to: strOrNull(o.to), on: strOrNull(o.on), do: str(o.do),
      says: str(o.says), flow: strOrNull(o.flow), at: str(o.at), reply: o.reply === true, payload: payload(o.payload, `${w} payload`, errors),
    };
  });
  const steps: AlgoStep[] = asList(raw.steps).map((st, i) => {
    const o = asObj(st);
    const w = `${where} step ${str(o.id) || i + 1}`;
    checkKeys('step', o, w, errors);
    return {
      id: str(o.id) || `s${i + 1}`, do: str(o.do), code: str(o.code), if: str(o.if), no: o.no ?? null, yes_says: str(o.yes_says),
      no_says: str(o.no_says), calls: strOrNull(o.calls), flow: strOrNull(o.flow), says: str(o.says), end: str(o.end),
      payload: payload(o.payload, `${w} payload`, errors),
    };
  });
  const columns: Column[] = asList(raw.columns).map((c, i) => {
    const o = asObj(c);
    checkKeys('column', o, `${where} column ${str(o.label) || i + 1}`, errors);
    return { label: str(o.label), means: str(o.means), tone: str(o.tone), marks: strList(o.marks), row: strList(o.row), says: str(o.says) };
  });
  if (raw.loads != null) checkKeys('loads', raw.loads, `${where} loads`, errors);
  const loads = isObj(raw.loads) ? { what: str(raw.loads.what), cmd: str(raw.loads.cmd), size: str(raw.loads.size), when: str(raw.loads.when) } : null;
  return {
    sheet: str(raw.sheet), scope: str(raw.scope), kind: str(raw.kind), title: str(raw.title), question: str(raw.question),
    bands, left: side(raw.left, 'left'), right: side(raw.right, 'right'),
    groups: asList(raw.groups).map((g, i) => {
      const o = asObj(g);
      checkKeys('group', o, `${where} group ${str(o.label) || i + 1}`, errors);
      return { id: str(o.id) || `group${i}`, label: str(o.label), means: str(o.means), marks: strList(o.marks), around: strList(o.around) };
    }),
    callouts: asList(raw.callouts).map((c, i) => {
      checkKeys('callout', c, `${where} callout ${i + 1}`, errors);
      const o = asObj(c);
      return { to: str(o.to), side: str(o.side), title: str(o.title), text: str(o.text) };
    }),
    brace: brace ? { over: strList(brace.over), text: str(brace.text), marks: strList(brace.marks ?? brace.mark) } : null,
    show: raw.show === 'all' ? 'all' : strList(raw.show),
    quiet: strList(raw.quiet),
    says: Object.fromEntries(Object.entries(asObj(raw.says)).map(([k, v]) => [k, str(v)])),
    notes,
    time: str(raw.time), lanes: strList(raw.lanes), places: places(raw.places, where, errors), hops,
    endpoint: strOrNull(raw.endpoint), route: str(raw.route), loads, steps,
    request: payload(raw.request, `${where} request`, errors), response: payload(raw.response, `${where} response`, errors),
    metric: str(raw.metric), columns,
  };
}

/** Every part a sheet places: its bands, side columns, lanes, landscape columns, endpoint and the parts its steps call. */
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
/** Pivot order: logical first, conceptual last, any other kind after the known ones, then by code. */
export const bySheetOrder = (sheets: Record<string, Sheet>) => (a: string, b: string) =>
  rank(sheets[a]!.kind) - rank(sheets[b]!.kind) || a.localeCompare(b, 'en', { numeric: true });

function readSources(raw: unknown, errors: string[]): Sources | null {
  if (raw == null) return null;
  const where = 'system.yaml sources';
  checkKeys('sources', raw, where, errors);
  const s = asObj(raw);
  const repos: Sources['repos'] = {};
  for (const [alias, r] of Object.entries(asObj(s.repos))) {
    if (!ALIAS.test(alias)) errors.push(`${where}: repo alias "${alias}" should be lower case letters, digits, - or _`);
    checkKeys('source', r, `${where} repo ${alias}`, errors);
    const o = asObj(r);
    const at = str(o.at);
    if (!str(o.repo)) errors.push(`${where} repo ${alias}: no repo (host/owner/name)`);
    if (!/^[0-9a-f]{7,40}$/.test(at)) errors.push(`${where} repo ${alias}: at should be the commit it was drawn from (7 to 40 hex digits), not "${at}"`);
    repos[alias] = { repo: str(o.repo), at };
  }
  const docs = strList(s.docs);
  for (const d of docs) if (!/^https?:\/\//.test(d)) errors.push(`${where}: doc "${d}" should be a URL`);
  return { repos, docs };
}

type Context = {
  parts: Record<string, Part>;
  flows: Record<string, Flow>;
  sheets: Record<string, Sheet>;
  scopes: Record<string, string>;
  aliases: Set<string>;
};

/** Reads one revision against a drawing. Pushes errors; returns the revision even when some failed. */
function buildRevision(doc: Obj, ctx: Context, where: string, errors: string[]): Revision {
  checkKeys('revision', doc, where, errors);
  const id = str(doc.revision);
  if (!id) errors.push(`${where}: no revision id`);
  const scope = str(doc.scope) || 'root';
  if (!ctx.scopes[scope]) errors.push(`${where}: unknown scope "${scope}"`);
  const add = asObj(doc.add);
  checkKeys('revadd', add, `${where} add`, errors);

  const addedParts: Revision['add']['parts'] = {};
  for (const [pid, p] of Object.entries(asObj(add.parts))) {
    if (p == null) {
      if (!ctx.parts[pid]) errors.push(`${where}: add parts ${pid} is ~, but the drawing has no part "${pid}"`);
      addedParts[pid] = null;
    } else {
      if (ctx.parts[pid]) errors.push(`${where}: add parts ${pid}: the drawing already has "${pid}"; write it as ${pid}: ~`);
      const part = normPart(pid, p, ctx.aliases, `${where} add part ${pid}`, errors);
      if (!ctx.scopes[part.in]) errors.push(`${where}: add part ${pid} is in unknown scope "${part.in}"`);
      addedParts[pid] = part;
    }
  }
  const known = (x: string) => !!ctx.parts[x] || !!addedParts[x];
  const addedFlows: Revision['add']['flows'] = {};
  for (const [fid, f] of Object.entries(asObj(add.flows))) {
    if (f == null) {
      if (!ctx.flows[fid]) errors.push(`${where}: add flows ${fid} is ~, but the drawing has no line "${fid}"`);
      addedFlows[fid] = null;
      continue;
    }
    if (ctx.flows[fid]) errors.push(`${where}: add flows ${fid}: the drawing already has "${fid}"; write it as ${fid}: ~`);
    const flow = normFlow(fid, f, ctx.aliases, `${where} add flow ${fid}`, errors);
    for (const e of [...flow.from, flow.to]) if (e && !known(e)) errors.push(`${where}: add flow ${fid} names unknown part "${e}"`);
    addedFlows[fid] = flow;
  }
  const knownFlow = (x: string) => !!ctx.flows[x] || !!addedFlows[x];

  const place: Revision['place'] = {};
  const placeRaw = { ...asObj(add.place), ...asObj(doc.place) };
  for (const [code, list] of Object.entries(placeRaw)) {
    const sheet = ctx.sheets[code];
    if (!sheet) errors.push(`${where}: place names unknown sheet "${code}"`);
    place[code] = {};
    for (const [pid, at] of Object.entries(asObj(list))) {
      const w = `${where} place ${code} ${pid}`;
      checkKeys('placement', at, w, errors);
      const o = asObj(at);
      if (!addedParts[pid]) errors.push(`${w}: only a part this revision adds in full may be placed`);
      if (sheet && !sheet.bands.some((b) => b.id === str(o.band))) errors.push(`${w}: sheet ${code} has no band "${str(o.band)}"`);
      place[code]![pid] = { band: str(o.band), after: strOrNull(o.after), span: numOrNull(o.span) };
    }
  }

  const change: Revision['change'] = {};
  for (const [cid, c] of Object.entries(asObj(doc.change))) {
    if (!known(cid) && !knownFlow(cid)) errors.push(`${where}: change names unknown part or line "${cid}"`);
    const o = isObj(c) ? c : { says: c };
    if (isObj(c)) checkKeys('change', c, `${where} change ${cid}`, errors);
    const set: Record<string, string> = {};
    for (const [path, v] of Object.entries(asObj(o.set))) {
      const [head, ...rest] = path.split('.');
      if (!(head === 'facts' && rest.length) && !(SETTABLE.includes(head!) && !rest.length)) {
        errors.push(`${where}: change ${cid} sets "${path}"; a change sets facts.<label>, ${SETTABLE.join(', ')}`);
      }
      set[path] = fmtValue(v);
    }
    change[cid] = { says: str(o.says), set, pr: numOrNull(o.pr) };
  }

  const remove: Revision['remove'] = {};
  for (const [rid, t] of Object.entries(asObj(doc.remove))) {
    if (isObj(t)) {
      checkKeys('removed', t, `${where} remove ${rid}`, errors);
      if (t.flow != null) {
        const flow = normFlow(rid, t.flow, ctx.aliases, `${where} remove ${rid} flow`, errors);
        for (const e of [...flow.from, flow.to]) if (e && !known(e)) errors.push(`${where}: remove ${rid} flow names unknown part "${e}"`);
        remove[rid] = { says: str(t.says), flow };
        continue;
      }
    }
    if (!known(rid) && !knownFlow(rid)) errors.push(`${where}: remove names unknown "${rid}"`);
    remove[rid] = { says: str(isObj(t) ? t.says : t), flow: null };
  }

  const sheets: Revision['sheets'] = {};
  for (const [code, sp] of Object.entries(asObj(doc.sheets))) {
    if (!ctx.sheets[code]) errors.push(`${where}: patches unknown sheet "${code}"`);
    checkKeys('patch', sp, `${where} sheets ${code}`, errors);
    const o = asObj(sp);
    for (const k of Object.keys(asObj(o.set))) {
      if (!(KEYS.sheet as readonly string[]).includes(k) || ['sheet', 'scope', 'kind'].includes(k)) {
        errors.push(`${where}: sheets ${code} sets "${k}", which a sheet does not have or a revision may not change`);
      }
    }
    const addTo: Record<string, unknown[]> = {};
    for (const [k, items] of Object.entries(asObj(o.add))) {
      if (!ADDABLE.includes(k)) errors.push(`${where}: sheets ${code} adds to "${k}"; a revision adds to ${ADDABLE.join(', ')}`);
      addTo[k] = asList(items);
    }
    sheets[code] = { set: asObj(o.set), add: addTo };
  }

  const lines: Record<string, string> = {};
  for (const [pid, n] of Object.entries(asObj(doc.lines))) {
    if (!known(pid)) errors.push(`${where}: lines names unknown part "${pid}"`);
    lines[pid] = str(n);
  }

  let steps: Revision['steps'] = null;
  if (doc.steps != null) {
    const st = asObj(doc.steps);
    checkKeys('steps', st, `${where} steps`, errors);
    const lanes = strList(st.lanes);
    for (const l of lanes) if (!known(l)) errors.push(`${where}: steps lane "${l}" is not a part`);
    const hops: StepHop[] = asList(st.hops).map((h, i) => {
      const o = asObj(h);
      const w = `${where} step ${i + 1}`;
      checkKeys('stephop', o, w, errors);
      for (const e of [o.from, o.to, o.on].filter((x) => x != null).map(String)) {
        if (!lanes.includes(e)) errors.push(`${w} names "${e}", which is not a lane`);
      }
      if (o.on == null && (o.from == null || o.to == null)) errors.push(`${w} needs from and to, or on`);
      if (o.is != null && o.is !== 'added' && o.is !== 'changed') errors.push(`${w} is "${str(o.is)}"; a step is added or changed, or says nothing`);
      return {
        from: strOrNull(o.from), to: strOrNull(o.to), on: strOrNull(o.on), do: str(o.do), says: str(o.says), reply: o.reply === true,
        at: str(o.at), payload: payload(o.payload, `${w} payload`, errors), is: (o.is as StepHop['is']) ?? null, note: str(o.note),
      };
    });
    steps = { title: str(st.title), question: str(st.question), time: str(st.time), lanes, places: places(st.places, `${where} steps`, errors), hops };
  }

  return {
    id, scope, title: str(doc.title), pr: numOrNull(doc.pr), repo: str(doc.repo), merged: str(doc.merged), date: str(doc.date),
    add: { parts: addedParts, flows: addedFlows }, place, change, remove, sheets, lines, steps,
  };
}

function checkFormat(sys: Obj, errors: string[]): boolean {
  if (sys.format == null) {
    errors.push(`system.yaml: this drawing has no format; this Plannotator reads format ${FORMAT}. Put "format: ${FORMAT}" at the top of system.yaml`);
    return false;
  }
  const n = Number(sys.format);
  if (!Number.isInteger(n) || n < 1) {
    errors.push(`system.yaml: format "${str(sys.format)}" is not a format number; this Plannotator reads format ${FORMAT}`);
    return false;
  }
  if (n > FORMAT) {
    errors.push(`system.yaml: this drawing is format ${n}; this Plannotator reads format ${FORMAT}`);
    return false;
  }
  return true;
}

/** Load a drawing from its files. No files at all means no drawing: model null and no errors. */
export function loadFiles(files: SystemFiles): LoadResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const paths = Object.keys(files).sort();
  if (!paths.length) return { model: null, errors, warnings };
  const sysText = files['system.yaml'];
  if (sysText == null) return { model: null, errors: ['system.yaml is missing'], warnings };
  const sys = readYaml('system.yaml', sysText, errors, warnings);
  if (!sys) return { model: null, errors, warnings };
  if (!checkFormat(sys, errors)) return { model: null, errors, warnings };
  checkKeys('system', sys, 'system.yaml', errors);

  const name = str(sys.system);
  if (!name) errors.push('system.yaml: no system (the display name)');
  const scopes = Object.fromEntries(Object.entries(asObj(sys.scopes)).map(([k, v]) => [k, str(v)]));
  if (!scopes.root) errors.push('system.yaml: scopes needs root, the landing scope, with its name');
  const sources = readSources(sys.sources, errors);
  const aliases = new Set(Object.keys(sources?.repos ?? {}));
  const watch = strList(sys.watch);

  const wanted: Wanted[] = asList(sys.wanted).map((w, i) => {
    checkKeys('wanted', w, `system.yaml wanted ${i + 1}`, errors);
    const o = asObj(w);
    if (!SHEET_CODE.test(str(o.code))) errors.push(`system.yaml wanted ${i + 1}: "${str(o.code)}" is not a sheet code like L-101`);
    return { code: str(o.code), kind: str(o.kind), question: str(o.question) };
  });

  // parts, then the stack (each entry a part of kind technology), then lines
  const parts: Record<string, Part> = {};
  if (sys.parts != null && !isObj(sys.parts)) errors.push('system.yaml: parts should map each part id to the part');
  for (const [id, p] of Object.entries(asObj(sys.parts))) parts[id] = normPart(id, p, aliases, `system.yaml part ${id}`, errors);
  for (const [id, t] of Object.entries(asObj(sys.stack))) {
    const where = `system.yaml stack ${id}`;
    checkKeys('stack', t, where, errors);
    if (parts[id]) {
      errors.push(`${where}: has the id of a part`);
      continue;
    }
    const o = asObj(t);
    const usedBy = strList(o.used_by);
    for (const u of usedBy) if (!asObj(sys.parts)[u]) errors.push(`${where}: used by unknown part "${u}"`);
    const facts: Obj = {
      ...(o.version != null ? { Version: o.version } : {}),
      ...(usedBy.length ? { 'Used by': usedBy.map((u) => parts[u]?.name || u).join(', ') } : {}),
      ...asObj(o.facts),
    };
    const part = normPart(id, {
      name: o.name, kind: 'technology', role: o.for ?? o.role ?? '', marks: o.mark ?? o.marks, wordmark: o.wordmark, facts,
    }, aliases, where, errors);
    part.usedBy = usedBy;
    parts[id] = part;
  }
  const flows: Record<string, Flow> = {};
  for (const [id, f] of Object.entries(asObj(sys.flows))) flows[id] = normFlow(id, f, aliases, `system.yaml flow ${id}`, errors);
  for (const f of Object.values(flows)) {
    for (const e of [...f.from, f.to]) if (e && !parts[e]) errors.push(`system.yaml flow ${f.id}: names unknown part "${e}"`);
  }

  // sheets
  const sheets: Record<string, Sheet> = {};
  for (const path of paths.filter((p) => p.startsWith('sheets/'))) {
    if (!path.endsWith('.yaml')) continue;
    const doc = readYaml(path, files[path]!, errors, warnings);
    if (!doc) continue;
    const s = normSheet(doc, path, errors);
    const fileCode = path.slice('sheets/'.length, -'.yaml'.length);
    if (!s.sheet) {
      errors.push(`${path}: no sheet code`);
      continue;
    }
    if (s.sheet !== fileCode) errors.push(`${path}: says sheet ${s.sheet}; the file of sheet ${s.sheet} is sheets/${s.sheet}.yaml`);
    if (sheets[s.sheet]) errors.push(`${path}: sheet ${s.sheet} is drawn twice`);
    if (!SHEET_CODE.test(s.sheet)) errors.push(`${path}: "${s.sheet}" is not a sheet code like L-101`);
    for (const k of ['scope', 'kind', 'title'] as const) if (!s[k]) errors.push(`${path}: no ${k}`);
    const letter = KIND_LETTER[s.kind];
    if (letter && s.sheet[0] !== letter) errors.push(`${path}: a ${s.kind} sheet's code starts with ${letter}, not ${s.sheet[0]}`);
    if (!s.bands.length && !s.lanes.length && !s.steps.length && !s.columns.length) {
      errors.push(`${path}: draws nothing; a sheet needs bands (or lanes, steps or columns)`);
    }
    sheets[s.sheet] = s;
  }
  for (const w of wanted) if (sheets[w.code]) warnings.push(`system.yaml wanted: sheet ${w.code} is drawn; take it out of wanted`);
  const root = str(sys.root);
  if (!root) errors.push('system.yaml: no root (the landing sheet\'s code)');
  else if (!sheets[root] && !wanted.some((w) => w.code === root)) errors.push(`system.yaml: root ${root} is neither drawn nor wanted`);
  else if (sheets[root] && sheets[root]!.scope !== 'root') errors.push(`system.yaml: root ${root} is a sheet of scope "${sheets[root]!.scope}", not of root`);

  // the scope tree: a scope is the inside of the one part that names it with
  // child:, and its parent is that part's own scope. Any depth; never itself.
  const owner: Record<string, string> = {};
  for (const [id, p] of Object.entries(parts)) {
    if (!scopes[p.in]) errors.push(`system.yaml part ${id}: in unknown scope "${p.in}"`);
    if (!p.child) continue;
    if (!scopes[p.child]) errors.push(`system.yaml part ${id}: opens unknown scope "${p.child}"`);
    else if (p.child === 'root') errors.push(`system.yaml part ${id}: opens root, the landing scope`);
    else if (owner[p.child]) errors.push(`system.yaml: scope "${p.child}" is opened by both ${owner[p.child]} and ${id}`);
    else owner[p.child] = id;
  }
  const parentOf: Record<string, string> = {};
  for (const sc of Object.keys(scopes)) if (sc !== 'root') parentOf[sc] = owner[sc] ? parts[owner[sc]!]!.in : 'root';
  for (const sc of Object.keys(parentOf)) {
    const seen = new Set([sc]);
    for (let q = parentOf[sc]; q && q !== 'root'; q = parentOf[q]) {
      if (seen.has(q)) {
        errors.push(`system.yaml: scope "${sc}" is inside itself`);
        parentOf[sc] = 'root';
        break;
      }
      seen.add(q);
    }
  }
  const within = (sc: string, top: string) => {
    for (let q: string | undefined = sc, n = 0; q && n < 64; q = parentOf[q], n++) if (q === top) return true;
    return false;
  };

  // what each sheet names
  for (const s of Object.values(sheets)) {
    const w = `sheets/${s.sheet}.yaml`;
    if (s.scope && !scopes[s.scope]) errors.push(`${w}: unknown scope "${s.scope}"`);
    const cells = sheetParts(s);
    for (const id of cells) if (!parts[id]) errors.push(`${w}: unknown part "${id}"`);
    const bandIds = new Set(s.bands.map((b) => b.id));
    for (const h of s.hops) {
      for (const e of [h.from, h.to, h.on]) if (e && !s.lanes.includes(e)) errors.push(`${w}: hop ${h.id} names "${e}", which is not a lane`);
      if (!h.on && !(h.from && h.to)) errors.push(`${w}: hop ${h.id} needs from and to, or on`);
      if (h.flow && !flows[h.flow]) errors.push(`${w}: hop ${h.id} cites unknown line "${h.flow}"`);
    }
    for (const p of s.places) for (const l of p.lanes) if (!s.lanes.includes(l)) errors.push(`${w}: place ${p.label} names "${l}", which is not a lane`);
    for (const st of s.steps) if (st.flow && !flows[st.flow]) errors.push(`${w}: step ${st.id} cites unknown line "${st.flow}"`);
    if (s.show !== 'all') for (const f of s.show) if (!flows[f]) errors.push(`${w}: shows unknown line "${f}"`);
    for (const f of s.quiet) if (!flows[f]) errors.push(`${w}: quiet names unknown line "${f}"`);
    for (const f of Object.keys(s.says)) if (!flows[f]) errors.push(`${w}: says rewords unknown line "${f}"`);
    for (const c of s.callouts) if (!parts[c.to]) errors.push(`${w}: a callout points to unknown part "${c.to}"`);
    for (const g of s.groups) for (const b of g.around) if (!bandIds.has(b)) errors.push(`${w}: group ${g.label} is around unknown band "${b}"`);
    for (const b of s.brace?.over ?? []) if (!bandIds.has(b)) errors.push(`${w}: the brace is over unknown band "${b}"`);
    for (const c of [...s.left, ...s.right]) if (c.beside && !bandIds.has(c.beside)) errors.push(`${w}: column ${c.label} is beside unknown band "${c.beside}"`);
    const local = new Set([...s.hops.map((h) => h.id), ...s.steps.map((st) => st.id)]);
    for (const n of s.notes) {
      if (n.on && !parts[n.on] && !flows[n.on] && !local.has(n.on)) errors.push(`${w}: note ${n.l} is on unknown "${n.on}"`);
    }
  }

  // lands: the part a line reaches inside a window; leaves: the same for the
  // from end. That part must be drawn on a sheet of the window's scope or of a
  // scope inside it.
  const drawnIn = (id: string, top: string) =>
    Object.values(sheets).some((sh) => within(sh.scope || 'root', top) && sheetParts(sh).includes(id));
  for (const f of Object.values(flows)) {
    for (const [key, ends] of [['lands', [f.to, ...f.from]], ['leaves', f.from]] as const) {
      const inner = f[key];
      if (!inner) continue;
      const wins = ends.filter((e) => parts[e]?.child);
      if (!wins.length) errors.push(`system.yaml flow ${f.id}: has ${key} but no end of it opens a scope`);
      else if (!wins.some((e) => drawnIn(inner, parts[e]!.child!))) {
        errors.push(`system.yaml flow ${f.id}: ${key} "${inner}", which no sheet inside ${wins.map((e) => parts[e]!.name).join(' or ')} draws`);
      }
    }
  }

  // revisions
  const ctx: Context = { parts, flows, sheets, scopes, aliases };
  const revisions: Record<string, Revision> = {};
  for (const path of paths.filter((p) => p.startsWith('revisions/'))) {
    if (!path.endsWith('.yaml')) continue;
    const doc = readYaml(path, files[path]!, errors, warnings);
    if (!doc) continue;
    const r = buildRevision(doc, ctx, path, errors);
    const fileId = path.slice('revisions/'.length, -'.yaml'.length);
    if (r.id && r.id !== fileId) errors.push(`${path}: says revision ${r.id}; the file of revision ${r.id} is revisions/${r.id}.yaml`);
    if (revisions[r.id]) errors.push(`${path}: revision ${r.id} is written twice`);
    revisions[r.id] = r;
  }
  for (const path of paths) {
    if (path === 'system.yaml' || path.startsWith('sheets/') || path.startsWith('revisions/')) continue;
    if (path.endsWith('.yaml') || path.endsWith('.yml')) warnings.push(`${path}: not read; a drawing is system.yaml, sheets/<CODE>.yaml and revisions/<id>.yaml`);
  }

  const order = Object.keys(sheets).sort(bySheetOrder(sheets));
  const byScope: Record<string, string[]> = {};
  for (const code of order) (byScope[sheets[code]!.scope || 'root'] ||= []).push(code);
  if (errors.length) return { model: null, errors, warnings };
  return {
    model: {
      format: FORMAT, name, root, scopes, parentOf, owner, byScope, parts, flows, sheets, revisions, wanted, sources, watch,
    },
    errors,
    warnings,
  };
}

/** Read one revision (a PR's change or a plan) against a loaded drawing. */
export function parseRevision(model: SystemModel, yaml: string): { revision: Revision | null; errors: string[] } {
  const errors: string[] = [];
  // a split bracket in a revision is drawn as written; only errors refuse it
  const doc = readYaml('revision', yaml, errors, []);
  if (!doc) return { revision: null, errors };
  const aliases = new Set(Object.keys(model.sources?.repos ?? {}));
  const revision = buildRevision(doc, { parts: model.parts, flows: model.flows, sheets: model.sheets, scopes: model.scopes, aliases }, 'revision', errors);
  return { revision: errors.length ? null : revision, errors };
}
