import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkShapeBoard, shapeCssProblems, shapeHtmlProblems, shapeParts } from './shape';
// @ts-expect-error the kit is plain JavaScript, with no types
import { arrow, board, box, card, cross, dots, followCss, line, mark, on, part, pic, pick, pin, sticky, svg, tag, text, tile } from './shape-kit.mjs';

const dir = mkdtempSync(join(tmpdir(), 'shape-kit-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const drawing = () =>
  dots(900, 500) +
  pick('all', 10, 10, 120, 40, 'All paths', { of: ['a', 'b'], checked: true }) +
  pick('a', 140, 10, 120, 40, 'Path <A>') +
  on(['a'], part('p-a', 1, box(20, 80, 200, 80), text(40, 120, 'A & B'), arrow([[220, 120], [400, 120]], { tone: 'soft', dash: true }), arrow([[220, 140], [300, 140], [300, 180]], { tone: 'soft' }))) +
  on(['b'], part('p-b', 2, line([[20, 200], [400, 200]], { tone: 'accent' }), cross(30, 240), tag(50, 240, 'New'))) +
  part('p-c', 3, card(420, 80, 300, 200), tile('claude', 440, 100), tile('codex', 500, 100), mark('github', 560, 100), sticky(440, 180, 200, 80, ['Words']), pic(620, 100, 80, 60, 'files/a.png', { dark: 'files/b.png', alt: 'Shot' }), pin(1, 720, 80));

describe('the kit', () => {
  test('everything it draws is something the store takes, and the board it writes passes whole', () => {
    expect(shapeHtmlProblems(drawing())).toEqual([]);
    const out = join(dir, 'board.json');
    board({
      out,
      title: 'T',
      claim: 'C',
      picture: svg(900, 500, drawing()),
      how: { ...svg(900, 500, drawing()), css: followCss(['a', 'b']) },
      refs: [{ n: 1, kind: 'link', title: 'R', target: 'https://example.com' }],
    });
    const written = JSON.parse(readFileSync(out, 'utf8'));
    const r = checkShapeBoard(written);
    expect(r.ok ? [] : r.errors).toEqual([]);
    if (r.ok) expect(shapeParts(r.value).some((p) => p.view === 'how' && p.id === 'p-a')).toBe(true);
  });

  test('same input, same drawing: a redraw does not churn', () => {
    expect(drawing()).toBe(drawing());
  });

  test("followCss passes the store's css rules, and looks for what pick and on write", () => {
    const css = followCss(['a', 'b']);
    expect(shapeCssProblems(css)).toEqual([]);
    expect(pick('a', 0, 0, 1, 1, 'A')).toContain('class="f-a"');
    expect(css).toContain('.f-a:checked');
    expect(on(['a', 'b'], '<g/>')).toBe('<g class="d on-a on-b"><g/></g>');
    expect(css).toContain('.d:not(.on-a)');
    expect(pick('all', 0, 0, 1, 1, 'All', { checked: true })).toContain('checked=""');
  });

  test('a mark the kit does not have says so', () => {
    let said = '';
    try { tile('gemini', 0, 0); } catch (e) { said = (e as Error).message; }
    expect(said).toContain('gemini is not in the kit');
    const names = /\((.+)\)/.exec(said)![1]!.split(', ');
    expect(names).toContain('codex');
    for (const name of names) expect(tile(name, 0, 0)).toContain('<g class="obj">');
  });

  test('a line turns square at its elbows; an arrow ends in one small closed head the board fills', () => {
    const tags = (html: string) => [...html.matchAll(/<path\b[^>]*>/g)].map((m) => m[0]);
    const elbow = tags(arrow([[0, 0], [100, 0], [100, 80]], { tone: 'soft' }));
    expect(elbow).toHaveLength(2);
    expect(elbow[0]).toContain('d="M0 0L100 0L100 80"');
    expect(elbow[0]).not.toContain('Q');
    expect(elbow[1]).toMatch(/class="shp-head grey"/);
    expect(elbow[1]).toMatch(/d="M[^"]+L100 80L[^"]+Z"/);
    expect(tags(line([[0, 0], [50, 0], [50, 50]]))).toHaveLength(1);
    expect(followCss(['a'])).toContain('.on-a path.shp-head.grey { fill: var(--mark); }');
  });

  test('words are escaped in every helper that takes them', () => {
    expect(pick('a', 0, 0, 1, 1, '<b>')).toContain('&lt;b>');
    expect(text(0, 0, '<b>')).toContain('&lt;b>');
    expect(part('"x', 1, '')).toContain('data-mark="&quot;x"');
  });
});
