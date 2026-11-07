import { describe, expect, test } from 'bun:test';
import { checkShapeBoard } from './shape';
import { checkShapeRun, type ShapeRun } from './shape-run';

const run = (): ShapeRun => ({
  run: 1,
  title: 'rerank',
  lanes: [{ id: 'b1', label: 'batch 1' }, { id: 'merge', label: 'merge' }],
  resources: { label: 'pod', items: [{ id: 'r0', label: 'reranker-0' }] },
  spans: [{ lane: 'b1', on: 'r0', from: 0, to: 30, end: 'ok' }],
  limits: [{ at: 120, label: 'deadline' }],
});

const board = (html: string, runs?: unknown) => ({ title: 't', claim: 'c', views: { how: { html } }, ...(runs ? { runs } : {}) });

describe('checkShapeRun', () => {
  test('a limit past the last span sets the length, and a shorter end is refused', () => {
    const ok = checkShapeRun(run());
    expect(ok.ok && ok.value.end).toBe(120);
    const short = checkShapeRun({ ...run(), end: 100 });
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.errors.join('\n')).toContain('run.end');
  });

  test('every reference is named by its field', () => {
    const bad = checkShapeRun({ ...run(), spans: [{ lane: 'b9', on: 'r7', from: 5, to: 2 }], msgs: [{ from: 'b1', to: 'nope', at: 1 }] });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    const all = bad.errors.join('\n');
    for (const f of ['run.spans[0].lane', 'run.spans[0].on', 'run.spans[0].to', 'run.msgs[0].to']) expect(all).toContain(f);
  });

  test('a state of a resource needs no lane; a span with neither is refused', () => {
    expect(checkShapeRun({ ...run(), spans: [{ on: 'r0', from: 0, to: 9, end: 'open' }] }).ok).toBe(true);
    expect(checkShapeRun({ ...run(), spans: [{ from: 0, to: 9 }] }).ok).toBe(false);
  });

  test('a run opens grouped by resource only when it has resources; any other view is refused', () => {
    const ok = checkShapeRun({ ...run(), view: 'res' });
    expect(ok.ok && ok.value.view).toBe('res');
    const flat = checkShapeRun({ ...run(), resources: undefined, spans: [{ lane: 'b1', from: 0, to: 30 }], view: 'res' });
    expect(flat.ok).toBe(false);
    if (!flat.ok) expect(flat.errors.join('\n')).toContain('run.view');
    for (const view of ['3d', 'gl']) {
      const bad = checkShapeRun({ ...run(), view });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.errors.join('\n')).toContain('run.view');
    }
  });

  test('a field the format does not have is named, not dropped', () => {
    const bad = checkShapeRun({ ...run(), events: [] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join('\n')).toContain('run.events: is not part of a run');
  });
});

describe('a board plays its runs', () => {
  test('a valid run is kept on the board the store saves', () => {
    const r = checkShapeBoard(board('<div data-run="rerank"></div>', { rerank: run() }));
    expect(r.ok && r.value.runs?.rerank?.spans.length).toBe(1);
  });

  test('a drawing that plays a run the board lacks is refused', () => {
    const r = checkShapeBoard(board('<div data-run="rerank"></div>'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toContain('data-run="rerank"');
  });

  test('a run with its own problems is named by them, not also as missing', () => {
    const r = checkShapeBoard(board('<div data-run="rerank"></div>', { rerank: { ...run(), spans: [{ lane: 'zz', from: 0, to: 1 }] } }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join('\n')).toContain('runs.rerank.spans[0].lane');
    expect(r.errors.join('\n')).not.toContain('runs has no');
  });

  test('a drawing that plays a run from its tall layout or its Show more page is checked too', () => {
    const tall = checkShapeBoard({ title: 't', claim: 'c', views: { how: { html: '<p>wide</p>', width: 800, height: 400, tall: { html: '<div data-run="x"></div>' } } } });
    expect(tall.ok).toBe(false);
    if (!tall.ok) expect(tall.errors.join('\n')).toContain('data-run="x"');
    const more = checkShapeBoard({ title: 't', claim: 'c', views: { picture: { html: '<p>p</p>', more: { html: '<div data-run="y"></div>' } } } });
    expect(more.ok).toBe(false);
    if (!more.ok) expect(more.errors.join('\n')).toContain('data-run="y"');
  });

  test('a board holds at most 8 runs, each under a short id', () => {
    const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`r${i}`, run()]));
    const r = checkShapeBoard(board('<p>x</p>', many));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toContain('runs: has 9; at most 8');
    const badId = checkShapeBoard(board('<p>x</p>', { 'no spaces': run() }));
    expect(badId.ok).toBe(false);
    if (!badId.ok) expect(badId.errors.join('\n')).toContain('runs.no spaces');
  });

  test('a name every object has is no run unless the board gives it', () => {
    const r = checkShapeBoard(board('<div data-run="constructor"></div>', { pool: run() }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toContain('runs has no "constructor"');
  });
});
