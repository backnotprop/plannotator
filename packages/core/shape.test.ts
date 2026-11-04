import { describe, expect, test } from 'bun:test';
import {
  checkShapeBoard,
  checkShapeNoteInput,
  diffShapeVersions,
  isShapeProjectPath,
  parseShapeCodeTarget,
  shapeCssProblems,
  shapeHtmlProblems,
  shapeHtmlMarks,
  shapeParts,
  summarizeShapeDiff,
  type ShapeBoard,
  type ShapeVersion,
} from './shape';
import { SHAPE_OUTSIDE_CSS, SHAPE_OUTSIDE_HTML, SHAPE_SAFE_HTML } from '../../tests/fixtures/shape-outside-loads';

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
    expect(text).toMatch(/views\.picture\.html: <img src="https:\/\/evil\.example\/x\.png">: nothing may load from outside/);
    expect(text).toMatch(/views\.how\.html: <image href="\/\/evil\.example\/y\.svg">: nothing may load from outside/);
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

describe('what a drawing may load (the review\'s probe payloads)', () => {
  test('every drawing that loads or runs something outside the board is refused', () => {
    const passed = SHAPE_OUTSIDE_HTML.filter((html) => shapeHtmlProblems(html).length === 0);
    expect(passed).toEqual([]);
  });

  test('every view css that loads from outside is refused, escapes and comments read first', () => {
    const passed = SHAPE_OUTSIDE_CSS.filter((css) => shapeCssProblems(css).length === 0);
    expect(passed).toEqual([]);
    expect(shapeCssProblems('.a{background:url(/**/https://evil.invalid/a)}').length).toBeGreaterThan(0);
  });

  test('the board\'s own files, fragments, data images and https links still pass', () => {
    expect(SHAPE_SAFE_HTML.map((html) => [html, shapeHtmlProblems(html)])).toEqual(SHAPE_SAFE_HTML.map((html) => [html, []]));
  });

  test('a bad drawing in a board is refused with its field named', () => {
    const b = board();
    b.views.picture = { html: '<div data-mark="p-kettle" style="background:url(https://evil.invalid/a)">Kettle</div>' };
    b.views.how = { html: '<p>x</p>', css: '.a{background:u\\72l(https://evil.invalid/a)}' };
    const r = checkShapeBoard(b);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.startsWith('views.picture.html: <div style>: url()'))).toBe(true);
    expect(r.errors.some((e) => e.startsWith('views.how.css: url()'))).toBe(true);
  });
});

describe('project paths', () => {
  test('only paths relative to the project root pass', () => {
    for (const good of ['src/kettle.ts', 'a.ts', 'apps/x-y/z_1.test.tsx', '.github/workflows/ci.yml']) expect(isShapeProjectPath(good)).toBe(true);
    for (const bad of ['', '/etc/passwd', '~/.ssh/id_rsa', 'C:/x.ts', 'C:\\x.ts', '\\\\server\\share\\a.ts', '..\\..\\x', '../../.env', 'src/../../x', 'src/./a.ts', 'src//a.ts', 'src/%2e%2e/x', 'file:src/a.ts', ' src/a.ts', 'src/a\nb.ts']) {
      expect([bad, isShapeProjectPath(bad)]).toEqual([bad, false]);
    }
  });

  test('a file ref, a diff ref, a requirement\'s code, the code view\'s files and a step\'s diffs must be project paths', () => {
    const b = board({
      refs: [
        { n: 1, kind: 'link', title: 'The merge', target: 'https://example.com/pr/1' },
        { n: 2, kind: 'file', title: 'Keys', target: '/Users/x/.ssh/id_rsa' },
        { n: 3, kind: 'diff', title: 'Env', target: '../../.env' },
      ],
    });
    b.views.reqs = { groups: [{ id: 'g', label: 'G', items: [{ id: 'r', text: 'a', code: { path: '\\\\server\\share\\a.ts', line: 1 } }] }] };
    b.views.code = {
      stage: 'after',
      guide: { title: 'T', intent: '', sections: [{ title: 'S', overview: '', diffs: [{ file: 'src/../../x.ts' }] }] },
      files: [{ path: '~/notes.md' }],
    };
    const r = checkShapeBoard(b);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const fields = r.errors.map((e) => e.slice(0, e.indexOf(':')));
    expect(fields).toEqual(['views.reqs.groups[0].items[0].code.path', 'views.code.guide.sections[0].diffs[0].file', 'views.code.files[0].path', 'refs[1].target', 'refs[2].target']);
  });
});

describe('data-code', () => {
  test('reads a file and line, and refuses what is not a place in the project', () => {
    expect(parseShapeCodeTarget('src/kettle.ts#L42')).toEqual({ path: 'src/kettle.ts', line: 42 });
    expect(parseShapeCodeTarget('src/kettle.ts#L42-L48')).toEqual({ path: 'src/kettle.ts', line: 42, lineEnd: 48 });
    expect(parseShapeCodeTarget('src/kettle.ts:7')).toEqual({ path: 'src/kettle.ts', line: 7 });
    for (const bad of ['src/kettle.ts', '/etc/passwd#L1', '../up.ts#L1', 'https://x.test/a.ts#L1', 'a.ts#L0', 'javascript:a#L1', '\\\\server\\share\\a.ts#L1', '..\\..\\x#L1', 'src\\a.ts#L1', '~/a.ts#L1', 'src/%2e%2e/a.ts#L1']) {
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

// ── How it works examples ("Follow an example") ──
// An invented drawing: a kettle with an arrow named by data-edge.
const KETTLE_HOW = {
  html: '<div data-mark="how-boil">Water boils</div><svg><g data-edge="hot"><path d="M0 0 H10"/></g></svg><span data-edge="hot">hot enough</span><div data-mark="how-whistle">It whistles</div><div data-mark="how-quiet">Stays quiet</div>',
  width: 800,
  height: 400,
};

function step(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    part: 'how-boil',
    tag: '100 °C',
    text: 'The water boils',
    inputs: [{ name: 'temp', value: '100', type: 'number', reading: '100 °C', from: { path: 'src/kettle.ts', line: 12 } }],
    signature: 'boils(temp: number): boolean',
    checks: [{ code: 'temp >= BOIL', constant: '100', saw: '100', result: 'pass', decides: true }],
    output: { name: 'boiling', value: 'true', type: 'boolean' },
    code: { path: 'src/kettle.ts', line: 10 },
    ...overrides,
  };
}

function withExamples(examples: unknown, how: Record<string, unknown> = KETTLE_HOW) {
  const b = board();
  return checkShapeBoard({ ...b, views: { ...b.views, how: { ...how, examples } } });
}

describe('checkShapeBoard: examples on How it works', () => {
  test('a whole example is kept, with its handed-on value and its failing check', () => {
    const examples = [
      {
        name: 'Nothing sounds',
        title: 'The water stops at 90 °C',
        steps: [
          step({
            tag: '90 °C',
            checks: [
              { code: 'temp >= BOIL', constant: '100', saw: '90', result: 'fail', decides: true, short: '10 short' },
              { code: 'lid.closed', result: 'not-reached' },
            ],
            output: { name: 'boiling', value: 'false', type: 'boolean' },
          }),
          step({ part: 'how-quiet', arrow: 'hot', tag: 'quiet', inputs: [{ name: 'boiling', value: 'false', from: { step: 1 } }, { name: 'mode', value: "'eco'", from: 'the settings' }] }),
        ],
      },
    ];
    const r = withExamples(examples);
    if (!r.ok) throw new Error(r.errors.join('\n'));
    const out = r.value.views.how!.examples!;
    expect(out[0]!.steps[1]!.inputs.map((i) => i.from)).toEqual([{ step: 1 }, 'the settings']);
    expect(out[0]!.steps[0]!.checks.map((c) => c.result)).toEqual(['fail', 'not-reached']);
    expect(out[0]!.steps[1]!.arrow).toBe('hot');
  });

  test('a step must light a part or an arrow the drawing has, in the tall drawing too', () => {
    const r = withExamples([{ name: 'It sounds', title: 'Boils', steps: [step({ part: 'how-kettle' }), step({ part: undefined, arrow: 'cold' })] }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toContain('views.how.examples[0].steps[0].part: "how-kettle" is not a data-mark in views.how.html');
    expect(r.errors.some((e) => e.startsWith('views.how.examples[0].steps[1].arrow: "cold" is not a data-edge in views.how.html'))).toBe(true);

    const tall = withExamples([{ name: 'It sounds', title: 'Boils', steps: [step({ part: 'how-whistle' })] }], { ...KETTLE_HOW, tall: { html: '<div data-mark="how-boil">Boils</div>' } });
    expect(tall.ok).toBe(false);
    if (!tall.ok) expect(tall.errors).toContain('views.how.examples[0].steps[0].part: "how-whistle" is not a data-mark in views.how.tall.html');

    const neither = withExamples([{ name: 'It sounds', title: 'Boils', steps: [step({ part: undefined })] }]);
    expect(neither.ok).toBe(false);
    if (!neither.ok) expect(neither.errors[0]).toContain('needs a part (a data-mark) or an arrow (a data-edge)');
  });

  test('checks: one decides, nothing runs after a failure, a shortfall only on a failure', () => {
    const r = withExamples([
      {
        name: 'It sounds',
        title: 'Boils',
        steps: [
          step({ checks: [{ code: 'a', saw: '1', result: 'pass' }, { code: 'b', saw: '2', result: 'pass' }] }),
          step({ checks: [{ code: 'a', saw: '1', result: 'fail', decides: true }, { code: 'b', saw: '2', result: 'pass' }] }),
          step({ checks: [{ code: 'a', saw: '1', result: 'pass', decides: true, short: '3 short' }] }),
          step({ checks: [{ code: 'a', result: 'not-reached', decides: true }, { code: 'b', saw: '2', result: 'maybe' }] }),
        ],
      },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const f = 'views.how.examples[0].steps';
    expect(r.errors).toContain(`${f}[0].checks: mark exactly one check "decides": true, the one that settled the step (0 are marked)`);
    expect(r.errors).toContain(`${f}[1].checks[1].result: must be "not-reached": an earlier check failed, so the code never got here`);
    expect(r.errors).toContain(`${f}[2].checks[0].short: only a failing check has a shortfall`);
    expect(r.errors).toContain(`${f}[3].checks[0].decides: a check that was not reached cannot decide the step`);
    expect(r.errors).toContain(`${f}[3].checks[1].result: must be "pass", "fail" or "not-reached"`);
  });

  test('a handed-on value names an earlier step; sources and code stay in the project', () => {
    const r = withExamples([
      {
        name: 'It sounds',
        title: 'Boils',
        steps: [
          step({ inputs: [{ name: 'x', value: '1', from: { step: 1 } }] }),
          step({ inputs: [{ name: 'x', value: '1', from: { step: 2 } }, { name: 'y', value: '2', from: { path: '../etc/passwd', line: 1 } }], code: { path: '/abs.ts', line: 1 } }),
        ],
      },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const f = 'views.how.examples[0].steps';
    expect(r.errors).toContain(`${f}[0].inputs[0].from.step: the first step has no earlier step; name the code it is read from: { path, line }`);
    expect(r.errors).toContain(`${f}[1].inputs[0].from.step: must be a whole number from 1 to 1`);
    expect(r.errors.some((e) => e.startsWith(`${f}[1].inputs[1].from.path:`))).toBe(true);
    expect(r.errors.some((e) => e.startsWith(`${f}[1].code.path:`))).toBe(true);
  });

  test('names, steps and outputs are required, and examples go only on How it works', () => {
    const r = withExamples([
      { name: 'Twice', title: 'A', steps: [step()] },
      { name: 'Twice', title: 'B', steps: [] },
      { title: 'C', steps: [step({ output: { name: 'x', value: '1' }, signature: 'not a call' })] },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toContain('views.how.examples[1].name: "Twice" is used twice; name each example by where it ends');
    expect(r.errors).toContain('views.how.examples[1].steps: needs at least one step');
    expect(r.errors).toContain('views.how.examples[2].name: is required');
    expect(r.errors).toContain('views.how.examples[2].steps[0].output.type: is required');
    expect(r.errors.some((e) => e.startsWith('views.how.examples[2].steps[0].signature: must start with the function'))).toBe(true);

    const b = board();
    const onPicture = checkShapeBoard({ ...b, views: { ...b.views, picture: { ...b.views.picture!, examples: [] } } });
    expect(onPicture.ok).toBe(false);
    if (!onPicture.ok) expect(onPicture.errors[0]).toContain('views.picture.examples: examples go on views.how');
  });
});
