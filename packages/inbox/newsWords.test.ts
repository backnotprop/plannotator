/**
 * The held line says what came (the owner approved these words on 2026-11-18). If the sentence for a mix of arrivals
 * drifts, the line says something the owner did not approve, or names the wrong agent or thread; if the split into
 * the part that is never cut, the name that is cut and the "from …" that is left off whole drifts, the line cuts an
 * agent's name or Show. The strings below are the approved ones.
 */
import { describe, expect, test } from 'bun:test';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { arrivalOf, elsewhereLine, hereLine, type Arrival, type NewsLine } from './newsWords';
import { heldLines } from './heldLines';
import { filterSections } from './held';

const A = (kind: Arrival['kind'], agent: string, title = 'x', project = 'storefront'): Arrival => ({ id: `${kind}-${agent}-${title}-${project}`, kind, agent, title, projectId: `prj_${project}`, project });

const said = (line: NewsLine | null) => (line ? `${line.full} · ${line.action}` : null);

describe('the line for news in the list on screen', () => {
  const table: [string, Arrival[], string][] = [
    ['one reply', [A('reply', 'Claude', 'Checkout redesign')], 'Claude replied in “Checkout redesign” · Show'],
    ['one question', [A('question', 'Codex', 'Invoice dates')], 'Codex asked in “Invoice dates” · Show'],
    ['one new thread', [A('thread', 'Codex', 'Node 22 upgrade')], 'New from Codex: “Node 22 upgrade” · Show'],
    ['two replies, one agent', [A('reply', 'Claude', 'a'), A('reply', 'Claude', 'b')], '2 replies from Claude · Show'],
    ['two replies, two agents', [A('reply', 'Claude', 'a'), A('reply', 'Codex', 'b')], '2 replies from Claude and Codex · Show'],
    ['five replies, three agents', [A('reply', 'Claude', 'a'), A('reply', 'Codex', 'b'), A('reply', 'Pi', 'c'), A('reply', 'Codex', 'd'), A('reply', 'Pi', 'e')], '5 replies from 3 agents · Show'],
    ['mixed', [A('reply', 'Codex', 'b'), A('thread', 'Codex', 'a')], '1 new thread, 1 reply from Codex · Show'],
    ['mixed, in the fixed order: new threads, questions, replies', [A('reply', 'Claude', 'c'), A('reply', 'Codex', 'd'), A('question', 'Claude', 'b'), A('thread', 'Codex', 'a')], '1 new thread, 1 question, 2 replies from Claude and Codex · Show'],
    ['two new threads', [A('thread', 'Codex', 'a'), A('thread', 'Claude', 'b')], '2 new threads from Codex and Claude · Show'],
    ['two questions', [A('question', 'Codex', 'a'), A('question', 'Codex', 'b')], '2 questions from Codex · Show'],
  ];
  for (const [name, arrivals, words] of table) test(name, () => expect(said(hereLine(arrivals))).toBe(words));

  test('nothing waits: no line', () => expect(hereLine([])).toBeNull());

  test('one arrival: the lead is never cut, the quoted thread name is the part that is', () => {
    expect(hereLine([A('reply', 'Claude', 'Move the payment provider webhooks')])).toEqual({ lead: 'Claude replied in', name: '“Move the payment provider webhooks”', full: 'Claude replied in “Move the payment provider webhooks”', action: 'Show' });
    expect(hereLine([A('thread', 'Codex', 'Node 22 upgrade')])).toMatchObject({ lead: 'New from Codex:', name: '“Node 22 upgrade”' });
  });

  test('several: "from …" is its own part, left off whole when the line has no room (never cut inside a name)', () => {
    expect(hereLine([A('thread', 'Codex'), A('question', 'Claude'), A('reply', 'Claude'), A('reply', 'Codex')])).toEqual({
      lead: '1 new thread, 1 question, 2 replies',
      from: 'from Codex and Claude',
      full: '1 new thread, 1 question, 2 replies from Codex and Claude',
      action: 'Show',
    });
  });

  test('a snoozed thread back by the clock (no agent wrote): the line says how many, as before', () => {
    expect(said(hereLine([A('back', 'Claude')]))).toBe('1 new in storefront · Show');
    expect(said(hereLine([A('back', 'Claude'), A('reply', 'Codex', 'y', 'billing-svc')]))).toBe('2 new · Show');
  });
});

describe('the line for news outside a project or filter view', () => {
  const table: [string, Arrival[], string][] = [
    ['one reply', [A('reply', 'Codex', 'x', 'billing-svc')], 'Codex replied in billing-svc · Show all'],
    ['one question', [A('question', 'Codex', 'x', 'billing-svc')], 'Codex asked in billing-svc · Show all'],
    ['one new thread', [A('thread', 'Codex', 'x', 'billing-svc')], 'Codex wrote in billing-svc · Show all'],
    ['several, one project', [A('reply', 'Codex', 'x', 'billing-svc'), A('question', 'Pi', 'y', 'billing-svc')], '2 new in billing-svc · Show all'],
    ['several projects', [A('reply', 'Codex', 'x', 'billing-svc'), A('reply', 'Pi', 'y', 'docs-site')], '2 new in other projects · Show all'],
  ];
  for (const [name, arrivals, words] of table) test(name, () => expect(said(elsewhereLine(arrivals))).toBe(words));

  test('the project name is the part that is cut', () => {
    expect(elsewhereLine([A('reply', 'Codex', 'x', 'billing-svc')])).toMatchObject({ lead: 'Codex replied in', name: 'billing-svc' });
    expect(elsewhereLine([A('reply', 'Codex', 'x', 'billing-svc'), A('reply', 'Pi', 'y', 'billing-svc')])).toMatchObject({ lead: '2 new in', name: 'billing-svc' });
  });
});

const T0 = '2026-11-18T09:00:00Z';
const T1 = '2026-11-18T10:00:00Z';
const NOQ = { open: 0, picked: 0, stopped: false, holds_up: [], prompt: null };
function row(id: string, over: Partial<InboxListRow> = {}): InboxListRow {
  return {
    thread_id: id,
    project: { id: 'prj_store', name: 'storefront' },
    author: { kind: 'agent', host: 'claude-code', session: 'ses_1', name: null },
    thread_name: `Thread ${id}`,
    subject: `Subject ${id}`,
    last_at: T0,
    last_agent_at: T0,
    last_author: 'agent',
    questions: NOQ,
    sent: null,
    ...over,
  } as InboxListRow;
}

describe('what came on a row', () => {
  test('a thread the list lacks is a new thread; more open questions is a question; else a reply', () => {
    expect(arrivalOf(row('a'), undefined).kind).toBe('thread');
    expect(arrivalOf(row('a', { last_agent_at: T1, questions: { ...NOQ, open: 1 } }), row('a')).kind).toBe('question');
    expect(arrivalOf(row('a', { last_agent_at: T1 }), row('a')).kind).toBe('reply');
  });

  test('a snoozed thread back by the clock with no new agent message is "back"; with one, what the agent wrote', () => {
    expect(arrivalOf(row('a', { snooze_back: T1 }), row('a')).kind).toBe('back');
    expect(arrivalOf(row('a', { snooze_back: T1, last_agent_at: T1 }), row('a')).kind).toBe('reply');
  });

  test('the agent is the one that wrote last, as the product names it', () => {
    expect(arrivalOf(row('a'), undefined).agent).toBe('Claude Code');
    // Several agents in the thread: the row says which wrote last.
    expect(arrivalOf(row('a', { participants: [{ host: 'claude-code', session: 'ses_1' }, { host: 'codex', session: 'ses_2' }], last_agent: { host: 'codex' } }), undefined).agent).toBe('Codex');
    // A thread the person started: the agent it is addressed to, never the person.
    expect(arrivalOf(row('a', { author: { kind: 'person' }, addressee: { host: 'pi', session: 'ses_3' } }), undefined).agent).toBe('Pi');
    // A name the agent gave itself wins over its host's.
    expect(arrivalOf(row('a', { author: { kind: 'agent', host: 'claude-code', session: 'ses_1', name: 'Reviewer' } }), undefined).agent).toBe('Reviewer');
  });

  test('the title is the row\'s: its name, else its subject; the project its window name', () => {
    expect(arrivalOf(row('a'), undefined).title).toBe('Thread a');
    expect(arrivalOf(row('a', { thread_name: null }), undefined).title).toBe('Subject a');
    expect(arrivalOf(row('a'), undefined, new Map([['prj_store', 'shop']])).project).toBe('shop');
  });
});

describe('the two lines of a view', () => {
  const inStore = (id: string, over: Partial<InboxListRow> = {}) => row(id, over);
  const inBill = (id: string, over: Partial<InboxListRow> = {}) => row(id, { project: { id: 'prj_bill', name: 'billing-svc' }, author: { kind: 'agent', host: 'codex', session: 'ses_2', name: null }, ...over });
  const sections = (...rows: InboxListRow[]): InboxListSection[] => [{ id: 'new', label: 'New since you looked', threads: rows }];
  const shown = sections(inStore('a'), inBill('b'));
  const latest = sections(inStore('a', { last_agent_at: T1 }), inBill('b', { last_agent_at: T1 }), inBill('c'));
  const store = (s: readonly InboxListSection[]) => filterSections(s as InboxListSection[], 'prj_store');

  test('the Inbox: one line for everything that came, none for elsewhere', () => {
    const lines = heldLines({ shown, latest, view: (s) => s as InboxListSection[], scope: null });
    expect(said(lines.here)).toBe('1 new thread, 2 replies from Claude Code and Codex · Show');
    expect(lines.elsewhere).toBeNull();
  });

  test('a project view: what came here, and what came in other projects, never counted twice', () => {
    const lines = heldLines({ shown, latest, view: store, scope: store });
    expect(said(lines.here)).toBe('Claude Code replied in “Thread a” · Show');
    expect(said(lines.elsewhere)).toBe('2 new in billing-svc · Show all');
  });

  test('a thread the person\'s own filter hides in this view is in neither line: Show all would not bring it in', () => {
    const picks = (s: readonly InboxListSection[]) => store(s).map((section) => ({ ...section, threads: section.threads.filter((r) => r.thread_id !== 'a') }));
    const lines = heldLines({ shown, latest, view: picks, scope: store });
    expect(lines.here).toBeNull();
    expect(said(lines.elsewhere)).toBe('2 new in billing-svc · Show all');
  });
});
