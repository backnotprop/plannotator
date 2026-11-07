/**
 * A run: what happened, over time, in one part of a board. An agent writes it
 * from a real run (an instrumented test, runtime/trace, OpenTelemetry spans)
 * or by hand for a scenario, and a drawn view plays it where it puts
 * `<div data-run="id"></div>`.
 *
 *   lanes   who does the work (a goroutine, a batch, a task), one row each
 *   on      optional second axis: where the work runs (a pod, a core, a lock)
 *   spans   work on a lane over [from, to], maybe on a resource; or a state of
 *           a resource alone (no lane), such as "breaker open"
 *   msgs    something sent from one lane to another (at, maybe arriving later)
 *   marks   a moment worth a word ("hedge", "cut off")
 *   limits  a time every lane is held to ("deadline 120 ms")
 *
 * Times are numbers in `unit` from the start of the run. Browser-safe, no DOM.
 */
import type { ShapeCheck } from './shape';

export const SHAPE_RUN_VERSION = 1;

export type ShapeRunTone = 'ink' | 'mark' | 'alert' | 'green' | 'amber' | 'grey';
export const SHAPE_RUN_TONES: readonly ShapeRunTone[] = ['ink', 'mark', 'alert', 'green', 'amber', 'grey'];

/** How a span ended. `won`: the first of several answers; `cancelled`: stopped by the run, not by itself. */
export type ShapeRunEnd = 'ok' | 'won' | 'cancelled' | 'error' | 'timeout' | 'open';
export const SHAPE_RUN_ENDS: readonly ShapeRunEnd[] = ['ok', 'won', 'cancelled', 'error', 'timeout', 'open'];

export interface ShapeRunRow {
  id: string;
  label: string;
}

export interface ShapeRunSpan {
  /** The lane doing the work. Absent: a state of the resource `on` itself. */
  lane?: string;
  /** Where it runs. Absent: in the lane's own process (`resources.home`). */
  on?: string;
  from: number;
  to: number;
  label?: string;
  end?: ShapeRunEnd;
  tone?: ShapeRunTone;
}

export interface ShapeRunMsg {
  from: string;
  to: string;
  at: number;
  /** When it arrived. Default: `at`. */
  arrive?: number;
  label?: string;
  tone?: ShapeRunTone;
}

export interface ShapeRunMark {
  at: number;
  lane?: string;
  on?: string;
  label: string;
  tone?: ShapeRunTone;
}

export interface ShapeRunLimit {
  at: number;
  label: string;
  tone?: ShapeRunTone;
}

export interface ShapeRun {
  run: 1;
  title: string;
  /** Default "ms". */
  unit?: string;
  /** Where it was read from: "searchd -demo, query 17 (go test trace)", or "scenario". */
  source?: string;
  /** The run's length. Default: the latest time in it. */
  end?: number;
  /** What one lane is ("batch", "goroutine"). Default "lane". */
  laneLabel?: string;
  /** The first grouping: "lanes" (one row per lane, the default) or "res" (one row per resource; needs resources). */
  view?: 'lanes' | 'res';
  lanes: ShapeRunRow[];
  /** The resource axis: what it is called, the lane's own process, and the resources. */
  resources?: { label: string; home?: string; items: ShapeRunRow[] };
  spans: ShapeRunSpan[];
  msgs?: ShapeRunMsg[];
  marks?: ShapeRunMark[];
  limits?: ShapeRunLimit[];
}

export const SHAPE_RUN_LIMITS = { lanes: 48, resources: 24, spans: 2000, msgs: 2000, marks: 60, limits: 8, label: 90, title: 120, id: 40 } as const;

const ID_RE = /^[A-Za-z0-9_.:-]+$/;
const RUN_KEYS = ['run', 'title', 'unit', 'source', 'end', 'laneLabel', 'view', 'lanes', 'resources', 'spans', 'msgs', 'marks', 'limits'];
const ROW_KEYS = ['id', 'label'];
const RESOURCES_KEYS = ['label', 'home', 'items'];
const SPAN_KEYS = ['lane', 'on', 'from', 'to', 'label', 'end', 'tone'];
const MSG_KEYS = ['from', 'to', 'at', 'arrive', 'label', 'tone'];
const MARK_KEYS = ['at', 'lane', 'on', 'label', 'tone'];
const LIMIT_KEYS = ['at', 'label', 'tone'];
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validate a run. Every problem names its field, the way `checkShapeBoard` does. */
export function checkShapeRun(input: unknown, field = 'run'): ShapeCheck<ShapeRun> {
  const errors: string[] = [];
  const fail = (at: string, why: string) => {
    if (errors.length < 30) errors.push(`${at}: ${why}`);
  };
  if (!isRecord(input)) return { ok: false, errors: [`${field}: must be an object { run: 1, title, lanes, spans }`] };
  if (input.run !== SHAPE_RUN_VERSION) fail(`${field}.run`, `must be ${SHAPE_RUN_VERSION} (the format version)`);
  // A key the format does not know is named, at every level: a typo ("ends" for "end") would otherwise be dropped without a word.
  const only = (v: Record<string, unknown>, keys: readonly string[], at: string, what: string) => {
    for (const key of Object.keys(v)) if (!keys.includes(key)) fail(`${at}.${key}`, `is not part of ${what} (${keys.join(', ')})`);
  };
  only(input, RUN_KEYS, field, 'a run');
  const text = (v: unknown, at: string, max: number, required: boolean): string | undefined => {
    if (v === undefined || v === null) {
      if (required) fail(at, 'is required');
      return undefined;
    }
    if (typeof v !== 'string') return fail(at, 'must be a string'), undefined;
    // An empty optional word is the same as none (a converter that writes "" for no label).
    if (!v.trim()) return required ? (fail(at, 'is empty'), undefined) : undefined;
    if (v.trim().length > max) fail(at, `is ${v.trim().length} characters; at most ${max}`);
    return v.trim();
  };
  const num = (v: unknown, at: string): number | undefined => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return fail(at, 'must be a number ≥ 0 (time from the start of the run)'), undefined;
    return v;
  };
  const tone = (v: unknown, at: string): ShapeRunTone | undefined => {
    if (v === undefined) return undefined;
    if (!SHAPE_RUN_TONES.includes(v as ShapeRunTone)) return fail(at, `must be one of ${SHAPE_RUN_TONES.join(', ')}`), undefined;
    return v as ShapeRunTone;
  };
  const list = (v: unknown, at: string, max: number, required: boolean): unknown[] => {
    if (v === undefined && !required) return [];
    if (!Array.isArray(v)) return fail(at, 'must be a list'), [];
    if (required && !v.length) fail(at, 'needs at least one');
    if (v.length > max) fail(at, `has ${v.length}; at most ${max}`);
    return v.slice(0, max);
  };
  const rows = (v: unknown, at: string, max: number): ShapeRunRow[] => {
    const seen = new Set<string>();
    const out: ShapeRunRow[] = [];
    list(v, at, max, true).forEach((r, i) => {
      if (!isRecord(r)) return fail(`${at}[${i}]`, 'must be { id, label }');
      only(r, ROW_KEYS, `${at}[${i}]`, 'a row');
      const id = typeof r.id === 'string' && ID_RE.test(r.id) && r.id.length <= SHAPE_RUN_LIMITS.id ? r.id : undefined;
      if (!id) return fail(`${at}[${i}].id`, 'must be a short id (letters, digits, _ . : -)');
      if (seen.has(id)) return fail(`${at}[${i}].id`, `"${id}" is used twice`);
      seen.add(id);
      out.push({ id, label: text(r.label, `${at}[${i}].label`, SHAPE_RUN_LIMITS.label, false) ?? id });
    });
    return out;
  };

  const title = text(input.title, `${field}.title`, SHAPE_RUN_LIMITS.title, true);
  const unit = text(input.unit, `${field}.unit`, 12, false);
  const source = text(input.source, `${field}.source`, SHAPE_RUN_LIMITS.label * 2, false);
  const laneLabel = text(input.laneLabel, `${field}.laneLabel`, 30, false);
  let view: ShapeRun['view'];
  if (input.view !== undefined) {
    if (input.view === 'lanes' || input.view === 'res') view = input.view;
    else fail(`${field}.view`, 'must be "lanes" (by lane) or "res" (by resource)');
  }
  const lanes = rows(input.lanes, `${field}.lanes`, SHAPE_RUN_LIMITS.lanes);
  const laneIds = new Set(lanes.map((l) => l.id));
  let resources: ShapeRun['resources'];
  if (input.resources !== undefined) {
    if (!isRecord(input.resources)) fail(`${field}.resources`, 'must be { label, home?, items }');
    else {
      const r = input.resources;
      only(r, RESOURCES_KEYS, `${field}.resources`, 'resources');
      resources = {
        label: text(r.label, `${field}.resources.label`, SHAPE_RUN_LIMITS.label, true) ?? '',
        ...(r.home !== undefined ? { home: text(r.home, `${field}.resources.home`, SHAPE_RUN_LIMITS.label, false) } : {}),
        items: rows(r.items, `${field}.resources.items`, SHAPE_RUN_LIMITS.resources),
      };
    }
  }
  const resIds = new Set((resources?.items ?? []).map((r) => r.id));
  if (view === 'res' && !resIds.size) fail(`${field}.view`, 'is "res", but the run has no resources to group by');
  const laneRef = (v: unknown, at: string, required: boolean) => {
    if (v === undefined && !required) return undefined;
    if (typeof v !== 'string' || !laneIds.has(v)) return fail(at, `must be a lane id (${[...laneIds].slice(0, 6).join(', ')}…)`), undefined;
    return v;
  };
  const resRef = (v: unknown, at: string) => {
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || !resIds.has(v)) return fail(at, resIds.size ? `must be a resource id (${[...resIds].slice(0, 6).join(', ')}…)` : 'needs resources.items to name it'), undefined;
    return v;
  };
  let latest = 0;
  const spans: ShapeRunSpan[] = [];
  list(input.spans, `${field}.spans`, SHAPE_RUN_LIMITS.spans, true).forEach((s, i) => {
    const at = `${field}.spans[${i}]`;
    if (!isRecord(s)) return fail(at, 'must be { lane, on?, from, to, label?, end? }');
    only(s, SPAN_KEYS, at, 'a span');
    const lane = laneRef(s.lane, `${at}.lane`, false);
    const on = resRef(s.on, `${at}.on`);
    if (s.lane === undefined && s.on === undefined) fail(at, 'needs a lane, or an on (a state of a resource)');
    const from = num(s.from, `${at}.from`);
    const to = num(s.to, `${at}.to`);
    if (from !== undefined && to !== undefined && to < from) fail(`${at}.to`, `ends (${to}) before it starts (${from})`);
    if (s.end !== undefined && !SHAPE_RUN_ENDS.includes(s.end as ShapeRunEnd)) fail(`${at}.end`, `must be one of ${SHAPE_RUN_ENDS.join(', ')}`);
    const label = text(s.label, `${at}.label`, SHAPE_RUN_LIMITS.label, false);
    const t = tone(s.tone, `${at}.tone`);
    if (from === undefined || to === undefined) return;
    latest = Math.max(latest, to);
    spans.push({ ...(lane ? { lane } : {}), ...(on ? { on } : {}), from, to, ...(label ? { label } : {}), ...(s.end ? { end: s.end as ShapeRunEnd } : {}), ...(t ? { tone: t } : {}) });
  });
  const msgs: ShapeRunMsg[] = [];
  list(input.msgs, `${field}.msgs`, SHAPE_RUN_LIMITS.msgs, false).forEach((m, i) => {
    const at = `${field}.msgs[${i}]`;
    if (!isRecord(m)) return fail(at, 'must be { from, to, at, arrive?, label? }');
    only(m, MSG_KEYS, at, 'a msg');
    const from = laneRef(m.from, `${at}.from`, true);
    const to = laneRef(m.to, `${at}.to`, true);
    const t = num(m.at, `${at}.at`);
    const arrive = m.arrive === undefined ? undefined : num(m.arrive, `${at}.arrive`);
    if (t !== undefined && arrive !== undefined && arrive < t) fail(`${at}.arrive`, 'is before it was sent');
    const label = text(m.label, `${at}.label`, SHAPE_RUN_LIMITS.label, false);
    const tn = tone(m.tone, `${at}.tone`);
    if (!from || !to || t === undefined) return;
    latest = Math.max(latest, arrive ?? t);
    msgs.push({ from, to, at: t, ...(arrive !== undefined ? { arrive } : {}), ...(label ? { label } : {}), ...(tn ? { tone: tn } : {}) });
  });
  const marks: ShapeRunMark[] = [];
  list(input.marks, `${field}.marks`, SHAPE_RUN_LIMITS.marks, false).forEach((m, i) => {
    const at = `${field}.marks[${i}]`;
    if (!isRecord(m)) return fail(at, 'must be { at, lane? or on?, label }');
    only(m, MARK_KEYS, at, 'a mark');
    const t = num(m.at, `${at}.at`);
    const lane = laneRef(m.lane, `${at}.lane`, false);
    const on = resRef(m.on, `${at}.on`);
    const label = text(m.label, `${at}.label`, SHAPE_RUN_LIMITS.label, true);
    const tn = tone(m.tone, `${at}.tone`);
    if (t === undefined || !label) return;
    latest = Math.max(latest, t);
    marks.push({ at: t, ...(lane ? { lane } : {}), ...(on ? { on } : {}), label, ...(tn ? { tone: tn } : {}) });
  });
  const limits: ShapeRunLimit[] = [];
  list(input.limits, `${field}.limits`, SHAPE_RUN_LIMITS.limits, false).forEach((m, i) => {
    const at = `${field}.limits[${i}]`;
    if (!isRecord(m)) return fail(at, 'must be { at, label }');
    only(m, LIMIT_KEYS, at, 'a limit');
    const t = num(m.at, `${at}.at`);
    const label = text(m.label, `${at}.label`, SHAPE_RUN_LIMITS.label, true);
    const tn = tone(m.tone, `${at}.tone`);
    if (t === undefined || !label) return;
    latest = Math.max(latest, t);
    limits.push({ at: t, label, ...(tn ? { tone: tn } : {}) });
  });
  let end = latest;
  if (input.end !== undefined) {
    const e = num(input.end, `${field}.end`);
    if (e !== undefined && e < latest) fail(`${field}.end`, `is ${e}, but the run has times up to ${latest}`);
    else if (e !== undefined) end = e;
  }
  if (end <= 0 && !errors.length) fail(field, 'has no time in it: every from, to and at is 0');
  if (errors.length || !title) return { ok: false, errors: errors.length ? errors : [`${field}.title: is required`] };
  return {
    ok: true,
    value: {
      run: 1,
      title,
      ...(unit ? { unit } : {}),
      ...(source ? { source } : {}),
      end,
      ...(laneLabel ? { laneLabel } : {}),
      ...(view ? { view } : {}),
      lanes,
      ...(resources ? { resources } : {}),
      spans,
      ...(msgs.length ? { msgs } : {}),
      ...(marks.length ? { marks } : {}),
      ...(limits.length ? { limits } : {}),
    },
  };
}

/** The run ids a drawn view's HTML plays (`data-run="id"`). No DOM. */
export function shapeHtmlRuns(html: string): string[] {
  return shapeHtmlAttr(html, 'data-run');
}

/** The values of one attribute on the tags of some HTML: inside a tag only, never in a comment or in text (a code sample that shows the attribute). */
export function shapeHtmlAttr(html: string, attr: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<[A-Za-z][^>]*?\\s${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'gi');
  for (const m of html.replace(/<!--[\s\S]*?-->/g, '').matchAll(re)) out.push((m[1] ?? m[2] ?? m[3] ?? '').trim());
  return out;
}
