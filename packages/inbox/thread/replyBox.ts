/** The reply box's constants and its press rule (components/Thread.tsx). */
import type { MouseEvent as ReactMouseEvent } from 'react';

/**
 * The in-thread New message button (record 5.1 to 5.3) is off since 👍 Looks
 * good (approval "inbox-acknowledge", 2026-10-15). Its route, phone door row
 * and code paths stay, so it comes back by turning this on.
 */
export const SHOW_NEW_MESSAGE_BUTTON = false;

/** From this many files the box's row says "7 files" (approval "inbox-reply-box", decision D2: no cap on files). */
export const REPLY_FILES_SUMMARY_FROM = 7;
/** `/side`, the reply box's built-in command for the side chat: its name in the "/" list and the list's one line. */
export const SIDE_COMMAND_NAME = 'side';
export const SIDE_COMMAND_DESCRIPTION = 'Start a side conversation with your agent';
/** How long "No skills are installed" stays in the reply box's row after a press on Skills with none to pick. */
export const NO_SKILLS_HINT_MS = 2000;

/**
 * What in the reply box keeps its own click: its controls (the chips'
 * buttons, a file tile's ×), the annotations list, the skill picker, and the
 * human-only notice (its text stays selectable).
 */
export const REPLY_BOX_CONTROLS =
  'button, a[href], input, select, textarea, label, summary, [role="button"], [role="dialog"], [role="menu"], [role="listbox"], [role="option"], [data-skill-menu], [data-skill-human-only-notice], [data-compose-file], [data-foot-sheet]';

/**
 * A press anywhere else in the reply box puts the caret in its text, as a
 * press anywhere in an input does. The box is drawn as one field with a focus
 * ring that is always on, but the textarea is only its upper part: a press on
 * the row of chips under it, or beside them, used to move focus to the page
 * while the box still looked focused. Typing then went nowhere, and so did a
 * dictation app's ⌘V (the owner: "focused on the input … it doesn't work").
 * The default is prevented so the press neither blurs the textarea nor starts
 * a selection; a textarea that already has focus keeps its caret.
 */
export function focusReplyFromBox(event: ReactMouseEvent<HTMLElement>, field: HTMLTextAreaElement | null): void {
  if (event.button !== 0 || !field || field.disabled) return;
  const target = event.target;
  if (!(target instanceof Element) || target === field || target.closest(REPLY_BOX_CONTROLS)) return;
  event.preventDefault();
  if (field.ownerDocument.activeElement === field) return;
  field.focus({ preventScroll: true });
  const end = field.value.length;
  field.setSelectionRange(end, end);
}

export const THREAD_GONE_TEXT = 'This thread was deleted, so nothing was sent.';
