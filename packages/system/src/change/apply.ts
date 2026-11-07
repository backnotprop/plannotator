// A change on the drawing: a pull request's revision, a plan, or the gate's
// touched parts (a PR with no revision yet). Each view of it is a model of its
// own, made once and kept:
//
// - After: the drawing with the change applied. A part a revision adds in full
//   (an open PR, a plan) is placed where it says; a part written `~` (a merged
//   PR kept in the repo) is already there. Removed parts and lines stay drawn,
//   struck in grey; a removed line the drawing no longer has is drawn from the
//   old ends the revision carries. Each touched part shows its line counts.
// - Before: the drawing as it was. What the change added is not drawn, what it
//   removed is drawn plain, and nothing is marked.
// - Steps: the revision's one sequence, laid out as a flow sheet of its own.
//
// A gate result has no Before and no Steps: its After marks the touched parts
// and lines amber and changes nothing else.
import type { AlgoStep, Cell, Flow, Hop, Part, Revision, Sheet, SystemModel } from '../format/types.ts';
import type { GateResult } from '../gate/gate.ts';
import { setMarks, type ChangeMarks } from './marks.ts';
import { changeSummary, isRevision, type ChangeFile } from './summary.ts';

/** The view of a change: the drawing before it, after it, or its one sequence. */
export type ChangeView = 'before' | 'after' | 'steps';

/** The Steps view's sheet code. Never a sheet of the drawing: it is in no scope's list. */
export const STEPS_CODE = '~steps';

const KEPT = new WeakMap<SystemModel, WeakMap<object, Map<string, SystemModel>>>();
const has = (o: object, k: string) => Object.hasOwn(o, k);
const cellIds = (c: Cell): string[] => (c.type === 'part' ? [c.id] : c.type === 'stack' ? c.stack.flatMap(cellIds) : []);

function drawnOn(s: Sheet): Set<string> {
  const out = new Set<string>();
  for (const b of s.bands) for (const c of b.row) cellIds(c).forEach((id) => out.add(id));
  for (const sec of [...s.left, ...s.right]) sec.stack.forEach((id) => out.add(id));
  s.lanes.forEach((id) => out.add(id));
  return out;
}

/**
 * The drawing with a change on it, in one view. Kept per drawing, change and
 * view (and the files given), so asking again is free and its layouts are kept.
 * `files`: the PR's changed files with their counts, when the host has them;
 * a part's line counts are read from them when the revision does not give any.
 */
export function applyChange(model: SystemModel, change: Revision | GateResult, view: ChangeView, files?: ChangeFile[]): SystemModel {
  let byChange = KEPT.get(model);
  if (!byChange) KEPT.set(model, (byChange = new WeakMap()));
  let m = byChange.get(change);
  if (!m) byChange.set(change, (m = new Map()));
  const key = view + (files ? ':' + files.length + ':' + files.map((f) => f.path).join('\n').length : '');
  const hit = m.get(key);
  if (hit) return hit;
  const out = !isRevision(change) ? gateAfter(model, change, files) : view === 'before' ? before(model, change) : view === 'steps' ? steps(model, change) : after(model, change, files);
  m.set(key, out);
  return out;
}

/** True when a revision has a sequence to show as Steps. */
export const hasSteps = (change: Revision | GateResult | null | undefined): boolean => !!change && isRevision(change) && !!change.steps?.hops.length;

// ---------------------------------------------------------------- a gate result
function gateAfter(model: SystemModel, g: GateResult, files?: ChangeFile[]): SystemModel {
  const sum = changeSummary(model, g, files);
  const parts = { ...model.parts };
  const marks: ChangeMarks = { parts: {}, flows: {}, hops: {} };
  sum.parts.forEach((p, i) => {
    marks.parts[p.id] = { is: 'changed', n: i + 1, lines: p.lines ?? null };
    if (p.lines && parts[p.id]) parts[p.id] = { ...parts[p.id]!, sub: p.lines };
  });
  for (const f of g.touched.flows) if (has(model.flows, f)) marks.flows[f] = 'changed';
  const out = { ...model, parts };
  setMarks(out, marks);
  return out;
}

// ---------------------------------------------------------------- several open PRs at rest
/** One open PR's touched parts, as the gate found them, and the label it shows by the parts ("PR 2848"). */
export type Touch = { label: string; change: GateResult };

const TOUCHED = new WeakMap<SystemModel, Map<string, SystemModel>>();

/**
 * The words a touched part carries: every label when one or two PRs touch it
 * ("PR 2848 · PR 2851"), the first and how many more past two ("PR 2848 +2"),
 * so a part's second line stays short and the sheet keeps its shape.
 */
export function touchWords(labels: string[]): string {
  return labels.length <= 2 ? labels.join(' · ') : `${labels[0]} +${labels.length - 1}`;
}

/**
 * The drawing at rest with several open PRs' touched parts on it: amber only,
 * as the gate draws one, each touched part labelled with the PRs that touch it
 * (in the order given) in place of its second line. No numbers, no counts.
 * Kept per drawing and per content, so a host's new array of the same touches
 * is the same model. With nothing touched it is the drawing itself.
 */
export function applyTouches(model: SystemModel, touches: Touch[]): SystemModel {
  const byPart = new Map<string, string[]>();
  const flows = new Set<string>();
  for (const t of touches) {
    for (const id of t.change.touched.parts) {
      if (!has(model.parts, id)) continue;
      const l = byPart.get(id) ?? [];
      if (!l.includes(t.label)) l.push(t.label);
      byPart.set(id, l);
    }
    for (const id of t.change.touched.flows) if (has(model.flows, id)) flows.add(id);
  }
  if (!byPart.size && !flows.size) return model;
  const key = JSON.stringify([[...byPart], [...flows]]);
  let kept = TOUCHED.get(model);
  if (!kept) TOUCHED.set(model, (kept = new Map()));
  const hit = kept.get(key);
  if (hit) return hit;
  const parts = { ...model.parts };
  const marks: ChangeMarks = { parts: {}, flows: {}, hops: {} };
  for (const [id, labels] of byPart) {
    const words = touchWords(labels);
    marks.parts[id] = { is: 'changed', n: 0, lines: words, who: labels };
    parts[id] = { ...parts[id]!, sub: words };
  }
  for (const id of flows) marks.flows[id] = 'changed';
  const out = { ...model, parts };
  setMarks(out, marks);
  kept.set(key, out);
  return out;
}

// ---------------------------------------------------------------- before
function before(model: SystemModel, r: Revision): SystemModel {
  // a `~` part or line is in the drawing already (a merged PR): before the PR it was not there
  const parts = { ...model.parts };
  for (const [id, p] of Object.entries(r.add.parts)) if (p == null) delete parts[id];
  const flows = { ...model.flows };
  for (const [id, f] of Object.entries(r.add.flows)) if (f == null) delete flows[id];
  // a removed line the drawing no longer has is drawn from its old ends
  const gone: string[] = [];
  for (const [id, t] of Object.entries(r.remove)) if (t.flow && !has(flows, id)) { flows[id] = t.flow; gone.push(id); }
  const sheets = withLines(model.sheets, flows, gone, parts);
  return { ...model, parts, flows, sheets };
}

// ---------------------------------------------------------------- after
function after(model: SystemModel, r: Revision, files?: ChangeFile[]): SystemModel {
  const parts: Record<string, Part> = { ...model.parts };
  const flows: Record<string, Flow> = { ...model.flows };
  const merged = !!r.merged;
  for (const [id, p] of Object.entries(r.add.parts)) if (p) parts[id] = p;
  for (const [id, f] of Object.entries(r.add.flows)) if (f) flows[id] = f;
  // an open PR or a plan writes the changed values; a merged PR's drawing already has them
  if (!merged) {
    for (const [id, c] of Object.entries(r.change)) {
      if (!has(parts, id) || !Object.keys(c.set).length) continue;
      const q: Part = { ...parts[id]!, facts: parts[id]!.facts.slice() };
      for (const [path, v] of Object.entries(c.set)) {
        const [head, ...rest] = path.split('.');
        if (head === 'facts' && rest.length) {
          const k = rest.join('.');
          const i = q.facts.findIndex(([x]) => x === k);
          if (i >= 0) q.facts[i] = [k, v];
          else q.facts.push([k, v]);
        } else if (head === 'role' || head === 'sub' || head === 'name') q[head] = v;
      }
      parts[id] = q;
    }
  }
  const gone: string[] = [];
  for (const [id, t] of Object.entries(r.remove)) if (t.flow && !has(flows, id)) { flows[id] = t.flow; gone.push(id); }

  const sum = changeSummary(model, r, files);
  const marks: ChangeMarks = { parts: {}, flows: {}, hops: {} };
  sum.parts.forEach((p, i) => {
    marks.parts[p.id] = { is: p.is, n: i + 1, lines: p.is === 'removed' ? null : p.lines ?? null };
    // the line counts read where the part's second line was
    if (p.is !== 'removed' && p.lines && parts[p.id]) parts[p.id] = { ...parts[p.id]!, sub: p.lines };
  });
  for (const id of Object.keys(r.add.flows)) if (has(flows, id)) marks.flows[id] = 'added';
  for (const id of Object.keys(r.change)) if (!has(parts, id) && has(flows, id)) marks.flows[id] = 'changed';
  for (const id of Object.keys(r.remove)) if (has(flows, id) && !has(model.parts, id)) marks.flows[id] = 'removed';
  // a line into or out of a removed part goes with it
  for (const f of Object.values(flows)) if ([...f.from, f.to].some((e) => marks.parts[e]?.is === 'removed')) marks.flows[f.id] = 'removed';

  // the sheets: placed parts, the lines the change adds or removes, a sheet's own patch
  const added = Object.entries(r.add.flows).filter(([, f]) => !!f).map(([id]) => id);
  let sheets: Record<string, Sheet> = {};
  for (const [code, s0] of Object.entries(model.sheets)) {
    let s = s0;
    const place = r.place[code];
    if (place && Object.keys(place).length) {
      const bands = s.bands.map((b) => ({ ...b, row: b.row.slice() }));
      for (const [id, at] of Object.entries(place)) {
        const b = bands.find((x) => x.id === at.band);
        if (!b) continue;
        const i = b.row.findIndex((c) => c.type === 'part' && c.id === at.after);
        const cell: Cell = { type: 'part', id, span: at.span };
        // a placed part takes a free gap after its neighbour first, so the others keep their places
        const gap = b.row.findIndex((c, j) => c.type === 'gap' && j > i);
        if (gap >= 0) b.row.splice(gap, 1, cell);
        else b.row.splice(i + 1, 0, cell);
      }
      s = { ...s, bands };
    }
    const patch = r.sheets[code];
    if (patch) s = patched(code, s, patch, marks);
    sheets[code] = s;
  }
  sheets = withLines(sheets, flows, [...added, ...gone], parts);
  const out = { ...model, parts, flows, sheets };
  setMarks(out, marks);
  return out;
}

/** Shows each of `ids` on every sheet that lists its lines and draws an end of it. */
function withLines(sheets: Record<string, Sheet>, flows: Record<string, Flow>, ids: string[], parts: Record<string, Part>): Record<string, Sheet> {
  if (!ids.length) return sheets;
  const out: Record<string, Sheet> = {};
  for (const [code, s] of Object.entries(sheets)) {
    if (s.show === 'all') { out[code] = s; continue; }
    const on = drawnOn(s);
    const more = ids.filter((id) => !s.show.includes(id) && [...flows[id]!.from, flows[id]!.to].some((e) => on.has(e) && has(parts, e)));
    out[code] = more.length ? { ...s, show: [...s.show, ...more] } : s;
  }
  return out;
}

const str = (v: unknown) => (v == null ? '' : String(v));
const strOrNull = (v: unknown) => (v == null ? null : String(v));
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** A sheet's own patch: `set` replaces keys; `add` puts hops or steps in, after a named one or at the end, marked added. */
function patched(code: string, s: Sheet, patch: Revision['sheets'][string], marks: ChangeMarks): Sheet {
  const out = { ...s } as Sheet & Record<string, unknown>;
  for (const [k, v] of Object.entries(patch.set)) out[k] = v;
  const hops = (patch.add.hops ?? []).map(obj);
  if (hops.length) {
    const list = out.hops.slice();
    hops.forEach((o, i) => {
      const h: Hop = {
        id: str(o.id) || `add${i + 1}`, from: strOrNull(o.from), to: strOrNull(o.to), on: strOrNull(o.on), do: str(o.do), says: str(o.says),
        flow: strOrNull(o.flow), at: str(o.at), reply: o.reply === true, payload: null,
      };
      const at = o.after != null ? list.findIndex((x) => x.id === str(o.after)) : -1;
      if (at >= 0) list.splice(at + 1, 0, h);
      else list.push(h);
      marks.hops[`${code}.${h.id}`] = 'added';
    });
    out.hops = list;
  }
  const steps = (patch.add.steps ?? []).map(obj);
  if (steps.length) {
    const list = out.steps.slice();
    steps.forEach((o, i) => {
      const st: AlgoStep = {
        id: str(o.id) || `add${i + 1}`, do: str(o.do), code: str(o.code), if: str(o.if), no: o.no ?? null, yes_says: str(o.yes_says), no_says: str(o.no_says),
        calls: strOrNull(o.calls), flow: strOrNull(o.flow), says: str(o.says), end: str(o.end), payload: null,
      };
      const at = o.after != null ? list.findIndex((x) => x.id === str(o.after)) : -1;
      if (at >= 0) list.splice(at + 1, 0, st);
      else list.push(st);
      marks.hops[`${code}.${st.id}`] = 'added';
    });
    out.steps = list;
  }
  return out;
}

// ---------------------------------------------------------------- steps
function steps(model: SystemModel, r: Revision): SystemModel {
  const base = after(model, r);
  const st = r.steps;
  if (!st) return base;
  // the lanes are the parts as they read, without their line counts: the hops carry the change
  const parts = { ...base.parts };
  for (const id of st.lanes) if (has(model.parts, id)) parts[id] = model.parts[id]!;
  const marks: ChangeMarks = { parts: {}, flows: {}, hops: {} };
  const hops: Hop[] = st.hops.map((h, i) => {
    const id = `s${i + 1}`;
    if (h.is) marks.hops[`${STEPS_CODE}.${id}`] = h.is;
    return { id, from: h.from, to: h.to, on: h.on, do: h.do, says: h.says, flow: null, at: String(i + 1), reply: h.reply, payload: h.payload };
  });
  const sheet: Sheet = {
    sheet: STEPS_CODE, scope: 'root', kind: 'flow', title: st.title || r.title, question: st.question, bands: [], left: [], right: [], groups: [],
    callouts: [], brace: null, show: [], quiet: [], says: {}, notes: [], time: st.time || 'in order', lanes: st.lanes, places: st.places, hops,
    endpoint: null, route: '', loads: null, steps: [], request: null, response: null, metric: '', columns: [],
  };
  const out = { ...base, parts, sheets: { ...base.sheets, [STEPS_CODE]: sheet } };
  setMarks(out, marks);
  return out;
}
