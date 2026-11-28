/**
 * Which key saves a comment (#1934).
 *
 * Every comment composer (the plan / annotate comment popover, the panel's
 * edit box, code review's line, file and general comments, the Inbox's file
 * comments) asks this one question, so a single setting governs them all.
 *
 * - Cmd/Ctrl+Enter always saves, whatever the setting says.
 * - With `enterSaves` (Settings → General → "Enter saves a comment", the
 *   cookie-only `enterSavesComment`, off by default) a plain Enter saves too
 *   and Shift+Enter is left to the field, which adds a new line.
 * - An Enter that belongs to an input method (Japanese, Chinese, Korean IME)
 *   never saves: `isComposing`, or the legacy `keyCode` 229 Safari reports for
 *   the Enter that commits a composition.
 *
 * The skill and mention menus are offered the key BEFORE this check by every
 * caller, so an arrowed-to row still takes Enter.
 */

export interface CommentSubmitKeyEvent {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  /** React's synthetic events carry the DOM event here. */
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
}

/** The Enter (or any key) belongs to an input method's composition. */
export function isImeCompositionKey(event: CommentSubmitKeyEvent): boolean {
  return (
    event.isComposing === true ||
    event.nativeEvent?.isComposing === true ||
    event.keyCode === 229 ||
    event.nativeEvent?.keyCode === 229
  );
}

/** Whether this keydown saves the comment being written. */
export function isCommentSubmitKey(event: CommentSubmitKeyEvent, enterSaves: boolean): boolean {
  if (event.key !== 'Enter') return false;
  if (isImeCompositionKey(event)) return false;
  if (event.metaKey || event.ctrlKey) return true;
  return enterSaves && !event.shiftKey && !event.altKey;
}

export function holdsImeEscape(event: CommentSubmitKeyEvent & { stopPropagation(): void }): boolean {
  if (event.key !== 'Escape' || !isImeCompositionKey(event)) return false;
  event.stopPropagation();
  return true;
}
