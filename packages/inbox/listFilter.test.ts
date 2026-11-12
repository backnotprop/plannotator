import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { inboxThreadPullsSummary, type InboxListRow, type InboxListSection, type InboxThreadPull, type InboxThreadPullState } from '@plannotator/core/inbox-types';
import {
  LIST_FILTER_COOKIE,
  NO_LIST_FILTER,
  appliedFilter,
  countWhere,
  filterListSections,
  parseListFilter,
  pickCount,
  resetListFilterForTests,
  rowMatches,
  rowPullMatches,
  rowPullStates,
  writeListFilter,
  type ListFilter,
} from './listFilter';
import { setStorageBackend, resetStorageBackend, getItem } from '@plannotator/ui/utils/storage';

const at = (month: number, day: number, hour: number, minute = 0) => new Date(2026, month - 1, day, hour, minute).toISOString();
const NOW = new Date(2026, 10, 8, 12, 0).getTime();

type PullState = 'open' | 'draft' | 'merged' | 'closed' | 'unknown';
function row(id: string, extra: { project?: string; last_at?: string; host?: string; hosts?: string[]; addressee?: string; person?: boolean; pull?: PullState; pulls?: number } = {}): InboxListRow {
  const project = extra.project ?? 'billing';
  return {
    thread_id: id,
    project: { id: `prj_${project}`, name: project },
    last_at: extra.last_at ?? at(11, 8, 9),
    author: extra.person ? { kind: 'user' } : { kind: 'agent', host: extra.host ?? 'claude-code', session: `s_${id}`, name: null },
    participants: extra.hosts?.map((host, i) => ({ host, session: `s_${id}_${i}` })),
    addressee: extra.addressee ? { host: extra.addressee, session: 's_to', name: null } : null,
    pulls: extra.pull ? { count: extra.pulls ?? 1, headline: { key: `github.com/o/r#${id}`, state: extra.pull } } : undefined,
  } as unknown as InboxListRow;
}

const ROWS = {
  billingToday: row('billingToday', { project: 'billing', last_at: at(11, 8, 0, 30), pull: 'open' }),
  webLateYesterday: row('webLateYesterday', { project: 'web', last_at: at(11, 7, 23, 30), host: 'codex', pull: 'draft' }),
  webSixDaysBack: row('webSixDaysBack', { project: 'web', last_at: at(11, 2, 0, 10), host: 'pi' }),
  docsSevenDaysBack: row('docsSevenDaysBack', { project: 'docs', last_at: at(11, 1, 23, 59), pull: 'merged', pulls: 3 }),
  docs29Back: row('docs29Back', { project: 'docs', last_at: at(10, 10, 8) }),
  opsOld: row('opsOld', { project: 'ops', last_at: at(10, 9, 8), host: 'codex', pull: 'closed' }),
  mixed: row('mixed', { project: 'ops', last_at: at(11, 5, 10), hosts: ['codex', 'pi'], pull: 'unknown' }),
  startedByPerson: row('startedByPerson', { project: 'web', last_at: at(11, 6, 10), person: true, addressee: 'pi' }),
};
const ALL = Object.values(ROWS);
const kept = (filter: Partial<ListFilter>) => ALL.filter((r) => rowMatches(r, { ...NO_LIST_FILTER, ...filter }, NOW)).map((r) => r.thread_id);

describe('which rows a set of picks keeps', () => {
  const cases: Array<[string, Partial<ListFilter>, string[]]> = [
    ['nothing picked: every row', {}, ALL.map((r) => r.thread_id)],
    ['one project', { projects: ['prj_web'] }, ['webLateYesterday', 'webSixDaysBack', 'startedByPerson']],
    ['two projects widen (either one)', { projects: ['prj_billing', 'prj_docs'] }, ['billingToday', 'docsSevenDaysBack', 'docs29Back']],
    ['Today starts at this midnight, not 24 hours back', { updated: 'today' }, ['billingToday']],
    ['Last 7 days is today and the six days before it', { updated: '7d' }, ['billingToday', 'webLateYesterday', 'webSixDaysBack', 'mixed', 'startedByPerson']],
    ['Last 30 days keeps the 29th day back, not the 30th', { updated: '30d' }, ['billingToday', 'webLateYesterday', 'webSixDaysBack', 'docsSevenDaysBack', 'docs29Back', 'mixed', 'startedByPerson']],
    ['a range keeps its whole last day', { updated: { from: '2026-11-01', to: '2026-11-02' } }, ['webSixDaysBack', 'docsSevenDaysBack']],
    ['a range picked backwards reads forwards', { updated: { from: '2026-11-02', to: '2026-11-01' } }, ['webSixDaysBack', 'docsSevenDaysBack']],
    ['one agent: its own threads and the threads it is one of several in', { agents: ['Codex'] }, ['webLateYesterday', 'opsOld', 'mixed']],
    ['a thread the person started counts as its addressee\'s', { agents: ['Pi'] }, ['webSixDaysBack', 'mixed', 'startedByPerson']],
    ['two agents widen', { agents: ['Claude Code', 'Pi'] }, ['billingToday', 'webSixDaysBack', 'docsSevenDaysBack', 'docs29Back', 'mixed', 'startedByPerson']],
    ['groups narrow each other (project and span and agent)', { projects: ['prj_web', 'prj_ops'], updated: '7d', agents: ['Codex'] }, ['webLateYesterday', 'mixed']],
    ['picks that leave nothing', { projects: ['prj_billing'], agents: ['Pi'] }, []],
  ];
  for (const [name, filter, ids] of cases) test(name, () => expect(kept(filter)).toEqual(ids));
});

describe('the Pull request group', () => {
  const cases: Array<[string, Partial<ListFilter>, string[]]> = [
    ['Open: the threads whose PR is open', { pulls: ['open'] }, ['billingToday']],
    ['Draft is not Open', { pulls: ['draft'] }, ['webLateYesterday']],
    ['Merged reads the PR the row shows, however many the thread has', { pulls: ['merged'] }, ['docsSevenDaysBack']],
    ['Closed', { pulls: ['closed'] }, ['opsOld']],
    ['two states widen', { pulls: ['open', 'draft'] }, ['billingToday', 'webLateYesterday']],
    ['Has a PR: any state, unread ones too', { pulls: ['any'] }, ['billingToday', 'webLateYesterday', 'docsSevenDaysBack', 'opsOld', 'mixed']],
    ['No PR: the threads with none', { pulls: ['none'] }, ['webSixDaysBack', 'docs29Back', 'startedByPerson']],
    ['No PR or Merged widen', { pulls: ['none', 'merged'] }, ['webSixDaysBack', 'docsSevenDaysBack', 'docs29Back', 'startedByPerson']],
    ['narrows with the other groups', { pulls: ['any'], agents: ['Codex'], updated: '7d' }, ['webLateYesterday', 'mixed']],
  ];
  for (const [name, filter, ids] of cases) test(name, () => expect(kept(filter)).toEqual(ids));

  test('the badge counts its picks and a menu row counts without its own group', () => {
    const filter: ListFilter = { ...NO_LIST_FILTER, pulls: ['open', 'none'], updated: '7d' };
    expect(pickCount(filter)).toBe(3);
    expect(countWhere(ALL, filter, NOW, 'pulls', (r) => rowPullStates(r).includes('draft'))).toBe(1);
  });

  test('a row with a count of none, or no pulls at all, has no PR', () => {
    expect(rowPullStates(row('gone', { pull: 'open', pulls: 0 }))).toEqual([]);
    expect(rowPullStates(row('never'))).toEqual([]);
  });
});

test('a PR not read yet is kept by Has a PR alone: by no state, and never by No PR', () => {
  expect(rowPullStates(ROWS.mixed)).toEqual(['unknown']);
  expect((['open', 'draft', 'merged', 'closed', 'any', 'none'] as const).filter((pick) => rowPullMatches(ROWS.mixed, pick))).toEqual(['any']);
  expect(kept({ pulls: ['open', 'draft', 'merged', 'closed', 'none'] })).not.toContain('mixed');
});

test('the row summary the server builds is what the picks read: the PR still in play, else the one not read, else the last', () => {
  const pull = (n: number, state: InboxThreadPullState): InboxThreadPull => ({
    id: `thr:github.com/o/r#${n}`,
    project_id: 'prj',
    thread_id: 'thr',
    pull: `github.com/o/r#${n}`,
    url: `https://github.com/o/r/pull/${n}`,
    added_by: { kind: 'person' },
    added_at: new Date(2026, 10, 1, n).toISOString(),
    state,
    title: null,
    base: null,
    head: null,
    read_at: null,
  });
  const picksOf = (pulls: InboxThreadPull[]) => {
    const r = { pulls: inboxThreadPullsSummary(pulls) };
    return (['open', 'draft', 'merged', 'closed', 'any', 'none'] as const).filter((pick) => rowPullMatches(r, pick));
  };
  expect(picksOf([])).toEqual(['none']);
  expect(picksOf([pull(1, 'merged'), pull(2, 'draft')])).toEqual(['draft', 'any']);
  expect(picksOf([pull(1, 'merged'), pull(2, 'unknown')])).toEqual(['any']);
  expect(picksOf([pull(1, 'merged'), pull(2, 'closed')])).toEqual(['closed', 'any']);
  expect(picksOf([pull(1, 'open')])).toEqual(['open', 'any']);
});

test('a project\'s page sets its Project picks aside, and the badge counts what applies', () => {
  const filter: ListFilter = { projects: ['prj_web', 'prj_docs'], updated: '7d', agents: ['Pi'], pulls: [] };
  expect(pickCount(filter)).toBe(4);
  expect(appliedFilter(filter, true)).toEqual({ projects: [], updated: '7d', agents: ['Pi'], pulls: [] });
  expect(pickCount(appliedFilter(filter, true))).toBe(2);
  expect(appliedFilter(filter, false)).toBe(filter);
});

test('Smart groups keep their order and names and count only the matches; nothing picked hands the same sections back', () => {
  const sections = [
    { id: 'waiting', label: 'Waiting on you', threads: [ROWS.billingToday, ROWS.webLateYesterday] },
    { id: 'new', label: 'New since you looked', threads: [ROWS.opsOld] },
    { id: 'quiet', label: 'Quiet', threads: [ROWS.webSixDaysBack, ROWS.docs29Back] },
  ] as InboxListSection[];
  expect(filterListSections(sections, NO_LIST_FILTER, NOW)).toBe(sections);
  const out = filterListSections(sections, { ...NO_LIST_FILTER, projects: ['prj_web'] }, NOW);
  expect(out.map((s) => [s.id, s.label, s.threads.map((r) => r.thread_id)])).toEqual([
    ['waiting', 'Waiting on you', ['webLateYesterday']],
    ['new', 'New since you looked', []],
    ['quiet', 'Quiet', ['webSixDaysBack']],
  ]);
});

test('a menu row counts with the other groups\' picks, not its own group\'s', () => {
  const filter: ListFilter = { projects: ['prj_web'], updated: '7d', agents: [], pulls: [] };
  expect(countWhere(ALL, filter, NOW, 'projects', (r) => r.project.id === 'prj_docs')).toBe(0);
  expect(countWhere(ALL, filter, NOW, 'projects', (r) => r.project.id === 'prj_billing')).toBe(1);
  expect(countWhere(ALL, { ...filter, updated: 'today' }, NOW, 'updated', (r) => Date.parse(r.last_at) >= new Date(2026, 9, 10).getTime())).toBe(3);
});

describe('remembered per browser', () => {
  const stored = new Map<string, string>();
  beforeEach(() => {
    stored.clear();
    setStorageBackend({ getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => void stored.set(k, v), removeItem: (k) => void stored.delete(k) });
    resetListFilterForTests();
  });
  afterEach(() => {
    resetStorageBackend();
    resetListFilterForTests();
  });

  test('picks are written, read back, and removed when cleared', () => {
    const filter: ListFilter = { projects: ['prj_web'], updated: { from: '2026-10-20', to: '2026-11-01' }, agents: ['Codex'], pulls: ['merged', 'none'] };
    writeListFilter(filter);
    expect(parseListFilter(getItem(LIST_FILTER_COOKIE))).toEqual(filter);
    writeListFilter(NO_LIST_FILTER);
    expect(stored.has(LIST_FILTER_COOKIE)).toBe(false);
  });

  const junk: Array<[string, string | null, ListFilter]> = [
    ['no cookie', null, NO_LIST_FILTER],
    ['not JSON', '{oops', NO_LIST_FILTER],
    ['wrong shapes are dropped', JSON.stringify({ projects: 'prj_web', updated: 'yesterday', agents: [1, 'Pi', ''] }), { projects: [], updated: null, agents: ['Pi'], pulls: [] }],
    ['unknown Pull request picks are dropped', JSON.stringify({ pulls: ['open', 'stale', 3] }), { ...NO_LIST_FILTER, pulls: ['open'] }],
    ['a range with a bad day is dropped', JSON.stringify({ updated: { from: '2026-13', to: '2026-11-01' } }), NO_LIST_FILTER],
  ];
  for (const [name, raw, want] of junk) test(name, () => expect(parseListFilter(raw)).toEqual(want));
});
