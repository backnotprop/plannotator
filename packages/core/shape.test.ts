import { describe, expect, test } from 'bun:test';
import {
  checkShapeBoard,
  checkShapeNoteInput,
  diffShapeVersions,
  parseShapeCodeTarget,
  shapeHtmlMarks,
  shapeParts,
  summarizeShapeDiff,
  type ShapeBoard,
  type ShapeVersion,
} from './shape';

// An invented board: a kettle that whistles once.
function board(overrides: Partial<ShapeBoard> = {}): ShapeBoard {
  return {
    title: 'The kettle whistles once',
    claim: 'Built and merged[^1]. Nothing waits on you.',
    views: {
      picture: {
        html: '<div data-step="1"><b data-mark="p-kettle">Kettle</b> <span data-mark="p-whistle">whistles once<span data-ref="1"></span></span></div>',
      },
      how: {
        html: '<div data-mark="how-boil">Water boils</div>',
        width: 800,
        height: 400,
        tall: { html: '<div data-mark="how-boil">Water boils (tall)</div><div data-mark="how-stop">Heat stops</div>' },
      },
      reqs: {
        groups: [{ id: 'when', label: 'When it sounds', items: [{ id: 'r-once', text: 'Once per boil.' }] }],
      },
    },
    refs: [{ n: 1, kind: 'link', title: 'The merge', target: 'https://example.com/pr/1' }],
    ...overrides,
  };
}

function version(b: ShapeBoard, n: number): ShapeVersion {
  return { ...b, n, at: '2026-11-03T10:00:00.000Z', base: n > 1 ? n - 1 : null, through: null, by: null, parts: shapeParts(b) };
}

describe('checkShapeBoard', () => {
  test('a well-formed board passes', () => {
    expect(checkShapeBoard(board()).ok).toBe(true);
  });

  test('scripts, handlers and outside loads in a drawn view are refused by field', () => {
    const bad = board({
      views: {
        picture: { html: '<img src="https://evil.example/x.png"><div onclick="x()">a</div><script>1</script>' },
        how: { html: '<svg><image href="//evil.example/y.svg"/></svg>', css: '@import "x.css"; a { background: url(https://x) }' },
      },
    });
    const result = checkShapeBoard(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const text = result.errors.join('\n');
    expect(text).toContain('views.picture.html: <script> is not allowed');
    expect(text).toContain('views.picture.html: event handler');
    expect(text).toContain('views.picture.html: nothing may load from outside');
    expect(text).toContain('views.how.html: nothing may load from outside');
    expect(text).toContain('views.how.css: @import');
    expect(text).toContain('views.how.css: url()');
  });

  test('a data: image and a #fragment url stay allowed in CSS', () => {
    const ok = board({ views: { picture: { html: '<p>x</p>', css: 'p { background: url(data:image/png;base64,AAAA); marker-end: url(#arrow) }' } } });
    expect(checkShapeBoard(ok).ok).toBe(true);
  });

  test('a cited reference must exist', () => {
    const result = checkShapeBoard(board({ refs: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toContain('[1]');
  });

  test('a board needs a view, and a canvas needs both sides', () => {
    const none = checkShapeBoard({ title: 't', claim: 'c', views: {} });
    expect(none.ok).toBe(false);
    const half = checkShapeBoard(board({ views: { how: { html: '<p>x</p>', width: 800 } } }));
    expect(half.ok).toBe(false);
    if (!half.ok) expect(half.errors.join()).toContain('views.how: width and height go together');
  });

  test('duplicate requirement ids are refused, since they key the redraw', () => {
    const dup = board({
      views: { reqs: { groups: [{ id: 'g', label: 'G', items: [{ id: 'r', text: 'a' }, { id: 'r', text: 'b' }] }] } },
    });
    const result = checkShapeBoard(dup);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toContain('views.reqs.groups[0].items[1].id: "r" is used twice');
  });
});

describe('data-code', () => {
  test('reads a file and line, and refuses what is not a place in the project', () => {
    expect(parseShapeCodeTarget('src/kettle.ts#L42')).toEqual({ path: 'src/kettle.ts', line: 42 });
    expect(parseShapeCodeTarget('src/kettle.ts#L42-L48')).toEqual({ path: 'src/kettle.ts', line: 42, lineEnd: 48 });
    expect(parseShapeCodeTarget('src/kettle.ts:7')).toEqual({ path: 'src/kettle.ts', line: 7 });
    for (const bad of ['src/kettle.ts', '/etc/passwd#L1', '../up.ts#L1', 'https://x.test/a.ts#L1', 'a.ts#L0', 'javascript:a#L1']) {
      expect(parseShapeCodeTarget(bad)).toBeNull();
    }
  });

  test('a board with a bad data-code is refused by field', () => {
    const b = board();
    b.views.picture = { html: '<div data-mark="p" data-code="kettle.ts">Kettle</div>' };
    const r = checkShapeBoard(b);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toContain('views.picture');
    b.views.picture = { html: '<div data-mark="p" data-code="src/kettle.ts#L3">Kettle</div>' };
    expect(checkShapeBoard(b).ok).toBe(true);
  });
});

describe('shapeHtmlMarks', () => {
  test('a mark keeps the words inside it, nested marks count for both, entities decode', () => {
    const marks = shapeHtmlMarks('<div data-mark="outer">A &amp; <b data-mark="inner">B&nbsp;C</b><br> D</div><p>not marked</p>');
    expect(marks).toEqual([
      { id: 'inner', text: 'B C' },
      { id: 'outer', text: 'A & B C D' },
    ]);
  });

  test('SVG self-closing elements do not swallow the next text', () => {
    const marks = shapeHtmlMarks('<svg><g data-mark="arrow"><path d="M0 0"/><text>checks</text></g></svg>');
    expect(marks).toEqual([{ id: 'arrow', text: 'checks' }]);
  });
});

describe('diffShapeVersions', () => {
  test('one changed mark is the only change, in its view', () => {
    const a = board();
    const b = board();
    b.views.picture = { html: a.views.picture!.html.replace('whistles once', 'whistles twice') };
    const diff = diffShapeVersions(version(a, 1), version(b, 2));
    expect(diff.changes).toEqual([{ view: 'picture', id: 'p-whistle', kind: 'changed', before: 'whistles once', after: 'whistles twice' }]);
    expect(diff.views).toEqual(['picture']);
  });

  test('the tall drawing names the same part: the wide drawing\'s words win, a tall-only part still counts', () => {
    const parts = shapeParts(board()).filter((p) => p.view === 'how');
    expect(parts).toEqual([
      { view: 'how', id: 'how-boil', text: 'Water boils' },
      { view: 'how', id: 'how-stop', text: 'Heat stops' },
    ]);
  });

  test('added and removed parts, a redrawn view with no mark change, and references', () => {
    const a = board();
    const b = board({ refs: [...board().refs!, { n: 2, kind: 'link', title: 'Docs', target: 'https://example.com/docs' }] });
    b.views.reqs = { groups: [{ id: 'when', label: 'When it sounds', items: [{ id: 'r-loud', text: 'Loud enough to hear upstairs.' }] }] };
    b.views.how = { ...a.views.how!, css: 'div { color: var(--mark) }' };
    const diff = diffShapeVersions(version(a, 1), version(b, 2));
    expect(diff.changes.map((c) => `${c.kind} ${c.view}/${c.id}`).sort()).toEqual(['added reqs/r-loud', 'removed reqs/r-once']);
    expect(diff.views).toEqual(['how', 'reqs']);
    expect(diff.refs).toEqual({ added: [2], removed: [], changed: [] });
    expect(summarizeShapeDiff(diff)).toEqual(['How it works: redrawn', 'Requirements: 1 added, 1 removed', 'References: 1 added']);
  });
});

describe('checkShapeNoteInput', () => {
  test('a general comment needs no part; a part needs its view', () => {
    expect(checkShapeNoteInput({ kind: 'change', v: 1, text: 'Simpler, please' }).ok).toBe(true);
    expect(checkShapeNoteInput({ kind: 'ask', v: 1, view: 'code', text: 'Why two files?' }).ok).toBe(true);
    const orphan = checkShapeNoteInput({ kind: 'change', v: 1, part: 'p-kettle', text: 'x' });
    expect(orphan.ok).toBe(false);
  });
});
