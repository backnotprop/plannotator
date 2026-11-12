import { expect, test } from 'bun:test';
import type { InboxAuthor, InboxCardWire, InboxInitiative } from '@plannotator/core/inbox-types';
import { boardCounts, boardFilterHash, boardInitiativeOf, cardsInInitiative, initiativeCounts, liveInitiatives, newCardInitiative, boardLanes, boardViewOf, boardProjects, cardAge, cardsInProject, newCardProject, cardFoot, cardLine, cardMenuItems, cardMenuToast, cardMessageBody, cardUndoStillApplies, cardShowsUnread, columnChoices, historyWords, messageKey, refState, sentTo, shortRef, unseenDrops, waitingThread, youLinkLabel, youThread, type CardMenuItem } from './model';

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

test('the five lanes in order, only In review on the person; a card the person sent sits on top of Todo until it moves', () => {
  const sent = card('sent', { column: 'todo', agent: CLAUDE, sent: { at: '2026-10-20T11:00:00.000Z', to: CLAUDE, thread_id: 'msg_1' }, moved_at: '2026-10-20T10:00:00.000Z' });
  const lanes = boardLanes([card('a', { column: 'todo' }), card('b', { column: 'in_progress' }), sent, card('c', { column: 'done' }), card('d')], Date.parse('2026-10-21T10:00:00.000Z'));
  expect(lanes.map((lane) => lane.column)).toEqual(['backlog', 'todo', 'in_progress', 'in_review', 'done']);
  expect(lanes.map((lane) => lane.label)).toEqual(['Backlog', 'Todo', 'In progress', 'In review', 'Done']);
  expect(lanes.filter((lane) => lane.onYou).map((lane) => lane.column)).toEqual(['in_review']);
  expect(lanes[1].cards.map((c) => c.id)).toEqual(['sent', 'a']);
  expect(lanes[0].cards.map((c) => c.id)).toEqual(['d']);
  expect(sentTo(sent)).toBe('Claude Code');
  expect(sentTo({ ...sent, column: 'in_progress', moved_at: '2026-10-20T12:00:00.000Z' })).toBeNull();
});

test('the Done lane holds the last seven days from when a card moved to Done; older ones only on All done', () => {
  const now = Date.parse('2026-10-30T12:00:00.000Z');
  const lanes = boardLanes(
    [
      card('fresh', { column: 'done', moved_at: '2026-10-30T11:00:00.000Z' }),
      card('six', { column: 'done', moved_at: '2026-10-24T13:00:00.000Z' }),
      card('eight', { column: 'done', moved_at: '2026-10-22T11:00:00.000Z' }),
      card('old-made', { column: 'done', created_at: '2026-09-01T10:00:00.000Z', moved_at: '2026-10-29T12:00:00.000Z' }),
      card('live', { column: 'in_progress', moved_at: '2026-09-01T10:00:00.000Z' }),
      card('gone', { column: 'dropped', moved_at: '2026-10-30T11:00:00.000Z' }),
    ],
    now,
  );
  expect(lanes.find((lane) => lane.column === 'done')!.cards.map((c) => c.id)).toEqual(['fresh', 'six', 'old-made']);
  expect(lanes.flatMap((lane) => lane.cards).map((c) => c.id)).not.toContain('gone');
  expect(boardLanes([card('edge', { column: 'done', moved_at: '2026-10-23T12:00:00.000Z' })], now).at(-1)!.cards).toEqual([]);
});

test('"Waiting on you" comes from a linked thread the Inbox lists as waiting on the person, before In review only', () => {
  const sections: Record<string, string> = { msg_stop: 'stopped', msg_hold: 'holding', msg_wait: 'waiting', msg_new: 'new', msg_quiet: 'quiet' };
  const rowOf = (id: string) => (sections[id] ? { section: sections[id] } : null);
  expect(waitingThread(card('a', { column: 'in_progress', threads: ['msg_quiet', 'msg_wait'] }), rowOf)).toBe('msg_wait');
  expect(waitingThread(card('b', { column: 'todo', threads: ['msg_stop'] }), rowOf)).toBe('msg_stop');
  expect(waitingThread(card('c', { column: 'backlog', threads: ['msg_hold'] }), rowOf)).toBe('msg_hold');
  expect(waitingThread(card('d', { column: 'in_progress', threads: ['msg_new', 'msg_quiet', 'msg_gone'] }), rowOf)).toBeNull();
  for (const column of ['in_review', 'done', 'dropped'] as const) expect(waitingThread(card('e', { column, threads: ['msg_wait'] }), rowOf)).toBeNull();
});

test('the header counts only what its two links hold: Done and Cancelled', () => {
  const counts = boardCounts([card('a'), card('b', { column: 'in_review' }), card('c', { column: 'in_progress' }), card('d', { column: 'done' }), card('e', { column: 'todo' }), card('f', { column: 'dropped' })]);
  expect(counts).toEqual({ done: 1, dropped: 1 });
});

test('the second line: "You: …" only in In review; the agent’s word elsewhere; the person’s notes when nobody spoke', () => {
  expect(cardLine(card('a', { column: 'in_review', you: 'Pick a dialog', said: 'two options' }))).toEqual({ you: true, text: 'Pick a dialog' });
  expect(cardLine(card('b', { column: 'in_progress', said: 'PR open' }))).toEqual({ you: false, text: 'PR open' });
  expect(cardLine(card('c', { agent: null, notes: '\nMaybe one page.\nMore later.' }))).toEqual({ you: false, text: 'Maybe one page.' });
  expect(cardLine(card('d'))).toBeNull();
});

test('unread: an agent wrote in a line after the look the visit began with, and the person has not opened or moved it', () => {
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
  expect(historyWords({ at: 'x', by: PERSON, kind: 'auto_shipped', prs: ['https://github.com/acme/widgets/pull/12'] })).toMatchObject({ before: 'Done automatically: ', bold: '#12', after: ' merged' });
  expect(historyWords({ at: 'x', by: PERSON, kind: 'auto_shipped', prs: ['https://github.com/acme/widgets/pull/12', 'https://gitlab.com/g/p/-/merge_requests/3'] }).bold).toBe('#12, !3');
});

test('an agent’s drops show until the person has looked, newest first', () => {
  const older = card('older', { column: 'dropped', dropped: { at: '2026-10-20T10:00:00.000Z', by: CLAUDE, reason: 'superseded', seen_at: null } });
  const newer = card('newer', { column: 'dropped', dropped: { at: '2026-10-21T10:00:00.000Z', by: CLAUDE, reason: null, seen_at: null } });
  const seen = card('seen', { column: 'dropped', dropped: { at: '2026-10-21T11:00:00.000Z', by: CLAUDE, reason: null, seen_at: '2026-10-21T12:00:00.000Z' } });
  const theirs = card('theirs', { column: 'dropped', dropped: { at: '2026-10-21T11:00:00.000Z', by: PERSON, reason: null, seen_at: '2026-10-21T11:00:00.000Z' } });
  expect(unseenDrops([older, newer, seen, theirs]).map((c) => c.id)).toEqual(['newer', 'older']);
});

test('the opened card’s foot: Send for a card nobody was asked about, Start for an agent’s card not started, Restore when cancelled, Mark done otherwise', () => {
  expect(cardFoot(card('mine', { agent: null })).primary).toBe('send');
  expect(cardFoot(card('theirs')).primary).toBe('start');
  expect(cardFoot(card('asked', { column: 'todo' })).primary).toBe('start');
  expect(cardFoot(card('sent', { column: 'todo', sent: { at: '2026-10-20T11:00:00.000Z', to: CLAUDE, thread_id: 'msg_1' } })).primary).toBe('ship');
  expect(cardFoot(card('built', { column: 'in_progress' }))).toEqual({ primary: 'ship', drop: true });
  expect(cardFoot(card('gone', { column: 'dropped' }))).toEqual({ primary: 'restore', drop: false });
  expect(cardFoot(card('done', { column: 'done' })).primary).toBeNull();
  expect(columnChoices(card('x', { column: 'in_progress' })).filter((c) => c.current).map((c) => c.column)).toEqual(['in_progress']);
  expect(columnChoices(card('x')).map((c) => c.column)).toEqual(['backlog', 'todo', 'in_progress', 'in_review', 'done']);
});

const menuWords = (groups: CardMenuItem[][]) => groups.map((group) => group.map((item) => (item.kind === 'column' && item.current ? `${item.label}*` : item.label)));

test('a card’s right-click menu: Open thread when linked, the Move menu’s words in its order with the card’s column checked, then Cancel…', () => {
  expect(menuWords(cardMenuItems(card('x', { column: 'in_progress' }), 'msg_1'))).toEqual([
    ['Open thread'],
    ['Backlog', 'Todo', 'In progress*', 'In review'],
    ['Done'],
    ['Cancel…'],
  ]);
  expect(cardMenuItems(card('x', { column: 'in_progress' }), 'msg_1')[0]).toEqual([{ kind: 'thread', threadId: 'msg_1', label: 'Open thread' }]);
  expect(menuWords(cardMenuItems(card('x'), null))[0]).toEqual(['Backlog*', 'Todo', 'In progress', 'In review']);
  expect(menuWords(cardMenuItems(card('x', { column: 'done' }), null))[1]).toEqual(['Done*']);
  expect(cardMenuItems(card('x', { column: 'dropped', aside_from: 'in_progress' }), 'msg_1')).toEqual([]);
});

test('the toast after a menu move: only when the card leaves the lanes, and its Undo puts it back where it was', () => {
  const building = card('x', { title: 'Slack bridge', column: 'in_progress' });
  expect(cardMenuToast(building, { ...building, column: 'done' })).toEqual({ lead: 'Done', detail: '“Slack bridge”', undo: { op: 'move', column: 'in_progress' } });
  expect(cardMenuToast(building, { ...building, column: 'dropped', aside_from: 'in_progress' })).toEqual({ lead: 'Cancelled', detail: '“Slack bridge”', undo: { op: 'restore' } });
  const shipped = card('z', { column: 'done' });
  expect(cardMenuToast(shipped, { ...shipped, column: 'dropped', aside_from: 'done' })?.undo).toEqual({ op: 'restore' });
  expect(cardMenuToast(building, { ...building, column: 'in_review' })).toBeNull();
  expect(cardMenuToast(building, { ...building, column: 'backlog' })).toBeNull();
  expect(cardMenuToast(shipped, { ...shipped, column: 'in_progress' })).toBeNull();
  expect(cardMenuToast(building, building)).toBeNull();
});

test('a toast’s Undo runs only while the card is still where the menu put it', () => {
  const shipped = card('x', { column: 'done', moved_at: '2026-10-20T12:00:00.000Z' });
  expect(cardUndoStillApplies(shipped, card('x', { column: 'done', moved_at: shipped.moved_at, heard_at: '2026-10-20T12:05:00.000Z' }))).toBe(true);
  expect(cardUndoStillApplies(shipped, { ...shipped, column: 'in_review', moved_at: '2026-10-20T12:01:00.000Z' })).toBe(false);
  expect(cardUndoStillApplies(shipped, { ...shipped, moved_at: '2026-10-20T12:02:00.000Z' })).toBe(false);
  expect(cardUndoStillApplies(shipped, null)).toBe(false);
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
  expect(youThread(card('a', { threads: ['msg_new', 'msg_sent'], sent }), rowOf)).toBe('msg_sent');
  expect(youThread(card('b', { threads: ['msg_new', 'msg_old'] }), rowOf)).toBe('msg_new');
  expect(youThread(card('c', { threads: ['msg_x', 'msg_y'] }), rowOf)).toBe('msg_y');
  expect(youThread(card('d', { threads: ['msg_old'], sent: { ...sent, thread_id: 'msg_gone' } }), rowOf)).toBe('msg_old');
  expect(youThread(card('d2', { threads: ['msg_old'], sent: { ...sent, thread_id: 'msg_new' } }), rowOf)).toBe('msg_old');
  expect(youThread(card('e'), rowOf)).toBeNull();
  for (const you of ['Merge #14', 'PR #14: look', 'Pick one of three dialogs']) expect(youLinkLabel(you).startsWith(`You: ${you}`)).toBe(true);
});

test("the project filter keeps only that project's cards, in every column; none keeps every card", () => {
  const cards = [
    card('a1', { project_id: 'prj_a', column: 'in_progress' }),
    card('b1', { project_id: 'prj_b', column: 'in_review' }),
    card('a2', { project_id: 'prj_a', column: 'done' }),
    card('a3', { project_id: 'prj_a', column: 'backlog' }),
    card('b2', { project_id: 'prj_b', column: 'dropped', dropped: { at: '2026-10-21T10:00:00.000Z', by: CLAUDE, reason: 'x', seen_at: null } }),
  ];
  expect(cardsInProject(cards, null)).toBe(cards);
  expect(cardsInProject(cards, 'prj_a').map((c) => c.id)).toEqual(['a1', 'a2', 'a3']);
  expect(boardCounts(cardsInProject(cards, 'prj_a'))).toEqual({ done: 1, dropped: 0 });
  expect(unseenDrops(cardsInProject(cards, 'prj_a'))).toEqual([]);
  expect(unseenDrops(cardsInProject(cards, 'prj_b')).map((c) => c.id)).toEqual(['b2']);
  expect(cardsInProject(cards, 'prj_gone')).toEqual([]);
});

test("the Project menu offers the projects with a card, in the sidebar's order, and keeps the picked one", () => {
  const projects = [{ id: 'prj_c' }, { id: 'prj_a' }, { id: 'prj_none' }, { id: 'prj_b' }];
  const cards = [card('b', { project_id: 'prj_b' }), card('a', { project_id: 'prj_a', column: 'done' }), card('c', { project_id: 'prj_c', column: 'dropped' })];
  expect(boardProjects(cards, projects, null).map((p) => p.id)).toEqual(['prj_c', 'prj_a', 'prj_b']);
  expect(boardProjects(cards, projects, 'prj_none').map((p) => p.id)).toEqual(['prj_c', 'prj_a', 'prj_none', 'prj_b']);
});

test('New card goes in the filtered project, else the card heard from last, else the first project', () => {
  const projects = [{ id: 'prj_a' }, { id: 'prj_b' }];
  const cards = [card('a', { project_id: 'prj_a', heard_at: '2026-10-20T10:00:00.000Z' }), card('b', { project_id: 'prj_b', heard_at: '2026-10-21T10:00:00.000Z' })];
  expect(newCardProject('prj_a', projects, cards)).toBe('prj_a');
  expect(newCardProject(null, projects, cards)).toBe('prj_b');
  expect(newCardProject('prj_gone', projects, cards)).toBe('prj_b');
  expect(newCardProject(null, projects, [])).toBe('prj_a');
  expect(newCardProject(null, [], [])).toBeNull();
});

test('an older Board link still opens: #board=icebox is the Cancelled list, #board=shipped the Done list', () => {
  expect(boardViewOf('cancelled')).toBe('cancelled');
  expect(boardViewOf('icebox')).toBe('cancelled');
  expect(boardViewOf('done')).toBe('done');
  expect(boardViewOf('shipped')).toBe('done');
  expect(boardViewOf(null)).toBe('lanes');
});

const SHAPE = 'ini_01JX0000000000000000000001';
const MEMORY = 'ini_01JX0000000000000000000002';
const GONE = 'ini_01JX0000000000000000000003';
function initiative(id: string, name: string, deleted = false): InboxInitiative {
  return { id, name, created_at: '2026-11-04T10:00:00.000Z', created_by: PERSON, updated_at: '2026-11-04T10:00:00.000Z', deleted_at: deleted ? '2026-11-04T11:00:00.000Z' : null };
}

test('the filter counts each live initiative and No initiative; a card in a deleted one counts as in none', () => {
  const live = liveInitiatives([initiative(SHAPE, 'Shape'), initiative(MEMORY, 'Memory'), initiative(GONE, 'Gone', true)]);
  expect(live.map((i) => i.name)).toEqual(['Shape', 'Memory']);
  const cards = [card('a', { initiative: SHAPE }), card('b', { initiative: SHAPE }), card('c', { initiative: null }), card('d'), card('e', { initiative: GONE })];
  expect(Object.fromEntries(initiativeCounts(cards, live))).toEqual({ none: 3, [SHAPE]: 2, [MEMORY]: 0 });
  const other = [...cards, card('x', { project_id: 'prj_2', initiative: MEMORY })];
  expect(Object.fromEntries(initiativeCounts(cardsInProject(other, 'prj_2'), live))).toEqual({ none: 0, [SHAPE]: 0, [MEMORY]: 1 });
});

test('the initiative filter narrows what the project filter left: one initiative, none, or every card', () => {
  const cards = [card('a', { initiative: SHAPE }), card('b', { initiative: SHAPE, project_id: 'prj_2' }), card('c'), card('d', { initiative: MEMORY })];
  expect(cardsInInitiative(cards, SHAPE).map((c) => c.id)).toEqual(['a', 'b']);
  expect(cardsInInitiative(cardsInProject(cards, 'prj_1'), SHAPE).map((c) => c.id)).toEqual(['a']);
  expect(cardsInInitiative(cards, 'none').map((c) => c.id)).toEqual(['c']);
  expect(cardsInInitiative(cards, null)).toBe(cards);
  const gone = [...cards, card('e', { initiative: GONE })];
  const live = liveInitiatives([initiative(SHAPE, 'Shape'), initiative(MEMORY, 'Memory'), initiative(GONE, 'Gone', true)]);
  expect(cardsInInitiative(gone, 'none', live).map((c) => c.id)).toEqual(['c', 'e']);
  expect(Object.fromEntries(initiativeCounts(gone, live)).none).toBe(cardsInInitiative(gone, 'none', live).length);
});

test('the address: #board&project=…&initiative=…, `none` kept, a stale or bad id no filter once the initiatives have loaded', () => {
  expect(boardFilterHash({ project: 'prj_1', initiative: SHAPE })).toBe(`&project=prj_1&initiative=${SHAPE}`);
  expect(boardFilterHash({ project: null, initiative: 'none' })).toBe('&initiative=none');
  expect(boardFilterHash({})).toBe('');
  const live = [initiative(SHAPE, 'Shape')];
  const params = new URLSearchParams(`board${boardFilterHash({ project: 'prj_1', initiative: SHAPE })}`);
  expect(boardInitiativeOf(params.get('initiative'), live)).toBe(SHAPE);
  expect(params.get('project')).toBe('prj_1');
  expect(boardInitiativeOf('none', live)).toBe('none');
  expect(boardInitiativeOf('none', null)).toBe('none');
  expect(boardInitiativeOf(MEMORY, null)).toBe(MEMORY);
  expect(boardInitiativeOf(MEMORY, live)).toBeNull();
  expect(boardInitiativeOf('shape', live)).toBeNull();
  expect(boardInitiativeOf(null, live)).toBeNull();
});

test('New card starts in the filtered initiative, never in "No initiative"', () => {
  expect(newCardInitiative(SHAPE)).toBe(SHAPE);
  expect(newCardInitiative('none')).toBeNull();
  expect(newCardInitiative(null)).toBeNull();
});

test('the history names the initiative a card was put in, and says when it was cleared', () => {
  const names = (id: string) => (id === SHAPE ? 'Shape' : null);
  const set = historyWords({ at: '2026-11-04T10:00:00.000Z', by: PERSON, kind: 'initiative', initiative: SHAPE }, names);
  expect(`${set.before}${set.bold}${set.after}`).toBe('Initiative: Shape by you');
  const cleared = historyWords({ at: '2026-11-04T10:00:00.000Z', by: PERSON, kind: 'initiative', initiative: null }, names);
  expect(`${cleared.before}${cleared.bold ?? ''}${cleared.after}`).toBe('Initiative cleared by you');
});
