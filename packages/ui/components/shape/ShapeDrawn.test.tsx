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
    // c carries the drawing's own `stale` class and a padding note it wrote: a host's tags leave both alone.
    const html = '<div data-mark="a">A</div><div data-mark="b" style="padding-top: 6px">B</div><div data-mark="c" class="stale" data-shp-pad="99px">C</div>';
    const tags = { fresh: 'changed', stale: 'changed since asked' };
    const { board } = await draw({ html, marks: { ...NO_MARKS, fresh: new Set(['a']) }, stale: new Set(['b']), tags });
    const tagOf = (id: string) => board.querySelector(`[data-mark="${id}"]`)!.getAttribute('data-shp-tag');
    expect([tagOf('a'), tagOf('b'), tagOf('c')]).toEqual(['changed', 'changed since asked', null]);
    expect(board.querySelector('[data-mark="b"]')!.classList.contains('shp-stale')).toBe(true);
    expect(board.querySelector('[data-mark="c"]')!.classList.contains('stale')).toBe(true);
    // The tag sits inside its part, with room made above the part's words; an untagged part keeps its layout.
    const padOf = (id: string) => board.querySelector<HTMLElement>(`[data-mark="${id}"]`)!.style.paddingTop;
    expect([padOf('a'), padOf('b'), padOf('c')]).toEqual(['28px', '28px', '']);
    await act(async () => {
      root!.render(<ShapeDrawn drawn={{ html, css: '.x { color: red; }' }} reduce />);
    });
    expect([tagOf('a'), tagOf('b')]).toEqual([null, null]);
    expect(board.querySelector('[data-mark="b"]')!.classList.contains('shp-stale')).toBe(false);
    expect(board.querySelector('[data-mark="c"]')!.classList.contains('stale')).toBe(true);
    expect([padOf('a'), padOf('b'), padOf('c')]).toEqual(['', '6px', '']);
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

describe.skipIf(!hasDom)('a drawing with controls, own numbers and kept pictures', () => {
  const REFS: ShapeRef[] = [
    { n: 1, kind: 'image', title: 'The dialog', target: 'files/a.png' },
    { n: 2, kind: 'link', title: 'The docs', target: 'https://example.com/docs' },
    { n: 3, kind: 'pr', title: 'The PR', target: 'https://example.com/pr/1', images: [{ src: 'files/pr.png', alt: 'Its page' }] },
  ];
  const hit = (el: Element, type: string, init: Record<string, unknown> = {}) => act(async () => { el.dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true, composed: true }), init)); });

  test('a number with only blank space inside still shows its number', async () => {
    const { shadow } = await draw({ html: '<span data-ref="1"> </span><span data-ref="2">\n</span><span data-ref="3"><b>mine</b></span>', refs: [1, 2, 3].map((n) => ({ n, kind: 'file' as const, title: 'T', target: 'a.ts' })) });
    expect(shadow.querySelector('[data-ref="1"]')!.textContent).toBe('1');
    expect(shadow.querySelector('[data-ref="2"]')!.textContent).toBe('2');
    expect(shadow.querySelector('[data-ref="3"]')!.classList.contains('own')).toBe(true);
  });

  test('finger-sized numbers come with the bubble: a drawing with no peek keeps its size', async () => {
    const refs = [{ n: 1, kind: 'file' as const, title: 'T', target: 'a.ts' }];
    const plain = await draw({ html: '<span data-ref="1"></span>', refs });
    expect(plain.board.classList.contains('peek')).toBe(false);
    act(() => root!.unmount());
    root = null;
    container!.remove();
    const peeking = await draw({ html: '<span data-ref="1"></span>', refs, onRefPeek: () => {} });
    expect(peeking.board.classList.contains('peek')).toBe(true);
  });

  test('a host URL cannot break out of the picture attribute', async () => {
    const { shadow } = await draw({ html: '<img src="files/a.png">', resolveSrc: () => '/x"><b id="out">y&z' });
    expect(shadow.querySelector('#out')).toBeNull();
    expect(shadow.querySelector('img')!.getAttribute('src')).toBe('/x"><b id="out">y&z');
  });

  test('only a caller that asks for it pans a narrow canvas; anything else shrinks to fit', async () => {
    // This DOM measures 0 wide, which is narrow; its padding has to read as a number.
    const real = window.getComputedStyle;
    window.getComputedStyle = ((el: Element) => { const cs = real.call(window, el); return new Proxy(cs, { get: (t, k) => (String(k).startsWith('padding') ? '0px' : Reflect.get(t, k)) }); }) as typeof window.getComputedStyle;
    try {
      const canvas = { html: '<p>x</p>', width: 1000, height: 500 };
      await draw({ html: '<p>x</p>', drawn: canvas, pan: true });
      expect(container!.querySelector('.shp-drawn')!.classList.contains('pan')).toBe(true);
      act(() => root!.unmount());
      root = null;
      container!.remove();
      const { board } = await draw({ html: '<p>x</p>', drawn: canvas });
      expect(container!.querySelector('.shp-drawn')!.classList.contains('pan')).toBe(false);
      expect(board.style.transform).toBe('scale(0.2)');
    } finally {
      window.getComputedStyle = real;
    }
  });

  test('a radio the kit draws survives the sanitizer, with the name, class and checked its css reads', async () => {
    const { shadow } = await draw({ html: '<label class="pick on-a"><input type="radio" name="follow" class="f-a" checked=""><span>Path A</span></label><label class="pick"><input type="radio" name="follow" class="f-b"></label>' });
    const radios = [...shadow.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map((r) => [r.name, r.className, r.hasAttribute('checked')])).toEqual([['follow', 'f-a', true], ['follow', 'f-b', false]]);
    expect(shadow.querySelector('label.pick.on-a')).not.toBeNull();
  });

  test('an input still cannot load anything', async () => {
    const { shadow } = await draw({ html: '<input type="image" src="https://evil.invalid/x.png">' });
    expect(shadow.querySelector('input')?.getAttribute('src') ?? null).toBeNull();
  });

  test('a number the agent drew stays its own; an empty one gets its number; one with no reference goes', async () => {
    const { shadow } = await draw({ html: '<svg><g data-ref="1"><circle r="9"></circle></g></svg><span data-ref="2"></span><span data-ref="9">x</span>', refs: REFS });
    const own = shadow.querySelector('[data-ref="1"]')!;
    expect(own.querySelector('circle')).not.toBeNull();
    expect(own.classList.contains('own')).toBe(true);
    const plain = shadow.querySelector('[data-ref="2"]')!;
    expect(plain.textContent).toBe('2');
    expect(plain.classList.contains('own')).toBe(false);
    expect(shadow.querySelector('[data-ref="9"]')).toBeNull();
  });

  test('kept pictures reach the host, in HTML and in SVG, and nothing else is rewritten', async () => {
    const { shadow } = await draw({ html: '<img src="files/a.png"><svg><image href="files/b.png"></image></svg><img src="data:image/png;base64,AAAA">', resolveSrc: (src) => `/assets/${src}` });
    const imgs = [...shadow.querySelectorAll('img')].map((i) => i.getAttribute('src'));
    expect(imgs).toEqual(['/assets/files/a.png', 'data:image/png;base64,AAAA']);
    expect(shadow.querySelector('image')?.getAttribute('href')).toBe('/assets/files/b.png');
  });

  test('a mouse over a number peeks; leaving hides it; a click opens it', async () => {
    const peeks: [number | null, string][] = [];
    const opens: number[] = [];
    const { shadow } = await draw({ html: '<span data-ref="1"></span>', refs: REFS, onRefPeek: (n, _el, how) => peeks.push([n, how]), onRefOpen: (n) => opens.push(n) });
    const b = shadow.querySelector('[data-ref="1"]')!;
    expect(b.hasAttribute('title')).toBe(false);
    await hit(b, 'pointerover', { pointerType: 'mouse' });
    await hit(b, 'pointerout', { pointerType: 'mouse' });
    expect(peeks).toEqual([[1, 'hover'], [null, 'hover']]);
    await hit(b, 'click');
    expect(opens).toEqual([1]);
  });

  test('a finger: no hover, and a tap pins the bubble instead of opening', async () => {
    const peeks: [number | null, string][] = [];
    const opens: number[] = [];
    const { shadow } = await draw({ html: '<span data-ref="1"></span>', refs: REFS, onRefPeek: (n, _el, how) => peeks.push([n, how]), onRefOpen: (n) => opens.push(n) });
    const b = shadow.querySelector('[data-ref="1"]')!;
    await hit(b, 'pointerover', { pointerType: 'touch' });
    expect(peeks).toEqual([]);
    await hit(b, 'pointerdown', { pointerType: 'touch' });
    await hit(b, 'click');
    expect(peeks).toEqual([[1, 'tap']]);
    expect(opens).toEqual([]);
  });

  test('a link with a picture opens the picture; one without opens its page', async () => {
    const opens: number[] = [];
    const realOpen = window.open;
    const opened: unknown[] = [];
    window.open = ((url: string) => { opened.push(url); return null; }) as typeof window.open;
    try {
      const { shadow } = await draw({ html: '<span data-ref="3"></span><span data-ref="2"></span>', refs: REFS, onRefPeek: () => {}, onRefOpen: (n) => opens.push(n) });
      await hit(shadow.querySelector('[data-ref="3"]')!, 'click');
      expect(opens).toEqual([3]);
      expect(opened).toEqual([]);
      await hit(shadow.querySelector('[data-ref="2"]')!, 'click');
      expect(opened).toEqual(['https://example.com/docs']);
    } finally {
      window.open = realOpen;
    }
  });

  test('without a peek (a diagram in another host) a number keeps its title and opens as before', async () => {
    const opens: number[] = [];
    const { shadow } = await draw({ html: '<span data-ref="1"></span>', refs: REFS, onRefOpen: (n) => opens.push(n) });
    const b = shadow.querySelector('[data-ref="1"]')!;
    expect(b.getAttribute('title')).toBe('The dialog');
    await hit(b, 'pointerdown', { pointerType: 'touch' });
    await hit(b, 'click');
    expect(opens).toEqual([1]);
  });
});

