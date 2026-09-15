/**
 * The alert title row carries chrome the reader cannot see: the visually
 * hidden "<Type>: " span that keeps the alert's type in its accessible name
 * (#1511). It sits inside `[data-block-id]`, so without `annotation-exclude`
 * it joins the annotation text stream — a drag that starts over the icon
 * quotes a word the reviewer never selected, and that quote is what the panel
 * shows, what the agent is handed, and what a share link has to find again by
 * text search (a search whose stream skips excluded nodes, so it cannot).
 *
 * Requires DOM (happy-dom) — runs under DOM_TESTS=1.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { useRef } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnnotationType, type Annotation } from '../../types';
import { fromShareable, toShareable } from '../../utils/sharing';

const hasDom = typeof document !== 'undefined';

// web-highlighter reads `window` at module-eval time; import lazily.
const hookMod = hasDom ? await import('../../hooks/useAnnotationHighlighter') : null;
const useAnnotationHighlighter =
  hookMod?.useAnnotationHighlighter as typeof import('../../hooks/useAnnotationHighlighter')['useAnnotationHighlighter'];
type HookReturn = import('../../hooks/useAnnotationHighlighter').UseAnnotationHighlighterReturn;
const alertMod = hasDom ? await import('./AlertBlock') : null;
const AlertBlock = alertMod?.AlertBlock as typeof import('./AlertBlock')['AlertBlock'];

const BODY = '**Browser quirks**\n\nSafari drops the label when ALPHA happens.';

function Harness({ resultRef, added, body }: {
  resultRef: { current: HookReturn | null };
  added: Annotation[];
  body: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  resultRef.current = useAnnotationHighlighter({
    containerRef,
    annotations: [],
    onAddAnnotation: (ann) => { added.push(ann); },
    selectedAnnotationId: null,
    mode: 'comment',
    verifyRestoredContent: true,
  });
  return (
    <div ref={containerRef}>
      <AlertBlock blockId="alert-1" kind="tip" body={body} />
      <p data-block-id="p-1">Trailing paragraph BRAVO.</p>
    </div>
  );
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(
  added: Annotation[],
  options: { body?: string } = {},
): Promise<{ current: HookReturn | null }> {
  host = document.createElement('div');
  document.body.appendChild(host);
  const resultRef: { current: HookReturn | null } = { current: null };
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <Harness resultRef={resultRef} added={added} body={options.body ?? BODY} />,
    );
  });
  return resultRef;
}

/** Whitespace-free comparison: the painted marks carry no separator between
 *  elements while the selection string does. */
const compact = (value: string): string => value.replace(/\s+/g, '');

/** Everything the highlighter painted, in document order. */
const paintedText = (): string =>
  Array.from(document.querySelectorAll('mark.annotation-highlight'))
    .map((el) => el.textContent ?? '')
    .join('');

/** The text node holding a piece of the rendered document. */
const textNodeWith = (selector: string, needle: string): Text => {
  const walkerRoot = Array.from(document.querySelectorAll(selector))
    .find((el) => (el.textContent ?? '').includes(needle));
  if (!walkerRoot) throw new Error(`Fixture no longer renders "${needle}" under ${selector}`);
  const walker = document.createTreeWalker(walkerRoot, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if ((node.textContent ?? '').includes(needle)) return node as Text;
  }
  throw new Error(`Fixture no longer holds "${needle}" in one text node`);
};

/** The hidden "<Type>: " span that rides the alert's title row. */
const hiddenTypeWord = (): Text => {
  const node = document.querySelector('.alert-title .sr-only')?.firstChild;
  if (!node || node.nodeType !== Node.TEXT_NODE) {
    throw new Error('Expected the title row to render its hidden type word');
  }
  return node as Text;
};

afterEach(async () => {
  if (root) {
    await act(async () => { root!.unmount(); });
    root = null;
  }
  host?.remove();
  host = null;
  if (hasDom) document.body.innerHTML = '';
});

/** A drag that starts at the left edge of the title row (over the icon, where
 *  the hidden type word lives) and ends at the end of the title. */
function titleRowRange(): Range {
  const srOnly = document.querySelector('.alert-title .sr-only');
  const titleText = Array.from(document.querySelectorAll('.alert-title span'))
    .map((el) => el.lastChild)
    .find((node) => node?.nodeType === Node.TEXT_NODE && node.textContent?.includes('Browser quirks'));
  if (!srOnly?.firstChild || !titleText) throw new Error('Expected the title row to render its hidden type word and title');
  const range = document.createRange();
  range.setStart(srOnly.firstChild, 0);
  range.setEnd(titleText, titleText.textContent!.length);
  return range;
}

describe('alert title annotations', () => {
  test.skipIf(!hasDom)('a selection from the icon does not quote the hidden type word', async () => {
    const added: Annotation[] = [];
    const hook = await mount(added);
    await act(async () => { hook.current!.highlightRange(titleRowRange()); });
    await act(async () => { hook.current!.handleCommentSubmit('tighten this'); });

    expect(added).toHaveLength(1);
    expect(added[0]!.originalText).toBe('Browser quirks');
    // The hidden word is never wrapped either.
    expect(document.querySelector('.sr-only mark')).toBeNull();
  });

  test.skipIf(!hasDom)('an ordinary selection keeps its quote byte for byte', async () => {
    // The repair only ever removes excluded chrome: a selection that touches
    // none must come through untouched, punctuation and all.
    const added: Annotation[] = [];
    const hook = await mount(added);
    const body = Array.from(document.querySelectorAll('p'))
      .find((p) => (p.textContent ?? '').includes('ALPHA'));
    const text = body?.firstChild;
    if (!text) throw new Error('Alert body did not render');
    const start = text.textContent!.indexOf('Safari');
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, text.textContent!.length);
    await act(async () => { hook.current!.highlightRange(range); });
    await act(async () => { hook.current!.handleCommentSubmit('why?'); });

    expect(added[0]!.originalText).toBe('Safari drops the label when ALPHA happens.');
  });

  test.skipIf(!hasDom)('a drag from the icon through the body paints the title too', async () => {
    // web-highlighter never enters an excluded subtree, so a range that STARTS
    // in the hidden span used to leave every run before the last one
    // unpainted: the reviewer dragged over title and body and got the body
    // alone, with the invisible word still in the quote.
    const added: Annotation[] = [];
    const hook = await mount(added);
    const body = textNodeWith('.alert-body p', 'Safari');
    const range = document.createRange();
    range.setStart(hiddenTypeWord(), 0);
    range.setEnd(body, body.length);
    await act(async () => { hook.current!.highlightRange(range); });
    await act(async () => { hook.current!.handleCommentSubmit('rewrite this'); });

    expect(paintedText()).toBe('Browser quirksSafari drops the label when ALPHA happens.');
    expect(added[0]!.originalText).not.toContain('Tip');
    expect(compact(added[0]!.originalText)).toBe(compact(paintedText()));
  });

  test.skipIf(!hasDom)('a title carrying inline markup is painted whole', async () => {
    // The title row is several text nodes once it holds a code span, so this
    // is the shape a start-of-range fix has to cover rather than the
    // single-text-node title that works by accident.
    const added: Annotation[] = [];
    const hook = await mount(added, { body: '**Browser `quirks` here**\n\nSafari drops the label when ALPHA happens.' });
    const lastTitleText = textNodeWith('.alert-title', ' here');
    const range = document.createRange();
    range.setStart(hiddenTypeWord(), 0);
    range.setEnd(lastTitleText, lastTitleText.length);
    await act(async () => { hook.current!.highlightRange(range); });
    await act(async () => { hook.current!.handleCommentSubmit('rename this'); });

    expect(paintedText()).toBe('Browser quirks here');
    expect(added[0]!.originalText).not.toContain('Tip');
  });

  test.skipIf(!hasDom)('a share link of that annotation restores onto the title', async () => {
    const added: Annotation[] = [];
    const first = await mount(added);
    await act(async () => { first.current!.highlightRange(titleRowRange()); });
    await act(async () => { first.current!.handleCommentSubmit('tighten this'); });
    // A share payload carries the quote and nothing else — the recipient's
    // restore is a text search over the rendered document.
    const shared = fromShareable(toShareable(added));
    await act(async () => { root!.unmount(); });
    root = null;
    host?.remove();
    document.body.innerHTML = '';

    const second = await mount([]);
    await act(async () => { second.current!.applyAnnotations(shared); });

    const mark = document.querySelector<HTMLElement>(`[data-bind-id="${shared[0]!.id}"], [data-highlight-id="${shared[0]!.id}"]`);
    expect(mark?.textContent).toBe('Browser quirks');
    expect(mark?.closest('.alert-title')).not.toBeNull();
  });
});
