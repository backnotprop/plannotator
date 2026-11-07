/**
 * What's changed in the Shape format (approval "shape-whats-changed"). What regresses if these fail:
 * - a board with What's changed is refused, or stored differently from what the agent wrote;
 * - a wrong field is stored instead of named (an agent then never hears what to fix);
 * - an old board without What's changed checks, parts or diffs differently than before;
 * - "since you looked" misses a change to one change, or to a call path.
 */
import { describe, expect, test } from 'bun:test';
import { checkShapeBoard, diffShapeVersions, shapeCitedRefs, shapeParts, SHAPE_VIEWS, type ShapeBoard } from './shape';
import { KETTLE_CHANGED, KETTLE_OLD_BOARD, kettleBoard } from '../../tests/fixtures/shape-whats-changed';

const errorsOf = (board: unknown) => {
  const r = checkShapeBoard(board);
  return r.ok ? [] : r.errors;
};

describe('What\'s changed', () => {
  test('is a view after How it works', () => {
    const ids = SHAPE_VIEWS.map((v) => v.id);
    expect(ids.indexOf('changed')).toBe(ids.indexOf('how') + 1);
  });

  test('a board with it is kept as the agent wrote it', () => {
    const r = checkShapeBoard(kettleBoard());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.views.changed).toEqual(KETTLE_CHANGED);
  });

  test('it alone is a board', () => {
    expect(checkShapeBoard({ title: 'Kettle', claim: 'Built.', views: { changed: KETTLE_CHANGED } }).ok).toBe(true);
  });

  test('each wrong field is named', () => {
    const bad = (change: Record<string, unknown>) => kettleBoard({ items: [{ ...KETTLE_CHANGED.items[0], ...change }] });
    expect(errorsOf(bad({ kind: 'feature' }))).toEqual(['views.changed.items[0].kind: must be one of behaviour, contract, moved, removed, check']);
    expect(errorsOf(bad({ code: ['/etc/passwd:1'] }))[0]).toStartWith('views.changed.items[0].code[0]:');
    expect(errorsOf(bad({ code: ['src/kettle.ts'] }))[0]).toStartWith('views.changed.items[0].code[0]:');
    expect(errorsOf(bad({ step: 0 }))[0]).toStartWith('views.changed.items[0].step:');
    expect(errorsOf(bad({ kind: 'check', was: undefined, now: undefined }))).toEqual(['views.changed.items[0].note: a check needs a note: what to look at, and why']);
    expect(errorsOf(bad({ kind: 'moved', was: undefined, now: undefined }))).toEqual(['views.changed.items[0]: a moved change needs from and to']);
    expect(errorsOf(bad({ kind: 'removed', was: undefined }))).toEqual(['views.changed.items[0].was: a removed change needs was: what is gone']);
    expect(errorsOf(bad({ was: [] }))).toEqual(['views.changed.items[0].was: is empty']);
    // A removed change with a wrong was hears about the was once, not also that it has none.
    expect(errorsOf(bad({ kind: 'removed', was: [], now: undefined }))).toEqual(['views.changed.items[0].was: is empty']);
    expect(errorsOf(bad({ kind: 'removed', was: Array(13).fill('x'), now: undefined }))).toEqual(['views.changed.items[0].was: has 13 entries; at most 12']);
    expect(errorsOf(kettleBoard({ items: [] }))).toEqual(['views.changed.items: is empty: name at least one change']);
    // An id names a part: a change and a call path cannot share one.
    const twice = kettleBoard({ flows: [{ ...KETTLE_CHANGED.flows![0]!, id: KETTLE_CHANGED.items[0]!.id }] });
    expect(errorsOf(twice)).toEqual([`views.changed.flows[0].id: "${KETTLE_CHANGED.items[0]!.id}" is used twice`]);
    const step = kettleBoard({ flows: [{ ...KETTLE_CHANGED.flows![0]!, steps: [{ call: 'boil()', is: 'louder' }] }] });
    expect(errorsOf(step)).toEqual(['views.changed.flows[0].steps[0].is: must be one of new, gone, changed, same']);
  });

  test('a field the board does not draw for that kind is refused, by name', () => {
    const bad = (change: Record<string, unknown>) => kettleBoard({ items: [{ ...KETTLE_CHANGED.items[0], ...change }] });
    expect(errorsOf(bad({ kind: 'check', note: 'Look at the lid.' }))).toEqual([
      'views.changed.items[0].was: is not shown on a check change (it shows its note)',
      'views.changed.items[0].now: is not shown on a check change (it shows its note)',
    ]);
    expect(errorsOf(bad({ kind: 'moved', from: 'a.ts', to: 'b.ts', now: undefined }))).toEqual(['views.changed.items[0].was: is not shown on a moved change (it shows from, to and lines)']);
    expect(errorsOf(bad({ lines: 3 }))).toEqual(['views.changed.items[0].lines: is not shown on a behaviour change (it shows was and now)']);
  });

  test('the same place in code twice is kept once', () => {
    const r = checkShapeBoard(kettleBoard({ items: [{ ...KETTLE_CHANGED.items[0]!, code: ['src/kettle.ts:42', 'src/kettle.ts:42', 'src/kettle.ts:8'] }] }));
    if (!r.ok) throw new Error(r.errors.join('; '));
    expect(r.value.views.changed!.items[0]!.code).toEqual(['src/kettle.ts:42', 'src/kettle.ts:8']);
  });

  test('a call path title cites like any title; words drawn as they are refuse a citation, by name', () => {
    const titled = kettleBoard({ flows: [{ ...KETTLE_CHANGED.flows![0]!, title: 'Water boils [^7]' }] });
    expect(shapeCitedRefs(titled as ShapeBoard).has(7)).toBe(true);
    expect(errorsOf(titled)).toEqual(['refs: the board cites [7] but refs has no entry with that n']);
    const cited = 'shows a [^n] as written: cite a reference in a title, a note, the summary or also';
    expect(errorsOf(kettleBoard({ items: [{ ...KETTLE_CHANGED.items[0]!, was: 'Whistles [^1]' }] }))).toEqual([`views.changed.items[0].was: ${cited}`]);
    expect(errorsOf(kettleBoard({ items: [{ ...KETTLE_CHANGED.items[1]!, now: ['ok', 'then [^1]'] }] }))).toEqual([`views.changed.items[0].now[1]: ${cited}`]);
    const flow = KETTLE_CHANGED.flows![0]!;
    expect(errorsOf(kettleBoard({ flows: [{ ...flow, start: 'At 100 °C [^1]' }] }))).toEqual([`views.changed.flows[0].start: ${cited}`]);
    expect(errorsOf(kettleBoard({ flows: [{ ...flow, steps: [{ call: 'onBoil()', is: 'same', note: 'see [^1]' }] }] }))).toEqual([`views.changed.flows[0].steps[0].note: ${cited}`]);
    expect(errorsOf(kettleBoard({ flows: [{ ...flow, forks: [{ when: 'Lid [^1]' }] }] }))).toEqual([`views.changed.flows[0].forks[0].when: ${cited}`]);
  });

  test('a citation in its words needs its reference', () => {
    const board = kettleBoard({ summary: 'One whistle now [^4].' });
    expect(shapeCitedRefs(board as ShapeBoard).has(4)).toBe(true);
    expect(errorsOf(board)).toEqual(['refs: the board cites [4] but refs has no entry with that n']);
  });

  test('each change and each call path is a part, and a change to one is found', () => {
    const before = checkShapeBoard(kettleBoard());
    const edited = structuredClone(KETTLE_CHANGED);
    edited.items[0]!.now = 'One whistle, then quiet for 5 minutes';
    edited.flows![0]!.steps![0]!.is = 'changed';
    const after = checkShapeBoard(kettleBoard(edited));
    if (!before.ok || !after.ok) throw new Error('fixture');
    const ids = shapeParts(before.value).filter((p) => p.view === 'changed').map((p) => p.id);
    expect(ids).toEqual([...KETTLE_CHANGED.items.map((i) => i.id), ...KETTLE_CHANGED.flows!.map((f) => f.id)]);
    const diff = diffShapeVersions({ n: 1, views: before.value.views, parts: shapeParts(before.value) }, { n: 2, views: after.value.views, parts: shapeParts(after.value) });
    expect(diff.views).toEqual(['changed']);
    expect(diff.changes.map((c) => `${c.view}/${c.id}/${c.kind}`)).toEqual([`changed/${KETTLE_CHANGED.items[0]!.id}/changed`, `changed/${KETTLE_CHANGED.flows![0]!.id}/changed`]);
  });
});

describe('a board without What\'s changed', () => {
  test('checks to exactly what it was', () => {
    const r = checkShapeBoard(KETTLE_OLD_BOARD);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(JSON.stringify(r.value)).toBe(JSON.stringify(KETTLE_OLD_BOARD));
    expect('changed' in r.value.views).toBe(false);
  });

  test('has the parts it had, in their order', () => {
    const r = checkShapeBoard(KETTLE_OLD_BOARD);
    if (!r.ok) throw new Error('fixture');
    expect(shapeParts(r.value).map((p) => `${p.view}/${p.id}`)).toEqual(['header/title', 'header/claim', 'picture/kettle', 'know/know-1']);
  });
});
