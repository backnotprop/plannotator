/**
 * Saved comments folded behind a bubble (DOM-gated). The Inbox's file panes opt
 * in (`commentMarkers="bubble"`): each line's comments sit behind one bubble in
 * the gutter of their last line, closed until clicked, and open in a row under
 * the line that pushes the code down. Every other host passes nothing and keeps
 * every comment drawn open under its line.
 *
 * What regresses: a card drawn open by default in the Inbox (it covered the
 * code), the row losing the rule that gives it height (Pierre's grid collapses
 * an annotation row in a fixed-height pane, so the open card covers the next
 * lines), a fold that will not close or reopen, one bubble per comment instead
 * of per line, or the opt-in leaking into other hosts.
 *
 * Pierre's `File` is replaced by a stub that draws each line annotation through
 * the view's `renderAnnotation` and keeps the CSS it was given.
 */
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CodeAnnotation } from '../types';

const hasDom = typeof document !== 'undefined';

interface StubFileProps {
  lineAnnotations?: { lineNumber: number; metadata?: unknown }[];
  renderAnnotation?: (annotation: { lineNumber: number; metadata?: unknown }) => React.ReactNode;
  options?: { unsafeCSS?: string };
}

let lastCss = '';
const realPierreDiffsReact = { ...(await import('@pierre/diffs/react')) };
mock.module('@pierre/diffs/react', () => ({
  ...realPierreDiffsReact,
  File: function StubFile({ lineAnnotations = [], renderAnnotation, options }: StubFileProps) {
    lastCss = options?.unsafeCSS ?? '';
    return <div>{lineAnnotations.map((a, i) => <div key={i} data-row={a.lineNumber}>{renderAnnotation?.(a)}</div>)}</div>;
  },
}));

const popoutModule = hasDom ? await import('./CodeFilePopout') : null;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  lastCss = '';
});

afterAll(() => {
  mock.module('@pierre/diffs/react', () => realPierreDiffsReact);
});

const comment = (id: string, lineStart: number, lineEnd: number, text: string): CodeAnnotation => ({
  id,
  type: 'comment',
  filePath: 'src/retry/worker.ts',
  lineStart,
  lineEnd,
  side: 'new',
  text,
  createdAt: 0,
});

const A = comment('a', 42, 42, 'Keep the flag off for invoices over $10k.');
const B = comment('b', 42, 42, 'Also log the key.');
const RANGE = comment('r', 50, 52, 'Retry only the conflict.');

type ViewProps = Partial<React.ComponentProps<NonNullable<typeof popoutModule>['CodeFileView']>>;

async function view(props: ViewProps): Promise<(next: ViewProps) => Promise<void>> {
  const CodeFileView = popoutModule!.CodeFileView;
  host = document.createElement('div');
  document.body.appendChild(host);
  const draw = (p: ViewProps) => (
    <CodeFileView filepath="src/retry/worker.ts" contents={'const a = 1;\n'.repeat(60)} commentCard="plain" {...p} />
  );
  await act(async () => {
    root = createRoot(host!);
    root.render(draw(props));
  });
  return async (next) => {
    await act(async () => root!.render(draw(next)));
  };
}

const bubble = (line: number) => host!.querySelector<HTMLButtonElement>(`[data-code-comment-bubble="${line}"]`);
const reveal = (line: number) => host!.querySelector<HTMLElement>(`[data-code-comment-fold="${line}"] [data-code-comment-reveal]`)!;
const isOpen = (line: number) => bubble(line)?.getAttribute('aria-expanded') === 'true' && reveal(line).hasAttribute('data-open');
const click = async (el: HTMLElement | null) => {
  if (!el) throw new Error('nothing to click');
  await act(async () => el.click());
};

describe.if(hasDom)('CodeFileView comment folds', () => {
  test('a host that passes nothing keeps every comment open under its line, with no bubble or row rule', async () => {
    await view({ annotations: [A, B, RANGE] });
    expect(host!.querySelector('[data-code-comment-bubble]')).toBeNull();
    expect(host!.querySelectorAll('[data-code-annotation-id]').length).toBe(3);
    expect(host!.querySelectorAll('[data-row]').length).toBe(3);
    expect(lastCss).not.toContain('max-content');
  });

  test('one bubble per line, with a count, on the last line of a range; all closed at first', async () => {
    await view({ annotations: [A, B, RANGE], commentMarkers: 'bubble' });
    expect(host!.querySelectorAll('[data-code-comment-bubble]').length).toBe(2);
    expect(bubble(42)!.textContent).toBe('2');
    expect(bubble(52)!.textContent).toBe('');
    expect(bubble(50)).toBeNull();
    expect(isOpen(42)).toBe(false);
    expect(isOpen(52)).toBe(false);
    // Folded comments are out of reach of the keyboard and screen readers.
    expect(reveal(42).hasAttribute('inert')).toBe(true);
    expect(reveal(42).getAttribute('aria-hidden')).toBe('true');
    expect(reveal(42).style.height).toBe('0px');
    // The row is kept as tall as its fold, so an open card never covers the next lines.
    expect(lastCss).toMatch(/\[data-line-annotation\]\s*\{[^}]*height:\s*max-content/);
  });

  test('the bubble opens and closes its fold; the card\'s Hide closes it too', async () => {
    await view({ annotations: [A, B], commentMarkers: 'bubble' });
    await click(bubble(42));
    expect(isOpen(42)).toBe(true);
    expect(reveal(42).hasAttribute('inert')).toBe(false);
    // One Hide per fold.
    expect(host!.querySelectorAll('[data-code-comment-fold="42"] [data-code-comment-hide]').length).toBe(1);
    await click(bubble(42));
    expect(isOpen(42)).toBe(false);
    await click(bubble(42));
    await click(host!.querySelector('[data-code-comment-hide]'));
    expect(isOpen(42)).toBe(false);
  });

  test('edit and delete stay on the open card', async () => {
    const edits: string[] = [];
    const deletes: string[] = [];
    await view({
      annotations: [A],
      commentMarkers: 'bubble',
      onEditAnnotation: (id) => edits.push(id),
      onDeleteAnnotation: (id) => deletes.push(id),
    });
    await click(bubble(42));
    const card = host!.querySelector<HTMLElement>('[data-code-annotation-id="a"]')!;
    await click(card.querySelector<HTMLButtonElement>('button[title="Delete comment"]'));
    expect(deletes).toEqual(['a']);
    await click(card.querySelector<HTMLButtonElement>('button[title="Edit comment"]'));
    await click([...card.querySelectorAll('button')].find((b) => b.textContent === 'Save') ?? null);
    expect(edits).toEqual(['a']);
  });

  test('choosing a comment opens its fold; folding it away lets go of it', async () => {
    const chosen: (string | null)[] = [];
    const redraw = await view({ annotations: [A, RANGE], commentMarkers: 'bubble', onSelectAnnotation: (id) => chosen.push(id) });
    await redraw({ annotations: [A, RANGE], commentMarkers: 'bubble', selectedAnnotationId: 'r', onSelectAnnotation: (id) => chosen.push(id) });
    expect(isOpen(52)).toBe(true);
    expect(isOpen(42)).toBe(false);
    await click(bubble(52));
    expect(isOpen(52)).toBe(false);
    // Let go once the fold has closed (the host's redraw would cut the motion short).
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    expect(chosen).toEqual([null]);
  });

  test('a comment saved while the file is open shows where it landed', async () => {
    const redraw = await view({ annotations: [A], commentMarkers: 'bubble' });
    expect(isOpen(42)).toBe(false);
    await redraw({ annotations: [A, RANGE], commentMarkers: 'bubble' });
    expect(isOpen(52)).toBe(true);
    expect(isOpen(42)).toBe(false);
  });

  test('the fold moves with an ease-out, and not at all under reduced motion', async () => {
    const frame = () => act(async () => { await new Promise((r) => setTimeout(r, 40)); });
    await view({ annotations: [A], commentMarkers: 'bubble' });
    await frame();
    expect(reveal(42).style.transition).toContain('cubic-bezier(0.23, 1, 0.32, 1)');
    expect(reveal(42).style.transition).not.toMatch(/ease-in|linear/);
    await act(async () => root!.unmount());
    root = null;
    host!.remove();

    const realMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      ...realMatchMedia.call(window, query),
      matches: query.includes('prefers-reduced-motion'),
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as typeof window.matchMedia;
    try {
      await view({ annotations: [A], commentMarkers: 'bubble' });
      await frame();
      await click(bubble(42));
      expect(isOpen(42)).toBe(true);
      expect(reveal(42).style.transition).toBe('none');
    } finally {
      window.matchMedia = realMatchMedia;
    }
  });
});
