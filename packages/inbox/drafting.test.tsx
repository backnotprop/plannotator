/**
 * A message being written with a drawing in it, as the open thread draws it
 * (prototype: live drawings; drafting.ts, components/LiveDrawings.tsx).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LiveDrawings } from './components/LiveDrawings';
import { DRAWING_ENTER_MS, drawablePartialSvg, noteDrafting } from './drafting';

const hasDom = typeof document !== 'undefined';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { root: Root; host: HTMLElement }[] = [];
afterEach(() => {
  for (const { root, host } of mounted.splice(0)) {
    act(() => root.unmount());
    host.remove();
  }
});

function mount(threadId: string, messages: number) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  const draw = (count: number) => act(() => root.render(<LiveDrawings threadId={threadId} messages={count} />));
  draw(messages);
  return { host, draw };
}

const svgOf = (img: Element) => decodeURIComponent(img.getAttribute('src')!.replace('data:image/svg+xml;charset=utf-8,', ''));

describe('drawablePartialSvg', () => {
  const whole = '<svg viewBox="0 0 680 200" xmlns="http://www.w3.org/2000/svg"><g fill="none"><rect x="10" y="10" width="80" height="40"/><text x="20" y="30">Docs &amp; index</text></g><path d="M0 0L10 10"/></svg>';

  test.skipIf(!hasDom)('every cut of a drawing closes what it opened, or draws nothing yet', () => {
    let drawn = 0;
    for (let cut = 0; cut <= whole.length; cut++) {
      const svg = drawablePartialSvg(whole.slice(0, cut));
      if (svg === null) continue;
      drawn += 1;
      expect(svg.endsWith('</svg>') || /^<svg[^<]*\/>$/.test(svg)).toBe(true);
      // An element with nothing in it yet may be written closed in itself.
      const opened = (svg.match(/<(g|text)(\s[^>]*)?>/g) ?? []).filter((tag) => !tag.endsWith('/>')).length;
      const closed = (svg.match(/<\/(g|text)>/g) ?? []).length;
      expect(closed).toBe(opened);
    }
    expect(drawn).toBeGreaterThan(whole.length / 2);
  });

  test.skipIf(!hasDom)('a shape is drawn once its tag is whole, and the tag being written is left out', () => {
    const svg = drawablePartialSvg('<svg viewBox="0 0 10 10"><g><rect id="a"/><circle id="b" cx="')!;
    expect(svg).toContain('id="a"');
    expect(svg).not.toContain('circle');
    expect(svg).toContain('0 0 10 10');
  });
});

describe('a shape comes in once', () => {
  const styleOf = (svg: string, id: string) => new RegExp(`id="${id}"[^>]*style="([^"]*)"`).exec(svg)?.[1] ?? new RegExp(`style="([^"]*)"[^>]*id="${id}"`).exec(svg)?.[1] ?? null;

  test.skipIf(!hasDom)('a new shape starts its entrance; in the next frame it carries on from its age, and a settled one has none', () => {
    const seen = new Map<number, number>();
    const first = drawablePartialSvg('<svg><defs><marker><path id="m"/></marker></defs><rect id="a"/>', { seen, now: 1000, reduced: false })!;
    expect(styleOf(first, 'a')).toContain(`animation:pn-in ${DRAWING_ENTER_MS}ms`);
    expect(styleOf(first, 'a')).toContain(' -0ms both');
    // An arrowhead's shape is drawn with its line, never on its own.
    expect(styleOf(first, 'm')).toBeNull();
    const next = drawablePartialSvg('<svg><defs><marker><path id="m"/></marker></defs><rect id="a"/><rect id="b"/>', { seen, now: 1120, reduced: false })!;
    expect(styleOf(next, 'a')).toContain(' -120ms both');
    expect(styleOf(next, 'b')).toContain(' -0ms both');
    const later = drawablePartialSvg('<svg><rect id="a"/><rect id="b"/>', { seen, now: 1000 + DRAWING_ENTER_MS, reduced: false })!;
    expect(styleOf(later, 'a')).toBeNull();
    expect(styleOf(later, 'b')).not.toBeNull();
    // Nothing left to come in: no keyframes either.
    expect(drawablePartialSvg('<svg><rect id="a"/><rect id="b"/>', { seen, now: 9000, reduced: false })).not.toContain('keyframes');
  });

  test.skipIf(!hasDom)('a shape with its own transform, or any shape under reduced motion, only fades; its own style is kept', () => {
    const moved = drawablePartialSvg('<svg><rect id="a" transform="rotate(10)" style="fill:red"/>', { seen: new Map(), now: 0, reduced: false })!;
    expect(styleOf(moved, 'a')).toContain('fill:red;animation:pn-fade');
    expect(styleOf(moved, 'a')).not.toContain('transform-origin');
    const calm = drawablePartialSvg('<svg><rect id="a"/>', { seen: new Map(), now: 0, reduced: true })!;
    expect(styleOf(calm, 'a')).toContain('animation:pn-fade');
  });
});

describe('LiveDrawings', () => {
  const frame = (body: string, done = false) => ({ call: 'call-1', session: 's1', thread_id: 'thr-live', body, done });

  test.skipIf(!hasDom)('the open thread draws the drawing as it grows, and it goes when the message lands', () => {
    const view = mount('thr-live', 1);
    expect(view.host.querySelector('[data-drafting]')).toBeNull();
    // Words only: nothing to draw yet.
    act(() => noteDrafting(frame('Here it is:\n')));
    expect(view.host.querySelector('[data-drafting]')).toBeNull();
    act(() => noteDrafting(frame('Here it is:\n```svg\n<svg viewBox="0 0 10 10"><rect id="a"/>')));
    expect(svgOf(view.host.querySelector('img')!)).toContain('id="a"');
    act(() => noteDrafting(frame('Here it is:\n```svg\n<svg viewBox="0 0 10 10"><rect id="a"/><rect id="b"/></svg>\n```', true)));
    expect(svgOf(view.host.querySelector('img')!)).toContain('id="b"');
    // Another thread's view never shows it.
    expect(mount('thr-other', 1).host.querySelector('[data-drafting]')).toBeNull();
    // The message landed.
    view.draw(2);
    expect(view.host.querySelector('[data-drafting]')).toBeNull();
  });

  test.skipIf(!hasDom)('a person replying while it is still being drawn does not take it away', () => {
    const view = mount('thr-live', 1);
    act(() => noteDrafting({ ...frame('```svg\n<svg><rect/>'), call: 'call-2' }));
    view.draw(2);
    expect(view.host.querySelector('[data-drafting="call-2"]')).not.toBeNull();
  });
});
