/**
 * The resize edge's tip (shell/CollapsibleEdge.tsx, used by the sidebar's edge and the list column's): it sat under
 * the pointer and landed on a routine's name beside the edge. Now it follows the pointer up and down only, sits left,
 * over the panel the edge resizes, opens after 600 ms (a pointer passing through to a row opens nothing), and goes
 * with its edge. What regresses: the tip back under the pointer (over the rows), a short delay, or a tip left behind.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { CollapsibleEdge, EDGE_TIP_DELAY_MS } = (hasDom ? await import('./CollapsibleEdge') : {}) as typeof import('./CollapsibleEdge');

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const wait = (ms: number) => act(async () => await new Promise((resolve) => setTimeout(resolve, ms)));

function edge(onCollapse?: () => void) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const draw = (shown: boolean) =>
    act(() =>
      root!.render(
        shown ? (
          <CollapsibleEdge label="Sidebar width" onCollapse={onCollapse} isDragging={false} resize={{ value: 240, min: 200, max: 400, resizeTo: () => {} }}>
            <div className="ib-handle-hit" />
          </CollapsibleEdge>
        ) : null,
      ),
    );
  draw(true);
  return { host, draw };
}

/** The edge stands 240px in, as beside a sidebar (happy-dom lays nothing out). */
async function hover(el: Element) {
  (el as HTMLElement).getBoundingClientRect = () => ({ x: 240, y: 0, left: 240, top: 0, right: 240, bottom: 768, width: 0, height: 768, toJSON: () => ({}) }) as DOMRect;
  await act(async () => {
    for (const type of ['pointerenter', 'pointerover', 'mouseenter', 'mouseover']) el.dispatchEvent(new MouseEvent(type, { bubbles: type.endsWith('over'), clientX: 240, clientY: 300 }));
    el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 240, clientY: 300 }));
  });
}

const tip = () => document.querySelector('.ib-edge-tip-pos');

test.skipIf(!hasDom)('the edge tip waits 600 ms, then opens left of the edge, over the panel it resizes', async () => {
  expect(EDGE_TIP_DELAY_MS).toBeGreaterThanOrEqual(600);
  const { host } = edge(() => {});
  await hover(host.querySelector('[role="separator"]')!);
  await wait(350);
  expect(tip()).toBeNull();
  await wait(EDGE_TIP_DELAY_MS);
  expect(tip()?.getAttribute('data-side')).toBe('left');
  expect(document.querySelector('.ib-edge-tip')?.textContent).toBe('Click to collapse, drag to resize');
});

test.skipIf(!hasDom)('an edge with nothing to collapse says Drag to resize, also on the left; the tip goes with its edge', async () => {
  const { host, draw } = edge();
  await hover(host.querySelector('[role="separator"]')!);
  await wait(EDGE_TIP_DELAY_MS + 100);
  expect(tip()?.getAttribute('data-side')).toBe('left');
  expect(document.querySelector('.ib-edge-tip')?.textContent).toBe('Drag to resize');
  draw(false);
  await wait(50);
  expect(document.querySelector('.ib-edge-tip')).toBeNull();
});
