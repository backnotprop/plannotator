import type { InboxAttachmentState, InboxMessageWire } from '@plannotator/core/inbox-types';
import { whenTime } from './format';

export interface ReplyViewing {
  attachment_id: string;
  time?: string;
  page?: string;
  as_sent?: true;
}

export function replyViewingOf(
  attachment: Pick<InboxAttachmentState, 'id' | 'message_id' | 'kind' | 'changed_since_sent' | 'unavailable'>,
  open: { version: 'current' | 'sent'; linked?: string | null },
  messages: readonly Pick<InboxMessageWire, 'id' | 'created_at'>[],
  time: (iso: string) => string = whenTime,
): ReplyViewing {
  const sentAt = messages.find((message) => message.id === attachment.message_id)?.created_at;
  // Only an HTML page opens linked pages. On any other file `linked=` is just words in an address an agent can write, and
  // nothing on screen. The route keeps the page's #fragment: the agent needs the page.
  const page = attachment.kind === 'html' ? open.linked?.split('#', 1)[0] : undefined;
  return {
    attachment_id: attachment.id,
    ...(sentAt ? { time: time(sentAt) } : {}),
    ...(page ? { page } : {}),
    ...((open.version === 'sent' && attachment.changed_since_sent) || attachment.unavailable ? { as_sent: true as const } : {}),
  };
}
