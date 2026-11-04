/**
 * Selecting a span again over two highlights, one inside the other, must
 * paint, not throw (seen while chasing #2594).
 *
 * The gesture: comment on "Stripe answers … still in flight" (it runs through
 * an inline `<code>`), comment on "idempotency key" inside that code, then
 * select the first span again. The second paint leaves the code's highlight
 * wrapper holding three text nodes: an empty one, the words, an empty one
 * (web-highlighter splits the text at both ends). The third selection takes
 * all three. Wrapping the first empty node splits that wrapper and puts copies
 * in its place, so the wrapper is out of the page; wrapping the last empty node
 * then calls `replaceChild` on the wrapper's parent, which is null:
 * `Cannot read properties of null (reading 'replaceChild')`, thrown out of the
 * library's own pointer-end listener with half the highlight painted and no
 * toolbar shown. In the Inbox it reproduced on desktop and on a phone, on a
 * Markdown attachment and on a message.
 *
 * Driven through the real library over a real `mouseup`, as its sibling
 * blankSelection test is. DOM-gated (DOM_TESTS=1).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { useRef } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Annotation } from '../types';

const hasDom = typeof document !== 'undefined';

// web-highlighter reads `window` at module-eval time; import lazily.
const mod = hasDom ? await import('./useAnnotationHighlighter') : null;
const useAnnotationHighlighter =
  mod?.useAnnotationHighlighter as typeof import('./useAnnotationHighlighter')['useAnnotationHighlighter'];

function Harness({ onAdd }: { onAdd: (ann: Annotation) => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  useAnnotationHighlighter({
    containerRef,
    annotations: [],
    selectedAnnotationId: null,
    mode: 'redline',
    onAddAnnotation: onAdd,
  });
  return (
    <div ref={containerRef}>
      <p data-block-id="block-1">
        {'Stripe answers 409 when a request with the same '}
        <code>idempotency key</code>
        {' is still in flight. See the docs.'}
      </p>
    </div>
  );
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let errorListener: ((event: Event) => void) | null = null;

afterEach(async () => {
  if (root) {
    await act(async () => { root!.unmount(); });
    root = null;
  }
  host?.remove();
  host = null;
  if (errorListener) {
    window.removeEventListener('error', errorListener);
    errorListener = null;
  }
  if (hasDom) document.body.innerHTML = '';
});

/** The text node holding `needle` now (painting replaces text nodes), and where in it. */
function textAt(container: HTMLElement, needle: string): [Text, number] {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = node.textContent?.indexOf(needle) ?? -1;
    if (at >= 0) return [node as Text, at];
  }
  throw new Error(`no text "${needle}"`);
}

/** Select from the start of `from` to the end of `to`, then release the pointer. */
async function selectAndRelease(container: HTMLElement, from: string, to: string): Promise<void> {
  const [start, startAt] = textAt(container, from);
  const [end, endAt] = textAt(container, to);
  const range = document.createRange();
  range.setStart(start, startAt);
  range.setEnd(end, endAt + to.length);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  await act(async () => {
    container.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 20));
  });
}

describe('useAnnotationHighlighter: selecting again over a highlight inside a highlight', () => {
  test.skipIf(!hasDom)('paints the third selection without throwing', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    const added: Annotation[] = [];
    root = createRoot(host);
    await act(async () => {
      root!.render(<Harness onAdd={(ann) => added.push(ann)} />);
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    // happy-dom reports an exception thrown inside a dispatched listener as an
    // `error` event on window, as a browser reports the uncaught TypeError.
    const uncaught: string[] = [];
    errorListener = (event: Event) => {
      const e = event as ErrorEvent;
      uncaught.push(String(e.message ?? (e.error as Error | undefined)?.message ?? e));
    };
    window.addEventListener('error', errorListener);
    const container = host.firstElementChild as HTMLElement;

    await selectAndRelease(container, 'Stripe answers', 'in flight');
    await selectAndRelease(container, 'idempotency key', 'idempotency key');
    await selectAndRelease(container, 'Stripe answers', 'in flight');

    expect(uncaught).toEqual([]);
    expect(added.map((a) => a.originalText)).toEqual([
      'Stripe answers 409 when a request with the same idempotency key is still in flight',
      'idempotency key',
      'Stripe answers 409 when a request with the same idempotency key is still in flight',
    ]);
    // Every word of the third span carries its highlight, and no highlight is empty.
    const third = [...container.querySelectorAll<HTMLElement>(`mark[data-highlight-id="${added[2]!.id}"]`)];
    expect(third.map((m) => m.textContent).join('')).toBe(added[2]!.originalText);
    expect([...container.querySelectorAll('mark')].filter((m) => m.textContent === '')).toEqual([]);
    // The text itself is untouched.
    expect(container.textContent).toBe('Stripe answers 409 when a request with the same idempotency key is still in flight. See the docs.');
  });
});
