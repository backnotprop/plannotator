/**
 * Stepping through a thread's attachments without leaving the viewer
 * (design record "inbox-attachment-stepping", v2, not in this repo): the
 * order, what a step announces, and when `]` `[` `→` `←` step. The order and
 * the words are pure; the key rule reads the DOM the event came from.
 */

import { inboxAttachmentKindLabel, type InboxAttachmentState, type InboxMessageWire } from '@plannotator/core/inbox-types';
import { agentName, whenTime } from './format';

/** One file in the thread's sequence, with the message it came in. */
export interface AttachmentStep {
  attachment: InboxAttachmentState;
  /** "Claude Code": who sent the message. */
  sender: string;
  /** "11:06 AM": when the message was sent. */
  sentAt: string;
  messageId: string;
}

/**
 * Every attachment of the thread in thread order: message by message, and in
 * each message in the order of its tiles. A file whose message is not in the
 * thread (it should not happen) goes last, so the count always matches.
 */
export function attachmentSequence(messages: readonly InboxMessageWire[], attachments: readonly InboxAttachmentState[]): AttachmentStep[] {
  const steps: AttachmentStep[] = [];
  const placed = new Set<string>();
  for (const message of messages) {
    for (const attachment of attachments) {
      if (attachment.message_id !== message.id || placed.has(attachment.id)) continue;
      placed.add(attachment.id);
      steps.push({ attachment, messageId: message.id, sender: agentName(message.author), sentAt: whenTime(message.created_at) });
    }
  }
  for (const attachment of attachments) {
    if (placed.has(attachment.id)) continue;
    steps.push({ attachment, messageId: attachment.message_id, sender: 'the agent', sentAt: whenTime(attachment.sent_at) });
  }
  return steps;
}

export const LAST_NOTE = 'Last attachment in this thread';
export const FIRST_NOTE = 'First attachment in this thread';

/** "4 of 5, checkout-mobile.png, PNG image, from Claude's 11:06 AM message": what a step says to a screen reader. */
export function stepAnnouncement(steps: readonly AttachmentStep[], index: number): string {
  const step = steps[index];
  if (!step) return '';
  const { attachment } = step;
  const kind = inboxAttachmentKindLabel(attachment.kind, attachment.name, attachment.media_type);
  const changed = attachment.changed_since_sent ? ', changed since it was sent' : '';
  const from = step.sentAt ? `, from ${step.sender}'s ${step.sentAt} message` : `, from ${step.sender}`;
  return `${index + 1} of ${steps.length}, ${attachment.name}, ${kind}${changed}${from}`;
}

/** Where focus is a place to type: `[` `]` and the arrows are text there. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const el = target as HTMLElement;
  if (el.isContentEditable) return true;
  if (el.closest('[contenteditable]:not([contenteditable="false"])')) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes((el as HTMLInputElement).type);
  return false;
}

/** Elements that use the arrow keys themselves (the diagram canvas pans, a zoomed image scrolls, menus move). */
const ARROW_OWNERS =
  '[data-claims-arrows="true"], [data-diagram-canvas], [role="menu"], [role="menubar"], [role="listbox"], [role="tablist"], [role="radiogroup"], [role="slider"], [role="tree"], [role="grid"]';

/** Whether the key's path (through shadow roots) passes an element that scrolls horizontally. */
function scrollsSideways(event: KeyboardEvent): boolean {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  for (const node of path) {
    if (!(node instanceof Element) || node === document.documentElement || node === document.body) continue;
    if (node.scrollWidth <= node.clientWidth + 1) continue;
    const overflow = getComputedStyle(node).overflowX;
    if (overflow === 'auto' || overflow === 'scroll') return true;
  }
  return false;
}

export interface StepKeyContext {
  /** The pane is full screen (keys work from anywhere in the window). */
  full: boolean;
  /** The pane's own element: beside the thread, keys step only from inside it. */
  pane: HTMLElement | null;
  /** The question row or the list is open: they own the keys. */
  blocked: boolean;
}

/**
 * Whether a keydown steps, and which way: 1 next, -1 previous, null not a
 * step. `]` `[` always, except while typing, with ⌘ / Ctrl / Alt (⌘[ ⌘] are
 * the browser's Back and Forward), on auto-repeat, during an IME
 * composition, or when the question row or the list is open. `→` `←` the
 * same, and also not with Shift, not where the focused element uses arrows
 * or sits in a block that scrolls sideways, not while a text selection
 * exists, and not when a handler already used the
 * key. Beside the thread, only when focus is in the file.
 */
export function stepKeyIntent(event: KeyboardEvent, context: StepKeyContext): 1 | -1 | null {
  const key = event.key;
  const bracket = key === ']' || key === '[';
  const arrow = key === 'ArrowRight' || key === 'ArrowLeft';
  if (!bracket && !arrow) return null;
  if (event.isComposing || event.repeat) return null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (context.blocked) return null;
  const target = event.target instanceof Element ? event.target : null;
  if (isEditableTarget(target)) return null;
  // A dialog or popover over the window (the image annotator, a composer) keeps its keys.
  if (target?.closest('[role="dialog"], [role="alertdialog"], [data-popover-layer], [data-pn-image-annotator-stage]')) return null;
  if (typeof document !== 'undefined' && document.querySelector('[data-pn-image-annotator-stage]')) return null;
  if (!context.full) {
    const pane = context.pane;
    const inside = !!pane && !!target && (pane === target || pane.contains(target));
    if (!inside) return null;
  }
  if (arrow) {
    if (event.shiftKey || event.defaultPrevented) return null;
    if (target?.closest(ARROW_OWNERS)) return null;
    // A block that scrolls sideways (a wide code line, a table), Pierre's code scroller in its shadow root included.
    if (scrollsSideways(event)) return null;
    const selection = typeof window !== 'undefined' ? window.getSelection() : null;
    if (selection && !selection.isCollapsed && selection.toString().trim() !== '') return null;
  }
  return key === ']' || key === 'ArrowRight' ? 1 : -1;
}
