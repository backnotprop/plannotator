import { INBOX_MCP_WAKING_HOSTS, INBOX_WAKING_HOSTS, type InboxMessageWire, type InboxThread } from '@plannotator/core/inbox-types';
import { wordsMessage } from './sendTargets';

/**
 * The request's words: the person's reply as stored and shown, and the body of
 * the agent's wake. Plain words (the owner's ask). "guided review" is pinned on
 * purpose (guideRequest.test.ts): it is the phrase the agent tool's
 * get_guide_brief and submit_guide lines use, so an agent finds them by it (a
 * clean-room agent given only the tool text and this wake called
 * get_guide_brief, then submit_guide in reply to it).
 */
export const GUIDE_REQUEST_WORDS = 'Please send me a guided review of the code changes from this thread.';

const GUIDE_REQUEST_HOSTS: ReadonlySet<string> = new Set(INBOX_WAKING_HOSTS);

function recipientOf(message: InboxMessageWire): { host: string; session: string } | null {
  if (message.author.kind === 'agent') {
    return message.author.session && message.author.host ? { host: message.author.host, session: message.author.session } : null;
  }
  return message.to ?? null;
}

export interface GuideRequestTarget {
  message: InboxMessageWire;
  to: { host: string; session: string };
}

export function guideRequestTarget(thread: InboxThread): GuideRequestTarget | null {
  if (thread.resolved_at !== null) return null;
  const message = wordsMessage(thread);
  const to = recipientOf(message);
  if (!to || !GUIDE_REQUEST_HOSTS.has(to.host)) return null;
  return { message, to };
}

export function guideTargetCanEnd(target: GuideRequestTarget): boolean {
  if (target.message.author.kind === 'agent') return target.message.wakes === true;
  return !INBOX_MCP_WAKING_HOSTS.includes(target.to.host);
}
