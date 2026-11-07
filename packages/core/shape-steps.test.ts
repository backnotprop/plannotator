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

  test('a name that would set the prototype is refused; one every object has is an ordinary id', () => {
    const proto = JSON.parse(JSON.stringify(graph()));
    proto.graph.nodes.push({ id: '__proto__', x: 50, y: 0 });
    expect(errorsOf(proto)).toContain('steps.graph.nodes[2].id');
    // Written as JSON, the way an agent's file arrives: a "__proto__" key is an own key of the parsed object.
    const tags = JSON.parse('{"A":0,"__proto__":3}');
    expect(errorsOf({ ...graph(), frames: [{ ...graph().frames[0], tags }] })).toContain('steps.frames[0].tags.__proto__');
    const vars = JSON.parse('{"__proto__":1}');
    expect(errorsOf({ ...sort(), frames: [{ ...sort().frames[0], vars }] })).toContain('steps.frames[0].vars.__proto__');
    const named = graph();
    named.graph!.nodes.push({ id: 'constructor', x: 50, y: 0 });
    named.frames[0]!.tags = { constructor: 7 };
    const r = checkShapeSteps(named);
    expect(r.ok && Object.hasOwn(r.value.frames[0]!.tags!, 'constructor') && r.value.frames[0]!.tags!.constructor).toBe(7);
  });

  test('a typo below a frame is named, and a part of another drawing is not dropped silently', () => {
    const g = graph() as any;
    g.graph.nodes[0].lable = 'A';
    g.graph.edges[0].weight = 3;
    g.frames[0].array = [1, 2];
    const all = errorsOf(g);
    expect(all).toContain('steps.graph.nodes[0].lable: is not part of a node');
    expect(all).toContain('steps.graph.edges[0].weight: is not part of an edge');
    expect(all).toContain('steps.frames[0].array: is for show "array"');
    expect(errorsOf({ ...sort(), graph: graph().graph })).toContain('steps.graph: is for show "graph"');
  });

  test('both ends of a bad edge are named, and a lit edge must be two node ids', () => {
    const g = graph() as any;
    g.graph.edges.push({ from: 'X', to: 'Y' });
    const all = errorsOf(g);
    expect(all).toContain('steps.graph.edges[1].from');
    expect(all).toContain('steps.graph.edges[1].to');
    const lit = graph() as any;
    lit.frames[0].edges = { look: [[['A'], 'B']] };
    expect(errorsOf(lit)).toContain('steps.frames[0].edges.look[0]');
  });
});

describe('what a drawing plays', () => {
  const board = (html: string, steps?: unknown) => ({ title: 't', claim: 'c', views: { how: { html } }, ...(steps ? { steps } : {}) });
  test('data-steps on a board with no steps says what it found', () => {
    const r = checkShapeBoard(board('<div data-steps="1"></div>'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toContain('has data-steps="1", but the board has no steps');
  });
  test('the attribute shown in a comment or in text is not a player', () => {
    const html = '<!-- <div data-steps="a"></div> --><pre><code>&lt;div data-steps="b"&gt;</code></pre><p> data-steps="c" in words</p>';
    expect(checkShapeBoard(board(html)).ok).toBe(true);
  });
});
