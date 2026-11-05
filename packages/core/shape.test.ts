import { describe, expect, test } from 'bun:test';
import {
  checkShapeBoard,
  checkShapeNoteInput,
  diffShapeVersions,
  isShapeProjectPath,
  parseShapeCodeTarget,
  shapeCssProblems,
  shapeHtmlDataCodes,
  shapeHtmlProblems,
  shapeHtmlMarks,
  shapeParts,
  summarizeShapeDiff,
  type ShapeBoard,
  type ShapeVersion,
  SHAPE_LIMITS,
  shapeBoardNotes,
  shapeDrawnWords,
  shapeViewContent,
  shapeCitedRefs,
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
      know: 'It whistles once per boil.',
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

  test('Show more: a drawing is checked like any other, and its parts and numbers count', () => {
    const bad = board();
    bad.views.picture = { html: '<p>x</p>', more: { html: '<script>x()</script>' } };
    const refused = checkShapeBoard(bad);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.errors.join()).toContain('views.picture.more.html');

    const b = board({ refs: [{ n: 1, kind: 'link', title: 'One', target: 'https://example.com' }] });
    b.views.picture = { html: '<p data-mark="main">x</p>', more: { html: '<p data-mark="deep">y<span data-ref="1"></span></p>' } };
    expect(checkShapeBoard(b).ok).toBe(true);
    expect(shapeParts(b).some((p) => p.view === 'picture' && p.id === 'deep')).toBe(true);
    expect(shapeCitedRefs(b).has(1)).toBe(true);
  });

  test("a reference's crop: four numbers from 0 to 1 that stay on the image", () => {
    const withCrop = (crop: unknown) => ({ ...board(), refs: [{ n: 1, kind: 'image', title: 'Shot', target: 'files/a.png', images: [{ src: 'files/a.png', alt: 'A', crop }] }] });
    const good = checkShapeBoard(withCrop([0.1, 0.2, 0.5, 0.5]));
    expect(good.ok && good.value.refs?.[0]?.images?.[0]?.crop).toEqual([0.1, 0.2, 0.5, 0.5]);
    for (const crop of [[0, 0, 1], [0, 0, 0, 1], [0.6, 0, 0.6, 1], [-0.1, 0, 0.5, 0.5], 'all']) {
      const r = checkShapeBoard(withCrop(crop));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.join()).toContain('refs[0].images[0].crop');
    }
  });
});

describe('What to know', () => {
  const knowing = (know: unknown) => {
    const b = board() as unknown as { views: Record<string, unknown> };
    b.views.know = know;
    return checkShapeBoard(b);
  };
  const errors = (r: ReturnType<typeof checkShapeBoard>) => (r.ok ? '' : r.errors.join('\n'));

  test('up to the limit it stores; past it the agent is told to cut, and how far', () => {
    expect(knowing('x'.repeat(1200)).ok).toBe(true);
    const long = knowing('x'.repeat(1201));
    expect(long.ok).toBe(false);
    expect(errors(long)).toContain('views.know: is 1201 characters; at most 1200');
    expect(errors(long)).toContain('Cut it');
  });

  test('two paragraphs store; a third is refused, however the blank line is written', () => {
    expect(knowing('One.\n\nTwo.').ok).toBe(true);
    expect(knowing('One.\nStill one.\n\nTwo.').ok).toBe(true);
    expect(errors(knowing('One.\n\nTwo.\n\nThree.'))).toContain('views.know: is 3 paragraphs; at most 2');
    expect(errors(knowing('One.\n  \nTwo.\r\n\r\nThree.'))).toContain('is 3 paragraphs');
  });

  test('only its length and its paragraphs are limited: a line may start any way', () => {
    for (const text of ['> 5 MB files are skipped.', '# of retries drops to 3.', '2026. That is when it ends.', '- and that is the point.', 'Wrapped, so the next line\n5. That one starts with a number.']) {
      expect(knowing(text).ok).toBe(true);
    }
  });

  test('a note from a tab older than What to know is taken, as What to know', () => {
    const r = checkShapeNoteInput({ kind: 'change', v: 1, view: 'reqs', part: 'r-1', text: 'Change this' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.view).toBe('know');
    expect(checkShapeNoteInput({ kind: 'change', v: 1, view: 'nope', text: 'x' }).ok).toBe(false);
  });

  test('it must be words, and its references must exist', () => {
    expect(errors(knowing({ groups: [] }))).toContain('views.know: must be a string');
    expect(errors(knowing('   '))).toContain('views.know: is empty');
    expect(errors(knowing('See this [^7].'))).toContain('[7]');
  });

  test('alone it is a board', () => {
    const r = checkShapeBoard({ title: 'T', claim: 'C', views: { know: 'Just this.' } });
    expect(r.ok && r.value.views.know).toBe('Just this.');
  });

  test('a new board cannot write Requirements: the refusal names where the words go', () => {
    const b = board() as unknown as { views: Record<string, unknown> };
    b.views.reqs = { groups: [{ id: 'g', label: 'G', items: [{ id: 'r', text: 'a' }] }] };
    const r = checkShapeBoard(b);
    expect(r.ok).toBe(false);
    expect(errors(r)).toContain('views.reqs: Requirements are gone');
    expect(errors(r)).toContain('views.know');
  });

  test('each paragraph is a part: a change to one marks that one, and says What to know', () => {
    const a = board();
    a.views.know = 'First.\n\nSecond.';
    const b = board();
    b.views.know = 'First.\n\nSecond, changed.';
    expect(shapeParts(a).filter((p) => p.view === 'know')).toEqual([
      { view: 'know', id: 'know-1', text: 'First.' },
      { view: 'know', id: 'know-2', text: 'Second.' },
    ]);
    const diff = diffShapeVersions(version(a, 1), version(b, 2));
    expect(diff.changes.map((c) => `${c.kind} ${c.view}/${c.id}`)).toEqual(['changed know/know-2']);
    expect(summarizeShapeDiff(diff)).toEqual(['What to know: 1 changed']);
  });

  test('an old board: its Requirements are what the view holds, with their parts and references', () => {
    const old = board({ refs: [{ n: 4, kind: 'link', title: 'R', target: 'https://example.com' }] });
    delete old.views.know;
    old.views.reqs = { groups: [{ id: 'g', label: 'When', items: [{ id: 'r-1', text: 'Once [^4]' }] }], foot: [{ label: 'Open', text: 'Nothing' }] };
    expect(shapeViewContent(old.views, 'know')).toBe(old.views.reqs);
    expect(shapeParts(old)).toContainEqual({ view: 'know', id: 'r-1', text: 'When: Once [^4]' });
    expect(shapeCitedRefs(old).has(4)).toBe(true);
    delete old.views.reqs;
    expect(shapeViewContent(old.views, 'know')).toBeUndefined();
  });
});

describe('shapeBoardNotes: what shape update says about a board', () => {
  const GOOD = '<svg viewBox="0 0 900 500"><g data-mark="a" data-ref="1"><rect x="0" y="0" width="880" height="480"/><text x="10" y="400">Kettle</text></g></svg>';
  const notesFor = (picture: Partial<ShapeBoard['views']['picture']> & { html?: string }, refs: ShapeBoard['refs'] = [{ n: 1, kind: 'image', title: 'Shot', target: 'files/a.png' }]) =>
    shapeBoardNotes({ views: { picture: { html: GOOD, width: 900, height: 500, tall: { html: '<p>tall</p>' }, ...picture } as ShapeBoard['views']['picture'] }, refs });

  test('a good board has none, and a board with no Picture has none', () => {
    expect(notesFor({})).toEqual([]);
    expect(shapeBoardNotes({ views: { know: 'Words.' } })).toEqual([]);
  });

  test.each([
    ['too many words', { html: `<svg viewBox="0 0 900 500" data-mark="a" data-ref="1"><text x="0" y="0">${'word '.repeat(81)}</text><rect x="0" y="0" width="900" height="500"/></svg>` }, 'has 81 words'],
    ['no canvas', { width: undefined, height: undefined }, 'no width and height'],
    ['no tall', { tall: undefined }, 'no tall drawing'],
    ['no numbers', { html: GOOD.replace(' data-ref="1"', '') }, 'no numbers'],
    ['no parts', { html: GOOD.replace(' data-mark="a"', '') }, 'no data-mark'],
    ['small in its canvas', { html: GOOD.replace('width="880" height="480"', 'width="100" height="100"').replace('y="400"', 'y="50"') }, 'The drawing fills'],
    ['fixed colours', { html: GOOD.replace('<rect ', '<rect fill="#ff0000" ') }, 'fixed colours'],
  ])('%s', (_name, picture, words) => {
    const notes = notesFor(picture as Parameters<typeof notesFor>[0]);
    expect(notes.join('\n')).toContain(words as string);
  });

  test('a number with nothing behind it is named; one with a line or a picture is not', () => {
    expect(notesFor({}, [{ n: 1, kind: 'file', title: 'File', target: 'a.ts' }]).join()).toContain('Bubble 1 shows only a title');
    expect(notesFor({}, [{ n: 1, kind: 'file', title: 'File', sub: 'One line', target: 'a.ts' }])).toEqual([]);
  });

  test("a real logo's own colours are not a problem", () => {
    expect(notesFor({ html: GOOD.replace('</g>', '<svg data-brand x="0" y="0"><path style="fill:#D97757;" d="M0 0"/></svg></g>') })).toEqual([]);
  });

  test('the words on a drawing leave out markup and titles', () => {
    expect(shapeDrawnWords('<svg><title>not counted here</title><text>two words</text><text>&amp; —</text></svg>')).toBe(2);
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

  test('a file ref, a diff ref, the code view\'s files and a step\'s diffs must be project paths', () => {
    const b = board({
      refs: [
        { n: 1, kind: 'link', title: 'The merge', target: 'https://example.com/pr/1' },
        { n: 2, kind: 'file', title: 'Keys', target: '/Users/x/.ssh/id_rsa' },
        { n: 3, kind: 'diff', title: 'Env', target: '../../.env' },
      ],
    });
    b.views.code = {
      stage: 'after',
      guide: { title: 'T', intent: '', sections: [{ title: 'S', overview: '', diffs: [{ file: 'src/../../x.ts' }] }] },
      files: [{ path: '~/notes.md' }],
    };
    const r = checkShapeBoard(b);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const fields = r.errors.map((e) => e.slice(0, e.indexOf(':')));
    expect(fields).toEqual(['views.code.guide.sections[0].diffs[0].file', 'views.code.files[0].path', 'refs[1].target', 'refs[2].target']);
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

describe('character references in a data-code', () => {
  test('decoded once, as a browser reads the attribute: nbsp, NULL, and 128–159 as windows-1252', () => {
    const codes = (value: string) => shapeHtmlDataCodes(`<div data-code="${value}">x</div>`);
    expect(codes('a&#38;#x2F;b')).toEqual(['a&#x2F;b']);
    expect(codes('a&amp;lt;b')).toEqual(['a&lt;b']);
    expect(codes('a&#x2F;b&#47c&lt;')).toEqual(['a/b/c<']);
    expect(codes('a.ts&nbsp;#L1')).toEqual(['a.ts\u00a0#L1']);
    expect(codes('a&#0;b\u0000c&#xD800;')).toEqual(['a\ufffdb\ufffdc\ufffd']);
    expect(codes('a&#150;b&#x80;&#159;&#129;&#160;')).toEqual(['a\u2013b\u20ac\u0178\u0081\u00a0']);
    // What the check reads is what is drawn: an en dash, not a C1 control in the path.
    expect(parseShapeCodeTarget(codes('a&#150;b.ts#L1')[0]!)).toEqual({ path: 'a\u2013b.ts', line: 1 });
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
    b.views.know = 'It whistles once per boil.\n\nLoud enough to hear upstairs.';
    b.views.how = { ...a.views.how!, css: 'div { color: var(--mark) }' };
    const diff = diffShapeVersions(version(a, 1), version(b, 2));
    expect(diff.changes.map((c) => `${c.kind} ${c.view}/${c.id}`).sort()).toEqual(['added know/know-2']);
    expect(diff.views).toEqual(['how', 'know']);
    expect(diff.refs).toEqual({ added: [2], removed: [], changed: [] });
    expect(summarizeShapeDiff(diff)).toEqual(['How it works: redrawn', 'What to know: 1 added', 'References: 1 added']);
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
