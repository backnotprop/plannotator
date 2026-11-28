/**
 * Project tags in the filters (projectTags.ts): a Tag pick keeps a thread tagged itself or in a project that carries
 * the tag, in the list and on the Board.
 *
 * What this catches: a project's tag that the list's Tag pick or its count misses; a project tag that keeps another
 * project's threads; a thread counted twice when it and its project carry the same tag; the window's own rule for a
 * row's tags bypassed (an older linked machine's row); a Board Tag pick that misses a tagged project's cards, or a
 * "No tag" that drops a card with no tag of its own; a Board card counted twice in one tag; and, with no project
 * tagged, any change at all to what the filters read.
 */
import { describe, expect, test } from 'bun:test';
import type { InboxCardWire, InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { INBOX_NO_INITIATIVE } from '@plannotator/core/inbox-types';
import { NO_LIST_FILTER, countWhere, filterListSections } from './listFilter';
import { projectTagMap, withProjectTags } from './projectTags';
import { cardsInInitiative, initiativeCounts } from './board/model';

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const row = (id: string, project: string, tags: string[] = []): InboxListRow =>
  ({ thread_id: id, project: { id: project, name: project }, last_at: '2026-11-18T09:00:00.000Z', author: { kind: 'agent', host: 'claude-code', session: `s_${id}` }, tags, unread: false }) as unknown as InboxListRow;

const ROWS = [row('bill1', 'prj_billing'), row('bill2', 'prj_billing', ['ini_release']), row('site1', 'prj_site'), row('docs1', 'prj_docs', ['ini_work']), row('ops1', 'prj_ops')];
const SECTIONS: InboxListSection[] = [{ id: 'waiting', threads: ROWS } as unknown as InboxListSection];
const PROJECTS = [
  { id: 'prj_billing', tags: ['ini_work'] },
  { id: 'prj_site', tags: ['ini_personal'] },
  { id: 'prj_docs', tags: ['ini_work'] },
  { id: 'prj_ops' },
];
const own = (r: InboxListRow) => r.tags ?? [];
const kept = (tags: string[], tagsOf = withProjectTags(own, projectTagMap(PROJECTS))) =>
  filterListSections(SECTIONS, { ...NO_LIST_FILTER, tags }, NOW, undefined, tagsOf)[0]!.threads.map((r) => r.thread_id);

describe('the list', () => {
  test('a tag keeps the threads of every project carrying it, and threads tagged themselves', () => {
    expect(kept(['ini_work'])).toEqual(['bill1', 'bill2', 'docs1']);
    expect(kept(['ini_personal'])).toEqual(['site1']);
    expect(kept(['ini_release'])).toEqual(['bill2']);
    // Two tags widen, as before.
    expect(kept(['ini_personal', 'ini_release'])).toEqual(['bill2', 'site1']);
  });

  test('the menu counts each thread once, its own tag and its project tag the same', () => {
    const tagsOf = withProjectTags(own, projectTagMap(PROJECTS));
    expect(countWhere(ROWS, NO_LIST_FILTER, NOW, 'tags', (r) => tagsOf(r).includes('ini_work'), tagsOf)).toBe(3);
    expect(tagsOf(ROWS[3]!)).toEqual(['ini_work']);
  });

  test("a row's own tags still come from the window's rule (a row it gives none keeps only its project's)", () => {
    const none = () => [] as readonly string[];
    expect(kept(['ini_release'], withProjectTags(none, projectTagMap(PROJECTS)))).toEqual([]);
    expect(kept(['ini_work'], withProjectTags(none, projectTagMap(PROJECTS)))).toEqual(['bill1', 'bill2', 'docs1']);
  });

  test('what this window just set wins over what the list said', () => {
    const map = projectTagMap(PROJECTS, new Map([['prj_ops', ['ini_work']], ['prj_billing', []]]));
    expect(kept(['ini_work'], withProjectTags(own, map))).toEqual(['docs1', 'ops1']);
  });

  test('with no project tagged the filters read exactly what they read before', () => {
    const untagged = PROJECTS.map(({ id }) => ({ id }));
    expect(withProjectTags(own, projectTagMap(untagged))).toBe(own);
    expect(withProjectTags(own, projectTagMap(undefined))).toBe(own);
  });
});

const card = (id: string, project: string, initiative: string | null = null) => ({ id, project_id: project, initiative }) as unknown as InboxCardWire;
const CARDS = [card('c1', 'prj_billing'), card('c2', 'prj_billing', 'ini_work'), card('c3', 'prj_site', 'ini_release'), card('c4', 'prj_ops'), card('c5', 'prj_ops', 'ini_work')];
const LIVE = [{ id: 'ini_work' }, { id: 'ini_personal' }, { id: 'ini_release' }];

describe('the Board', () => {
  test("a tag keeps its own cards and every card of a project carrying it; No tag stays the cards with no tag of their own", () => {
    const ids = (pick: string) => cardsInInitiative(CARDS, pick, LIVE, PROJECTS).map((c) => c.id);
    expect(ids('ini_work')).toEqual(['c1', 'c2', 'c5']);
    expect(ids('ini_personal')).toEqual(['c3']);
    expect(ids(INBOX_NO_INITIATIVE)).toEqual(['c1', 'c4']);
    // Without the projects, as before.
    expect(cardsInInitiative(CARDS, 'ini_work', LIVE).map((c) => c.id)).toEqual(['c2', 'c5']);
  });

  test('the counts follow the same rule, each card once per tag', () => {
    const counts = initiativeCounts(CARDS, LIVE, PROJECTS);
    expect(counts.get('ini_work')).toBe(3);
    expect(counts.get('ini_personal')).toBe(1);
    expect(counts.get('ini_release')).toBe(1);
    expect(counts.get(INBOX_NO_INITIATIVE)).toBe(2);
  });
});
