/**
 * The selection toolbar of a text selection made with a finger (issue #1041):
 * the toolbar a painted selection gets, above the selection while it is still
 * the system's. Where it sits and that a press leaves the selection where it
 * is (AnnotationToolbar's `unpainted`), what each button hands the hook, and
 * that the markdown Viewer shows it and acts on its buttons. DOM-gated
 * (DOM_TESTS=1).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnnotationType, type Annotation, type EditorMode, type HostDraft } from '../types';
import type { TouchSelectionOffer } from '../hooks/useAnnotationHighlighter';
import type { SelectionAction } from '../utils/selectionActions';
import type { ToolbarRect } from '../utils/touchToolbarPlacement';
import { THUMBS_UP_LABEL } from '../utils/quickLabels';
import { TOUCH_SELECTION_SETTLE_MS } from '../utils/touchSelection';

const hasDom = typeof document !== 'undefined';
const toolbarModule = hasDom ? await import('./TouchSelectionToolbar') : null;
const paintedModule = hasDom ? await import('./AnnotationToolbar') : null;
const viewerModule = hasDom ? await import('./Viewer') : null;
const parserModule = hasDom ? await import('../utils/parser') : null;

let root: Root | null = null;
let host: HTMLElement | null = null;
const restorers: Array<() => void> = [];

function stubProperty(target: object, key: string, descriptor: PropertyDescriptor) {
  const own = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, ...descriptor });
  restorers.push(() => {
    if (own) Object.defineProperty(target, key, own);
    else delete (target as Record<string, unknown>)[key];
  });
}

const rect = (left: number, top: number, width: number, height: number): ToolbarRect => ({
  left, top, right: left + width, bottom: top + height,
});

/** A 390x844 phone whose main pointer is a finger (or, with `pointer: 'fine'`, a computer); the toolbar measures 276x54. The host did NOT opt into `touchSelectionToolbar`. */
function screen(pointer: 'coarse' | 'fine') {
  stubProperty(window, 'matchMedia', {
    value: (query: string) => ({
      matches: query.includes(`pointer: ${pointer}`),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    }),
    writable: true,
  });
  stubProperty(window, 'innerWidth', { value: 390 });
  stubProperty(window, 'innerHeight', { value: 844 });
  stubProperty(window, 'visualViewport', { value: null });
  const measured = (size: number) => function (this: HTMLElement) {
    return this.classList?.contains('annotation-toolbar') ? size : 0;
  };
  stubProperty(HTMLElement.prototype, 'offsetWidth', { get: measured(276) });
  stubProperty(HTMLElement.prototype, 'offsetHeight', { get: measured(54) });
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  while (restorers.length) restorers.pop()!();
  if (hasDom) {
    window.getSelection()?.removeAllRanges();
    document.body.replaceChildren();
  }
});

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
const rest = () => act(async () => { await new Promise((r) => setTimeout(r, TOUCH_SELECTION_SETTLE_MS + 80)); });

/** The toolbar of a resting touch selection, and one of its buttons by name. */
const offerBox = () => document.querySelector<HTMLElement>('.annotation-toolbar[data-pn-touch-selection-offer]');
const button = (name: string) => offerBox()?.querySelector<HTMLButtonElement>(`button[title="${name}"]`) ?? null;
const buttonNames = () => Array.from(offerBox()?.querySelectorAll('button') ?? []).map((b) => b.getAttribute('title') ?? b.textContent?.trim() ?? '');

interface Calls {
  annotated: AnnotationType[];
  commented: Array<string | undefined>;
  labelled: string[];
  closed: number;
}

async function mountToolbar(anchor: { current: ToolbarRect | null }, mode: EditorMode = 'selection') {
  screen('coarse');
  const calls: Calls = { annotated: [], commented: [], labelled: [], closed: 0 };
  const element = document.createElement('p');
  element.textContent = 'The selected words are in this paragraph.';
  document.body.appendChild(element);
  const offer: TouchSelectionOffer = {
    element,
    selectionText: 'selected words',
    getAnchorRect: () => anchor.current,
    getRichCopy: () => null,
    mode,
    onAnnotate: (type) => calls.annotated.push(type),
    onRequestComment: (initialChar) => calls.commented.push(initialChar),
    onQuickLabel: (label) => calls.labelled.push(label.text),
    onClose: () => { calls.closed += 1; },
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    const TouchSelectionToolbar = toolbarModule!.TouchSelectionToolbar;
    root.render(<TouchSelectionToolbar offer={offer} />);
  });
  await settle();
  return calls;
}

describe('TouchSelectionToolbar', () => {
  test.skipIf(!hasDom)('sits above the selection, centered, clear of iOS\'s menu band and the start handle, and follows it as the page scrolls', async () => {
    const anchor = { current: rect(100, 300, 200, 40) as ToolbarRect | null };
    await mountToolbar(anchor);

    // Over the selection's top (300), past the 60px band where iOS draws its
    // menu above a selection; centered on it (200 - 138).
    const box = offerBox()!;
    expect(box.dataset.pnAnnotationToolbarTouch).toBe('above');
    const top = parseFloat(box.style.top);
    expect(top + box.getBoundingClientRect().height).toBeLessThanOrEqual(300 - 60);
    expect(parseFloat(box.style.left)).toBe(62);

    // The page scrolls 80px: the selection moved, and so did the toolbar.
    anchor.current = rect(100, 220, 200, 40);
    await act(async () => { window.dispatchEvent(new Event('scroll')); });
    expect(parseFloat(offerBox()!.style.top)).toBe(top - 80);
  });

  test.skipIf(!hasDom)('goes below a selection with no room above it, and hides while the selection is scrolled out of sight', async () => {
    const anchor = { current: rect(100, 40, 200, 40) as ToolbarRect | null };
    await mountToolbar(anchor);
    expect(offerBox()!.dataset.pnAnnotationToolbarTouch).toBe('below');
    expect(parseFloat(offerBox()!.style.top)).toBeGreaterThan(80);

    anchor.current = rect(100, -400, 200, 40);
    await act(async () => { window.dispatchEvent(new Event('scroll')); });
    expect(offerBox()!.style.visibility).toBe('hidden');
  });

  test.skipIf(!hasDom)('a press leaves the selection on the page; a painted selection\'s toolbar is not touched by that', async () => {
    await mountToolbar({ current: rect(100, 200, 200, 40) });

    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    button('Comment')!.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);

    // The same toolbar on a painted selection, as before.
    await act(async () => root?.unmount());
    root = null;
    const painted = document.createElement('mark');
    painted.textContent = 'selected words';
    document.body.appendChild(painted);
    const AnnotationToolbar = paintedModule!.AnnotationToolbar;
    await act(async () => {
      root = createRoot(host!);
      root.render(<AnnotationToolbar element={painted} positionMode="center-above" onAnnotate={() => {}} onClose={() => {}} />);
    });
    await settle();
    const box = document.querySelector<HTMLElement>('.annotation-toolbar')!;
    expect(box.hasAttribute('data-pn-touch-selection-offer')).toBe(false);
    const painting = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    box.dispatchEvent(painting);
    expect(painting.defaultPrevented).toBe(false);
  });

  // The words of the buttons are the toolbar's own, deliberately pinned.
  test.skipIf(!hasDom)('has the buttons a painted selection\'s toolbar has; each hands the hook what it asks', async () => {
    const calls = await mountToolbar({ current: rect(100, 200, 200, 40) });
    expect(buttonNames()).toEqual(expect.arrayContaining(['Copy', 'Delete', 'Comment', 'Quick label', 'Looks good', 'Cancel']));

    await act(async () => { button('Comment')!.click(); });
    await act(async () => { button('Delete')!.click(); });
    await act(async () => { button('Looks good')!.click(); });
    await act(async () => { button('Cancel')!.click(); });

    expect(calls.commented).toEqual([undefined]);
    expect(calls.annotated).toEqual([AnnotationType.DELETION]);
    expect(calls.labelled).toEqual([THUMBS_UP_LABEL.text]);
    expect(calls.closed).toBe(1);
  });

  test.skipIf(!hasDom)('Copy copies the words and takes nothing: no selection is taken, no offer dismissed', async () => {
    const written: string[] = [];
    stubProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => { written.push(text); } } });
    const calls = await mountToolbar({ current: rect(100, 200, 200, 40) });

    await act(async () => { button('Copy')!.click(); });
    await settle();

    expect(written).toEqual(['selected words']);
    expect(calls).toEqual({ annotated: [], commented: [], labelled: [], closed: 0 });
  });

  test.skipIf(!hasDom)('Escape dismisses it, as on a painted selection', async () => {
    const calls = await mountToolbar({ current: rect(100, 200, 200, 40) });
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(calls.closed).toBeGreaterThan(0);
  });

  test.skipIf(!hasDom)('in Comment mode it offers Comment alone: no Delete, no labels', async () => {
    await mountToolbar({ current: rect(100, 200, 200, 40) }, 'comment');
    expect(button('Comment')).not.toBeNull();
    expect(button('Delete')).toBeNull();
    expect(button('Quick label')).toBeNull();
    expect(button('Looks good')).toBeNull();
  });
});

describe('Viewer on a touch screen', () => {
  const markdown = 'The timer and the rain sensor both started the cycle.\n\nThe sensor now waits for the timer.\n';

  async function mountViewer(
    pointer: 'coarse' | 'fine',
    props: {
      mode?: EditorMode;
      onHostDraft?: (draft: HostDraft | null) => void;
      onAdd?: (annotation: Annotation) => void;
      selectionActions?: SelectionAction[];
    } = {},
  ) {
    screen(pointer);
    // happy-dom lays nothing out: the selection is where the page says.
    stubProperty(Range.prototype, 'getClientRects', { value: () => [rect(16, 100, 200, 20)], writable: true });
    const Viewer = viewerModule!.Viewer;
    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      root = createRoot(host!);
      root.render(
        <Viewer
          blocks={parserModule!.parseMarkdownToBlocks(markdown)}
          markdown={markdown}
          annotations={[]}
          onAddAnnotation={props.onAdd ?? (() => {})}
          onSelectAnnotation={() => {}}
          selectedAnnotationId={null}
          mode={props.mode ?? 'selection'}
          onHostDraft={props.onHostDraft}
          selectionActions={props.selectionActions}
          taterMode={false}
          stickyActions={false}
          disableCodePathValidation
        />,
      );
    });
    await settle();
  }

  /** "sensor both" in the first paragraph, as a finger left it. */
  const selectWords = () => act(async () => {
    const walker = document.createTreeWalker(host!, NodeFilter.SHOW_TEXT);
    let text: Node | null = walker.nextNode();
    while (text && !(text.textContent ?? '').includes('sensor both')) text = walker.nextNode();
    const range = document.createRange();
    range.setStart(text!, text!.textContent!.indexOf('sensor both'));
    range.setEnd(text!, text!.textContent!.indexOf('sensor both') + 'sensor both'.length);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });

  const marks = () => document.querySelectorAll('mark').length;

  test.skipIf(!hasDom)('a selection that rests shows the selection toolbar and paints nothing; Comment opens the composer', async () => {
    await mountViewer('coarse');
    await selectWords();
    await rest();

    expect(offerBox()).not.toBeNull();
    expect(marks()).toBe(0);
    expect(window.getSelection()!.toString()).toBe('sensor both');
    expect(offerBox()!.dataset.pnAnnotationToolbarTouch).toBe('below');

    await act(async () => { button('Comment')!.click(); });
    await settle();

    expect(marks()).toBeGreaterThan(0);
    expect(document.querySelector('textarea')).not.toBeNull();
    expect(offerBox()).toBeNull();
  });

  test.skipIf(!hasDom)('Delete takes the selection and deletes it; a label applies the label; neither opens a composer', async () => {
    const added: Annotation[] = [];
    await mountViewer('coarse', { onAdd: (annotation) => added.push(annotation) });
    await selectWords();
    await rest();
    await act(async () => { button('Delete')!.click(); });
    await settle();
    expect(added.map((a) => [a.type, a.originalText])).toEqual([[AnnotationType.DELETION, 'sensor both']]);
    expect(document.querySelector('textarea')).toBeNull();

    await selectWords();
    await rest();
    await act(async () => { button('Looks good')!.click(); });
    await settle();
    expect(added.map((a) => [a.type, a.originalText, a.isQuickLabel])).toEqual([
      [AnnotationType.DELETION, 'sensor both', undefined],
      [AnnotationType.COMMENT, 'sensor both', true],
    ]);
    expect(document.querySelector('textarea')).toBeNull();
  });

  test.skipIf(!hasDom)('Cancel dismisses the toolbar and leaves the selection and the page as they were', async () => {
    const added: Annotation[] = [];
    await mountViewer('coarse', { onAdd: (annotation) => added.push(annotation) });
    await selectWords();
    await rest();

    await act(async () => { button('Cancel')!.click(); });
    await rest();

    expect(offerBox()).toBeNull();
    expect(window.getSelection()!.toString()).toBe('sensor both');
    expect(marks()).toBe(0);
    expect(added).toEqual([]);
  });

  /**
   * A press on a row of the toolbar's menus (they are portaled out of it): the
   * page's selection stays (mousedown cancelled), and iOS clearing the selection
   * as the finger lands does not take the toolbar, with its menu, from under it.
   */
  async function pressRow(row: Element) {
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    row.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    await act(async () => { row.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true })); });
    await act(async () => {
      window.getSelection()!.removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
    });
    // Longer than a selection takes to settle.
    await rest();
  }

  test.skipIf(!hasDom)('a press on a label row is a press on the toolbar: the selection it clears does not cost the label its tap', async () => {
    const added: Annotation[] = [];
    await mountViewer('coarse', { onAdd: (annotation) => added.push(annotation) });
    await selectWords();
    await rest();
    await act(async () => { button('Quick label')!.click(); });
    const row = document.querySelector<HTMLButtonElement>('[data-quick-label-picker] button')!;

    await pressRow(row);
    expect(offerBox()).not.toBeNull();
    expect(document.querySelector('[data-quick-label-picker]')).not.toBeNull();

    await act(async () => {
      row.dispatchEvent(new Event('pointerup', { bubbles: true }));
      row.click();
    });
    expect(added.map((a) => [a.type, a.originalText, a.isQuickLabel])).toEqual([[AnnotationType.COMMENT, 'sensor both', true]]);
    expect(offerBox()).toBeNull();
  });

  test.skipIf(!hasDom)('a press on a row of a host\'s actions is a press on the toolbar too, and the action gets the words', async () => {
    const got: string[] = [];
    await mountViewer('coarse', { selectionActions: [{ id: 'ask', label: 'Ask about it', onSelect: (context) => { got.push(context.text); } }] });
    await selectWords();
    await rest();
    await act(async () => { button('Actions')!.click(); });
    const row = document.querySelector<HTMLButtonElement>('[data-selection-actions-picker] button')!;

    await pressRow(row);
    expect(offerBox()).not.toBeNull();

    await act(async () => {
      row.dispatchEvent(new Event('pointerup', { bubbles: true }));
      row.click();
    });
    expect(got).toEqual(['sensor both']);
    expect(offerBox()).toBeNull();
    expect(marks()).toBe(0);
  });

  test.skipIf(!hasDom)('a host that composes (onHostDraft) gets no toolbar: its own Comment action takes the selection', async () => {
    await mountViewer('coarse', { onHostDraft: () => {} });
    await selectWords();
    await rest();

    expect(offerBox()).toBeNull();
    expect(marks()).toBe(0);
  });

  test.skipIf(!hasDom)('with a fine pointer nothing changes: the release paints the selection and Select\'s toolbar opens', async () => {
    await mountViewer('fine');
    await selectWords();
    await rest();
    expect(offerBox()).toBeNull();
    expect(marks()).toBe(0);

    await act(async () => {
      (host!.querySelector('article') ?? host!).dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    });
    await settle();

    expect(marks()).toBeGreaterThan(0);
    expect(document.querySelector('.annotation-toolbar')).not.toBeNull();
    expect(offerBox()).toBeNull();
  });
});
