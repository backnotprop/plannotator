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
 * of per line, keyboard focus dropped to the page when a fold closes or its last
 * comment goes, a click in a fold opening a new comment on the line above, the
 * code shifting when the first comment comes, an easing that lags an edit, or
 * the opt-in leaking into other hosts.
 *
 * Pierre's `File` is replaced by a stub that draws each line annotation through
 * the view's `renderAnnotation` and keeps the props it was given, so a line
 * click or a range is reported the way Pierre reports one.
 */
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CodeAnnotation } from '../types';
import type { CodeFileAnnotationInput } from './CodeFilePopout';

const hasDom = typeof document !== 'undefined';

interface StubFileProps {
  lineAnnotations?: { lineNumber: number; metadata?: unknown }[];
  renderAnnotation?: (annotation: { lineNumber: number; metadata?: unknown }) => React.ReactNode;
  options?: {
    unsafeCSS?: string;
    onLineClick?: (props: { lineNumber: number; lineElement: HTMLElement; event: Event }) => void;
    onLineSelectionEnd?: (range: { start: number; end: number } | null) => void;
  };
}

let lastProps: StubFileProps = {};
const realPierreDiffsReact = { ...(await import('@pierre/diffs/react')) };
mock.module('@pierre/diffs/react', () => ({
  ...realPierreDiffsReact,
  File: function StubFile(props: StubFileProps) {
    lastProps = props;
    const { lineAnnotations = [], renderAnnotation } = props;
    return (
      <div>
        <div data-stub-line="7">const a = 1;</div>
        {lineAnnotations.map((a, i) => <div key={i} data-row={a.lineNumber}>{renderAnnotation?.(a)}</div>)}
      </div>
    );
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
  lastProps = {};
  if (hasDom) document.body.replaceChildren();
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
const fileArea = () => host!.firstElementChild as HTMLElement;
const composer = () => document.querySelector('[data-comment-popover]');
const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const click = async (el: HTMLElement | null) => {
  if (!el) throw new Error('nothing to click');
  await act(async () => el.click());
};
const cardButton = (id: string, title: string) =>
  host!.querySelector<HTMLButtonElement>(`[data-code-annotation-id="${id}"] button[title="${title}"]`);

/** Pierre reporting a line click from a click on `target` (its listener reads the event while it is dispatched). */
async function lineClickFrom(target: HTMLElement, lineNumber: number) {
  await act(async () => {
    const listener = (event: Event) => lastProps.options!.onLineClick!({ lineNumber, lineElement: target, event });
    target.addEventListener('click', listener, { once: true });
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
  });
}

describe.if(hasDom)('CodeFileView comment folds', () => {
  test('a host that passes nothing keeps every comment open under its line, with no bubble or row rule', async () => {
    await view({ annotations: [A, B, RANGE] });
    expect(host!.querySelector('[data-code-comment-bubble]')).toBeNull();
    expect(host!.querySelectorAll('[data-code-annotation-id]').length).toBe(3);
    expect(host!.querySelectorAll('[data-row]').length).toBe(3);
    expect(lastProps.options?.unsafeCSS ?? '').not.toContain('max-content');
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
    expect(bubble(42)!.getAttribute('aria-controls')).toBe(reveal(42).id);
    // The row is kept as tall as its fold, so an open card never covers the next lines.
    expect(lastProps.options!.unsafeCSS).toMatch(/\[data-line-annotation\]\s*\{[^}]*height:\s*max-content/);
  });

  test('a file that takes comments has the bubble\'s gutter before its first comment, so the code never shifts', async () => {
    const redraw = await view({ annotations: [], commentMarkers: 'bubble', onAddAnnotation: () => {} });
    const before = lastProps.options!.unsafeCSS;
    expect(before).toMatch(/\[data-column-number\]\s*\{\s*padding-left/);
    await redraw({ annotations: [A], commentMarkers: 'bubble', onAddAnnotation: () => {} });
    expect(lastProps.options!.unsafeCSS).toBe(before);
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

  test('Hide and a delete leave keyboard focus on a bubble or the file, never on the page', async () => {
    const deleted: string[] = [];
    const props = (annotations: CodeAnnotation[]): ViewProps => ({
      annotations,
      commentMarkers: 'bubble',
      onDeleteAnnotation: (id) => deleted.push(id),
    });
    const redraw = await view(props([A, B, RANGE]));
    await click(bubble(42));
    const hide = host!.querySelector<HTMLButtonElement>('[data-code-comment-fold="42"] [data-code-comment-hide]')!;
    hide.focus();
    await click(hide);
    expect(isOpen(42)).toBe(false);
    expect(document.activeElement).toBe(bubble(42));

    // One of two comments: the bubble stays, focus goes to it.
    await click(bubble(42));
    await click(cardButton('b', 'Delete comment'));
    expect(deleted).toEqual(['b']);
    expect(document.activeElement).toBe(bubble(42));
    await redraw(props([A, RANGE]));

    // The line's last comment: its bubble goes too, focus moves to the next bubble.
    await click(cardButton('a', 'Delete comment'));
    await redraw(props([RANGE]));
    expect(document.activeElement).toBe(bubble(52));

    // The file's last comment: focus stays in the file.
    await click(bubble(52));
    await click(cardButton('r', 'Delete comment'));
    await redraw(props([]));
    expect(document.activeElement).toBe(fileArea());
    expect(deleted).toEqual(['b', 'a', 'r']);
  });

  test('a click or a press inside a fold never opens a new comment on the line above', async () => {
    await view({ annotations: [A], commentMarkers: 'bubble', onAddAnnotation: () => {} });
    await click(bubble(42));
    const card = host!.querySelector<HTMLElement>('[data-code-annotation-id="a"]')!;

    await lineClickFrom(card, 42);
    expect(composer()).toBeNull();
    await act(async () => {
      card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
      lastProps.options!.onLineSelectionEnd!({ start: 42, end: 42 });
    });
    expect(composer()).toBeNull();

    // A line's own click still opens the composer.
    const line = host!.querySelector<HTMLElement>('[data-stub-line]')!;
    await act(async () => { line.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true })); });
    await lineClickFrom(line, 7);
    expect(composer()).not.toBeNull();
  });

  test('edit and delete stay on the open card', async () => {
    const edits: string[] = [];
    const deletes: string[] = [];
    await view({
      annotations: [A, B],
      commentMarkers: 'bubble',
      onEditAnnotation: (id) => edits.push(id),
      onDeleteAnnotation: (id) => deletes.push(id),
    });
    await click(bubble(42));
    await click(cardButton('a', 'Delete comment'));
    expect(deletes).toEqual(['a']);
    await click(cardButton('a', 'Edit comment'));
    const card = host!.querySelector<HTMLElement>('[data-code-annotation-id="a"]')!;
    await click([...card.querySelectorAll('button')].find((b) => b.textContent === 'Save') ?? null);
    expect(edits).toEqual(['a']);
  });

  test('choosing a comment opens its fold; folding it away lets go of it once closed', async () => {
    const chosen: (string | null)[] = [];
    const redraw = await view({ annotations: [A, RANGE], commentMarkers: 'bubble', onSelectAnnotation: (id) => chosen.push(id) });
    await redraw({ annotations: [A, RANGE], commentMarkers: 'bubble', selectedAnnotationId: 'r', onSelectAnnotation: (id) => chosen.push(id) });
    expect(isOpen(52)).toBe(true);
    expect(isOpen(42)).toBe(false);
    await click(bubble(52));
    expect(isOpen(52)).toBe(false);
    await wait(300);
    expect(chosen).toEqual([null]);
  });

  test('an edit put back opens its comment\'s fold, its edit box holding those words', async () => {
    const onEditAnnotation = () => {};
    const redraw = await view({ annotations: [A, RANGE], commentMarkers: 'bubble', onEditAnnotation });
    await redraw({ annotations: [A, RANGE], commentMarkers: 'bubble', onEditAnnotation, reopenEdit: { id: 'r', text: 'Retry only the 409.' } });
    expect(isOpen(52)).toBe(true);
    expect(isOpen(42)).toBe(false);
    expect(reveal(52).querySelector('textarea')?.value).toBe('Retry only the 409.');
  });

  test('a view gone before its fold closed never lets go of the comment afterwards', async () => {
    const chosen: (string | null)[] = [];
    await view({ annotations: [RANGE], commentMarkers: 'bubble', selectedAnnotationId: 'r', onSelectAnnotation: (id) => chosen.push(id) });
    await click(bubble(52));
    await act(async () => root!.unmount());
    root = null;
    await wait(300);
    expect(chosen).toEqual([]);
  });

  test('a comment saved here shows where it landed; comments loaded later stay folded', async () => {
    const added: CodeFileAnnotationInput[] = [];
    const props = (annotations: CodeAnnotation[]): ViewProps => ({
      annotations,
      commentMarkers: 'bubble',
      onAddAnnotation: (a) => added.push(a),
    });
    // The host's records arrive after the first draw: they stay folded.
    const redraw = await view(props([]));
    await redraw(props([A]));
    expect(isOpen(42)).toBe(false);

    // The pointer over the file is where the composer opens (the file area remembers it).
    await act(async () => {
      fileArea().dispatchEvent(new PointerEvent('pointermove', { clientX: 100, clientY: 200, bubbles: true }));
    });
    await act(async () => { lastProps.options!.onLineSelectionEnd!({ start: 50, end: 52 }); });
    const area = document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(area, RANGE.text);
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));
    });
    expect(added.map((a) => [a.lineStart, a.lineEnd])).toEqual([[50, 52]]);
    await redraw(props([A, RANGE]));
    expect(isOpen(52)).toBe(true);
    expect(isOpen(42)).toBe(false);
  });

  test('the fold eases out only while it opens or closes, and not at all under reduced motion', async () => {
    await view({ annotations: [A], commentMarkers: 'bubble' });
    await wait(40);
    await click(bubble(42));
    expect(reveal(42).style.transition).toContain('height');
    expect(reveal(42).style.transition).not.toMatch(/ease-in|linear/);
    // Open and still: the height follows the card at once, so an edit never lags behind a clip.
    await wait(400);
    expect(isOpen(42)).toBe(true);
    expect(reveal(42).style.transition).toBe('none');
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
      await wait(40);
      await click(bubble(42));
      expect(isOpen(42)).toBe(true);
      expect(reveal(42).style.transition).toBe('none');
    } finally {
      window.matchMedia = realMatchMedia;
    }
  });
});
