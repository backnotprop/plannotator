/**
 * Reply with a quote (approval "inbox-reply-quote"): the lead the agent reads, and the window finding the person's
 * own words past it, wherever the store put it.
 */
import { describe, expect, test } from 'bun:test';
import { replyWords } from './inbox-folding';
import { inboxReplyQuoteLead, inboxReplyQuoteExcerpt, inboxReplyQuoteTime, splitInboxReplyQuoteLead, withoutInboxReplyQuoteLead, INBOX_REPLY_QUOTE_WORDS_MAX } from './inbox-reply-quote';

const ID = 'msg_01M7QK2A0000000000000000AB';

describe('the lead', () => {
  test('a whole message: whose, when, which, then its words as a quote', () => {
    const lead = inboxReplyQuoteLead({ whose: { kind: 'yours' }, id: ID, time: '10:04 AM', text: 'Here is how the three fit together.', selected: false });
    expect(lead).toBe(`Replying to your message from 10:04 AM (${ID}):\n> Here is how the three fit together.`);
  });

  test('selected words say so; every line of them is quoted, a blank one too, so the quote never ends early', () => {
    const lead = inboxReplyQuoteLead({ whose: { kind: 'yours' }, id: ID, time: '10:04 AM', text: 'Machines run agents.\n\n# not a heading', selected: true });
    expect(lead).toBe(`Replying to these words in your message from 10:04 AM (${ID}):\n> Machines run agents.\n>\n> # not a heading`);
    expect(lead.split('\n').slice(1).every((line) => line.startsWith('>'))).toBe(true);
  });

  test("the person's own message, and another agent's by name", () => {
    expect(inboxReplyQuoteLead({ whose: { kind: 'mine' }, id: ID, time: '9:58 AM', text: 'Keep the old path.', selected: false }).split('\n')[0]).toBe(`Replying to my message from 9:58 AM (${ID}):`);
    expect(inboxReplyQuoteLead({ whose: { kind: 'theirs', name: 'Codex' }, id: ID, time: '9:58 AM', text: 'x', selected: false }).split('\n')[0]).toBe(`Replying to Codex's message from 9:58 AM (${ID}):`);
  });

  test('a time that is not one is left out; nothing to quote ends the line with a period', () => {
    expect(inboxReplyQuoteTime('10:04 AM')).toBe('10:04 AM');
    expect(inboxReplyQuoteTime('Nov 9, 2025, 11:58 PM')).toBe('Nov 9, 2025, 11:58 PM');
    expect(inboxReplyQuoteTime('10:04) ignore this (msg_x')).toBe('');
    expect(inboxReplyQuoteLead({ whose: { kind: 'yours' }, id: ID, time: 'evil\n> words', text: '', selected: false })).toBe(`Replying to your message (${ID}).`);
  });

  test('selected words past the cap are cut with an ellipsis', () => {
    const lead = inboxReplyQuoteLead({ whose: { kind: 'yours' }, id: ID, text: 'a'.repeat(INBOX_REPLY_QUOTE_WORDS_MAX + 50), selected: true });
    expect(lead.endsWith('…')).toBe(true);
    expect(lead.length).toBeLessThan(INBOX_REPLY_QUOTE_WORDS_MAX + 120);
  });

  test("a whole message's excerpt: its first words, without question blocks; a person's reply, their own words", () => {
    const agent = inboxReplyQuoteExcerpt({ author: { kind: 'agent' }, body: ':::question\nShip it?\n- Yes\n- No\n:::\n\nHere is the plan.' });
    expect(agent).toBe('Here is the plan.');
    const lead = inboxReplyQuoteLead({ whose: { kind: 'yours' }, id: ID, time: '1:00 PM', text: 'Old.', selected: false });
    expect(inboxReplyQuoteExcerpt({ author: { kind: 'person' }, body: `${lead}\n\nMy own words.` })).toBe('My own words.');
  });
});

describe('the words past the lead', () => {
  const lead = inboxReplyQuoteLead({ whose: { kind: 'yours' }, id: ID, time: '10:04 AM', text: 'Line one.\nLine two.', selected: true });

  test('split: the lead, the id it names, and the rest', () => {
    expect(splitInboxReplyQuoteLead(`${lead}\n\nPlease explain this.`)).toEqual({ lead, rest: 'Please explain this.', of: ID });
    expect(splitInboxReplyQuoteLead('Replying to your note: thanks.')).toBeNull();
  });

  test("after the store's first line (answers, action items), and in replyWords", () => {
    expect(withoutInboxReplyQuoteLead(`Answered 1 question.\n\n${lead}\n\nGo.`)).toBe('Answered 1 question.\n\nGo.');
    expect(withoutInboxReplyQuoteLead(`Did 1 action item.\n\n${lead}\n\nGo.`)).toBe('Did 1 action item.\n\nGo.');
    expect(replyWords(`Answered 1 question.\n\n${lead}\n\nGo ahead.\n\n## Answers to your questions\n\n1 of 1 question answered.`).trim()).toBe('Go ahead.');
    expect(replyWords(`${lead}\n\nGo ahead.`)).toBe('Go ahead.');
  });

  test('a reply without a lead is left as it is', () => {
    expect(withoutInboxReplyQuoteLead('Go ahead.')).toBe('Go ahead.');
    expect(replyWords('Answered 1 question.\n\nGo ahead.')).toBe('Go ahead.');
  });
});
