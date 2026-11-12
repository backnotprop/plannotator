/**
 * Reply with a quote (approval "inbox-reply-quote", issue #3109): the person pressed ↩ on an older message (or
 * selected words in one first), so the reply says which message, or which words, it answers.
 *
 * The reply's body opens with a short lead the agent reads, before the person's words:
 *
 *   Replying to your message from 10:04 AM (msg_…):
 *   > Here is how the three fit together. Accounts hold your sign-in and…
 *
 * The store writes it (`InboxStore.sendReply`, from the reply's `quote`), so every way an agent reads a reply (a
 * wake, read_thread, a queue) carries it. The window draws the quote as one quiet line instead and leaves the lead
 * out of the reply's words (`replyWords`, `withoutInboxReplyQuoteLead`).
 *
 * The wording is agent-facing text: it is all in INBOX_REPLY_QUOTE_LEAD, so a change of words is one edit here.
 */

import { cutAtWord, firstWords, replyWords } from './inbox-folding';
import type { InboxReplyQuote } from './inbox-types';

export type { InboxReplyQuote };

/**
 * The agent-facing words of the lead (NOT yet approved word for word: one place, so a change is one edit).
 * `{whose}` is `yours` (the agent's own message), `mine` (the person's) or `theirs` (another agent's, named).
 */
export const INBOX_REPLY_QUOTE_LEAD = {
  /** The lead's first words. */
  opening: 'Replying to',
  /** Before `whose` when the person quoted only some words. */
  selected: 'these words in',
  yours: 'your message',
  mine: 'my message',
  theirs: (name: string) => `${name}'s message`,
  /** Before the time. */
  from: 'from',
} as const;

/** The most characters of selected words a quote carries (more is cut, with "…"). */
export const INBOX_REPLY_QUOTE_WORDS_MAX = 2000;
/** About how many characters of a whole message a quote carries (cut at a word, with "…"). */
export const INBOX_REPLY_QUOTE_EXCERPT_MAX = 280;
/** The longest time label a lead prints ("Nov 9, 2025, 11:58 PM" fits). */
export const INBOX_REPLY_QUOTE_TIME_MAX = 40;

/** Whose message is quoted, as the agent reading the reply is told. */
export type InboxReplyQuoteWhose = { kind: 'yours' } | { kind: 'mine' } | { kind: 'theirs'; name: string };

function whoseWords(whose: InboxReplyQuoteWhose): string {
  if (whose.kind === 'yours') return INBOX_REPLY_QUOTE_LEAD.yours;
  if (whose.kind === 'mine') return INBOX_REPLY_QUOTE_LEAD.mine;
  return INBOX_REPLY_QUOTE_LEAD.theirs(oneLine(whose.name, 60) || 'another agent');
}

/** Text on one line: no control or format characters, runs of spaces as one, at most `max` characters. */
function oneLine(value: string, max: number): string {
  const flat = value
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\p{Cf}+/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return [...flat].length > max ? `${[...flat].slice(0, max).join('').trimEnd()}…` : flat;
}

/** A time label a lead may print: one short line of letters, digits, spaces and , : . (else ''). */
export function inboxReplyQuoteTime(value: unknown): string {
  if (typeof value !== 'string') return '';
  const line = value.replace(/[  ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (line === '' || line.length > INBOX_REPLY_QUOTE_TIME_MAX) return '';
  return /^[\p{L}\p{N} ,:.]+$/u.test(line) ? line : '';
}

/**
 * The quoted text as `> ` lines: the selected words line by line (a blank line is a bare `>`, so the quote never
 * ends early), cut at INBOX_REPLY_QUOTE_WORDS_MAX characters.
 */
function quoteLines(text: string): string {
  const cut = [...text].length > INBOX_REPLY_QUOTE_WORDS_MAX ? `${[...text].slice(0, INBOX_REPLY_QUOTE_WORDS_MAX).join('').trimEnd()}…` : text;
  return cut
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\p{Cc}]+/gu, ' ').trimEnd())
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');
}

/**
 * The lead a quoting reply opens with: `Replying to your message from 10:04 AM (msg_…):`, then the quoted text as
 * `> ` lines. `selected`: the person quoted only these words (`Replying to these words in your message …`). With no
 * text to quote, the first line alone, ending with a period.
 */
export function inboxReplyQuoteLead(input: { whose: InboxReplyQuoteWhose; id: string; time?: string; text: string; selected: boolean }): string {
  const L = INBOX_REPLY_QUOTE_LEAD;
  const time = inboxReplyQuoteTime(input.time);
  const head = [L.opening, input.selected ? L.selected : null, whoseWords(input.whose), time ? `${L.from} ${time}` : null, `(${input.id})`]
    .filter((part): part is string => !!part)
    .join(' ');
  const text = input.text.trim();
  return text === '' ? `${head}.` : `${head}:\n${quoteLines(text)}`;
}

/**
 * What a whole message is quoted as: its first words as plain text (code fences, question blocks and markup left
 * out; a person's reply, its own words), about INBOX_REPLY_QUOTE_EXCERPT_MAX characters. '' when it has none.
 */
export function inboxReplyQuoteExcerpt(message: { author: { kind: string }; body: string }): string {
  const text = message.author.kind === 'person' ? replyWords(message.body) : message.body;
  return cutAtWord(firstWords(text, INBOX_REPLY_QUOTE_EXCERPT_MAX * 2).replace(/\s+/g, ' ').trim(), INBOX_REPLY_QUOTE_EXCERPT_MAX);
}

/** The lead's first line, as the store writes it (any `whose`, any time). */
const LEAD_HEAD = (() => {
  const L = INBOX_REPLY_QUOTE_LEAD;
  const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const theirs = esc(L.theirs('\u0000')).replace('\u0000', '[^\\n]{1,64}');
  const whose = `(?:${esc(L.yours)}|${esc(L.mine)}|${theirs})`;
  return new RegExp(`^${esc(L.opening)} (?:${esc(L.selected)} )?${whose}(?: ${esc(L.from)} [^\\n]{1,${INBOX_REPLY_QUOTE_TIME_MAX}})? \\((msg_[A-Za-z0-9]+)\\)(?::\\n(?:>[^\\n]*(?:\\n|$))+|\\.(?:\\n|$))`);
})();

/**
 * A person's words split from the lead they open with: `{ lead, rest, of }`, or null when they open with none.
 * The window's own reply drawing uses it only on a message that carries a `quote`; `replyWords` uses it on any
 * person's reply, so snippets and the list's preview show the person's words.
 */
export function splitInboxReplyQuoteLead(text: string): { lead: string; rest: string; of: string } | null {
  const match = LEAD_HEAD.exec(text);
  if (!match) return null;
  const lead = match[0].replace(/\n$/, '');
  return { lead, rest: text.slice(match[0].length).replace(/^\n+/, ''), of: match[1]! };
}

/**
 * A person's reply body without the lead: at its start, or right after the store's first line ("Answered N
 * questions.", "Did 1 action item."; the lead goes in front of the words, after that line). The body as it is when
 * there is none.
 */
export function withoutInboxReplyQuoteLead(body: string): string {
  const direct = splitInboxReplyQuoteLead(body);
  if (direct) return direct.rest;
  // The store's first line: answers ("Answered 1 question.", "Skipped 2 questions."), action items ("Did 1 action
  // item.", "Couldn't do 1 action item."), or both joined ("Answered 1 question, did 1 action item.").
  const sentence = /^(?:Answered|Skipped|Did|Couldn't do) \d+ [^\n]*\.\n\n/.exec(body);
  if (!sentence) return body;
  const after = splitInboxReplyQuoteLead(body.slice(sentence[0].length));
  return after ? `${sentence[0]}${after.rest}` : body;
}
