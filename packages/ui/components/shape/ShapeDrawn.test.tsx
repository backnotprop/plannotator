/**
 * A drawn view is an agent's HTML (DOM-gated, DOM_TESTS=1). What regresses if
 * these fail:
 * - the agent's markup runs script, loads from outside the board, or keeps
 *   its own <style> (every payload of the review's probe, in
 *   tests/fixtures/shape-outside-loads.ts, comes out neutered; the board's
 *   own files, fragments, data images and https links stay);
 * - the view's css escapes its frame (`:host { position: fixed }` over the app),
 *   or a part opens in the top layer (a popover, a dialog, a select's picker);
 * - the view's css leaks out of its shadow root, or css that loads from
 *   outside the board is kept;
 * - a bubble for a reference the board does not have shows as a dead number;
 * - a part's `data-code` no longer reaches the host, so a diagram outside the
 *   board (code review's "show me how this works") cannot open the code;
 * - while pointing (Change it / Ask), a marked part opens the code instead of
 *   being picked, or a bad `data-code` reaches the host;
 * - a drawing's `#…` link changes the host page's hash (the Inbox's route), or
 *   its https link opens in the same tab (leaving the Inbox), or an image map's
 *   `<area href>` gets past either.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ShapeCodeTarget, ShapeRef } from '@plannotator/core/shape';
import { bridgeSanitizerDom } from '../../../../tests/helpers/chat-sanitizer-dom';
import { OUTSIDE_HOST, SHAPE_OUTSIDE_HTML, SHAPE_SAFE_HTML } from '../../../../tests/fixtures/shape-outside-loads';

const hasDom = typeof document !== 'undefined';
const drawnModule = hasDom ? await import('./ShapeDrawn') : null;

let root: Root | null = null;
let unbridge: (() => void) | null = null;

// happy-dom cannot host DOMPurify as it stands; the chat folder's bridge makes
// it, and if the bridge stops working the sanitizer fails its proof and the
// drawings come out empty, which fails these tests.
beforeAll(() => {
  if (hasDom) unbridge = bridgeSanitizerDom();
});
afterAll(() => unbridge?.());
let container: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

async function draw(props: Partial<React.ComponentProps<NonNullable<typeof drawnModule>['ShapeDrawn']>> & { html: string; css?: string }) {
  const { ShapeDrawn } = drawnModule!;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const { html, css = '.x { color: red; }', ...rest } = props;
  await act(async () => {
    root!.render(<ShapeDrawn drawn={{ html, css }} reduce {...rest} />);
  });
  const shadow = container.querySelector('.shp-drawn-host')!.shadowRoot!;
  return { shadow, board: shadow.querySelector('.board') as HTMLElement };
}

const REFS: ShapeRef[] = [{ n: 1, kind: 'file', title: 'The kettle', target: 'src/kettle.ts', line: 3 }];

describe.skipIf(!hasDom)('a drawn view', () => {
  // An iframe with no src, and hosts that never resolve: drawing this fetches nothing.
  test('keeps the drawing and drops script, handlers, outside loads and its own <style>', async () => {
    const { board } = await draw({
      html: '<div data-mark="k" data-code="src/kettle.ts#L1" onclick="window.__pwned=1">Kettle</div><script>window.__pwned=1</script><img src="https://evil.invalid/x.png"><iframe></iframe><style>body{display:none}</style><svg><rect class="ink" width="4" height="4"/><foreignObject width="9" height="9"><div data-mark="label" onmouseover="x()">Label</div></foreignObject></svg><a href="https://example.com/pr/1">PR</a>',
    });
    const kettle = board.querySelector('[data-mark="k"]')!;
    expect(kettle.textContent).toBe('Kettle');
    expect(kettle.getAttribute('data-code')).toBe('src/kettle.ts#L1');
    expect(board.innerHTML).not.toMatch(/onclick|onmouseover|<script|<iframe|<style|evil\.invalid/);
    expect(board.querySelector('rect')).not.toBeNull();
    // HTML inside a foreignObject stays in a browser; happy-dom parses its namespace differently.
    expect(board.querySelector('a')?.getAttribute('href')).toBe('https://example.com/pr/1');
  });

  test('the view keeps its css inside its own root, and loses css that reaches outside', async () => {
    const { shadow } = await draw({ html: '<p>Kettle</p>' });
    expect(shadow.querySelectorAll('style')).toHaveLength(1);
    expect(shadow.querySelector('style')!.textContent).toContain('.x { color: red; }');
    expect(document.head.innerHTML).not.toContain('.x { color: red; }');
    act(() => root?.unmount());
    container?.remove();
    const outside = await draw({ html: '<p>Kettle</p>', css: '@\\69mport url(https://evil.invalid/a.css); .y { color: blue; }' });
    expect(outside.shadow.querySelector('style')!.textContent).not.toContain('evil.invalid');
    expect(outside.shadow.querySelector('style')!.textContent).not.toContain('.y { color: blue; }');
  });

  test('every probe payload comes out neutered (sanitized as a string, never attached)', () => {
    const { sanitizeShapeHtml } = drawnModule!;
    const LEFT = new RegExp(`${OUTSIDE_HOST.replace('.', '\\.')}|javascript|alert|data:text|svg\\+xml|passwd|\\son\\w+=|<style|<source|<animate|<set\\b|srcset|poster|ping=|formaction|background=|popover|command|interest|<dialog|<select`, 'i');
    const kept = SHAPE_OUTSIDE_HTML.map((html) => [html, sanitizeShapeHtml(html)] as const).filter(([, out]) => LEFT.test(out));
    expect(kept).toEqual([]);
  });

  test('the board\'s own files, fragments, data images, https links and plain styles stay', () => {
    const { sanitizeShapeHtml } = drawnModule!;
    const out = SHAPE_SAFE_HTML.map((html) => sanitizeShapeHtml(html)).join('\n');
    for (const kept of ['src="files/B-desktop-light.png"', 'src="data:image/png;base64,AAAA"', 'href="https://example.com/pr/1"', 'href="#step-2"', 'marker-end="url(#arrow)"', 'fill="url(#g)"', 'style="left:12px;top:40px;width:300px"']) {
      expect(out).toContain(kept);
    }
  });

  test('the frame contains the drawing, so its css cannot lay it over the app', async () => {
    await draw({ html: '<p>Kettle</p>', css: ':host { position: fixed !important; inset: 0; z-index: 2147483647; }' });
    const frame = container!.querySelector<HTMLElement>('.shp-drawn')!;
    // Containment makes the frame the box a fixed host is placed in; the clip keeps it within 24px of the frame.
    expect(frame.style.contain).toBe('layout');
    expect(frame.style.clipPath).toBe('inset(-24px)');
    expect(frame.contains(container!.querySelector('.shp-drawn-host'))).toBe(true);
  });

  test('numbers the bubbles it has a reference for and drops the rest', async () => {
    const { board } = await draw({ html: '<p>Boils<span data-ref="1"></span> and sings<span data-ref="7"></span></p>', refs: REFS });
    const bubbles = [...board.querySelectorAll('[data-ref]')];
    expect(bubbles.map((b) => b.textContent)).toEqual(['1']);
    expect(bubbles[0]!.getAttribute('aria-label')).toBe('Reference 1: The kettle');
  });

  test('a part with data-code opens that file and line through the host', async () => {
    const opened: ShapeCodeTarget[] = [];
    const { board } = await draw({
      html: '<div data-code="src/kettle.ts#L12-L14">Heat</div><div data-code="/etc/passwd#L1">Root</div>',
      onCode: (at) => opened.push(at),
    });
    const [good, bad] = [...board.querySelectorAll<HTMLElement>('[data-code]')];
    await act(async () => good!.click());
    await act(async () => bad!.click());
    expect(opened).toEqual([{ path: 'src/kettle.ts', line: 12, lineEnd: 14 }]);
    expect(bad!.hasAttribute('tabindex')).toBe(false);
  });

  // Code review's redrawn Overview tags the parts that changed; a Show me of an earlier round tags the parts whose code moved on.
  test("a host's tags land on the fresh and the stale parts only, and leave with them", async () => {
    const { NO_MARKS, ShapeDrawn } = drawnModule!;
    const html = '<div data-mark="a">A</div><div data-mark="b">B</div><div data-mark="c">C</div>';
    const tags = { fresh: 'changed', stale: 'changed since asked' };
    const { board } = await draw({ html, marks: { ...NO_MARKS, fresh: new Set(['a']) }, stale: new Set(['b']), tags });
    const tagOf = (id: string) => board.querySelector(`[data-mark="${id}"]`)!.getAttribute('data-shp-tag');
    expect([tagOf('a'), tagOf('b'), tagOf('c')]).toEqual(['changed', 'changed since asked', null]);
    expect(board.querySelector('[data-mark="b"]')!.classList.contains('stale')).toBe(true);
    await act(async () => {
      root!.render(<ShapeDrawn drawn={{ html, css: '.x { color: red; }' }} reduce />);
    });
    expect([tagOf('a'), tagOf('b')]).toEqual([null, null]);
    expect(board.querySelector('[data-mark="b"]')!.classList.contains('stale')).toBe(false);
  });

  test('while pointing, a marked part is picked and its code waits', async () => {
    const opened: ShapeCodeTarget[] = [];
    const picked: string[] = [];
    const { board } = await draw({
      html: '<div data-mark="heat" data-code="src/kettle.ts#L12">Heat</div>',
      pinpoint: true,
      onCode: (at) => opened.push(at),
      onPickMark: (el) => picked.push(el.getAttribute('data-mark')!),
    });
    await act(async () => board.querySelector<HTMLElement>('[data-mark]')!.click());
    expect(picked).toEqual(['heat']);
    expect(opened).toEqual([]);
  });

  test("a drawing's #link never changes the host's hash, and its https link opens in a new tab", async () => {
    window.location.hash = '#thread=msg_keep';
    const opened: unknown[][] = [];
    const realOpen = window.open;
    window.open = ((...args: unknown[]) => {
      opened.push(args);
      return null;
    }) as typeof window.open;
    try {
      const { board } = await draw({
        html: '<a href="#steam">Steam</a><p id="steam">Steam</p><a href="https://example.com/kettle">Spec</a><svg><a href="#steam"><text>S</text></a></svg>',
      });
      const [frag, out] = [...board.querySelectorAll<HTMLAnchorElement>(':scope > a')];
      for (const a of [frag!, out!, board.querySelector('svg a')!]) {
        const click = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true });
        await act(async () => {
          a.dispatchEvent(click);
        });
        expect(click.defaultPrevented).toBe(true);
      }
      expect(window.location.hash).toBe('#thread=msg_keep');
      expect(opened).toEqual([['https://example.com/kettle', '_blank', 'noopener,noreferrer']]);
    } finally {
      window.open = realOpen;
      window.location.hash = '';
    }
  });

  test("an image map's <area href> is refused by the store and the sanitizer, and the guard holds any href it is handed", async () => {
    const { shapeHtmlProblems } = await import('@plannotator/core/shape');
    const map = '<img src="files/a.png" usemap="#m"><map name="m"><area shape="rect" coords="0,0,10,10" href="#settings"><area href="files/a.png"></map>';
    expect(shapeHtmlProblems(map)).toEqual(expect.arrayContaining(['<area> is not allowed', '<map> is not allowed']));
    expect(drawnModule!.sanitizeShapeHtml(map)).not.toMatch(/<area|<map/i);
    // A board from a host that skipped the store: an element with an href reaching the drawing still moves nothing.
    window.location.hash = '#thread=msg_keep';
    try {
      const { board } = await draw({ html: '<p id="settings">Kettle</p>' });
      const area = document.createElement('area');
      area.setAttribute('href', '#settings');
      const file = document.createElement('area');
      file.setAttribute('href', 'files/a.png');
      board.querySelector('p')!.append(area, file);
      for (const el of [area, file]) {
        const click = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true });
        await act(async () => {
          el.dispatchEvent(click);
        });
        expect(click.defaultPrevented).toBe(true);
      }
      expect(window.location.hash).toBe('#thread=msg_keep');
    } finally {
      window.location.hash = '';
    }
  });
});
