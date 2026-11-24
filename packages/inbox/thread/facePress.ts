/**
 * Selecting a message's words past its face (approval "inbox-reactions-every-message"): a drag with the main button
 * selects text exactly as it does with no face there, and its release lands on the text, so the comment toolbar opens.
 * - A press on the text (anything in the thread's body but a face or an opened face's emoji): while the button is
 *   down, `data-react-pressing` on the body makes every face and opened face take no pointer (inbox.css), so the
 *   pointer reaching a face mid-drag selects the words under it, and opens no face.
 * - A press on a face that drags past `DRAG_SLOP_PX`: a selection, not a click. The face lets the pointer through the
 *   same way and the words are selected from the press to the pointer (the browser starts no selection from a button).
 *   A press that does not move stays the face's click.
 * Nothing is prevented: the browser's own press and drag handling go on as before. Listening only during a press.
 */
import { caretAtPoint, type CaretPosition } from '@plannotator/ui/utils/caretAtPoint';
import { faceHover } from './messageReact';

/** Pointer travel, in CSS px, under which a press on the face is its click. */
const DRAG_SLOP_PX = 4;
export const PRESSING_ATTR = 'data-react-pressing';

/** Follows main-button presses in `body`; returns the cleanup. */
export function followTextPresses(body: HTMLElement): () => void {
  let press: { x: number; y: number; face: HTMLElement | null; anchor: CaretPosition | null } | null = null;

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
    // An opened face's emoji are buttons to press.
    if (!target || target.closest('.ib-rstrip')) return;
    const face = target.closest<HTMLElement>('.ib-rface');
    press = { x: e.clientX, y: e.clientY, face, anchor: null };
    if (!face) letThrough();
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', end, true);
  };
  body.addEventListener('mousedown', onDown, true);
  return () => {
    end();
    body.removeEventListener('mousedown', onDown, true);
  };
}
