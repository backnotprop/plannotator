/**
 * A thread mentioned in a reply (approval "inbox-drag-threads", piece 1). What regresses: the agent's words losing
 * the thread's id at the mention's spot, wording spelled outside the one constant (the owner approves it word for
 * word), the window drawing the agent's list or the inline form instead of a link, and previews showing them.
 */
import { describe, expect, test } from 'bun:test';
import { replyWords } from './inbox-folding';
import {
  INBOX_THREAD_MENTION_WORDS as W,
  inboxThreadMentionList,
  inboxThreadMentionTitle,
  inboxThreadMentionWords,
  linkInboxThreadMentions,
  splitInboxThreadMentions,
  withoutInboxThreadMentions,
} from './inbox-thread-mention';

const FLAKY = { id: 'msg_01JD5FLAKYLOGINTESTCI000', title: 'Flaky login test on CI', project: 'harbor' };
const RATE = { id: 'msg_01JD5RATELIMITPUBLICAPI0', title: 'Rate limit for the public API', project: 'ledger-api', archived: true };

function spanOf(words: string, label: string, ref: typeof FLAKY | typeof RATE) {
  const start = words.indexOf(label);
  return { ref, start, end: start + label.length };
}

describe('the words the agent reads', () => {
  test('each mention keeps its spot with its id, and the list after the words names every thread once, all from the one constant', () => {
    const words = 'Same root cause as Flaky login test on CI; see Rate limit for the public API · ledger-api and Flaky login test on CI.';
    const second = words.lastIndexOf(FLAKY.title);
    const out = inboxThreadMentionWords(words, [
      spanOf(words, FLAKY.title, FLAKY),
      spanOf(words, 'Rate limit for the public API · ledger-api', RATE),
      { ref: FLAKY, start: second, end: second + FLAKY.title.length },
    ]);
    const expected =
      `Same root cause as ${W.inline(FLAKY.title, FLAKY.id)}; see ${W.inline(RATE.title, RATE.id)} and ${W.inline(FLAKY.title, FLAKY.id)}.` +
      `\n\n${W.heading}\n${W.item(FLAKY.id, FLAKY.title)}\n  ${W.details(FLAKY)}.\n  ${W.read(FLAKY.id)}` +
      `\n${W.item(RATE.id, RATE.title)}\n  ${W.details(RATE)}.\n  ${W.read(RATE.id)}`;
    expect(out).toBe(expected);
    // The id is in the words at the mention, not only in the list.
    expect(out.indexOf(FLAKY.id)).toBeLessThan(out.indexOf(W.heading));
    expect(W.details(RATE)).toContain('archived');
  });

  test('a thread on another machine says it cannot be read from here, and gets no read line', () => {
    const list = inboxThreadMentionList([{ id: FLAKY.id, title: FLAKY.title, elsewhere: true }]);
    expect(list).toContain(W.details({ elsewhere: true }));
    expect(list).not.toContain(W.read(FLAKY.id));
  });

  test('no mention: the words as they are; an overlapping or stale span is left as plain words', () => {
    expect(inboxThreadMentionWords('plain words', [])).toBe('plain words');
    expect(inboxThreadMentionWords('short', [{ ref: FLAKY, start: 2, end: 99 }])).toBe('short');
  });

  test('a title is one line and capped', () => {
    expect(inboxThreadMentionTitle('two\nlines​ here')).toBe('two lines here');
    expect([...inboxThreadMentionTitle('x'.repeat(500))].length).toBe(121);
    expect(inboxThreadMentionTitle('   ')).toBe('Untitled thread');
  });
});

describe('what the window draws', () => {
  const body = inboxThreadMentionWords('Fix it like Flaky login test on CI did.', [spanOf('Fix it like Flaky login test on CI did.', FLAKY.title, FLAKY)]);

  test('a sent mention is a link to its thread, and the list is not drawn', () => {
    expect(linkInboxThreadMentions(body)).toBe(`Fix it like [Flaky login test on CI](#thread=${FLAKY.id}) did.`);
  });

  test('a title with markdown in it stays the link text', () => {
    const odd = { id: FLAKY.id, title: 'Fix [x] *now*' };
    const sent = inboxThreadMentionWords('See Fix [x] *now*', [{ ref: odd, start: 4, end: 17 }]);
    expect(linkInboxThreadMentions(sent)).toBe(`See [Fix \\[x\\] \\*now\\*](#thread=${FLAKY.id})`);
  });

  test('a preview reads the title alone (replyWords)', () => {
    expect(withoutInboxThreadMentions(body)).toBe('Fix it like Flaky login test on CI did.');
    expect(replyWords(body)).toBe('Fix it like Flaky login test on CI did.');
  });

  test('words that only look like a list are left alone', () => {
    const typed = `${W.heading}\nnothing listed`;
    expect(splitInboxThreadMentions(typed)).toBeNull();
    expect(linkInboxThreadMentions(typed)).toBe(typed);
  });

  test('what the store adds after the words (answers) stays', () => {
    const withAnswers = `${body}\n\nAnswers:\n1. Yes`;
    expect(linkInboxThreadMentions(withAnswers)).toBe(`Fix it like [Flaky login test on CI](#thread=${FLAKY.id}) did.\n\nAnswers:\n1. Yes`);
  });
});
