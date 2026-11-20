/**
 * A text selection made with a finger is the system's until the person takes
 * it (issue #1041).
 *
 * On a touch screen the selection used to be painted as a highlight 400 ms
 * after `selectionchange` settled (and at once, by the library, at touchend),
 * which ended the system selection, its handles and its edit menu before the
 * person could reach for a handle. Now a selection that rests is offered, not
 * painted (`touchSelectionOffer`: what the selection toolbar is drawn from),
 * and a button of that toolbar takes it, then does what it does on a painted
 * selection.
 *
 * These drive the real hook and the real library over `selectionchange` and
 * `touchend`, as a phone sends them; the desktop control drives `mouseup`.
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { useRef } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnnotationType, type Annotation, type EditorMode, type HostDraft } from '../types';
import { THUMBS_UP_LABEL } from '../utils/quickLabels';
import { TOUCH_SELECTION_SETTLE_MS } from '../utils/touchSelection';

const hasDom = typeof document !== 'undefined';

// web-highlighter reads `window` at module-eval time; import lazily (the same
// pattern every DOM-gated sibling of this hook uses).
const mod = hasDom ? await import('./useAnnotationHighlighter') : null;
const useAnnotationHighlighter =
  mod?.useAnnotationHighlighter as typeof import('./useAnnotationHighlighter')['useAnnotationHighlighter'];
type Hook = import('./useAnnotationHighlighter').UseAnnotationHighlighterReturn;

const FIRST = 'First paragraph alpha.';
const SECOND = 'Second paragraph beta.';

function Harness({
  mode,
  onAdd,
  onHostDraft,
  hookRef,
}: {
  mode: EditorMode;
  onAdd: (annotation: Annotation) => void;
  onHostDraft?: (draft: HostDraft | null) => void;
  hookRef: { current: Hook | null };
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  hookRef.current = useAnnotationHighlighter({
    containerRef,
    annotations: [],
    selectedAnnotationId: null,
    mode,
    onAddAnnotation: onAdd,
    onHostDraft,
  });
  return (
    <div ref={containerRef}>
      <p data-block-id="block-1">{FIRST}</p>
      <p data-block-id="block-2">{SECOND}</p>
      <div className="annotation-exclude" data-block-id="block-3">Excluded words that are not annotatable.</div>
      <p data-block-id="block-4">Alert <span className="annotation-exclude">Tip: </span>title words here.</p>
    </div>
  );
}

let root: Root | null = null;
let host: HTMLElement | null = null;
const restorers: Array<() => void> = [];

afterEach(async () => {
  if (root) {
    await act(async () => { root!.unmount(); });
    root = null;
  }
  host?.remove();
  host = null;
  while (restorers.length) restorers.pop()!();
  if (hasDom) {
    window.getSelection()?.removeAllRanges();
    document.body.replaceChildren();
  }
});

/** A screen whose main pointer is a finger (or a mouse). */
function pointer(kind: 'coarse' | 'fine') {
  const original = Object.getOwnPropertyDescriptor(window, 'matchMedia');
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query.includes(`pointer: ${kind}`),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    }),
  });
  restorers.push(() => {
    if (original) Object.defineProperty(window, 'matchMedia', original);
    else delete (window as unknown as Record<string, unknown>).matchMedia;
  });
}

interface Mounted {
  container: HTMLElement;
  added: Annotation[];
  drafts: Array<HostDraft | null>;
  hook: { current: Hook | null };
}

async function mount(mode: EditorMode, withHostDraft = false): Promise<Mounted> {
  host = document.createElement('div');
  document.body.appendChild(host);
  const added: Annotation[] = [];
  const drafts: Array<HostDraft | null> = [];
  const hook: { current: Hook | null } = { current: null };
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <Harness
        mode={mode}
        onAdd={(annotation) => added.push(annotation)}
        onHostDraft={withHostDraft ? (draft) => drafts.push(draft) : undefined}
        hookRef={hook}
      />,
    );
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  return { container: host.firstElementChild as HTMLElement, added, drafts, hook };
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

/** "paragraph alpha" in the first block. */
const selectWords = (container: HTMLElement) => select(container.children[0]!.firstChild!, 6, container.children[0]!.firstChild!, 21);

/**
 * The selection changes, and the page is told, as a phone does. Inside `act`:
 * happy-dom announces a change from `addRange` / `removeAllRanges` itself, at
 * once, and the hook's listener sets state.
 */
const moveSelection = (change: () => void) => act(async () => {
  change();
  document.dispatchEvent(new Event('selectionchange'));
});

/** The selection comes to rest. */
const rest = () => act(async () => { await new Promise((r) => setTimeout(r, TOUCH_SELECTION_SETTLE_MS + 80)); });

const marks = (container: HTMLElement) => container.querySelectorAll('mark').length;

describe('useAnnotationHighlighter: a selection made with a finger', () => {
  test.skipIf(!hasDom)('a selection that rests is offered, not painted, and stays the system\'s', async () => {
    pointer('coarse');
    const { container, added, hook } = await mount('selection');
    await moveSelection(() => selectWords(container));
    const selection = window.getSelection()!;
    await rest();

    expect(hook.current!.touchSelectionOffer).not.toBeNull();
    expect(hook.current!.touchSelectionOffer!.mode).toBe('selection');
    expect(hook.current!.touchSelectionOffer!.selectionText).toBe('paragraph alpha');
    // The toolbar anchors on an element of the selection's start; nothing is painted around it.
    expect(container.contains(hook.current!.touchSelectionOffer!.element)).toBe(true);
    expect(marks(container)).toBe(0);
    expect(hook.current!.toolbarState).toBeNull();
    expect(hook.current!.commentPopover).toBeNull();
    expect(added).toEqual([]);
    // The handles are still the person's to drag.
    expect(selection.toString()).toBe('paragraph alpha');
  });

  test.skipIf(!hasDom)('the offer is gone while the selection moves, and back with the new words once it rests', async () => {
    pointer('coarse');
    const { container, hook } = await mount('selection');
    await moveSelection(() => selectWords(container));
    await rest();
    expect(hook.current!.touchSelectionOffer).not.toBeNull();

    // A handle dragged: the selection grows to the whole first block.
    await moveSelection(() => select(container.children[0]!.firstChild!, 0, container.children[0]!.firstChild!, FIRST.length));
    expect(hook.current!.touchSelectionOffer).toBeNull();
    expect(marks(container)).toBe(0);

    await rest();
    expect(hook.current!.touchSelectionOffer).not.toBeNull();
    await act(async () => { hook.current!.touchSelectionOffer!.onRequestComment(); });
    expect(hook.current!.commentPopover?.selectedText).toBe(FIRST);
  });

  test.skipIf(!hasDom)('Comment takes the selection and opens the composer on it, as in Comment mode, and clears the system selection', async () => {
    pointer('coarse');
    const { container, added, hook } = await mount('selection');
    await moveSelection(() => selectWords(container));
    const selection = window.getSelection()!;
    await rest();

    await act(async () => { hook.current!.touchSelectionOffer!.onRequestComment(); });

    expect(marks(container)).toBeGreaterThan(0);
    expect(hook.current!.commentPopover?.selectedText).toBe('paragraph alpha');
    // Select's painted toolbar is not what is left behind.
    expect(hook.current!.toolbarState).toBeNull();
    expect(hook.current!.touchSelectionOffer).toBeNull();
    expect(selection.isCollapsed).toBe(true);
    // Nothing is stored until the comment is written.
    expect(added).toEqual([]);
  });

  test.skipIf(!hasDom)('a key typed to comment opens the composer with that key', async () => {
    pointer('coarse');
    const { container, hook } = await mount('selection');
    await moveSelection(() => selectWords(container));
    await rest();

    await act(async () => { hook.current!.touchSelectionOffer!.onRequestComment('w'); });

    expect(hook.current!.commentPopover?.selectedText).toBe('paragraph alpha');
    expect(hook.current!.commentPopover?.initialText).toBe('w');
  });

  test.skipIf(!hasDom)('Delete takes the selection and deletes it, with no composer', async () => {
    pointer('coarse');
    const { container, added, hook } = await mount('selection');
    await moveSelection(() => selectWords(container));
    await rest();

    await act(async () => { hook.current!.touchSelectionOffer!.onAnnotate(AnnotationType.DELETION); });

    expect(added.map((a) => [a.type, a.originalText])).toEqual([[AnnotationType.DELETION, 'paragraph alpha']]);
    expect(hook.current!.commentPopover).toBeNull();
    expect(hook.current!.toolbarState).toBeNull();
    expect(window.getSelection()!.isCollapsed).toBe(true);
  });

  test.skipIf(!hasDom)('a quick label takes the selection and applies the label, with no composer', async () => {
    pointer('coarse');
    const { container, added, hook } = await mount('selection');
    await moveSelection(() => selectWords(container));
    await rest();

    await act(async () => { hook.current!.touchSelectionOffer!.onQuickLabel(THUMBS_UP_LABEL); });

    expect(added.map((a) => [a.type, a.originalText, a.isQuickLabel, a.text])).toEqual([
      [AnnotationType.COMMENT, 'paragraph alpha', true, `${THUMBS_UP_LABEL.emoji} ${THUMBS_UP_LABEL.text}`],
    ]);
    expect(hook.current!.commentPopover).toBeNull();
    expect(hook.current!.toolbarState).toBeNull();
    expect(hook.current!.touchSelectionOffer).toBeNull();
  });

  test.skipIf(!hasDom)('closing the offer leaves the page\'s selection alone and does not bring it back', async () => {
    pointer('coarse');
    const { container, added, hook } = await mount('selection');
    await moveSelection(() => selectWords(container));
    const selection = window.getSelection()!;
    await rest();

    await act(async () => { hook.current!.touchSelectionOffer!.onClose(); });
    await rest();

    expect(hook.current!.touchSelectionOffer).toBeNull();
    expect(selection.toString()).toBe('paragraph alpha');
    expect(marks(container)).toBe(0);
    expect(added).toEqual([]);
  });

  test.skipIf(!hasDom)('the quote leaves out text the highlighter skips, as the painted toolbar\'s does (an alert\'s hidden "Tip: ", #1511)', async () => {
    pointer('coarse');
    const { container, hook } = await mount('selection');
    const alert = container.children[3]!;
    // From the alert's lead word through the hidden word into its title.
    await moveSelection(() => select(alert.firstChild!, 0, alert.lastChild!, 'title words'.length));
    await rest();

    expect(hook.current!.touchSelectionOffer!.selectionText).toBe('Alert title words');
  });

  test.skipIf(!hasDom)('an offer closes the toolbar of a painted selection that is still open, so only one shows', async () => {
    pointer('coarse');
    const { container, hook } = await mount('selection');
    // What a pinpoint tap does on a touch screen: paints a block and opens the toolbar.
    const second = container.children[1]!.firstChild!;
    await act(async () => {
      const range = document.createRange();
      range.setStart(second, 0);
      range.setEnd(second, SECOND.length);
      hook.current!.highlightRange(range);
    });
    expect(hook.current!.toolbarState).not.toBeNull();
    expect(marks(container)).toBeGreaterThan(0);

    await moveSelection(() => selectWords(container));
    await rest();

    expect(hook.current!.touchSelectionOffer?.selectionText).toBe('paragraph alpha');
    expect(hook.current!.toolbarState).toBeNull();
    // Its highlight goes with it; the new selection is still the page's.
    expect(marks(container)).toBe(0);
    expect(window.getSelection()!.toString()).toBe('paragraph alpha');
  });

  test.skipIf(!hasDom)('in Comment mode the offer says so (its toolbar offers Comment alone)', async () => {
    pointer('coarse');
    const { container, hook } = await mount('comment');
    await moveSelection(() => selectWords(container));
    await rest();
    expect(hook.current!.touchSelectionOffer!.mode).toBe('comment');
  });

  /** A finger on the offer's button: the events the hook hears of it. */
  const pressOffer = () => {
    const button = document.createElement('button');
    button.setAttribute('data-pn-touch-selection-offer', 'selection');
    document.body.appendChild(button);
    const send = (type: string) => act(async () => { button.dispatchEvent(new Event(type, { bubbles: true, cancelable: true })); });
    return { down: () => send('pointerdown'), up: () => send('pointerup'), cancel: () => send('pointercancel') };
  };

  test.skipIf(!hasDom)('a press that takes the selection off the page still takes the words offered, however long it lasts', async () => {
    pointer('coarse');
    const { container, hook } = await mount('selection');
    await moveSelection(() => selectWords(container));
    const selection = window.getSelection()!;
    await rest();
    expect(hook.current!.touchSelectionOffer).not.toBeNull();

    // iOS can clear the selection as a press lands off its text. The press is
    // on the offer's own button, so the offer stays for the tap that follows.
    const finger = pressOffer();
    await finger.down();
    await moveSelection(() => selection.removeAllRanges());
    expect(hook.current!.touchSelectionOffer).not.toBeNull();
    // The finger rests on the button longer than the selection takes to settle.
    await rest();
    expect(hook.current!.touchSelectionOffer).not.toBeNull();

    await finger.up();
    await act(async () => { hook.current!.touchSelectionOffer!.onRequestComment(); });
    expect(hook.current!.commentPopover?.selectedText).toBe('paragraph alpha');
  });

  test.skipIf(!hasDom)('a selection cleared right after the lift of a press on the offer does not cost it its tap', async () => {
    pointer('coarse');
    const { container, hook } = await mount('selection');
    await moveSelection(() => selectWords(container));
    const selection = window.getSelection()!;
    await rest();

    // A tap's own selection change comes after the finger's lift, before its click.
    const finger = pressOffer();
    await finger.down();
    await finger.up();
    await moveSelection(() => selection.removeAllRanges());
    expect(hook.current!.touchSelectionOffer).not.toBeNull();

    await act(async () => { hook.current!.touchSelectionOffer!.onRequestComment(); });
    expect(hook.current!.commentPopover?.selectedText).toBe('paragraph alpha');
  });

  test.skipIf(!hasDom)('a press on the offer that is cancelled, with the selection gone, takes the offer away', async () => {
    pointer('coarse');
    const { container, hook } = await mount('selection');
    await moveSelection(() => selectWords(container));
    const selection = window.getSelection()!;
    await rest();

    const finger = pressOffer();
    await finger.down();
    await moveSelection(() => selection.removeAllRanges());
    expect(hook.current!.touchSelectionOffer).not.toBeNull();
    await finger.cancel();
    expect(hook.current!.touchSelectionOffer).toBeNull();
  });

  test.skipIf(!hasDom)('a toolbar dismissed with a press stays dismissed when the press is over, and the selection stays the page\'s', async () => {
    pointer('coarse');
    const { container, hook } = await mount('selection');
    await moveSelection(() => selectWords(container));
    const selection = window.getSelection()!;
    await rest();

    const finger = pressOffer();
    await finger.down();
    await finger.up();
    await act(async () => { hook.current!.touchSelectionOffer!.onClose(); });
    // Past the moment the press is held for.
    await act(async () => { await new Promise((r) => setTimeout(r, 800)); });

    expect(hook.current!.touchSelectionOffer).toBeNull();
    expect(selection.toString()).toBe('paragraph alpha');
  });

  test.skipIf(!hasDom)('a selection made right after a press on the offer is offered once the press is over', async () => {
    pointer('coarse');
    const { container, hook } = await mount('selection');
    await moveSelection(() => selectWords(container));
    await rest();
    const finger = pressOffer();
    await finger.down();
    await finger.up();
    await act(async () => { hook.current!.touchSelectionOffer!.onAnnotate(AnnotationType.DELETION); });

    // The next words, chosen while the lift is still being held for.
    await moveSelection(() => select(container.children[1]!.firstChild!, 0, container.children[1]!.firstChild!, 6));
    await act(async () => { await new Promise((r) => setTimeout(r, 900)); });

    expect(hook.current!.touchSelectionOffer?.selectionText).toBe('Second');
  });

  test.skipIf(!hasDom)('a selection the person lets go of takes its offer away', async () => {
    pointer('coarse');
    const { container, hook } = await mount('selection');
    await moveSelection(() => selectWords(container));
    const selection = window.getSelection()!;
    await rest();
    expect(hook.current!.touchSelectionOffer).not.toBeNull();

    // A tap elsewhere: no press on the offer, so nothing keeps it.
    await moveSelection(() => selection.removeAllRanges());
    expect(hook.current!.touchSelectionOffer).toBeNull();
    await rest();
    expect(hook.current!.touchSelectionOffer).toBeNull();
    expect(marks(container)).toBe(0);
  });

  test.skipIf(!hasDom)('nothing is offered where nothing would be taken: blank words, excluded chrome, outside the document', async () => {
    pointer('coarse');
    const { container, hook } = await mount('selection');

    // The break between two blocks (what a double-click past a block's end selects).
    await moveSelection(() => select(container.children[0]!.firstChild!, FIRST.length, container.children[1]!.firstChild!, 0));
    await rest();
    expect(hook.current!.touchSelectionOffer).toBeNull();

    // Words in a subtree the highlighter skips.
    const excluded = container.children[2]!.firstChild!;
    await moveSelection(() => select(excluded, 0, excluded, 8));
    await rest();
    expect(hook.current!.touchSelectionOffer).toBeNull();

    // Words outside the container.
    const outside = document.createElement('p');
    outside.textContent = 'Words elsewhere on the page.';
    document.body.appendChild(outside);
    await moveSelection(() => select(outside.firstChild!, 0, outside.firstChild!, 5));
    await rest();
    expect(hook.current!.touchSelectionOffer).toBeNull();

    expect(marks(container)).toBe(0);
  });

  test.skipIf(!hasDom)('the lift of the finger after a long press paints nothing either', async () => {
    pointer('coarse');
    const { container, hook } = await mount('comment');
    await moveSelection(() => selectWords(container));
    const selection = window.getSelection()!;

    // The library's own pointer-end listener would paint whatever is selected
    // at the lift: it hears touchend on a phone's user agent, and mouseup on
    // happy-dom's and on an iPad's desktop one.
    await act(async () => {
      container.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
      container.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(marks(container)).toBe(0);
    expect(hook.current!.commentPopover).toBeNull();
    expect(selection.toString()).toBe('paragraph alpha');
  });

  test.skipIf(!hasDom)('a host that composes gets no offer; its own Comment action takes the selection', async () => {
    pointer('coarse');
    const { container, drafts, hook } = await mount('selection', true);
    await moveSelection(() => selectWords(container));
    await rest();

    expect(hook.current!.touchSelectionOffer).toBeNull();
    expect(marks(container)).toBe(0);

    let taken = false;
    await act(async () => { taken = hook.current!.takeSelection!(); });
    expect(taken).toBe(true);
    expect(drafts.at(-1)?.intent).toBe('selection');
  });
});

describe('useAnnotationHighlighter: a mouse is unchanged', () => {
  test.skipIf(!hasDom)('a selection made with a mouse is painted at the release, and selectionchange alone offers nothing', async () => {
    pointer('fine');
    const { container, hook } = await mount('comment');
    await moveSelection(() => selectWords(container));
    await rest();
    expect(hook.current!.touchSelectionOffer).toBeNull();
    expect(marks(container)).toBe(0);

    await act(async () => {
      container.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(marks(container)).toBeGreaterThan(0);
    expect(hook.current!.commentPopover?.selectedText).toBe('paragraph alpha');
  });
});
