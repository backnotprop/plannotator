/**
 * A selection with nothing in it must not become an annotation (#881).
 *
 * Two failures this pins, both from ONE user gesture — a double-click at a
 * block boundary, which every browser answers with a non-collapsed selection
 * whose string is the break between the two blocks:
 *
 *  1. The quote is whitespace. web-highlighter paints an invisible highlight,
 *     the toolbar/composer opens on it, and acting on it stores an annotation
 *     with `originalText: "\n"` that no reload can re-anchor and that is still
 *     counted and exported. (Reproduced in Chromium against the annotate
 *     server; see the PR body.)
 *  2. The end boundary is an element with `endOffset === childNodes.length`.
 *     The library resolves that to `childNodes[offset]` — `undefined` — and
 *     `Cannot read properties of undefined (reading 'parentNode')` escapes its
 *     own pointer-end listener as an uncaught error.
 *
 * Both shapes reproduce in happy-dom, which is why this file drives the real
 * library over a real `mouseup` rather than asserting on the guard helpers.
 * The browser script that produced the same two symptoms through real mouse
 * gestures is kept out of the tree (scratchpad `881/repro5.mjs`).
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { useRef } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnnotationType, type Annotation } from '../types';

const hasDom = typeof document !== 'undefined';

// web-highlighter reads `window` at module-eval time; import lazily (the same
// pattern every DOM-gated sibling of this hook uses).
const mod = hasDom ? await import('./useAnnotationHighlighter') : null;
const useAnnotationHighlighter =
  mod?.useAnnotationHighlighter as typeof import('./useAnnotationHighlighter')['useAnnotationHighlighter'];
type Report = import('./useAnnotationHighlighter').AnnotationRestoreReport;

const FIRST = 'First paragraph alpha.';
const SECOND = 'Second paragraph beta.';

interface HookHandle {
  toolbarState: unknown;
  commentPopover: unknown;
  quickLabelPicker: unknown;
  applyAnnotations: (anns: Annotation[]) => void;
}

function Harness({
  mode,
  onAdd,
  hookRef,
  annotations = [],
  onReport,
}: {
  mode: 'redline' | 'selection' | 'comment';
  onAdd: (ann: Annotation) => void;
  hookRef: { current: HookHandle | null };
  annotations?: Annotation[];
  onReport?: (report: Report) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hook = useAnnotationHighlighter({
    containerRef,
    annotations,
    selectedAnnotationId: null,
    mode,
    onAddAnnotation: onAdd,
    onRestoreReport: onReport,
  });
  hookRef.current = hook as unknown as HookHandle;
  return (
    <div ref={containerRef}>
      <p data-block-id="block-1">{FIRST}</p>
      <p data-block-id="block-2">{SECOND}</p>
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

interface Mounted {
  container: HTMLElement;
  added: Annotation[];
  uncaught: string[];
  hook: { current: HookHandle | null };
  reports: Report[];
}

async function mount(mode: 'redline' | 'selection' | 'comment', annotations: Annotation[] = []): Promise<Mounted> {
  host = document.createElement('div');
  document.body.appendChild(host);
  const added: Annotation[] = [];
  const reports: Report[] = [];
  const hook: { current: HookHandle | null } = { current: null };
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <Harness
        mode={mode}
        onAdd={(ann) => added.push(ann)}
        hookRef={hook}
        annotations={annotations}
        onReport={(r) => reports.push(r)}
      />,
    );
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

  // happy-dom reports an exception thrown inside a dispatched listener as an
  // `error` event on window rather than rethrowing to the dispatcher, which is
  // exactly how a browser surfaces the uncaught TypeError this file is about.
  const uncaught: string[] = [];
  errorListener = (event: Event) => {
    const e = event as ErrorEvent;
    uncaught.push(String(e.message ?? (e.error as Error | undefined)?.message ?? e));
  };
  window.addEventListener('error', errorListener);

  return { container: host.firstElementChild as HTMLElement, added, uncaught, hook, reports };
}

const paragraphs = (container: HTMLElement) => ({
  first: container.children[0] as HTMLElement,
  second: container.children[1] as HTMLElement,
});

const select = (start: Node, startOffset: number, end: Node, endOffset: number): Selection => {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
};

const pointerEnd = async (container: HTMLElement) => {
  await act(async () => {
    container.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 20));
  });
};

describe('useAnnotationHighlighter: a selection with nothing to quote (#881)', () => {
  test.skipIf(!hasDom)('a whitespace-only selection at a block boundary creates nothing', async () => {
    const { container, added, uncaught, hook } = await mount('comment');
    const { first, second } = paragraphs(container);

    // What a double-click just past the end of a block leaves behind: a
    // non-collapsed selection that starts at the end of one block's text and
    // ends at the start of the next one's, carrying only the break between.
    const selection = select(first.firstChild!, FIRST.length, second.firstChild!, 0);
    expect(selection.isCollapsed).toBe(false);
    expect(selection.toString().trim()).toBe('');

    await pointerEnd(container);

    expect(added).toEqual([]);
    expect(hook.current!.commentPopover).toBeNull();
    expect(hook.current!.toolbarState).toBeNull();
    expect(hook.current!.quickLabelPicker).toBeNull();
    // Before the guard the library painted one empty <mark> per block.
    expect(container.querySelectorAll('mark').length).toBe(0);
    expect(uncaught).toEqual([]);
  });

  test.skipIf(!hasDom)('a whitespace-only selection in redline mode creates no annotation', async () => {
    // Redline commits on the spot, with no toolbar in between: the shortest
    // path from the boundary gesture to a stored `originalText: "\n"`.
    const { container, added, uncaught } = await mount('redline');
    const { first, second } = paragraphs(container);
    select(first.firstChild!, FIRST.length, second.firstChild!, 0);

    await pointerEnd(container);

    expect(added).toEqual([]);
    expect(container.querySelectorAll('mark').length).toBe(0);
    expect(uncaught).toEqual([]);
  });

  test.skipIf(!hasDom)('a boundary past an element\'s last child does not throw', async () => {
    const { container, added, uncaught } = await mount('selection');
    const { first } = paragraphs(container);

    // `endOffset === childNodes.length` is legal in the DOM and is what a
    // browser reports for a double-click at the end of the last block.
    const selection = select(first.firstChild!, 0, first, first.childNodes.length);
    expect(selection.isCollapsed).toBe(false);

    await pointerEnd(container);

    expect(uncaught).toEqual([]);
    expect(added).toEqual([]);
  });

  test.skipIf(!hasDom)('a selection running past the document into its scroll wrapper does not throw', async () => {
    // The shape a double-click past the end of the LAST block really produces
    // in Chromium: the selection ends in an empty element OUTSIDE the
    // annotation container (the scroll wrapper), so its common ancestor is
    // outside too. The library's own listener does not check containment
    // before serializing, so neither may the guard — this is the case a
    // containment bail used to hand straight to the serializer.
    const { container, added, uncaught } = await mount('selection');
    const { second } = paragraphs(container);
    const outside = document.createElement('div');
    container.parentElement!.appendChild(outside);
    expect(container.contains(outside)).toBe(false);

    select(second.firstChild!, SECOND.length, outside, 0);
    await pointerEnd(container);

    expect(uncaught).toEqual([]);
    expect(added).toEqual([]);
    expect(container.querySelectorAll('mark').length).toBe(0);
  });

  test.skipIf(!hasDom)('a real selection still anchors exactly as it did', async () => {
    // The regression pin: the guards must be invisible to every selection that
    // has something in it. These values are web-highlighter's own serialization
    // of a whole-paragraph selection, unchanged by this fix.
    const { container, added, uncaught } = await mount('redline');
    const { first } = paragraphs(container);
    select(first.firstChild!, 0, first.firstChild!, FIRST.length);

    await pointerEnd(container);

    expect(added.length).toBe(1);
    const ann = added[0]!;
    expect(ann.originalText).toBe(FIRST);
    expect(ann.type).toBe(AnnotationType.DELETION);
    expect(ann.blockId).toBe('block-1');
    expect(ann.startOffset).toBe(0);
    expect(ann.endOffset).toBe(FIRST.length);
    expect(ann.startMeta).toEqual({ parentTagName: 'P', parentIndex: 0, textOffset: 0 });
    expect(ann.endMeta).toEqual({ parentTagName: 'P', parentIndex: 0, textOffset: FIRST.length });
    expect(container.querySelector('mark')?.textContent).toBe(FIRST);
    expect(uncaught).toEqual([]);
  });

  test.skipIf(!hasDom)('a selection ending on an in-range element boundary still anchors', async () => {
    // The other half of the serializability rule, and the reason it is a
    // bounds check rather than "text boundaries only": Chromium ends an
    // ordinary multi-block drag (and a triple-click) on an ELEMENT boundary
    // whose offset is inside `childNodes`, which the library resolves and
    // serializes fine. Narrowing the predicate to text nodes would silently
    // drop those everyday selections.
    const { container, added, uncaught } = await mount('redline');
    const { first, second } = paragraphs(container);
    const selection = select(first.firstChild!, 0, second, 0);
    expect(selection.isCollapsed).toBe(false);
    // Read before the gesture: committing in redline mode clears the selection.
    const quote = selection.toString();
    expect(quote.trim()).not.toBe('');

    await pointerEnd(container);

    expect(added.length).toBe(1);
    expect(added[0]!.originalText).toBe(quote);
    expect(uncaught).toEqual([]);
  });
});

/** A draft written before the guard existed, or by any other producer. */
const BLANK_ROW: Annotation = {
  id: 'blank1',
  blockId: 'block-1',
  startOffset: FIRST.length,
  endOffset: FIRST.length + 1,
  type: AnnotationType.DELETION,
  originalText: '\n',
  createdA: 1,
  startMeta: { parentTagName: 'P', parentIndex: 0, textOffset: FIRST.length },
  endMeta: { parentTagName: 'P', parentIndex: 1, textOffset: 0 },
};

const REAL_ROW: Annotation = {
  id: 'real1',
  blockId: 'block-2',
  startOffset: 0,
  endOffset: SECOND.length,
  type: AnnotationType.COMMENT,
  text: 'this one is fine',
  originalText: SECOND,
  createdA: 2,
};

describe('useAnnotationHighlighter: restoring a stored blank quote (#881)', () => {
  test.skipIf(!hasDom)('is skipped, not painted and not reported, while its neighbours restore', async () => {
    const annotations = [BLANK_ROW, REAL_ROW];
    const { container, uncaught, hook, reports } = await mount('comment', annotations);

    await act(async () => {
      hook.current!.applyAnnotations(annotations);
      await new Promise((r) => setTimeout(r, 20));
    });

    const last = reports[reports.length - 1];
    expect(last).toBeDefined();
    expect(last!.attempted).not.toContain(BLANK_ROW.id);
    expect(last!.unanchored).not.toContain(BLANK_ROW.id);
    expect(container.querySelector(`[data-bind-id="${BLANK_ROW.id}"]`)).toBeNull();
    // The valid row beside it is untouched by the skip.
    expect(last!.attempted).toContain(REAL_ROW.id);
    expect(last!.unanchored).not.toContain(REAL_ROW.id);
    expect(container.querySelector(`[data-bind-id="${REAL_ROW.id}"]`)?.textContent).toBe(SECOND);
    expect(uncaught).toEqual([]);
  });
});
