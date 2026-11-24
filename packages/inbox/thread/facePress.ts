/**
 * Selecting a message's words past its face (approval "inbox-reactions-every-message"): a drag with the main button
 * selects text exactly as it does with no face there, and its release lands on the text, so the comment toolbar opens.
 * - A press on the text (anything in the thread's body but a face or an opened face's emoji): while the button is
 *   down, `data-react-pressing` on the body makes every face and opened face take no pointer (inbox.css), so the
 *   pointer reaching a face mid-drag selects the words under it, and opens no face.
 * - A press on a face that drags past `DRAG_SLOP_PX`: a selection, not a click. The face lets the pointer through the
 *   same way and the words are selected from the press to the pointer (the browser starts no selection from a button).
 *   A press that does not move stays the face's click.
 * - A double- or triple-click or a Shift-click on the face or on an opened face (a click opens it at once, so a
 *   double-click's second press lands on its emoji): the words', never a reaction. The face or opened face lets the pointer through and the word, the
 *   paragraph or the words up to the pointer are selected as the browser would; the opened face closes. (Its emoji
 *   also ignore such presses, and any in the moment after a click opened it: `deliberatePress`.)
 * Nothing is prevented: the browser's own press and drag handling go on as before. Listening only during a press.
 */
import { caretAtPoint, type CaretPosition } from '@plannotator/ui/utils/caretAtPoint';
import { faceHover } from './messageReact';

/** Pointer travel, in CSS px, under which a press on the face is its click. */
const DRAG_SLOP_PX = 4;
export const PRESSING_ATTR = 'data-react-pressing';

/** A selection to make: anchor node and offset, focus node and offset. */
type Wanted = [Node, number, Node, number];

/** The word around `offset` in `data` (its start and end), or null when there is none (a space, a mark). */
function wordAround(data: string, offset: number): [number, number] | null {
  if (typeof Intl.Segmenter === 'function') {
    for (const s of new Intl.Segmenter(undefined, { granularity: 'word' }).segment(data)) {
      if (s.isWordLike && offset >= s.index && offset <= s.index + s.segment.length) return [s.index, s.index + s.segment.length];
    }
    return null;
  }
  const before = /[\p{L}\p{N}_'’-]*$/u.exec(data.slice(0, offset))![0].length;
  const after = /^[\p{L}\p{N}_'’-]*/u.exec(data.slice(offset))![0].length;
  return before + after > 0 ? [offset - before, offset + after] : null;
}

/** Follows main-button presses in `body`; returns the cleanup. */
export function followTextPresses(body: HTMLElement): () => void {
  let press: { x: number; y: number; face: HTMLElement | null; anchor: CaretPosition | null; wanted: Wanted | null } | null = null;

  const letThrough = () => {
    faceHover.close();
    faceHover.hush('*');
    body.setAttribute(PRESSING_ATTR, '');
  };
  /** A text position of the same message under a point, with the faces letting the pointer through. */
  const textAt = (x: number, y: number, article: Element): CaretPosition | null => {
    const caret = caretAtPoint(x, y);
    return caret && caret.node.nodeType === Node.TEXT_NODE && article.contains(caret.node) ? caret : null;
  };
  const end = (e?: MouseEvent) => {
    // A double-click or Shift-click on the face: its selection is there for the release (and the comment toolbar).
    const wanted = press?.wanted;
    const selection = wanted && e?.type === 'mouseup' ? window.getSelection() : null;
    if (wanted && selection?.isCollapsed && (wanted[0] !== wanted[2] || wanted[1] !== wanted[3])) selection.setBaseAndExtent(...wanted);
    press = null;
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseup', end, true);
    if (!body.hasAttribute(PRESSING_ATTR)) return;
    body.removeAttribute(PRESSING_ATTR);
    // Let go over a face: that face stays shut until the pointer leaves it, so it does not open over the words just
    // selected and their comment toolbar.
    const under = e?.type === 'mouseup' ? document.elementFromPoint?.(e.clientX, e.clientY)?.closest('[data-react-face]') : null;
    faceHover.hush(under?.getAttribute('data-react-face') ?? null);
  };
  const onMove = (e: MouseEvent) => {
    if (!press) return;
    // A release the page never heard (outside the window): the first move with the button up ends the press.
    if (!(e.buttons & 1)) return end(e);
    const face = press.face;
    if (!face) return;
    const article = face.closest('[data-message-article]');
    if (!article) return;
    if (!body.hasAttribute(PRESSING_ATTR)) {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_SLOP_PX) return;
      letThrough();
      press.anchor = textAt(press.x, press.y, article);
    }
    const focus = textAt(e.clientX, e.clientY, article);
    if (press.anchor && focus) window.getSelection()?.setBaseAndExtent(press.anchor.node, press.anchor.offset, focus.node, focus.offset);
  };
  const onDown = (e: MouseEvent) => {
    end();
    if (e.button !== 0) return;
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const strip = target.closest<HTMLElement>('.ib-rstrip');
    const face = strip ? null : target.closest<HTMLElement>('.ib-rface');
    // On the face or an opened face, a double- or triple-click or a Shift-click is the words' under it.
    const asText = !!(strip ?? face) && (e.detail > 1 || e.shiftKey);
    // An opened face's emoji are buttons to press.
    if (strip && !asText) return;
    press = { x: e.clientX, y: e.clientY, face: asText ? null : face, anchor: null, wanted: null };
    if (!press.face) letThrough();
    const article = asText ? (strip ?? face)!.closest('[data-message-article]') : null;
    if (article) press.wanted = selectAsText(e, article);
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', end, true);
  };
  /** What the browser selects for this press on the words under the face: the word, the paragraph, or up to it. */
  const selectAsText = (e: MouseEvent, article: Element): Wanted | null => {
    const caret = textAt(e.clientX, e.clientY, article);
    const selection = window.getSelection();
    if (!caret || !selection) return null;
    const text = caret.node as Text;
    let wanted: Wanted;
    if (e.shiftKey && e.detail <= 1) {
      const from = selection.rangeCount > 0 && selection.anchorNode ? { node: selection.anchorNode, offset: selection.anchorOffset } : caret;
      wanted = [from.node, from.offset, caret.node, caret.offset];
    } else if (e.detail === 2) {
      const word = wordAround(text.data, caret.offset);
      wanted = word ? [text, word[0], text, word[1]] : [text, caret.offset, text, caret.offset];
    } else {
      const block = text.parentElement?.closest('p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, td, th') ?? text.parentElement;
      if (!block) return null;
      const range = document.createRange();
      range.selectNodeContents(block);
      wanted = [range.startContainer, range.startOffset, range.endContainer, range.endOffset];
    }
    selection.setBaseAndExtent(...wanted);
    return wanted;
  };
  body.addEventListener('mousedown', onDown, true);
  return () => {
    end();
    body.removeEventListener('mousedown', onDown, true);
  };
}
