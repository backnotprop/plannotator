/**
 * Request guided review (the owner's ask, 2026-11-02: "In the thread dropdown,
 * we can add a button to request a guided review"): an item in the thread
 * header's ⋯ that sends the person's reply asking the agent for a guided review
 * of the code changes in this thread. Pure, for the tests: who the request goes
 * to, and the words it carries. The reply itself is an ordinary one (the reply
 * route, its idempotency key, its wake), sent by `Thread.tsx`.
 */
import { INBOX_WAKING_HOSTS, type InboxMessageWire, type InboxThread } from '@plannotator/core/inbox-types';
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

/**
 * The hosts whose agent gets a guided review request: the ones a reply wakes
 * (Claude Code, Pi and OpenCode 2 through Plannotator's connection, Codex and
 * Qwen Code through MCP). Each of them reaches the Inbox through its tools, and
 * the Inbox lists get_guide_brief and submit_guide to every one. Any other
 * author (an agent with no host, a script) would never be told.
 */
const GUIDE_REQUEST_HOSTS: ReadonlySet<string> = new Set(INBOX_WAKING_HOSTS);

/** The session a reply to `message` is addressed to: its agent author, or the session a person's message names. */
function recipientOf(message: InboxMessageWire): { host: string; session: string } | null {
  if (message.author.kind === 'agent') {
    return message.author.session && message.author.host ? { host: message.author.host, session: message.author.session } : null;
  }
  return message.to ?? null;
}

/** Where a guided review request goes: the message it answers, and the session that reply reaches. */
export interface GuideRequestTarget {
  message: InboxMessageWire;
  to: { host: string; session: string };
}

/**
 * Where a guided review request goes, or null when the item is not offered:
 * the message a typed reply's words answer (`wordsMessage`: the latest agent
 * message, the new owner's after a hand-off, the person's own first message in
 * a thread they started), when the thread is not archived and that reply
 * reaches an agent session whose host gets guided reviews.
 */
export function guideRequestTarget(thread: InboxThread): GuideRequestTarget | null {
  if (thread.resolved_at !== null) return null;
  const message = wordsMessage(thread);
  const to = recipientOf(message);
  if (!to || !GUIDE_REQUEST_HOSTS.has(to.host)) return null;
  return { message, to };
}
