/**
 * The dropdown's rows and the transcript the window draws. Pure: the same rows
 * in the real window are proved by askWindow.test.tsx.
 */
import { describe, expect, test } from 'bun:test';
import type { InboxAskChat, InboxAskConversationWire } from '../api';
import { ASK_RECENT_MAX, askChatGroups, askChatTime, askMessages, askStopped, askUnanswered, askUnseen } from './askModel';

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
