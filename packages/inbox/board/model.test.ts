/**
 * The Board page's rules (approval "inbox-board", step 2), pure: the lanes'
 * order with a sent card on top of Backlog, the header's counts, a card's
 * second line, the unread rule for one visit, the opened card's foot and
 * column menu, the age and the live state of a link. What regresses: a lane
 * out of COLUMNS.md order, "You: …" leaking into an agent's column, a card
 * staying bold after the person opened it, a Start offered on a card already
 * sent, or a merged PR shown as open.
 */
import { expect, test } from 'bun:test';
import type { InboxAuthor, InboxCardWire } from '@plannotator/core/inbox-types';
import { boardCounts, boardLanes, cardAge, cardFoot, cardLine, cardMessageBody, cardShowsUnread, columnChoices, historyWords, messageKey, refState, sentTo, shortRef, unseenDrops, youLinkLabel, youThread } from './model';

const CLAUDE: InboxAuthor = { kind: 'agent', host: 'claude-code', session: 's1', name: 'Claude Code' };
const PERSON: InboxAuthor = { kind: 'person' };

function card(id: string, over: Partial<InboxCardWire> = {}): InboxCardWire {
  return {
    id,
    project_id: 'prj_1',
    title: id,
    column: 'backlog',
    you: null,
    said: null,
    threads: [],
    prs: [],
    refs: [],
    agent: CLAUDE,
    created_at: '2026-10-20T10:00:00.000Z',
    created_by: CLAUDE,
    moved_at: '2026-10-20T10:00:00.000Z',
    heard_at: '2026-10-20T10:00:00.000Z',
    heard_by: CLAUDE,
    dropped: null,
    aside_from: null,
    idempotency_key: null,
    notes: null,
    sent: null,
    ...over,
  } as InboxCardWire;
}

test('the five lanes in order; a card the person sent sits on top of Backlog until it moves', () => {
  const sent = card('sent', { agent: CLAUDE, sent: { at: '2026-10-20T11:00:00.000Z', to: CLAUDE, thread_id: 'msg_1' }, moved_at: '2026-10-20T10:00:00.000Z' });
  const lanes = boardLanes([card('a'), card('b', { column: 'building' }), sent, card('c', { column: 'shipped' })]);
  expect(lanes.map((lane) => lane.column)).toEqual(['backlog', 'designing', 'your_look', 'building', 'your_review']);
  expect(lanes[0].cards.map((c) => c.id)).toEqual(['sent', 'a']);
  expect(sentTo(sent)).toBe('Claude Code');
  // Once the agent moves it, it is just a card.
  expect(sentTo({ ...sent, column: 'designing', moved_at: '2026-10-20T12:00:00.000Z' })).toBeNull();
});

test('the header counts the live lanes, what is on the person, and the two links', () => {
  const counts = boardCounts([card('a'), card('b', { column: 'your_look' }), card('c', { column: 'your_review' }), card('d', { column: 'shipped' }), card('e', { column: 'icebox' }), card('f', { column: 'dropped' })]);
  expect(counts).toEqual({ inFlight: 3, onYou: 2, shipped: 1, icebox: 1, dropped: 1 });
});

test('the second line: "You: …" only in Your look and Your review; the agent’s word elsewhere; the person’s notes when nobody spoke', () => {
  expect(cardLine(card('a', { column: 'your_look', you: 'Pick a dialog', said: 'two options' }))).toEqual({ you: true, text: 'Pick a dialog' });
  expect(cardLine(card('b', { column: 'building', said: 'PR open' }))).toEqual({ you: false, text: 'PR open' });
  expect(cardLine(card('c', { agent: null, notes: '\nMaybe one page.\nMore later.' }))).toEqual({ you: false, text: 'Maybe one page.' });
  expect(cardLine(card('d'))).toBeNull();
});

test('unread: an agent wrote in a line after the look the visit began with, and the person has not opened or moved it', () => {
  // By seq, not by clock: two writes in one millisecond are told apart.
  const late = card('late', { heard_seq: 12 });
  const sameMs = card('same', { heard_seq: 11 });
  const early = card('early', { heard_seq: 9 });
  const mine = card('mine', { heard_seq: 13, heard_by: PERSON });
  const look = 10;
  expect(cardShowsUnread(late, look, new Set())).toBe(true);
  expect(cardShowsUnread(sameMs, look, new Set())).toBe(true);
  expect(cardShowsUnread(early, look, new Set())).toBe(false);
  expect(cardShowsUnread(mine, look, new Set())).toBe(false);
  expect(cardShowsUnread(late, look, new Set(['late']))).toBe(false);
  // Never looked: every card an agent wrote is unread.
  expect(cardShowsUnread(early, null, new Set())).toBe(true);
});

test('a card message names the card; a message key replays the same words and not changed ones', () => {
  expect(cardMessageBody('Roadmap', 'One page.', 'crd_1')).toBe('One page.\n\n(This is “Roadmap” on my Board, card crd_1. It is yours now: move it there as the work goes.)');
  expect(cardMessageBody('Roadmap', null, null)).toContain('(This is “Roadmap” on my Board. It is yours now');
  expect(messageKey('k', 'ses_a', 'hello')).toBe(messageKey('k', 'ses_a', 'hello'));
  expect(messageKey('k', 'ses_a', 'hello')).not.toBe(messageKey('k', 'ses_a', 'hello!'));
  expect(messageKey('k', 'ses_a', 'hello')).not.toBe(messageKey('k', 'ses_b', 'hello'));
});

test('history reads like the mock: short refs, and a Start in the card’s own thread says so', () => {
  expect(shortRef('acme/widgets#2018')).toBe('#2018');
  expect(shortRef('g/p!7')).toBe('!7');
  expect(historyWords({ at: 'x', by: CLAUDE, kind: 'linked_ref', ref: 'acme/widgets#2018', ref_kind: 'pr' })).toMatchObject({ before: 'Linked ', bold: '#2018', after: '' });
  expect(historyWords({ at: 'x', by: PERSON, kind: 'sent', to: CLAUDE, thread_id: 'msg_1', existing_thread: true }).after).toBe(' in the card’s thread');
  expect(historyWords({ at: 'x', by: PERSON, kind: 'sent', to: CLAUDE, thread_id: 'msg_1', existing_thread: false }).after).toBe(' in a new thread');
});

test('an agent’s drops show until the person has looked, newest first', () => {
  const older = card('older', { column: 'dropped', dropped: { at: '2026-10-20T10:00:00.000Z', by: CLAUDE, reason: 'superseded', seen_at: null } });
  const newer = card('newer', { column: 'dropped', dropped: { at: '2026-10-21T10:00:00.000Z', by: CLAUDE, reason: null, seen_at: null } });
  const seen = card('seen', { column: 'dropped', dropped: { at: '2026-10-21T11:00:00.000Z', by: CLAUDE, reason: null, seen_at: '2026-10-21T12:00:00.000Z' } });
  const theirs = card('theirs', { column: 'dropped', dropped: { at: '2026-10-21T11:00:00.000Z', by: PERSON, reason: null, seen_at: '2026-10-21T11:00:00.000Z' } });
  expect(unseenDrops([older, newer, seen, theirs]).map((c) => c.id)).toEqual(['newer', 'older']);
});

test('the opened card’s foot: Send for a card nobody was asked about, Start for an agent’s card in Backlog, Restore aside, Ship otherwise', () => {
  expect(cardFoot(card('mine', { agent: null })).primary).toBe('send');
  expect(cardFoot(card('theirs')).primary).toBe('start');
  expect(cardFoot(card('sent', { sent: { at: '2026-10-20T11:00:00.000Z', to: CLAUDE, thread_id: 'msg_1' } })).primary).toBe('ship');
  expect(cardFoot(card('built', { column: 'building' }))).toEqual({ primary: 'ship', icebox: true, drop: true });
  expect(cardFoot(card('iced', { column: 'icebox' }))).toEqual({ primary: 'restore', icebox: false, drop: true });
  expect(cardFoot(card('gone', { column: 'dropped' }))).toEqual({ primary: 'restore', icebox: false, drop: false });
  expect(cardFoot(card('done', { column: 'shipped' })).primary).toBeNull();
  expect(columnChoices(card('x', { column: 'building' })).filter((c) => c.current).map((c) => c.column)).toEqual(['building']);
  expect(columnChoices(card('x')).map((c) => c.column)).toEqual(['backlog', 'designing', 'your_look', 'building', 'your_review', 'shipped', 'icebox']);
});

test('the age is short on the card and whole words for a screen reader', () => {
  const now = Date.parse('2026-10-22T10:00:00.000Z');
  expect(cardAge('2026-10-22T09:59:40.000Z', now).short).toBe('now');
  expect(cardAge('2026-10-22T09:55:00.000Z', now).short).toBe('5m ago');
  expect(cardAge('2026-10-20T10:00:00.000Z', now)).toMatchObject({ short: '2d ago' });
  expect(cardAge('not a date', now)).toEqual({ short: '', long: '' });
});

test('a link’s live state reads like the hover card: Merged with its day, Open, Not planned', () => {
  expect(refState({ state: 'merged', kind: 'pull', closedAt: '2026-10-20T10:00:00.000Z' })).toMatchObject({ tone: 'merged' });
  expect(refState({ state: 'merged', kind: 'pull', closedAt: '2026-10-20T10:00:00.000Z' }).label).toStartWith('Merged');
  expect(refState({ state: 'open', kind: 'issue', closedAt: null })).toEqual({ label: 'Open', tone: 'open' });
  expect(refState({ state: 'not_planned', kind: 'issue', closedAt: null } as never).label).toStartWith('Not planned');
});

test('"You: …" goes to the thread where the person makes the call: the sent thread, else the latest, else none', () => {
  const rows: Record<string, { last_at: string }> = {
    msg_old: { last_at: '2026-10-20T09:00:00.000Z' },
    msg_new: { last_at: '2026-10-21T09:00:00.000Z' },
    msg_sent: { last_at: '2026-10-19T09:00:00.000Z' },
  };
  const rowOf = (id: string) => rows[id] ?? null;
  const sent = { at: '2026-10-19T09:00:00.000Z', to: CLAUDE, thread_id: 'msg_sent' };
  // Sent first, even when another linked thread spoke later.
  expect(youThread(card('a', { threads: ['msg_new', 'msg_sent'], sent }), rowOf)).toBe('msg_sent');
  // Else the linked thread with the latest message, whatever order they were linked in.
  expect(youThread(card('b', { threads: ['msg_new', 'msg_old'] }), rowOf)).toBe('msg_new');
  // Threads the list does not hold: the later-linked one.
  expect(youThread(card('c', { threads: ['msg_x', 'msg_y'] }), rowOf)).toBe('msg_y');
  // A sent thread that is no longer linked (the wire drops a thread that is gone) is passed over, even when the list still holds it.
  expect(youThread(card('d', { threads: ['msg_old'], sent: { ...sent, thread_id: 'msg_gone' } }), rowOf)).toBe('msg_old');
  expect(youThread(card('d2', { threads: ['msg_old'], sent: { ...sent, thread_id: 'msg_new' } }), rowOf)).toBe('msg_old');
  // No thread: none (the card opens instead).
  expect(youThread(card('e'), rowOf)).toBeNull();
  // The link's name holds its visible words as shown, case and all (WCAG 2.5.3: a voice user says what they see).
  for (const you of ['Merge #14', 'PR #14: look', 'Pick one of three dialogs']) expect(youLinkLabel(you).startsWith(`You: ${you}`)).toBe(true);
});
