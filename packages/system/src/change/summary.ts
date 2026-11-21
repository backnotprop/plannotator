// What a change does, in numbers and in one line: the sheet it touches most,
// how many parts it adds, changes and removes, and each part with the files of
// the change it rests on. The card's picture, the tally, the numbered legend
// and the parts list all read it, so they always agree.
import { covers } from '../format/cited.ts';
import { bySheetOrder } from '../format/load.ts';
import type { Cell, Part, Revision, Sheet, SystemModel } from '../format/types.ts';
import { isIgnoredPath, type GateResult } from '../gate/gate.ts';
import { outerTest } from '../layout/common.ts';
import { plural } from '../draw/format.ts';
import type { ChangeIs } from './marks.ts';

/** One file of a pull request: what `git diff --numstat` and `--name-status` say about it. */
export type ChangeFile = { path: string; status?: 'A' | 'M' | 'D' | 'R'; from?: string; additions?: number; deletions?: number };

export type ChangePart = {
  id: string;
  name: string;
  is: ChangeIs;
  /** The PR's files this part cites (a cited folder covers its files), in the PR's order. Never a file the PR did not change. */
  files: string[];
  /** Its line counts: read from its files when the host gives the PR's files, else as the revision writes them ("frame.ts · +532"). */
  lines?: string;
};

export type ChangeSummary = {
  /** The sheet that draws most of the change: where the card's picture and the full view open. */
  sheet: string;
  added: number;
  changed: number;
  /** Removed parts and removed lines. */
  removed: number;
  /** The changed parts, numbered in this order (added, changed, removed): the number on the sheet is the index plus one. */
  parts: ChangePart[];
  /** The lines the change adds, changes or removes. */
  flows: { id: string; says: string; is: ChangeIs }[];
};

/** True for a revision (a PR's change or a plan), false for a gate result. */
export const isRevision = (c: Revision | GateResult): c is Revision => 'add' in c && 'change' in c;

const has = (o: object, k: string) => Object.hasOwn(o, k);
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const cellIds = (c: Cell): string[] => (c.type === 'part' ? [c.id] : c.type === 'stack' ? c.stack.flatMap(cellIds) : []);
const MINUS = '−';

/** The PR's files a part rests on: its cited paths in this repo that cover a changed file. Tests and docs count only when cited by name. */
function filesOf(p: Part | undefined, files: ChangeFile[]): ChangeFile[] {
  if (!p) return [];
  const cited = p.code.filter((c) => c.repo === 'self').map((c) => c.path);
  return files.filter((f) => {
    const paths = f.status === 'R' && f.from ? [f.from, f.path] : [f.path];
    return paths.some((x) => cited.some((c) => (isIgnoredPath(x) ? c === x : covers(c, x))));
  });
}

/** "frame.ts · +532", "inbox.ts and 2 more · +21 −1": the line counts of a part's files. */
export function linesOf(files: ChangeFile[]): string | undefined {
  if (!files.length) return undefined;
  const add = files.reduce((n, f) => n + (f.additions ?? 0), 0);
  const del = files.reduce((n, f) => n + (f.deletions ?? 0), 0);
  const name = base(files[0]!.path) + (files.length > 1 ? ` and ${files.length - 1} more` : '');
  const counts = [add ? `+${add}` : '', del ? `${MINUS}${del}` : ''].filter(Boolean).join(' ');
  return counts ? `${name} · ${counts}` : name;
}

/**
 * What a change does. `files` (the PR's changed files with their counts, when
 * the host has them) names each part's files; without them, a revision's part
 * keeps only the cited files its own line counts name.
 */
export function changeSummary(model: SystemModel, change: Revision | GateResult, files?: ChangeFile[]): ChangeSummary {
  const parts: ChangePart[] = [];
  const flows: ChangeSummary['flows'] = [];
  const partOf = (id: string): Part | undefined => (has(model.parts, id) ? model.parts[id] : undefined);
  const entry = (id: string, is: ChangeIs, p: Part | undefined, written?: string): ChangePart => {
    let mine: string[] = [];
    let lines = written || undefined;
    if (files) {
      // the PR's own files decide: the counts are those of the files the part is credited with, so the two never
      // disagree; the revision's words stand only for a part none of whose cited files the PR changed
      const f = filesOf(p, files);
      mine = f.map((x) => x.path);
      lines = linesOf(f) ?? lines;
    } else if (p && written) {
      // no file list: keep only the cited files the revision's own counts name
      const named = new Set(written.split(/[\s,·]+/).filter(Boolean));
      mine = p.code.filter((c) => c.repo === 'self' && named.has(base(c.path))).map((c) => c.path);
    }
    return { id, name: p?.name || id, is, files: mine, ...(lines ? { lines } : {}) };
  };

  if (isRevision(change)) {
    const r = change;
    for (const [id, p] of Object.entries(r.add.parts)) parts.push(entry(id, 'added', p ?? partOf(id), r.lines[id]));
    const isPart = (id: string) => has(model.parts, id) || !!r.add.parts[id];
    for (const id of Object.keys(r.change)) {
      // a part the change adds is counted once, as added
      if (isPart(id)) { if (!has(r.add.parts, id)) parts.push(entry(id, 'changed', partOf(id), r.lines[id])); }
      else if (has(model.flows, id) || r.add.flows[id]) flows.push({ id, says: (model.flows[id] ?? r.add.flows[id])!.says, is: 'changed' });
    }
    for (const [id, t] of Object.entries(r.remove)) {
      if (t.flow) flows.push({ id, says: t.flow.says || t.says, is: 'removed' });
      else if (has(model.parts, id)) parts.push(entry(id, 'removed', partOf(id)));
      else if (has(model.flows, id)) flows.push({ id, says: model.flows[id]!.says, is: 'removed' });
    }
    for (const [id, f] of Object.entries(r.add.flows)) flows.unshift({ id, says: (f ?? model.flows[id])?.says ?? '', is: 'added' });
  } else {
    for (const id of change.touched.parts) if (has(model.parts, id)) parts.push(entry(id, 'changed', partOf(id)));
    for (const id of change.touched.flows) if (has(model.flows, id)) flows.push({ id, says: model.flows[id]!.says, is: 'changed' });
  }
  const n = (k: ChangeIs) => parts.filter((p) => p.is === k).length;
  return {
    sheet: sheetFor(model, change, parts.map((p) => p.id)),
    added: n('added'), changed: n('changed'),
    removed: n('removed') + flows.filter((f) => f.is === 'removed').length,
    parts, flows,
  };
}

/** The sheet that draws the most changed parts; a banded sheet before a flow sheet, then the drawing's own order. */
function sheetFor(model: SystemModel, change: Revision | GateResult, ids: string[]): string {
  const want = new Set(ids);
  const place = isRevision(change) ? change.place : {};
  let best = '', score = 0;
  for (const code of Object.keys(model.sheets).sort(bySheetOrder(model.sheets))) {
    const s: Sheet = model.sheets[code]!;
    const outer = outerTest(model, s.scope);
    const on = new Set<string>(Object.keys(place[code] ?? {}));
    for (const b of s.bands) for (const c of b.row) cellIds(c).forEach((id) => on.add(id));
    for (const sec of [...s.left, ...s.right]) sec.stack.forEach((id) => on.add(id));
    s.lanes.forEach((id) => on.add(id));
    const hits = [...on].filter((id) => want.has(id) && !(has(model.parts, id) && outer(id))).length;
    const sc = hits * 4 + (hits && s.bands.length ? 2 : 0) + (place[code] ? 1 : 0);
    if (sc > score) { best = code; score = sc; }
  }
  return best || (model.sheets[model.root] ? model.root : Object.keys(model.sheets)[0] ?? '');
}

/** The change in one line: "3 parts added, 5 changed, 1 line removed". */
export function changeWords(s: ChangeSummary): string {
  const gonePart = s.parts.filter((p) => p.is === 'removed').length;
  const goneLine = s.removed - gonePart;
  const out: string[] = [];
  if (s.added) out.push(`${plural(s.added, 'part')} added`);
  if (s.changed) out.push(`${out.length ? s.changed : plural(s.changed, 'part')} changed`);
  if (gonePart) out.push(`${out.length ? gonePart : plural(gonePart, 'part')} removed`);
  if (goneLine) out.push(`${plural(goneLine, 'line')} removed`);
  return out.length ? out.join(', ') : 'No drawn part changed';
}
