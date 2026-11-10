/**
 * Press and drag (`configurePlannotatorUI({ pressAndDrag: true })`): a
 * selection released OUTSIDE the document still becomes a highlight.
 *
 * The highlight itself is web-highlighter's (its `pressAndDrag` option). The
 * hook's part is to pass the option only when the host asked, and to check
 * the selection at a release anywhere on the page: the library then makes the
 * highlight on the next task, after the hook's guard, which the quote repair
 * and the #881 checks depend on.
 *
 * Two groups, chosen by what the installed library does, not by its version:
 *  - a library WITHOUT the option (0.8.2): turning the seam on changes nothing;
 *  - a library WITH it: the behaviour above. These run by themselves once the
 *    installed web-highlighter has the option.
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { useRef } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Annotation } from '../types';

const hasDom = typeof document !== 'undefined';

const mod = hasDom ? await import('./useAnnotationHighlighter') : null;
const policy = hasDom ? await import('../utils/pressAndDragPolicy') : null;
const useAnnotationHighlighter =
  mod?.useAnnotationHighlighter as typeof import('./useAnnotationHighlighter')['useAnnotationHighlighter'];

const pointer = (type: string, init: Record<string, unknown> = {}): Event => {
  const base = { bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true, pointerType: 'mouse', ...init };
  return typeof PointerEvent === 'function' ? new PointerEvent(type, base) : new MouseEvent(type, base);
};

/**
 * Whether the installed library has press and drag, asked of its behaviour: in
 * that mode a press followed by a native `dragstart` (a press on a link) is
 * cancelled so the drag selects instead.
 */
const libraryHasPressAndDrag = hasDom ? await (async () => {
  const { default: Highlighter } = await import('@plannotator/web-highlighter');
  const probe = document.createElement('div');
  probe.textContent = 'probe';
  document.body.appendChild(probe);
  const options: object = { $root: probe, pressAndDrag: true };
  const highlighter = new Highlighter(options);
  highlighter.run();
  probe.dispatchEvent(pointer('pointerdown', { clientX: 1, clientY: 1 }));
  const drag = new Event('dragstart', { bubbles: true, cancelable: true });
  probe.dispatchEvent(drag);
  highlighter.dispose();
  probe.remove();
  return drag.defaultPrevented;
})() : false;

const FIRST = 'First paragraph alpha.';
const SECOND = 'Second paragraph beta.';
const THIRD = 'Third paragraph gamma.';
const PANEL = 'Panel comment text.';

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
    <div>
      <div ref={containerRef} data-testid="doc">
        <p data-block-id="block-1">{FIRST}</p>
        <p data-block-id="block-2">
          {SECOND}
          <span className="annotation-exclude">Hidden</span>
        </p>
        <p data-block-id="block-3">{THIRD}</p>
      </div>
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
  policy?.resetPressAndDrag();
  if (hasDom) {
    window.getSelection()?.removeAllRanges();
    document.body.innerHTML = '';
  }
});

async function mount(pressAndDrag: boolean, threshold?: number) {
  policy!.setPressAndDrag(pressAndDrag, threshold);
  host = document.createElement('div');
  document.body.appendChild(host);
  const added: Annotation[] = [];
  root = createRoot(host);
  await act(async () => { root!.render(<Harness onAdd={(ann) => added.push(ann)} />); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

  const uncaught: string[] = [];
  errorListener = (event: Event) => {
    const e = event as ErrorEvent;
    uncaught.push(String(e.message ?? (e.error as Error | undefined)?.message ?? e));
  };
  window.addEventListener('error', errorListener);

  const container = host.querySelector('[data-testid="doc"]') as HTMLElement;
  const panel = host.querySelector('[data-testid="panel"]') as HTMLElement;
  const [first, second, third] = Array.from(container.children) as HTMLElement[];
  return { container, panel, first: first!, second: second!, third: third!, added, uncaught };
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

/** Press on `from`, drag `distance` px making `makeSelection`'s selection, release on `to`. */
const drag = async (from: HTMLElement, to: HTMLElement, makeSelection: () => void, distance = 80) => {
  await act(async () => {
    from.dispatchEvent(pointer('pointerdown', { clientX: 10, clientY: 10, buttons: 1 }));
    document.dispatchEvent(pointer('pointermove', { clientX: 10 + distance, clientY: 10, buttons: 1 }));
    makeSelection();
    to.dispatchEvent(pointer('pointerup', { clientX: 10 + distance, clientY: 10, buttons: 0 }));
    to.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 30));
  });
};

const paintedText = (container: HTMLElement): string =>
  Array.from(container.querySelectorAll('mark')).map((m) => m.textContent ?? '').join('');

const without = !hasDom || libraryHasPressAndDrag;
const withIt = !hasDom || !libraryHasPressAndDrag;

describe('useAnnotationHighlighter: pressAndDrag on a library without the option', () => {
  test.skipIf(without)('a release inside the document highlights as before', async () => {
    const { container, first, added, uncaught } = await mount(true);

    await drag(first, first, () => select(first.firstChild!, 0, first.firstChild!, 5));

    expect(added.length).toBe(1);
    expect(paintedText(container)).toBe('First');
    expect(uncaught).toEqual([]);
  });

  test.skipIf(without)('a release outside the document is still not looked at', async () => {
    // A whitespace-only selection: the guard collapses one it sees (#881).
    // Without the library's option it must not see a release out here.
    const { container, panel, first, second, added } = await mount(true);

    await drag(first, panel, () => select(first.firstChild!, FIRST.length, second.firstChild!, 0));

    expect(window.getSelection()!.isCollapsed).toBe(false);
    expect(added).toEqual([]);
    expect(container.querySelectorAll('mark').length).toBe(0);
  });
});

describe('useAnnotationHighlighter: pressAndDrag', () => {
  test.skipIf(withIt)('a selection released over a panel outside the document becomes a highlight', async () => {
    const { container, panel, first, added, uncaught } = await mount(true);

    await drag(first, panel, () => select(first.firstChild!, 0, first.firstChild!, 5));

    expect(added.length).toBe(1);
    expect(added[0]!.originalText).toBe('First');
    expect(paintedText(container)).toBe('First');
    expect(uncaught).toEqual([]);
  });

  test.skipIf(withIt)('off by default: the same release makes nothing', async () => {
    const { container, panel, first, added } = await mount(false);

    await drag(first, panel, () => select(first.firstChild!, 0, first.firstChild!, 5));

    expect(added).toEqual([]);
    expect(container.querySelectorAll('mark').length).toBe(0);
  });

  test.skipIf(withIt)('a release inside the document makes one highlight, not two', async () => {
    const { container, first, added } = await mount(true);

    await drag(first, first, () => select(first.firstChild!, 0, first.firstChild!, 5));

    expect(added.length).toBe(1);
    expect(container.querySelectorAll('mark').length).toBe(1);
  });

  test.skipIf(withIt)('the quote of a selection released outside is repaired like one released inside', async () => {
    // The selection runs THROUGH excluded text. The quote repair reads what
    // the guard recorded at the release, so the guard must have run for it.
    const { panel, second, third, added } = await mount(true);

    await drag(second, panel, () => select(second.firstChild!, 0, third.firstChild!, 5));

    expect(added.length).toBe(1);
    expect(added[0]!.originalText).not.toContain('Hidden');
    expect(added[0]!.originalText.replace(/\s+/g, '')).toBe((SECOND + 'Third').replace(/\s+/g, ''));
  });

  test.skipIf(withIt)('a selection the library cannot serialize, released outside, makes nothing and throws nothing', async () => {
    // #881: an end one past an element's last child.
    const { container, panel, first, added, uncaught } = await mount(true);

    await drag(first, panel, () => select(first.firstChild!, 0, first, first.childNodes.length));

    expect(uncaught).toEqual([]);
    expect(added).toEqual([]);
    expect(container.querySelectorAll('mark').length).toBe(0);
  });

  test.skipIf(withIt)('a selection made in the panel is left alone', async () => {
    // The guard hears every release on the page now; this one is not the
    // document's, and the person may be copying it.
    const { container, panel, added } = await mount(true);
    const panelText = panel.querySelector('p')!.firstChild!;

    await drag(panel, panel, () => select(panelText, 0, panelText, 5));

    expect(window.getSelection()!.toString()).toBe('Panel');
    expect(added).toEqual([]);
    expect(container.querySelectorAll('mark').length).toBe(0);
  });

  test.skipIf(withIt)('pressAndDragThreshold reaches the library: a shorter drag released outside is a click', async () => {
    const { container, panel, first, added } = await mount(true, 200);

    await drag(first, panel, () => select(first.firstChild!, 0, first.firstChild!, 5));

    expect(added).toEqual([]);
    expect(container.querySelectorAll('mark').length).toBe(0);
  });
});
