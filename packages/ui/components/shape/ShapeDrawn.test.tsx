/**
 * A drawn view is an agent's HTML (DOM-gated, DOM_TESTS=1). What regresses if
 * these fail:
 * - the agent's markup runs script, loads from outside the board, or keeps
 *   its own <style>;
 * - the view's css leaks out of its shadow root, or css that loads from
 *   outside the board is kept;
 * - a bubble for a reference the board does not have shows as a dead number;
 * - a part's `data-code` no longer reaches the host, so a diagram outside the
 *   board (code review's "show me how this works") cannot open the code;
 * - while pointing (Change it / Ask), a marked part opens the code instead of
 *   being picked, or a bad `data-code` reaches the host.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ShapeCodeTarget, ShapeRef } from '@plannotator/core/shape';
import { bridgeSanitizerDom } from '../../../../tests/helpers/chat-sanitizer-dom';

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
  test('keeps the drawing and drops script, handlers, outside loads and its own <style>', async () => {
    const { board } = await draw({
      html: '<div data-mark="k" data-code="src/kettle.ts#L1" onclick="window.__pwned=1">Kettle</div><script>window.__pwned=1</script><img src="https://evil.test/x.png"><iframe src="https://evil.test"></iframe><style>body{display:none}</style><svg><rect class="ink" width="4" height="4"/><foreignObject width="9" height="9"><div data-mark="label" onmouseover="x()">Label</div></foreignObject></svg><a href="https://example.com/pr/1">PR</a>',
    });
    const kettle = board.querySelector('[data-mark="k"]')!;
    expect(kettle.textContent).toBe('Kettle');
    expect(kettle.getAttribute('data-code')).toBe('src/kettle.ts#L1');
    expect(board.innerHTML).not.toMatch(/onclick|onmouseover|<script|<iframe|<style|evil\.test/);
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
    const outside = await draw({ html: '<p>Kettle</p>', css: '@import url(https://evil.test/a.css); .y { color: blue; }' });
    expect(outside.shadow.querySelector('style')!.textContent).not.toContain('evil.test');
    expect(outside.shadow.querySelector('style')!.textContent).not.toContain('.y { color: blue; }');
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
});
