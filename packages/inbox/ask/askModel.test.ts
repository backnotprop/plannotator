/**
 * The dropdown's rows and the transcript the window draws. Pure: the same rows
 * in the real window are proved by askWindow.test.tsx.
 */
import { describe, expect, test } from 'bun:test';
import type { InboxAskChat, InboxAskConversationWire } from '../api';
import { ASK_RECENT_MAX, askChatGroups, askChatTime, askMessages, askRowState, askShownQuestion, askStopped, askUnanswered, askUnseen } from './askModel';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const HOUR = 60;

const chat = (thread_id: string, minutes: number, extra: Partial<InboxAskChat> = {}): InboxAskChat => ({
  thread_id,
  subject: thread_id,
  project: 'api',
  host: 'claude-code',
  at: ago(minutes),
  unread: false,
  answering: false,
  ...extra,
});

const ids = (rows: InboxAskChat[]) => rows.map((row) => row.thread_id);

describe('the chat list', () => {
  test('the current chat leads, even with no question yet, then the rest newest first', () => {
    const current = chat('here', 0);
    const groups = askChatGroups([chat('older', 300), chat('newer', 4)], current, NOW);
    expect(ids(groups.top)).toEqual(['here', 'newer', 'older']);
    expect(groups.recent).toEqual([]);
  });

  test('the current row is the listed one, so its real time shows and it never shows twice', () => {
    const groups = askChatGroups([chat('here', 90)], chat('here', 0), NOW);
    expect(groups.top.length).toBe(1);
    expect(groups.top[0]!.at).toBe(ago(90));
  });

  test('past 24 hours a chat is Recent, unless it is answering or has a new answer', () => {
    const groups = askChatGroups(
      [chat('day-old', 24 * HOUR + 1), chat('answering', 72 * HOUR, { answering: true }), chat('unread', 96 * HOUR, { unread: true }), chat('fresh', 23 * HOUR)],
      chat('here', 0),
      NOW,
    );
    expect(ids(groups.top)).toEqual(['here', 'fresh', 'answering', 'unread']);
    expect(ids(groups.recent)).toEqual(['day-old']);
  });

  test('a current chat from long ago stays on top, not under Recent', () => {
    const groups = askChatGroups([chat('here', 100 * HOUR)], chat('here', 0), NOW);
    expect(ids(groups.top)).toEqual(['here']);
    expect(groups.recent).toEqual([]);
  });

  test('Recent keeps the newest, up to its limit', () => {
    const many = Array.from({ length: ASK_RECENT_MAX + 5 }, (_, i) => chat(`old-${i}`, (30 + i) * HOUR));
    const groups = askChatGroups(many, chat('here', 0), NOW);
    expect(groups.recent.length).toBe(ASK_RECENT_MAX);
    expect(groups.recent[0]!.thread_id).toBe('old-0');
    expect(groups.recent.at(-1)!.thread_id).toBe(`old-${ASK_RECENT_MAX - 1}`);
  });

  test('a row wears one mark: the check, else the spinner, else the dot', () => {
    expect(askRowState(chat('here', 0, { answering: true, unread: true }), 'here')).toBe('current');
    expect(askRowState(chat('other', 0, { answering: true, unread: true }), 'here')).toBe('answering');
    expect(askRowState(chat('other', 0, { unread: true }), 'here')).toBe('unread');
    expect(askRowState(chat('other', 0), 'here')).toBeNull();
  });

  test('a row says how long ago in words that step up with the time', () => {
    expect(askChatTime(ago(0), NOW)).toBe('now');
    expect(askChatTime(ago(4), NOW)).toBe('4 min ago');
    expect(askChatTime(ago(3 * HOUR), NOW)).toBe('3 h ago');
    expect(askChatTime(ago(24 * HOUR), NOW)).toBe('yesterday');
    expect(askChatTime(ago(72 * HOUR), NOW)).toBe('3 days ago');
    expect(askChatTime(ago(8 * 24 * HOUR), NOW)).toBe('last week');
  });
});

const conversation = (turns: InboxAskConversationWire['turns'], seen_at: string | null = null): InboxAskConversationWire => ({ v: 1, thread_id: 't', seen_at, turns });
const turn = (id: string, extra: Partial<InboxAskConversationWire['turns'][number]> = {}) => ({ id, at: ago(1), session: 's', host: 'claude-code', question: `q ${id}`, ...extra });

describe('the transcript', () => {
  test('the saved answer wins over the stream, so a stream that lost words never shows', () => {
    const messages = askMessages(conversation([turn('one', { answer: 'the whole answer', answered_at: ago(0) })]), { turnId: 'one', text: 'the wh', streaming: true });
    expect(messages.map((m) => m.parts[0]!.text)).toEqual(['q one', 'the whole answer']);
    expect(messages[1]!.parts[0]!.state).toBe('done');
  });

  test('the stream fills in only the turn it belongs to', () => {
    const messages = askMessages(conversation([turn('one', { answer: 'kept' }), turn('two')]), { turnId: 'two', text: 'arriving', streaming: true });
    expect(messages.map((m) => m.parts[0]!.text)).toEqual(['q one', 'kept', 'q two', 'arriving']);
    expect(messages[3]!.parts[0]!.state).toBe('streaming');
  });

  test('a turn with no words has no answer row', () => {
    expect(askMessages(conversation([turn('one')]), null).map((m) => m.role)).toEqual(['user']);
  });

  test('only a stopped turn with words is labelled Stopped in the transcript', () => {
    const stopped = askStopped(conversation([turn('one', { answer: 'part', stopped: true }), turn('two', { stopped: true }), turn('three', { answer: 'all' })]));
    expect([...stopped]).toEqual(['a-one']);
  });

  test('a turn counts as unanswered only when nothing runs it and it was not stopped', () => {
    expect(askUnanswered(turn('one'), null)).toBe(true);
    expect(askUnanswered(turn('one'), 'one')).toBe(false);
    expect(askUnanswered(turn('one', { stopped: true }), null)).toBe(false);
    expect(askUnanswered(turn('one', { answer: 'yes' }), null)).toBe(false);
  });

  test('seen follows the newest answer, and stays quiet once it covers it', () => {
    const turns = [turn('one', { answer: 'a', answered_at: ago(10) }), turn('two', { answer: 'b', answered_at: ago(2) })];
    expect(askUnseen(conversation(turns), )).toBe(ago(2));
    expect(askUnseen(conversation(turns, ago(10)))).toBe(ago(2));
    expect(askUnseen(conversation(turns, ago(2)))).toBeNull();
    expect(askUnseen(conversation([turn('three')]))).toBeNull();
  });
});

// An older Inbox's Show me, as its conversation file keeps it: the agent's long request in `question`, the person's
// ask in `show_me`, and fields this Inbox no longer reads (`again_shape`, `shape`). Nothing asks one now; the old
// turns read as the person asked them, never as the request the agent got.
describe('an older Show me in the transcript', () => {
  const request = 'The reviewer pressed Show me on lines of the review. Run plannotator review draw …';
  const show_me = { review: 'msg_1', file: 'src/jobs/retry-worker.ts', lines: [16, 18] as [number, number], round: 1, words: 'after the third failure?' };
  const old = (id: string, extra: Record<string, unknown>) => turn(id, { question: request, kind: 'show_me', ...extra } as never);

  test("reads as the person asked it: the file's name and lines, a line, the whole review, a board's part", () => {
    expect(askShownQuestion({ question: request, kind: 'show_me', show_me })).toBe('Show me on retry-worker.ts lines 16–18: after the third failure?');
    expect(askShownQuestion({ question: request, kind: 'show_me', show_me: { ...show_me, lines: [7, 7], words: undefined } })).toBe('Show me on retry-worker.ts line 7');
    expect(askShownQuestion({ question: request, kind: 'show_me', show_me: { review: 'msg_1', file: null, lines: null, round: 1 } })).toBe('Show me on the whole review');
    const part = { board: 'shp_01ABC', name: 'The retry loop' } as never;
    expect(askShownQuestion({ question: request, kind: 'show_me', show_me: { review: null, file: null, lines: null, round: 1, words: ' why? ', part } })).toBe('Show me on The retry loop: why?');
    // A plain question, and a stored Show me with its target lost: the words as they were sent.
    expect(askShownQuestion({ question: 'Why five attempts?' })).toBe('Why five attempts?');
    expect(askShownQuestion({ question: request, kind: 'show_me' })).toBe(request);
  });

  test('a conversation of old Show me turns, with fields no longer read, draws them beside plain questions', () => {
    const turns = [
      old('one', { show_me, answer: 'I drew the retry loop.', answered_at: ago(5), again_shape: 'shp_01ABC', shape: { id: 'shp_01ABC' } }),
      turn('two', { answer: 'Five, then it gives up.' }),
      old('three', { show_me: { review: 'msg_1', file: null, lines: null, round: 2 }, failure: 'gone' }),
    ];
    const messages = askMessages(conversation(turns), null);
    expect(messages.map((m) => [m.role, m.parts[0]!.text])).toEqual([
      ['user', 'Show me on retry-worker.ts lines 16–18: after the third failure?'],
      ['assistant', 'I drew the retry loop.'],
      ['user', 'q two'],
      ['assistant', 'Five, then it gives up.'],
      ['user', 'Show me on the whole review'],
    ]);
    expect(JSON.stringify(messages)).not.toContain('plannotator review draw');
    expect(askUnanswered(turns[2]!, null)).toBe(true);
  });
});
