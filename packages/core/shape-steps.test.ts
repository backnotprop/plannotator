import { describe, expect, test } from 'bun:test';
import { checkShapeBoard } from './shape';
import { checkShapeSteps, type ShapeSteps } from './shape-steps';

const sort = (): ShapeSteps => ({
  steps: 1,
  title: 'sort',
  code: { lang: 'go', lines: ['for i := 1; i < n; i++ {', '  a[j+1] = a[j]', '}'] },
  show: 'array',
  frames: [
    { line: 1, say: 'Start.', array: [3, 1, 2], cells: { done: [0] }, ptr: { i: 1, j: -1 } },
    { line: 2, say: 'Shift 3 right.', array: [3, 3, 2], cells: { moved: [1] } },
  ],
});
const graph = (): ShapeSteps => ({
  steps: 1,
  title: 'bfs',
  code: { lines: ['q.push(s)'] },
  show: 'graph',
  graph: { nodes: [{ id: 'A', x: 0, y: 50 }, { id: 'B', x: 100, y: 50 }], edges: [{ from: 'A', to: 'B', w: 3 }] },
  frames: [{ line: 1, say: 'Start at A.', nodes: { now: ['A'] }, edges: { look: [['B', 'A']] }, tags: { A: 0, B: null } }],
});
const errorsOf = (v: unknown) => {
  const r = checkShapeSteps(v);
  return r.ok ? '' : r.errors.join('\n');
};

describe('checkShapeSteps', () => {
  test('a frame pointing past the code, or at an index past the array, is named by its field', () => {
    const s = sort();
    s.frames[1]!.line = 9;
    s.frames[0]!.cells = { look: [5] };
    const all = errorsOf(s);
    expect(all).toContain('steps.frames[1].line');
    expect(all).toContain('steps.frames[0].cells.look[0]');
  });

  test('a pointer may sit one past either end of the array, no further', () => {
    expect(checkShapeSteps(sort()).ok).toBe(true);
    const s = sort();
    s.frames[0]!.ptr = { j: -2 };
    expect(errorsOf(s)).toContain('steps.frames[0].ptr.j');
  });

  test('an unknown role is refused and the roles are listed', () => {
    const s = sort() as any;
    s.frames[0].cells = { highlighted: [0] };
    expect(errorsOf(s)).toContain('steps.frames[0].cells.highlighted: is not a role; use look, now');
  });

  test('an undirected edge can be lit either way round; an edge not in the graph is refused', () => {
    expect(checkShapeSteps(graph()).ok).toBe(true);
    const directed = graph();
    directed.graph!.directed = true;
    expect(errorsOf(directed)).toContain('steps.frames[0].edges.look[0]');
  });

  test('a surface is not a step-through here, and a field the format does not have is named', () => {
    expect(errorsOf({ ...sort(), show: 'surface' })).toContain('steps.show');
    expect(errorsOf({ ...sort(), view: 'gl' })).toContain('steps.view: is not part of a step-through');
    const s = sort() as any;
    s.frames[0].highlight = [0];
    expect(errorsOf(s)).toContain('steps.frames[0].highlight: is not part of a frame');
  });
});

describe('a board plays its step-throughs', () => {
  const board = (html: string, steps?: unknown) => ({ title: 't', claim: 'c', views: { how: { html } }, ...(steps ? { steps } : {}) });
  test('a valid step-through is kept on the board the store saves', () => {
    const r = checkShapeBoard(board('<div data-steps="sort"></div>', { sort: sort() }));
    expect(r.ok && r.value.steps?.sort?.frames.length).toBe(2);
  });
  test('a drawing that plays a missing step-through is refused once, by name', () => {
    const r = checkShapeBoard(board('<div data-steps="nope"></div>'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.filter((e) => e.includes('data-steps="nope"'))).toHaveLength(1);
    const own = checkShapeBoard(board('<div data-steps="sort"></div>', { sort: { ...sort(), frames: [] } }));
    if (!own.ok) expect(own.errors.join('\n')).not.toContain('steps has no');
  });
  test('rows: each box role lines up with a box, and a bad role or an overlong box is named', () => {
    const rows = (): ShapeSteps => ({
      steps: 1,
      title: 'hash map',
      code: { lines: ['put(k, v)'] },
      show: 'rows',
      rowsJoin: 'arrow',
      frames: [{ line: 1, say: 'Put "cat" in bucket 1.', rows: [{ label: '0', items: [] }, { label: '1', items: ['dog', 'cat'], role: 'look', roles: [null, 'moved'] }] }],
    });
    const ok = checkShapeSteps(rows());
    expect(ok.ok && ok.value.frames[0]!.rows![1]!.roles).toEqual([null, 'moved']);
    const s = rows();
    s.frames[0]!.rows![1]!.roles = [null, 'moved', 'done'];
    s.frames[0]!.rows![0]!.items = ['a-key-far-too-long'];
    const all = errorsOf(s);
    expect(all).toContain('steps.frames[0].rows[1].roles');
    expect(all).toContain('steps.frames[0].rows[0].items[0]');
    const t = rows() as unknown as { frames: { rows: { role: string }[] }[] };
    t.frames[0]!.rows[1]!.role = 'hot';
    expect(errorsOf(t)).toContain('steps.frames[0].rows[1].role');
  });

  test('a graph keeps ring and small nodes; rowsJoin is refused outside rows', () => {
    const g = graph();
    g.graph!.ring = true;
    g.graph!.nodes[1]!.small = true;
    const r = checkShapeSteps(g);
    expect(r.ok && r.value.graph!.ring).toBe(true);
    expect(r.ok && r.value.graph!.nodes[1]!.small).toBe(true);
    expect(errorsOf({ ...graph(), rowsJoin: 'arrow' })).toContain('steps.rowsJoin');
  });

});
