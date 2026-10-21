/**
 * The Board's pure rules (packages/inbox/board.ts): the lanes and their order,
 * the counts the header and the sidebar show, the card's second line, the
 * last-heard age that replaced amber, which drops wait for the person, and
 * where "Ask where this is" goes.
 */
import { expect, test } from 'bun:test';
import type { InboxCardWire, InboxComposeProject } from '@plannotator/core/inbox-types';
import { ageShort, ageWords, askTarget, boardOf, cardLine } from './board';

const now = Date.parse('2026-10-20T20:45:00Z');
const at = (ms: number) => new Date(now - ms).toISOString();
const H = 3600_000;
let n = 0;
function card(over: Partial<InboxCardWire>): InboxCardWire {
  n++;
  const agent = { kind: 'agent' as const, host: 'claude-code', session: `ses_${n}`, name: 'Claude Code' };
  return {
    id: `crd_${String(n).padStart(26, '0')}`,
    project_id: 'prj_a',
    title: `Card ${n}`,
    column: 'asked',
    you: null,
    said: null,
    threads: [],
    prs: [],
    agent,
    created_at: at(10 * H),
    created_by: agent,
    moved_at: at(n * H),
    heard_at: at(H),
    heard_by: agent,
    dropped: null,
    aside_from: null,
    idempotency_key: null,
    ...over,
  };
}

test('lanes in COLUMNS.md order; the newest move first; Shipped, the Icebox and Dropped are not lanes', () => {
  const older = card({ column: 'building', moved_at: at(5 * H) });
  const newer = card({ column: 'building', moved_at: at(1 * H) });
  const look = card({ column: 'your_look', you: 'Pick one' });
  const review = card({ column: 'your_review', you: 'Merge it' });
  const shipped = card({ column: 'shipped' });
  const paused = card({ column: 'icebox' });
  const mine = card({ column: 'dropped', dropped: { at: at(H), by: { kind: 'person' }, reason: null, seen_at: at(H) } });
  const theirs = card({ column: 'dropped', dropped: { at: at(2 * H), by: { kind: 'agent', host: 'codex', session: 's', name: 'Codex' }, reason: 'Folded in', seen_at: null } });
  const seen = card({ column: 'dropped', dropped: { at: at(3 * H), by: { kind: 'agent', host: 'codex', session: 's', name: 'Codex' }, reason: 'Done', seen_at: at(H) } });
  const board = boardOf([older, newer, look, review, shipped, paused, mine, theirs, seen]);
  expect(board.lanes.map((l) => l.column)).toEqual(['asked', 'designing', 'your_look', 'building', 'your_review']);
  expect(board.lanes.map((l) => l.onYou)).toEqual([false, false, true, false, true]);
  expect(board.lanes[3]!.cards.map((c) => c.id)).toEqual([newer.id, older.id]);
  expect(board.inFlight).toBe(4);
  expect(board.onYou).toBe(2);
  expect(board.shipped).toEqual([shipped]);
  expect(board.icebox).toEqual([paused]);
  expect(board.dropped.map((c) => c.id)).toEqual([mine.id, theirs.id, seen.id]);
  // Only an agent's drop the person has not seen.
  expect(board.droppedByAgent.map((c) => c.id)).toEqual([theirs.id]);
});

test('the second line: "You: …" in the person\'s lanes, the agent\'s last word otherwise', () => {
  expect(cardLine({ column: 'your_look', you: 'Pick one', said: 'Five options' })).toEqual({ you: true, text: 'Pick one' });
  expect(cardLine({ column: 'building', you: null, said: 'PR open' })).toEqual({ you: false, text: 'PR open' });
  // A person's lane with nothing owed falls back to the agent's word.
  expect(cardLine({ column: 'your_review', you: null, said: 'Green' })).toEqual({ you: false, text: 'Green' });
  expect(cardLine({ column: 'asked', you: null, said: null })).toBeNull();
});

test('the last-heard age, short and in words', () => {
  expect(ageShort(at(20_000), now)).toBe('just now');
  expect(ageShort(at(39 * 60_000), now)).toBe('39m ago');
  expect(ageShort(at(10 * H), now)).toBe('10h ago');
  expect(ageShort(at(49 * H), now)).toBe('2d ago');
  expect(ageShort(at(20 * 24 * H), now)).toBe('2w ago');
  expect(ageShort(new Date(now + H).toISOString(), now)).toBe('just now');
  expect(ageShort('not a date', now)).toBe('');
  expect(ageWords(at(49 * H), now)).toBe('2 days ago');
  expect(ageWords(at(60 * 60_000), now)).toBe('1 hour ago');
});

test('Ask where this is: the card\'s own live session, else a live one in its project, else nobody', () => {
  const c = card({ project_id: 'prj_a' });
  const own = (c.agent as { session: string }).session;
  const projects = (sessions: Record<string, string[]>): InboxComposeProject[] =>
    Object.entries(sessions).map(([id, list]) => ({ project: { id, name: id, root: `/${id}` }, sessions: list.map((session) => ({ session, host: 'claude-code' }) as never) }));
  expect(askTarget(c, projects({ prj_b: [own], prj_a: ['ses_other'] }))).toEqual({ session: own, own: true, host: 'claude-code' });
  // Its own agent ended: another session in the project, said as not its own.
  expect(askTarget(c, projects({ prj_a: ['ses_other'] }))).toEqual({ session: 'ses_other', own: false, host: 'claude-code' });
  expect(askTarget(c, projects({ prj_b: ['ses_other'] }))).toBeNull();
  expect(askTarget(c, null)).toBeNull();
  expect(askTarget(card({ agent: null }), projects({ prj_a: ['ses_x'] }))).toEqual({ session: 'ses_x', own: true, host: 'claude-code' });
});
