/**
 * The click on an action row's task line (ActionChecklist): the task's words
 * sit beside the row's toggle button, not inside it, so they can be selected
 * and copied. A plain click on them opens or closes the row as the button
 * does; a press that moved (a drag), one that leaves a selection, or a
 * double-click (it selects a word) toggles nothing, and a double-click takes
 * back the toggle its first click made. The button's own click (the line's
 * free space, Enter, Space) is the button's.
 */
import { useRef, type MouseEvent, type PointerEvent } from 'react';

/** How far a press may move and still be a click, as a question card's choice row counts it. */
const MOVE_MOUSE = 4;
const MOVE_TOUCH = 10;
/** A second click this soon after the first one's toggle is a double-click: it takes the toggle back. */
const DOUBLE_CLICK_MS = 500;

export function useLineToggle(onToggle: () => void) {
  const press = useRef<{ x: number; y: number; touch: boolean } | null>(null);
  const toggledAt = useRef(0);
  const onLinePress = (event: PointerEvent) => {
    press.current = { x: event.clientX, y: event.clientY, touch: event.pointerType === 'touch' };
  };
  const onLineClick = (event: MouseEvent) => {
    const at = press.current;
    press.current = null;
    if (event.target instanceof Element && event.target.closest('button')) return;
    if (event.detail > 1) {
      if (event.detail === 2 && Date.now() - toggledAt.current < DOUBLE_CLICK_MS) {
        toggledAt.current = 0;
        onToggle();
      }
      return;
    }
    const limit = at?.touch ? MOVE_TOUCH : MOVE_MOUSE;
    if (at && Math.hypot(event.clientX - at.x, event.clientY - at.y) > limit) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().trim() !== '') return;
    toggledAt.current = Date.now();
    onToggle();
  };
  return { onLinePress, onLineClick };
}
