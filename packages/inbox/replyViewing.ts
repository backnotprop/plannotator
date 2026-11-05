/**
 * What a Send from full screen's floating box says was on screen (the owner, 2026-11-04: "It doesn't mean I'm choosing
 * that one, it just means, oh, the user was on top of this image when they sent this comment"). The server reads the
 * file's name and message from the thread, and the agent's read words it (`inboxViewingLine`); the window draws nothing.
 */
import type { InboxAttachmentState, InboxMessageWire } from '@plannotator/core/inbox-types';
import { whenTime } from './format';

export interface ReplyViewing {
  attachment_id: string;
  time?: string;
  page?: string;
  as_sent?: true;
}

export function replyViewingOf(
  attachment: Pick<InboxAttachmentState, 'id' | 'message_id' | 'changed_since_sent'>,
  open: { version: 'current' | 'sent'; linked?: string | null },
  messages: readonly Pick<InboxMessageWire, 'id' | 'created_at'>[],
  time: (iso: string) => string = whenTime,
): ReplyViewing {
  const sentAt = messages.find((message) => message.id === attachment.message_id)?.created_at;
  // The route keeps the page's #fragment: the agent needs the page.
  const page = open.linked?.split('#', 1)[0];
  return {
    attachment_id: attachment.id,
    ...(sentAt ? { time: time(sentAt) } : {}),
    ...(page ? { page } : {}),
    // Sent and current are one picture until the file changes.
    ...(open.version === 'sent' && attachment.changed_since_sent ? { as_sent: true as const } : {}),
  };
}
