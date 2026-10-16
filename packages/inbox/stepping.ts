/**
 * Stepping through a thread's attachments without leaving the viewer
 * (design record "inbox-attachment-stepping", v2, not in this repo): the
 * order, what a step announces, and when `]` `[` `→` `←` step. The order and
 * the words are pure; the key rule reads the DOM the event came from.
 */

import { inboxAttachmentKindLabel, type InboxAttachmentState, type InboxMessageWire } from '@plannotator/core/inbox-types';
import { agentName, whenTime } from './format';
import { hasCommandModifier, inOverlay, isComposingKey, isEditableTarget, isRepeatKey } from './shortcuts/guards';

/** One file in the thread's sequence, with the message it came in. */
export interface AttachmentStep {
  attachment: InboxAttachmentState;
  /** "Claude Code": who sent the message ("You" for the person's own). */
  sender: string;
  /** "11:06 AM": when the message was sent. */
  sentAt: string;
  messageId: string;
  /** An image the message's text shows (`inline_images`), not an attached file. */
  inline: boolean;
}

/**
 * Everything the thread shows that opens in the viewer, in reading order
 * (approval "inbox-image-viewer", 2026-10-15): message by message, the images
 * its text shows in text order, then its attached files in the order of its
 * tiles. A file whose message is not in the thread (it should not happen)
 * goes last, so the count always matches. Guided reviews keep their reader.
 */
export function attachmentSequence(
  messages: readonly InboxMessageWire[],
  attachments: readonly InboxAttachmentState[],
  inlineImages: readonly InboxAttachmentState[] = [],
): AttachmentStep[] {
  const steps: AttachmentStep[] = [];
  const placed = new Set<string>();
  const add = (attachment: InboxAttachmentState, message: InboxMessageWire, inline: boolean) => {
    placed.add(attachment.id);
    // The person's own message (an image in their reply): "You", never an agent's name.
    steps.push({ attachment, messageId: message.id, sender: message.author.kind === 'person' ? 'You' : agentName(message.author), sentAt: whenTime(message.created_at), inline });
  };
  for (const message of messages) {
    for (const image of inlineImages) if (image.message_id === message.id && !placed.has(image.id)) add(image, message, true);
    for (const attachment of attachments) if (attachment.message_id === message.id && !placed.has(attachment.id)) add(attachment, message, false);
  }
  for (const [list, inline] of [
    [inlineImages, true],
    [attachments, false],
  ] as const) {
    for (const attachment of list) {
      if (placed.has(attachment.id)) continue;
      placed.add(attachment.id);
      steps.push({ attachment, messageId: attachment.message_id, sender: 'the agent', sentAt: whenTime(attachment.sent_at), inline });
    }
  }
  return steps;
}

export const LAST_NOTE = 'Last file in this thread';
export const FIRST_NOTE = 'First file in this thread';

/**
 * "3 of 9, checkout-c-drawer.png, PNG image, in Claude Code's 11:22 AM
 * message" (an image in the text), "… attached to Claude's 11:31 AM message"
 * (an attached file): what a step says to a screen reader.
 */
export function stepAnnouncement(steps: readonly AttachmentStep[], index: number): string {
  const step = steps[index];
  if (!step) return '';
  const { attachment } = step;
  const kind = inboxAttachmentKindLabel(attachment.kind, attachment.name, attachment.media_type);
  const changed = attachment.changed_since_sent ? (attachment.captured === 'on_open' ? ', changed since you first opened it' : ', changed since it was sent') : '';
  const where = step.inline ? 'in' : 'attached to';
  const whose = step.sender === 'You' ? 'your' : `${step.sender}'s`;
  const from = step.sentAt ? `, ${where} ${whose} ${step.sentAt} message` : `, ${where} ${whose} message`;
  return `${index + 1} of ${steps.length}, ${attachment.name}, ${kind}${changed}${from}`;
}

/** Where focus is a place to type: the shared rule (shortcuts/guards.ts), kept here for the files that import it from stepping. */
export { isEditableTarget };

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
  if (isComposingKey(event) || isRepeatKey(event)) return null;
  if (hasCommandModifier(event)) return null;
  if (context.blocked) return null;
  const target = event.target instanceof Element ? event.target : null;
  if (isEditableTarget(target)) return null;
  // A dialog or popover over the window (the image annotator, a composer) keeps its keys.
  if (inOverlay(target)) return null;
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
