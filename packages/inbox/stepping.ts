import { inboxAttachmentKindLabel, type InboxAttachmentState, type InboxMessageWire } from '@plannotator/core/inbox-types';
import { threadArtifacts, type Artifact } from './artifacts';
import { ANNOTATOR_STAGE, hasCommandModifier, inOverlay, isComposingKey, isEditableTarget, isRepeatKey, singleKeysLive } from './shortcuts/guards';

export interface AttachmentStep {
  attachment: InboxAttachmentState;
  sender: string;
  sentAt: string;
  messageId: string;
  inline: boolean;
  alsoIds?: readonly string[];
}

export function attachmentSequence(
  messages: readonly InboxMessageWire[],
  attachments: readonly InboxAttachmentState[],
  inlineImages: readonly InboxAttachmentState[] = [],
): AttachmentStep[] {
  return stepsOf(threadArtifacts(messages, attachments, inlineImages));
}

export function stepsOf(artifacts: readonly Artifact[]): AttachmentStep[] {
  const steps: AttachmentStep[] = [];
  for (const artifact of artifacts) {
    if (artifact.type !== 'file') continue;
    steps.push({ attachment: artifact.attachment, sender: artifact.sender, sentAt: artifact.sentAt, messageId: artifact.messageId, inline: artifact.inline, ...(artifact.alsoIds.length > 0 ? { alsoIds: artifact.alsoIds } : {}) });
  }
  return steps;
}

export function stepIndexOf(steps: readonly AttachmentStep[], attachmentId: string): number {
  return steps.findIndex((s) => s.attachment.id === attachmentId || (s.alsoIds?.includes(attachmentId) ?? false));
}

export const LAST_NOTE = 'Last file in this thread';
export const FIRST_NOTE = 'First file in this thread';

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

export { isEditableTarget };

const ARROW_OWNERS =
  '[data-claims-arrows="true"], [data-diagram-canvas], [role="menu"], [role="menubar"], [role="listbox"], [role="tablist"], [role="radiogroup"], [role="slider"], [role="tree"], [role="grid"]';

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
  full: boolean;
  pane: HTMLElement | null;
  blocked: boolean;
}

export function stepKeyIntent(event: KeyboardEvent, context: StepKeyContext): 1 | -1 | null {
  const key = event.key;
  const bracket = key === ']' || key === '[';
  const arrow = key === 'ArrowRight' || key === 'ArrowLeft';
  if (!bracket && !arrow) return null;
  // `[` `]` are single keys: off with Single-key shortcuts and on a touch phone (WCAG 2.1.4). The arrows stay.
  if (bracket && !singleKeysLive()) return null;
  if (isComposingKey(event) || isRepeatKey(event)) return null;
  if (hasCommandModifier(event)) return null;
  if (context.blocked) return null;
  const target = event.target instanceof Element ? event.target : null;
  if (isEditableTarget(target)) return null;
  if (inOverlay(target)) return null;
  if (typeof document !== 'undefined' && document.querySelector(ANNOTATOR_STAGE)) return null;
  if (!context.full) {
    const pane = context.pane;
    const inside = !!pane && !!target && (pane === target || pane.contains(target));
    if (!inside) return null;
  }
  if (arrow) {
    if (event.shiftKey || event.defaultPrevented) return null;
    if (target?.closest(ARROW_OWNERS)) return null;
    if (scrollsSideways(event)) return null;
    const selection = typeof window !== 'undefined' ? window.getSelection() : null;
    if (selection && !selection.isCollapsed && selection.toString().trim() !== '') return null;
  }
  return key === ']' || key === 'ArrowRight' ? 1 : -1;
}
