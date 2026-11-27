import { describe, expect, test } from 'bun:test';
import {
  checkShapeDrawnView,
  isShapeProjectPath,
  parseShapeCodeTarget,
  shapeCssProblems,
  shapeHtmlDataCodes,
  shapeHtmlProblems,
} from './shape';
import { SHAPE_OUTSIDE_CSS, SHAPE_OUTSIDE_HTML, SHAPE_SAFE_HTML } from '../../tests/fixtures/shape-outside-loads';

// The checks a guide's html diagram gets (checkInboxDrawing reads them through checkShapeDrawnView).

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

  test('a bad drawn view is refused with its field named, in html, css and the tall drawing', () => {
    const r = checkShapeDrawnView(
      {
        html: '<div style="background:url(https://evil.invalid/a)">Kettle</div>',
        css: '.a{background:u\\72l(https://evil.invalid/a)}',
        tall: { html: '<img src="//evil.invalid/x.png">' },
      },
      'diagram',
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.startsWith('diagram.html: <div style>: url()'))).toBe(true);
    expect(r.errors.some((e) => e.startsWith('diagram.css: url()'))).toBe(true);
    expect(r.errors.some((e) => e.startsWith('diagram.tall.html: '))).toBe(true);
  });

  test('a safe drawn view passes and keeps only what it was given', () => {
    const r = checkShapeDrawnView({ html: '<svg><text>Kettle</text></svg>', width: 400, height: 300 });
    expect(r).toEqual({ ok: true, value: { html: '<svg><text>Kettle</text></svg>', width: 400, height: 300 } });
    const half = checkShapeDrawnView({ html: '<p>x</p>', width: 400 });
    expect(half.ok).toBe(false);
  });
});

describe('project paths', () => {
  test('only paths relative to the project root pass', () => {
    for (const good of ['src/kettle.ts', 'a.ts', 'apps/x-y/z_1.test.tsx', '.github/workflows/ci.yml']) expect(isShapeProjectPath(good)).toBe(true);
    for (const bad of ['', '/etc/passwd', '~/.ssh/id_rsa', 'C:/x.ts', 'C:\\x.ts', '\\\\server\\share\\a.ts', '..\\..\\x', '../../.env', 'src/../../x', 'src/./a.ts', 'src//a.ts', 'src/%2e%2e/x', 'file:src/a.ts', ' src/a.ts', 'src/a\nb.ts']) {
      expect([bad, isShapeProjectPath(bad)]).toEqual([bad, false]);
    }
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
