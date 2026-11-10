/**
 * A drag that starts in the document and is let go outside it still makes the
 * highlight.
 *
 * web-highlighter listens for the release on its root only, so a selection
 * dragged across some words and released left of the text, below the document,
 * over a side panel or outside the window stayed on screen as a plain
 * selection: no highlight, no toolbar. The hook now follows a press that
 * starts in the document to its release anywhere and commits the selection
 * through the same guard, snaps, quote repair and mode routing as a release
 * inside.
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { useRef } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnnotationType, type Annotation } from '../types';

const hasDom = typeof document !== 'undefined';

const mod = hasDom ? await import('./useAnnotationHighlighter') : null;
const useAnnotationHighlighter =
  mod?.useAnnotationHighlighter as typeof import('./useAnnotationHighlighter')['useAnnotationHighlighter'];

const FIRST = 'First paragraph alpha.';
const SECOND = 'Second paragraph beta.';
const THIRD = 'Third paragraph gamma.';
const HEAD = 'Page header.';
const PANEL = 'Panel comment text.';

type Mode = 'redline' | 'selection' | 'comment';
interface HookHandle {
  toolbarState: { selectionText: string } | null;
}

function Harness({ mode, onAdd, hookRef }: { mode: Mode; onAdd: (ann: Annotation) => void; hookRef: { current: HookHandle | null } }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hook = useAnnotationHighlighter({
    containerRef,
    annotations: [],
    selectedAnnotationId: null,
    mode,
    onAddAnnotation: onAdd,
  });
  hookRef.current = hook as unknown as HookHandle;
  return (
    <div>
      <header data-testid="head">{HEAD}</header>
      <div data-testid="gutter" />
      <div ref={containerRef} data-testid="doc">
        <p data-block-id="block-1">{FIRST}</p>
        <p data-block-id="block-2">
          {SECOND}
          <span className="annotation-exclude">Hidden</span>
        </p>
        <p data-block-id="block-3">{THIRD}</p>
      </div>
      <div data-testid="below" />
      <aside data-testid="panel">
        <p>{PANEL}</p>
      </aside>
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
  if (hasDom) {
    window.getSelection()?.removeAllRanges();
    document.body.innerHTML = '';
  }
});

async function mount(mode: Mode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  const added: Annotation[] = [];
  const hook: { current: HookHandle | null } = { current: null };
  root = createRoot(host);
  await act(async () => { root!.render(<Harness mode={mode} onAdd={(ann) => added.push(ann)} hookRef={hook} />); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

  const uncaught: string[] = [];
  errorListener = (event: Event) => {
    const e = event as ErrorEvent;
    uncaught.push(String(e.message ?? (e.error as Error | undefined)?.message ?? e));
  };
  window.addEventListener('error', errorListener);

  const q = (id: string) => host!.querySelector(`[data-testid="${id}"]`) as HTMLElement;
  const container = q('doc');
  const [first, second, third] = Array.from(container.children) as HTMLElement[];
  return {
    container, first: first!, second: second!, third: third!,
    head: q('head'), gutter: q('gutter'), below: q('below'), panel: q('panel'),
    added, hook, uncaught,
  };
}

const select = (start: Node, startOffset: number, end: Node, endOffset: number): Selection => {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
};

const mouse = (type: string, init: MouseEventInit = {}) =>
  new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === 'mouseup' ? 0 : 1, ...init });

/** Press on `from`, make the selection the drag would, let go on `to`. */
const drag = async (from: EventTarget, to: EventTarget, makeSelection: () => void, press: MouseEventInit = {}) => {
  await act(async () => {
    from.dispatchEvent(mouse('mousedown', press));
    makeSelection();
    to.dispatchEvent(mouse('mouseup', { button: press.button ?? 0 }));
    await new Promise((r) => setTimeout(r, 30));
  });
};

const paintedText = (container: HTMLElement): string =>
  Array.from(container.querySelectorAll('mark')).map((m) => m.textContent ?? '').join('');

describe('useAnnotationHighlighter: a drag let go outside the document', () => {
  test.skipIf(!hasDom)('left of the text: the same annotation as a release inside', async () => {
    const inside = await mount('redline');
    await drag(inside.first, inside.first, () => select(inside.first.firstChild!, 6, inside.first.firstChild!, 15));
    expect(inside.added.length).toBe(1);
    const want = inside.added[0]!;
    await act(async () => { root!.unmount(); });
    root = null;
    host!.remove();

    const { container, first, gutter, added, uncaught } = await mount('redline');
    await drag(first, gutter, () => select(first.firstChild!, 6, first.firstChild!, 15));

    expect(added.length).toBe(1);
    const got = added[0]!;
    expect(got.type).toBe(AnnotationType.DELETION);
    expect(got.originalText).toBe('paragraph');
    expect(got.originalText).toBe(want.originalText);
    expect(got.blockId).toBe(want.blockId);
    expect(got.startOffset).toBe(want.startOffset);
    expect(got.endOffset).toBe(want.endOffset);
    expect(got.startMeta).toEqual(want.startMeta);
    expect(got.endMeta).toEqual(want.endMeta);
    expect(paintedText(container)).toBe('paragraph');
    expect(uncaught).toEqual([]);
  });

  test.skipIf(!hasDom)('in selection mode the toolbar opens on it and the selection is gone, as inside', async () => {
    const { container, first, gutter, added, hook } = await mount('selection');

    await drag(first, gutter, () => select(first.firstChild!, 0, first.firstChild!, 5));

    expect(hook.current!.toolbarState?.selectionText).toBe('First');
    expect(paintedText(container)).toBe('First');
    expect(window.getSelection()!.isCollapsed).toBe(true);
    expect(added).toEqual([]);
  });

  test.skipIf(!hasDom)('below the document, the selection running into what follows: it stops at the document\'s end', async () => {
    const { container, second, below, added, uncaught } = await mount('redline');

    await drag(second, below, () => select(second.firstChild!, 7, below, 0));

    expect(added.length).toBe(1);
    expect(paintedText(container)).toBe('paragraph beta.' + THIRD);
    expect(uncaught).toEqual([]);
  });

  test.skipIf(!hasDom)('over a side panel, the selection reaching into its text: none of the panel\'s words are taken', async () => {
    const { container, panel, third, added } = await mount('redline');
    const panelText = panel.querySelector('p')!.firstChild!;

    await drag(third, panel, () => select(third.firstChild!, 6, panelText, 5));

    expect(added.length).toBe(1);
    expect(paintedText(container)).toBe('paragraph gamma.');
    expect(added[0]!.originalText.trim()).toBe('paragraph gamma.');
    expect(panel.querySelectorAll('mark').length).toBe(0);
  });

  test.skipIf(!hasDom)('dragged backwards past the top of the document: it starts at the document\'s first words', async () => {
    const { container, head, first, added } = await mount('redline');

    await drag(first, head, () => select(head.firstChild!, 5, first.firstChild!, 5));

    expect(added.length).toBe(1);
    expect(paintedText(container)).toBe('First');
    expect(added[0]!.originalText.trim()).toBe('First');
  });

  test.skipIf(!hasDom)('outside the window (the release reaches only the document)', async () => {
    const { container, first, added } = await mount('redline');

    await drag(first, document, () => select(first.firstChild!, 0, first.firstChild!, 5));

    expect(added.length).toBe(1);
    expect(paintedText(container)).toBe('First');
  });

  test.skipIf(!hasDom)('a release the page never hears (over a frame) is taken at the next move with no button down', async () => {
    const { container, first, gutter, added } = await mount('redline');

    await act(async () => {
      first.dispatchEvent(mouse('mousedown'));
      select(first.firstChild!, 0, first.firstChild!, 5);
      gutter.dispatchEvent(mouse('mousemove', { buttons: 1 }));
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(added).toEqual([]);

    await act(async () => {
      gutter.dispatchEvent(mouse('mousemove', { buttons: 0 }));
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(added.length).toBe(1);
    expect(paintedText(container)).toBe('First');
  });

  test.skipIf(!hasDom)('a host that stops the release on its way still gets the highlight', async () => {
    const { container, first, gutter, added } = await mount('redline');
    gutter.addEventListener('mouseup', (event) => event.stopPropagation());

    await drag(first, gutter, () => select(first.firstChild!, 0, first.firstChild!, 5));

    expect(added.length).toBe(1);
    expect(paintedText(container)).toBe('First');
  });

  test.skipIf(!hasDom)('a quote that runs through excluded text is repaired as for a release inside', async () => {
    const { second, third, gutter, added } = await mount('redline');

    await drag(second, gutter, () => select(second.firstChild!, 0, third.firstChild!, 5));

    expect(added.length).toBe(1);
    expect(added[0]!.originalText).not.toContain('Hidden');
    expect(added[0]!.originalText.replace(/\s+/g, '')).toBe((SECOND + 'Third').replace(/\s+/g, ''));
  });
});

describe('useAnnotationHighlighter: what a release outside must not do', () => {
  test.skipIf(!hasDom)('a release inside the document still makes one highlight, not two', async () => {
    const { container, first, added } = await mount('redline');

    await drag(first, first, () => select(first.firstChild!, 0, first.firstChild!, 5));

    expect(added.length).toBe(1);
    expect(container.querySelectorAll('mark').length).toBe(1);
  });

  test.skipIf(!hasDom)('a drag that starts outside the document and ends outside makes nothing', async () => {
    const { container, panel, second, gutter, added } = await mount('redline');
    const panelText = panel.querySelector('p')!.firstChild!;

    await drag(panel, gutter, () => select(second.firstChild!, 7, panelText, 5));

    expect(added).toEqual([]);
    expect(container.querySelectorAll('mark').length).toBe(0);
    // The person's selection is left alone.
    expect(window.getSelection()!.isCollapsed).toBe(false);
  });

  test.skipIf(!hasDom)('a selection made elsewhere, with an old press in the document long over, makes nothing', async () => {
    const { container, first, panel, added } = await mount('redline');
    const panelText = panel.querySelector('p')!.firstChild!;
    // A plain click in the document, then a drag inside the panel.
    await drag(first, first, () => {});

    await drag(panel, panel, () => select(panelText, 0, panelText, 5));

    expect(added).toEqual([]);
    expect(container.querySelectorAll('mark').length).toBe(0);
    expect(window.getSelection()!.toString()).toBe('Panel');
  });

  test.skipIf(!hasDom)('a press with another button is not followed', async () => {
    const { container, first, gutter, added } = await mount('redline');

    await drag(first, gutter, () => select(first.firstChild!, 0, first.firstChild!, 5), { button: 2 });

    expect(added).toEqual([]);
    expect(container.querySelectorAll('mark').length).toBe(0);
  });

  test.skipIf(!hasDom)('a whitespace-only selection let go outside makes nothing and throws nothing', async () => {
    const { container, first, second, gutter, added, uncaught } = await mount('redline');

    await drag(first, gutter, () => select(first.firstChild!, FIRST.length, second.firstChild!, 0));

    expect(added).toEqual([]);
    expect(container.querySelectorAll('mark').length).toBe(0);
    expect(uncaught).toEqual([]);
  });

  test.skipIf(!hasDom)('nothing is followed once the document is gone', async () => {
    const { first, gutter, added, uncaught } = await mount('redline');
    await act(async () => {
      first.dispatchEvent(mouse('mousedown'));
      select(first.firstChild!, 0, first.firstChild!, 5);
    });
    await act(async () => { root!.unmount(); });
    root = null;

    gutter.dispatchEvent(mouse('mouseup'));
    await new Promise((r) => setTimeout(r, 30));

    expect(added).toEqual([]);
    expect(uncaught).toEqual([]);
  });
});
