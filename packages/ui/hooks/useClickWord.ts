import { useEffect, useRef, type RefObject } from 'react';
import { wordAround, wordAtPoint, wordRange, type TextPosition, type WordBounds } from '../utils/wordAtPoint';

/**
 * How long a click on a word waits for a second click before it becomes a
 * highlight. The word shows as selected at once; the highlight (and its
 * toolbar or composer) follows. Painting the highlight changes the DOM, and a
 * DOM change under the pointer resets the browser's click count, so painting
 * at once would turn every double click into one word and kill the triple
 * click's paragraph (see useDismissOnOutsideAndEscape.ts).
 */
export const CLICK_WORD_WAIT_MS = 300;

/** Pointer travel, in CSS px, under which a press and release is a click. */
const CLICK_SLOP_PX = 4;

/**
 * A click on these keeps its own meaning and never selects a word: existing
 * highlights, links, buttons and button-like chips, form controls, labels,
 * images and diagrams, formulas, question cards, and everything pinpoint
 * skips (blockTargeting.ts SKIP_SELECTORS).
 */
const NOT_A_WORD_CLICK = [
  '.annotation-toolbar',
  '.annotation-highlight',
  'mark[data-bind-id]',
  '[data-highlight-id]',
  'button',
  '[data-pinpoint-ignore]',
  'a',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  'input',
  'textarea',
  'select',
  'label',
  'summary',
  'img',
  'svg',
  'canvas',
  'video',
  '.katex',
  '.math-annotatable',
  '[data-math-tex]',
  '.annotation-exclude',
  'fieldset.question-block',
  '[contenteditable]:not([contenteditable="false"])',
].join(',');

/** Open toolbars, composers and pickers: a click while one is open only closes it. */
const ANNOTATION_UI = '.annotation-toolbar, [data-quick-label-picker]';

export interface UseClickWordOptions {
  containerRef: RefObject<HTMLElement | null>;
  /** On in the Select input method; off for Pinpoint, read-only, a plan diff, vim focus. */
  enabled: boolean;
  /** One click on a word highlights it. Off in redline, where a stray click would delete a word. */
  clicksEnabled: boolean;
  /** A drag selects whole words. */
  snapDrags: boolean;
  /** A toolbar, composer or picker is open now: a click then only closes it. */
  annotationUiOpen: boolean;
  /** The shared annotation path (`highlightRange`), as pinpoint uses it. */
  onSelectRange: (range: Range) => void;
}

interface Press {
  x0: number;
  y0: number;
  moved: boolean;
  detail: number;
  /** The word the press was on, for a drag's anchor. */
  word: WordBounds | null;
  /** Nothing may come of this click: it closes a toolbar, composer or picker, or clears a selection. */
  dismisses: boolean;
}

const samePos = (a: TextPosition, node: Node | null, offset: number) => a.node === node && a.offset === offset;

/**
 * Click a word, part of the Select input method:
 *
 * - One click on a word selects it at once and, unless a second click comes
 *   within CLICK_WORD_WAIT_MS, highlights it through `onSelectRange`, the same
 *   path pinpoint uses (snaps, quote repair, per-mode toolbar or composer).
 * - With `snapDrags` (off in the Viewer), a press-and-drag selects whole words: the browser's own selection is
 *   snapped to the start of the first word and the end of the last, live on
 *   every selection change and once more on release, so the library's normal
 *   pointer-end handler commits a word-snapped range.
 *
 * Double click (a word), triple click (a paragraph), shift-click and keyboard
 * selection are the browser's, unchanged. Mouse and pen, main button only. A
 * drag the browser leaves as a caret, and one let go outside the document,
 * are repaired by `useAnnotationHighlighter` for every input method.
 */
export function useClickWord({ containerRef, enabled, clicksEnabled, snapDrags, annotationUiOpen, onSelectRange }: UseClickWordOptions): void {
  const onSelectRangeRef = useRef(onSelectRange);
  onSelectRangeRef.current = onSelectRange;
  const clicksEnabledRef = useRef(clicksEnabled);
  clicksEnabledRef.current = clicksEnabled;
  const snapDragsRef = useRef(snapDrags);
  snapDragsRef.current = snapDrags;
  const annotationUiOpenRef = useRef(annotationUiOpen);
  annotationUiOpenRef.current = annotationUiOpen;

  useEffect(() => {
    const container = containerRef.current;
    if (!enabled || !container) return;

    let press: Press | null = null;
    /** The press whose release is being handled: a newer press cancels a late commit. */
    let pressAtRelease: Press | null = null;
    let down = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let preview: WordBounds | null = null;
    let arm: () => void = () => {};

    const cancelPending = () => {
      clearTimeout(timer);
      timer = undefined;
      preview = null;
    };

    const isPreviewSelection = (sel: Selection) =>
      !!preview && samePos(preview.start, sel.anchorNode, sel.anchorOffset) && samePos(preview.end, sel.focusNode, sel.focusOffset);

    const onPointerDown = (e: PointerEvent) => {
      pressAtRelease = null;
      const target = e.target as Element | null;
      const inside = !!target && container.contains(target);
      const sel = window.getSelection();
      const pendingPreview = !!sel && isPreviewSelection(sel);
      cancelPending();
      press = null;
      down = false;
      if (!inside || e.button !== 0 || e.pointerType === 'touch') return;
      // Read before the browser collapses the selection and before outside-click dismissal runs.
      const liveSelection = !!sel && !sel.isCollapsed && !pendingPreview;
      const uiOpen = annotationUiOpenRef.current || !!document.querySelector(ANNOTATION_UI);
      const plain = !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey;
      const onWordTarget = !target.closest(NOT_A_WORD_CLICK);
      const word = onWordTarget ? wordAtPoint(e.clientX, e.clientY) : null;
      press = {
        x0: e.clientX,
        y0: e.clientY,
        moved: false,
        detail: 1,
        word: word && container.contains(word.start.node) ? word : null,
        dismisses: !plain || liveSelection || uiOpen,
      };
      down = true;
    };

    const onMouseDown = (e: MouseEvent) => {
      if (press && down) press.detail = e.detail;
    };

    const onPointerMove = (e: PointerEvent) => {
      const p = press;
      if (!p || !down) return;
      if (!p.moved && Math.hypot(e.clientX - p.x0, e.clientY - p.y0) >= CLICK_SLOP_PX) p.moved = true;
    };

    /** Snap the live selection of a single-press drag to whole words. */
    const snap = () => {
      if (!press || !press.moved || press.detail > 1 || !snapDragsRef.current) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !sel.anchorNode || !sel.focusNode) return;
      if (!container.contains(sel.anchorNode) || !container.contains(sel.focusNode)) return;
      const forward = sel.anchorNode === sel.focusNode
        ? sel.anchorOffset <= sel.focusOffset
        : (sel.anchorNode.compareDocumentPosition(sel.focusNode) & Node.DOCUMENT_POSITION_PRECEDING) === 0;
      const focusWord = wordAround(sel.focusNode, sel.focusOffset, 1) ?? wordAround(sel.focusNode, sel.focusOffset, -1);
      const anchor = press.word ? (forward ? press.word.start : press.word.end) : null;
      const focus = focusWord && !(focusWord.start.node.parentElement?.closest(NOT_A_WORD_CLICK))
        ? (forward ? focusWord.end : focusWord.start)
        : null;
      const a = anchor ?? { node: sel.anchorNode as Text, offset: sel.anchorOffset };
      const f = focus ?? { node: sel.focusNode as Text, offset: sel.focusOffset };
      if (samePos(a, sel.anchorNode, sel.anchorOffset) && samePos(f, sel.focusNode, sel.focusOffset)) return;
      sel.setBaseAndExtent(a.node, a.offset, f.node, f.offset);
    };

    const onPointerUp = () => {
      if (!down) return;
      down = false;
      pressAtRelease = press;
      snap();
    };

    // Once more at the release itself, after `useAnnotationHighlighter`'s own
    // release handling (a drag it had to select itself is set unsnapped) and
    // before the highlight is made: in the document on the way down to it,
    // outside it on the way back up.
    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== 0 || pressAtRelease === null) return;
      const inside = e.target instanceof Node && container.contains(e.target);
      if (inside === (e.currentTarget === container)) snap();
    };

    const onSelectionChange = () => {
      if (down) snap();
    };

    const onClick = (e: MouseEvent) => {
      const p = press;
      press = null;
      if (!p || p.dismisses || p.moved || e.detail !== 1 || !clicksEnabledRef.current) return;
      if (Math.hypot(e.clientX - p.x0, e.clientY - p.y0) >= CLICK_SLOP_PX) return;
      const target = e.target as Element | null;
      if (!target || target.closest(NOT_A_WORD_CLICK)) return;
      const sel = window.getSelection();
      if (!sel || (sel.rangeCount > 0 && !sel.isCollapsed)) return;
      const word = wordAtPoint(e.clientX, e.clientY);
      if (!word || !container.contains(word.start.node) || !p.word) return;
      if (word.start.node !== p.word.start.node || word.start.offset !== p.word.start.offset) return;
      // Select now (no DOM change, so a second click still counts as a double click); highlight after the wait.
      sel.setBaseAndExtent(word.start.node, word.start.offset, word.end.node, word.end.offset);
      preview = word;
      const clicked = wordRange(word).toString();
      const commit = () => {
        timer = undefined;
        const live = window.getSelection();
        const still = !!live && isPreviewSelection(live);
        preview = null;
        // The document may have been replaced or edited under the wait (a host that remounts its
        // body, a live edit): only the word that was clicked, still in place, is highlighted.
        if (!still || !word.start.node.isConnected || !word.end.node.isConnected) return;
        if (word.start.offset > word.start.node.length || word.end.offset > word.end.node.length) return;
        const range = wordRange(word);
        if (!container.contains(range.commonAncestorContainer) || range.toString() !== clicked) return;
        onSelectRangeRef.current(range);
      };
      arm = () => {
        clearTimeout(timer);
        timer = setTimeout(commit, CLICK_WORD_WAIT_MS);
      };
      arm();
    };

    // Never while the page is moving: a scroll during the wait starts the wait again, so the
    // highlight (and its toolbar) appears once the page has been still for the whole of it.
    const onScroll = () => {
      if (timer !== undefined) arm();
    };

    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', onPointerUp, true);
    document.addEventListener('selectionchange', onSelectionChange);
    container.addEventListener('click', onClick, true);
    container.addEventListener('mouseup', onMouseUp, true);
    document.addEventListener('mouseup', onMouseUp);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      cancelPending();
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('pointermove', onPointerMove, true);
        window.removeEventListener('pointerup', onPointerUp, true);
      window.removeEventListener('pointercancel', onPointerUp, true);
      document.removeEventListener('selectionchange', onSelectionChange);
      container.removeEventListener('click', onClick, true);
      container.removeEventListener('mouseup', onMouseUp, true);
      document.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [containerRef, enabled]);
}
