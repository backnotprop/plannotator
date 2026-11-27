/**
 * The quote suite: a reply that quotes a message (approval "inbox-reply-quote"). The Inbox writes a lead the agent
 * reads in front of the person's words (packages/core/inbox-reply-quote.ts `inboxReplyQuoteLead`; the store joins
 * it with a blank line); the window leaves it out when it draws the reply (`withoutInboxReplyQuoteLead`) and shows a
 * quiet line instead. ↩ quotes a whole message only when an agent wrote after it (packages/inbox/replyQuote.ts
 * `arrowQuotesWhole`), and what ↩ does to the reply box (`arrowReply`: the quote it leaves and the agent it aims at).
 * The store quotes a whole message as its excerpt (`inboxReplyQuoteExcerpt`). The phone draws and decides the same;
 * this suite holds it to the window's own functions.
 * scripts/mobile/vectors.ts writes vectors/quote.json from it.
 */
import { inboxReplyQuoteExcerpt, inboxReplyQuoteLead, withoutInboxReplyQuoteLead, type InboxReplyQuoteWhose } from '../../packages/core/inbox-reply-quote';
import type { InboxMessageWire } from '../../packages/core/inbox-types';
import { arrowQuotesWhole, arrowReply } from '../../packages/inbox/replyQuote';
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
  /** Threads for ↩: `a` and `b` two agent sessions, `p` the person. */
  arrows: string[];
  /** Messages quoted whole. */
  excerpts: { kind: 'agent' | 'person'; body: string }[];
};

/** The words a person selected, in the arrow cases. */
const SELECTED = 'the selected words';

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
  const arrows = fixture.arrows.map((shape) => {
    const messages = [...shape].map(
      (who, i) => ({ id: `msg_R${i}`, author: who === 'p' ? { kind: 'person' } : { kind: 'agent', host: 'claude-code', session: `ses_${who.toUpperCase()}` } }) as unknown as InboxMessageWire,
    );
    const presses = messages.flatMap((message) =>
      [null, SELECTED].flatMap((words) => [false, true].map((quoted) => ({ at: message.id, words, quoted, ...arrowReply(messages, message, words, quoted) }))),
    );
    // undefined (the quote stays) is written as "keep", so the JSON holds it.
    return { shape, presses: presses.map((p) => ({ ...p, quote: p.quote === undefined ? 'keep' : p.quote })) };
  });
  const excerpts = fixture.excerpts.map((message) => ({ ...message, excerpt: inboxReplyQuoteExcerpt({ author: { kind: message.kind }, body: message.body }) }));
  return { about, leads, bodies, threads, selected: SELECTED, arrows, excerpts };
}
