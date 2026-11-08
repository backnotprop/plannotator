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
 * - an icon, logo or drawn thing `shape update` stamped loses strokes, colour or
 *   its motion to the sanitizer, or keeps moving when motion is reduced;
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
import { expandShapeStamps } from '../../../shared/shape/stamps';

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

describe.skipIf(!hasDom)('icons, logos and drawn things by name (stamped by `shape update`)', () => {
  // Inside a drawing's own <svg>, as a board has them.
  const STAMPED = expandShapeStamps(
    '<svg viewBox="0 0 900 400"><svg data-icon="database" x="10" y="10" width="28" height="28" style="color:var(--blue)"/><svg data-logo="stripe" x="60" y="10"/><svg data-logo="github" x="110" y="10"/>'
      + '<svg data-draw="database" x="10" y="80" width="140" height="120" data-label="Postgres"/><svg data-draw="queue" x="200" y="80" width="200" height="60" data-label="jobs"/>'
      + '<svg data-draw="envelope" x="10" y="260" width="56" height="40" data-to="400 260"/></svg>',
  ).html;
  const shapes = (html: string) => html.match(/<(path|rect|ellipse|circle|text)\b/g)!.length;

  test('come through the same sanitizer whole: every stroke, the logo, the label and the motion', () => {
    const out = drawnModule!.sanitizeShapeHtml(STAMPED);
    expect(shapes(out)).toBe(shapes(STAMPED));
    expect(out).toContain('fill="#635BFF"');
    expect(out).toContain('fill:var(--ink)');
    expect(out).toMatch(/<g class="shp-go" style="--dx:\s*390px;\s*--dy:\s*0px;?">/);
    expect(out).toContain('>Postgres</text>');
  });

  test('a thing sent along moves, and holds still halfway when motion is reduced', async () => {
    const html = STAMPED;
    const moving = await draw({ html, reduce: false });
    expect(getComputedStyle(moving.shadow.querySelector('.shp-go')!).animation).toMatch(/^shp-go /);
    act(() => root?.unmount());
    const still = await draw({ html, reduce: true });
    const style = getComputedStyle(still.shadow.querySelector('.shp-go')!);
    expect(style.animation).toBe('none');
    expect(style.transform).toContain('/ 2');
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

  // A real board cut off at 390 px showed its left zone and no sign there was more to the right.
  test('a panning drawing shows which way there is more: that side fades, and a track follows the scroll', async () => {
    const real = window.getComputedStyle;
    window.getComputedStyle = ((el: Element) => { const cs = real.call(window, el); return new Proxy(cs, { get: (t, k) => (String(k).startsWith('padding') ? '0px' : Reflect.get(t, k)) }); }) as typeof window.getComputedStyle;
    try {
      const canvas = { html: '<p>x</p>', width: 1400, height: 620 };
      await draw({ html: '<p>x</p>', drawn: canvas, pan: true });
      const frame = container!.querySelector<HTMLElement>('.shp-drawn')!;
      const track = frame.querySelector<HTMLElement>('.shp-pan-track')!;
      expect(track).not.toBeNull();
      let at = 0;
      Object.defineProperty(frame, 'clientWidth', { configurable: true, get: () => 360 });
      Object.defineProperty(frame, 'scrollWidth', { configurable: true, get: () => 770 });
      Object.defineProperty(frame, 'scrollLeft', { configurable: true, get: () => at, set: (v: number) => { at = v; } });
      const scrollTo = (x: number) => act(() => { frame.scrollLeft = x; frame.dispatchEvent(new Event('scroll')); });
      const fades = () => [frame.style.getPropertyValue('--shp-fl'), frame.style.getPropertyValue('--shp-fr')];
      scrollTo(0);
      expect(fades()).toEqual(['0px', '28px']);
      scrollTo(200);
      expect(fades()).toEqual(['28px', '28px']);
      // The track stays in the middle of what shows, and its thumb is where you are.
      expect(track.style.left).toBe(`${200 + (360 - 56) / 2}px`);
      expect(parseFloat((track.firstElementChild as HTMLElement).style.left)).toBeCloseTo((200 / 770) * 100, 3);
      scrollTo(410);
      expect(fades()).toEqual(['28px', '0px']);
      expect(track.hidden).toBe(false);
      // A drawing that fits its frame does not pan: no track, no fade.
      Object.defineProperty(frame, 'scrollWidth', { configurable: true, get: () => 360 });
      scrollTo(0);
      expect(track.hidden).toBe(true);
      expect(fades()).toEqual(['0px', '0px']);
      act(() => root!.unmount());
      root = null;
      container!.remove();
      await draw({ html: '<p>x</p>', drawn: canvas });
      expect(container!.querySelector('.shp-pan-track')).toBeNull();
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

  // A <span> or <div> inside an <svg> ends the SVG where it stands in a browser, and all drawn after it was lost
  // (shapeKeepSvgWhole's parse5 test shows that parse; happy-dom drops the span instead).
  test('an HTML tag inside an SVG keeps the rest of the drawing; an empty <span data-ref> there is its number, once, in place', async () => {
    const { shadow } = await draw({
      html:
        '<svg viewBox="0 0 400 200"><g data-mark="queue"><rect class="ink" x="10" y="10" width="100" height="40"/><text x="20" y="35">Queue</text><span data-ref="1"></span></g>' +
        '<g data-mark="diff"><rect class="ink" x="200" y="10" width="100" height="40"/><text x="210" y="35">Diff <span data-ref="2"></span></text></g>' +
        '<div></div><circle id="last" cx="50" cy="150" r="9"/><text x="1" y="1">x</text><circle data-ref="3" r="4"/></svg>',
      refs: REFS,
    });
    const svg = shadow.querySelector('svg')!;
    const SVG_NS = 'http://www.w3.org/2000/svg';
    // Every part drawn after the span is still in the SVG, as SVG.
    expect(svg.querySelector('[data-mark="diff"] rect')?.namespaceURI).toBe(SVG_NS);
    expect(svg.querySelector('#last')?.namespaceURI).toBe(SVG_NS);
    // One number each, in the SVG, in the words it follows.
    for (const [n, words] of [[1, 'Queue'], [2, 'Diff']] as const) {
      const spots = shadow.querySelectorAll(`[data-ref="${n}"]`);
      expect(spots.length).toBe(1);
      const spot = spots[0]!;
      expect(spot.namespaceURI).toBe(SVG_NS);
      expect(spot.textContent).toBe(String(n));
      expect(spot.classList.contains('shp-rb')).toBe(true);
      expect(spot.closest('text')?.textContent?.startsWith(words)).toBe(true);
    }
    // A shape that is a number stays that shape.
    expect(shadow.querySelector('[data-ref="3"]')?.localName).toBe('circle');
  });

  test('an empty number in an SVG with no words before it goes to the nearest drawn words, else just after the SVG; never a hidden one', async () => {
    const { shadow } = await draw({
      html:
        '<svg><g><span data-ref="1"></span><rect width="9" height="9"/><text x="1" y="9">Label</text></g></svg>' +
        '<svg id="bare"><defs><text id="tucked">tucked</text></defs><span data-ref="2"></span><rect width="9" height="9"/></svg>',
      refs: REFS,
    });
    const one = shadow.querySelectorAll('[data-ref="1"]');
    expect(one.length).toBe(1);
    expect(one[0]!.closest('text')?.textContent).toBe('Label1');
    // No drawn words: a bubble just after the SVG, not one inside <defs>.
    const two = shadow.querySelectorAll('[data-ref="2"]');
    expect(two.length).toBe(1);
    expect(shadow.querySelector('#tucked')?.textContent).toBe('tucked');
    expect(two[0]!.localName).toBe('span');
    expect(two[0]!.previousElementSibling?.id).toBe('bare');
    expect(two[0]!.textContent).toBe('2');
  });

  test('kept pictures reach the host, in HTML and in SVG, and nothing else is rewritten', async () => {
    const { shadow } = await draw({ html: '<img src="files/a.png"><svg><image href="files/b.png"></image></svg><img src="data:image/png;base64,AAAA">', resolveSrc: (src) => `/assets/${src}` });
    const imgs = [...shadow.querySelectorAll('img')].map((i) => i.getAttribute('src'));
    expect(imgs).toEqual(['/assets/files/a.png', 'data:image/png;base64,AAAA']);
    expect(shadow.querySelector('image')?.getAttribute('href')).toBe('/assets/files/b.png');
  });

  test('darkContrast on a dark board: edges on zones that draw no line, a tile behind each kept SVG picture (never a logo or a framed one), and a light board left exactly as drawn', async () => {
    const { holdDarkBoard, releaseDarkBoard } = await import('./darkContrast');
    // A stand-in for the canvas: happy-dom resolves the variables below to plain rgb().
    const paint = (color: string) => {
      const m = /^rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(color);
      return m ? ([Number(m[1]), Number(m[2]), Number(m[3])] as const) : null;
    };
    const palette = (dark: boolean) => dark
      ? '.board { --paper: rgb(8 13 22); --ink: rgb(218 222 229); --grey: rgb(150 156 166); --surface: rgb(22 28 40); --rule: rgb(55 61 72); --blue: rgb(94 140 191); --blue-soft: rgb(13 24 39); --amber: rgb(193 147 86); --amber-soft: rgb(36 33 30); --green: rgb(90 170 120); --green-soft: rgb(12 30 25); --plum: rgb(180 100 150); --plum-soft: rgb(28 18 30); --alert: rgb(241 77 76); --alert-soft: rgb(38 16 20); }'
      : '.board { --paper: rgb(245 246 248); --ink: rgb(20 24 32); --grey: rgb(90 96 106); --surface: rgb(255 255 255); --rule: rgb(220 222 226); --blue: rgb(40 90 150); --blue-soft: rgb(225 233 243); --amber: rgb(150 100 20); --amber-soft: rgb(248 236 215); --green: rgb(30 110 70); --green-soft: rgb(222 240 230); --plum: rgb(130 50 100); --plum-soft: rgb(243 226 236); --alert: rgb(200 30 30); --alert-soft: rgb(250 225 225); }';
    const logo = expandShapeStamps('<svg data-logo="codex" x="0" y="0" width="40" height="40"/>').html;
    const html = `<svg><rect id="zone" width="300" height="200" style="fill:var(--blue-soft)"/><rect id="lined" width="80" height="60" style="fill:var(--amber-soft);stroke:var(--rule)"/>${logo}<image href="files/shot.png" x="10" y="20" width="100" height="50" transform="rotate(3)" data-step="2"/><image href="files/framed.png" x="0" y="0" width="80" height="80" clip-path="url(#c)"/><defs><pattern id="p"><image href="files/pat.png" width="8" height="8"/></pattern></defs><image href="files/nosize.png"/></svg><div id="hz" style="background: var(--amber-soft)">zone</div><img src="files/a.png">`;

    const dark = await draw({ html, css: palette(true), resolveSrc: (src) => `/assets/${src}`, darkContrast: true });
    expect(holdDarkBoard(dark.board, paint)).toBe(true);
    expect(dark.board.classList.contains('dark-hold')).toBe(true);
    // Every structural colour it set reads at 3:1 or more on what it meets (the rule itself: darkContrast.test.ts).
    expect(dark.board.style.getPropertyValue('--rule')).toMatch(/^rgb\(/);
    expect(dark.board.style.getPropertyValue('--shp-edge-blue')).toMatch(/^rgb\(/);
    expect(dark.shadow.getElementById('zone')?.getAttribute('data-shp-edge')).toBe('blue');
    expect(dark.shadow.getElementById('hz')?.getAttribute('data-shp-edge')).toBe('amber');
    // A zone that draws its own line keeps it (and its --rule is lifted instead).
    expect(dark.shadow.getElementById('lined')?.hasAttribute('data-shp-edge')).toBe(false);
    const tiles = [...dark.shadow.querySelectorAll('rect.shp-pic-tile')];
    expect(tiles).toHaveLength(1);
    expect(tiles[0]!.nextElementSibling?.getAttribute('href')).toBe('/assets/files/shot.png');
    expect(['x', 'y', 'width', 'height'].map((k) => Number(tiles[0]!.getAttribute(k)))).toEqual([4, 14, 112, 62]);
    // It turns and draws in with its picture.
    expect(tiles[0]!.getAttribute('transform')).toBe('rotate(3)');
    expect(tiles[0]!.getAttribute('data-step')).toBe('2');
    expect(dark.shadow.querySelector('svg[data-brand] image')?.hasAttribute('data-shp-pic')).toBe(false);
    // Taken back, nothing of it stays.
    releaseDarkBoard(dark.board);
    expect(dark.board.classList.contains('dark-hold')).toBe(false);
    expect(dark.board.getAttribute('style') ?? '').not.toMatch(/--rule|--surface|--grey|--shp-edge/);
    expect(dark.shadow.querySelectorAll('rect.shp-pic-tile, [data-shp-edge]')).toHaveLength(0);

    // A light board: the same drawing, with the opt-in and without, is the same DOM (but the pictures' own mark).
    const light = await draw({ html, css: palette(false), resolveSrc: (src) => `/assets/${src}`, darkContrast: true });
    const before = light.board.outerHTML;
    expect(holdDarkBoard(light.board, paint)).toBe(false);
    expect(light.board.outerHTML).toBe(before);
    const plain = await draw({ html, css: palette(false), resolveSrc: (src) => `/assets/${src}` });
    expect(before.replace(/ data-shp-pic=""/g, '')).toBe(plain.board.outerHTML);
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

