/**
 * Threads mentioned in the reply box (approval "inbox-drag-threads", piece 1): the mentions a reply carries, where a
 * drop lands in the words, Backspace over one, and the words a Send hands the agent. What regresses: words becoming a
 * mention (nothing is matched against titles), mentions surviving a Send or Discard, a draft opened elsewhere losing
 * its mentions, a save dropping mentions a window never knew, the agent told to read a thread its machine does not
 * hold (or not told it can), a drop that splits a word, Backspace leaving half a title, and a self-mention.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { INBOX_THREAD_MENTION_WORDS as W } from '@plannotator/core/inbox-thread-mention';
import type { InboxReplyMention } from '@plannotator/core/inbox-types';
import {
  addReplyMentions,
  backspaceMention,
  clearReplyMentions,
  commitReplyEdit,
  mentionAt,
  mentionLabel,
  mentionReadable,
  mentionsFor,
  noteDraftMentions,
  registerMentionTaker,
  replyMentionsSave,
  replyWordsWithMentions,
  requestMention,
  resetReplyMentionsForTests,
  snapToWordEnd,
  withMentionsAt,
  type MentionRef,
} from './threadMentions';
import { pastedStill, pastedThreadId } from './replyMentions';
import { rememberMachine, resetMachineRoutes, setSelfMachine } from './inboxUrl';

const idOf = (seed: string) => `msg_${seed.padEnd(26, '0')}`;
const HERE = idOf('01JD5HERE');
const FLAKY: MentionRef = { id: idOf('01JD5F1AKY'), title: 'Flaky login test on CI', project: 'harbor' };
const RATE: MentionRef = { id: idOf('01JD5RATE'), title: 'Rate limit for the public API', project: 'ledger-api' };
const SELF = `ibx_${'01JD5SE1F'.padEnd(26, '0')}`;
const OTHER = `ibx_${'01JD5THER'.padEnd(26, '0')}`;

afterEach(() => {
  resetReplyMentionsForTests();
  resetMachineRoutes();
});

/** The box after the person put `ref` at the end of `words`: the words, and the mention at its range. */
function mentioned(words: string, ref: MentionRef, label = ref.title): string {
  const put = withMentionsAt(words, words.length, [label]);
  commitReplyEdit(HERE, words, put.text, put.caret);
  addReplyMentions(HERE, put.text, [mentionAt(ref, label, put.starts[0]!)]);
  return put.text;
}

describe('the mentions a reply carries', () => {
  test('a title typed later is plain words: nothing is matched against titles', () => {
    const text = mentioned('See', FLAKY);
    const typed = `${text}and again Flaky login test on CI`;
    commitReplyEdit(HERE, text, typed, typed.length);
    expect(mentionsFor(HERE, typed).map((m) => m.at)).toEqual([4]);
    const sent = replyWordsWithMentions(HERE, typed);
    expect(sent.split(W.inline(1, FLAKY.id)).length).toBe(2);
    expect(sent).toContain('and again Flaky login test on CI');
  });

  test('an edit inside a mention ends it; its words stay as words', () => {
    const text = mentioned('See', FLAKY);
    const edited = text.replace('login', 'logn');
    commitReplyEdit(HERE, text, edited, text.indexOf('login') + 3);
    expect(mentionsFor(HERE, edited)).toEqual([]);
    expect(replyWordsWithMentions(HERE, edited)).toBe(edited);
  });

  test('Send and Discard take the mentions with the words: the same words typed again are plain', () => {
    const text = mentioned('See', FLAKY);
    clearReplyMentions(HERE);
    expect(mentionsFor(HERE, text)).toEqual([]);
    expect(replyWordsWithMentions(HERE, text)).toBe(text);
  });

  test('a draft read on another device paints its mentions for its words', () => {
    const body = 'See Flaky login test on CI now';
    noteDraftMentions(HERE, { body, mentions: [{ thread_id: FLAKY.id, title: FLAKY.title, label: FLAKY.title, at: 4 }] });
    expect(mentionsFor(HERE, body).map((m) => m.thread_id)).toEqual([FLAKY.id]);
    // The Send takes the words trimmed: still the same mention.
    expect(replyWordsWithMentions(HERE, body.trim())).toContain(W.inline(1, FLAKY.id));
    // Edited from there, the mention moves with the words.
    const typed = `Please s${body.slice(1)}`;
    commitReplyEdit(HERE, body, typed, 'Please s'.length);
    expect(mentionsFor(HERE, typed).map((m) => m.at)).toEqual([4 + 'Please s'.length - 1]);
  });

  test('a save names the mentions once this window knows them; otherwise the draft keeps its own', () => {
    expect(replyMentionsSave(HERE, 'Some words')).toEqual({});
    const text = mentioned('See', FLAKY);
    expect(replyMentionsSave(HERE, text).mentions?.map((m) => m.thread_id)).toEqual([FLAKY.id]);
    const cut = 'See ';
    commitReplyEdit(HERE, text, cut, cut.length);
    expect(replyMentionsSave(HERE, cut)).toEqual({ mentions: [] });
  });
});

describe('whether the reply\'s agent can open a mentioned thread', () => {
  const asMention = (machine: string | undefined): InboxReplyMention => ({ thread_id: FLAKY.id, title: FLAKY.title, label: FLAKY.title, at: 0, ...(machine ? { machine } : {}) });

  test('worked out against the reply thread\'s machine, not this window\'s', () => {
    setSelfMachine(SELF);
    // A reply in a linked machine's thread, mentioning another thread of that machine: its agent can open it.
    rememberMachine([HERE], OTHER);
    expect(mentionReadable(HERE, asMention(OTHER))).toBe(true);
    // A thread of this window's Inbox: the linked machine's agent cannot.
    expect(mentionReadable(HERE, asMention(SELF))).toBe(false);
    expect(mentionReadable(HERE, asMention(undefined))).toBe(false);
  });

  test('a reply in this Inbox\'s own thread reads its own threads, not a linked machine\'s', () => {
    setSelfMachine(SELF);
    expect(mentionReadable(HERE, asMention(undefined))).toBe(true);
    expect(mentionReadable(HERE, asMention(OTHER))).toBe(false);
  });

  // Linked machines whose agents read each other's threads (mark `agent-read`), and one too old to.
  const THIRD = `ibx_${'01JD5THRD'.padEnd(26, '0')}`;
  const linked = (marks: string[], both_ways = true, other: { list_cursor?: number | null; state?: string } = {}) => [
    { id: SELF, self: true, name: 'Studio', marks: ['agent-read'], both_ways: true, list_cursor: null, state: 'online' },
    { id: OTHER, name: 'Mini', marks, both_ways, list_cursor: 7, state: 'online', ...other },
  ];

  test('a linked machine\'s thread is readable both ways once that machine reads across', () => {
    setSelfMachine(SELF, linked(['star', 'agent-read']));
    // This Inbox's thread, mentioning the linked machine's: this Inbox's agent reads it there.
    expect(mentionReadable(HERE, asMention(OTHER))).toBe(true);
    // The linked machine's thread, mentioning this Inbox's: its agent reads it here.
    rememberMachine([HERE], OTHER);
    expect(mentionReadable(HERE, asMention(SELF))).toBe(true);
    const sent = replyWordsWithMentions(HERE, mentioned('See', { ...FLAKY, machine: SELF }));
    expect(sent).toContain(W.read(FLAKY.id));
    expect(sent).not.toContain(W.unreadable);
  });

  test('a linked machine too old to read across is named, with what to do', () => {
    setSelfMachine(SELF, linked(['star']));
    const sent = replyWordsWithMentions(HERE, mentioned('See', { ...FLAKY, machine: OTHER }));
    expect(sent).toContain(W.needsUpdate('Mini'));
    expect(sent).not.toContain(W.read(FLAKY.id));
  });

  test('a thread here, read by an agent on an older linked machine: its own machine must update, not this one', () => {
    setSelfMachine(SELF, linked(['star']));
    // The reply goes to Mini's agent; the mentioned thread is on Studio, this window's machine.
    rememberMachine([HERE], OTHER);
    const sent = replyWordsWithMentions(HERE, mentioned('See', { ...FLAKY, machine: SELF }));
    expect(sent).toContain(W.readerNeedsUpdate('Studio', 'Mini'));
    expect(sent).not.toContain(W.needsUpdate('Mini'));
    expect(sent).not.toContain(W.read(FLAKY.id));
  });

  test('a linked machine whose list is not read yet is not called old: the agent is told to read it', () => {
    // Asleep since this Inbox restarted: no list, so no marks, and not known to be old.
    setSelfMachine(SELF, linked([], true, { list_cursor: null, state: 'offline' }));
    const there = replyWordsWithMentions(HERE, mentioned('See', { ...FLAKY, machine: OTHER }));
    expect(there).toContain(W.read(FLAKY.id));
    expect(there).not.toContain(W.needsUpdate('Mini'));
    // A machine its line already found too old is named even before its list.
    setSelfMachine(SELF, linked([], true, { list_cursor: null, state: 'needs_update' }));
    expect(mentionReadable(HERE, asMention(OTHER))).toBe(false);
  });

  test('no way there: a link only one way, or a third machine, stays unreadable', () => {
    // The linked machine holds no link back to this one: its agent cannot reach this Inbox's thread.
    setSelfMachine(SELF, linked(['agent-read'], false));
    rememberMachine([HERE], OTHER);
    expect(replyWordsWithMentions(HERE, mentioned('See', { ...FLAKY, machine: SELF }))).toContain(W.unreadable);
    // A reply on one linked machine, mentioning another's thread: this window cannot tell they are linked.
    expect(mentionReadable(HERE, asMention(THIRD))).toBe(false);
  });

  test('the Send tells the agent which it cannot open', () => {
    setSelfMachine(SELF);
    rememberMachine([HERE], OTHER);
    const text = mentioned('See', { ...FLAKY, machine: SELF });
    const sent = replyWordsWithMentions(HERE, text);
    expect(sent).toContain(W.unreadable);
    expect(sent).not.toContain(W.read(FLAKY.id));
  });
});

describe('where a mention goes in', () => {
  test('at the drop point, snapped to the end of the word under it, with the spaces it needs', () => {
    const text = 'Same as the failure we saw.';
    const at = snapToWordEnd(text, text.indexOf('ilure'));
    expect(at).toBe(text.indexOf(' we'));
    const put = withMentionsAt(text, at, [FLAKY.title]);
    expect(put.text).toBe('Same as the failure Flaky login test on CI we saw.');
    expect(put.text.startsWith(FLAKY.title, put.starts[0]!)).toBe(true);
  });

  test('several picked threads go in comma separated, each at its own range', () => {
    const labels = [FLAKY.title, mentionLabel(RATE, 'harbor')];
    const put = withMentionsAt('Read these first:', 17, labels);
    expect(put.text).toBe(`Read these first: ${labels[0]}, ${labels[1]} `);
    labels.forEach((label, i) => expect(put.text.startsWith(label, put.starts[i]!)).toBe(true));
  });

  test('the project follows the title only when it is not the reply\'s own', () => {
    expect(mentionLabel(RATE, 'harbor')).toBe('Rate limit for the public API · ledger-api');
    expect(mentionLabel(FLAKY, 'harbor')).toBe('Flaky login test on CI');
  });

  test('Backspace right after a mention takes it whole (and the space it brought)', () => {
    const text = 'See Flaky login test on CI and more';
    const m = mentionAt(FLAKY, FLAKY.title, 4);
    const end = text.indexOf(' and');
    expect(backspaceMention(text, end, [m])?.text).toBe('See  and more');
    expect(backspaceMention(text, end + 1, [m])?.text).toBe('See and more');
    expect(backspaceMention(text, end - 2, [m])).toBeNull();
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

  test('a link waiting for its read becomes the mention only where it still stands untouched', () => {
    const link = `http://localhost:19432/#thread=${FLAKY.id}`;
    expect(pastedStill(`See ${link}`, link, 4)).toBe(4);
    // Typed before it meanwhile: found at its one place.
    expect(pastedStill(`Please see ${link}`, link, 4)).toBe(11);
    // Edited, gone, or there twice: it stays words, and nothing else is taken out.
    expect(pastedStill(`See ${link.slice(0, -2)}`, link, 4)).toBeNull();
    expect(pastedStill('See', link, 4)).toBeNull();
    expect(pastedStill(`${link} ${link}`, link, 99)).toBeNull();
  });
});
