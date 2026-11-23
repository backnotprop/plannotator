/**
 * The quote suite: a reply that quotes a message (approval "inbox-reply-quote"). The Inbox writes a lead the agent
 * reads in front of the person's words (packages/core/inbox-reply-quote.ts `inboxReplyQuoteLead`; the store joins
 * it with a blank line); the window leaves it out when it draws the reply (`withoutInboxReplyQuoteLead`) and shows a
 * quiet line instead. ↩ quotes a whole message only when an agent wrote after it (packages/inbox/replyQuote.ts
 * `arrowQuotesWhole`). The phone draws and decides the same; this suite holds it to the window's own functions.
 * scripts/mobile/vectors.ts writes vectors/quote.json from it.
 */
import { inboxReplyQuoteLead, withoutInboxReplyQuoteLead, type InboxReplyQuoteWhose } from '../../packages/core/inbox-reply-quote';
import type { InboxMessageWire } from '../../packages/core/inbox-types';
import { arrowQuotesWhole } from '../../packages/inbox/replyQuote';
import { readRepoText } from './lib';

export const QUOTE_FIXTURE = 'apps/mobile/contract/fixtures/quote.json';

type LeadCase = { whose: InboxReplyQuoteWhose; id: string; time?: string; text: string; selected: boolean };
type Fixture = {
  leads: LeadCase[];
  /** Words a person wrote after a lead (each lead with each), and before one ("Answered 1 question."). */
  words: string[];
  /** The store's first line, in front of the lead. */
  firsts: string[];
  /** Bodies that open with no lead the store writes (they stay as they are). */
  plain: string[];
  /** Threads as who wrote each message, in order: `a` an agent, `p` the person. */
  threads: string[];
};

export function quoteVectors(about: string): unknown {
  const fixture = JSON.parse(readRepoText(QUOTE_FIXTURE)) as Fixture;
  const leads = fixture.leads.map((input) => ({ input, lead: inboxReplyQuoteLead(input) }));
  const bodies: { body: string; words: string }[] = [];
  for (const { lead } of leads) {
    for (const words of fixture.words) bodies.push({ body: `${lead}\n\n${words}`, words: '' });
    for (const first of fixture.firsts) bodies.push({ body: `${first}\n\n${lead}\n\n${fixture.words[0]}`, words: '' });
  }
  for (const body of fixture.plain) bodies.push({ body, words: '' });
  for (const one of bodies) one.words = withoutInboxReplyQuoteLead(one.body);
  const threads = fixture.threads.map((shape) => {
    const messages = [...shape].map((who, i) => ({ id: `msg_Q${i}`, author: { kind: who === 'a' ? 'agent' : 'person' } }) as unknown as InboxMessageWire);
    return { shape, quotes: messages.map((m) => arrowQuotesWhole(messages, m.id)) };
  });
  return { about, leads, bodies, threads };
}
