/**
 * Threads mentioned in the reply box (approval "inbox-drag-threads", piece 1): where a drop lands in the words, which
 * labels count as mentions, Backspace over one, and the words a Send hands the agent. What regresses: a drop that
 * splits a word or loses its spaces, a token that survives an edit inside it (or a typed title that never was one),
 * Backspace leaving half a title, a self-mention, and agent words that drop the thread's id.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { INBOX_THREAD_MENTION_WORDS as W } from '@plannotator/core/inbox-thread-mention';
import {
  backspaceMention,
  keepReplyMentions,
  mentionLabel,
  mentionSpans,
  registerMentionTaker,
  replyMentions,
  replyWordsWithMentions,
  requestMention,
  resetReplyMentionsForTests,
  snapToWordEnd,
  withMentionsAt,
  type ReplyMention,
} from './threadMentions';
import { pastedThreadId } from './replyMentions';

const HERE = 'msg_01JD5LOGINREDIRECTLOOP00';
const FLAKY: ReplyMention = { id: 'msg_01JD5FLAKYLOGINTESTCI000', title: 'Flaky login test on CI', project: 'harbor', label: 'Flaky login test on CI' };
const RATE: ReplyMention = { id: 'msg_01JD5RATELIMITPUBLICAPI0', title: 'Rate limit for the public API', project: 'ledger-api', label: 'Rate limit for the public API · ledger-api' };

afterEach(() => resetReplyMentionsForTests());

describe('where a mention goes in', () => {
  test('at the drop point, snapped to the end of the word under it, with the spaces it needs', () => {
    const text = 'Same as the failure we saw.';
    const at = snapToWordEnd(text, text.indexOf('ilure'));
    expect(at).toBe(text.indexOf(' we'));
    expect(withMentionsAt(text, at, [FLAKY.label]).text).toBe('Same as the failure Flaky login test on CI we saw.');
  });

  test('an empty box: the mention first, the caret after it and its space', () => {
    const put = withMentionsAt('', 0, [FLAKY.label]);
    expect(put.text).toBe('Flaky login test on CI ');
    expect(put.caret).toBe(put.text.length);
  });

  test('several picked threads go in comma separated', () => {
    expect(withMentionsAt('Read these first:', 17, [FLAKY.label, RATE.label]).text).toBe(`Read these first: ${FLAKY.label}, ${RATE.label} `);
  });

  test('the project follows the title only when it is not the reply\'s own', () => {
    expect(mentionLabel(RATE, 'harbor')).toBe('Rate limit for the public API · ledger-api');
    expect(mentionLabel(FLAKY, 'harbor')).toBe('Flaky login test on CI');
  });
});

describe('which words are mentions', () => {
  test('a label still standing is one; an edit inside it turns it back into plain words', () => {
    keepReplyMentions(HERE, [FLAKY]);
    expect(mentionSpans('See Flaky login test on CI.', replyMentions(HERE)).map((s) => s.mention.id)).toEqual([FLAKY.id]);
    expect(mentionSpans('See Flaky logn test on CI.', replyMentions(HERE))).toEqual([]);
  });

  test('a title nobody mentioned in this reply is plain words', () => {
    keepReplyMentions('msg_01JD5ANOTHERTHREAD00000', [FLAKY]);
    expect(mentionSpans('See Flaky login test on CI.', replyMentions(HERE))).toEqual([]);
  });

  test('Backspace right after a mention takes it whole (and the space it brought)', () => {
    const text = 'See Flaky login test on CI and more';
    const end = text.indexOf(' and');
    expect(backspaceMention(text, end, [FLAKY])?.text).toBe('See  and more');
    expect(backspaceMention(text, end + 1, [FLAKY])?.text).toBe('See and more');
    // Anywhere else Backspace is the field's own.
    expect(backspaceMention(text, end - 2, [FLAKY])).toBeNull();
  });
});

describe('what a Send hands the agent', () => {
  test('each standing mention at its spot with the thread id, then the list, worded by the one constant', () => {
    keepReplyMentions(HERE, [FLAKY, RATE]);
    const words = `Same as ${FLAKY.label}, and ${RATE.label}.`;
    const out = replyWordsWithMentions(HERE, words);
    expect(out.startsWith(`Same as ${W.inline(FLAKY.title, FLAKY.id)}, and ${W.inline(RATE.title, RATE.id)}.`)).toBe(true);
    expect(out).toContain(`\n\n${W.heading}\n${W.item(FLAKY.id, FLAKY.title)}`);
    expect(out).toContain(W.read(RATE.id));
  });

  test('words with no mention go as they are', () => {
    keepReplyMentions(HERE, [FLAKY]);
    expect(replyWordsWithMentions(HERE, 'Nothing mentioned.')).toBe('Nothing mentioned.');
  });
});

describe('the way in from outside the box', () => {
  test('the open box takes the threads; the thread itself is refused quietly', () => {
    const took: string[][] = [];
    const off = registerMentionTaker(HERE, (refs) => took.push(refs.map((r) => r.id)));
    requestMention(HERE, [{ id: HERE, title: 'Login redirect loop' }]);
    requestMention(HERE, [{ id: HERE, title: 'Login redirect loop' }, FLAKY, RATE]);
    off();
    expect(took).toEqual([[FLAKY.id, RATE.id]]);
  });

  test('a closed box takes what waited for it once its field mounts', async () => {
    requestMention(HERE, [FLAKY]);
    const took: string[] = [];
    const off = registerMentionTaker(HERE, (refs) => took.push(...refs.map((r) => r.id)));
    await new Promise((resolve) => setTimeout(resolve, 5));
    off();
    expect(took).toEqual([FLAKY.id]);
  });
});

describe('a pasted thread link', () => {
  test('this Inbox\'s Copy link, a message link of it, or a bare thread id name the thread', () => {
    expect(pastedThreadId(`http://localhost:19432/#thread=${FLAKY.id}`)).toBe(FLAKY.id);
    expect(pastedThreadId(` http://localhost:19432/#thread=${FLAKY.id}&msg=msg_01JD5SOMEMESSAGE0000000 `)).toBe(FLAKY.id);
    expect(pastedThreadId(FLAKY.id)).toBe(FLAKY.id);
  });

  test('words around a link, or any other link, paste as words', () => {
    expect(pastedThreadId(`see http://localhost:19432/#thread=${FLAKY.id}`)).toBeNull();
    expect(pastedThreadId('https://example.com/page#section')).toBeNull();
  });
});
