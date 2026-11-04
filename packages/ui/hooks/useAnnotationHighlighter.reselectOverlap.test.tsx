/**
 * A selection over two highlights, one inside the other, must paint, not
 * throw (seen while chasing #2594).
 *
 * The gesture: comment on "Stripe answers … still in flight" (it runs through
 * an inline `<code>`), comment on "idempotency key" inside that code, then make
 * a third selection that crosses the code's highlight: the whole span again,
 * from inside the code to the end, or from the start into the code. The second
 * paint leaves the code's highlight wrapper holding three text nodes: an empty
 * one, the words, an empty one (web-highlighter splits the text at both ends).
 * The third selection takes the empty ones along. Wrapping one of them splits
 * that wrapper and puts copies in its place, so the wrapper is out of the page;
 * wrapping the next node in it then calls `replaceChild` on the wrapper's
 * parent, which is null: `Cannot read properties of null (reading
 * 'replaceChild')`, thrown out of the library's own pointer-end listener with
 * half the highlight painted and no toolbar shown. In the built Inbox it
 * reproduced on a Markdown attachment, on desktop and on a phone. All three
 * selections threw before the fix.
 *
 * Each case also reloads: a fresh mount restores the three stored comments
 * from their saved positions, and each paints exactly its own words.
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
type Report = import('./useAnnotationHighlighter').AnnotationRestoreReport;

const HEAD = 'Stripe answers 409 when a request with the same ';
const CODE = 'idempotency key';
const TAIL = ' is still in flight. See the docs.';
const TEXT = HEAD + CODE + TAIL;

interface HookHandle {
  applyAnnotations: (anns: Annotation[]) => void;
}

function Harness({
  onAdd,
  hookRef,
  annotations = [],
  onMismatch,
  onReport,
}: {
  onAdd: (ann: Annotation) => void;
  hookRef: { current: HookHandle | null };
  annotations?: Annotation[];
  onMismatch?: (ann: Annotation, painted: string) => void;
  onReport?: (report: Report) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hook = useAnnotationHighlighter({
    containerRef,
    annotations,
    selectedAnnotationId: null,
    mode: 'redline',
    onAddAnnotation: onAdd,
    verifyRestoredContent: true,
    onRestoreMismatch: onMismatch,
    onRestoreReport: onReport,
  });
  hookRef.current = hook as unknown as HookHandle;
  return (
    <div ref={containerRef}>
      <p data-block-id="block-1">
        {HEAD}
        <code>{CODE}</code>
        {TAIL}
      </p>
    </div>
  );
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let errorListener: ((event: Event) => void) | null = null;

async function unmount(): Promise<void> {
  if (root) {
    await act(async () => { root!.unmount(); });
    root = null;
  }
  host?.remove();
  host = null;
}

afterEach(async () => {
  await unmount();
  if (errorListener) {
    window.removeEventListener('error', errorListener);
    errorListener = null;
  }
  if (hasDom) document.body.innerHTML = '';
});

async function mount(props: Omit<Parameters<typeof Harness>[0], 'hookRef'>): Promise<{ container: HTMLElement; hook: { current: HookHandle | null } }> {
  host = document.createElement('div');
  document.body.appendChild(host);
  const hook: { current: HookHandle | null } = { current: null };
  root = createRoot(host);
  await act(async () => {
    root!.render(<Harness {...props} hookRef={hook} />);
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  return { container: host.firstElementChild as HTMLElement, hook };
}

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

/** The words painted for `id`: every mark naming it, as its own id or under another (the library's getDoms rule). */
function paintedText(container: HTMLElement, id: string): string {
  return [...container.querySelectorAll<HTMLElement>('mark[data-highlight-id]')]
    .filter((mark) => mark.dataset.highlightId === id || (mark.dataset.highlightIdExtra ?? '').split(';').includes(id))
    .map((mark) => mark.textContent)
    .join('');
}

/** The words from the start of `from` to the end of `to`. */
const quote = (from: string, to: string) => TEXT.slice(TEXT.indexOf(from), TEXT.indexOf(to) + to.length);

const OUTER = quote('Stripe answers', 'in flight');

const THIRD_SELECTIONS: { name: string; from: string; to: string; noEmptyMark: boolean }[] = [
  { name: 'the whole span again', from: 'Stripe answers', to: 'in flight', noEmptyMark: true },
  // The library still leaves an empty <mark> beside these two (harmless: no text, no throw).
  { name: 'from inside the nested highlight to the end', from: 'key', to: 'in flight', noEmptyMark: false },
  { name: 'from the start into the nested highlight', from: 'Stripe answers', to: 'idempotency', noEmptyMark: false },
];

describe('useAnnotationHighlighter: a selection over a highlight inside a highlight', () => {
  for (const third of THIRD_SELECTIONS) {
    test.skipIf(!hasDom)(`${third.name}: paints without throwing, and restores after a reload`, async () => {
      const added: Annotation[] = [];
      const { container } = await mount({ onAdd: (ann) => added.push(ann) });
      // happy-dom reports an exception thrown inside a dispatched listener as an
      // `error` event on window, as a browser reports the uncaught TypeError.
      const uncaught: string[] = [];
      errorListener = (event: Event) => {
        const e = event as ErrorEvent;
        uncaught.push(String(e.message ?? (e.error as Error | undefined)?.message ?? e));
      };
      window.addEventListener('error', errorListener);

      await selectAndRelease(container, 'Stripe answers', 'in flight');
      await selectAndRelease(container, CODE, CODE);
      await selectAndRelease(container, third.from, third.to);

      expect(uncaught).toEqual([]);
      const expected = quote(third.from, third.to);
      expect(added.map((a) => a.originalText)).toEqual([OUTER, CODE, expected]);
      // Every word of the third selection carries its highlight.
      expect(paintedText(container, added[2]!.id)).toBe(expected);
      if (third.noEmptyMark) {
        expect([...container.querySelectorAll('mark')].filter((m) => m.textContent === '')).toEqual([]);
      }
      // The text itself is untouched.
      expect(container.textContent).toBe(TEXT);

      // Reload: a fresh document restores the three from their saved positions.
      await unmount();
      const mismatches: string[] = [];
      const reports: Report[] = [];
      const reloaded = await mount({
        onAdd: () => {},
        annotations: added,
        onMismatch: (ann, painted) => mismatches.push(`${ann.id}: ${painted}`),
        onReport: (report) => reports.push(report),
      });
      await act(async () => {
        reloaded.hook.current!.applyAnnotations(added);
        await new Promise((r) => setTimeout(r, 20));
      });

      expect(uncaught).toEqual([]);
      expect(mismatches).toEqual([]);
      expect(reports.length).toBeGreaterThan(0);
      expect(reports.at(-1)!.unanchored).toEqual([]);
      for (const ann of added) expect(paintedText(reloaded.container, ann.id)).toBe(ann.originalText);
      expect(reloaded.container.textContent).toBe(TEXT);
    });
  }
});
