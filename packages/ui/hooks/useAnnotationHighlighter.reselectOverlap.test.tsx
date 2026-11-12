import { afterEach, describe, expect, test } from 'bun:test';
import React, { useRef } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Annotation } from '../types';

const hasDom = typeof document !== 'undefined';

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

function textAt(container: HTMLElement, needle: string): [Text, number] {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = node.textContent?.indexOf(needle) ?? -1;
    if (at >= 0) return [node as Text, at];
  }
  throw new Error(`no text "${needle}"`);
}

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

function paintedText(container: HTMLElement, id: string): string {
  return [...container.querySelectorAll<HTMLElement>('mark[data-highlight-id]')]
    .filter((mark) => mark.dataset.highlightId === id || (mark.dataset.highlightIdExtra ?? '').split(';').includes(id))
    .map((mark) => mark.textContent)
    .join('');
}

const quote = (from: string, to: string) => TEXT.slice(TEXT.indexOf(from), TEXT.indexOf(to) + to.length);

const OUTER = quote('Stripe answers', 'in flight');

const THIRD_SELECTIONS: { name: string; from: string; to: string; noEmptyMark: boolean }[] = [
  { name: 'the whole span again', from: 'Stripe answers', to: 'in flight', noEmptyMark: true },
  { name: 'from inside the nested highlight to the end', from: 'key', to: 'in flight', noEmptyMark: false },
  { name: 'from the start into the nested highlight', from: 'Stripe answers', to: 'idempotency', noEmptyMark: false },
];

describe('useAnnotationHighlighter: a selection over a highlight inside a highlight', () => {
  for (const third of THIRD_SELECTIONS) {
    test.skipIf(!hasDom)(`${third.name}: paints without throwing, and restores after a reload`, async () => {
      const added: Annotation[] = [];
      const { container } = await mount({ onAdd: (ann) => added.push(ann) });
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
      expect(paintedText(container, added[2]!.id)).toBe(expected);
      if (third.noEmptyMark) {
        expect([...container.querySelectorAll('mark')].filter((m) => m.textContent === '')).toEqual([]);
      }
      expect(container.textContent).toBe(TEXT);

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
